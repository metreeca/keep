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
 * Query-mode walk for {@link createFlake}.
 *
 * Two passes decode a collection {@link Query} into the flake. A query's keys (operator-prefixed
 * `>price`, projection `alias=expr`, piped expressions) each encode a full path and transform pipe
 * inline, so the flat key set does not match the flake's nesting:
 *
 *  1. **gather** flattens the query into a stream of {@link Entry} records, one per decoded probe,
 *     each carrying its path, pipe, and value;
 *  2. **build** regroups the stream into the tree: entries at the current depth fill the bearing
 *     {@link Flake}'s constraint, projection, and {@link Flake.transforms | transforms} slots; deeper
 *     entries group by their next path segment and recurse through {@link Branch} steps, a union-typed
 *     property fanning one branch per variant declaring the segment.
 *
 * Both passes are pure functional walks: every grouping is a `filter` / `flatMap` /
 * `Object.fromEntries` composition, with no mutable accumulator.
 *
 * @module
 */

import { getShapeProperties } from "@metreeca/blue/resource";
import { getShapeBranches, type UnionShape } from "@metreeca/blue/union";
import { type Range, type Shape } from "@metreeca/blue/value";
import { type Identifier, isIdentifier, isObject } from "@metreeca/core";
import { immutable } from "@metreeca/core/structures";
import {
	decodeProbe,
	isSelector,
	isUnion,
	type Probe,
	type Transform
} from "@metreeca/qest/model";
import {
	getEntries,
	getMouldEntries,
	getPropertyRange,
	getRootRange,
	getTransformRange,
	mergeEntries
} from "./index.core.js";
import { type Branch, type Entries, type Flake, type Mould, type Transforms } from "./index.js";


/**
 * Operator-symbol to {@link Flake} slot mapping. A probe `target` absent from this table is a
 * projection alias (`alias=expr` keys) rather than an operator.
 */
const Operators: Readonly<Record<string, keyof Flake>> = {

	"<": "lt",
	">": "gt",
	"<=": "lte",
	">=": "gte",

	"~": "like",

	"?": "any",
	"!": "all",

	"+": "focus",
	"^": "order",

	"@": "offset",
	"#": "limit"

};


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * A decoded query probe paired with its value, flattened by {@link queryEntriesOf} and regrouped by
 * {@link queryNodeOf}.
 *
 * Extends the qest {@link Probe} (its `path`, `pipe`, and the `target` naming an operator or a
 * projection alias) with the probed `value`.
 */
type Entry = Probe & {

	readonly value: unknown;

};


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Builds the query-mode {@link Flake} from a collection's member shape and a {@link Query}.
 *
 * Internal entry point: public callers go through the dispatcher in {@link createFlake}, which routes
 * the `(Shape, Query)` call shape here.
 *
 * @param shape The member shape: the value shape of the collection's elements
 * @param query The user query: the node retrieving the collection, its
 *              {@link @metreeca/qest/model!Criteria | criteria} merged in alongside its retrieval keys
 *
 * @returns The immutable {@link Flake} rooted at `shape`, carrying the whole query on its
 * {@link Flake.drain | drain} and with constraints, transforms, and projection marks populated as the
 * query directs
 */
