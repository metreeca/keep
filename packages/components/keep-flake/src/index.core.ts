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
 * Internal helpers for flake builders.
 *
 * Range resolution, drain classification, and property branch assembly shared by the shape-, model-, and
 * query-mode builders. Not part of the package's public API.
 *
 * @module
 */

import { getShapeTarget } from "@metreeca/blue/reference";
import type { Member } from "@metreeca/blue/resource";
import { getModelBranches, getShapeBranches } from "@metreeca/blue/union";
import { effective, type Range, type Shape } from "@metreeca/blue/value";
import { type Identifier, isArray, isObject, isString, type Lazy, opt } from "@metreeca/core";
import { TraceError } from "@metreeca/core/trace";
import { immutable } from "@metreeca/core/values";
import {
	encodeProbe,
	isAtomic,
	isBranch,
	isCell,
	isLocale,
	isProjection,
	isQuery,
	isSelector,
	isSlot,
	isTemplate,
	type Placeholder,
	type Query,
	type Slot,
	type Transform,
	type Union
} from "@metreeca/qest/model";
import type { Branch, Drain, Entries } from "./index.js";


/**
 * Resolves the root node's effective {@link Range}: the driving `shape` enveloped as a range.
 *
 * This is the only shape-to-range conversion in a flake: every other node's range is stepped from its parent's.
 */
export function getRootRange(shape: Shape): Range {
	return getRange(shape, [], []);
}

/**
 * Resolves the child {@link Range} one `property` step from a node's `range` (§5.8.1).
 *
 * The cardinality composes across the step; an `id` / `type` marker resolves to the IRI range.
 */
export function getPropertyRange(range: Range, property: Identifier): Range {
	return getRange(range, [property], []);
}

/**
 * Resolves the {@link Range} a single `transform` produces from a stage's input `range` (§5.8.2).
 *
 * Pipes are resolved one stage at a time, each nested stage stepping from its parent's range.
 */
export function getTransformRange(range: Range, transform: Transform): Range {
	return getRange(range, [], [transform]);
}


/**
 * Resolves a probe against a shape or range through blue's {@link @metreeca/blue/value!effective | effective}.
 *
 * Backs {@link getRootRange}, {@link getPropertyRange}, and {@link getTransformRange}; every range in a flake is
 * built one step at a time through those, never over a multi-step path.
 *
 * @throws {@link @metreeca/core/trace!TraceError | TraceError} If the probe fails to resolve: a contract violation,
 * since Keep validates models at its boundary
 */
function getRange(source: Shape | Range, path: readonly Identifier[], pipe: readonly Transform[]): Range {

	// effective reads only path/pipe; target is required by the Probe guard but ignored, so a placeholder
	// identifier stands in (the empty string would be rejected as malformed)

	const probe = { target: "$", path, pipe };
	const range = effective(source, probe);

	if ( isString(range) ) {
		throw new TraceError(encodeProbe(probe), [range]);
	}

	// frozen up front, so freezing the flake keeps the range as is: drains keyed by its variants stay keyed by the
	// variants the frozen flake exposes, rather than by the originals of their clones

	return immutable(range);

}


/**
 * Pairs each union variant a query retrieves with every alternative reaching it (§5.5).
 *
 * A query addresses a union-typed property in one of two forms:
 *
 *  - a **keyed** {@link @metreeca/qest/model!Union | union}, whose retrieval keys are all opaque branch keys, states
 *    one alternative per key;
 *  - any **other** query is itself the single alternative.
 *
 * Each alternative reaches the variants it matches by form (§5.3): an atomic every variant it can stand for, a
 * template the nested-resource variants answering any of its properties, a locale the localised variant. One
 * alternative may thus reach several variants, and one variant may be reached by several alternatives. A template
 * spanning several variants is handed to each as the properties that variant answers alone.
 *
 * Alternatives are returned as their retrieval half: the criteria riding on the query (§5.6) constrain the collection
 * as a whole and select no variant.
 *
 * > [!IMPORTANT]
 * > Queries are expected to have passed template validation against the property's shape, which rejects an
 * > alternative matching no variant (§5.3, §5.5); an alternative that still matches none contributes nothing here.
 *
 * @param shape The union-typed property's shape, possibly deferred to break definition cycles; its variants are
 * resolved as {@link @metreeca/blue/union!getShapeBranches | getShapeBranches} enumerates them
 * @param query The union-typed property's query: a keyed union, or a single alternative
 *
 * @returns One `[variant, alternative]` pair per alternative and variant it reaches, in alternative order; empty
 * when the query reaches no variant
 */
