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
 * Folds every batched group's {@link Flake | detail plan} into one `select` whose `where` is a `union` of arms.
 * A `union` sums solutions rather than joining them, so giving each fan-out source its own arm keeps the row count a
 * sum of per-property cardinalities instead of a cross-product. Multi-valued properties go to the select pass, so
 * the only fan-out sources here are localised (`dictionary`) leaves and union variants.
 *
 * A group is the set of root entries sharing one detail plan. Every arm of a group reads from the group's **subject**
 * variable, and a `values` block binds that subject to all the group's entries. Arms and columns therefore grow with
 * the plan alone, and the query text grows linearly with the entries. A collection of a thousand members expanded
 * through one template costs as many arms and columns as a single member, since only the `values` blocks grow.
 *
 * A group contributes three kinds of arms, each opening with its `values` block:
 *
 *  - a **scalar** arm (from {@link scalars}): the whole plain single-valued subtree (scalars, references, embedded
 *    resources), every edge `optional` so one row carries all bound values;
 *  - a **localised** arm per `dictionary` leaf (from {@link composites}): the required path to the leaf's parent,
 *    then the localised edge binding one tagged-term column;
 *  - a **variant** arm per requested union variant (from {@link composites}): the variant's object column gated by
 *    its {@link membership} constraint, then the variant's subtree.
 *
 * Variables come from the {@link Scope} shared with the decoder, so both sides agree on every column. The subject is
 * keyed on the group's root {@link Flake}, and the rows of one request are those whose subject binds its entry.
 * Every other column is keyed on {@link Branch} identity, paired with the variant shape for a variant column. Groups
 * whose plan reads no single-valued property contribute no arm, and the caller must filter them out before encoding.
 *
 * @module
 */

import { eager } from "@metreeca/blue/value";
import type { Scope } from "@metreeca/core/scope";
import { type Branch, type Flake, getFlakeEntries, getFlakeVariant, isModelBranch } from "@metreeca/keep-flake";
import type { Reference } from "@metreeca/qest/state";
import { named } from "@metreeca/trio";
import { type SPARQL, type Variable } from "@metreeca/wire-sparql";
import { all, fragment, optional, select, term, union, values, where } from "@metreeca/wire-sparql/builder";
import { link, membership } from "../index.core.js";


/**
 * Encodes one batched `select` covering every group.
 *
 * @param scope The variable allocator shared with the decoder, keyed on the plan node behind each column
 * @param batch The groups to read, each pairing the root entries sharing a {@link Flake | detail plan} with that plan
 *
 * @returns The batched `select` query
 */
export function encode(
	scope: Scope<Variable>,
	batch: readonly { readonly entries: readonly Reference[]; readonly flake: Flake }[]
): SPARQL {

	return select(all(), where(
		union(...batch.flatMap(({ entries, flake }) => group(entries, flake)))
	));


	/**
	 * The arms reading one group: the subtree of its plan at the group's subject. Every arm opens with the `values`
	 * block binding the subject to the group's entries, so each arm returns rows for those entries only.
	 */
	function group(entries: readonly Reference[], flake: Flake): readonly SPARQL[] {

		const subject = scope.resolve(flake);

		// bound inside every arm rather than once outside the union: a `values` joined to the union would leave
		// the scalar arm's leading `optional` evaluated with the subject unbound, a full predicate scan per arm

		const binding = values([subject], entries.map(entry => [term(named(entry))]));

		return resource([], subject, getFlakeEntries(flake));


		/**
		 * The arms reading the subtree at `anchor`: its {@link scalars} and its {@link composites}, each an
		 * independent arm of the enclosing `union`. Every arm is prefixed by `path`, the required edges reaching
		 * `anchor`: empty at the subject, a variant's membership-gated reach below it.
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
		 * reaching `anchor` even if `anchor` has no scalar leaf.
		 */
		function scalars(path: readonly SPARQL[], anchor: Variable, entries: readonly Branch[]): readonly SPARQL[] {

			return arm(...path, ...optionals(anchor, entries));


			/**
			 * The `optional` clauses of the plain single-valued subtree at `anchor`, one per branch wrapping its
			 * edge and nested descent. Composite branches (`dictionary` leaves, unions) are skipped:
			 * {@link composites} emits them as standalone arms.
			 */
			function optionals(anchor: Variable, entries: readonly Branch[]): readonly SPARQL[] {

				return entries.filter(isModelBranch).flatMap(branch => {

					const shape = eager(branch.entry.range.shape);

					if ( shape.kind === "dictionary" || shape.kind === "union" ) { return []; } else {

						const target = scope.resolve(branch);

						return [optional(
							link([anchor, branch.entry, target]),
							...optionals(target, getFlakeEntries(branch))
						)];

					}

				});

			}

		}

		/**
		 * The standalone composite arms under `anchor`, the complement of {@link scalars}: one arm per `dictionary`
		 * leaf and one per requested union variant (each with its own subtree and nested composites), recursing
		 * through plain nested resources. Each arm carries `path`, the required edges reaching `anchor`, so it
		 * returns rows only if that path exists.
		 */
		function composites(path: readonly SPARQL[], anchor: Variable, entries: readonly Branch[]): readonly SPARQL[] {

			return entries.filter(isModelBranch).flatMap(branch => {

				const shape = eager(branch.entry.range.shape);

				if ( shape.kind === "union" ) {

					const requested = branch.drain?.form === "union" ? [...branch.drain.variants.keys()] : [];

					return requested.flatMap(variant => {

						// keyed on the branch as well as the variant: a variant shape is shared by every group
						// retrieving the same union, so the shape alone would conflate their columns

						const target = scope.resolve(branch, variant);

						return resource([
								...path,
								link([anchor, branch.entry, target]),
								membership(target, variant)
							],
							target,
							getFlakeVariant(branch, variant)
						);

					});

				} else if ( shape.kind === "dictionary" ) {

					const target = scope.resolve(branch);

					return arm(...path, link([anchor, branch.entry, target]));

				} else {

					const target = scope.resolve(branch);

					return composites([
							...path,
							link([anchor, branch.entry, target])
						],
						target,
						getFlakeEntries(branch)
					);

				}

			});

		}


		/**
		 * An arm wrapping the group binding and `clauses`, or nothing when there are no clauses: a bare binding
		 * would return one empty row per entry, and an empty {@link fragment} would surface as a stray `{ }`
		 * branch matching everything once the enclosing {@link union} groups the arms.
		 */
		function arm(...clauses: readonly SPARQL[]): readonly SPARQL[] {
			return clauses.length > 0 ? [fragment(binding, ...clauses)] : [];
		}

	}

}
