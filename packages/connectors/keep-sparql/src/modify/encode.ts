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
 * Mutations SPARQL Update emitter.
 *
 * Folds a batch of {@link Modify} requests into one SPARQL 1.1 Update. A request carrying a `state`
 * is emitted as a `DELETE WHERE; INSERT DATA` pair that clears the entry's owned triples and
 * re-inserts the supplied state; a request with an omitted `state` is emitted as a cascade
 * `DELETE WHERE` that removes the entry together with its embedded and captive descendants. Every
 * statement is joined into a single update applied in submission order.
 *
 * All structural decisions are driven by the request's {@link Flake | plan}: forward and reverse
 * predicates are both written, foreign references are left untouched as read-only views, and
 * embedded resources recurse while plain references are written in place.
 *
 * @see {@link https://www.w3.org/TR/sparql11-update/ SPARQL 1.1 Update}
 *
 * @module
 */

import { type Property, type ResourceShape } from "@metreeca/blue/resource";
import { getShapeVariants, getStateVariant } from "@metreeca/blue/union";
import type { Shape, ValuesShape } from "@metreeca/blue/value";
import { isObject, opt } from "@metreeca/core";
import { some } from "@metreeca/core/arrays";
import type { Scope } from "@metreeca/core/scope";
import { type Branch, type Flake, getFlakeVariant } from "@metreeca/keep-flake";
import type { Deferred, Modify } from "@metreeca/keep/batching";
import type { Reference, Resource, Values } from "@metreeca/qest/resource";
import { isVacuous } from "@metreeca/qest/template";
import { named, type Named, rdf } from "@metreeca/trio";
import { type SPARQL, type Variable } from "@metreeca/wire-sparql";
import {
	deleet,
	fragment,
	insert as create,
	nil,
	optional,
	pattern,
	reference,
	union,
	update,
	values,
	variable,
	where
} from "@metreeca/wire-sparql/builder";
import { forward, reverse, valuesToTerms } from "../_/_encode.js";


/**
 * Emits a single batched SPARQL Update covering every supplied request.
 *
 * Each request is dispatched by the presence of its `state`: a present `state` produces a
 * cleanup-and-insert statement, an omitted `state` a cascade delete. The per-request statements are
 * joined into one update applied in submission order.
 *
 * @param scope The variable allocator shared across every request's cleanup walk, keyed on
 * {@link Branch} identity
 * @param batch The batched root entries paired with their {@link Flake | mutation plans}
 *
 * @returns The unified SPARQL Update query
 */
export function encode(
	scope: Scope<Variable>,
	batch: readonly (Deferred<Modify> & { readonly flake: Flake })[]
): SPARQL {

	return update(...batch.map(({ request: { entry, state }, flake }) =>
		state === undefined
			? remove(entry, flake)
			: insert(entry, flake, state)
	));


	function insert(entry: Reference, flake: Flake, state: Resource): SPARQL {

		return update(
			deleet(triples(named(entry), flake), where(matches(named(entry), flake))),
			create(data(entry, flake, state))
		);


		function triples(entry: Variable | Named, flake: Flake): SPARQL {
			return fragment(...flake.range.variants.flatMap(shape =>
				shape.kind !== "resource" ? [] : [fragment(
					isTyped(shape) ? pattern([entry, named(rdf.type), scope.resolve(shape)]) : nil(),
					...getFlakeVariant(flake, shape).flatMap(branch => {

						const property = branch.entry;

						if ( property.kind === "property" && isOwn(property.range.shape) ) {

							const v = scope.resolve(branch);

							return [
								forward([entry, property, v]),
								reverse([entry, property, v]),
								triples(v, branch) // only embedded resources recurse; references are written separately
							];

						} else {

							return [];

						}

					})
				)]
			));
		}

		function matches(entry: Variable | Named, flake: Flake): SPARQL {
			return fragment(...flake.range.variants.flatMap(shape =>
				shape.kind !== "resource" ? [] : [fragment(
					isTyped(shape) ? optional(pattern([entry, named(rdf.type), scope.resolve(shape)])) : nil(),
					...getFlakeVariant(flake, shape).flatMap(branch => {

						const property = branch.entry;

						if ( property.kind === "property" && isOwn(property.range.shape) ) {

							const v = scope.resolve(branch);

							const edges = fragment(
								forward([entry, property, v]),
								reverse([entry, property, v])
							);

							return [
								...(getShapeVariants(property.range.shape).some(variant => variant.kind === "resource")
										? [optional(edges, matches(v, branch))] // only embedded resources recurse
										: []
								),
								...(isLeaf(property.range.shape)
										? [optional(edges)]
										: []
								)
							];

						} else {

							return [];

						}

					})
				)]
			));
		}

		function data(entry: Reference, flake: Flake, state: Resource): SPARQL {

			const shape = getStateVariant(state, flake.range.variants);

			return shape === undefined || shape.kind !== "resource" ? nil() : record(named(entry), shape, state);


			function record(entry: Named, shape: ResourceShape, state: Resource): SPARQL {

				// denormalise the class lineage as `rdf:type` triples — own `class` plus inherited `classes` —
				// so an exact-match query on any supertype reaches the instance (class-lineage retrieval)

				return fragment(
					shape.class !== undefined ? pattern([entry, named(rdf.type), named(shape.class)]) : nil(),
					...(shape.classes ?? []).map(clazz => pattern([entry, named(rdf.type), named(clazz)])),
					...Object.entries(shape.entries).flatMap(([label, property]) => {

						const values = state[label];

						if ( property.kind === "property" && values !== undefined ) {

							const variants = getShapeVariants(property.range.shape);

							return some(values)
								.filter(value => !isVacuous(value))
								.flatMap(value => opt(getStateVariant(value, variants),
									variant => triples(property, value, variant),
									[]
								));

						} else {

							return [];

						}

					})
				);

				function triples(property: Property, values: Values, shape: ValuesShape): readonly SPARQL[] {
					switch ( shape.kind ) {

						case "boolean":
						case "number":
						case "string":
						case "dictionary":

							return valuesToTerms(values, shape).map(term =>
								forward([entry, property, term])
							);

						case "reference":

							if ( shape.foreign === true ) { return []; } else {

								return valuesToTerms(values, shape).filter(node => node.kind === "named").flatMap(node => [
									forward([entry, property, node]),
									reverse([entry, property, node])
								]);

							}

						case "resource":

							if ( !isObject(values) ) {return [];} else {

								return valuesToTerms(values, shape).filter(node => node.kind === "named").flatMap(node => [
									forward([entry, property, node]),
									reverse([entry, property, node]),
									record(node, shape, values)
								]);

							}

					}
				}

			}

		}

	}

	function remove(entry: Reference, flake: Flake): SPARQL {

		const branches = Object.values(flake.entries ?? {}).flat();

		const root = scope.resolve();

		// wildcard patterns matching every triple incident on `?root` (outgoing then incoming),
		// resolved once so the same variables bind in both the DELETE template and the WHERE match

		const wildcard = [
			pattern([root, scope.resolve(), scope.resolve()]),
			pattern([scope.resolve(), scope.resolve(), root])
		];

		return deleet(fragment(...wildcard), where(
			union(
				values([variable(root)], [[reference(entry)]]),
				...matches(named(entry), [], branches)
			),
			union(...wildcard)
		));


		function matches(anchor: Variable | Named, prefix: readonly SPARQL[], level: readonly Branch[]): readonly SPARQL[] {
			return level.flatMap(branch => {

				if ( branch.entry.kind === "property" && isCascading(branch.entry.range.shape) ) {

					const property = branch.entry;

					const here = fragment(
						...prefix,
						forward([anchor, property, root]),
						reverse([anchor, property, root])
					);

					const perVariant = getShapeVariants(property.range.shape)
						.map(variant => getFlakeVariant(branch, variant))
						.filter(bs => bs.length > 0);

					if ( perVariant.length === 0 ) {

						return [here];

					} else {

						const next = scope.resolve();

						const step = [
							...prefix,
							forward([anchor, property, next]),
							reverse([anchor, property, next])
						];

						return [here, ...perVariant.flatMap(bs => matches(next, step, bs))];

					}

				} else {

					return [];

				}

			});
		}

	}


	function isTyped(shape: Shape): boolean {
		return shape.kind === "union" ? shape.variants.some(isTyped)
			: shape.kind === "resource" && Object.values(shape.entries).some(p => p.kind === "type");
	}

	function isLeaf(shape: Shape): boolean {
		return shape.kind === "union" ? shape.variants.some(isLeaf)
			: shape.kind !== "resource" && (shape.kind !== "reference" || shape.foreign !== true);
	}

	function isOwn(shape: Shape): boolean {
		return shape.kind === "union" ? shape.variants.some(isOwn)
			: shape.kind !== "reference" || shape.foreign !== true;
	}

	function isCascading(shape: Shape): boolean {
		return shape.kind === "union" ? shape.variants.some(isCascading)
			: shape.kind === "reference" && shape.captive === true || shape.kind === "resource";
	}

}
