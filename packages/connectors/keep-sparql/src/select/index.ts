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
import { equals } from "@metreeca/core/values";
import { createQueryFlake } from "@metreeca/keep-flake";
import type { Broker, Deferred, Select } from "@metreeca/keep/batching";
import { type RepositoryClient, variable } from "@metreeca/wire-sparql";
import { bounded, grouped } from "../index.core.js";
import { decode } from "./decode.js";
import { encode, type Group } from "./encode.js";


/**
 * Resolves a batch of select requests through shared `select` queries, binding at most `Chunk` owners each.
 *
 * Requests sharing a field, a structurally equal query and the same locale are planned once with
 * {@link createQueryFlake} and read together. The queries therefore grow with the number of distinct plans and
 * linearly with the number of entries, never with their product, and a batch over the cap runs as several queries.
 * Each request still resolves to the members of its own collection alone, in the order and within the window its
 * query states, whatever other requests share its plan or its query, and settles as soon as its own query returns.
 *
 * @param batch The queued select requests to resolve
 * @param client The repository the query runs against
 * @param broker The channel expanding members through the detail pass
 *
 * @returns A promise settling once the results of every query have been handed to the decoder
 */
export async function select(
	batch: readonly Deferred<Select>[],
	client: RepositoryClient,
	broker: Broker
): Promise<void> {

	const scope = createScope(variable);

	const groups = grouped<Deferred<Select>, Group>(batch,
		({ field, query, locale }, { request }) =>
			field === request.field && equals(query, request.query) && equals(locale, request.locale),
		item => ({
			field: item.request.field,
			query: item.request.query,
			locale: item.request.locale,
			flake: createQueryFlake(item.request.field.range.shape, item.request.query),
			items: [item]
		})
	);

	// each query is decoded with the very group records it was encoded from, which key its stamp and owner variables

	await Promise.all(bounded(groups).map(query => client
		.select(encode(scope, query))
		.then(tuples => decode(scope, query, broker, tuples))
	));

}
