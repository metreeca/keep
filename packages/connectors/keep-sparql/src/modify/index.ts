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

import { createScope } from "@metreeca/core/scope";
import { createFlake } from "@metreeca/keep-flake";
import type { Deferred, Modify } from "@metreeca/keep/batching";
import { type RepositoryClient, variable as toVariable } from "@metreeca/wire-sparql";
import { decode } from "./decode.js";
import { encode } from "./encode.js";

/**
 * Applies a batch of {@link Modify} requests against a repository as a single update.
 *
 * Each request is encoded by the presence of its `state`: a present `state` inserts (creates or
 * updates) the entry, an omitted `state` removes it. Every request's operations are folded into one
 * SPARQL update joined in submission order, so the backend applies them sequentially
 * ({@link https://www.w3.org/TR/sparql11-update/#updateLanguage SPARQL 1.1 Update §3}) and, where
 * supported, atomically (§3.2). The batch arrives pre-validated by the batching layer, which rejects
 * any request whose `state` carries an `id` other than its `entry` (§4.1) before it reaches here, so
 * every request is applied unconditionally; each batched {@link Deferred} resolves to its entry once
 * the update completes, while a backend failure propagates for the batching layer to settle as a
 * rejection across the batch.
 *
 * @param batch The modify requests to apply
 * @param client The repository the mutations are applied against
 *
 * @returns A promise settling once the batched update has been applied
 */
export async function modify(
	batch: readonly Deferred<Modify>[],
	client: RepositoryClient
): Promise<void> {

	const scope = createScope(toVariable);

	const items = batch.map(modify =>
		({ ...modify, flake: createFlake(modify.request.shape) })
	);

	decode(scope, items, await client.update(
		encode(scope, items)
	));

}
