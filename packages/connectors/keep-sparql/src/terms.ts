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
 * Value and term codecs.
 *
 * The conversions between the QEST values a store exchanges with its callers and the RDF terms a repository stores,
 * each driven by the shape variant the value is typed after: write values and constraint options to the terms to
 * store or match, solution terms back to the values they stand for. No SPARQL is composed here, so a connector for
 * another RDF-backed query language keeps this module as it is and rewrites the emitters composing the text alone.
 *
 * @module
 */

import { getShapeId } from "@metreeca/blue/resource";
import { getOptionBranch, getShapeBranches } from "@metreeca/blue/union";
import { type Range, sh, type Shape } from "@metreeca/blue/value";
import { error, isBoolean, isNumber, isObject, isString } from "@metreeca/core";
import { some } from "@metreeca/core/arrays";
import { isNumeric as isNumericDatatype, xsd } from "@metreeca/core/datatype";
import type { Tag } from "@metreeca/core/language";
import { Options } from "@metreeca/qest/model";
import { isReference, isVacuous, type Reference, type Value, type Values } from "@metreeca/qest/state";
import { named, tagged, type Term, typed } from "@metreeca/trio";


//// Encoders //////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Converts the options of a set-matching or focus constraint to individual match {@link Term | terms} (§5.7.3).
 *
 * A localised dictionary option expands to one language-tagged term per text, the `und` tag included. A scalar option
 * maps to a term typed after the {@link Range | range} variant it fits, and an option array maps element-wise. A
 * `null` option is kept as the absent-value option, which the emitted condition tests as an unbound value (§5.7.3).
 *
 * @param value The constraint options
 * @param range The range of the constrained value
 *
 * @returns The match terms, `null` standing for the absent value
 *
 * @throws {@link !RangeError RangeError} If a scalar option fits no variant of `range`
 */
export function optionsToTerms(value: Options, range: Range): readonly (null | Term)[] {

	if ( isObject(value) ) {

		return Object.entries(value).flatMap(([language, values]) =>
			some(values).map(text => tagged(text, language))
		);

	} else {

		const variants = getShapeBranches(range.shape);

		return some(value).map(option =>
			option === null ? null : valueToTerm(option, getOptionBranch(option, variants)
				?? error(new RangeError(`unresolved range variant for value <${String(option)}>`))
			)
		);

	}

}

/**
 * Converts a property's write values to the RDF {@link Term | terms} to store under a resolved
 * {@link Shape | shape} variant, the terms an insert states as the objects of the property's stored edges.
 *
 * A boolean, number, or string value becomes a literal typed after the variant; a string shape carrying the `sh:IRI`
 * datatype renders an IRI node instead, as in {@link valueToTerm}. A localised dictionary becomes one language-tagged
 * term per text (§4.3), the `und` tag included, so a string variant sharing the property never claims it on read
 * (§3.1); a plain string is never localised text and is dropped. A reference becomes its IRI. A nested resource becomes
 * its declared id if present (a captive resource with its own identity). An embedded resource becomes a fresh
 * `urn:uuid:` IRI instead, so the store never writes blank nodes and can read back every embedded resource it stores.
 *
 * Values not fitting the variant are dropped. A nested resource carrying no content is dropped too, so no link to an
 * empty subject is stored and an empty embedded resource reads back as an absent property, as the contract requires.
 *
 * @param values The write values, a single value or a value set
 * @param shape The range variant the values are typed after
 *
 * @returns The terms to store, possibly empty
 *
 * @throws {@link !RangeError RangeError} If `shape` is a union shape
 */
export function valuesToTerms(values: Values, shape: Shape): readonly Term[] {
	switch ( shape.kind ) {

		case "boolean":

			return some(values).filter(isBoolean).map(value => typed(value, xsd.boolean));

		case "number":

			return some(values).filter(isNumber).map(value => typed(value, shape.datatype ?? xsd.double));

		case "string":

			return some(values).filter(isString).map(value => shape.datatype === sh.IRI
				? named(value)
				: typed(value, shape.datatype)
			);

		case "dictionary":

			return some(values).flatMap(value => isObject(value)
				? Object.entries(value).flatMap(([tag, texts]) => some(texts).filter(isString).map(text => tagged(text, tag)))
				: []
			);

		case "reference":

			return some(values).filter(isReference).map(value => named(value));

		case "resource":

			const id = getShapeId(shape);

			return some(values).filter(v => isObject(v)).flatMap(value => {
				const node = id !== undefined ? value[id] : undefined;
				return isReference(node) ? [named(node)] : isVacuous(value) ? [] : [named()];
			});

		case "union": // a range variant is always a flattened branch, never a union

			throw new RangeError(`unsupported union variant`);

	}
}

/**
 * Converts a scalar operand to the RDF {@link Term} typed after its resolved {@link Shape | shape} (§5.7.1).
 *
 * A string shape carrying the `sh:IRI` datatype (an `id` or `type` entry, or a reference-ranged property) renders an
 * IRI node rather than a literal; an IRI-shaped literal (a `url`) is told apart by datatype alone.
 *
 * @param value The operand to convert
 * @param shape The range variant the operand resolves to
 *
 * @returns The typed operand term
 *
 * @throws {@link !RangeError RangeError} If `shape` is a resource or union shape, neither of which types a scalar
 */
