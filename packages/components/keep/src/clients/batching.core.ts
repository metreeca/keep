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

import type { Identifier, Lazy } from "@metreeca/core";
import type { ResourceShape } from "@metreeca/blue/resource";
import type { Delivery } from "@metreeca/blue/value";
import { immutable } from "@metreeca/core/values";
import type { Reference } from "@metreeca/qest/state";
import type { Template } from "@metreeca/qest/model";
import type { Items, Mould } from "../_inference.js";
import type { Broker, Deferred, Detect, Handler, Lookup, Modify, Request, Select } from "./batching.js";

/**
 * Creates a batching request {@link Broker}.
 *
 * Backs {@link createBatchingStore}: returns a broker that queues each submitted request by type and
 * drives the queues to completion against the supplied handlers. The first submission kicks a drain
 * loop that runs all four handlers concurrently, round by round, until every queue is quiescent;
 * requests issued mid-round, whether forwarded by a handler or freshly submitted, are served on a
 * later round, so handlers must not assume any ordering between handlers.
 *
 * Handler errors poison the run: every still-pending {@link Deferred} is rejected with the
 * originating error, so callers see a deterministic failure rather than a hang.
 *
 * @param handlers The batch handlers, one per request type. Each settles every {@link Deferred} in
 *     its batch and may issue nested {@link Broker.lookup} / {@link Broker.select} calls while
 *     processing; its returned promise must settle only after every owned request, including
 *     transitively nested ones, has settled.
 *
 * @returns An immutable {@link Broker} surface for enqueuing requests and receiving their
 *     materialised results; each call returns a promise that settles when the relevant batch
 *     completes
 */
export function createBroker(handlers: {

	detect: Handler<Detect>
	lookup: Handler<Lookup>
	select: Handler<Select>
	modify: Handler<Modify>

}): Broker {

	const queues: Record<Identifier, {

		readonly items: Deferred<Request>[];

		readonly drain: () => Promise<void>;
		readonly purge: (error: unknown) => void;

	}> = Object.fromEntries(Object.entries(handlers).map(([key, handler]) => {

		const items: Deferred<Request>[] = [];

		return [key, {

			items,

			drain: async () => {
				if ( items.length > 0 ) {
					const batch = items.slice();
					await handler(batch as never, broker); // ;(cast) erased to the handler's union parameter
					items.splice(0, batch.length);
				}
			},

			purge: error => {
				items.forEach(deferred => deferred.reject(error));
				items.length = 0;
			}

		}];

	}));

	// Inner surface handed to the handlers: nested calls enqueue without kicking a drain.

	const broker: Broker = immutable({

		detect(request: Detect) { // ;(cast) the erased queue holds the union; this entry is a Detect
			return new Promise<boolean>((resolve, reject) =>
				queues.detect.items.push({ request, resolve, reject } as Deferred<Detect>)
			);
		},

		lookup<S extends Lazy<ResourceShape>, T extends Template>(request: Lookup<T, S>) { // ;(cast) the handler resolves Instance<T> at runtime
			return new Promise<Delivery<S, T>>((resolve, reject) =>
				queues.lookup.items.push({ request, resolve, reject } as Deferred<Lookup>)
			);
		},

		select<T extends Mould>(request: Select<T>) { // ;(cast) the handler resolves Items<T> at runtime
			return new Promise<Items<T>>((resolve, reject) =>
				queues.select.items.push({ request, resolve, reject } as Deferred<Select>)
			);
		},

		modify(request: Modify) { // ;(cast) the erased queue holds the union; this entry is a Modify
			return new Promise<Reference>((resolve, reject) =>
				queues.modify.items.push({ request, resolve, reject } as Deferred<Modify>)
			);
		}

	});

	// Public surface: every call enqueues through the inner broker and kicks a drain via `process`.

	return immutable({

		detect(request: Detect) {
			return process(() => broker.detect(request));
		},

		lookup<S extends Lazy<ResourceShape>, T extends Template>(request: Lookup<T, S>) {
			return process(() => broker.lookup(request));
		},

		select<T extends Mould>(request: Select<T>) {
			return process(() => broker.select(request));
		},

		modify(request: Modify) {
			return process(() => broker.modify(request));
		}

	});


	// Kicks a drain only when every queue is idle: a running drain keeps its snapshot queued, so
	// "all empty" means "no drain in flight". The kick is a microtask, so a synchronous burst of
	// submissions coalesces into one drain. The check runs before `submit` enqueues, or it would
	// always see the request it just pushed.

	function process<T>(submit: () => T): T {

		// a running drain keeps its snapshot in the queues until the round ends, so any non-empty
		// queue means a drain is already in flight; all-empty is the only "no drain running" state

		if ( Object.values(queues).every(queue => queue.items.length === 0) ) {

			Promise.resolve().then(async () => {

				// Drain in rounds until every queue is quiescent, all four handlers concurrently per
				// round. A handler keeps its snapshot in the queue across the `await` (so the idle-check
				// still sees work and won't kick a second drain) and removes exactly it on success;
				// anything pushed mid-round is served next round. A throw leaves the snapshot queued to purge.

				try {

					while ( Object.values(queues).some(queue => queue.items.length > 0) ) {
						await Promise.all(Object.values(queues).map(queue => queue.drain()));
					}

				} catch ( error ) {

					// A handler throw poisons the run: purge every queue so pending callers reject
					// instead of hanging; already-settled entries no-op.

					Object.values(queues).forEach(queue => queue.purge(error));

				}

			});

		}

		return submit();
	}

}
