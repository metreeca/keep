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
import { createQueryFlake } from "@metreeca/keep-flake";
import type { Broker, Deferred, Select } from "@metreeca/keep/batching";
import { type RepositoryClient, variable } from "@metreeca/wire-sparql";
import { decode } from "./decode.js";
import { encode } from "./encode.js";


/**
 * Per-batch body for the select handler.
 *
 * Three phases run in sequence: **plan** every request by pairing it with its
 * {@link _flake_!createFlake | flake} and unpacking the deferred callbacks; **fetch** by
 * folding plans into one batched SELECT through
 * {@link encode} and running it; **deliver** by {@link decode | decoding} each request,
 * expanding nested-resource references through the supplied {@link Broker}, and settling
 * each request's deferred. Variable allocation across the
 * batched SELECT is shared between {@link encode} and {@link decode} via a single
 * {@link createScope | Scope}, so the decoder recovers the same per-request slots.
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
