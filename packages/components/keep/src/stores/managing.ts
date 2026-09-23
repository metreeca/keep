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
 * Manages mutation events, transactional execution, and lifecycle for a plain {@link StoreClient},
 * exposing it as a full {@link Store}.
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
 * This lets a connector implement only the {@link StoreClient} data surface and obtain
 * mutation events, transactional execution, and lifecycle for free: supply nothing and the wrapper provides working
 * defaults, or hand it backend primitives through `management` to back any of `execute`, `observe`, or `close`.
 *
 * Each standalone mutation call and each {@link Store.execute execute} call accumulates its own
 * batch of mutation signals and delivers a single filtered event to each matching registered
 * {@link StoreObserver observer} when the call resolves; if it rejects, pending signals are discarded
 * and no observers are notified. Both synchronous throws and asynchronous rejections from observers
 * are caught and silently ignored so that one faulty observer cannot break delivery to others.
 *
 * Any of the {@link Store} management methods may be supplied through `management` to delegate to an inner
 * implementation; the wrapper fills in whatever is missing.
 *
 * All errors — `RangeError`, {@link @metreeca/core!TraceError | TraceError},
 * {@link @metreeca/http!Problem | Problem} —
 * propagate as promise rejections per the unified {@link Store} error channel.
 *
 * > [!IMPORTANT]
 * > **Transaction Isolation** — `None` by default: the built-in `execute` is a deferred identity that applies each
 * > call directly, with no write buffering and no rollback. When an `execute` opt is supplied through `management`,
 * > the level is determined by that wrapper (typically a backend transaction primitive).
 *
 * > [!IMPORTANT]
 * > **Mutation Events** — emits in-process observer events: each standalone mutation and each
 * > {@link Store.execute execute} call delivers a single filtered batch to matching {@link StoreObserver observer}s
 * > on resolve, and none on rejection. Cross-client signals reach local observers only when a backend-bridging
 * > `observe` opt is supplied through `management`.
 *
 * @param store - Inner StoreClient to delegate data calls to
 * @param management - Subset of {@link Store} management methods to delegate to; the wrapper fills in whatever is
 *     missing
 * @param management.execute - Wraps every standalone StoreClient call and the body of {@link Store.execute execute},
 *     typically a backend transaction primitive (for example, `graph.execute` for a SPARQL connector) responsible for
 *     atomic commit and rollback. The wrapper StoreClient passed to the user task does NOT re-enter the opt; it relies
 *     on the outer wrap so cross-call isolation works as expected. The task receives a per-call `scope` StoreClient,
 *     and every delegated call within the wrap routes through `scope` (mirroring the {@link Store.execute} contract),
 *     letting the wrapper install per-call state such as a freshly-bound graph buffer without leaking it across
 *     concurrent invocations. Defaults to a deferred identity (`task => Promise.resolve().then(() => task(store))`);
 *     user-supplied wrappers MUST pass a per-call `scope` StoreClient to `task` and MUST convert synchronous throws
 *     from `task` into promise rejections to preserve the unified Store error channel; the `lookup` path delegates
 *     directly to the wrapper and provides no additional guard
 * @param management.observe - Registers each observer with the delegate as well as locally, combining the two
 *     unsubscribe handles so a single detach call releases both; this is how storage-level events (mutations from
 *     other clients sharing the backend) reach the wrapper's local observers. The resource filter always arrives as
 *     an array of references, or as `undefined` where the registration is unfiltered, so a bare reference or a
 *     single-pass iterable handed to {@link Store.observe observe} never has to be handled again downstream.
 *     Absent by default
 * @param management.close - Exposed verbatim on the returned store. Defaults to a resolved no-op
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

		lookup: (specs, opts) => execute(store => store.lookup(specs, opts)),

		create: specs => notify(({ mutated }) => execute(store => store.create(specs).then(mutated))),
		update: specs => notify(({ mutated }) => execute(store => store.update(specs).then(mutated))),
		delete: specs => notify(({ deleted }) => execute(store => store.delete(specs).then(deleted))),

		insert: (specs, opts) => notify(({ mutated }) => execute(store => store.insert(specs, opts).then(mutated))),
		remove: specs => notify(({ deleted }) => execute(store => store.remove(specs).then(deleted))),


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

				lookup: (specs, opts) => store.lookup(specs, opts),

				create: specs => store.create(specs).then(mutated),
				update: specs => store.update(specs).then(mutated),
				delete: specs => store.delete(specs).then(deleted),

				insert: (specs, opts) => store.insert(specs, opts).then(mutated),
				remove: specs => store.remove(specs).then(deleted)

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
					// and an array — possibly empty — for a filtered one

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
