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
 * Resources-pass driver.
 *
 * Owns one SELECT round per drain iteration covering every queued
 * {@link Lookup}. The cycle is:
 *
 *   **plan** → **encode** → `client.select` → **decode**
 *
 *  - {@link _flake_!createFlake | createFlake} builds the per-request lookup plan
 *    ({@link Flake} IR) from `(shape, model)`;
 *  - {@link encode} folds every plan into one batched SELECT whose WHERE is a union of
 *    arms, coordinated with the decoder through the shared {@link Scope};
 *  - `client.select` runs the unified query;
 *  - {@link decode} walks each request's plan alongside the returned tuples, decoding
 *    single-valued slots inline and forwarding set-valued slots to the collections
 *    pass through {@link select}.
 *
 * Multi-valued slots are forwarded to the collections pass through the supplied
 * {@link Broker}, the only cross-pass communication channel admitted by this module.
 * Decoding chains the deferred's resolution through the returned promise so the handler
 * can return promptly and let the drain advance to the collections pass within the same
 * iteration.
 *
 * @module
 */

import { eager } from "@metreeca/blue/value";
import { createScope, type Scope } from "@metreeca/core/scope";
import { createFlake, type Flake, isModelBranch } from "@metreeca/keep-flake";
import type { Broker, Deferred, Lookup } from "@metreeca/keep/batching";
import { type RepositoryClient, variable as toVariable } from "@metreeca/wire-sparql";
import { decode } from "./decode.js";
import { encode } from "./encode.js";


/**
 * Per-batch body for the lookup handler.
 *
 * Three phases run in sequence: **plan** every request via
 * {@link _flake_!createFlake | createFlake}; **fetch** by
 * folding plans into one batched SELECT through {@link encode}; **deliver** by
 * {@link decode | decoding} each request against the returned tuples and settling the
 * deferred. Variable allocation across the batched
 * SELECT is shared via a single {@link createScope | Scope} passed into {@link encode}, so
 * the decoder recovers each request's per-slot columns by resolving the same branch nodes.
 *
 * Items whose flake carries no top-level descent branch are filtered out of the fetch
 * phase (their arms would be empty), and the fetch is skipped entirely when no item
 * contributes anything. They still flow through the deliver phase, where {@link decode}
 * yields `id` / `type` entries inline from the focus and shape and routes set-valued
 * slots through the collections pass.
 */
export async function lookup(
	batch: readonly Deferred<Lookup>[],
	client: RepositoryClient,
	broker: Broker
): Promise<void> {

	const scope = createScope(toVariable);

	const items = batch.map(lookup =>
		({ ...lookup, flake: createFlake(eager(lookup.request.shape), lookup.request.model) })
	);

	// drop items whose union arm would be empty (only id/type or collection slots) from the fetch;
	// they still flow through delivery, where decode yields id/type inline and routes collections

	const effective = items.filter(({ flake }) =>
		Object.values(flake.entries ?? {}).flat().some(isModelBranch)
	);

	decode(scope, items, broker, effective.length === 0 ? [] : await client.select(
		encode(scope, effective)
	));

}