export function getUnionBranches(shape: Lazy<Shape>, query: Query<Slot>): readonly (readonly [Shape, Query<Slot>])[] {

	const branches = getShapeBranches(shape);

	return isKeyed(query)
		? getQueryEntries(query).flatMap(([, alternative]) => pairs(alternative))
		: pairs(retrieval(query));


	function retrieval(query: Query<Slot>): Slot {

		// ;(cast) Object.fromEntries widens the retrieval entries to a string-keyed record; every key of a query
		// but the criteria is one the slot declares, so the record is the slot the query states

		return Object.fromEntries(getQueryEntries(query)) as Slot;

	}

	function isKeyed(query: Query<Slot>): query is Query<Union<Placeholder>> {

		// the keyed form is decided once for the query as a whole, by its keys alone: branch keys are disjoint
		// from every other retrieval key space and admit no mixing (§5.5), and the atomic, stating no key at all,
		// is a single alternative; the branches hold the placeholders a valid query states under them


		const keys = Object.keys(query).filter(key => !isSelector(key));

		return keys.length > 0 && keys.every(isBranch);

	}

	function pairs(alternative: Query<Slot>): readonly (readonly [Shape, Query<Slot>])[] {
		return (getModelBranches(alternative, branches) ?? []).map((variant): readonly [Shape, Query<Slot>] =>
			[variant, part(variant, alternative)]
		);
	}

	function part(variant: Shape, alternative: Query<Slot>): Query<Slot> {

		// a template may span several resource variants (§5.5), each answering the members it admits alone

		// ;(cast) Object.fromEntries widens the retained entries to a string-keyed record; they are a subset of the
		// template's own entries, so the record is a template

		return getShapeTarget(variant) !== undefined && isQuery(alternative, isTemplate)
			? Object.fromEntries(getQueryEntries(alternative).filter(([name, query]) =>
				getModelBranches({ [name]: query }, [variant]) !== undefined
			)) as Query<Slot>
			: alternative;

	}

}

/**
 * Resolves which union branches a query retrieves, and the alternative retrieving each.
 *
 * Reads the query as {@link getUnionBranches} does and folds the alternatives reaching the same variant into
 * the one request for it, so a variant is retrieved once, to the depth its most demanding alternative asks for: a
 * structured alternative (a template or a locale) prevails over the atomic, and structured alternatives merge their
 * keys, recursively where the same key is requested by several; where they state different criteria for the same
 * nested collection, the later alternative's criterion prevails. The map is the single source of truth shared by an
 * encoder emitting one arm per retrieved variant and a decoder reading each retrieved variant's column and shaping
 * it through its alternative.
 *
 * @param shape The union-typed property's shape, possibly deferred to break definition cycles; its variants are
 * resolved as {@link @metreeca/blue/union!getShapeBranches | getShapeBranches} enumerates them
 * @param query The union-typed property's query: a keyed union, or a single alternative
 *
 * @returns Each retrieved variant mapped to its folded alternative, in the order alternatives first reach them;
 * empty when the query reaches no variant
 */
export function getUnionPlaceholders(shape: Lazy<Shape>, query: Query<Slot>): ReadonlyMap<Shape, Query<Slot>> {

	const alternatives = getUnionBranches(shape, query);
	const reached = [...new Set(alternatives.map(([variant]) => variant))];

	return new Map(reached.map(variant => [variant, alternatives
		.filter(([target]) => target === variant)
		.map(([, alternative]) => alternative)
		.reduce(mergeQueries)
	]));

}

/**
 * Folds two requests for the same node into one, retrieving to the depth the more demanding asks for.
 *
 * A structured request (a template or a locale) prevails over the atomic, and structured requests merge their keys,
 * recursively where both request the same key; where they state different criteria for the same nested collection,
 * `y`'s criterion prevails.
 *
 * @param x The earlier request
 * @param y The later request
 *
 * @returns The folded request
 */
