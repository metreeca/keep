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
import { getBoundBranch, getShapeBranches, getStateBranch } from "@metreeca/blue/union";
import { type Range, sh, type Shape } from "@metreeca/blue/value";
import { error, isBoolean, isNumber, isObject, isString, opt } from "@metreeca/core";
import { some } from "@metreeca/core/arrays";
import { xsd } from "@metreeca/core/datatype";
import { isReference, type Literal, type Reference, type Value, type Values } from "@metreeca/qest/resource";
import { Options, type Transform } from "@metreeca/qest/template";
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


/**
 * The RDF {@link Term} of a comparison bound (`<` / `>` / `<=` / `>=`), typed against the {@link Range |
 * range} variant it resolves to so the comparison resolves in the target's processing type (§5.7.1).
 * {@link getBoundBranch} routes the bound, relaxing the value-domain facets a bound need not satisfy. A
 * string variant carrying the `sh:IRI` datatype (an id / type entry, or a reference-ranged property) renders
 * an IRI node rather than a literal, told apart from an IRI-shaped literal (a `url`) by datatype alone.
 */
export function boundToTerm(value: Literal, range: Range): Term {

	const variants = getShapeBranches(range.shape);

	return valueToTerm(value,
		getBoundBranch(value, variants)
		?? (isString(value) ? variants.find(variant => variant.kind === "dictionary") : undefined)
		?? error(new RangeError(`unresolved range variant for value <${String(value)}>`))
	);

}

/**
 * Flattens the options of a set-matching or focus constraint to individual match {@link Term | terms}: a
 * localised dictionary set expands to one language-tagged term per language tag (its value, or every element of
 * its value array), a scalar option maps to its term typed by the {@link Range | range} variant it
 * fits, and an option array maps element-wise. A `null` scalar survives as the absent-value option
 * (§5.7.3).
 */
export function optionsToTerms(value: Options, range: Range): readonly (null | Term)[] {

	const variants = getShapeBranches(range.shape);

	if ( isObject(value) ) {

		// the `und` tag is stored as a plain literal, every other tag as a language-tagged one (§6), so
		// an und option matches by its plain value while a tagged option matches the raw tagged literal

		return Object.entries(value).flatMap(([language, values]) =>
			some(values).map(text => language === "und" ? typed(text) : tagged(text, language))
		);

	} else {

		return some(value).map(option =>
			option === null ? null : valueToTerm(option,
				getStateBranch(option, variants)
				?? (isString(option) ? variants.find(variant => variant.kind === "dictionary") : undefined)
				?? error(new RangeError(`unresolved range variant for value <${String(option)}>`)))
		);

	}

}

/**
 * Types an operand against its resolved {@link Shape | shape} (§5.7.1). A string shape carrying the
 * `sh:IRI` datatype (an id / type entry, or a reference-ranged property) renders an IRI node rather than a
 * literal, told apart from an IRI-shaped literal (a `url`) by datatype alone.
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

/**
 * Types a property's write value(s) to the RDF {@link Term | terms} to store, flattening a single value or
 * a value set against the resolved {@link Shape | shape} variant (§5.7.1).
 *
 * Each element is typed by the variant it fits: a boolean, number, or string operand to its datatype-typed
 * literal (a string shape carrying the `sh:IRI` datatype renders an IRI node instead, as in
 * {@link valueToTerm}); a localised dictionary to one plain or language-tagged term per tag (§6); a reference to
 * its IRI as-is; and a nested resource to its declared id when present (a captive resource with its own
 * identity), else a freshly skolemised IRI addressing the embedded sub-resource. Values not fitting the
 * variant are dropped.
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

					return [typed(value)];

				} else if ( isObject(value) ) {

					return Object.entries(value).flatMap(([tag, texts]) =>
						some(texts).filter(isString).map(text => tag === "und" ? typed(text) : tagged(text, tag))
					);

				} else {

					return [];

				}

			});

		case "reference":

			return some(values).filter(isReference).map(value => named(value));

		case "resource":

			const id = getShapeId(shape);

			return some(values).filter(v => isObject(v)).map(value => {
				const node = id !== undefined ? value[id] : undefined;
				return isReference(node) ? named(node) : named();
			});

		case "union": // a range variant is always a flattened branch, never a union

			throw new RangeError(`unsupported union variant`);

	}
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * The stored edge connecting `source` to `target` through a {@link Property | property}'s declared
 * predicate. Renders the forward direction when the property declares one and `source` may stand in
 * subject position, else the reverse direction when `target` may; both directions carry the value, so
 * either connects the pair. Yields the empty fragment when neither applies.
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
 * Generates the SPARQL triple pattern rendering a {@link Property | property}'s forward direction.
 *
 * Emits `subject forward object` when the property declares a `forward` predicate; an undeclared
 * forward direction contributes no pattern, yielding the empty fragment. The reverse-direction
 * counterpart is {@link reverse}.
 *
 * @param edge The edge to render, as a `[subject, property, object]` tuple
 *
 * @returns The generated triple pattern, or the empty fragment when the property declares no forward
 * predicate
 *
 * @see {@link https://www.w3.org/TR/sparql11-query/#QSynTriples SPARQL 1.1 Triple Patterns}
 */
