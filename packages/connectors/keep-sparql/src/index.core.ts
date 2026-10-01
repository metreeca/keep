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

import { getShapeClass, getShapeId, type Property } from "@metreeca/blue/resource";
import { getOptionBranch, getShapeBranches } from "@metreeca/blue/union";
import { type Range, sh, type Shape } from "@metreeca/blue/value";
import { error, isBoolean, isNumber, isObject, isString, opt } from "@metreeca/core";
import { some } from "@metreeca/core/arrays";
import { isNumeric as isNumericDatatype, xsd } from "@metreeca/core/datatype";
import { Options, type Transform } from "@metreeca/qest/model";
import { isReference, isVacuous, type Value, type Values } from "@metreeca/qest/state";
import { type Blank, named, type Named, rdf, tagged, type Term, typed } from "@metreeca/trio";
import type { SPARQL, Variable } from "@metreeca/wire-sparql";
import {
	abs,
	and,
	avg,
	ceil,
	count,
	datatype,
	day,
	eq,
	filter,
	floor,
	gt,
	hours,
	iif,
	isIRI,
	isLiteral,
	isNumeric,
	lang,
	lcase,
	max,
	min,
	minutes,
	month,
	ne,
	nil,
	not,
	number,
	pattern,
	reference,
	round,
	seconds,
	string,
	strlen,
	sum,
	ucase,
	variable,
	year
} from "@metreeca/wire-sparql/builder";


