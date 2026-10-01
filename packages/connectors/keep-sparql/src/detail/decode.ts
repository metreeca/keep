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
 * Detail-pass result decoder.
 *
 * Assembles each queued {@link Detail} resource from the batched query's solution tuples, delegating multi-valued
 * properties to the select pass.
 *
 * @module
 */

import { type Property, type ResourceShape } from "@metreeca/blue/resource";
import { getShapeBranches } from "@metreeca/blue/union";
import { eager, type Shape } from "@metreeca/blue/value";
import { type Identifier, isArray, isObject, opt } from "@metreeca/core";
import { unique } from "@metreeca/core/arrays";
import { isTagRange, matchTag, type Tag } from "@metreeca/core/language";
import type { Scope } from "@metreeca/core/scope";
import { equals } from "@metreeca/core/values";
import {
	type Branch,
	type Drain,
	type Flake,
	getFlakeEntries,
	getFlakeVariant,
	isModelBranch,
	isQueryBranch
} from "@metreeca/keep-flake";
import type { Broker, Deferred, Detail, Response } from "@metreeca/keep/batching";
import {
	type Dictionary,
	type Reference,
	type Resource,
	type Value,
	type Values
} from "@metreeca/qest/state";
import type { Term } from "@metreeca/trio";
import type { Tuple, Variable } from "@metreeca/wire-sparql";

import { termToValue } from "../index.core.js";


/**
 * Settles each batched detail request with the resource decoded from the `select` solution.
 *
 * Each property is read from its column through the {@link Scope} shared with the encoder, following the same
 * {@link Flake | detail plan}. Each property is read by the counterpart of the arm that produced it:
 *
 *  - a **scalar** property reads its column and recurses into a nested embedded or expanded resource;
 *  - a **localised** property collects the tagged terms across its arm's rows into a tag-keyed dictionary or the
 *    coalesced label the model requests;
 *  - a **union** property reads the column of the requested variant that bound, so the variant needs no term
 *    inspection.
 *
 * Properties with no column resolve without the tuples: multi-valued properties are forwarded to the select pass
 * through {@link Broker.select}, while `id` and `type` come from the entry and the shape. Each request resolves to
 * its decoded resource, or rejects with the error raised while decoding it.
 *
 * @param scope The variable scope shared with the encoder
 * @param items The batched requests, each paired with its {@link Flake | detail plan} and deferred
 * @param broker The channel forwarding multi-valued properties to the select pass
 * @param tuples The solution rows returned by the batched `select` query
 */
