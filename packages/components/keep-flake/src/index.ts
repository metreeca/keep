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
 * Shape-driven traversal trees.
 *
 * A {@link Shape} and its retrieval {@link @metreeca/qest/model!Template | template} or collection
 * {@link @metreeca/qest/model!Query | query} scatter what to fetch across independent probes: property requests,
 * constraints, and transforms. A flake gathers those probes into one traversal tree. A connector walks that tree
 * directly, instead of matching the raw shape against the raw input at every step.
 *
 * Three flavours of the tree are available:
 *
 * - **shape** — the full structural reach of a resource shape, with no input, built by {@link createFlake};
 * - **model** — the reach restricted to the properties a retrieval template addresses, each node carrying the
 *   {@link Flake.drain | drain} requested for it, built by {@link createFlake};
 * - **query** — a collection member shape tagged with the constraints, ordering, and projections a collection query
 *   expresses, built by {@link createQueryFlake}.
 *
 * Every node, the root included, is a {@link Flake}. Its {@link Flake.path | path} locates it along the property
 * axis and its {@link Flake.pipe | pipe} along the transform axis. A resource node branches along both axes, while a
 * non-resource node is a bare leaf:
 *
 * - **property branches** — a node steps through its {@link Flake.entries | entries} into one {@link Branch} per
 *   addressed {@link Id} / {@link Type} / {@link Property}; a name shared by several variants of a union-typed node
 *   takes a single branch;
 * - **transform stages** — a node holds each {@link Transform} a query applies to it as a nested {@link Flake}
 *   under its {@link Flake.transforms | transforms}.
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
import {
	type Atomic,
	type Cell,
	getOrderPrecedence,
	isAggregate,
	type Locale,
	type Option,
	type Options,
	type Projection,
	type Query,
	type Slot,
	type Template,
	type Transform
} from "@metreeca/qest/model";
import type { Dictionary, Literal } from "@metreeca/qest/state";
import { createModelFlake } from "./model.js";
import { createQueryFlake as createFlakeQuery } from "./query.js";
import { createShapeFlake } from "./shape.js";


/**
 * A node of a flake.
 *
 * The common base of every node: the root, each {@link Branch}, and each transform stage. A node carries the
 * {@link Flake.path | path} locating it and the {@link Flake.range | range} it resolves to. Model- and query-mode
 * flakes add the {@link Flake.drain | retrieval} requested at the node; query-mode flakes also add its transform
 * stages and its constraint, ordering, and pagination slots.
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
	 * The type and cardinality the node's {@link Flake.path | path} and {@link Flake.pipe | pipe} resolve to,
	 * composed across the steps from the root. A single-valued property under a multi-valued ancestor thus carries
	 * the multi-valued cardinality. On the root, the range envelopes the driving shape. On a {@link Branch}, it is
	 * the effective range of the entry; {@link Id} / {@link Type} markers resolve to the IRI range. On a transform
	 * stage, it is the output of the transform. Consumers read it directly, with no need to resolve it again
	 * through blue's {@link @metreeca/blue/value!effective | effective}.
	 */
	readonly range: Range;

	/**
	 * The retrieval requested at this node, in a model- or query-mode flake.
	 *
	 * On the root, the drain holds the whole retrieval. On a {@link Branch}, it holds the query requested for the
	 * property. A projected node, including a transform stage, also carries the binding `alias`. Absent where
	 * nothing is requested.
	 */
	readonly drain?: Drain;


	/**
	 * The transform stages applied to this node, keyed by the {@link Transform} each applies.
	 */
	readonly transforms?: Transforms;

	/**
	 * This node's property branches (see {@link Entries}).
	 *
	 * Absent where the node has none: scalar and localised ranges, {@link Id} / {@link Type} markers, and
	 * transform stages. In a shape-mode flake, references other than captive ones carry none either. In a
	 * model-mode flake, properties retrieved as atomics carry none, and neither do multi-valued properties, whose
	 * drain holds the nested retrieval.
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
	 * Text search constraint (`~` operator).
	 *
	 * Matches values containing every whitespace-separated token of the search string as a case-insensitive
	 * substring.
	 */
	readonly like?: string;

	/**
	 * Existential set matching constraint ("any of", `?` operator).
	 */
	readonly any?: Options;

	/**
	 * Universal set matching constraint ("all of", `!` operator).
	 */
	readonly all?: Options;


	/**
	 * Sort focus (`+` operator): resources whose value is among the options rank first, ahead of the sort order.
	 */
	readonly focus?: Options;

	/**
	 * Sort-key precedence (`^` operator). The absolute value sets the position across sort keys; the
	 * sign sets the direction. The `"asc"`/`"desc"` shorthands are normalised to `1`/`-1`.
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
 * Pairs the {@link @metreeca/qest/model!Query | query} requested at the node with the projection alias bound to
 * it, if any. The drain also settles the `form` the query takes against the node's {@link Flake.range | range}, so
 * consumers switch on the form instead of classifying the query again:
 *
 * - **atomic** — an {@link @metreeca/qest/model!Atomic | atomic} requesting the value as it stands, on any range;
 * - **template** — a {@link @metreeca/qest/model!Template | template} on a resource or reference range;
 * - **locale** — a {@link @metreeca/qest/model!Locale | locale} on a localised range;
 * - **projection** — a {@link @metreeca/qest/model!Projection | projection} on a collection;
 * - **union** — a union on a union-typed range, with its alternatives resolved to the variants they reach.
 *
 * The form follows the query's retrieval keys: a query stating none is an atomic (§5.3).
 *
 * The cardinality of the property the node steps through and the presence of an alias together classify a branch.
 * {@link isModelBranch} and {@link isQueryBranch} tell plain retrievals apart, and {@link isProbeBranch} picks out
 * projected ones.
 */
