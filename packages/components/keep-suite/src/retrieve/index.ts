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
 * Shared helpers for retrieval conformance suites.
 *
 * @module retrieve/index
 */

import { type Identifier, isObject } from "@metreeca/core";
import type { Criteria } from "@metreeca/qest/model";
import type { Values } from "@metreeca/qest/state";


/**
 * Builds a `members` model for catalogue-style endpoints.
 *
 * Emits the `members` slot as the node retrieving the collection: the element retrieval template (a placeholder
 * object, for example `{ sku: {}, price: {} }`, or a `Projection` binding map) with the optional `Criteria`
 * narrowing the collection merged in alongside its own keys (§5.6).
 *
 * @param element - The literal element retrieval template
 * @param selection - The optional selection (filtering, ordering, slicing) applied to the collection
 */
export function catalogue<E>(element: E, selection?: Criteria): {

	readonly members: E

};

export function catalogue(element: unknown, selection?: Criteria): {

	readonly members: object

} {
	return { members: merge(element, selection) };
}


/**
 * Builds the collection model for a multi-valued property slot.
 *
 * Emits the slot value as the node retrieving the collection: the element retrieval template (the atomic leaf
 * `{}`, or a placeholder object, for example `{ sku: {}, price: {} }`) with the optional `Criteria` narrowing it
 * merged in alongside its own keys (§5.6), for properties whose values are retrieved as a set rather than as a
 * single value.
 *
 * @param element - The literal element retrieval template
 * @param selection - The optional selection (filtering, ordering, slicing) applied to the collection
 */
export function collection<E>(element: E, selection?: Criteria): E;

export function collection(element: unknown, selection?: Criteria): object {
	return merge(element, selection);
}


/**
 * Merges a collection's criteria into the node retrieving it.
 *
 * Retrieval keys and constraint keys share one key space (§5.6), so a query states both in one object.
 */
function merge(element: unknown, selection: undefined | Criteria): object {
	return { ...(isObject(element) ? element : {}), ...selection };
}


/**
 * Extracts the `members` array from a catalogue lookup result.
 */
export function members<R extends { readonly members?: unknown }>(result: R | undefined): R["members"] {

	return result?.members;

}


/**
 * Extracts the projected rows from a catalogue collection retrieved through a projection.
 *
 * A projection's cells are named by its binding keys, which state an expression rather than a member, so the shape
 * settles neither their names nor their types. Rows are therefore read as the cell-keyed records they are, each cell
 * carrying a state value.
 *
 * @param result - The catalogue collection to read, as returned by {@link members}
 *
 * @returns The projected rows, each keyed by the binding names the projection stated
 */
export function rows(result: undefined | readonly unknown[]): readonly Row[] {

	// ;(cast) a projection's rows are settled by its binding keys, which the shape-driven delivery does not resolve

	return (result ?? []) as readonly Row[];

}

/**
 * One projected row: the cells a projection's bindings name, each carrying a state value.
 */
export type Row = {

	readonly [cell: Identifier]: undefined | Values;

};


/**
 * Reads a projected cell as the number its binding computes.
 *
 * A binding states an expression rather than a member, so the shape settles neither the cell's name nor its type.
 * The row carries the cell as a bare state value, and a test asserting arithmetic over a numeric binding reads it
 * through this helper.
 *
 * @param cell - The cell to read
 *
 * @returns The number `cell` carries
 */
export function num(cell: undefined | Values): number {

	// ;(cast) the asserting case states the binding that computed the cell, so it knows the cell is numeric

	return cell as number;

}
