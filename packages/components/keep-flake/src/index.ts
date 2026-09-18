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
 * A shape and its optional retrieval model or collection query, represented as a single traversal tree.
 *
 * A {@link Shape} and its retrieval {@link @metreeca/qest/model!Template | Template} scatter what to fetch
 * across the structure as independent probes (property requests, constraints, transforms), leaving the
 * collective traversal that satisfies them implicit. A flake makes it explicit, reorganising the probes
 * into one tree a shape-driven processor walks directly instead of correlating raw shape with raw input
 * at every step.
 *
 * {@link createFlake} produces three flavours of the tree, one per overload:
 *
 * - **shape** — a resource full structural reach, with no input (a leaf for a non-resource root);
 * - **model** — the reach restricted to the properties a retrieval {@link @metreeca/qest/model!Template | Template} addresses, each node
 *   carrying the {@link Flake.drain | drain} requested for it (a
 *   {@link @metreeca/qest/model!Template} on a resource root; any other form, or a non-resource root,
 *   degenerates to a leaf);
 * - **query** — a collection member shape tagged with the constraints, ordering, and projection a
 *   {@link Mould} expresses.
 *
 * Every node, the root included, is a {@link Flake} located by its {@link Flake.path | path} along the
 * property axis and its {@link Flake.pipe | pipe} along the transform axis, and sharing the same
 * constraint, ordering, and projection slots. A resource node branches along both axes; a non-resource
 * node is a bare leaf:
 *
 * - **property branches** — a node steps through its {@link Flake.entries | entries} into one
 *   {@link Branch} per addressed {@link Id} / {@link Type} / {@link Property}, a union-typed property
 *   keeping one branch per variant. The {@link Flake.path | path} records this axis;
 * - **transform stages** — a node hangs each {@link Transform} a query applies off its
 *   {@link Flake.transforms | transforms} as a nested {@link Flake}. The {@link Flake.pipe | pipe}
 *   records this axis.
 *
 * @group Components
 *
 * @module index
 */

import { getShapeProperties, type Id, type Member, type Property, type Type } from "@metreeca/blue/resource";
import { eager, type Range, type Shape } from "@metreeca/blue/value";
import { type Identifier, isObject, type Lazy } from "@metreeca/core";
import { some } from "@metreeca/core/arrays";
import { by } from "@metreeca/core/order";
import type { Dictionary, Literal } from "@metreeca/qest/state";
import {
	getOrderPrecedence,
	isAggregate,
	type Option,
	type Options,
	type Placeholder,
	type Projection,
	type Query,
	type Template,
	type Transform,
	type Union
} from "@metreeca/qest/model";
import { createModelFlake } from "./model.js";
import { createQueryFlake as createFlakeQuery } from "./query.js";
import { createShapeFlake } from "./shape.js";


/**
 * A node of a flake.
 *
 * The common base of every node: the root, each {@link Branch}, and each transform stage. Carries the
 * {@link Flake.path | path} locating it, the {@link Flake.entries | entries} it steps into, and the
 * optional {@link Flake.drain | retrieval}, transform, and constraint slots a query populates.
 */
