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
 * Caching store wrapper.
 *
 * Provides {@link createCachingStore}, which wraps a {@link Store} with an in-memory cache
 * supporting LRU and TTL-based eviction, in-flight request sharing, an in-flight write bypass that prevents
 * pre-commit values from being cached, and coherent invalidation driven by both the wrapper's own write
 * operations and the delegate's mutation events.
 *
 * @module
 */

import { isArray, isObject, type Optional } from "@metreeca/core";
import type { Tag } from "@metreeca/core/language";
import { immutable } from "@metreeca/core/structures";
import type { Reference } from "@metreeca/qest/resource";
import type { Instance, Template } from "@metreeca/qest/template";
import type { Store } from "../index.js";


/**
 * Creates a caching store backed by a delegate.
 *
 * Serves repeated retrievals from an in-memory cache, sparing the delegate a round-trip whenever a prior retrieval
 * can be reused; this cuts latency and backend load for read-heavy workloads, while writes and eviction keep cached
 * results coherent and bounded.
 *
 * Retrievals are memoised under an `(entry, model, locale, limit)` key, where the model is canonicalised bottom-up so
 * templates differing only in property or element order (including arrays of objects) share a cache entry, widening
 * the set of requests a single cached result can serve.
 *
 * > [!IMPORTANT]
 * > `shape` is deliberately excluded from the cache key: the retrieval result must be a pure function of
 * > `(entry, model, locale, limit)`, with `shape` supplying only structural metadata that does not affect the
 * > returned payload.
 *
 * > [!IMPORTANT]
 * > `opts.locale` is part of the cache key because it selects which localised content a retrieval returns. Unlike
 * > the model, the locale priority list is order-significant — `["en", "it"]` and `["it", "en"]` key separately —
 * > since order encodes language-negotiation preference. An omitted or empty locale list collapses to a single key,
 * > distinct from any explicit list.
 *
 * > [!IMPORTANT]
 * > `opts.limit` is part of the cache key because it caps each selection's `#` and so changes the returned payload,
 * > with an omitted or `0` limit collapsing to a single unbounded key. `opts.plain`/`opts.depth` are excluded: they
 * > only accept or reject a model, never altering a successful payload.
 *
 * The cache offers three observable guarantees:
 *
 * - **coalescing** — concurrent retrievals for the same key resolve from a single delegate fetch, and a failed
 *   retrieval is never cached, so a later retrieval re-fetches;
 * - **read-after-write coherence** — a retrieval never returns content staler than the latest write made through this
 *   store: {@link Store.create create}, {@link Store.update update}, {@link Store.delete delete},
 *   {@link Store.insert insert} and {@link Store.remove remove} invalidate matching entries, and a
 *   retrieval overlapping an in-progress write to the same entry is served from the delegate without being cached;
 * - **commit coherence** — writes committed through {@link Store.execute execute}, by other clients sharing the
 *   delegate, or signalled by the backend invalidate matching entries on commit, for as long as the store stays open
 *   ({@link Store.close close} ends further invalidation).
 *
 * The configurable `match` predicate selects which cached entries a write invalidates.
 *
 * > [!IMPORTANT]
 * > **Transaction Isolation** — Inherited from the wrapped {@link Store}.
 *
 * > [!IMPORTANT]
 * > **Mutation Events** — Inherited from the wrapped {@link Store}.
 *
 * @param store - The delegate store to cache
 * @param options - Cache configuration options
 *
 * @returns An immutable store with caching behaviour
 *
 * @example
 * ```typescript
 * const cache = createCachingStore(restStore, { size: 1_000, ttl: 60_000 });
 * const product = await cache.lookup({ entry, shape, model });
 * ```
 */
