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
 * Single-valued properties are read from that query, while multi-valued properties are read off the collections
 * the spine materialises through the {@link Broker}, the only channel between passes. The handler returns without
 * waiting for those nested requests, so the select pass serves them in a later batching round of the same run.
 *
 * @module index
 */

import { createFlake } from "@metreeca/keep-flake";
import type { Broker, Deferred, Detail } from "@metreeca/keep/batching";
import type { RepositoryClient } from "@metreeca/wire-sparql";
import { read } from "../spine.js";
import { decode } from "./decode.js";
import { encode } from "./encode.js";
import { schema } from "./schema.js";


/**
 * Resolves a batch of detail requests through one shared `select` query.
 *
 * The batching layer hands over requests sharing a shape, a structurally equal model and a locale, planned once
 * with {@link createFlake}, so all entries are read together. The query grows with the plan and linearly with the
 * entries, never with their product. A plan reading no single-valued property runs no query. Its requests still
 * resolve: `id` and `type` come from the entry and the shape, multi-valued properties from the select pass.
 *
 * @param batch The queued detail requests to resolve, sharing one plan
 * @param client The repository the query runs against
 * @param broker The channel forwarding multi-valued properties to the select pass
 *
 * @returns A promise settling once every request has been decoded or rejected, without waiting for the select
 *     requests materialising multi-valued properties, which run in a later batching round
 */
export function detail(
	batch: readonly Deferred<Detail>[],
	client: RepositoryClient,
	broker: Broker
): Promise<void> {

	const [{ request: { shape, model } }] = batch;

	// the plan and its schema are derived once and handed to both sides, so they bind and read the same columns

	const flake = createFlake(shape, model);
	const columns = schema(flake);

	return read(batch, client, broker, {

		// a plan binding no column (only id/type or collection slots) runs no query: its requests still reach the
		// decoder, which yields id/type inline and reads collections off the select pass

		encode: scope => columns.size > 0
			? encode(scope, batch.map(({ request }) => request.entry), flake, columns)
			: undefined,

		owner: scope => scope.resolve(flake),

		decode: (scope, item, rows) => decode(scope, flake, columns, item, rows)

	});

}
