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
 * Modify-pass SPARQL update encoder.
 *
 * Folds a batch of {@link Modify} requests into one SPARQL 1.1 update applied in submission order:
 *
 *  - a request carrying a `link` inserts the membership edge alone, leaving the entry's own state untouched;
 *  - a request carrying a `state` clears the entry's owned triples and inserts the supplied state;
 *  - a request with no `state` deletes the entry together with its embedded and captive descendants.
 *
 * The request's {@link Flake | plan} drives every structural decision. Forward and reverse predicates are both
 * written, foreign properties are left untouched, and embedded resources are written recursively while references
 * are written as links.
 *
 * @see {@link https://www.w3.org/TR/sparql11-update/ SPARQL 1.1 Update}
 *
 * @module
 */

import { type Property, type ResourceShape } from "@metreeca/blue/resource";
import { getShapeBranches, getStateBranch } from "@metreeca/blue/union";
import { eager, type Shape } from "@metreeca/blue/value";
import { isObject, opt } from "@metreeca/core";
import { some } from "@metreeca/core/arrays";
import type { Scope } from "@metreeca/core/scope";
import { type Branch, type Flake, getFlakeVariant } from "@metreeca/keep-flake";
import type { Deferred, Modify } from "@metreeca/keep/batching";
import type { Reference, Resource, Values } from "@metreeca/qest/state";
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
import { forward, reverse, valuesToTerms } from "../index.core.js";


/**
 * Encodes a single SPARQL update covering every request in the batch.
 *
 * @param scope The variable allocator shared across every request's cleanup walk, keyed on
 * {@link Branch} identity
 * @param batch The batched root entries paired with their {@link Flake | mutation plans}
 *
 * @returns The batched SPARQL update
 */
export function encode(
	scope: Scope<Variable>,
	batch: readonly (Deferred<Modify> & { readonly flake: Flake })[]
): SPARQL {

	return update(...batch.map(({ request: { entry, state, link }, flake }) =>
		link !== undefined ? attach(entry, link)
			: state === undefined ? remove(entry, flake)
				: insert(entry, flake, state)
	));


	function attach(entry: Reference, { property, item }: {
		readonly property: Property;
		readonly item: Reference
	}): SPARQL {

		// the membership edge alone, in both directions the property declares: the entry's own state is left as it is

		return create(fragment(
			forward([named(entry), property, named(item)]),
			reverse([named(entry), property, named(item)])
		));

	}

	function insert(entry: Reference, flake: Flake, state: Resource): SPARQL {

		return update(
			deleet(triples(named(entry), flake), where(matches(named(entry), flake))),
			create(data(entry, flake, state))
		);


		function triples(entry: Variable | Named, flake: Flake): SPARQL {
			return fragment(...getShapeBranches(flake.range.shape).flatMap(shape =>
				shape.kind !== "resource" ? [] : [fragment(
					isTyped(shape) ? pattern([entry, named(rdf.type), scope.resolve(shape)]) : nil(),
					...getFlakeVariant(flake, shape).flatMap(branch => {

						const property = branch.entry;

						if ( property.kind === "property" && isOwn(property) ) {

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
			return fragment(...getShapeBranches(flake.range.shape).flatMap(shape =>
				shape.kind !== "resource" ? [] : [fragment(
					isTyped(shape) ? optional(pattern([entry, named(rdf.type), scope.resolve(shape)])) : nil(),
					...getFlakeVariant(flake, shape).flatMap(branch => {

						const property = branch.entry;

						if ( property.kind === "property" && isOwn(property) ) {

							const v = scope.resolve(branch);

							const edges = fragment(
								forward([entry, property, v]),
								reverse([entry, property, v])
							);

							return [
								...(getShapeBranches(property.range.shape).some(variant => variant.kind === "resource")
										? [optional(edges, matches(v, branch))] // only embedded resources recurse
										: []
								),
								...(isLeaf(property)
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

			const shape = getStateBranch(state, getShapeBranches(flake.range.shape));

			return shape === undefined || shape.kind !== "resource" ? nil() : record(named(entry), shape, state);


			function record(entry: Named, shape: ResourceShape, state: Resource): SPARQL {

				// denormalise the class lineage as `rdf:type` triples (own `class` plus inherited `classes`),
				// so an exact-match query on any supertype reaches the instance (class-lineage retrieval)

				return fragment(
					shape.class !== undefined ? pattern([entry, named(rdf.type), named(shape.class)]) : nil(),
					...(shape.classes ?? []).map(clazz => pattern([entry, named(rdf.type), named(clazz)])),
					...Object.entries(shape.members).flatMap(([label, property]) => {

						const values = state[label];

						if ( property.kind === "property" && values !== undefined ) {

							const variants = getShapeBranches(property.range.shape);

							return some(values).flatMap(value => opt(getStateBranch(value, variants),
								variant => facts(property, value, variant),
								[]
							));

						} else {

							return [];

						}

					})
				);

				function facts(property: Property, values: Values, shape: Shape): readonly SPARQL[] {
					switch ( shape.kind ) {

						case "boolean":
						case "number":
						case "string":
						case "dictionary":

							return valuesToTerms(values, shape).map(term =>
								forward([entry, property, term])
							);

						case "reference":

							if ( property.foreign === true ) { return []; } else {

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

						case "union": // a range variant is always a flattened branch, never a union

							throw new RangeError(`unsupported union variant`);

					}
				}

			}

		}

	}

	function remove(entry: Reference, flake: Flake): SPARQL {

		const branches = Object.values(flake.entries ?? {});

		const root = scope.resolve();

		// wildcard patterns matching every triple incident on `?root` (outgoing then incoming),
		// resolved once so the same variables bind in both the `delete` template and the `where` match

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

				if ( branch.entry.kind === "property" && isCascading(branch.entry) ) {

					const property = branch.entry;

					const here = fragment(
						...prefix,
						forward([anchor, property, root]),
						reverse([anchor, property, root])
					);

					const perVariant = getShapeBranches(property.range.shape)
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


	/**
	 * Checks whether a shape owns the `rdf:type` triples of the resources it describes.
	 *
	 * A `type` member activates only on a shape declaring its own target class, so a common supershape may factor the
	 * member without contributing a type: the class-less shapes inheriting it carry no type of their own and their
	 * stored `rdf:type` triples are left to whichever shape declared them.
	 */
	function isTyped(shape: Shape): boolean {
		return shape.kind === "union" ? getShapeBranches(shape).some(isTyped)
			: shape.kind === "resource" && shape.class !== undefined;
	}

	function isLeaf(property: Property): boolean {

		return property.foreign !== true && leaf(eager(property.range.shape));

		function leaf(shape: Shape): boolean {
			return shape.kind === "union" ? getShapeBranches(shape).some(leaf) : shape.kind !== "resource";
		}

	}

	function isOwn(property: Property): boolean {

		return property.foreign !== true;

	}

	function isCascading(property: Property): boolean {

		return property.captive === true || embedded(eager(property.range.shape));

		function embedded(shape: Shape): boolean {
			return shape.kind === "union" ? getShapeBranches(shape).some(embedded) : shape.kind === "resource";
		}

	}

}