export function forward(
	[subject, property, object]: readonly [Variable | Blank | Named, Property, Variable | Term]
): SPARQL {
	return opt(property.forward, forward => pattern([subject, named(forward), object]), nil());
}

/**
 * Generates the SPARQL triple pattern rendering a {@link Property | property}'s reverse direction.
 *
 * Emits `subject reverse object`, flipping object and subject, when the property declares a `reverse`
 * predicate; an undeclared reverse direction contributes no pattern, yielding the empty fragment. The
 * subject lands in the triple's object position, so it is constrained to an IRI {@link Reference}. The
 * forward-direction counterpart is {@link forward}.
 *
 * @param edge The edge to render, as a `[object, property, subject]` tuple
 *
 * @returns The generated triple pattern, or the empty fragment when the property declares no reverse
 * predicate
 *
 * @see {@link https://www.w3.org/TR/sparql11-query/#QSynTriples SPARQL 1.1 Triple Patterns}
 */
export function reverse(
	[object, property, subject]: readonly [Variable | Term, Property, Variable | Blank | Named]
): SPARQL {
	return opt(property.reverse, reverse => pattern([subject, named(reverse), object]), nil());
}


/**
 * The gate binding a union shape's discriminator only for members belonging to it (union.md §Model).
 *
 * A classed node shape is gated by its stored `rdf:type` triple; a plain-string literal by a
 * datatype/kind `filter` (boolean datatype, numeric test, or plain string); a localised `dictionary` shape by
 * the language-tagged literal test, disjoint from the plain string; a classless node shape by the bare
 * IRI-kind test. Under the modeller's disjointness guarantee (union.md §State) at most one shape's arm
 * binds a given value.
 *
 * @param anchor The shape's value variable
 * @param shape The shape to gate on
 *
 * @returns The gating triple pattern or `filter`
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

		case "string": // !!! review

			return filter(and(
				isLiteral(value),
				eq(lang(value), string("")),
				ne(datatype(value), reference(xsd.boolean)),
				not(isNumeric(value))
			));

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
 * The SPARQL expression applying a transform `pipe` to a value variable.
 *
 * Composes the pipe right-to-left (`reduceRight`), so the pipe's trailing transform applies to `anchor`
 * first and each earlier transform wraps the running expression, leaving the leading transform
 * outermost; an empty pipe yields the bare variable. Each {@link Transform} maps to its SPARQL aggregate
 * (`count`/`sum`/`min`/`max`/`avg`, with the empty-set patch keeping `avg` over no rows unbound rather
 * than erroring, Appendix A.4.3) or scalar function (string, numeric, and date-part).
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

			case "avg": // !!! document rationale

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
