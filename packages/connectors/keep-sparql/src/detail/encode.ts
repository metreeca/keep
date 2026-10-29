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
 * Detail-pass SPARQL encoder.
 *
 * Folds a batch's {@link Flake | detail plan} into one `select` whose `where` is a `union` of arms. A `union` sums
 * solutions rather than joining them, so giving each fan-out source its own arm keeps the row count a sum of
 * per-property cardinalities instead of a cross-product. Multi-valued properties go to the select pass, so the only
 * fan-out sources left here are the localised (`dictionary`) leaves and the requested variants of union properties.
 *
 * Every arm reads from the batch's **subject** variable, and a `values` block binds that subject to all the batch's
 * entries. Arms and columns therefore grow with the plan alone, and the query text grows linearly with the entries:
 * expanding a thousand members through one template costs as many arms and columns as expanding a single member.
 *
 * The plan contributes three kinds of arms, each opening with the `values` block:
 *
 *  - a **scalar** arm (from `scalars`): the whole plain single-valued subtree (scalars, references, embedded
 *    resources), every edge `optional` so one row carries all bound values and an absent one leaves no row out;
 *  - a **localised** arm per `dictionary` leaf (from `composites`): the required path to the leaf's parent,
 *    then the localised edge binding one tagged-term column, one row per tagged value the leaf carries;
 *  - a **variant** arm per requested union variant (from `composites`): the variant's object column gated by
 *    its {@link membership} constraint, then the variant's subtree, read as a plain resource arm of its own.
 *
 * Variables come from the {@link Scope} shared with the decoder, so both sides agree on every column. The subject is
 * keyed on the root {@link Flake}, and the rows of one request are those whose subject binds its entry. Every other
 * column is keyed on {@link Branch} identity, paired with the variant shape for a variant column. A plan reading no
 * single-valued property contributes no arm, and the caller must not encode it.
 *
 * @module
 */

import type { Scope } from "@metreeca/core/scope";
import { type Branch, type Flake, getFlakeEntries } from "@metreeca/keep-flake";
import type { Reference } from "@metreeca/qest/state";
import { named } from "@metreeca/trio";
import { type SPARQL, type Variable } from "@metreeca/wire-sparql";
import { all, fragment, optional, select, term, union, values, where } from "@metreeca/wire-sparql/builder";
import { link, membership } from "../patterns.js";
import { type Column, column, entries as nested, type Schema } from "./schema.js";


/**
 * Encodes the batched `select` reading `entries` through one {@link Flake | detail plan}.
 *
 * @param scope The variable allocator shared with the decoder, keyed on the plan node behind each column
 * @param entries The root entries to read, all sharing `flake`
 * @param flake The detail plan the entries share
 * @param schema The table schema of the plan, the columns to bind for each property it reads
 *
 * @returns The batched `select` query
 */
export function encode(
	scope: Scope<Variable>,
	entries: readonly Reference[],
	flake: Flake,
	schema: Schema
): SPARQL {

	const subject = scope.resolve(flake);

	// bound inside every arm rather than once outside the union: a `values` joined to the union would leave
	// the scalar arm's leading `optional` evaluated with the subject unbound, a full predicate scan per arm

	const binding = values([subject], entries.map(entry => [term(named(entry))]));

	return select(all(), where(
		union(...resource([], subject, getFlakeEntries(flake)))
	));


	/**
	 * The arms reading the subtree at `anchor`: its `scalars` and its `composites`, each an independent arm of
	 * the enclosing `union`. Every arm is prefixed by `path`, the required edges reaching `anchor`: empty at the
	 * subject, a variant's membership-gated reach below it, so an arm returns rows only where that path exists.
	 */
	function resource(path: readonly SPARQL[], anchor: Variable, entries: readonly Branch[]): readonly SPARQL[] {

		return [
			...scalars(path, anchor, entries),
			...composites(path, anchor, entries)
		];

	}

	/**
	 * The single arm reading `anchor`'s scalar properties: `path` followed by the `optional` block of the plain
	 * single-valued subtree. The arm is emitted whenever it has clauses, so a bare `path` still binds the edges
	 * reaching `anchor` even if `anchor` has no scalar leaf, and a reached resource always surfaces its reference.
	 */
	function scalars(path: readonly SPARQL[], anchor: Variable, entries: readonly Branch[]): readonly SPARQL[] {

		return arm(...path, ...optionals(anchor, entries));


		/**
		 * The `optional` clauses of the plain single-valued subtree at `anchor`, one per scalar branch wrapping
		 * its edge and nested descent. Composite branches (`dictionary` leaves, unions) are skipped here, since
		 * `composites` emits each of them as a standalone arm of the enclosing `union`, beside the scalar arm.
		 */
		function optionals(anchor: Variable, entries: readonly Branch[]): readonly SPARQL[] {

			return entries.flatMap(branch => scalar(branch).map(scalar => {

				const target = column(scope, scalar);

				return optional(
					link([anchor, scalar.node.entry, target]),
					...optionals(target, nested(scalar))
				);

			}));

		}

	}

	/**
	 * The standalone composite arms under `anchor`, the complement of `scalars`: one arm per `dictionary` leaf
	 * and one per requested union variant (each with its own subtree and nested composites), recursing through
	 * plain nested resources. Each arm carries `path`, the required edges reaching `anchor`, so it returns rows
	 * only if that path exists and never surfaces a value under a resource the entry does not actually reach.
	 */
	function composites(path: readonly SPARQL[], anchor: Variable, entries: readonly Branch[]): readonly SPARQL[] {

		return entries.flatMap(branch => (schema.get(branch) ?? []).flatMap(composite => {

			const target = column(scope, composite);
			const reach = [...path, link([anchor, composite.node.entry, target])];

			return isVariant(composite) ? resource([...reach, membership(target, composite.variant)], target, nested(composite))
				: composite.form === "tagged" ? arm(...reach)
					: composites(reach, target, nested(composite));

		}));

	}


	/**
	 * The scalar column of a branch, the one `optionals` binds: a plain single-valued property, neither localised
	 * nor union-typed, which is read inside the scalar arm rather than through a composite arm of its own.
	 */
	function scalar(branch: Branch): readonly Column[] {
		return (schema.get(branch) ?? []).filter(column => column.form === "value" && !isVariant(column));
	}

	/**
	 * Checks whether a column binds one requested variant of a union-typed property, gated by its membership.
	 */
	function isVariant({ node }: Column): boolean {
		return node.drain?.form === "union";
	}


	/**
	 * An arm wrapping the entry binding and `clauses`, or nothing when there are no clauses: a bare binding
	 * would return one empty row per entry, and an empty {@link fragment} would surface as a stray `{ }`
	 * branch matching everything once the enclosing {@link union} groups the arms.
	 */
	function arm(...clauses: readonly SPARQL[]): readonly SPARQL[] {
		return clauses.length > 0 ? [fragment(binding, ...clauses)] : [];
	}

}
