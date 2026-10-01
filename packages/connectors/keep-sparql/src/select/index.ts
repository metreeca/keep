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
 * Select-pass driver.
 *
 * Materialises every queued {@link Select} collection in a batch with a single `select` query against the
 * repository. Members whose content the request asks for are expanded through the detail pass.
 *
 * @module index
 */

import { createScope } from "@metreeca/core/scope";
import { createQueryFlake } from "@metreeca/keep-flake";
import type { Broker, Deferred, Select } from "@metreeca/keep/batching";
import { type RepositoryClient, variable } from "@metreeca/wire-sparql";
import { decode } from "./decode.js";
import { encode } from "./encode.js";


/**
 * Resolves a batch of select requests with one `select` query.
 *
 * Each request is planned with {@link createQueryFlake}, and every plan is folded into one query. Each request
 * resolves to the members of its collection, in the order and window its query states.
 *
 * @param batch The queued select requests to resolve
 * @param client The repository the query runs against
 * @param broker The channel expanding members through the detail pass
 *
 * @returns A promise settling once the query results have been handed to the decoder
 */
export async function select(
	batch: readonly Deferred<Select>[],
	client: RepositoryClient,
	broker: Broker
): Promise<void> {

	const scope = createScope(variable);

	const items = batch.map(select =>
		({ ...select, flake: createQueryFlake(select.request.field.range.shape, select.request.query) })
	);

	decode(scope, items, broker, await client.select(
		encode(scope, items)
	));

}