//// Shape-Aware SPARQL DSL ////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Generates the SPARQL triple pattern matching the stored edge from `source` to `target` through a
 * {@link Property | property}.
 *
 * Both declared directions store the value, so either one connects the pair. The forward direction is used if the
 * property declares one and `source` may stand in subject position; otherwise the reverse direction is used if
 * `target` may.
 *
 * @param edge The edge to match, as a `[source, property, target]` tuple
 *
 * @returns The generated triple pattern, or the empty fragment if neither direction applies
 *
 * @see {@link https://www.w3.org/TR/sparql11-query/#QSynTriples SPARQL 1.1 Triple Patterns}
 */
export function link([source, property, target]: readonly [Variable | Term, Property, Variable | Term]): SPARQL {

	const forward = property.forward;
	const reverse = property.reverse;

	return forward !== undefined && isAnchor(source) ? pattern([source, named(forward), target])
		: reverse !== undefined && isAnchor(target) ? pattern([target, named(reverse), source])
			: nil();

	function isAnchor(value: Variable | Term): value is Variable | Blank | Named {
		return isString(value) || value.kind === "blank" || value.kind === "named";
	}

}

/**
 * Generates the SPARQL triple pattern for a {@link Property | property}'s forward direction.
 *
 * The pattern reads `subject forward object`. The reverse-direction counterpart is {@link reverse}.
 *
 * @param edge The edge to render, as a `[subject, property, object]` tuple
 *
 * @returns The generated triple pattern, or the empty fragment if the property declares no `forward` predicate
 *
 * @see {@link https://www.w3.org/TR/sparql11-query/#QSynTriples SPARQL 1.1 Triple Patterns}
 */
export function forward([subject, property, object]: readonly [Variable | Blank | Named, Property, Variable | Term]): SPARQL {
	return opt(property.forward, forward => pattern([subject, named(forward), object]), nil());
}

/**
 * Generates the SPARQL triple pattern for a {@link Property | property}'s reverse direction.
 *
 * The edge is stated in forward order and the pattern swaps its ends, reading `subject reverse object`. The forward
 * object becomes the subject of the stored triple, so it is constrained to a variable, a blank node or an IRI. The
 * forward-direction counterpart is {@link forward}.
 *
 * @param edge The edge to render, in forward order, as an `[object, property, subject]` tuple
 *
 * @returns The generated triple pattern, or the empty fragment if the property declares no `reverse` predicate
 *
 * @see {@link https://www.w3.org/TR/sparql11-query/#QSynTriples SPARQL 1.1 Triple Patterns}
 */
export function reverse([object, property, subject]: readonly [Variable | Term, Property, Variable | Blank | Named]): SPARQL {
	return opt(property.reverse, reverse => pattern([subject, named(reverse), object]), nil());
}


/**
 * Generates the SPARQL clause admitting only the values belonging to a union variant.
 *
 * A classed resource or reference variant is gated by its stored `rdf:type` triple, and a classless one by an IRI
 * test. A boolean, number or string variant is gated by a `filter` on the literal kind. A localised `dictionary`
 * variant is gated by a language-tagged literal test, disjoint from the plain string test. Union variants are disjoint
 * by contract, so at most one variant admits a given value.
 *
 * @param anchor The variable holding the value
 * @param shape The variant to gate on
 *
 * @returns The gating triple pattern or `filter`
 *
 * @throws {@link !RangeError RangeError} If `shape` is a union shape
 */
export function membership(anchor: Variable, shape: Shape): SPARQL {

	const value = variable(anchor);

	switch ( shape.kind ) {

		case "boolean":

			return filter(and(
				isLiteral(value),
				eq(datatype(value), reference(xsd.boolean))
			));

		case "number":

			return filter(isNumeric(value));

		case "string":

			return filter(textual(value));

		case "dictionary":

			return filter(and(
				isLiteral(value),
				ne(lang(value), string(""))
			));

		case "reference":
		case "resource":

			return opt(getShapeClass(shape),
				clazz => pattern([anchor, named(rdf.type), named(clazz)]),
				() => filter(isIRI(value))
			);

		case "union": // a range variant is always a flattened branch, never a union

			throw new RangeError(`unsupported union variant`);

	}

}

/**
 * Generates the SPARQL test admitting a plain string value.
 *
 * A plain string is a literal carrying neither a language tag nor a boolean or numeric datatype. Stored strings,
 * temporal values the backend leaves opaque, and coalesced localised labels (§6.2) all pass the test.
 *
 * @param value The expression to test
 *
 * @returns The boolean expression holding when `value` is a plain string
 */
export function textual(value: SPARQL): SPARQL {
	return and(
		isLiteral(value),
		eq(lang(value), string("")),
		ne(datatype(value), reference(xsd.boolean)),
		not(isNumeric(value))
	);
}

/**
 * Generates the SPARQL expression applying a transform `pipe` to a value variable (§5.8.2).
 *
 * The trailing transform applies to `anchor` first and the leading transform is outermost. Each {@link Transform}
 * maps to its SPARQL aggregate or scalar function. An `avg` over no rows leaves its binding unbound rather than `0`,
 * as QEST requires (Appendix A.4.3).
 *
 * @param anchor The value variable the pipe transforms
 * @param pipe The transforms to compose, leading (outermost) first
 *
 * @returns The SPARQL expression applying `pipe` to `anchor`, or the bare `anchor` variable when `pipe`
 * is empty
 *
 * @see {@link https://www.w3.org/TR/sparql11-query/#aggregates SPARQL 1.1 Aggregates}
 */
export function expression(anchor: Variable, pipe: readonly Transform[]): SPARQL {

	return pipe.reduceRight((expression, transform) => apply(expression, transform), variable(anchor));

	function apply(expression: SPARQL, transform: Transform): SPARQL {

		switch ( transform ) {

			case "count":

				return count(expression);

			case "sum":

				return sum(expression);

			case "min":

				return min(expression);

			case "max":

				return max(expression);

			case "avg":

				// sparql averages an empty group to 0, where qest leaves the aggregate undefined (Appendix
				// A.4.3): forcing an ill-typed cast on an empty count errors the expression, so the
				// binding stays unbound and decodes as absent

				return iif(
					gt(count(expression), number(0)),
					avg(expression),
					`${reference(xsd.integer)}("!")`
				);

			case "length":

				return strlen(expression);

			case "lower":

				return lcase(expression);

			case "upper":

				return ucase(expression);

			case "abs":

				return abs(expression);

			case "floor":

				return floor(expression);

			case "ceil":

				return ceil(expression);

			case "round":

				return round(expression);

			case "year":

				return year(expression);

			case "month":

				return month(expression);

			case "day":

				return day(expression);

			case "hours":

				return hours(expression);

			case "minutes":

				return minutes(expression);

			case "seconds":

				return seconds(expression);

		}

	}

}


//// Encoders //////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Converts the options of a set-matching or focus constraint to individual match {@link Term | terms} (§5.7.3).
 *
 * A localised dictionary option expands to one language-tagged term per text, the `und` tag included. A scalar option
 * maps to a term typed after the {@link Range | range} variant it fits, and an option array maps element-wise. A
 * `null` option is kept as the absent-value option.
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
 * {@link Shape | shape} variant.
 *
 * A boolean, number, or string value becomes a literal typed after the variant; a string shape carrying the `sh:IRI`
 * datatype renders an IRI node instead, as in {@link valueToTerm}. A localised dictionary becomes one language-tagged
 * term per text (§6), the `und` tag included and a plain string shorthand standing for its `und` text, so a string
 * variant sharing the property never claims it on read (§3.1); a reference becomes its IRI. A nested resource becomes
 * its declared id if present (a captive resource with its own identity), else a fresh skolem IRI naming the embedded
 * resource.
 *
 * Values not fitting the variant are dropped. A nested resource carrying no content is dropped too, so no link to an
 * empty subject is stored.
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

			return some(values).flatMap(value => {

				if ( isString(value) ) {

					return [tagged(value, "und")];

				} else if ( isObject(value) ) {

					return Object.entries(value).flatMap(([tag, texts]) =>
						some(texts).filter(isString).map(text => tagged(text, tag))
					);

				} else {

					return [];

				}

			});

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
 * {@link Shape | shape} variant (§3.4), the read-side counterpart of `valueToTerm`.
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
 * Converts a computed solution {@link Term} back to the QEST {@link Value} it stands for (§3.4).
 *
 * A computed value carries no declared shape, so its datatype alone settles its type. An IRI keeps its reference
 * identity. A literal maps to its transport type: an `xsd:boolean` to a boolean, a numeric datatype to a number, and
 * any other datatype (the `xsd:string` of a plain literal included) to its lexical form. The mapping is many-to-one,
 * so processing-type distinctions are not preserved.
 *
 * @param value The solution term to convert, an IRI reference or a plain or typed literal
 *
 * @returns The decoded value: a reference, boolean, number, or string
 *
 * @throws {@link !RangeError RangeError} If `value` is a blank node or a language-tagged literal, neither of which
 * stands for a scalar value
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