export function createCachingStore(store: Store, {

	size = 0,
	ttl = 0,
	match = () => true

}: {

	/**
	 * Maximum number of records to cache.
	 *
	 * When the cache exceeds this bound, the least-recently-used record is evicted after each miss.
	 *
	 * @defaultValue 0 (unlimited)
	 */
	readonly size?: number;

	/**
	 * Maximum record age in milliseconds.
	 *
	 * Records older than this value are treated as misses on the next retrieval and evicted when a sibling miss
	 * triggers the TTL sweep. Expiration is checked on every hit, so a stale record is never returned even if the
	 * sweep hasn't run yet.
	 *
	 * @defaultValue 0 (no expiration)
	 */
	readonly ttl?: number;

	/**
	 * Predicate deciding which cached records an invalidation event discards.
	 *
	 * Invoked by both invalidation paths — pre-commit writes on the wrapper and reactive mutation events from the
	 * delegate — with the mutated resource's identifier and the identifier carried on each cached record. Return
	 * true to evict the record.
	 *
	 * @param entry - Identifier of the mutated resource
	 * @param cache - Identifier associated with a cached record
	 *
	 * @returns true if the record should be evicted; false otherwise
	 *
	 * @defaultValue `() => true` (every mutation clears the cache)
	 */
	readonly match?: (entry: Reference, cache: Reference) => boolean;

} = {}): Store {

	// LRU ordering is supplied for free by `Map`'s insertion-order iteration: every hit re-sets the entry,
	// moving it to the tail, so `cache.keys().next().value` is always the least-recently-used key.

	const cache = new Map<string, {

		readonly entry: Reference;			// mutated-resource identifier, used by `match` during invalidation
		readonly value: Promise<unknown>;	// memoised retrieval promise (type erased to share across generics)
		readonly created: number;			// insertion timestamp (ms) used for TTL expiration

	}>();

	// Tracks entries with at least one in-flight wrapper-initiated write. Reads of these entries bypass the
	// cache entirely — they still query the delegate, but their result is not stored. This closes the window
	// between a lookup resolving with a pre-commit value and the reactive observer firing on commit, during
	// which the cache would otherwise hold a stale-but-fresh-looking record.

	const writing = new Map<Reference, number>();


	// Reactive invalidation: subscribe to the delegate's mutation events and drop matching records on commit.
	// Covers writes routed through `execute`, writes from other clients sharing the delegate, and backends that
	// emit storage-level events. The subscription is released by `close()` so the delegate does not retain a
	// reference to a discarded wrapper.

	const unsubscribe = store.observe(mutations => {

		Object.keys(mutations).forEach(invalidate);

	});


	return immutable<Store>({

		lookup({ entry, shape, model }, opts) {

			return memoise(entry, model, opts, () => store.lookup({ entry, shape, model }, opts));

		},


		create({ entry, shape, state }) {

			return write(entry, () => store.create({ entry, shape, state }));

		},

		update({ entry, shape, state }) {

			return write(entry, () => store.update({ entry, shape, state }));

		},

		delete({ entry, shape }) {

			return write(entry, () => store.delete({ entry, shape }));

		},


		insert({ entry, shape, state }, opts) {

			return write(entry, () => store.insert({ entry, shape, state }, opts));

		},

		remove({ entry, shape }) {

			return write(entry, () => store.remove({ entry, shape }));

		},


		observe(observer, resources) {

			return store.observe(observer, resources);

		},

		execute(task) {

			return store.execute(task); // task mutations invalidate the cache reactively through events

		},

		close() {

			unsubscribe();

			return store.close();

		}

	});


	/**
	 * Retrieve-with-cache core.
	 *
	 * Three branches:
	 *
	 * - **bypass** — when `entry` has any wrapper-initiated write in flight, runs `miss()` and returns its
	 *   promise without storing it, so a pre-commit snapshot cannot be installed as fresh;
	 * - **fresh hit** — returns the memoised promise and re-inserts the record to bump its LRU position;
	 * - **miss / TTL-expired** — runs `miss()`, stores the pending promise under the canonicalised key so
	 *   concurrent callers share the in-flight request, and enforces TTL/size bounds via {@link purge}; a
	 *   rejected fetch evicts its record only if an intervening invalidation has not already replaced it.
	 *
	 * @param entry - Resource identifier; paired with the canonicalised model and varying opts to form the cache key
	 * @param model - Retrieval template, canonicalised so that equivalent templates in different orderings share a key
	 * @param vary  - Retrieval opts whose values vary the returned payload, folded into the key: `locale`
	 *   order-significantly (an omitted or empty list collapsing to a single key) and `limit` because it caps each
	 *   selection's `#` pagination bound (an omitted or `0` unbounded value collapsing to a single key)
	 * @param miss  - Fetcher invoked on cache miss, on TTL expiration, or while the entry has an in-flight write
	 *
	 * @returns The memoised, freshly-fetched, or bypass-fetched promise
	 */
	function memoise<T extends Template>(
		entry: Reference,
		model: T,
		vary: { readonly locale?: readonly Tag[]; readonly limit?: number } = {},
		miss: () => Promise<Optional<Instance<T>>>
	): Promise<Optional<Instance<T>>> {

		// Bypass the cache while a write to this entry is in flight: still query the delegate so the caller
		// gets a value, but do not store the result — it is liable to be the pre-commit snapshot that the
		// reactive observer would invalidate moments later

		if ( writing.has(entry) ) {

			return miss();

		} else {

			// Cache key layout: `<entry>\x00<canonical-model>\x00<locale>\x00<limit>`. `canonical` walks the model
			// bottom-up, sorting object keys and (already-canonical) array elements, so templates differing only in
			// ordering share a key. The locale segment is serialised verbatim (order preserved, since the priority
			// list is order-significant) with omitted and empty lists collapsing to `[]`. The limit segment is
			// keyed because it caps each selection's `#` and so changes the payload, with omitted and `0` (both
			// unbounded) collapsing to `0`. `\x00` is safe as a separator — IRIs cannot contain it and JSON always
			// escapes it inside string payloads.

			const key = `${entry}\x00${canonical(model)}\x00${JSON.stringify(vary.locale ?? [])}\x00${vary.limit ?? 0}`;

			const cached = cache.get(key);

			if ( cached && !expired(cached.created) ) {

				// hit: re-insert to move the entry to the tail of the Map's iteration order (the LRU position),
				// and return the memoised promise; the cast reflects the type-erased `Promise<unknown>` storage
				// that lets records with different template types share one Map

				cache.delete(key);
				cache.set(key, cached);

				return cached.value as Promise<Optional<Instance<T>>>;

			} else {

				// miss (or TTL-expired): drop any stale record, run the fetcher, and memoise the pending promise
				// under the same key so concurrent callers share the in-flight request; a failure evicts its own
				// record through the catch handler so transient errors are not retained

				if ( cached ) {
					cache.delete(key);
				}

				const value = miss().catch(error => {

					// identity-check: only evict if this promise is still the cached one —
					// avoids dropping a newer record installed after an intervening invalidate

					if ( cache.get(key)?.value === value ) {
						cache.delete(key);
					}

					throw error;

				});

				cache.set(key, {

					entry,
					value,
					created: Date.now()

				});

				purge();

				return value;

			}

		}

	}


	/**
	 * Serialises a value to a canonical JSON-like string.
	 *
	 * Children are canonicalised first, then sorted by their already-canonical string form — so arrays of
	 * objects are ordered by structural content rather than by the `"[object Object]"` placeholder that
	 * `Array.prototype.sort` would otherwise impose. The output collapses values differing only in property
	 * or element order to the same string.
	 *
	 * @param value - Value to serialise
	 *
	 * @returns A canonical string representation of `value`
	 */
	function canonical(value: unknown): string {

		if ( isArray(value) ) {

			return `[${value.map(canonical).sort().join(",")}]`;

		} else if ( isObject(value) ) {

			return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;

		} else {

			// JSON.stringify(undefined) returns undefined, not a string; substitute a distinct sentinel so the
			// signature holds and `undefined` does not collide with the string literal `"undefined"` (which JSON
			// would render with surrounding quotes)

			return value === undefined ? "undefined" : JSON.stringify(value);

		}
	}

	/**
	 * Tests whether a record is older than the configured TTL.
	 *
	 * Returns false when `ttl <= 0`, so the predicate can be reused at both the hit guard and the purge sweep
	 * without duplicating the boundary check. The reference timestamp defaults to `Date.now` but may be
	 * passed in to share a single snapshot across a batch of comparisons.
	 *
	 * @param created - Insertion timestamp (ms) of the record under test
	 * @param now     - Reference timestamp (ms) to compare against; defaults to `Date.now`
	 *
	 * @returns true if `ttl > 0` and `created` is older than `ttl` milliseconds relative to `now`; false otherwise
	 */
	function expired(created: number, now: number = Date.now()): boolean {

		return ttl > 0 && now-created > ttl;

	}

	/**
	 * Run a wrapper-initiated write under in-flight tracking.
	 *
	 * Marks `entry` as having an in-flight write, runs the configured pre-commit invalidation, delegates to
	 * `op`, and clears the marker once the delegate settles. While the marker is set, retrievals of `entry`
	 * bypass the cache so a pre-commit value can never be stored as fresh.
	 *
	 * @param entry - Resource identifier targeted by the write
	 * @param op    - Thunk that delegates the write to the wrapped store and returns its promise
	 *
	 * @returns The promise returned by `op`, settled after the in-flight marker has been cleared
	 */
	function write<T>(entry: Reference, op: () => Promise<T>): Promise<T> {

		writing.set(entry, (writing.get(entry) ?? 0)+1);

		invalidate(entry);

		return op().finally(() => {

			const count = (writing.get(entry) ?? 1)-1;

			if ( count <= 0 ) { writing.delete(entry); } else { writing.set(entry, count); }

		});

	}

	/**
	 * Drop cached records matching a mutated resource.
	 *
	 * Iterates the cache and removes every record whose stored identifier satisfies the configured {@link match}
	 * predicate against the mutated `entry`. Called from both the pre-commit write path on the wrapper and the
	 * reactive observer attached to the delegate.
	 *
	 * @param entry - Identifier of the mutated resource
	 */
	function invalidate(entry: Reference): void {

		for (const [key, record] of cache) {
			if ( match(entry, record.entry) ) { cache.delete(key); }
		}

	}

	/**
	 * Enforce TTL and size bounds.
	 *
	 * Runs two sweeps: first, when `ttl > 0`, drops every record older than `ttl` milliseconds; second, when
	 * `size > 0` and the cache is overfull, drops the head slice of the Map (least-recently-used first) in
	 * a single batch sized to the exact overflow. Invoked after every miss so expired siblings and overfill
	 * are cleaned up incrementally — the cache has no background sweeper.
	 */
	function purge(): void {

		if ( ttl > 0 ) {

			const now = Date.now();

			for (const [key, record] of cache) {
				if ( expired(record.created, now) ) { cache.delete(key); }
			}

		}

		// LRU sweep: when over the size bound, take the head slice of Map keys (insertion order = LRU first)
		// and drop them — `cache.size - size` is the exact overflow, so no loop condition needs re-checking

		if ( size > 0 && cache.size > size ) {

			Array.from(cache.keys())
				.slice(0, cache.size-size)
				.forEach(key => cache.delete(key));

		}

	}

}
