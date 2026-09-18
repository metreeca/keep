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
 * Result typing for the store signatures.
 *
 * Resolves what a retrieval hands back from the model alone, so a consumer reads the same result types as before
 * and aligns on its own schedule rather than on this package's.
 *
 * > [!WARNING]
 * > Provisional, and weaker than what it replaces: a result is read off the model's key structure, while the leaf
 * > types once read alongside it are gone. Every leaf being the atomic `{}`, a leaf resolves to `{}` rather than
 * > to the `string`, `number` or `Reference` a typed placeholder once carried. Retrieval is unaffected: the shape
 * > settles what comes back, and only the static type is weaker.
 *
 * > [!IMPORTANT]
 * > Superseded by {@link @metreeca/blue/value!Delivery | Delivery}, which resolves the same result from the
 * > **shape** and the model together. Reaching it costs the store signatures a shape type parameter, a change to
 * > the published API that is deliberately not made here.
 *
 * @module
 */

import type { Binding, Criteria, Placeholder, Projection, Query, Union } from "@metreeca/qest/model";


/**
 * A retrieval fragment.
 *
 * Every form a retrieval entry takes, with the {@link Criteria} constraining it merged in. Retrieval keys and
 * constraint keys share one key space, so a request states what to retrieve and which items to retrieve it for in
 * one object.
 */
export type Mould = Query<
	| Placeholder
	| Union<Placeholder>
	| Projection
>;


/**
 * Resolves the value a retrieval hands back.
 *
 * Rewrites a template into the result shape it asks for:
 *
 * - **objects** — maps properties homomorphically, rewriting each key through {@link Name} and each value
 *   recursively, a keyed union frame collapsing to the union of its alternatives
 * - **primitives** — passes them through unchanged
 *
 * A collection hands back its members through {@link Items} instead: the node retrieving it states no
 * cardinality of its own, the tuple that once carried it having dissolved into the entry naming it.
 *
 * Propagates `undefined` and other union members through conditional-type distribution, preserving the
 * nullability of undefined-able fields without an explicit branch in the rewrite.
 *
 * @typeParam T The template value to rewrite, typically inferred from an inline template literal via `typeof`
 */
export type Instance<T> =
	T extends object                                                  // object
		? [Index<T>] extends [never]                                  //   numeric keys?
			? Slots<T>                                                //     no → map fields
			: Instance<T[Index<T>]>                                   //     yes → unwrap branch union
		: T;                                                          // primitive

/**
 * Resolves the values a collection retrieval hands back.
 *
 * States the arrayness the collection tuple once carried in the notation: with the tuple dissolved into the
 * entry retrieving the collection, a node no longer says how many values it addresses, and the cardinality
 * comes from the shape instead.
 *
 * @typeParam T The node retrieving the collection
 */
export type Items<T> = readonly Instance<T>[];

/**
 * Extracts the numeric-literal keys of a union frame, in both string (`"0"`) and numeric (`0`) form.
 *
 * Declaration emit serialises numeric keys as bare numerics (`{ 0; 1 }`) rather than string literals
 * (`{ "0"; "1" }`), so both forms must be matched for the collapse to survive a cross-package `.d.ts`
 * round-trip. Wide `number` / `string` index signatures are excluded so they keep mapping through
 * {@link Slots}.
 *
 * @typeParam T The object type whose numeric-literal keys to extract
 */
export type Index<T> =
	keyof T extends infer K                                           // distribute over each key
		? K extends `${number}` ? K                                   // string form (`"0"`)
			: K extends number ? (number extends K ? never : K)       // numeric form (`0`), excluding wide `number`
				: never
		: never;

/**
 * Projects a template-shaped object through `Instance`.
 *
 * Rewrites each property homomorphically: maps the key through {@link Name} and the value recursively through
 * `Instance`.
 *
 * @typeParam T The template-shaped object type to rewrite
 */
export type Slots<T> = {

	readonly [K in keyof T as Name<K>]: Instance<T[K]>

};

/**
 * Projects an `Instance` property key to its output name.
 *
 * - **drops** {@link Criteria} constraint and pagination keys, collapsing them to `never`
 * - **extracts** the identifier portion from computed {@link Binding} keys (`name=expression`)
 * - **passes** plain identifier keys through unchanged
 *
 * @typeParam K The input property key to rewrite
 */
export type Name<K> =
	K extends keyof Criteria ? never
		: K extends Binding ? K extends `${infer I}=${string}` ? I : K
			: K;
