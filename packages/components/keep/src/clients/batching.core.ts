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

import type { ResourceShape } from "@metreeca/blue/resource";
import { eager, type Match } from "@metreeca/blue/value";
import { error, type Identifier, isNumber, isString, type Lazy } from "@metreeca/core";
import { resolve } from "@metreeca/core/resource";
import { immutable } from "@metreeca/core/values";
import type { Query, Slot, Template } from "@metreeca/qest/model";
import type { Reference, Resource, Value } from "@metreeca/qest/state";
import type { Broker, Deferred, Detect, Handler, Detail, Modify, Request, Select } from "./batching.js";


/**
 * The form a value read off a state has to take to stand as a path segment: non-empty, with no delimiter or
 * whitespace.
 */
const SegmentFormat = /^[^\s/?#]+$/;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

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
 *     its batch and may issue nested {@link Broker.detail} / {@link Broker.select} calls while
 *     processing; its returned promise must settle only after every owned request, including
 *     transitively nested ones, has settled.
 *
 * @returns An immutable {@link Broker} surface for enqueuing requests and receiving their
 *     materialised results; each call returns a promise that settles when the relevant batch
 *     completes
 */
export function createBroker(handlers: {

	detect: Handler<Detect>
	detail: Handler<Detail>
	select: Handler<Select>
	modify: Handler<Modify>

}): Broker {

	const queues: Record<Identifier, {

		readonly items: Deferred<Request>[];

		readonly round: () => { readonly done: Promise<void>, readonly settle: () => void };
		readonly purge: (error: unknown) => void;

	}> = Object.fromEntries(Object.entries(handlers).map(([key, handler]) => {

		const items: Deferred<Request>[] = [];

		return [key, {

			items,

			// snapshots the queued requests and hands them to the handler, keeping them queued until the round
			// is settled by the drain loop, which removes exactly the snapshot in the same step it re-checks the
			// queues: a queue emptied any earlier would let a submission landing in between kick a second drain
			// over the same snapshot, whose own removal would then drop whatever was queued behind it

			round: () => {

				const batch = items.slice();

				return { // ;(cast) erased to the handler's union parameter

					done: batch.length > 0 ? handler(batch as never, broker) : Promise.resolve(),

					settle: () => { items.splice(0, batch.length); }

				};

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

		detail<S extends Lazy<ResourceShape>, T extends Template>(request: Detail<T, S>) { // ;(cast) the handler resolves Match<S, T> at runtime
			return new Promise<Match<S, T>>((resolve, reject) =>
				queues.detail.items.push({ request, resolve, reject } as Deferred<Detail>)
			);
		},

		select<T extends Query<Slot>>(request: Select<T>) { // ;(cast) the erased queue holds the union; this entry is a Select
			return new Promise<readonly Value[]>((resolve, reject) =>
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

		detail<S extends Lazy<ResourceShape>, T extends Template>(request: Detail<T, S>) {
			return process(() => broker.detail(request));
		},

		select<T extends Query<Slot>>(request: Select<T>) {
			return process(() => broker.select(request));
		},

		modify(request: Modify) {
			return process(() => broker.modify(request));
		}

	});


	// Kicks a drain only when every queue is idle: a running drain keeps its snapshots queued until the
	// step that re-checks the queues, so "all empty" means "no drain in flight". The kick is a microtask,
	// so a synchronous burst of submissions coalesces into one drain. The check runs before `submit`
	// enqueues, or it would always see the request it just pushed.

	function process<T>(submit: () => T): T {

		if ( Object.values(queues).every(queue => queue.items.length === 0) ) {

			Promise.resolve().then(async () => {

				// Drain in rounds until every queue is quiescent, all four handlers concurrently per
				// round. Every snapshot stays queued across the `await` and is removed in the same
				// synchronous step as the next idle check, so no submission can ever find the queues empty
				// while the loop is alive; anything pushed mid-round is served next round. A throw leaves
				// the snapshots queued to purge.

				try {

					while ( Object.values(queues).some(queue => queue.items.length > 0) ) {

						const rounds = Object.values(queues).map(queue => queue.round());

						await Promise.all(rounds.map(round => round.done));

						rounds.forEach(round => round.settle());

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

/**
 * Mints the identifier of a resource created under a collection.
 *
 * Yields an identifier nested under `entry` that matches the identifier {@link ResourceShape.pattern | pattern}
 * the shape declares, where it does: each `{name}` slot of the pattern is read off the like-named member of `state`
 * where the state carries one, and filled with an opaque segment otherwise, as is a trailing `/*` slot; a
 * root-relative pattern is resolved against `entry`. A shape declaring no pattern yields an opaque segment under
 * `entry`.
 *
 * @param entry The absolute identifier of the resource collecting the new one
 * @param shape The shape describing the new resource, possibly deferred to break definition cycles
 * @param state The initial state of the new resource
 *
 * @returns The absolute identifier of the new resource
 *
 * @throws {@link !RangeError RangeError} If a member a slot is read off is not a single non-empty path segment
 */
export function mint(entry: Reference, shape: Lazy<ResourceShape>, state: Resource): Reference {

	const { pattern } = eager(shape);

	return pattern === undefined
		? resolve(entry.endsWith("/") ? entry : `${entry}/`, crypto.randomUUID())
		: resolve(entry, pattern.replace(/\{(\w*)}|(?<=\/)\*$/g, (_, name?: string) =>
			name === undefined ? crypto.randomUUID() : segment(name)
		));


	/**
	 * Reads a pattern slot off the like-named member of the state, or fills it with an opaque segment.
	 */
	function segment(name: string): string {

		const value = state[name];

		return value === undefined ? crypto.randomUUID()
			: (isString(value) || isNumber(value)) && SegmentFormat.test(String(value)) ? String(value)
				: error(new RangeError(`illegal identifier segment <${String(value)}> for slot <${name}>`));

	}

}
