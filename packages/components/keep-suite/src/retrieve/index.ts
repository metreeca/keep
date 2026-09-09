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
 * Shared helpers for lookup conformance suites.
 *
 * @module retrieve/index
 */

import { model, type Schema, type Shape } from "@metreeca/blue/value";
import { isLazy, isObject, type Lazy } from "@metreeca/core";
import type { Selection } from "@metreeca/qest/template";


/**
 * Builds a `members?: [element, selection?]` model for catalogue-style endpoints.
 *
 * Emits the `members` slot directly as a {@link https://www.w3.org/TR/sparql11-query/ collection} query
 * tuple `[element, selection?]` — the element retrieval template paired with an optional `Selection`.
 *
 * @param members - The element shape, modelled via blue {@link model}
 * @param selection - The optional selection applied to the collection
 */
export function catalogue<S extends Lazy<Shape>>(members: S, selection?: Selection): {

	readonly members: readonly [Schema<S>, Selection?]

};

/**
 * Builds a `members?: [element, selection?]` model from a literal element retrieval template.
 *
 * The element is authored as a literal retrieval template (a placeholder object, e.g.
 * `{ sku: "", price: 0 }`, a bare scalar placeholder, or a `Projection` binding map) and rides straight
 * through to the tuple's first slot. A `Selection` may be attached in the tuple's second slot.
 *
 * @param element - The literal element retrieval template
 * @param selection - The optional selection (filtering, ordering, slicing) applied to the collection
 */
export function catalogue<E>(element: E, selection?: Selection): {

	readonly members: readonly [E, Selection?]

};

export function catalogue(element: unknown, selection?: Selection): {

	readonly members: readonly unknown[]

} {

	// !!! transitional shape path: a call site passing a shape element (first overload) has its retrieval template
	// derived here via blue model(); one passing an already-authored literal template (second overload) rides
	// straight through unchanged. once every call site authors literal templates, drop the shape overload, this
	// branch, and the model() call.

	const resolved = isLazy(element, isShape) ? model(element) : element;

	return { members: selection === undefined ? [resolved] : [resolved, selection] };


	function isShape(value: unknown): value is Shape {
		return isObject(value) && "kind" in value;
	}

}


/**
 * Builds a `[element, selection?]` collection model for a multi-valued property slot.
 *
 * Emits the slot value directly as a collection query tuple — the element retrieval template paired with an
 * optional `Selection` — for properties whose values are retrieved as a set rather than as a single value.
 *
 * @param element - The element shape, modelled via blue {@link model}
 * @param selection - The optional selection (filtering, ordering, slicing) applied to the collection
 */
export function collection<S extends Lazy<Shape>>(element: S, selection?: Selection): readonly [Schema<S>, Selection?];

/**
 * Builds a `[element, selection?]` collection model from a literal element retrieval template.
 *
 * The element is authored as a literal retrieval template (a bare scalar placeholder, e.g. `""`, or a
 * placeholder object, e.g. `{ sku: "", price: 0 }`) and rides straight through to the tuple's first slot.
 * A `Selection` may be attached in the tuple's second slot.
 *
 * @param element - The literal element retrieval template
 * @param selection - The optional selection (filtering, ordering, slicing) applied to the collection
 */
export function collection<E>(element: E, selection?: Selection): readonly [E, Selection?];

export function collection(element: unknown, selection?: Selection): readonly unknown[] {

	// !!! transitional shape path: mirrors catalogue() — a call site passing a shape element (first overload) has its
	// retrieval template derived here via blue model(); one passing an already-authored literal template (second
	// overload) rides straight through unchanged. this helper also stands in for the blue multiple(shape, selection)
	// selection argument, holding every attached-selection site under one symbol; once every call site authors literal
	// templates, drop the shape overload, this branch, and the model() call.

	const resolved = isLazy(element, isShape) ? model(element) : element;

	return selection === undefined ? [resolved] : [resolved, selection];


	function isShape(value: unknown): value is Shape {
		return isObject(value) && "kind" in value;
	}

}


/**
 * Extracts the `members` array from a catalogue-lookup result.
 */
export function members<R extends { readonly members?: unknown }>(result: R | undefined): R["members"] {

	return result?.members;

}
