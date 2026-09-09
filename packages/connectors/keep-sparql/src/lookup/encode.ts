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
 * Resources-pass SPARQL emitter.
 *
 * Folds every batched request's {@link Flake | lookup plan} into one `SELECT` whose `WHERE` is a
 * `UNION` of arms. `UNION` sums solutions rather than joining them, so giving each fan-out source its
 * own arm keeps the row count a sum of per-slot cardinalities instead of a cross-product. Set-valued
 * properties go to the collections pass, so this pass sees only single-valued slots and the only
 * fan-out sources are localised (`dictionary`) leaves and union variants.
 *
 * A resource contributes two descents, {@link scalars} and {@link composites}, together emitting three
 * arm kinds:
 *
 *  - a **scalar** arm (from {@link scalars}): the whole plain single-valued subtree (scalars, references,
 *    embedded resources), every edge `OPTIONAL` so one row carries all bound slots;
 *  - a **localised** arm per `dictionary` leaf (from {@link composites}): the required path to the leaf's
 *    parent, then the localised edge binding one tagged-term column;
 *  - a **variant** arm per requested union variant (from {@link composites}; {@link getUnionPlaceholders},
 *    union.md §Model): the variant's object column gated by its {@link membership} constraint, then the
 *    variant's subtree.
 *
 * Variables come from the shared {@link Scope}, keyed on {@link Branch} identity (or the variant shape
 * for a variant column), so the decoder recovers each column by resolving the same node. Requests whose
 * flake has no descent branch contribute no arm and are pre-filtered by the caller.
 *
 * @module
 */

import type { Scope } from "@metreeca/core/scope";
import { type Branch, type Flake, getFlakeEntries, getFlakeVariant, isModelBranch } from "@metreeca/keep-flake";
import type { Lookup } from "@metreeca/keep/batching";
import { named, type Named } from "@metreeca/trio";
import { type SPARQL, type Variable } from "@metreeca/wire-sparql";
import { all, fragment, optional, select, union, where } from "@metreeca/wire-sparql/builder";
import { link, membership } from "../_/_encode.js";
import { getUnionPlaceholders } from "../_/_union.js";


/**
 * Emits one batched SELECT covering every request.
 *
 * Builds the `WHERE` from the `UNION` of every request's arms, all sharing `scope` so the decoder can
 * recover each request's columns.
 *
 * @param scope The variable allocator shared with the decoder, keyed on {@link Branch} identity
 * @param batch The root entries paired with their {@link Flake | lookup plans}
 *
 * @returns The unified SELECT query
 */
export function encode(
	scope: Scope<Variable>,
	batch: readonly { readonly request: Lookup; readonly flake: Flake }[]
): SPARQL {

	return select(all(), where(
		union(...batch.flatMap(({ request, flake }) =>
			resource([], named(request.entry), getFlakeEntries(flake))
		))
	));


	/**
	 * The arms reading the subtree at `anchor`. A resource has two descents, its {@link scalars} and its
	 * {@link composites}, each an independent arm of the enclosing `UNION` and each prefixed by `path`:
	 * the required edges reaching `anchor`, empty at the root, a variant's membership-gated reach in
	 * recursion.
	 */
	function resource(path: readonly SPARQL[], anchor: Variable | Named, entries: readonly Branch[]): readonly SPARQL[] {

		return [
			...scalars(path, anchor, entries),
			...composites(path, anchor, entries)
		];

	}

	/**
	 * The single arm reading `anchor`'s scalar properties: `path` followed by the `OPTIONAL` block of the
	 * plain single-valued subtree. Emitted only when non-empty, so a bare `path` still binds the edges
	 * reaching `anchor` even when it has no scalar leaf.
	 */
	function scalars(path: readonly SPARQL[], anchor: Variable | Named, entries: readonly Branch[]): readonly SPARQL[] {

		return arm(...path, ...optionals(anchor, entries));


		/**
		 * The `OPTIONAL` clauses of the plain single-valued subtree at `anchor`, one per branch wrapping its
		 * edge and nested descent. Composite branches (`dictionary` leaves, unions) are skipped:
		 * {@link composites} emits them as standalone arms.
		 */
		function optionals(anchor: Variable | Named, entries: readonly Branch[]): readonly SPARQL[] {

			return entries.filter(isModelBranch).flatMap(branch => {

				const shape = branch.entry.range.shape;

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
	 * The standalone composite arms under `anchor`, the complement of {@link scalars}: one arm per
	 * `dictionary` leaf, one per requested union variant (each with its own subtree and nested composites), recursing
	 * through plain nested resources. Each arm carries `path` (the required edges reaching here) so it
	 * yields rows only when that path exists.
	 */
	function composites(path: readonly SPARQL[], anchor: Variable | Named, entries: readonly Branch[]): readonly SPARQL[] {

		return entries.filter(isModelBranch).flatMap(branch => {

			const shape = branch.entry.range.shape;

			if ( shape.kind === "union" ) {

				return [...getUnionPlaceholders(shape.variants, branch.drain?.mould).keys()].flatMap(variant => {

					const target = scope.resolve(variant);

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
	 * An arm wrapping `clauses`, or nothing when there are none: an empty {@link fragment} would surface
	 * as a stray `{ }` branch matching everything once the enclosing {@link union} groups the arms.
	 */
	function arm(...clauses: readonly SPARQL[]): readonly SPARQL[] {
		return clauses.length > 0 ? [fragment(...clauses)] : [];
	}

}
