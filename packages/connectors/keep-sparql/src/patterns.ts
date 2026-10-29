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
 * Shape-aware SPARQL emitters.
 *
 * The graph patterns and expressions every pass composes its clauses from: the stored edge of a property, the
 * clause gating a union variant, the test telling a plain string apart, the expression applying a transform pipe,
 * and the patterns settling localised text. Each emitter renders one shape-level notion into SPARQL text and knows
 * nothing of the pass calling it, so the passes differ only in how they assemble clauses from them, and a connector
 * for another query language reimplements this module alone, leaving the spine, the codecs and the drivers as they are.
 *
 * **Localised text.** A localised label is coalesced where it is consumed (§6.2). The select pass filters, sorts
 * and projects on the label, so {@link coalesced} and {@link folded} settle it in SPARQL under the request's
 * language priority; the detail pass only returns it, and under a locale placeholder returns every tag, so it reads
 * the raw tagged values and coalesces them in the decoder through the tag-priority reader of `terms.ts`. Both halves
 * apply the same priority: the first tag of the request's locale the property carries a value under wins.
 *
 * @module
 */

import { getShapeClass, type Property } from "@metreeca/blue/resource";
import { getShapeBranches } from "@metreeca/blue/union";
import { type Shape } from "@metreeca/blue/value";
import { isString, opt } from "@metreeca/core";
import { xsd } from "@metreeca/core/datatype";
import type { Tag } from "@metreeca/core/language";
import type { Scope } from "@metreeca/core/scope";
import { type Transform } from "@metreeca/qest/model";
import { named, type Named, rdf, type Subject, type Term } from "@metreeca/trio";
import type { SPARQL, Variable } from "@metreeca/wire-sparql";
import {
	abs,
	and,
	avg,
	bind,
	ceil,
	coalesce,
	count,
	datatype,
	day,
	eq,
	exists,
	filter,
	floor,
	gt,
	hours,
	iif,
	isBound,
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
	optional,
	or,
	pattern,
	reference,
	round,
	seconds,
	str,
	string,
	strlen,
	sum,
	term,
	ucase,
	variable,
	year
} from "@metreeca/wire-sparql/builder";


/**
 * The stored edge a node is reached through.
 */
export type Edge = {

	/**
	 * The subject holding the property: a variable, or the IRI of the request entry.
	 */
	readonly owner: Variable | Named;

	/**
	 * The property the edge stores.
	 */
	readonly property: Property;

	/**
	 * The variable bound to the stored object, which is the node value itself unless the node coalesces or folds text.
	 */
	readonly object: Variable;

};


