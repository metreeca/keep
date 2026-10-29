/*
 * Copyright © 2025-2026 Metreeca srl
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Select-pass result decoder.
 *
 * Materialises one queued {@link Select} collection from its own solution rows, one member per row, in the returned
 * order. A projection row becomes a record of its bindings, and a plain collection row becomes its member. Every
 * cell is read off the {@link Schema | columns} the group schema declares for it: the first column that bound
 * settles the variant and the form of the value, with no term inspection, so a cell never misreads a stored term.
 *
 * A request reads only the rows carrying its own entry in the owner column of its {@link Group | group}, already
 * ordered and windowed by the server, so the decoder neither sorts nor slices and the row order is the result order.
 *
 * A resource or expanded reference is read off the resource the detail pass materialises for it, as is the owner
 * of a localised property retrieved structurally (§5.4); the decoded collection depends on those requests and the
 * spine runs them. Any other cell coerces its term. The decoder issues no request itself. The contract shared with
 * the encoder is stated in `src/index.md`, next to the clause structure of the query.
 *
 * @module
 */

import { getShapeTarget } from "@metreeca/blue/reference";
import { type ResourceShape } from "@metreeca/blue/resource";
import { getShapeBranches } from "@metreeca/blue/union";
import { opt } from "@metreeca/core";
import type { Scope } from "@metreeca/core/scope";
import { type Flake, getFlakeEntries, getFlakeProjection, getFlakeTemplate, getFlakeVariant, isDrainedFlake } from "@metreeca/keep-flake";
import type { Deferred, Select } from "@metreeca/keep/batching";
import type { Value, Values } from "@metreeca/qest/state";
import type { Term } from "@metreeca/trio";
import type { Tuple, Variable } from "@metreeca/wire-sparql";
import { computedToValue, termToReference, termToValue } from "../terms.js";
import { all, type Decoded, map, plain, resource } from "../spine.js";
import type { Group } from "./encode.js";
import { type Column, column } from "./schema.js";


/**
 * Decodes one batched select request from its own `select` solution rows.
 *
 * @param scope The variable scope shared with the encoder, recovering the group's tuple slots
 * @param group The group the request belongs to, which must be the very record handed to the encoder: its columns
 * are keyed on the record's identity, so a copy or a fresh equivalent would resolve to different variables
 * @param item The request to decode
 * @param rows The solution rows binding the request's own entry, in solution order
 *
 * @returns The decoded collection, one value per row in row order, a row resolving to no value left out, depending
 * on the detail requests its resource cells read their content from, in cell order
 */
export function decode(
	scope: Scope<Variable>,
	group: Group,
	{ request: { locale } }: Deferred<Select>,
	rows: readonly Tuple[]
): Decoded<readonly Value[]> {

	const { flake, schema } = group;

	return map(all(rows.map(row => flake.drain?.form === "projection"
		? record(flake, row)
		: cell(flake, flake, row)
	)), values => values.flatMap(value => value === undefined ? [] : [value]));


	/**
	 * One projection row: every binding the query projects, keyed by its alias, omitting a binding that
	 * resolves to no value (§5.2), so a record never carries an alias bound to no value at all.
	 */
	function record(root: Flake, row: Tuple): Decoded<Value> {

		const cells = Object.entries(getFlakeProjection(root)).map(([alias, node]) =>
			map(cell(root, node, row), value => ({ alias, value }))
		);

		return map(all(cells), bindings => Object.fromEntries(bindings.flatMap(({ alias, value }) =>
			value === undefined ? [] : [[alias, value]]
		)));

	}

	/**
	 * One cell of a row: the value of the first of its columns that bound, a row binding none of them, as a
	 * member of an unrequested variant does, resolving to no value and so left out of the decoded collection.
	 */
	function cell(root: Flake, node: Flake, row: Tuple): Decoded<undefined | Value> {

		const bound = (schema.get(node) ?? []).flatMap(candidate =>
			opt(row[column(scope, candidate)], term => [{ column: candidate, term }], [])
		);

		return bound.length === 0 ? plain(undefined)
			: value(root, bound[0].column, bound[0].term);

	}

	/**
	 * The value a column's bound term stands for, by the column's form: a computed literal is coerced by its datatype;
	 * the owner of a localised property retrieved structurally is read off the resource the detail pass expands tag by
	 * tag (§5.4); a coalesced label is its string (§6.2); a stored value is coerced under the column's variant, a
	 * resource or reference being read off the resource the detail pass materialises where the request asks for its
	 * content, and kept as the bare reference naming it where it asks for the reference alone.
	 */
	function value(root: Flake, { node, variant, drain, form }: Column, term: Term): Decoded<undefined | Value> {

		if ( form === "computed" ) {

			return plain(computedToValue(term));

		} else if ( form === "owner" ) {

			const name = node.path[node.path.length-1];
			const owner = owning(root, node);
			const entry = termToReference(term);

			return entry === undefined || owner === undefined || drain?.form !== "locale" ? plain(undefined)
				: resource({ entry, shape: owner, model: { [name]: drain.query }, locale }, resource =>
					opt(resource[name], value => isSingle(value) ? value : undefined, undefined)
				);

		} else if ( form === "label" ) {

			return plain(termToValue(term, variant));

		} else if ( variant.kind === "resource" || variant.kind === "reference" ) {

			const target = getShapeTarget(variant);
			const branches = node.drain?.form === "union" ? getFlakeVariant(node, variant) : getFlakeEntries(node);
			const expanded = drain?.form === "template" || branches.some(isDrainedFlake);
			const entry = termToReference(term);

			// the member's own content is the detail pass's responsibility, under the template the request stated
			// for it, and is never reconstructed from the returned tuples, which carry the bare reference alone

			return entry === undefined ? plain(undefined)
				: expanded && target !== undefined ? resource({
						entry,
						shape: target,
						model: node.drain?.form === "union" ? getFlakeTemplate(node, variant) : getFlakeTemplate(node),
						locale
					}, resource => resource)
					: plain(entry);

		} else {

			return plain(termToValue(term, variant));

		}

	}

	/**
	 * Checks whether a value set holds a single value: a localised property retrieved structurally yields its
	 * dictionary, a single value the cell takes as it is, never a list of values to fan out across rows.
	 */
	function isSingle(values: Values): values is Value {
		return !Array.isArray(values);
	}

	/**
	 * The shape the detail pass expands a localised cell's owner under: the first resource the cell's parent
	 * range reaches that declares the property as localised, so a localised branch declared by one variant of
	 * a crossed union (§5.8.1) is expanded under that variant.
	 */
	function owning(root: Flake, node: Flake): undefined | ResourceShape {

		const name = node.path[node.path.length-1];
		const parent = node.path.slice(0, -1).reduce<Flake>((at, step) => (at.entries ?? {})[step], root);

		return getShapeBranches(parent.range.shape)
			.flatMap(variant => opt(getShapeTarget(variant), target => [target], []))
			.find(target => opt(target.members[name], member =>
					member.kind === "property" && getShapeBranches(member.range.shape).some(variant => variant.kind === "dictionary"),
				false
			));

	}

}
