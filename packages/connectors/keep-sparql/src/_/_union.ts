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

import { getModelBranches } from "@metreeca/blue/union";
import type { Shape } from "@metreeca/blue/value";
import { isObject } from "@metreeca/core";
import { isSelector, isUnion } from "@metreeca/qest/model";

/**
 * Resolves which union variants a retrieval placeholder requests, and the sub-placeholder that projects
 * each (union.md §Model).
 *
 * The model addresses a union in one of two forms:
 *
 *  - a **keyed** placeholder (an object whose keys are opaque `${number}` strings) supplies one
 *    alternative per entry. Each alternative is matched independently against the variants by kind and
 *    structure ({@link @metreeca/blue/union!getModelBranches | getModelBranches}), so one alternative may
 *    reach several variants and one variant may be reached by several alternatives.
 *  - any **other** placeholder is itself a single alternative, reaching every variant its kind fits.
 *
 * The result pairs each requested variant with the alternative that projects it. When several
 * alternatives reach the same variant, the last in key order wins (plain `Map` semantics); the choice is
 * immaterial, since same-variant alternatives project it identically. The map is the single source of
 * truth shared by the encoder, which emits one arm per requested variant, and the decoder, which reads
 * each requested variant's column and projects it through the paired alternative.
 *
 * @param variants The union variants to resolve against
 * @param placeholder The union property's retrieval placeholder: a keyed alternative map, or a single
 * alternative
 *
 * @returns Each requested variant mapped to its projecting alternative; empty when the placeholder
 * requests no variant
 */
export function getUnionPlaceholders<V extends Shape>(
	variants: readonly V[],
	placeholder: unknown
): ReadonlyMap<V, unknown> {

	// criteria ride on the node retrieving a collection (§5.6) and name no alternative, so they are dropped
	// here, where the alternatives are read, rather than by every caller

	const model = isObject(placeholder)
		? Object.fromEntries(Object.entries(placeholder).filter(([key]) => !isSelector(key)))
		: placeholder;

	// the keyed form is decided once for the placeholder as a whole (§5.5 admits no mixing); the atomic leaf
	// `{}`, which `isUnion` accepts vacuously, is a single alternative

	const placeholders = isUnion(model) && Object.keys(model).length > 0
		? Object.values(model)
		: [model];

	return new Map(placeholders.flatMap(alternative =>
		(getModelBranches(alternative, variants) ?? []).map(variant => [variant, alternative])
	));

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