export function createQueryFlake(shape: Shape, query: Mould): Flake {

	return immutable({

		drain: { mould: query },

		...queryNodeOf(getRootRange(shape), [], queryEntriesOf(shape, query))

	});

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Flattens the user query into an {@link Entry} stream.
 *
 * Retrieval keys and constraint keys share one key space (§5.6), so the node is split by key syntax in
 * {@link queryObjectEntriesOf}; the per-item element and the criteria narrowing the collection are no longer
 * told apart by position.
 */
function queryEntriesOf(shape: Shape, query: Mould): readonly Entry[] {

	return isObject(query) ? queryObjectEntriesOf(shape, query) : [];

}

/**
 * Walks one node of the query and emits {@link Entry | entries}.
 *
 * The node's form is settled once for the whole node, never key by key: criteria keys are carved out by
 * their own syntax (§5.6), and what remains is either the keyed alternatives a union-typed node is
 * addressed through (§5.5) or the bindings and paths naming the element, the two admitting no mixing. A
 * localised node contributes nothing, its tag keys naming no probe.
 *
 * Alternatives recurse through {@link queryVariantEntriesOf}; every other key is a probe (a criterion
 * operator, or an element binding or path) decoded through {@link queryProbeOf}, where a key that fails to
 * decode is a malformed query, a contract violation Keep rejects at its boundary.
 */
function queryObjectEntriesOf(shape: Shape, node: Record<string, unknown>): readonly Entry[] {

	const stated = Object.entries(node).filter(([, value]) => value !== undefined);

	const criteria = stated.filter(([key]) => isSelector(key));
	const retrieval = stated.filter(([key]) => !isSelector(key));

	const keyed = shape.kind === "union"
		&& retrieval.length > 0
		&& retrieval.every(([key]) => isVariantKey(key));

	return shape.kind === "dictionary" ? []
		: keyed ? [
				...criteria.map(queryProbeEntryOf),
				...retrieval.flatMap(([key, value]) => queryVariantEntriesOf(shape, key, value))
			]
			: stated.map(queryProbeEntryOf);

}

/**
 * Pairs a probe key with its value as an {@link Entry}.
 */
function queryProbeEntryOf([key, value]: readonly [string, unknown]): Entry {

	return { ...queryProbeOf(key), value };

}

/**
 * Checks whether a key labels a {@link @metreeca/qest/model!Union | union} alternative.
 *
 * Alternatives are keyed by opaque canonical non-negative integer strings (§5.5), which is what tells the
 * keyed union form apart from a template or projection naming the element. Model walks settle the same
 * question with qest's {@link @metreeca/qest/model!isUnion | isUnion}, which a query node escapes: its
 * alternatives carry the bindings and criteria no {@link @metreeca/qest/model!Placeholder | placeholder}
 * admits.
 */
function isVariantKey(key: string): boolean {

	return VariantKeys.test(key);

}

const VariantKeys = /^(0|[1-9]\d*)$/;

/**
 * Decodes a placeholder key into a {@link Probe}.
 *
 * A bare identifier path (`name`, `vendor.name`) is a self-projecting path descent whose leaf identifier
 * names the target: qest's {@link @metreeca/qest/model!decodeProbe | decodeProbe} rejects it since the
 * binding shorthand was removed (an explicit `alias=expression` is now required at the qest boundary), so
 * Keep reproduces the descent locally. Binding (`alias=expr`) and operator (`>price`) keys, which carry no
 * bare-identifier path, still route through `decodeProbe`.
 */
function queryProbeOf(key: string): Probe {

	const path = key.split(".");

	return path.every(isIdentifier)
		? { target: path[path.length-1], pipe: [], path }
		: decodeProbe(key);

}

/**
 * Recurses into a union-arm variant placeholder, flattening its keys against the variant shape so
 * locale maps and nested unions inside the variant are peeled correctly. The emitted entries route to
 * their variant by declared property at {@link queryDescentOf}, so they carry no variant tag.
 */
function queryVariantEntriesOf(shape: UnionShape, key: string, value: unknown): readonly Entry[] {

	const variant = getShapeBranches(shape).at(Number(key));

	return variant === undefined || !isObject(value) ? [] : queryObjectEntriesOf(variant, value);

}


/**
 * Folds an {@link Entry} stream into a {@link Flake} rooted at `path`.
 *
 * Entries at this depth fill the bearing locus inline; deeper entries recurse through
 * {@link queryDescentOf}, for a `range` that admits {@link Flake.entries | entries}
 * (a multi-variant range, or a resource or reference variant, resolved through its target). Scalars and
 * localised ranges carry none.
 */
function queryNodeOf(range: Range, path: readonly Identifier[], entries: readonly Entry[]): Flake {

	const local = entries.filter(e => e.path.length === path.length);
	const deeper = entries.filter(e => e.path.length > path.length);

	// a node admits properties when its range carries a resource or reference variant, or is a union (whose
	// scalar-only variants still yield an empty record, matching the shape-driven walk)

	const variants = getShapeBranches(range.shape);

	const descends = variants.length > 1
		|| variants.some(variant => variant.kind === "resource" || variant.kind === "reference");

	const base = queryLocusOf(range, path, [], [], local);

	// a binding's nested template folds into the terminal's properties, symmetric with model mode (a
	// projection binding's projected sub-structure is thus reachable through `entries`, not only
	// `projection[1]`); the terminal keeps its projection alias

	const queried = descends ? queryDescentOf(range, path, deeper) : undefined;
	const folded = descends && base.drain?.alias !== undefined
		? queryFoldOf(base.range, path, base.drain.mould)
		: undefined;

	const record = queried === undefined ? undefined
		: folded === undefined ? queried
			: mergeEntries([queried, folded]) ?? queried;

	return record === undefined ? base : { ...base, entries: record };

}

/**
 * Folds a projection binding's nested {@link Mould} into the terminal node's {@link Entries}.
 *
 * A binding whose expression crosses a union-typed step (§5.8.1) is union-typed, so it carries the keyed
 * {@link @metreeca/qest/model!Union | union} form (§5.6) even though the walk has fanned each variant to its
 * own single reference/resource variant. Decompose it against that narrowed `range`: fold every keyed alternative
 * on its own and merge, so the alternative matching this variant surfaces its branches while the others, naming
 * no property of this target, drop out (§5.4). A multi-variant `range` (a binding whose final step is itself
 * union-typed) and every non-union model pass straight through to {@link getEntries}, which pairs a keyed
 * union model only with a multi-variant range.
 */
function queryFoldOf(range: Range, path: readonly Identifier[], model: Mould): undefined | Entries {

	return getShapeBranches(range.shape).length > 1 || !isUnion(model)
		? getEntries(range, path, model)
		: mergeEntries(getMouldEntries(model).flatMap(([, alternative]) => {

			const entries = getEntries(range, path, alternative);

			return entries === undefined ? [] : [entries];

		}));

}

/**
 * Assembles a {@link Flake} at `path` from its depth-local entries.
 *
 * Identity-pipe entries fill the constraint and projection slots inline; piped entries fold into the
 * {@link Transforms} tree under the `recorded` breadcrumb.
 */
function queryLocusOf(
	range: Range,
	path: readonly Identifier[],
	pipe: readonly Transform[],
	recorded: readonly Transform[],
	entries: readonly Entry[]
): Flake {

	const identity = entries.filter(e => e.pipe.length === 0);
	const piped = entries.filter(e => e.pipe.length > 0);

	// `range` is this locus's own range — the node range, or a stage range already stepped by its transform;
	// nested stages step one transform further from it

	return {
		path,
		pipe,
		range,
		...queryConstraintsOf(identity),
		...queryProjectionOf(identity),
		transforms: queryTransformsOf(range, path, recorded, piped)
	};

}

/**
 * Collects the operator-constraint slots from a locus's entries.
 *
 * Each entry whose `target` names an {@link Operators | operator} contributes that slot and its value.
 */
function queryConstraintsOf(entries: readonly Entry[]): Partial<Flake> {
	return Object.fromEntries(
		entries.flatMap(e => {
			const slot = Operators[e.target];
			return slot === undefined ? [] : [[slot, e.value] as const];
		})
	);
}

/**
 * Extracts the projection from a locus's entries.
 *
 * The first entry whose `target` is an alias rather than an {@link Operators | operator} binds that
 * alias to its requested {@link Mould}; yields the empty object when none is present.
 */
function queryProjectionOf(entries: readonly Entry[]): {
	drain?: { readonly alias: Identifier; readonly mould: Mould }
} {

	const bound = entries.find(e => Operators[e.target] === undefined);

	// ;(cast) a binding entry's value is the requested projected fragment: Mould is the documented
	// binding-value shape at the Keep boundary.

	return bound === undefined ? {} : { drain: { alias: bound.target, mould: bound.value as Mould } };

}

/**
 * Builds the {@link Transforms} sub-tree from piped entries. Groups by the innermost (last) pipe
 * element, peels it off, and recurses; `recorded` is the breadcrumb captured on each stage's `pipe`
 * entry, growing innermost-first so it matches the right-to-left functional-composition order.
 */
function queryTransformsOf(
	range: Range,
	path: readonly Identifier[],
	recorded: readonly Transform[],
	entries: readonly Entry[]
): Transforms {

	return Object.fromEntries(
		queryUniq(entries.map(e => e.pipe[e.pipe.length-1]))
			.map(head => [head, queryStageOf(getTransformRange(range, head), path, [head, ...recorded], peelPipe(head, entries))] as const)
	);

}

/**
 * Builds one transform stage at `path` under the accumulated `pipe`, its `range` already stepped one
 * transform from the enclosing locus's range by {@link queryTransformsOf}. A stage is just a
 * {@link Flake}: its inline slots and nested {@link Transforms} are assembled by {@link queryLocusOf}.
 */
function queryStageOf(
	range: Range,
	path: readonly Identifier[],
	pipe: readonly Transform[],
	entries: readonly Entry[]
): Flake {

	return queryLocusOf(range, path, pipe, pipe, entries);

}

/**
 * Selects the entries whose innermost pipe element is `head` and strips it, exposing the next pipe
 * element for the recursive {@link queryTransformsOf} walk.
 */
function peelPipe(head: Transform, entries: readonly Entry[]): readonly Entry[] {
	return entries
		.filter(e => e.pipe[e.pipe.length-1] === head)
		.map(e => ({ ...e, pipe: e.pipe.slice(0, -1) }));
}


/**
 * Derives a node's property-major {@link Entries} from its `range`.
 *
 * Groups entries by their next path segment and recurses through {@link queryBranchOf}, one branch per
 * declared segment, dropping segments no variant declares. A segment declared across several variants of a
 * union range (a path crossing the union under a shared predicate, §5.8.1) is one binding, one cell (§5.6),
 * so it yields a single branch whose range is the disjunction its child step resolves, never a branch per
 * variant.
 */
function queryDescentOf(range: Range, path: readonly Identifier[], entries: readonly Entry[]): Entries {

	return Object.fromEntries(
		queryUniq(entries.map(e => e.path[path.length]))
			.flatMap(head => {
				const kept = entries.filter(e => e.path[path.length] === head);
				const branch = queryBranchOf(range, path, head, kept);
				return branch === undefined ? [] : [[head, [branch]] as const];
			})
	);

}

/**
 * Builds one {@link Branch} for the `head` step. Resolves the source entry from the first variant declaring
 * it (a crossing union shares the predicate across variants, so any declarer's entry carries it), steps the
 * child's effective range one property from the node `range` (an `id` / `type` marker resolving to the IRI
 * range), and recurses through {@link queryNodeOf}. Returns `undefined` when no variant declares the entry:
 * Keep validates models at the API boundary, so this only fires on contract violations.
 */
function queryBranchOf(
	range: Range,
	path: readonly Identifier[],
	head: Identifier,
	entries: readonly Entry[]
): undefined | Branch {

	const property = getShapeBranches(range.shape)
		.map(variant => getShapeProperties(variant)[head])
		.find(field => field !== undefined);

	if ( property === undefined ) {

		return undefined;

	} else {

		return { ...queryNodeOf(getPropertyRange(range, head), [...path, head], entries), entry: property };

	}

}


/**
 * Order-preserving deduplication. Used for grouping without a mutable accumulator.
 */
function queryUniq<T>(items: readonly T[]): readonly T[] {
	return items.filter((item, idx) => items.indexOf(item) === idx);
}
