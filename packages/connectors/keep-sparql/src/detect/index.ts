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
 * Settles every queued {@link Detect} request in a batch with a single existence query against the repository.
 *
 * @module index
 */

import { createScope } from "@metreeca/core/scope";
import type { Deferred, Detect } from "@metreeca/keep/batching";
import { type RepositoryClient, variable } from "@metreeca/wire-sparql";
import { decode } from "./decode.js";
import { encode } from "./encode.js";


/**
 * Resolves a batch of detect requests with one existence query.
 *
 * Each request resolves to `true` if its entry is the subject of at least one stored triple, and to `false`
 * otherwise.
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
