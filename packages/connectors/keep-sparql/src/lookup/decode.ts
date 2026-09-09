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

import { type Property, type ResourceShape } from "@metreeca/blue/resource";
import { getShapeVariants, type UnionShape } from "@metreeca/blue/union";
import { eager, type ValueShape } from "@metreeca/blue/value";
import { type Identifier, isAny, isArray, isObject } from "@metreeca/core";
import { unique } from "@metreeca/core/arrays";
import { matchTag, type Tag } from "@metreeca/core/language";
import type { Scope } from "@metreeca/core/scope";
import { equals } from "@metreeca/core/structures";
import {
	type Branch,
	type Flake,
	getFlakeEntries,
	getFlakeVariant,
	isModelBranch,
	isQueryBranch
} from "@metreeca/keep-flake";
import type { Broker, Deferred, Lookup } from "@metreeca/keep/batching";
import type { Dictionary, Reference, Resource, Value, Values } from "@metreeca/qest/resource";
import { isTemplate, type Placeholders, type Query } from "@metreeca/qest/template";
import type { Term } from "@metreeca/trio";
import type { Tuple, Variable } from "@metreeca/wire-sparql";
import { column } from "../_/_decode.js";
import { getUnionPlaceholders } from "../_/_union.js";


/**
 * Decodes a SELECT result tuple set into a resource state.
 *
 * Reads back the arms the emitter produced, walking the same {@link Flake | lookup plan} and resolving
 * each property from its column in the returned `tuples` through the shared {@link Scope}. Each property
 * is read by the counterpart of the arm that emitted it:
 *
 *  - a **scalar** property reads its column and recurses into the nested subject as an embedded or
 *    expanded resource;
 *  - a **localised** property collects every tagged term across its arm's rows into a tag-keyed
 *    dictionary or the shorthand the model requests;
 *  - a **variant** property reads whichever requested variant's column bound ({@link getUnionPlaceholders},
 *    union.md §Model), fixing the variant by the bound column with no term classification: the read-side
 *    dual of the emitter's membership gate.
 *
 * Properties with no emitted column resolve inline: set-valued properties forward to the collections
 * pass through {@link select}, and `id` / `type` markers read from the focus and shape. Each item's
 * deferred settles with its decoded resource, or rejects with a `TypeError` on a malformed tuple set
 * that breaches the shape contract write-time validation upholds.
 *
 * @param scope The variable scope shared with the encoder
 * @param items The batched requests, each paired with its {@link Flake | lookup plan} and deferred
 * @param broker The cross-pass channel forwarding set-valued slots to the collections pass
 * @param tuples The solution rows returned by the batched SELECT query
 */