export type Flake = {

	/**
	 * The address of this node: the {@link Property} names walked from the root. Empty at the root.
	 */
	readonly path: readonly Identifier[];

	/**
	 * The transforms applied at this node. Empty except on a transform stage.
	 */
	readonly pipe: readonly Transform[];


	/**
	 * The effective value {@link Range} this node resolves to against the flake's driving shape.
	 *
	 * The type and cardinality the node's {@link Flake.path | path} and {@link Flake.pipe | pipe} yield,
	 * composed across the steps from the root, so a single-valued property under a multi-valued ancestor
	 * reports the multi-valued cardinality. It is the transform's output on a transform stage; the entry's
	 * effective range on a {@link Branch} (an {@link Id} / {@link Type} marker resolving to the IRI range);
	 * the enveloped driving shape on the root {@link Flake}. Precomputed so consumers read it directly
	 * instead of re-resolving through blue's {@link @metreeca/blue/value!effective | effective}.
	 */
	readonly range: Range;

	/**
	 * The retrieval requested at this node, in a model- or query-mode flake.
	 *
	 * On a {@link Branch}, the {@link Drain.mould | fragment} requested for the property; on the root
	 * {@link Flake}, the whole retrieval. A query projecting the node also binds its
	 * {@link Drain.alias | alias}. Absent where nothing is requested.
	 */
	readonly drain?: Drain;


	/**
	 * The transform stages hanging off this node, keyed by the {@link Transform} each applies.
	 */
	readonly transforms?: Transforms;

	/**
	 * This node's property branches (see {@link Entries}).
	 *
	 * Absent where the node has none: scalars, localised ranges, {@link Id} / {@link Type} markers, and
	 * multi-valued properties.
	 */
	readonly entries?: Entries;


	/**
	 * Strict upper bound constraint (`<` operator).
	 */
	readonly lt?: Literal;

	/**
	 * Strict lower bound constraint (`>` operator).
	 */
	readonly gt?: Literal;

	/**
	 * Inclusive upper bound constraint (`<=` operator).
	 */
	readonly lte?: Literal;

	/**
	 * Inclusive lower bound constraint (`>=` operator).
	 */
	readonly gte?: Literal;


	/**
	 * Substring or pattern match constraint (`~` operator).
	 */
	readonly like?: string;

	/**
	 * Existential set membership constraint ("any of", `?` operator).
	 */
	readonly any?: Options;

	/**
	 * Universal set membership constraint ("all of", `!` operator).
	 */
	readonly all?: Options;


	/**
	 * Focus boost (`+` operator), biasing ranking towards matching resources.
	 */
	readonly focus?: Options;

	/**
	 * Sort-key precedence (`^` operator). The absolute value sets the position across sort keys; the
	 * sign sets the direction.
	 */
	readonly order?: number;


	/**
	 * Result-window offset (`@` operator).
	 */
	readonly offset?: number;

	/**
	 * Result-window upper bound (`#` operator).
	 */
	readonly limit?: number;

}

/**
 * Property-step node of a flake.
 */
export type Branch = Flake & {

	/**
	 * The shape member this branch steps through.
	 */
	readonly entry: Member;

}


/**
 * The retrieval requested at a {@link Flake | node} of a flake.
 *
 * Pairs the requested template fragment with the projection alias a query binds to it, if any. The
 * fragment shape and the presence of an alias jointly classify the node: use {@link isModelBranch} /
 * {@link isQueryBranch} to split a plain retrieval, {@link isProbeBranch} to pick out a projected one.
 */
export type Drain = {

	/**
	 * The projection alias, when a query projects the node.
	 *
	 * The name the node's values are reported under in the projected result. Absent on an unprojected
	 * template retrieval.
	 */
	readonly alias?: Identifier;

	/**
	 * The requested template fragment.
	 */
	readonly mould: Mould;

};

/**
 * The retrieval fragment requested at a {@link Flake | node} of a flake.
 *
 * Every form a template entry takes, with the collection {@link @metreeca/qest/model!Criteria | criteria} constraining
 * it merged in: an {@link @metreeca/qest/model!Atomic | atomic} leaf, a nested
 * {@link @metreeca/qest/model!Template | template}, a {@link @metreeca/qest/model!Locale | locale} map, a
 * {@link @metreeca/qest/model!Union | union} of those, or a {@link @metreeca/qest/model!Projection | projection}.
 * Retrieval keys and constraint keys share one key space, so a node states what to retrieve and which items to
 * retrieve it for in one object.
 */
export type Mould = Query<
	| Placeholder
	| Union<Placeholder>
	| Projection
>;

/**
 * A node's transform stages, keyed by the {@link Transform} each stage applies.
 */
export type Transforms = {

	readonly [transform in Transform]?: Flake;

};

/**
 * A node's property branches, keyed by property name.
 *
 * Each name maps to the {@link Branch | branches} reachable through it: one branch for a plain
 * property, one per declaring variant for a union-typed property, so a name shared across variants
 * keeps every variant branch rather than collapsing to one.
 *
 * > [!IMPORTANT]
 * > Sibling branches under one name share identical {@link Flake} fields, differing only in
 * > {@link Branch | entry}, {@link Flake.drain | drain}, and {@link Flake.entries | entries}.
 * > The replication is intentional: it leaves every {@link Branch} a self-contained {@link Flake}, so
 * > consumers walk uniformly without special-casing union fan-out.
 */
