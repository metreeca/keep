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
 * Shape-mode walk for {@link createFlake}.
 *
 * Walks every entry of `shape.entries` (id, type, property) and recurses through embedded resources
 * and captive references. Plain and foreign references stay as leaves: crossing them would reach into
 * their own independent identity.
 *
 * Produces an immutable {@link Flake} carrying only the structural reach, with no {@link Flake.drain | drain},
 * constraints, or {@link Flake.transforms | transforms}. Cyclic captive shapes (a captive reference whose target
 * loops back) are unsupported: the walk performs no cycle detection.
 *
 * @module
 */

import { getShapeTarget } from "@metreeca/blue/reference";
import { type RangeShape, type Shape } from "@metreeca/blue/value";
import type { Identifier } from "@metreeca/core";
import { immutable } from "@metreeca/core/structures";
import { getPropertyRange, getRootRange, mergeEntries } from "./index.core.js";
import { type Entries, type Flake } from "./index.js";


/**
 * Builds the shape-mode {@link Flake} from a root shape.
 *
 * Internal entry point: public callers go through the dispatcher in {@link createFlake}, which routes
 * the no-input call shape here.
 *
 * A non-resource root yields a degenerate leaf flake with no property branches.
 *
 * @param shape The shape rooting the walk
 *
 * @returns The immutable {@link Flake} rooted at `shape`, with structural
 * reach in {@link Flake.entries | entries}
 */
export function createShapeFlake(shape: Shape): Flake {

	const range = getRootRange(shape);

	return immutable(shape.kind === "resource"
		? { path: [], pipe: [], range, entries: shapeEntriesOf([], range) ?? {} }
		: { path: [], pipe: [], range }
	);

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Builds the property-major {@link Entries} of a node from its effective {@link RangeShape}.
 *
 * Each owned variant of the range — an embedded resource or a captive reference — contributes its target's
 * declared properties, merged across variants; plain and foreign references keep their independent identity
 * and contribute none. Every declared entry becomes a single-element `[Branch]` carrying its range (stepped
 * one property from the node range) and recursing into that child's own owned structure. Cyclic captive
 * shapes are unsupported: the walk performs no cycle detection.
 */
function shapeEntriesOf(path: readonly Identifier[], range: RangeShape): undefined | Entries {

	return mergeEntries(range.variants.flatMap(variant => {

		// shape-mode reaches a variant's structure only through ownership: an embedded resource or a
		// captive reference; plain and foreign references stay leaves

		const owned = variant.kind === "resource"
			|| (variant.kind === "reference" && variant.captive === true);

		const target = owned ? getShapeTarget(variant) : undefined;

		return target === undefined ? [] : [Object.fromEntries(Object.entries(target.entries).map(([key, entry]) => {

			const branchPath: readonly Identifier[] = [...path, key];
			const child = getPropertyRange(range, key);
			const entries = shapeEntriesOf(branchPath, child);

			return [key, [{
				entry,
				path: branchPath,
				pipe: [],
				range: child,
				...(entries ? { entries } : {})
			}]];

		}))];

	}));

}
