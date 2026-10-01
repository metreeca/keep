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
 * Managing store wrapper.
 *
 * Turns a plain {@link StoreClient} into a full {@link Store}, supplying mutation events, transactional execution and
 * lifecycle management that a connector does not provide natively.
 *
 * @module
 */

import type { Optional } from "@metreeca/core";
import { some } from "@metreeca/core/arrays";
import type { Awaitable } from "@metreeca/core/async";
import { isNestedIRI } from "@metreeca/core/resource";
import { immutable } from "@metreeca/core/values";

import type { Reference } from "@metreeca/qest/state";

import type { Store, StoreClient, StoreObserver } from "../index.js";


/**
 * Manages mutation events, transactional execution, and lifecycle for a bare {@link StoreClient},
 * exposing it as a full {@link Store}.
 *
 * A connector can implement only the {@link StoreClient} data surface and still offer the full {@link Store}
 * contract. With no `management` options, the wrapper provides working defaults. Backend primitives supplied through
 * `management` back any of `execute`, `observe` or `close`, and the wrapper fills in whatever is missing.
 *
 * Each standalone mutation call and each {@link Store.execute execute} call delivers a single filtered event to each
 * matching {@link StoreObserver observer} once the call resolves. If the call rejects, its pending events are
 * discarded and no observer is notified. Synchronous throws and asynchronous rejections from observers are caught and
 * silently ignored, so one faulty observer cannot break delivery to others.
 *
 * All errors, including {@link !RangeError RangeError}, {@link @metreeca/core!TraceError | TraceError} and
 * {@link @metreeca/http!Problem | Problem}, propagate as promise rejections, in line with the unified {@link Store}
 * error channel.
 *
 * > [!IMPORTANT]
 * > **Transaction Isolation** — `None` by default: the built-in `execute` applies each call directly, with no write
 * > buffering and no rollback. If an `execute` option is supplied through `management`, that option determines the
 * > level, typically through a backend transaction primitive.
 *
 * > [!IMPORTANT]
 * > **Mutation Events** — emits in-process observer events: each standalone mutation and each
 * > {@link Store.execute execute} call delivers a single filtered batch to matching {@link StoreObserver observer}s
 * > on resolve, and none on rejection. Mutations made by other clients reach local observers only if a
 * > backend-bridging `observe` option is supplied through `management`.
 *
 * @param store - Inner StoreClient serving the data calls
 * @param management - Subset of {@link Store} management methods backed by the connector; the wrapper fills in
 *     whatever is missing
 * @param management.execute - Transaction wrapper applied to every standalone StoreClient call and to the body of
 *     each {@link Store.execute execute} call, typically a backend transaction primitive (for example,
 *     `graph.execute` for a SPARQL connector) responsible for atomic commit and rollback. It receives a task and MUST
 *     call it with a `scope` StoreClient dedicated to that call, so per-call state, such as a freshly bound graph
 *     buffer, never leaks across concurrent invocations; every data call within the transaction is routed through
 *     `scope`. Calls made by a user task inside {@link Store.execute execute} do not open further transactions: they
 *     share the outer one. The option MUST convert synchronous throws from the task into promise rejections, to
 *     preserve the unified Store error channel: lookups are routed through it with no additional guard. Defaults to
 *     applying the task directly to `store`, with no isolation
 * @param management.observe - Backend registration for storage-level events, such as mutations made by other clients
 *     sharing the backend. Each observer is registered both with this option and locally, and a single detach call
 *     releases both registrations. The resource filter always arrives as an array of references, or as `undefined`
 *     for an unfiltered registration, so the option never has to handle bare references or single-pass iterables.
 *     Absent by default
 * @param management.close - Exposed as is on the returned store. Defaults to a resolved no-op
 *
 * @returns An immutable {@link Store} composing `store` with the supplied `management` opts
 */
export function createManagingStore(store: StoreClient, {

	observe,
	execute = <V>(task: (store: StoreClient) => Awaitable<V>) => Promise.resolve().then(() => task(store)),
	close = () => Promise.resolve()

}: Partial<Store> = {}): Store {

	const observers = new Map<symbol, {

		readonly observer: StoreObserver,
		readonly resources: Optional<readonly Reference[]>

	}>();

	return immutable({

		lookup: (request, opts) => execute(store => store.lookup(request, opts)),

		create: request => notify(({ mutated }) => execute(store => store.create(request).then(mutated))),
		update: request => notify(({ mutated }) => execute(store => store.update(request).then(mutated))),
		delete: request => notify(({ deleted }) => execute(store => store.delete(request).then(deleted))),

		insert: request => notify(({ mutated }) => execute(store => store.insert(request).then(mutated))),
		remove: request => notify(({ deleted }) => execute(store => store.remove(request).then(deleted))),


		observe(observer, resources) {

			// normalise upfront: the filter is drawn from once, so a single-pass iterable is safely
			// shared between the local registration and the delegate

			const filter = resources === undefined ? undefined : some(resources);

			if ( filter?.length === 0 ) {

				return observe?.(observer, []) ?? (() => {});

			} else {

				const token = Symbol();
				const detach = observe?.(observer, filter);

				observers.set(token, { observer, resources: filter });

				return () => {
					try { detach?.(); } finally { observers.delete(token); }
				};

			}

		},

		execute(task) {

			return notify(({ mutated, deleted }) => execute(store => task(immutable({

				lookup: (request, opts) => store.lookup(request, opts),

				create: request => store.create(request).then(mutated),
				update: request => store.update(request).then(mutated),
				delete: request => store.delete(request).then(deleted),

				insert: request => store.insert(request).then(mutated),
				remove: request => store.remove(request).then(deleted)

			}))));

		},

		close

	});


	async function notify<V>(task: (notify: {

		mutated: <R extends Optional<Reference>>(entry: R) => R,
		deleted: <R extends Optional<Reference>>(entry: R) => R

	}) => Awaitable<V>): Promise<V> {

		const mutations = new Map<Reference, boolean>();

		const value = await task({

			mutated: entry => {
				if ( entry !== undefined ) { mutations.set(entry, true); }
				return entry;
			},

			deleted: entry => {
				if ( entry !== undefined ) { mutations.set(entry, false); }
				return entry;
			}

		});

		if ( mutations.size > 0 ) {

			observers.forEach(({ observer, resources }) => {

				const event: Record<Reference, boolean> = {};

				mutations.forEach((exists, id) => {

					// `resources` is `undefined` for an unfiltered registration (fires for every mutation)
					// and an array (possibly empty) for a filtered one

					if ( resources === undefined || resources.some(r => isNestedIRI(r, id)) ) { event[id] = exists; }

				});

				if ( Object.keys(event).length > 0 ) {

					Promise.resolve(event)
						.then(observer)
						.catch(() => { });

				}

			});

		}

		return value;

	}

}