export function decode(
	scope: Scope<Variable>,
	items: readonly (Deferred<Lookup> & { readonly flake: Flake })[],
	broker: Broker,
	tuples: readonly Tuple[]
): void {

	items.forEach(({ request, flake, resolve, reject }) =>
		decodeResource(request.entry, flake, request.locale)
			.then(resolve)
			.catch(reject)
	);


	function decodeResource(entry: Reference, flake: Flake, locale: readonly Tag[]): Promise<Resource> {

		return Promise.all(flake.range.variants.flatMap(variant =>
			variant.kind !== "resource" ? [] : [decodeVariant(entry, variant, locale, getFlakeVariant(flake, variant))]
		)).then(resources => resources.reduce<Resource>(
			(merged, resource) => ({ ...merged, ...resource }),
			{}
		));

	}

	function decodeVariant(
		entry: Reference,
		shape: ResourceShape,
		locale: readonly Tag[],
		branches: readonly Branch[]
	): Promise<Resource> {

		type Slot = readonly [Identifier, undefined | Values];

		return Promise.all(branches.map((branch): Slot | Promise<Slot> => {

			// a value set resolving to no content is never surfaced as an empty array or map (§4):
			// the owning property is omitted from the decoded resource instead, except on a
			// constrained collection (a query tuple carrying a selection), whose value is the
			// filtered result set and legitimately empty

			return isQueryBranch(branch) ? broker
					.select({ entry, shape, field: branch.entry, query: branch.drain.mould, locale })
					.then(values => [branch.path[branch.path.length-1], isSelected(branch.drain.mould) || !isEmpty(values) ? values : undefined])

				: isModelBranch(branch) ? Promise
						.resolve(decodeProperty(locale, branch))
						.then(value => [branch.path[branch.path.length-1], value])

					: branch.entry.kind === "id" ? [branch.path[branch.path.length-1], entry]
						: [branch.path[branch.path.length-1], shape.class];

		})).then(slots => slots.reduce<Resource>(
			(resource, [key, value]) => value === undefined ? resource : { ...resource, [key]: value },
			{}
		));

	}

	/**
	 * Reads a single-valued model property, dispatching by range kind in the emitter's order: a **union** to
	 * {@link decodeUnion}, a **localised** `dictionary` leaf to {@link decodeDictionary}, any other **scalar**
	 * shape to {@link decodeValue}. The property is single-valued, so the first decoded value stands; an empty
	 * result omits the owning property (§4).
	 */
	function decodeProperty(
		locale: readonly Tag[],
		branch: Branch & { readonly entry: Property }
	): Values | Promise<Resource> | undefined {

		const rangeShape = branch.entry.range.shape;

		const model = branch.drain?.mould;

		if ( rangeShape.kind === "union" ) {

			return decodeUnion(rangeShape, locale, branch, model)[0];

		} else if ( rangeShape.kind === "dictionary" ) {

			// localised slots resolve as a single structured `Localised` value, not a collection:
			// the `Locales` placeholder's tag ranges select the languages and fix the per-tag cardinality

			return decodeDictionary(locale, model, unique(column(scope.resolve(branch), tuples), equals));

		} else {

			return decodeValue(rangeShape, locale, getFlakeEntries(branch), model, unique(column(scope.resolve(branch), tuples), equals))[0];

		}

	}

	/**
	 * Decodes the localised arm: the language-tagged terms matched against a localised placeholder.
	 *
	 * Structural access (a {@link @metreeca/qest/template!Locales | Locales} placeholder) yields the
	 * {@link Dictionary} map of the tags matching the requested ranges by RFC 4647 basic filtering (the wildcard `*`
	 * or an empty map admits every tag), with the per-tag cardinality fixed by the placeholder's value shape. Coalesced
	 * access (a plain string or singleton-array placeholder) reduces the map to the first locale-priority
	 * tag present (§6.2), at the matching per-tag cardinality. A typed literal carrying no language tag
	 * lands under the `und` tag. A result carrying no content resolves to `undefined`, so the owning
	 * property is omitted (§4).
	 */
	function decodeDictionary(
		locale: readonly Tag[],
		placeholder: Placeholders | undefined,
		terms: readonly Term[]
	): string | string[] | Dictionary | undefined {

		const pairs = terms.flatMap((t): readonly { readonly tag: string; readonly text: string }[] => {

			return t.kind === "blank" || t.kind === "named" ? []
				: t.kind === "tagged" ? [{ tag: t.language === "" ? "und" : t.language, text: t.text }]
					: [{ tag: "und", text: t.text }];

		});

		if ( isObject(placeholder) ) {

			const ranges = Object.keys(placeholder);

			const matching = ranges.length === 0 ? pairs : pairs.filter(({ tag }) =>
				ranges.some(range => matchTag(tag, range))
			);

			if ( matching.length === 0 ) {

				return undefined;

			} else if ( Object.values(placeholder).some(v => isArray(v)) ) {

				return matching.reduce<Record<string, readonly string[]>>(
					(values, { tag, text }) => ({ ...values, [tag]: [...(values[tag] ?? []), text] }),
					{}
				);

			} else {

				return matching.reduce<Record<string, string>>(
					(values, { tag, text }) => ({ ...values, [tag]: text }),
					{}
				);

			}

		} else {

			const winning = locale.find(tag => pairs.some(pair => pair.tag === tag));
			const texts = pairs.filter(pair => pair.tag === winning).map(pair => pair.text);

			return winning === undefined ? undefined
				: isArray(placeholder) ? texts
					: texts[0];

		}

	}

	/**
	 * Decodes the variant arms, the read-side dual of the emitter's membership gate: each requested variant
	 * owns its own arm and object column, so the value's variant is fixed by which column bound, with no
	 * term classification (union.md §Model). The property is single-valued, so the first requested variant
	 * whose column is bound stands; same-kind variants decode an identical bare payload. Resolves to no
	 * value when no variant column bound, omitting the owning property (§4).
	 */
	function decodeUnion(
		shape: UnionShape,
		locale: readonly Tag[],
		branch: Branch & { readonly entry: Property },
		placeholder: unknown
	): readonly (Value | Promise<Resource>)[] {

		const variants = getShapeVariants(shape);

		const requested = getUnionPlaceholders(variants, placeholder);

		const present = variants.find((variant): variant is ValueShape =>
			variant.kind !== "dictionary" && requested.has(variant) && unique(column(scope.resolve(variant), tuples), equals).length > 0
		);

		return present === undefined ? []
			: decodeValue(present, locale, getFlakeVariant(branch, present), requested.get(present), unique(column(scope.resolve(present), tuples), equals));
	}

	/**
	 * Coerces a bound column into values of `shape`, shared by the scalar and variant readers: literal
	 * shapes map each typed term to its JavaScript value; a `reference` yields bare {@link Reference}s, or
	 * expands them as nested resources when the placeholder is a template; a `resource` always expands.
	 */
	function decodeValue(
		shape: ValueShape,
		locale: readonly Tag[],
		branches: readonly Branch[],
		placeholder: unknown,
		terms: readonly Term[]
	): readonly (Value | Promise<Resource>)[] {

		switch ( shape.kind ) {

			case "boolean":

				return terms.filter(t => t.kind === "typed").map(t => t.text === "true");

			case "number":

				return terms.filter(t => t.kind === "typed").map(t => Number(t.text));

			case "string":

				return terms.filter(t => t.kind === "typed").map(t => t.text);

			case "reference":

				return isTemplate(placeholder)
					? entries().map(entry => decodeVariant(entry, eager(shape.shape), locale, branches))
					: entries();

			case "resource":

				return entries().map(entry => decodeVariant(entry, shape, locale, branches));

		}


		/**
		 * The IRIs bound by the column, the named terms of a reference- or resource-ranged property.
		 */
		function entries(): readonly Reference[] {
			return terms.filter(t => t.kind === "named").map(t => t.iri);
		}

	}


	/**
	 * Tests whether a resolved slot value carries no content (`undefined`, an empty array, or an empty
	 * map) and must therefore be omitted from the decoded resource (§4).
	 */
	function isEmpty(value: unknown): boolean {
		return value === undefined
			|| isArray(value, [])
			|| isObject(value, {});
	}

	/**
	 * Tests whether a collection query carries a non-vacuous selection: such a slot is a filtered query
	 * whose result set is returned even when empty, rather than an unconstrained value set subject to
	 * empty-value omission (§4).
	 */
	function isSelected(query: Query): boolean {
		return isArray(query, [isAny, selection =>
			isObject(selection) && Object.keys(selection).length > 0
		]);
	}

}