export type Drain = {

	/**
	 * The projection alias, when a query projects the node.
	 *
	 * The name the node's values are returned under in the projected result. Absent on an unprojected
	 * retrieval.
	 */
	readonly alias?: Identifier;

} & (

	| {

	/**
	 * The query requests the value as it stands: no further shape, whatever the range (§5.3).
	 */
	readonly form: "atomic";

	/**
	 * The query requested at the node, criteria included; its retrieval half states no key.
	 */
	readonly query: Query<Atomic>;

}

	| {

	/**
	 * The query expands a resource, naming the properties to retrieve.
	 */
	readonly form: "template";

	/**
	 * The query requested at the node, criteria included; its retrieval half is the template.
	 */
	readonly query: Query<Template>;

}

	| {

	/**
	 * The query retrieves a localised property tag by tag, as a structured map (§5.4).
	 */
	readonly form: "locale";

	/**
	 * The query requested at the node; its retrieval half is the locale map.
	 */
	readonly query: Query<Locale>;

}

	| {

	/**
	 * The query retrieves a collection as rows of computed values (§5.2).
	 */
	readonly form: "projection";

	/**
	 * The query requested at the node, criteria included; its retrieval half is the projection.
	 */
	readonly query: Query<Projection>;

}

	| {

	/**
	 * The query addresses a union-typed range, one alternative per variant it reaches (§5.5).
	 */
	readonly form: "union";

	/**
	 * The query requested at the node, criteria included: a keyed union, or a single alternative standing for
	 * every variant it fits.
	 */
	readonly query: Query<Cell>;

	/**
	 * The drain of each variant the query reaches, keyed by variant.
	 *
	 * A variant no alternative fits is absent. A variant reached by several alternatives carries them folded into
	 * one request. Each drain is settled against its variant alone, so it is never itself a union.
	 */
	readonly variants: ReadonlyMap<Shape, Drain>;

}

	);

/**
 * A node's transform stages, keyed by the {@link Transform} each stage applies.
 */
export type Transforms = {

	readonly [transform in Transform]?: Flake;

};

/**
 * A node's property branches, keyed by property name.
 *
 * Each name maps to the one {@link Branch} reachable through it. A name declared by several variants of a
 * union-typed node is one property (union coherence, §3.2): its branch ranges over the disjunction of the
 * per-variant declarations (§5.8.1), carries every request reaching it folded into one {@link Flake.drain | drain},
 * and is entered through the first declaring variant's `entry`.
 */
export type Entries = {

	readonly [entry: Identifier]: Branch;

};


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Builds a flake from a shape, capturing its full structural reach.
 *
 * The reach extends into embedded resources and captive references. Other references stay leaves, since their
 * targets have an independent lifecycle. A non-resource root yields a leaf flake with no property branches.
 *
 * > [!WARNING]
 * > Cyclic captive shapes are not supported: building a flake over a captive reference whose target leads back to
 * > it exhausts the call stack.
 *
 * @param shape The {@link Lazy | lazy} root shape
 *
 * @returns An immutable {@link Flake} over the structural reach of `shape`
 */
export function createFlake(shape: Lazy<Shape>): Flake;