export type Entries = {

	readonly [entry: Identifier]: readonly Branch[]; // !!! why Branch[]!? variants are stored in Branch.range

};


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Builds a flake from a shape, capturing its full structural reach.
 *
 * A non-resource root yields a degenerate leaf flake with no property branches.
 *
 * @param shape The {@link Lazy | lazy} root shape
 *
 * @returns An immutable {@link Flake} over the shape structural reach
 */
export function createFlake(shape: Lazy<Shape>): Flake;

/**
 * Builds a flake from a shape and a retrieval template, keeping only the properties the template addresses,
 * each branch carrying the {@link Flake.drain | drain} requested for it, the constraints merged into that
 * request, and the transforms and projection marks it directs.
 *
 * Property branches form only on a resource root; a non-resource root yields a degenerate leaf flake.
 *
 * @param shape The {@link Lazy | lazy} root shape
 * @param model The retrieval {@link @metreeca/qest/model!Template | template} selecting the properties to keep
 *
 * @returns An immutable {@link Flake} restricted to the template-addressed properties
 */
export function createFlake(shape: Lazy<Shape>, model: Template): Flake;

/**
 * Builds a {@link Flake} from a {@link Shape} and an optional retrieval
 * {@link @metreeca/qest/model!Template | template}.
 */
export function createFlake(shape: Lazy<Shape>, model?: Template): Flake {

	return model === undefined ? createShapeFlake(eager(shape))
		: createModelFlake(eager(shape), model);

}

/**
 * Builds a flake from a collection's member shape and the node retrieving it, tagging each addressed node with
 * the constraints, ordering, and projection the node expresses.
 *
 * A collection is reached through the entry naming it, which carries its
 * {@link @metreeca/qest/model!Criteria | criteria} merged in alongside its retrieval keys, so a caller holding
 * such an entry resolves the collection through this rather than through {@link createFlake}, whose root states
 * a plain {@link @metreeca/qest/model!Template | template}.
 *
 * @param shape The {@link Lazy | lazy} member shape of the collection's elements
 * @param query The node retrieving the collection, its criteria merged in
 *
 * @returns An immutable {@link Flake} tagged with the constraints, ordering, and projection `query` expresses
 */