export function valueToTerm(value: Value, shape: Shape): Term {
	switch ( shape.kind ) {

		case "boolean":

			return typed(String(value), xsd.boolean);

		case "number":

			return typed(String(value), shape.datatype ?? xsd.double);

		case "string":

			return shape.datatype === sh.IRI
				? named(String(value))
				: typed(String(value), shape.datatype);

		case "dictionary": // a localised dictionary shape is coalesced to a plain xsd:string (§6)

			return typed(String(value));

		case "reference":

			return named(String(value));

		case "resource": // a scalar operand never resolves to an expanded resource shape

			throw new RangeError(`unsupported embedded resource variant for value <${String(value)}>`);

		case "union": // a range variant is always a flattened branch, never a union

			throw new RangeError(`unsupported union variant for value <${String(value)}>`);

	}
}


//// Decoders //////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Converts a solution {@link Term} back to the QEST {@link Value} it stands for under a resolved
 * {@link Shape | shape} variant (§3.4), the read-side counterpart of {@link valueToTerm}.
 *
 * A boolean or number variant takes a literal of a matching datatype. A string variant carrying the `sh:IRI` datatype
 * takes an IRI, any other string variant a typed literal, as its lexical form. A localised variant takes its coalesced
 * label (§6.2), a language-tagged or plain literal, as a string. A reference variant takes an IRI.
 *
 * @param term The solution term to convert
 * @param shape The range variant the term was read under
 *
 * @returns The decoded value, or `undefined` if `term` does not fit `shape`
 *
 * @throws {@link !RangeError RangeError} If `shape` is a resource or union shape, neither of which types a scalar
 */
export function termToValue(term: Term, shape: Shape): undefined | Value {
	switch ( shape.kind ) {

		case "boolean":

			return term.kind === "typed" && term.datatype === xsd.boolean ? term.text === "true" : undefined;

		case "number":

			return term.kind === "typed" && isNumericDatatype(term.datatype) ? Number(term.text) : undefined;

		case "string":

			return shape.datatype === sh.IRI
				? term.kind === "named" ? term.iri : undefined
				: term.kind === "typed" ? term.text : undefined;

		case "dictionary":

			return term.kind === "tagged" || term.kind === "typed" ? term.text : undefined;

		case "reference":

			return term.kind === "named" ? term.iri : undefined;

		case "resource": // an embedded resource is expanded by its caller, never decoded from a single term

			throw new RangeError(`unsupported embedded resource variant`);

		case "union": // a range variant is always a flattened branch, never a union

			throw new RangeError(`unsupported union variant`);

	}
}

/**
 * Converts a solution {@link Term} bound where a resource is expected to the {@link Reference} naming it.
 *
 * The store reads only resources named by IRIs, embedded resources included, so a graph loaded by other means must
 * be skolemised first. A blank node is rejected rather than skipped: skipping it would silently drop the embedded
 * resource it names, together with all the content requested under that resource.
 *
 * @param value The solution term to convert
 *
 * @returns The IRI of a named node, or `undefined` for a literal, which names no resource
 *
 * @throws {@link !RangeError RangeError} If `value` is a blank node
 */
export function termToReference(value: Term): undefined | Reference {
	if ( value.kind === "blank" ) {

		throw new RangeError(`unsupported blank node <_:${value.label}>`);

	} else if ( value.kind === "named" ) {

		return value.iri;

	} else {

		return undefined;

	}
}

/**
 * Converts a computed solution {@link Term} back to the QEST {@link Value} it stands for (§3.4).
 *
 * A computed value carries no declared shape, so its datatype alone settles its type. An IRI keeps its reference
 * identity. A literal maps to its transport type: an `xsd:boolean` to a boolean, a numeric datatype to a number, and
 * any other datatype (the `xsd:string` of a plain literal included) to its lexical form. The mapping is many-to-one,
 * so processing-type distinctions are not preserved: a date and a plain string both come back as strings.
 *
 * @param value The solution term to convert, an IRI reference or a plain or typed literal
 *
 * @returns The decoded value: a reference, boolean, number, or string
 *
 * @throws {@link !RangeError RangeError} If `value` is a blank node or a language-tagged literal, neither of which
 * stands for a scalar value a computed cell can carry, as neither is told by a datatype the transform could yield
 */
export function computedToValue(value: Term): Value {
	if ( value.kind === "blank" ) {

		throw new RangeError(`unsupported blank node <_:${value.label}>`);

	} else if ( value.kind === "named" ) {

		return value.iri;

	} else if ( value.kind === "tagged" ) {

		throw new RangeError(`unsupported language-tagged literal <${value.text}@${value.language}>`);

	} else if ( value.datatype === xsd.boolean ) {

		return value.text === "true";

	} else if ( isNumericDatatype(value.datatype) ) {

		return Number(value.text);

	} else {

		return value.text;

	}
}

/**
 * Coalesces the language-tagged terms of a localised property to the texts under the tag a language priority picks
 * (§6.2), the read-side counterpart of the SPARQL coalescing in `patterns.ts`, applying the very same priority rule.
 *
 * The first tag of `locale` some term carries wins, and every text under it is returned; terms under any other tag,
 * and terms carrying no tag, are left out. A priority naming no tag the terms carry picks nothing.
 *
 * @param terms The solution terms of the property
 * @param locale The language priority, most preferred first
 *
 * @returns The texts under the winning tag, in term order; empty when no priority tag is carried
 */
export function coalesce(terms: readonly Term[], locale: readonly Tag[]): readonly string[] {

	const tagged = terms.flatMap(term => term.kind === "tagged" ? [term] : []);

	const winning = locale.find(tag => tagged.some(term => term.language === tag));

	return tagged.filter(term => term.language === winning).map(term => term.text);

}