/**
 * Builds a flake from a shape and a retrieval template, keeping only the properties the template addresses.
 *
 * The root carries the whole template as its {@link Flake.drain | drain}. Each branch carries the query requested
 * for its property as its own drain, including the criteria of a collection query. Property branches form only on
 * a resource root: a non-resource root yields a leaf flake with no drain.
 *
 * @param shape The {@link Lazy | lazy} root shape
 * @param model The retrieval {@link @metreeca/qest/model!Template | template} selecting the properties to keep
 *
 * @returns An immutable {@link Flake} restricted to the properties `model` addresses
 *
 * @throws {@link !RangeError RangeError} If a query in `model` takes no form its property admits
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
 * Builds a flake from a collection's member shape and the query retrieving it.
 *
 * Each node the query addresses carries the constraints, ordering, pagination, transforms, and projections the
 * query states for it. The root carries the whole query as its {@link Flake.drain | drain}. Collection queries
 * need this factory: unlike the plain {@link @metreeca/qest/model!Template | template} that {@link createFlake}
 * accepts, a query merges its {@link @metreeca/qest/model!Criteria | criteria} with its retrieval keys.
 *
 * @param shape The {@link Lazy | lazy} member shape of the collection's elements
 * @param query The query retrieving the collection, criteria included
 *
 * @returns An immutable {@link Flake} tagged with the constraints, ordering, and projections `query` states
 *
 * @throws {@link !RangeError RangeError} If `query` holds a malformed binding or takes no form the collection admits
 */
export function createQueryFlake(shape: Lazy<Shape>, query: Query<Slot>): Flake {

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
 * sum. Aggregate stages drive grouped query semantics: the non-aggregate projections become the grouping keys, and
 * constraints on aggregates filter groups rather than items. The test is local to the node and ignores aggregate
 * stages nested beneath it; {@link isGroupingFlake} checks the projections across the whole tree.
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
 * grouping keys (see {@link getFlakeGrouping}) and the aggregates reduce each group. The test covers every
 * projection in the tree, unlike {@link isAggregateFlake}, which tests one node.
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
 * branches does, at any depth. Such a subtree contributes retrieved values to the result, unlike one present only
 * to carry constraints.
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
 * True when the node carries any filtering constraint, {@link Flake.focus | focus} boost, or
 * {@link Flake.order | order} key, or when any transform stage or property branch does, at any depth. Broader than
 * {@link isFilteredFlake}, which counts filtering constraints alone. Pagination slots do not count.
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
 * Checks whether a {@link Flake} carries an existence-implying filter constraint, at the node or anywhere beneath it.
 *
 * Such a constraint marks the retrieval path as required rather than optional. Existence is implied by a comparison
 * or text search constraint, or by a set matching constraint naming at least one non-null option (see
 * {@link hasValueOptions}). A null-only option set, the ranking and pagination slots, and any constraint behind an
 * aggregate pipe (which filters groups, not the path) all leave the path optional. A constraint on any descendant
 * marks the whole path to it required.
 *
 * @param flake The flake to test
 *
 * @returns true when an existence-implying constraint appears anywhere in the flake; false otherwise
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
		|| Object.values(flake.entries ?? {}).some(isRequiredFlake)
		|| Object.values(flake.transforms ?? {}).some(isRequiredFlake);
}


/**
 * Checks whether a {@link Flake}'s set matching constraints name at least one non-null value.
 *
 * Inspects the node's own {@link Flake.any | any} and {@link Flake.all | all} option sets for a value other than
 * `null`. A `null` option matches an absent value, so a null-only or empty set fails the test. This is the
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
 * Checks whether a {@link Flake}'s set matching constraints include a localised dictionary option.
 *
 * Inspects the node's own {@link Flake.any | any} and {@link Flake.all | all} option sets for a localised
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
 * Checks whether a {@link Flake}'s set matching constraints include an explicit `null` option.
 *
 * Inspects the node's own {@link Flake.any | any} and {@link Flake.all | all} option sets for a `null` entry.
 * A `null` option matches an absent value, so the constraint no longer requires the value to exist. The test is
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
 * Checks whether a {@link Flake} is a {@link Branch}, that is a property or marker step whose
 * `entry` is available.
 *
 * @param flake The node to inspect
 *
 * @returns true if `flake` steps through a shape member; false for the root and for transform stages
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
 * Cardinality is read off the property the branch steps through, never off {@link Flake.range | range}. The range
 * composes the cardinality of every step from the root, so it shows a single-valued property under a multi-valued
 * ancestor as multi-valued. A localised property counts as single-valued whatever its bounds, since it is retrieved
 * as one tag-keyed map (§5.4).
 *
 * @param flake The flake to inspect
 *
 * @returns true if `flake` is a single-valued {@link Property} with a non-projected drain (or none); false
 * otherwise, including transform stages, {@link Id} / {@link Type} markers, {@link isQueryBranch | collection},
 * and {@link isProbeBranch | projected} branches
 */