export function createQueryFlake(shape: Lazy<Shape>, query: Mould): Flake {

	return createFlakeQuery(eager(shape), query);

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Checks whether a {@link Flake} is a transform stage rather than a property or marker step.
 *
 * A computed node carries at least one {@link Transform} along its {@link Flake.pipe | pipe}, so its value is
 * produced by the transform pipeline instead of read straight from a property edge. The test is local to the
 * node and ignores any stages or branches nested beneath it.
 *
 * @param flake The flake to test
 *
 * @returns true when the node carries at least one transform; false otherwise
 */
export function isComputedFlake(flake: Flake): boolean {
	return flake.pipe.length > 0;
}

/**
 * Checks whether a {@link Flake} is an aggregate transform stage.
 *
 * True for a {@link isComputedFlake | computed} node whose leading {@link Flake.pipe | pipe} transform
 * aggregates a group (`qest`'s {@link @metreeca/qest/model!isAggregate | isAggregate}), such as a count or
 * sum. Aggregate stages drive grouped query semantics: the non-aggregate projection bindings become the
 * `GROUP BY` keys and the aggregate filters move to `HAVING`. The test is local to the node; walk the tree to
 * find aggregate stages nested beneath it.
 *
 * @param flake The flake to test
 *
 * @returns true when the node's leading transform aggregates; false otherwise
 */
export function isAggregateFlake(flake: Flake): boolean {
	return isComputedFlake(flake) && isAggregate(flake.pipe[0]);
}

/**
 * Checks whether a {@link Flake} is a scalar (non-aggregating) transform stage.
 *
 * True for a {@link isComputedFlake | computed} node whose leading {@link Flake.pipe | pipe} transform yields
 * one value per input rather than aggregating a group, such as a year or absolute-value transform. The
 * complement of {@link isAggregateFlake} among computed nodes. The test is local to the node.
 *
 * @param flake The flake to test
 *
 * @returns true when the node's leading transform is non-aggregating; false otherwise
 */
export function isScalarFlake(flake: Flake): boolean {
	return isComputedFlake(flake) && !isAggregate(flake.pipe[0]);
}

/**
 * Checks whether a {@link Flake} groups the query.
 *
 * True when any of the flake's {@link getFlakeProjections | projected flakes} carries an
 * {@link @metreeca/qest/model!isAggregate | aggregate} transform along its {@link Flake.pipe | pipe}. A single
 * aggregate projection switches the whole query to grouped semantics: the non-aggregate projections become the
 * grouping keys (see {@link getFlakeGrouping}) and the aggregates reduce each group. Scans the projection set across
 * the tree, unlike {@link isAggregateFlake}, which tests one node.
 *
 * @param flake The flake to test
 *
 * @returns true when at least one projection aggregates; false otherwise
 */
export function isGroupingFlake(flake: Flake): boolean {
	return getFlakeProjections(flake).some(flake => flake.pipe.some(isAggregate));
}


/**
 * Checks whether a {@link Flake} requests any retrieval, at the node or anywhere beneath it.
 *
 * True when the node carries a {@link Flake.drain | drain}, or any of its transform stages or property
 * branches does, at any depth. Marks a subtree that contributes projected values to the result, as opposed to
 * one present only to carry constraints.
 *
 * @param flake The flake to test
 *
 * @returns true when the node or any descendant carries a drain; false otherwise
 */
export function isDrainedFlake(flake: Flake): boolean {
	return flake.drain !== undefined
		|| getFlakeTransforms(flake).some(isDrainedFlake)
		|| getFlakeEntries(flake).some(isDrainedFlake);
}

/**
 * Checks whether a {@link Flake} carries any constraint, ranking, or ordering slot, at the node or anywhere
 * beneath it.
 *
 * True when the node carries any filtering constraint, {@link Flake.focus | focus} boost, or {@link Flake.order |
 * order} key, or when any transform stage or property branch does, at any depth. Broader than {@link isFilteredFlake},
 * which counts filtering constraints alone.
 *
 * @param flake The flake to test
 *
 * @returns true when the node or any descendant carries a constraint, focus, or order slot; false otherwise
 */
export function isConstrainedFlake(flake: Flake): boolean {
	return flake.lt !== undefined
		|| flake.gt !== undefined
		|| flake.lte !== undefined
		|| flake.gte !== undefined
		|| flake.like !== undefined
		|| flake.any !== undefined
		|| flake.all !== undefined
		|| flake.focus !== undefined
		|| flake.order !== undefined
		|| getFlakeTransforms(flake).some(isConstrainedFlake)
		|| getFlakeEntries(flake).some(isConstrainedFlake);
}

/**
 * Checks whether a {@link Flake} carries a filtering constraint, at the node or anywhere beneath it.
 *
 * True when the node carries a value-, pattern-, or membership-matching constraint, or when any transform stage or
 * property branch does, at any depth. Narrower than {@link isConstrainedFlake}: the {@link Flake.focus | focus} and
 * {@link Flake.order | order} slots do not count as filters.
 *
 * @param flake The flake to test
 *
 * @returns true when the node or any descendant carries a filtering constraint; false otherwise
 */
export function isFilteredFlake(flake: Flake): boolean {
	return flake.lt !== undefined
		|| flake.gt !== undefined
		|| flake.lte !== undefined
		|| flake.gte !== undefined
		|| flake.like !== undefined
		|| flake.any !== undefined
		|| flake.all !== undefined
		|| getFlakeTransforms(flake).some(isFilteredFlake)
		|| getFlakeEntries(flake).some(isFilteredFlake);
}

/**
 * Checks whether a {@link Flake} carries an existence-implying filter constraint.
 *
 * Such a constraint marks the retrieval path as required rather than optional. Existence is implied by a filtering
 * constraint whose membership options name at least one non-null value (see {@link hasValueOptions}). A null-only
 * membership set, the ranking and pagination slots, and any constraint behind an aggregate pipe (which filters groups,
 * not the path) all leave the path optional. A constraint on any descendant marks the whole path to it required.
 *
 * @param flake The flake to test
 *
 * @returns true when an existence-implying constraint appears anywhere in the flake
 */
export function isRequiredFlake(flake: Flake): boolean {
	return !flake.pipe.some(isAggregate) && (
			flake.lt !== undefined
			|| flake.gt !== undefined
			|| flake.lte !== undefined
			|| flake.gte !== undefined
			|| flake.like !== undefined
			|| hasValueOptions(flake)
		)
		|| Object.values(flake.entries ?? {}).flat().some(isRequiredFlake)
		|| Object.values(flake.transforms ?? {}).some(isRequiredFlake);
}


/**
 * Checks whether a {@link Flake}'s membership constraints name at least one non-null value.
 *
 * Scans the node's own {@link Flake.any | any} and {@link Flake.all | all} option sets for a value other than
 * `null`. A `null` option matches an absent value, so a null-only or empty set reports false. This is the
 * condition under which an `any` / `all` constraint implies the constrained value exists (see
 * {@link isRequiredFlake}). The test is local to the node.
 *
 * @param flake The flake to test
 *
 * @returns true when `any` or `all` holds a non-null value; false otherwise
 */
export function hasValueOptions(flake: Flake): boolean {
	return some<Option | Dictionary>(flake.any).some(option => option !== null)
		|| some<Option | Dictionary>(flake.all).some(option => option !== null);
}

/**
 * Checks whether a {@link Flake}'s membership constraints include a localised dictionary option.
 *
 * Scans the node's own {@link Flake.any | any} and {@link Flake.all | all} option sets for a localised
 * {@link Dictionary} option, held as an object rather than a bare scalar or `null`. The test is local to the
 * node.
 *
 * @param flake The flake to test
 *
 * @returns true when `any` or `all` holds a localised dictionary option; false otherwise
 */
export function hasDictionaryOptions(flake: Flake): boolean {
	return some<Option | Dictionary>(flake.any).some(v => isObject(v))
		|| some<Option | Dictionary>(flake.all).some(v => isObject(v));
}

/**
 * Checks whether a {@link Flake}'s membership constraints include an explicit `null` option.
 *
 * Scans the node's own {@link Flake.any | any} and {@link Flake.all | all} option sets for a `null` entry,
 * which matches an absent value and so relaxes the constraint from an existence requirement. The test is
 * local to the node.
 *
 * @param flake The flake to test
 *
 * @returns true when `any` or `all` includes `null`; false otherwise
 */
export function hasNullOptions(flake: Flake): boolean {
	return some<Option | Dictionary>(flake.any).includes(null)
		|| some<Option | Dictionary>(flake.all).includes(null);
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Checks whether a {@link Flake} is a {@link Branch} (a property or marker step) rather than a
 * transform stage, so its {@link Branch | entry} is available.
 *
 * @param flake The node to inspect
 *
 * @returns true if `flake` steps through a {@link Branch | entry}; false for a transform stage
 */
export function isBranch(flake: Flake): flake is Branch {
	return "entry" in flake;
}

/**
 * Checks whether a flake steps through a {@link Property} edge, regardless of what it retrieves: the union
 * of {@link isModelBranch | model}, {@link isQueryBranch | query}, and {@link isProbeBranch | projected}
 * branches, excluding {@link Id} / {@link Type} markers and transform stages.
 *
 * @param flake The flake to inspect
 *
 * @returns true if `flake` is a {@link Branch} whose entry is a {@link Property}; false otherwise, including
 * {@link Id} / {@link Type} markers and transform stages
 */
export function isPropertyBranch(flake: Flake): flake is Branch & {

	readonly entry: Property

} {

	return isBranch(flake) && flake.entry.kind === "property";

}

/**
 * Checks whether a flake steps through a single-valued {@link Property}, whose retrieval addresses one value
 * and admits no collection constraints.
 *
 * Cardinality is read off the property the branch steps through, never off {@link Flake.range | range}, which
 * composes the cardinality of every step from the root and so reports a single-valued property under a
 * multi-valued ancestor as multi-valued.
 *
 * @param flake The flake to inspect
 *
 * @returns true if `flake` is a single-valued {@link Property} with a non-projected drain (or none); false
 * otherwise, including transform stages, {@link Id} / {@link Type} markers, {@link isQueryBranch | collection},
 * and {@link isProbeBranch | projected} branches
 */
export function isModelBranch(flake: Flake): flake is Branch & {

	readonly entry: Property;
	readonly drain?: { readonly mould: Mould }

} {

	return isPropertyBranch(flake)
		&& flake.drain?.alias === undefined
		&& !isCollection(flake.entry);

}

/**
 * Checks whether a flake steps through a multi-valued {@link Property}, whose retrieval addresses a collection
 * and carries the {@link @metreeca/qest/model!Criteria | criteria} narrowing it.
 *
 * Cardinality is read off the property the branch steps through, for the reason given on
 * {@link isModelBranch}.
 *
 * @param flake The flake to inspect
 *
 * @returns true if `flake` is a multi-valued {@link Property} with a non-projected drain; false otherwise,
 * including transform stages, {@link Id} / {@link Type} markers, {@link isModelBranch | single-valued}, and
 * {@link isProbeBranch | projected} branches
 */
export function isQueryBranch(flake: Flake): flake is Branch & {

	readonly entry: Property;
	readonly drain: { readonly mould: Mould }

} {

	return isPropertyBranch(flake)
		&& flake.drain !== undefined
		&& flake.drain.alias === undefined
		&& isCollection(flake.entry);

}

/**
 * Checks whether a property addresses a collection.
 *
 * A property admitting several values addresses a collection, with one exception: a localised property is delivered
 * as a single tag-keyed map whatever its bounds, the per-tag cardinality it declares applying within that map rather
 * than making the property itself multi-valued (§5.4).
 *
 * @param entry The property to test
 *
 * @returns true if `entry` addresses a collection; false otherwise
 */
function isCollection(entry: Property): boolean {
	return entry.range.maxCount !== 1 && eager(entry.range.shape).kind !== "dictionary";
}

/**
 * Checks whether a flake is projected by a query: its {@link Flake.drain | drain} carries a projection alias.
 *
 * @param flake The flake to inspect
 *
 * @returns true if `flake`'s drain binds a projection alias; false otherwise
 */
export function isProbeBranch(flake: Flake): flake is Branch & {

	readonly drain: { readonly alias: Identifier; readonly mould: Mould }

} {

	return isBranch(flake)
		&& flake.drain?.alias !== undefined;

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Collects every projected flake of a {@link Flake} into a flat list.
 *
 * The values of the alias-keyed index {@link getFlakeProjection} builds, dropping the aliases: every flake
 * bearing a projection alias.
 *
 * @param flake The flake to collect from
 *
 * @returns The projected flakes
 */
export function getFlakeProjections(flake: Flake): readonly Flake[] {
	return Object.values(getFlakeProjection(flake));
}

/**
 * Lists a flake's own transform stages.
 *
 * The {@link Flake} hanging off each {@link Transform} the flake applies (see {@link Flake.transforms |
 * transforms}), as a flat list. Local to the flake: stages nested deeper are not included.
 *
 * @param flake The flake whose transform stages to list
 *
 * @returns The flake's transform stages
 */
export function getFlakeTransforms(flake: Flake): readonly Flake[] {
	return Object.values(flake.transforms ?? {});
}

/**
 * Lists a flake's own property branches.
 *
 * Every {@link Branch} reachable through the flake's {@link Flake.entries | entries}, flattened across
 * property names and union variants into a single list. Local to the flake: branches nested deeper are not
 * included.
 *
 * @param flake The flake whose property branches to list
 *
 * @returns The flake's property branches
 */
export function getFlakeEntries(flake: Flake): readonly Branch[] {
	return Object.values(flake.entries ?? {}).flat();
}


/**
 * Collects every projection in a {@link Flake} into an alias-keyed index.
 *
 * Each binding alias, unique within a projection (qest §5.6), maps to the single flake bearing it. A union-typed
 * binding folds its variants into that flake's {@link Flake.entries | entries} rather than fanning them to
 * sibling alias-bearing flakes, so no alias is ever shared.
 *
 * @param flake The flake to index
 *
 * @returns A map from each projection alias to the flake bearing it
 */
export function getFlakeProjection(flake: Flake): { readonly [alias: Identifier]: Flake } {

	return Object.fromEntries(projections(flake));

	function projections(flake: Flake): readonly (readonly [Identifier, Flake])[] {
		return [
			...some(flake.drain?.alias).map(alias => [alias, flake] as const),
			...getFlakeTransforms(flake).flatMap(projections),
			...getFlakeEntries(flake).flatMap(projections)
		];
	}

}

/**
 * Collects the grouping keys of a {@link Flake}.
 *
 * The {@link getFlakeProjections | projected flakes} that do not carry an
 * {@link @metreeca/qest/model!isAggregate | aggregate} transform along their {@link Flake.pipe | pipe}. When the
 * flake {@link isGroupingFlake | groups the query}, these are the keys each group is formed on, while the aggregate
 * projections reduce per group.
 *
 * @param flake The flake to collect from
 *
 * @returns The non-aggregating projected flakes that form the grouping keys
 */
export function getFlakeGrouping(flake: Flake): readonly Flake[] {
	return getFlakeProjections(flake).filter(flake => !flake.pipe.some(isAggregate));
}

/**
 * Collects the focus keys of a {@link Flake}.
 *
 * Every coordinate under the flake that bears a {@link Flake.focus | focus} boost (qest §5.7.4), gathered in
 * document order by descending through transform stages and nested property branches. A focus boost ranks its
 * matching resources ahead of the regular {@link getFlakeOrdering | sort order}, independently of the sort
 * precedence, so these coordinates form a distinct key set from the ordering ones.
 *
 * @param flake The flake to collect from
 *
 * @returns The focus-bearing coordinates, in document order
 */
export function getFlakeFocusing(flake: Flake): readonly (Flake & { readonly focus: Options })[] {

	return [
		...(isFocusing(flake) ? [flake] : []),
		...getFlakeTransforms(flake).flatMap(getFlakeFocusing),
		...getFlakeEntries(flake).flatMap(getFlakeFocusing)
	];

	function isFocusing(flake: Flake): flake is Flake & { readonly focus: Options } {
		return flake.focus !== undefined;
	}

}

/**
 * Collects the sort keys of a {@link Flake}, by ascending precedence.
 *
 * Every coordinate under the flake that bears a {@link Flake.order | sort order} (qest §5.7.5), gathered by
 * descending through transform stages and nested property branches, then ordered by its
 * {@link @metreeca/qest/model!getOrderPrecedence | precedence} with document order breaking ties. These are
 * the regular sort criteria, applied after any {@link getFlakeFocusing | focus} boost.
 *
 * @param flake The flake to collect from
 *
 * @returns The order-bearing coordinates, by ascending sort precedence
 */
export function getFlakeOrdering(flake: Flake): readonly (Flake & { readonly order: number })[] {

	return ordering(flake).sort(by(flake => getOrderPrecedence(flake.order)));

	function ordering(node: Flake): (Flake & { readonly order: number })[] {
		return [
			...(isOrdering(node) ? [node] : []),
			...getFlakeTransforms(node).flatMap(ordering),
			...getFlakeEntries(node).flatMap(ordering)
		];
	}

	function isOrdering(flake: Flake): flake is Flake & { readonly order: number } {
		return flake.order !== undefined;
	}

}


/**
 * Slices a node's entry-major branch index down to the branches one variant shape contributes.
 *
 * A node's {@link Entries} index every union variant's branches by property name; this cross-cuts
 * that index along the shape axis, keeping at each name the branches whose name `shape` declares. A path
 * crossing the union under a shared predicate folds to a single branch (§5.8.1) contributed by every
 * variant declaring that name, so such a branch surfaces under each of them.
 *
 * @param flake The node whose branch index to slice: any {@link Flake}, a collection flake root as well as a
 * {@link Branch}
 * @param shape One of the range {@link @metreeca/blue/union!getShapeBranches | branches} to slice by
 *
 * @returns The branches `shape` contributes, in property declaration order
 */
export function getFlakeVariant(flake: Flake, shape: Shape): readonly Branch[] {

	const entries = getShapeProperties(shape);

	return Object.entries(flake.entries ?? {}).flatMap(([name, branches]) =>
		entries[name] !== undefined ? branches : []
	);

}
