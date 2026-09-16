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
import { eager, type Instance, type Range, type Shape } from "@metreeca/blue/value";
import type { Eager, Lazy, Optional } from "@metreeca/core";
import type { TagRange } from "@metreeca/core/language";
import { app, getNamespaceIRI } from "@metreeca/core/resource";
import type { Reference } from "@metreeca/qest/resource";


/**
 * Derives the retrieval template addressing every slot a shape declares.
 *
 * Every leaf is addressed at its own kind: a literal by an empty placeholder of its type, a reference and the `id` /
 * `type` markers by the default base IRI, a localised slot by a per-tag map over the tags it admits (every tag, where
 * it admits any), a nested resource by its own template, and a union by the index-keyed map holding one alternative
 * per branch. A multi-valued slot holds its template in a singleton tuple; a localised one holds a string per tag
 * where it is unique-tagged and a singleton tuple per tag otherwise.
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
 * ones it inherits, each conditioned on its cardinality and relaxed to an optional key where it admits absence; a
 * union is the index-keyed map over its branches; a localised leaf is a map keyed by the tags it admits; any other
 * leaf is the value type it describes.
 *
 * @typeParam S The shape whose template type to resolve
 */
export type Schema<S extends Lazy<Shape>> =
	Shape extends Eager<S> ? never
		: Eager<S> extends infer E extends Shape
			? E extends ResourceShape ? Prototype<Carried<E>>
				: E extends UnionShape<infer B> ? { readonly [I in keyof B & `${number}`]: Schema<B[I]> }
					: E extends DictionaryShape ? { readonly [tag in Tags<E>]: string }
						: Instance<E>
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
 * The template record over a set of members, each key optional where its slot admits absence.
 */
type Prototype<M> = Joined<
	& { readonly [K in keyof M as undefined extends Slot<M[K]> ? never : K]: Slot<M[K]> }
	& { readonly [K in keyof M as undefined extends Slot<M[K]> ? K : never]?: Slot<M[K]> }
>;

/**
 * Collapses an intersection of records into a single record.
 */
type Joined<T> = {
	[K in keyof T]: T[K]
};

/**
 * The template slot of a member: the base IRI for a marker, the bounded template of its range for a property.
 */
type Slot<M> =
	M extends Id | Type ? Reference
		: M extends Property<infer R, infer L, infer U> ? Bounds<R, L, U>
			: never;

/**
 * The template of a range conditioned on its cardinality: bare where single-valued, boxed in a singleton tuple where
 * multi-valued, a localised range boxing per tag by its own arity; `undefined` joins in where the range admits
 * absence.
 */
type Bounds<R extends Lazy<Shape>, L extends Optional<number>, U extends Optional<number>> =
	| ([Extract<Optional<0>, L>] extends [never] ? never : undefined)
	| (Eager<R> extends infer D extends DictionaryShape
		? { readonly [tag in Tags<D>]: D extends { readonly uniqueLang: true } ? string : readonly [string] }
		: Boxed<Schema<R>, U>);

/**
 * Boxes a template in a singleton tuple where the cardinality admits several values.
 */
type Boxed<V, U extends Optional<number>> =
	[U] extends [1] ? V : readonly [V];

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

			return false;

		case "number":

			return 0;

		case "string":

			return "";

		case "dictionary":

			return Object.fromEntries((shape.languageIn ?? ["*"]).map(tag => [tag, ""]));

		case "reference":

			return getNamespaceIRI(app);

		case "resource":

			return Object.fromEntries(Object.entries(shape.members).map(([name, member]) =>
				[name, member.kind === "id" || member.kind === "type" ? getNamespaceIRI(app) : values(member.range)]
			));

		case "union":

			return Object.fromEntries(getShapeBranches(shape).map((branch, index) =>
				[`${index}`, value(branch)]
			));

	}
}

/**
 * The template addressing one value set, projected at the set's cardinality.
 */
function values({ shape, maxCount }: Range): unknown {

	const resolved = eager(shape);

	return resolved.kind === "dictionary"

		// localised: the arity applies per tag within the map, so wrap each tag's content

		? Object.fromEntries((resolved.languageIn ?? ["*"]).map(tag =>
			[tag, resolved.uniqueLang === true ? "" : [""]]
		))

		: maxCount === 1 ? value(resolved)
			: [value(resolved)];

}