export function decode(
	scope: Scope<Variable>,
	items: readonly (Deferred<Detail> & { readonly flake: Flake })[],
	broker: Broker,
	tuples: readonly Tuple[]
): void {

	// ;(cast) the decoded resource is the instance the request asked for: the walk is driven by the very flake
	// the model built, so its slots are the model's keys. The static inference no longer says so, reading leaf
	// types off a notation that no longer carries them (see `@metreeca/blue/value`).

	items.forEach(({ request, flake, resolve, reject }) =>
		decodeResource(request.entry, flake, request.locale)
			.then(resource => resolve(resource as Response<Detail>))
			.catch(reject)
	);


	function decodeResource(entry: Reference, flake: Flake, locale: readonly Tag[]): Promise<Resource> {

		return Promise.all(getShapeBranches(flake.range.shape).flatMap(variant =>
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
			// the owning property is omitted from the decoded resource instead, constrained
			// collections included

			return isQueryBranch(branch) ? broker
					.select({ entry, shape, field: branch.entry, query: branch.drain.query, locale })
					.then((values): Slot => [
						branch.path[branch.path.length-1],
						isEmpty(values) ? undefined : values
					])

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

	function decodeProperty(
		locale: readonly Tag[],
		branch: Branch & { readonly entry: Property }
	): Values | Promise<Resource> | undefined {

		const rangeShape = eager(branch.entry.range.shape);

		const drain = branch.drain;

		if ( rangeShape.kind === "union" ) {

			return decodeUnion(locale, branch, drain);

		} else if ( rangeShape.kind === "dictionary" ) {

			// localised slots resolve as a single structured `Dictionary` value, not a collection:
			// the `Locale` placeholder's tag ranges select the languages, the property the per-tag cardinality

			return decodeDictionary(
				locale, drain,
				unique(decodeColumn(scope.resolve(branch), tuples), equals),
				rangeShape.uniqueLang === true
			);

		} else {

			return decodeValue(
				rangeShape,
				locale,
				getFlakeEntries(branch),
				drain,
				unique(decodeColumn(scope.resolve(branch), tuples), equals)
			)[0];

		}

	}

	function decodeUnion(
		locale: readonly Tag[],
		branch: Branch & { readonly entry: Property },
		drain: undefined | Drain
	): Values | Promise<Resource> | undefined {

		const requested = drain?.form === "union" ? drain.variants : new Map<Shape, Drain>();

		const present = [...requested.keys()].find(variant =>
			unique(decodeColumn(scope.resolve(branch, variant), tuples), equals).length > 0
		);

		return present === undefined ? undefined
			: present.kind === "dictionary" ? decodeDictionary(
					locale, requested.get(present),
					unique(decodeColumn(scope.resolve(branch, present), tuples), equals),
					present.uniqueLang === true
				)
				: decodeValue(
					present,
					locale,
					getFlakeVariant(branch, present), requested.get(present),
					unique(decodeColumn(scope.resolve(branch, present), tuples), equals)
				)[0];
	}

	function decodeDictionary(
		locale: readonly Tag[],
		drain: undefined | Drain,
		terms: readonly Term[],
		uniqueLang: boolean
	): string | readonly string[] | Dictionary | undefined {

		const pairs = terms.flatMap((t): readonly { readonly tag: string; readonly text: string }[] =>
			t.kind === "tagged" ? [{ tag: t.language, text: t.text }] : []
		);

		// §5.4: a tag-range map asks for the property structurally, the atomic leaf `{}` for its coalesced
		// label; the two are told apart by the drain form, `{}` no longer standing for "every tag"

		const ranges = drain?.form === "locale" ? Object.keys(drain.query).filter(isTagRange) : [];

		if ( ranges.length > 0 ) {

			const matching = pairs.filter(({ tag }) => ranges.some(range => matchTag(tag, range)));

			// §5.4: the retrieved entries carry the per-tag cardinality the property declares, which the
			// template does not restate

			return matching.length === 0 ? undefined
				: uniqueLang ? matching.reduce<Record<string, string>>(
						(values, { tag, text }) => ({ ...values, [tag]: text }),
						{}
					)
					: matching.reduce<Record<string, readonly string[]>>(
						(values, { tag, text }) => ({ ...values, [tag]: [...(values[tag] ?? []), text] }),
						{}
					);

		} else {

			const winning = locale.find(tag => pairs.some(pair => pair.tag === tag));
			const texts = pairs.filter(pair => pair.tag === winning).map(pair => pair.text);

			return winning === undefined ? undefined
				: uniqueLang ? texts[0]
					: texts;

		}

	}

	function decodeValue(
		shape: Shape,
		locale: readonly Tag[],
		branches: readonly Branch[],
		drain: undefined | Drain,
		terms: readonly Term[]
	): readonly (Value | Promise<Resource>)[] {

		switch ( shape.kind ) {

			case "boolean":
			case "number":
			case "string":

				return terms.flatMap(term => opt(termToValue(term, shape), value => [value], []));

			case "reference":

				// the atomic keeps the bare references

				return drain?.form === "template"
					? entries().map(entry => decodeVariant(entry, eager(shape.target), locale, branches))
					: entries();

			case "resource":

				return entries().map(entry => decodeVariant(entry, shape, locale, branches));

			case "dictionary": // a localised variant is decoded from its tagged columns, never from a bound column

				throw new RangeError(`unsupported dictionary variant`);

			case "union": // a range variant is always a flattened branch, never a union

				throw new RangeError(`unsupported union variant`);

		}


		function entries(): readonly Reference[] {
			return terms.filter(t => t.kind === "named").map(t => t.iri);
		}

	}


	function decodeColumn(variable: Variable, tuples: readonly Tuple[]): readonly Term[] {
		return tuples.flatMap(tuple => tuple[variable] ?? []);
	}

	function isEmpty(value: unknown): boolean {
		return value === undefined
			|| isArray(value, [])
			|| isObject(value, {});
	}

}
