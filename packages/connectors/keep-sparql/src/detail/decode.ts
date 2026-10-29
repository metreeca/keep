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
 * Assembles one queued {@link Detail} resource from its own solution rows, reading each multi-valued property off
 * the collection the select pass materialises for it, so the resource depends on one select request per such property.
 *
 * @module
 */

import { type ResourceShape } from "@metreeca/blue/resource";
import { getShapeBranches } from "@metreeca/blue/union";
import { eager, type Shape } from "@metreeca/blue/value";
import { type Identifier, isArray, isObject, opt } from "@metreeca/core";
import { unique } from "@metreeca/core/arrays";
import { isTagRange, matchTag } from "@metreeca/core/language";
import type { Scope } from "@metreeca/core/scope";
import { equals } from "@metreeca/core/values";
import { type Branch, type Drain, type Flake, getFlakeVariant, isModelBranch, isQueryBranch } from "@metreeca/keep-flake";
import type { Deferred, Detail } from "@metreeca/keep/batching";
import { type Dictionary, type Reference, type Resource, type Value, type Values } from "@metreeca/qest/state";
import type { Term } from "@metreeca/trio";
import type { Tuple, Variable } from "@metreeca/wire-sparql";
import { coalesce, termToReference, termToValue } from "../terms.js";
import { all, collection, type Decoded, map, plain } from "../spine.js";
import { column, entries, type Schema } from "./schema.js";


/**
 * Decodes one batched detail request from its own `select` solution rows.
 *
 * Properties are read off the {@link Schema | columns} the plan schema declares for them, resolved through the
 * {@link Scope} shared with the encoder. Each property reads the first of its columns that bound:
 *
 *  - a **value** column yields its literal or reference, recursing into a nested embedded or expanded resource;
 *  - a **tagged** column collects the tagged terms across its arm's rows into the tag-keyed dictionary or the
 *    coalesced label the model requests, under the request's language priority;
 *  - a **union** property has one column per requested variant, so the variant needs no term inspection.
 *
 * Properties with no column resolve without the tuples: `id` and `type` come from the entry and the shape, and
 * each multi-valued property is read off the collection the select request materialising it returns, so the
 * decoded resource depends on one select request per such property and the spine runs them; a collection
 * resolving to no content leaves the property out (§4). The decoder issues no request itself.
 *
 * The request must carry only the solution rows whose subject column binds its own entry. Entries sharing a plan
 * share its columns too, so passing the rows of the whole batch would mix the values of different entries.
 *
 * @param scope The variable scope shared with the encoder
 * @param flake The {@link Flake | detail plan} the batch shares
 * @param schema The table schema of the plan, the columns bound for each property it reads
 * @param item The request to decode
 * @param tuples The solution rows bound to the request's entry
 *
 * @returns The decoded resource, depending on the select requests its multi-valued properties read from
 */
export function decode(
	scope: Scope<Variable>,
	flake: Flake,
	schema: Schema,
	{ request: { entry, locale } }: Deferred<Detail>,
	tuples: readonly Tuple[]
): Decoded<Resource> {

	return decodeResource(entry, flake, tuples);


	function decodeResource(entry: Reference, flake: Flake, tuples: readonly Tuple[]): Decoded<Resource> {

		return merge(getShapeBranches(flake.range.shape).flatMap(variant =>
			variant.kind !== "resource" ? [] : [decodeVariant(entry, variant, getFlakeVariant(flake, variant), tuples)]
		));

	}

	function decodeVariant(
		entry: Reference,
		shape: ResourceShape,
		branches: readonly Branch[],
		tuples: readonly Tuple[]
	): Decoded<Resource> {

		return merge(branches.map(branch => {

			const name = branch.path[branch.path.length-1];

			// a value set resolving to no content is never surfaced as an empty array or map (§4): the owning
			// property is omitted from the decoded resource instead, constrained collections included

			return isQueryBranch(branch) ? collection(
					{ entry, shape, field: branch.entry, query: branch.drain.query, locale },
					values => isEmpty(values) ? {} : { [name]: values }
				)

				: isModelBranch(branch) ? slot(name, decodeProperty(branch, tuples))

					: branch.entry.kind === "id" ? plain({ [name]: entry })
						: plain(opt(shape.class, clazz => ({ [name]: clazz }), {}));

		}));

	}

	/**
	 * The value of a single-valued property: read off the first of its schema columns that bound, a localised
	 * column as the dictionary or coalesced label the request asks for, any other under the column's variant;
	 * a property none of whose columns bound in any row resolves to no value and is left out of the resource.
	 */
	function decodeProperty(branch: Branch, tuples: readonly Tuple[]): Decoded<undefined | Values> {

		const present = (schema.get(branch) ?? [])
			.map(candidate => ({ column: candidate, terms: unique(decodeColumn(column(scope, candidate), tuples), equals) }))
			.find(({ terms }) => terms.length > 0);

		return present === undefined ? plain(undefined)
			: present.column.form === "tagged" ? plain(decodeDictionary(
					present.column.drain, present.terms,
					present.column.variant.kind === "dictionary" && present.column.variant.uniqueLang === true
				))
				: first(decodeValue(
					present.column.variant,
					entries(present.column), present.column.drain,
					present.terms,
					tuples
				));

	}

	function decodeDictionary(
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

			const texts = coalesce(terms, locale);

			return texts.length === 0 ? undefined
				: uniqueLang ? texts[0]
					: texts;

		}

	}

	function decodeValue(
		shape: Shape,
		branches: readonly Branch[],
		drain: undefined | Drain,
		terms: readonly Term[],
		tuples: readonly Tuple[]
	): readonly Decoded<Value>[] {

		switch ( shape.kind ) {

			case "boolean":
			case "number":
			case "string":

				return terms.flatMap(term => opt(termToValue(term, shape), value => [plain(value)], []));

			case "reference":

				// the atomic keeps the bare references

				return drain?.form === "template"
					? references().map(entry => decodeVariant(entry, eager(shape.target), branches, tuples))
					: references().map(plain);

			case "resource":

				return references().map(entry => decodeVariant(entry, shape, branches, tuples));

			case "dictionary": // a localised variant is decoded from its tagged columns, never from a bound column

				throw new RangeError(`unsupported dictionary variant`);

			case "union": // a range variant is always a flattened branch, never a union

				throw new RangeError(`unsupported union variant`);

		}


		function references(): readonly Reference[] {
			return terms.flatMap(term => opt(termToReference(term), entry => [entry], []));
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


	/**
	 * The resource slot a decoded property fills, or none for a property resolving to no value.
	 */
	function slot(name: Identifier, property: Decoded<undefined | Values>): Decoded<Resource> {
		return map(property, value => value === undefined ? {} : { [name]: value });
	}

	/**
	 * The first of the decoded values of a single-valued property, with the requests it alone depends on; none where
	 * none of the property's columns bound a value in any row the request was handed.
	 */
	function first(values: readonly Decoded<Value>[]): Decoded<undefined | Values> {
		return values.length === 0 ? plain(undefined) : values[0];
	}

	/**
	 * Merges decoded resources into one, depending on every request they depend on.
	 */
	function merge(resources: readonly Decoded<Resource>[]): Decoded<Resource> {
		return map(all(resources), resources => resources.reduce<Resource>((merged, resource) =>
			({ ...merged, ...resource }), {}
		));
	}

}