export function mergeQueries(x: Query<Slot>, y: Query<Slot>): Query<Slot> {

	// ;(cast) folding two queries key by key yields a query: shared keys fold recursively, the others carry over

	return merge(x, y) as Query<Slot>;


	function merge(x: unknown, y: unknown): unknown {
		return isObject(x) && isObject(y)
			? { ...x, ...Object.fromEntries(Object.entries(y).map(([key, value]) => [key, merge(x[key], value)])) }
			: y ?? x;
	}

}


/**
 * Settles the {@link Drain} a query requests against a node's range.
 *
 * The form is read off the range and the query's retrieval keys: a multi-variant range reads the query as a
 * union (§5.5), each variant it reaches carrying its own drain settled against that variant alone; no key is the
 * atomic (§5.3); a collection takes a projection (§5.2); a localised range takes a locale map (§5.4) and a resource
 * or reference range a template. The query is validated against the form it takes: Keep validates models at its
 * boundary, so a query fitting no form the range admits is a contract violation.
 *
 * @param range The node's range
 * @param query The query requested at the node
 * @param alias The projection alias the query binds to the node, if any
 *
 * @returns The drain requested at the node
 *
 * @throws {@link !RangeError RangeError} If `query` takes no form `range` admits
 */
export function getDrain(range: Range, query: Query<Slot>, alias?: Identifier): Drain {

	const bound = alias === undefined ? {} : { alias };
	const variants = getShapeBranches(range.shape);
	const [variant] = variants;

	if ( variants.length > 1 && isQuery(query, isCell) ) {

		// a variant's drain is settled against the node's range restricted to that variant

		const placeholders = [...getUnionPlaceholders(range.shape, query)].map(([variant, placeholder]): readonly [Shape, Drain] =>
			[variant, getDrain({ ...range, shape: variant }, placeholder)]
		);

		return { ...bound, form: "union", query, variants: new Map(placeholders) };

	} else if ( isQuery(query, isAtomic) ) {

		return { ...bound, form: "atomic", query };

	} else if ( range.maxCount !== 1 && variant.kind !== "dictionary" && isQuery(query, isProjection) ) {

		return { ...bound, form: "projection", query };

	} else if ( variant.kind === "dictionary" && isQuery(query, isLocale) ) {

		return { ...bound, form: "locale", query };

	} else if ( (variant.kind === "resource" || variant.kind === "reference") && isQuery(query, isTemplate) ) {

		return { ...bound, form: "template", query };

	} else {

		throw new RangeError(`unsupported query form <${JSON.stringify(query)}>`);

	}

}


/**
 * Assembles a node's property-major {@link Entries} from its effective range and the requested model.
 *
 * Folds the `model` fragment against `range`, emitting one {@link Branch} per requested property some variant
 * declares. A multi-variant range reads the query as a union (§5.5): each alternative is matched against the
 * variants by form. A single-variant range folds the whole model against that variant. Either way each reachable
 * variant resolves its target and folds every model entry against the target's declared properties: names the target
 * does not declare are dropped, `id` and `type` entries become terminal branches, and property entries carry their
 * requested query as their {@link Flake.drain | drain}. A name declared by several variants is one property (union
 * coherence, §3.2): the requests reaching it fold through {@link mergeQueries} into one branch, entered through the
 * first declaring variant's member and ranging over the disjunction of the per-variant declarations (§5.8.1). Only a
 * single-valued property expanded by a non-atomic request is descended for nested properties. An atomic request
 * (§5.3) or a multi-valued property, whose nested retrieval stays in its {@link @metreeca/qest/model!Query | query}
 * (§5.6), holds none. `path` accumulates the branch path to this node and is prefixed onto every emitted child
 * branch.
 *
 * @param range The effective {@link Range} of the node whose properties are assembled
 * @param path  The branch path accumulated to this node, prefixed onto every emitted child branch
 * @param model The requested model fragment driving per-property reach
 *
 * @returns The property-major {@link Entries} record for the node, or `undefined` when no record applies: a
 * non-object `model`, or a range no variant of which contributes a record (no variant resolves an owned target, or
 * a multi-variant range's alternatives match no variant)
 */
