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
 * Retrieval node classifiers for the encode and decode walks.
 *
 * Tells what a node asks for — the value as it stands, an expansion, or rows — by composing
 * `@metreeca/qest/model` guards over its retrieval half, so the walks read as they did against the previous
 * retrieval model and the criteria a node carries (§5.6) count toward neither reading.
 *
 * @module
 */

import { isObject } from "@metreeca/core";
import { isAtomic, isProjection, isQuery } from "@metreeca/qest/model";


/**
 * Checks whether a retrieval fragment projects a collection as rows.
 *
 * Pairs `isProjection`, which holds vacuously of a fragment stating no key at all, with the atomic leaf it
 * cannot exclude on its own: a collection asked for as it stands would otherwise read as a projection with no
 * bindings. A projection states at least one binding. Both readings go through `isQuery`, so the criteria a
 * node carries alongside its bindings (§5.6) count toward neither.
 *
 * @param value The fragment to test
 *
 * @returns true if `value` states at least one binding; false otherwise
 */
export function isProjected(value: unknown): boolean {
	return isQuery(value, isProjection) && !isQuery(value, isAtomic);
}

/**
 * Checks whether a retrieval fragment expands the resource it reaches.
 *
 * Reads the fragment against `isAtomic` through `isQuery`, so that the criteria it carries (§5.6) count for
 * nothing; the `isTemplate` test the previous notation relied on no longer tells the two apart, `{}` being both
 * a legal empty template and the atomic leaf. A fragment expands only where it states retrieval keys of its own;
 * the atomic leaf asks for the value as it stands (§5.3), a reference coming back as the identifier naming its
 * target.
 *
 * @param value The fragment to test
 *
 * @returns true if `value` states at least one retrieval key; false otherwise
 */
export function isExpanded(value: unknown): boolean {
	return isObject(value) && !isQuery(value, isAtomic);
}

