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

import { isNumeric, xsd } from "@metreeca/core/datatype";
import type { Value } from "@metreeca/qest/state";
import type { Term } from "@metreeca/trio";
import type { Tuple, Variable } from "@metreeca/wire-sparql";

/**
 * The terms a solution variable binds across a tuple set, in tuple order, skipping the tuples leaving it
 * unbound.
 *
 * @param variable The solution variable to read
 * @param tuples The solution tuples to read it from
 *
 * @returns The bound terms, one per tuple binding `variable`
 */
export function column(variable: Variable, tuples: readonly Tuple[]): readonly Term[] {
	return tuples.flatMap(tuple => tuple[variable] ?? []);
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Coerces a scalar solution {@link Term} back to the QEST {@link Value} it stands for (§3.4).
 *
 * An IRI keeps its reference identity. A literal maps to its transport type: an `xsd:boolean` to a boolean, a numeric
 * datatype to a number, and any other datatype (the `xsd:string` of a plain literal included) to its lexical form.
 * The mapping is many-to-one, so processing-type distinctions are not preserved.
 *
 * @param value The solution term to coerce, an IRI reference or a plain or typed literal
 *
 * @returns The decoded value: a reference, boolean, number, or string
 *
 * @throws {@link !RangeError RangeError} If `value` is a blank node or a language-tagged literal, neither of which
 * stands for a scalar value
 */
export function termToValue(value: Term): Value {
	if ( value.kind === "blank" ) {

		throw new RangeError(`unsupported blank node <_:${value.label}>`);

	} else if ( value.kind === "named" ) {

		return value.iri;

	} else if ( value.kind === "tagged" ) {

		throw new RangeError(`unsupported language-tagged literal <${value.text}@${value.language}>`);

	} else if ( value.datatype === xsd.boolean ) {

		return value.text === "true";

	} else if ( isNumeric(value.datatype) ) {

		return Number(value.text);

	} else {

		return value.text;

	}
}
