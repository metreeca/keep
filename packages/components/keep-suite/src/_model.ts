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
 * Retrieval template derivation.
 *
 * Derives a retrieval template addressing every slot a shape declares, so a conformance case states the shape it
 * exercises rather than transcribing the template it expects.
 *
 * > [!IMPORTANT]
 * > Provisional: it stands in for the shape-to-template inference blue no longer provides, and is due to go once
 * > every case authors its own literal template.
 *
 * @module
 */

import type { DictionaryShape } from "@metreeca/blue/dictionary";
import type { Id, Parents, Property, ResourceShape, Type } from "@metreeca/blue/resource";
import { getShapeBranches, type UnionShape } from "@metreeca/blue/union";
import { eager, type Range, type Shape } from "@metreeca/blue/value";
import type { Eager, Lazy, Optional } from "@metreeca/core";
import type { TagRange } from "@metreeca/core/language";
import type { Atomic } from "@metreeca/qest/model";


/**
 * Derives the retrieval template addressing every slot a shape declares.
 *
 * Every leaf is the atomic placeholder `{}`, whatever it addresses: a literal, a reference, and the `id` / `type`
 * markers alike. A localised slot is a per-tag map over the tags it admits (every tag, where it admits any), each tag
 * itself atomic; a nested resource is its own template; a union is the index-keyed map holding one alternative per
 * branch. Cardinality is not stated: a single- and a multi-valued slot are addressed identically, the shape settling
 * how many values come back.
 *
 * @typeParam S The shape whose template to derive
 *
 * @param shape The shape to address, or a factory deferring it
 *
 * @returns The retrieval template addressing every slot `shape` declares
 *
 * @throws {TraceError} If `shape` transitively references itself, producing a circular extends chain
 */
export function model<S extends Lazy<Shape>>(shape: S): Schema<S> {

	// ;(cast) the structural derivation is opaque to the compiler, which recovers the template type from the shape

	return value(eager(shape)) as Schema<S>;

}


/**
 * The retrieval template type a shape is addressed by.
 *
 * Mirrors the runtime derivation of {@link model}: a resource is a record of the members it declares merged over the
 * ones it inherits, relaxed to an optional key where a slot admits absence; a union is the index-keyed map over its
 * branches; a localised leaf is a map keyed by the tags it admits; any other leaf is the atomic placeholder.
 *
 * @typeParam S The shape whose template type to resolve
 */
export type Schema<S extends Lazy<Shape>> =
	Shape extends Eager<S> ? never
		: Eager<S> extends infer E extends Shape
			? E extends ResourceShape ? Prototype<Carried<E>>
				: E extends UnionShape<infer B> ? { readonly [I in keyof B & `${number}`]: Schema<B[I]> }
					: E extends DictionaryShape ? { readonly [tag in Tags<E>]: Atomic }
						: Atomic
			: never;


/**
 * The members a resource shape carries: the ones it declares merged over the ones it inherits.
 */
type Carried<E> =
	E extends ResourceShape<infer P, infer M> ? Omit<Inherited<P>, keyof M> & M : {};

/**
 * The members inherited from a list of parent shapes, earlier parents taking precedence.
 */
type Inherited<P extends Parents> =
	P extends readonly [infer H extends Lazy<ResourceShape>, ...infer T extends Parents]
		? Omit<Inherited<T>, keyof Carried<Eager<H>>> & Carried<Eager<H>>
		: {};

/**
 * The template record over a set of members.
 *
 * Every member is stated, whether or not its slot admits absence: a derived template asks for everything the shape
 * declares, and a key left out of a template asks for nothing at all. Optionality belongs to the delivered value,
 * which the shape settles, not to the request.
 */
type Prototype<M> = {
	readonly [K in keyof M]: Slot<M[K]>
};

/**
 * The template slot of a member: the atomic placeholder for a marker, the template of its range for a property.
 */
type Slot<M> =
	M extends Id | Type ? Atomic
		: M extends Property<infer R> ? Bounds<R>
			: never;

/**
 * The template of a range: the range's own template, or a per-tag map for a localised one.
 *
 * Neither cardinality nor optionality is stated, the shape settling how many values come back and whether the slot
 * may be absent; the template states what to retrieve alone.
 */
type Bounds<R extends Lazy<Shape>> =
	Eager<R> extends infer D extends DictionaryShape
		? { readonly [tag in Tags<D>]: Atomic }
		: Schema<R>;

/**
 * The tags a localised shape addresses: the ones it admits, or any where it admits every tag.
 */
type Tags<D extends DictionaryShape> =
	D extends { readonly languageIn: readonly (infer T extends TagRange)[] } ? T : TagRange;


//// Derivation ////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * The template addressing one value shape, dispatched by kind.
 */
function value(shape: Shape): unknown {
	switch ( shape.kind ) {

		case "boolean":
		case "number":
		case "string":
		case "reference":

			return {};

		case "dictionary":

			return Object.fromEntries((shape.languageIn ?? ["*"]).map(tag => [tag, {}]));

		case "resource":

			return Object.fromEntries(Object.entries(shape.members).map(([name, member]) =>
				[name, member.kind === "id" || member.kind === "type" ? {} : values(member.range)]
			));

		case "union":

			return Object.fromEntries(getShapeBranches(shape).map((branch, index) =>
				[`${index}`, value(branch)]
			));

	}
}

/**
 * The template addressing one value set.
 *
 * Cardinality is not stated by a placeholder: a single- and a multi-valued set are addressed identically, so the set
 * resolves to its shape's own template whatever its bounds.
 */
function values({ shape }: Range): unknown {

	const resolved = eager(shape);

	return resolved.kind === "dictionary"

		// localised: the tag ranges select the content and the shape fixes the per-tag arity, so each tag is atomic

		? Object.fromEntries((resolved.languageIn ?? ["*"]).map(tag => [tag, {}]))

		: value(resolved);

}
