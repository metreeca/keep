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
 * Materialises each queued {@link Select} collection from the batched query's solution tuples, one member per row of
 * the request, in the returned order. A projection row becomes a record of its bindings, and a plain collection row
 * becomes its member. A cell retrieved as a union is read from the variant column that bound (§5.5), with no term
 * inspection.
 *
 * A resource or expanded reference is handed to the detail pass through the {@link Broker}, which fetches its
 * content. So is the owner of a localised property retrieved structurally (§5.4). Any other cell coerces its term.
 * The contract shared with the encoder is stated in `select/index.md`.
 *
 * @module
 */

import { getShapeTarget } from "@metreeca/blue/reference";
import { type ResourceShape } from "@metreeca/blue/resource";
import { getShapeBranches } from "@metreeca/blue/union";
import { type Shape } from "@metreeca/blue/value";
import { type Identifier, opt } from "@metreeca/core";
import type { Tag } from "@metreeca/core/language";
import type { Scope } from "@metreeca/core/scope";
import {
	type Branch,
	type Drain,
	type Flake,
	getFlakeEntries,
	getFlakeProjection,
	getFlakeVariant,
	isComputedFlake,
	isDrainedFlake
} from "@metreeca/keep-flake";
import type { Broker, Deferred, Select } from "@metreeca/keep/batching";
import type { Reference, Resource, Value } from "@metreeca/qest/state";
import type { Term } from "@metreeca/trio";
import type { Tuple, Variable } from "@metreeca/wire-sparql";
import { computedToValue, termToValue } from "../index.core.js";


/**
 * Settles each batched select request with the collection decoded from the `select` solution.
 *
 * @param scope The variable scope shared with the encoder, recovering per-request tuple slots
 * @param batch The queued select requests to settle, each paired with its {@link Flake | query plan} and deferred
 * @param broker The cross-pass channel expanding structured and localised cells through the detail pass
 * @param tuples The solution tuples returned by the batched `select` query
 */
export function decode(
	scope: Scope<Variable>,
	batch: readonly (Deferred<Select> & { readonly flake: Flake; })[],
	broker: Broker,
	tuples: readonly Tuple[]
): void {

	const guard = scope.resolve(batch);

	batch.forEach(({ request: { locale }, flake, resolve, reject }, index) => {

		const rows = tuples.filter(tuple => {
			const stamp = tuple[guard];
			return stamp?.kind === "typed" && stamp.text === String(index);
		});

		Promise.all(rows.map(row => flake.drain?.form === "projection"
				? record(flake, row, locale)
				: cell(flake, flake, row, locale)
			))
			.then(values => values.filter(value => value !== undefined))
			.then(resolve)
			.catch(reject);

	});


	/**
	 * One projection row: every binding the query projects, keyed by its alias, omitting a binding that
	 * resolves to no value (§5.2).
	 */
	function record(root: Flake, row: Tuple, locale: readonly Tag[]): Promise<Resource> {

		return Promise.all(Object.entries(getFlakeProjection(root)).map(([alias, node]) =>
			cell(root, node, row, locale).then((value): readonly [Identifier, undefined | Value] => [alias, value])
		)).then(cells =>
			Object.fromEntries(cells.filter(([, value]) => value !== undefined))
		);

	}

	/**
	 * One cell of a row: a transform stage coerces its computed literal; a cell retrieved as a union reads
	 * the first requested variant whose column bound, a member of an unrequested variant resolving to no
	 * value; any other cell reads its single column under its range's variant.
	 */
	function cell(root: Flake, node: Flake, row: Tuple, locale: readonly Tag[]): Promise<undefined | Value> {

		const drain = node.drain;

		if ( isComputedFlake(node) ) {

			return Promise.resolve(opt(row[scope.resolve(node)], computedToValue));

		} else if ( drain?.form === "union" ) {

			const bound = [...drain.variants].flatMap(([variant, placeholder]) =>
				opt(row[scope.resolve(node, variant)], term => [{ variant, placeholder, term }], [])
			);

			return bound.length === 0 ? Promise.resolve(undefined)
				: value(root, node, bound[0].variant, bound[0].placeholder, getFlakeVariant(node, bound[0].variant), bound[0].term, locale);

		} else {

			const [variant] = getShapeBranches(node.range.shape);

			return opt(row[scope.resolve(node)],
				term => value(root, node, variant, drain, getFlakeEntries(node), term, locale),
				() => Promise.resolve(undefined)
			);

		}

	}

	/**
	 * The value a cell's bound term stands for under `variant`: a localised variant is the label coalesced
	 * by the encoder (§6.2) or, under a locale placeholder, the owner whose property the detail pass
	 * expands tag by tag (§5.4); a resource or reference is expanded by the detail pass where the request
	 * asks for its content, else kept as the reference naming it; a literal is coerced.
	 */
	function value(
		root: Flake,
		node: Flake,
		variant: Shape,
		drain: undefined | Drain,
		branches: readonly Branch[],
		term: Term,
		locale: readonly Tag[]
	): Promise<undefined | Value> {

		if ( variant.kind === "dictionary" && drain?.form === "locale" ) {

			const name = node.path[node.path.length-1];
			const owner = owning(root, node);

			return term.kind !== "named" || owner === undefined ? Promise.resolve(undefined)
				: broker.detail({
					entry: term.iri,
					shape: owner,
					model: { [name]: drain.query },
					locale
				}).then(resource =>
					// ;(cast) the detailed resource carries the one localised field just requested, which decodes to a
					// single structured value rather than to a set; the static inference no longer says either,
					// reading leaf types off a notation that no longer carries them (see `@metreeca/blue/value`)
					(resource as Resource)[name] as undefined | Value
				);

		} else if ( variant.kind === "dictionary" ) {

			return Promise.resolve(termToValue(term, variant));

		} else if ( variant.kind === "resource" || variant.kind === "reference" ) {

			const target = getShapeTarget(variant);
			const expanded = drain?.form === "template" || branches.some(isDrainedFlake);

			return term.kind !== "named" ? Promise.resolve(undefined)
				: expanded && target !== undefined ? expand(term.iri, target, branches, locale)
					: Promise.resolve(term.iri);

		} else {

			return Promise.resolve(termToValue(term, variant));

		}

	}

	/**
	 * Expands a structured member through the detail pass: reassembles its retrieval template from the
	 * requested branches and hands it to the broker, keyed on the member entry, so the member's own content
	 * is the detail handler's responsibility and never reconstructed from the returned tuples.
	 */
	function expand(entry: Reference, shape: ResourceShape, branches: readonly Branch[], locale: readonly Tag[]): Promise<Resource> {

		return broker.detail({

			entry,
			shape,

			model: Object.fromEntries(branches.flatMap(branch => branch.drain === undefined ? []
				: [[branch.path[branch.path.length-1], branch.drain.query]]
			)),

			locale

		});

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