export function getEntries(range: Range, path: readonly Identifier[], model: Query<Slot>): Entries | undefined {

	// each reachable variant folds its model fragment against its target's declared properties: a multi-variant
	// range reads the query as a union (§5.5, each alternative matched to the variants it fits by form), a
	// single-variant range takes the whole model

	const variants = getShapeBranches(range.shape);

	const requests: readonly (readonly [Shape, Query<Slot>])[] = !isObject(model) ? []
		: variants.length > 1 ? getUnionBranches(range.shape, model)
			: variants.map((variant): readonly [Shape, Query<Slot>] => [variant, model]);

	// one record of declared requests per variant resolving a target, so a range no variant of which resolves one
	// holds no record at all

	const records = requests.flatMap(([variant, request]) => opt(getShapeTarget(variant), target => [

		// a resource target is descended by a template (§5.3): any other form names no property of it

		(isQuery(request, isTemplate) ? getQueryEntries(request) : []).flatMap(([name, query]) =>
			opt(target.members[name], (member): readonly (readonly [Identifier, Member, Query<Slot>])[] =>
				[[name, member, query]], []
			)
		)

	], []));

	// a name declared by several variants is one property (§3.2): its first declaring member enters it, and the
	// requests reaching it fold into one

	const declared = records.flat().reduce<Readonly<Record<Identifier, readonly [Member, Query<Slot>]>>>(
		(folded, [name, member, query]) => ({
			...folded,
			[name]: name in folded ? [folded[name][0], mergeQueries(folded[name][1], query)] : [member, query]
		}),
		{}
	);

	return records.length === 0 ? undefined : Object.fromEntries(Object.entries(declared).flatMap<[Identifier, Branch]>(([name, [member, query]]) => {

		const lower: readonly Identifier[] = [...path, name];

		if ( member.kind === "id" || member.kind === "type" ) {

			return [[name, {

				entry: member,

				path: lower,
				pipe: [],

				range: getPropertyRange(range, name)

			}]];

		} else if ( member.kind === "property" ) {

			const child = getPropertyRange(range, name);

			// the atomic leaf asks for the value as it stands (§5.3), so a reference under it comes back as the
			// identifier naming its target rather than expanded; only a fragment stating retrieval keys of its own
			// descends

			const entries = child.maxCount === 1 && !isQuery(query, isAtomic)
				? getEntries(child, lower, query)
				: undefined;

			return [[name, {

				...(entries ? { entries } : {}),

				entry: member,

				path: lower,
				pipe: [],

				range: child,
				drain: getDrain(child, query)

			}]];

		} else {

			return [];

		}

	}));

}

/**
 * Merges property-major {@link Entries} records reaching the same node into one.
 *
 * A name several records hold is one property, so its branches fold into one: the earlier branch's slots prevail
 * and their nested entries merge recursively. With no records there are no properties, so the result is `undefined`
 * and the caller omits the slot.
 *
 * @param entries The property-major records, in precedence order
 *
 * @returns The merged property-major {@link Entries} record (property names in first-seen order), or `undefined`
 * when `entries` is empty
 */
export function mergeEntries(entries: readonly Entries[]): undefined | Entries {

	return entries.length === 0 ? undefined
		: entries.flatMap(record => Object.entries(record)).reduce<Entries>(
			(merged, [name, branch]) => ({
				...merged,
				[name]: name in merged ? mergeBranches(merged[name], branch) : branch
			}),
			{}
		);


	function mergeBranches(earlier: Branch, later: Branch): Branch {

		const entries = mergeEntries([earlier.entries, later.entries].filter(record => record !== undefined));

		return { ...later, ...earlier, ...(entries ? { entries } : {}) };

	}

}


/**
 * Lists the retrieval entries a query states.
 *
 * Splits off the retrieval half a {@link @metreeca/qest/model!Query | query} states from the
 * {@link @metreeca/qest/model!Criteria | criteria} it carries alongside (§5.6): the criteria constrain the collection
 * the query retrieves and are held by the node retrieving it, so a walk descending into the entries leaves them
 * behind. Every retrieval form keys its entries by string and nests a query under each, so the entries serve
 * whatever form the query takes.
 *
 * @param query The query to read
 *
 * @returns The query's retrieval entries, in stated order, each pairing a key with the query it states
 */
export function getQueryEntries(query: Query<Slot>): readonly (readonly [string, Query<Slot>])[] {

	return Object.entries(query).filter(entry => isEntry(entry));

	function isEntry(value: unknown): value is readonly [string, Query<Slot>] {
		return isArray(value, [key => !isSelector(key), value => isQuery(value, isSlot)]);
	}

}
