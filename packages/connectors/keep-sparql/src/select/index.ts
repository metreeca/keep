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
 * Materialises every queued {@link Select} collection in a batch with a single `select` query against the repository.
 * Members whose content the request asks for are read off the resources the spine materialises through the detail pass
 * under the template the request stated for them, in a later batching round of the same run.
 *
 * @module index
 */

import { createQueryFlake } from "@metreeca/keep-flake";
import type { Broker, Deferred, Select } from "@metreeca/keep/batching";
import type { RepositoryClient } from "@metreeca/wire-sparql";
import { read } from "../spine.js";
import { decode } from "./decode.js";
import { encode, type Group } from "./encode.js";
import { schema } from "./schema.js";


/**
 * Resolves a batch of select requests through one shared `select` query.
 *
 * The batching layer hands over requests sharing a field, a structurally equal query and the same locale, planned
 * once with {@link createQueryFlake} and read together, so the query grows with the plan and linearly with the
 * owners, never with their product. Each request still resolves to the members of its own collection alone, in the
 * order and within the window its query states, whatever other requests share its plan.
 *
 * @param batch The queued select requests to resolve, sharing one plan
 * @param client The repository the query runs against
 * @param broker The channel expanding members through the detail pass
 *
 * @returns A promise settling once every request has been decoded or rejected, without waiting for the members
 *     expanded through the detail pass, which serves them in a later batching round
 */
export function select(
	batch: readonly Deferred<Select>[],
	client: RepositoryClient,
	broker: Broker
): Promise<void> {

	const [{ request: { field, query, locale } }] = batch;

	// the query is decoded with the very group record it was encoded from, which keys its owner variable, and
	// with the schema derived once from its plan, so both sides project and read the same columns

	const flake = createQueryFlake(field.range.shape, query);

	const group: Group = {
		field, query, locale,
		flake,
		schema: schema(flake),
		items: batch
	};

	return read(batch, client, broker, {

		encode: scope => encode(scope, group),
		owner: scope => scope.resolve(group),

		decode: (scope, item, rows) => decode(scope, group, item, rows)

	});

}
