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
 * Clearing and deleting walk the plan once each into the {@link Step | steps} reaching the edges they act on, and
 * every clause of the operation is read off those steps, so the `delete` template of a clearing update and the
 * `where` arms binding it can never drift apart. Clearing an entry scales with the number of triples it owns,
 * embedded resources included, rather than with the product of the values of its multi-valued properties, so
 * updating a richly described resource stays fast however many keywords, documents or reviews it carries.
 *
 * @see {@link https://www.w3.org/TR/sparql11-update/ SPARQL 1.1 Update}
 *
 * @module
 */

import { getStateEntries, type Property, type ResourceShape } from "@metreeca/blue/resource";
import { getShapeBranches, getStateBranch } from "@metreeca/blue/union";
import { eager, type Shape } from "@metreeca/blue/value";
import { isObject } from "@metreeca/core";
import type { Scope } from "@metreeca/core/scope";
import { type Branch, type Flake, getFlakeVariant, isPropertyBranch } from "@metreeca/keep-flake";
import type { Deferred, Modify } from "@metreeca/keep/batching";
import type { Reference, Resource, Values } from "@metreeca/qest/state";
import { named, type Named, rdf } from "@metreeca/trio";
import { type SPARQL, type Variable } from "@metreeca/wire-sparql";
import {
	data,
	deleet,
	fragment,
	group,
	insert as create,
	nil,
	pattern,
	reference,
	union,
	update,
	values,
	variable,
	where
} from "@metreeca/wire-sparql/builder";
import { forward, reverse } from "../patterns.js";
import { valuesToTerms } from "../terms.js";


/**
 * One edge a plan walk reaches under an entry: the stored type of a resource, or the stored edge of a property,
 * each with the edges leading to its subject, so an arm built from the step binds every variable on its own.
 */
type Step = {

	/**
	 * The edges reaching `subject` from the root entry.
	 */
	readonly path: readonly SPARQL[];

	/**
	 * The resource holding the edge.
	 */
	readonly subject: Variable | Named;

} & (

	| {

	/**
	 * The resource shape whose `rdf:type` triple the step reaches.
	 */
	readonly shape: ResourceShape;

}

	| {

	/**
	 * The property branch whose stored edge the step reaches.
	 */
	readonly branch: Branch & { readonly entry: Property };

	/**
	 * The variable the edge binds its stored object to.
	 */
	readonly object: Variable;

}

	);


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

		return create(data(
			forward([named(entry), property, named(item)]),
			reverse([named(entry), property, named(item)])
		));

	}

	/**
	 * Clears the edges the entry owns and inserts the supplied state. The clearing `delete` template and its
	 * `where` arms come from the same steps: one arm per owned edge, each starting with the edges leading to it,
	 * so matched rows add up across edges instead of multiplying and the update stays linear in the triples. An
	 * arm matches the edge in whichever direction it is stored, so an edge a graph loaded by other means carries
	 * in one direction only is cleared too, and the template retracts both directions of what matched.
	 */
	function insert(entry: Reference, flake: Flake, state: Resource): SPARQL {

		const owned = steps(scope, [], named(entry), flake, isOwn, isEmbedding);

		return update(
			deleet(group(...owned.map(step => fragment(...edges(step)))), where(union(...owned.map(step =>
				fragment(...step.path, either(step))
			)))),
			create(data(content(entry, flake, state)))
		);

	}

	/**
	 * Deletes every triple incident on the entry and on the embedded and captive resources under it: one arm per
	 * cascading edge binds the cascaded resource to the wildcard subject, so the wildcard patterns match its
	 * triples as they match the entry's own. The arm reaches the cascaded resource through whichever direction of
	 * the edge is stored, so a resource linked in one direction only is deleted with its captor too.
	 */
	function remove(entry: Reference, flake: Flake): SPARQL {

		const root = scope.resolve();

		// wildcard patterns matching every triple incident on `?root` (outgoing then incoming),
		// resolved once so the same variables bind in both the `delete` template and the `where` match

		const wildcard = [
			pattern([root, scope.resolve(), scope.resolve()]),
			pattern([scope.resolve(), scope.resolve(), root])
		];

		const cascaded = steps(scope, [], named(entry), flake, isCascading, () => true).flatMap(step =>
			"branch" in step ? [fragment(...step.path, either({ ...step, object: root }))] : []
		);

		return deleet(group(...wildcard), where(
			union(
				values([variable(root)], [[reference(entry)]]),
				...cascaded
			),
			union(...wildcard)
		));

	}


	/**
	 * The stored edges a step reaches: the `rdf:type` triple of a resource, or the forward and reverse edges of a
	 * property, in the directions it declares, so a `delete` template built from them retracts both of them at once.
	 */
	function edges(step: Step): readonly SPARQL[] {
		return "shape" in step
			? [classed(step)]
			: [forward([step.subject, step.branch.entry, step.object]), reverse([step.subject, step.branch.entry, step.object])];
	}

	/**
	 * The pattern matching a step's edge in whichever direction it is stored: the `rdf:type` triple of a resource, or
	 * the stored directions of a property as alternatives, so a property declaring both matches a pair carrying either.
	 */
	function either(step: Step): SPARQL {
		return "shape" in step
			? classed(step)
			: stored(step.subject, step.branch.entry, step.object);
	}

	/**
	 * The `rdf:type` triple a resource step reaches, its class bound to the variable keyed on the resource shape.
	 */
	function classed({ subject, shape }: Step & { readonly shape: ResourceShape }): SPARQL {
		return pattern([subject, named(rdf.type), scope.resolve(shape)]);
	}

	/**
	 * The triples inserting a state under its entry: the class lineage and the facts of every entry the state
	 * carries, embedded resources recursively; nothing for a state satisfying no variant of the plan's shape.
	 */
	function content(entry: Reference, flake: Flake, state: Resource): SPARQL {

		const shape = getStateBranch(state, getShapeBranches(flake.range.shape));

		return shape === undefined || shape.kind !== "resource" ? nil() : record(named(entry), shape, state);


		function record(entry: Named, shape: ResourceShape, state: Resource): SPARQL {

			// denormalise the class lineage as `rdf:type` triples (own `class` plus inherited `classes`),
			// so an exact-match query on any supertype reaches the instance (class-lineage retrieval)

			return fragment(
				shape.class !== undefined ? pattern([entry, named(rdf.type), named(shape.class)]) : nil(),
				...(shape.classes ?? []).map(clazz => pattern([entry, named(rdf.type), named(clazz)])),
				...getStateEntries(shape, state).flatMap(({ property, shape, value }) => facts(property, value, shape))
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

						if ( !isObject(values) ) { return []; } else {

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


/**
 * Walks a plan into the steps reaching the edges it owns under `subject`: the stored type of each resource variant
 * declaring one, then, for each property `admits`, its stored edge, followed by the steps under the resource it
 * reaches where `descends` holds. Each step carries the edges leading to its subject, keyed on branch identity, so
 * an arm built from it binds every variable on its own and the same edge takes the same variable in every clause.
 */
function steps(
	scope: Scope<Variable>,
	path: readonly SPARQL[],
	subject: Variable | Named,
	flake: Flake,
	admits: (property: Property) => boolean,
	descends: (property: Property) => boolean
): readonly Step[] {

	return getShapeBranches(flake.range.shape).flatMap(shape => shape.kind !== "resource" ? [] : [

		...(isTyped(shape) ? [{ path, subject, shape }] : []),

		...getFlakeVariant(flake, shape).flatMap((branch): readonly Step[] => {

			if ( isPropertyBranch(branch) && admits(branch.entry) ) {

				const object = scope.resolve(branch);
				const reach = stored(subject, branch.entry, object);

				return reach === nil() ? [] : [
					{ path, subject, branch, object },
					...(descends(branch.entry) ? steps(scope, [...path, reach], object, branch, admits, descends) : [])
				];

			} else {

				return [];

			}

		})

	]);

}


/**
 * The pattern matching a property's edge in whichever direction it is stored: its declared directions as alternatives,
 * so a pair stored in one direction only still matches; the empty fragment for a property declaring none.
 */
function stored(subject: Variable | Named, property: Property, object: Variable): SPARQL {

	const directions = [forward([subject, property, object]), reverse([subject, property, object])]
		.filter(direction => direction !== nil());

	return directions.length === 0 ? nil()
		: directions.length === 1 ? directions[0]
			: union(...directions);

}

/**
 * Checks whether a shape owns the `rdf:type` triples of the resources it describes.
 *
 * A `type` member activates only on a shape declaring its own target class, so a common supershape may factor the
 * member without contributing a type: the class-less shapes inheriting it carry no type of their own and their
 * stored `rdf:type` triples are left to whichever shape declared them, untouched by a clearing update under them.
 */
function isTyped(shape: Shape): boolean {
	return shape.kind === "union" ? getShapeBranches(shape).some(isTyped)
		: shape.kind === "resource" && shape.class !== undefined;
}

/**
 * Checks whether a property's edges belong to the resource holding it, so a clearing update retracts them: every
 * property but a foreign one, which reads edges another property owns and a clearing update must leave as they are.
 */
function isOwn(property: Property): boolean {
	return property.foreign !== true;
}

/**
 * Checks whether a property embeds the resources it reaches, so a clearing update descends into their edges: a
 * captive or plain reference keeps its own state, and only its link is retracted.
 */
function isEmbedding(property: Property): boolean {
	return getShapeBranches(property.range.shape).some(variant => variant.kind === "resource");
}

/**
 * Checks whether the resources a property reaches are deleted together with the resource holding it: embedded
 * resources, which have no lifecycle of their own, and captive references, cascade-deleted by contract.
 */
function isCascading(property: Property): boolean {

	return property.captive === true || embedded(eager(property.range.shape));

	function embedded(shape: Shape): boolean {
		return shape.kind === "union" ? getShapeBranches(shape).some(embedded) : shape.kind === "resource";
	}

}
