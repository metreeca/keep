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
 * Detect-pass query encoder.
 *
 * Folds a batch of candidate entries into one `select distinct` query returning exactly the entries that are the
 * subject of at least one stored triple. Variables are allocated through the {@link Scope} shared with the decoder,
 * so both sides agree on the subject variable.
 *
 * @module
 */

import type { Scope } from "@metreeca/core/scope";
import type { Deferred, Detect } from "@metreeca/keep/batching";
import type { SPARQL, Variable } from "@metreeca/wire-sparql";
import { distinct, edge, reference, select, values, variable, where } from "@metreeca/wire-sparql/builder";


/**
 * Encodes the batched existence query for a set of candidate entries.
 *
 * @param scope The shared variable scope, also threaded into the decoder
 * @param batch The candidate items to probe, each carrying the `request` whose `entry` is tested for existence
 *
 * @returns A `select distinct` query projecting the subject variable for every entry that is the
 * subject of at least one stored triple; an entry with no triples returns no row
 */
export function encode(
	scope: Scope<Variable>,
	batch: readonly Deferred<Detect>[]
): SPARQL {

	const subject = scope.resolve(batch);

	return select(distinct(variable(subject)), where(
		values([variable(subject)], batch.map(({ request }) =>
			[reference(request.entry)]
		)),
		edge(
			variable(subject),
			variable(scope.resolve()),
			variable(scope.resolve())
		)
	));

}
