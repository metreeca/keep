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
 * Detect-pass result decoder.
 *
 * Settles each queued {@link Detect} against the existence query's solution tuples: the entries
 * that came back are the candidates that are the subject of at least one stored triple. The subject
 * token is recovered from the shared {@link Scope} threaded from the driver, so it matches the
 * encoder's projection, and every request's deferred resolves to whether its entry is present.
 *
 * @module
 */

import type { Scope } from "@metreeca/core/scope";
import type { Deferred, Detect } from "@metreeca/keep/batching";
import type { Tuple, Variable } from "@metreeca/wire-sparql";


/**
 * Resolves a batch of detect requests against the existence query's present entries.
 *
 * Recovers the entries bound to the subject variable, folds them into a membership set, and settles
 * each request's deferred to whether its `entry` is present.
 *
 * @param scope The shared variable scope, also threaded into the encoder
 * @param batch The queued detect requests to settle, each carrying the `request` whose `entry` is tested
 * @param tuples The solution tuples returned by the batched existence `select`
 */
export function decode(
	scope: Scope<Variable>,
	batch: readonly Deferred<Detect>[],
	tuples: readonly Tuple[]
): void {

	const subject = scope.resolve(batch);

	const entries = new Set(tuples.flatMap(tuple => {
		const term = tuple[subject];
		return term?.kind === "named" ? [term.iri] : [];
	}));

	batch.forEach(({ request, resolve }) =>
		resolve(entries.has(request.entry))
	);

}
