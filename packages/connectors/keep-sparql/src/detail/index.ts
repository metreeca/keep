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
 * Detail-pass driver.
 *
 * Materialises every queued {@link Detail} request in a batch with a single `select` query against the repository.
 * Single-valued properties are read from that query, while multi-valued properties are forwarded to the select pass
 * through the {@link Broker}, the only channel between passes. The handler returns without waiting for the
 * forwarded requests, so the select pass can run them within the same batching round.
 *
 * @module index
 */

import { eager } from "@metreeca/blue/value";
import { createScope } from "@metreeca/core/scope";
import { createFlake, isModelBranch } from "@metreeca/keep-flake";
import type { Broker, Deferred, Detail } from "@metreeca/keep/batching";
import { type RepositoryClient, variable as toVariable } from "@metreeca/wire-sparql";
import { decode } from "./decode.js";
import { encode } from "./encode.js";


/**
 * Resolves a batch of detail requests with one `select` query.
 *
 * Each request is planned with {@link createFlake}, and every plan is folded into one query. Requests reading no
 * single-valued property contribute nothing to the query, and no query runs if none does. Such requests still
 * resolve: `id` and `type` come from the entry and the shape, and multi-valued properties come from the select pass.
 *
 * @param batch The queued detail requests to resolve
 * @param client The repository the query runs against
 * @param broker The channel forwarding multi-valued properties to the select pass
 *
 * @returns A promise settling once the query results have been handed to the decoder
 */
export async function detail(
	batch: readonly Deferred<Detail>[],
	client: RepositoryClient,
	broker: Broker
): Promise<void> {

	const scope = createScope(toVariable);

	const items = batch.map(detail =>
		({ ...detail, flake: createFlake(eager(detail.request.shape), detail.request.model) })
	);

	// drop items whose union arm would be empty (only id/type or collection slots) from the fetch;
	// they still flow through delivery, where decode yields id/type inline and routes collections

	const effective = items.filter(({ flake }) =>
		Object.values(flake.entries ?? {}).some(isModelBranch)
	);

	decode(scope, items, broker, effective.length === 0 ? [] : await client.select(
		encode(scope, effective)
	));

}
