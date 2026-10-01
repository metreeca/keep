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
 * Modify-pass result decoder.
 *
 * Settles each queued {@link Modify} once the batched update has been applied, resolving it to its own `entry`. A
 * SPARQL update returns no bindings, so there is nothing to read back.
 *
 * @module
 */

import type { Scope } from "@metreeca/core/scope";
import type { Deferred, Modify } from "@metreeca/keep/batching";
import type { Variable } from "@metreeca/wire-sparql";


/**
 * Resolves each applied modify request to its entry.
 *
 * @param scope The shared variable scope, unused: the update projects no bindings
 * @param batch The queued modify requests to settle, each carrying the `request` whose `entry` is returned
 * @param value The update result, unused: a SPARQL update returns no solution
 */
export function decode(
	scope: Scope<Variable>,
	batch: readonly Deferred<Modify>[],
	value: void
): void {

	batch.forEach(({ request, resolve }) =>
		resolve(request.entry)
	);

}