//// Edges ////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Generates the SPARQL triple pattern matching the stored edge from `source` to `target` through a
 * {@link Property | property}, in whichever of its declared directions the two ends can be stated.
 *
 * Both declared directions store the value, so either one connects the pair. The forward direction is used if the
 * property declares one and `source` may stand in subject position; otherwise the reverse direction is used if
 * `target` may, a literal never standing as the subject of a stored triple whatever the property declares.
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

	function isAnchor(value: Variable | Term): value is Variable | Subject {
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
export function forward([subject, property, object]: readonly [Variable | Subject, Property, Variable | Term]): SPARQL {
	return opt(property.forward, forward => pattern([subject, named(forward), object]), nil());
}

/**
 * Generates the SPARQL triple pattern for a {@link Property | property}'s reverse direction.
 *
 * The edge is stated in forward order and the pattern swaps its ends, reading `subject reverse object`. The forward
 * object becomes the subject of the stored triple, so it is constrained to a variable, a blank node or an IRI, and
 * a literal object cannot be stated this way at all. The forward-direction counterpart is {@link forward}.
 *
 * @param edge The edge to render, in forward order, as an `[object, property, subject]` tuple
 *
 * @returns The generated triple pattern, or the empty fragment if the property declares no `reverse` predicate
 *
 * @see {@link https://www.w3.org/TR/sparql11-query/#QSynTriples SPARQL 1.1 Triple Patterns}
 */
export function reverse([object, property, subject]: readonly [Variable | Term, Property, Variable | Subject]): SPARQL {
	return opt(property.reverse, reverse => pattern([subject, named(reverse), object]), nil());
}

/**
 * Renders the subject an edge hangs off: a variable or the IRI of the request entry.
 *
 * @param owner The edge subject to render
 *
 * @returns The rendered subject
 */
export function anchor(owner: Variable | Named): SPARQL {
	return isString(owner) ? variable(owner) : term(owner);
}


//// Variants /////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Generates the SPARQL clause admitting only the values belonging to a union variant.
 *
 * A classed resource or reference variant is gated by its stored `rdf:type` triple, and a classless one by an IRI
 * test. A boolean, number or string variant is gated by a `filter` on the literal kind. A localised `dictionary`
 * variant is gated by a language-tagged literal test, disjoint from the plain string test. Union variants are disjoint
 * by contract, so at most one variant admits a given value and a stored value never surfaces under two of them.
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


//// Localised Text ///////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Generates the patterns binding a localised property's coalesced label (§6.2).
 *
 * The first tag of the request's language priority the property carries wins, and the values under it come back as
 * plain strings, so every construct downstream reads an ordinary `xsd:string`. Only language-tagged values are text: a
 * plain string a sibling string variant stores never passes. An owner carrying no value under any priority tag binds
 * nothing, as every owner does under an empty priority, which is taken literally rather than defaulted (§6.2).
 *
 * A property fixing a single string per tag is read through one `optional` edge per priority tag, coalesced into
 * one label. A property carrying several strings per tag settles the winning tag with an `exists` probe per tag
 * instead (Appendix A.5): a join per tag would multiply its rows by the values under every other tag.
 *
 * @param scope The variable scope allocating the per-tag edges or the probe the priority is settled with
 * @param edge The edge storing the localised values
 * @param target The variable the label is bound to
 * @param locale The request's language priority, most preferred first
 *
 * @returns The patterns binding the label to `target`
 */
export function coalesced(scope: Scope<Variable>, edge: Edge, target: SPARQL, locale: readonly Tag[]): readonly SPARQL[] {

	const { owner, property, object } = edge;

	const raw = variable(object);

	if ( isUniqueLang(property) && locale.length > 0 ) {

		const tagged = locale.map(tag => ({ tag, value: scope.resolve() }));

		return [
			...tagged.map(({ tag, value }) => optional(
				link([owner, property, value]),
				filter(eq(lang(variable(value)), string(tag)))
			)),
			bind(str(coalesce(...tagged.map(({ value }) => variable(value)))), target),
			filter(isBound(target))
		];

	} else {

		return [
			link([owner, property, object]),
			filter(and(ne(lang(raw), string("")), eq(lang(raw), winner(scope, edge, locale)))),
			bind(str(raw), target)
		];

	}

}

/**
 * Generates the patterns binding a property mixing text with other variants, folded (§3.2).
 *
 * A tagged value passes under the winning tag of the request's language priority alone, as a plain string; any
 * other stored value, a plain string or a node among them, passes as it is, so one column carries every variant.
 *
 * @param scope The variable scope allocating the probe the priority is settled with
 * @param edge The edge storing the mixed values
 * @param target The variable the folded value is bound to
 * @param locale The request's language priority, most preferred first
 *
 * @returns The patterns binding the folded value to `target`
 */
export function folded(scope: Scope<Variable>, edge: Edge, target: SPARQL, locale: readonly Tag[]): readonly SPARQL[] {

	const { owner, property, object } = edge;

	const raw = variable(object);
	const tag = coalesce(lang(raw), string("")); // a node carries no tag

	return [
		link([owner, property, object]),
		filter(or(eq(tag, string("")), eq(tag, winner(scope, edge, locale)))),
		bind(iif(eq(tag, string("")), raw, str(raw)), target)
	];

}

/**
 * Generates the expression settling the tag the request's language priority picks for a property's text: the
 * first priority tag the owner carries a value under, or the empty string for none.
 */
function winner(scope: Scope<Variable>, { owner, property }: Edge, locale: readonly Tag[]): SPARQL {

	const probe = scope.resolve();

	return locale.reduceRight<SPARQL>((rest, tag) => iif(present(tag), string(tag), rest), string(""));


	function present(tag: Tag): SPARQL {
		return exists(link([owner, property, probe]), filter(eq(lang(variable(probe)), string(tag))));
	}

}


/**
 * Checks whether a localised property fixes a single string per tag, so its coalesced label is one value.
 */
function isUniqueLang(property: Property): boolean {
	return getShapeBranches(property.range.shape).some(variant =>
		variant.kind === "dictionary" && variant.uniqueLang === true
	);
}


//// Transforms ///////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Generates the SPARQL expression applying a transform `pipe` to an `anchor` expression (§5.8.2).
 *
 * The trailing transform applies to `anchor` first and the leading transform is outermost. Each {@link Transform}
 * maps to its SPARQL aggregate or scalar function. An `avg` over no rows leaves its binding unbound rather than `0`,
 * as QEST requires (Appendix A.4.3), so an empty group decodes to an absent average rather than to a false zero.
 *
 * @param anchor The expression the pipe transforms, typically a value variable
 * @param pipe The transforms to compose, leading (outermost) first
 *
 * @returns The SPARQL expression applying `pipe` to `anchor`, or `anchor` itself when `pipe` is empty
 *
 * @see {@link https://www.w3.org/TR/sparql11-query/#aggregates SPARQL 1.1 Aggregates}
 */
export function expression(anchor: SPARQL, pipe: readonly Transform[]): SPARQL {

	return pipe.reduceRight((expression, transform) => apply(expression, transform), anchor);

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
				// A.4.3): forcing an ill-typed cast on an empty count errors the expression, so the binding
				// stays unbound and decodes as absent, with no sentinel value the decoder has to recognise

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