export function isModelBranch(flake: Flake): flake is Branch & {

	readonly entry: Property;
	readonly drain?: Drain

} {

	return isPropertyBranch(flake)
		&& flake.drain?.alias === undefined
		&& !isCollection(flake.entry);

}

/**
 * Checks whether a flake steps through a multi-valued {@link Property}, whose retrieval addresses a collection
 * and carries the {@link @metreeca/qest/model!Criteria | criteria} narrowing it.
 *
 * Cardinality is read off the property the branch steps through, as explained on {@link isModelBranch}; localised
 * properties never qualify.
 *
 * @param flake The flake to inspect
 *
 * @returns true if `flake` is a multi-valued {@link Property} with a non-projected drain; false otherwise,
 * including transform stages, {@link Id} / {@link Type} markers, {@link isModelBranch | single-valued}, and
 * {@link isProbeBranch | projected} branches
 */
export function isQueryBranch(flake: Flake): flake is Branch & {

	readonly entry: Property;
	readonly drain: Drain

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

	readonly drain: Drain & { readonly alias: Identifier }

} {

	return isBranch(flake)
		&& flake.drain?.alias !== undefined;

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Collects every projected flake of a {@link Flake} into a flat list.
 *
 * Returns every flake bearing a projection alias, as indexed by {@link getFlakeProjection}, without the aliases.
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
 * Returns the {@link Flake} stage for each {@link Transform} the flake applies (see
 * {@link Flake.transforms | transforms}), as a flat list. Local to the flake: stages nested deeper are not included.
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
 * Every {@link Branch} reachable through the flake's {@link Flake.entries | entries}, one per property name.
 * Local to the flake: branches nested deeper are not included.
 *
 * @param flake The flake whose property branches to list
 *
 * @returns The flake's property branches
 */
export function getFlakeEntries(flake: Flake): readonly Branch[] {
	return Object.values(flake.entries ?? {});
}


/**
 * Collects every projection in a {@link Flake} into an alias-keyed index.
 *
 * Each binding alias, unique within a projection (qest §5.2), maps to the single flake bearing it. A union-typed
 * binding holds its variants in that flake's {@link Flake.entries | entries}, so no alias is ever shared by several
 * flakes.
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
 * Returns every node at or under the flake that bears a {@link Flake.focus | sort focus} (qest §5.7.4), including
 * transform stages and nested property branches. A sort focus ranks its matching resources ahead of the regular
 * {@link getFlakeOrdering | sort order}, whatever the sort precedence, so these nodes form a key set distinct from
 * the ordering one.
 *
 * @param flake The flake to collect from
 *
 * @returns The focus-bearing nodes, in tree order: each node before its transform stages, and those before its
 * property branches
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
 * Returns every node at or under the flake that bears a {@link Flake.order | sort order} (qest §5.7.5), including
 * transform stages and nested property branches. Nodes are sorted by their
 * {@link @metreeca/qest/model!getOrderPrecedence | precedence}, with tree order breaking ties. These are the regular
 * sort criteria, applied after any {@link getFlakeFocusing | sort focus}.
 *
 * @param flake The flake to collect from
 *
 * @returns The order-bearing nodes, by ascending sort precedence
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
 * Selects the property branches of a node that one variant of its range declares.
 *
 * A node's {@link Entries} hold the branches of every union variant, keyed by property name. This view keeps only
 * the branches whose name `shape` declares. A name declared by several variants is one branch (qest §3.2, §5.8.1),
 * so that branch appears under each of them.
 *
 * @param flake The node whose branches to select: any {@link Flake}, including a collection flake root, not only
 * a {@link Branch}
 * @param shape One of the range {@link @metreeca/blue/union!getShapeBranches | variants} to select by
 *
 * @returns The branches `shape` declares, in the order of the node's {@link Flake.entries | entries}
 */
export function getFlakeVariant(flake: Flake, shape: Shape): readonly Branch[] {

	const entries = getShapeProperties(shape);

	return Object.entries(flake.entries ?? {}).flatMap(([name, branch]) =>
		entries[name] !== undefined ? [branch] : []
	);

}
