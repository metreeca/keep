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
import { error, isNumber, isString, type Lazy } from "@metreeca/core";
import { resolve } from "@metreeca/core/resource";
import { equals, immutable } from "@metreeca/core/values";
import type { Query, Slot, Template } from "@metreeca/qest/model";
import type { Reference, Resource, Value } from "@metreeca/qest/state";
import type { Broker, Deferred, Detail, Detect, Handler, Limits, Modify, Request, Select } from "./batching.js";


/**
 * The form a value read off a state has to take to stand as a path segment: non-empty, with no delimiter or
 * whitespace.
 */
const SegmentFormat = /^[^\s/?#]+$/;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates a batching request {@link Broker}.
 *
 * Backs {@link createBatchingStore}: the broker queues each submitted request by type and serves the queues in rounds
 * against the supplied handlers, running all four concurrently, until every queue is empty. Within a round, a queue
 * is served as one handler call per plan and per chunk of at most the `limits` declared for its type, the calls
 * running concurrently, at most the `burst` the limits declare at once; see {@link Handler} for the plan each
 * request type shares. Requests issued mid-round, whether forwarded by a handler or freshly submitted, are served
 * in a later round, so a handler must not assume any ordering between its own run and that of another handler.
 *
 * A handler throw fails the whole run: every pending {@link Deferred} is rejected with the originating error, so
 * callers see a deterministic failure rather than a hang.
 *
 * @param handlers The batch handlers, one per request type. Each settles every {@link Deferred} in
 *     its batch and may issue nested {@link Broker.detail} / {@link Broker.select} calls while
 *     processing; its returned promise must settle only after every owned request, including
 *     transitively nested ones, has settled.
 * @param limits The most requests a handler receives in one call, per request type, and the most calls in flight
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

}, limits: Limits = {}): Broker {

	const admit = gate(limits.burst);

	const queues = {

		detect: queue(handlers.detect, () => true, limits.detect),

		detail: queue(handlers.detail, (x, y) =>
			x.shape === y.shape && equals(x.model, y.model) && equals(x.locale, y.locale), limits.detail
		),

		select: queue(handlers.select, (x, y) =>
			x.field === y.field && equals(x.query, y.query) && equals(x.locale, y.locale), limits.select
		),

		modify: queue(handlers.modify, () => true, limits.modify)

	};

	// Inner surface handed to the handlers: nested calls enqueue without kicking a drain.

	const broker: Broker = immutable({

		detect(request: Detect) {
			return new Promise<boolean>((resolve, reject) =>
				queues.detect.items.push({ request, resolve, reject })
			);
		},

		detail<S extends Lazy<ResourceShape>, T extends Template>(request: Detail<T, S>) { // ;(cast) the handler resolves Match<S, T> at runtime
			return new Promise<Match<S, T>>((resolve, reject) =>
				queues.detail.items.push({ request, resolve, reject } as Deferred<Detail>)
			);
		},

		select<T extends Query<Slot>>(request: Select<T>) {
			return new Promise<readonly Value[]>((resolve, reject) =>
				queues.select.items.push({ request, resolve, reject })
			);
		},

		modify(request: Modify) {
			return new Promise<Reference>((resolve, reject) =>
				queues.modify.items.push({ request, resolve, reject })
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


	/**
	 * Admits a handler call through the burst gate: at most `limit` calls run at once, a call past the limit starting
	 * as soon as an admitted one settles, in admission order; with no limit every call starts at once. An admitted call
	 * starts synchronously, so a queue served after another one still snapshots what that one's handlers submitted.
	 */
	function gate(limit?: number): (call: () => Promise<void>) => Promise<void> {

		if ( limit === undefined ) {

			return call => call();

		} else {

			// the admitted count and the waiting line are the gate's state, updated in place: a gate is a
			// counter by nature, and threading it through every call's promise chain would obscure the one
			// rule it enforces, admission in order (sw-developer:code, genuine state machine)

			const waiting: (() => void)[] = [];

			let admitted = 0;

			return call => new Promise((resolve, reject) => {

				const start = () => {

					admitted++;

					call().then(resolve, reject).finally(() => {
						admitted--;
						waiting.shift()?.();
					});

				};

				if ( admitted < limit ) {
					start();
				} else {
					waiting.push(start);
				}

			});

		}

	}

	/**
	 * The queue of one request type: its pending requests, and the round serving them through `handler` as one
	 * call per plan, `alike` telling the requests sharing a plan, and per chunk of at most `limit` requests.
	 */
	function queue<R extends Request>(handler: Handler<R>, alike: (x: R, y: R) => boolean, limit?: number): {

		readonly items: Deferred<R>[];

		readonly round: () => { readonly done: Promise<void>, readonly settle: () => void };
		readonly purge: (error: unknown) => void;

	} {

		const items: Deferred<R>[] = [];

		return {

			items,

			// snapshots the queued requests and hands them to the handler, keeping them queued until the round
			// is settled by the drain loop, which removes exactly the snapshot in the same step it re-checks the
			// queues: a queue emptied any earlier would let a submission landing in between kick a second drain
			// over the same snapshot, whose own removal would then drop whatever was queued behind it

			round: () => {

				const batch = items.slice();

				return {

					done: Promise.all(batches(batch).map(call => admit(() => handler(call, broker)))).then(() => undefined),

					settle: () => { items.splice(0, batch.length); }

				};

			},

			purge: error => {
				items.forEach(deferred => deferred.reject(error));
				items.length = 0;
			}

		};


		/**
		 * The handler calls serving a batch: one per plan, in order of first request, each split into chunks of at
		 * most `limit` requests in submission order, or left whole where the request type declares no limit.
		 */
		function batches(batch: readonly Deferred<R>[]): readonly (readonly Deferred<R>[])[] {

			const groups = batch.reduce<readonly (readonly Deferred<R>[])[]>((groups, item) => {

				const group = groups.find(([first]) => alike(first.request, item.request));

				return group === undefined ? [...groups, [item]]
					: groups.map(candidate => candidate === group ? [...group, item] : candidate);

			}, []);

			return groups.flatMap(group => limit === undefined ? [group]
				: Array.from({ length: Math.ceil(group.length/limit) }, (_, index) =>
					group.slice(index*limit, (index+1)*limit)
				)
			);

		}

	}

}

/**
 * Mints the identifier of a resource created under a collection.
 *
 * Returns an identifier nested under `entry`, matching the identifier {@link ResourceShape.pattern | pattern} declared
 * by the shape, if any. Each `{name}` slot is filled with the like-named member of `state`, or with an opaque segment
 * if the state has no such member. A trailing `/*` slot is always filled with an opaque segment. A root-relative
 * pattern is resolved against `entry`. If the shape declares no pattern, the identifier is an opaque segment under
 * `entry`.
 *
 * @param entry The absolute identifier of the resource collecting the new one
 * @param shape The shape describing the new resource, possibly deferred to break definition cycles
 * @param state The initial state of the new resource
 *
 * @returns The absolute identifier of the new resource
 *
 * @throws {@link !RangeError RangeError} If a member filling a slot is not a single non-empty path segment
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
