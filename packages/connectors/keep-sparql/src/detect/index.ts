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
 * Detect-pass driver.
 *
 * Owns one `select` round per drain iteration covering every queued {@link Detect}. The cycle is:
 *
 *   **plan** → **encode** → `client.select` → **decode**
 *
 *  - the batch's candidate entries are collected;
 *  - {@link encode} folds them into one batched existence `select`;
 *  - `client.select` runs the unified query;
 *  - {@link decode} folds the entries that came back into the present-entry set and resolves each
 *    request to whether its entry is present.
 *
 * Variable allocation across the query is shared between {@link encode} and {@link decode} through
 * a single {@link createScope | Scope}.
 *
 * @module
 */

import { createScope } from "@metreeca/core/scope";
import type { Deferred, Detect } from "@metreeca/keep/batching";
import { type RepositoryClient, variable } from "@metreeca/wire-sparql";
import { decode } from "./decode.js";
import { encode } from "./encode.js";


/**
 * Per-batch body for the detect handler.
 *
 * Two phases run in sequence: **fetch** by folding the batch's candidate entries into one batched
 * existence `select` through {@link encode} and running it; **deliver** by {@link decode | decoding}
 * the solution to the present entries, folding them into a set, and resolving each request to whether
 * its entry is present.
 *
 * @param batch The queued detect requests to resolve
 * @param client The repository the existence query runs against
 *
 * @returns A promise settling once every request in the batch has been resolved
 */
export async function detect(
	batch: readonly Deferred<Detect>[],
	client: RepositoryClient
): Promise<void> {

	const scope = createScope(variable);

	decode(scope, batch, await client.select(
		encode(scope, batch)
	));

}
