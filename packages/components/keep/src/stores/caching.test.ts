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
import type { Lazy } from "@metreeca/core";
import type { Reference } from "@metreeca/qest/state";
import type { Template } from "@metreeca/qest/model";
import { describe, expect, it, vi } from "vitest";
import type { LookedUp } from "../_/blue/value/index.js";
import type { Store, StoreClient, StoreObserver } from "../index.js";
import { createCachingStore } from "./caching.js";


describe("createCachingStore", () => {

	// minimal placeholder shape: MockStore does not exercise shape validation, so a structurally
	// valid but empty ResourceShape is sufficient — no cast required

	const shape: Lazy<ResourceShape> = () => ({ kind: "resource", classes: [], parents: [], members: {} });


	// time constants used by the TTL eviction suite — siblings expressed in terms of TTL

	const TTL = 100;
	const EXPIRED = TTL+50;	// advance the clock past the TTL boundary
	const FRESH = TTL-50;	// advance the clock but stay within the TTL window
	const FOREVER = 1_000_000;	// far beyond any plausible TTL, for the "no expiration" test


	// arbitrary task return value used to verify execute passthrough
	const RESULT = 42;


	/**
	 * Creates a deferred promise — returns the pending promise alongside its `resolve`/`reject` settlers,
	 * so tests can drive promise resolution explicitly without nested constructors.
	 */
	function defer<T = undefined>(): {
		readonly promise: Promise<T>;
		readonly resolve: (value: T) => void;
		readonly reject: (error: unknown) => void;
	} {

		let resolve: (value: T) => void = () => {};
		let reject: (error: unknown) => void = () => {};

		const promise = new Promise<T>((res, rej) => {
			resolve = res;
			reject = rej;
		});

		return { promise, resolve, reject };

	}

	/**
	 * Runs the test body under Vitest's fake-timer mode, restoring real timers afterwards even on failure.
	 */
	async function withFakeTimers(body: () => Promise<void>): Promise<void> {

		vi.useFakeTimers();

		try { await body(); } finally { vi.useRealTimers(); }

	}

	function MockStore(overrides: Partial<Store> = {}): Store & { calls: string[] } {

		const calls: string[] = [];
		const observers = new Set<StoreObserver>();

		function signal(entry: Reference, exists: boolean): void {
			observers.forEach(observer => observer({ [entry]: exists }));
		}

		const store: Store & { calls: string[] } = {

			calls,

			lookup(specs) {
				calls.push("lookup");
				// a found resource, cacheable unlike absence; ;(cast) test mock: the payload shape is irrelevant here
				return overrides.lookup?.(specs) ?? Promise.resolve({} as LookedUp<typeof specs.shape, typeof specs.model>);
			},

			create(specs) {
				calls.push("create");
				const result = overrides.create?.(specs) ?? Promise.resolve(specs.entry);
				return result.then(value => {
					if ( value !== undefined ) { signal(specs.entry, true); }
					return value;
				});
			},

			update(specs) {
				calls.push("update");
				const result = overrides.update?.(specs) ?? Promise.resolve(specs.entry);
				return result.then(value => {
					if ( value !== undefined ) { signal(specs.entry, true); }
					return value;
				});
			},

			delete(specs) {
				calls.push("delete");
				const result = overrides.delete?.(specs) ?? Promise.resolve(specs.entry);
				return result.then(value => {
					if ( value !== undefined ) { signal(specs.entry, false); }
					return value;
				});
			},

			insert(specs) {
				calls.push("insert");
				const result = overrides.insert?.(specs) ?? Promise.resolve(specs.entry);
				return result.then(value => {
					if ( value !== undefined ) { signal(specs.entry, true); }
					return value;
				});
			},

			remove(specs) {
				calls.push("remove");
				const result = overrides.remove?.(specs) ?? Promise.resolve(specs.entry);
				return result.then(value => {
					if ( value !== undefined ) { signal(specs.entry, false); }
					return value;
				});
			},

			execute(task) {
				calls.push("execute");
				return overrides.execute?.(task) ?? Promise.resolve(task(store));
			},

			observe(observer, resources) {
				// intentionally not tracked in `calls`: createCacheStore subscribes
				// at construction time, which would pollute every call-log assertion
				observers.add(observer);
				const overrideUnsub = overrides.observe?.(observer, resources);
				return () => {
					observers.delete(observer);
					overrideUnsub?.();
				};
			},

			close() {
				calls.push("close");
				return overrides.close?.() ?? Promise.resolve();
			}

		};

		return store;

	}


	describe("lookup", () => {

		it("should delegate on first call", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/products/1", shape, model: { name: {} } });

			expect(mock.calls).toEqual(["lookup"]);

		});

		it("should return cached result on second call", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/products/1", shape, model: { name: {} } });
			await store.lookup({ entry: "/products/1", shape, model: { name: {} } });

			expect(mock.calls).toEqual(["lookup"]);

		});

		it("should cache independently for different entries", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/products/1", shape, model: { name: {} } });
			await store.lookup({ entry: "/products/2", shape, model: { name: {} } });

			expect(mock.calls).toEqual(["lookup", "lookup"]);

		});

		it("should cache independently for different models on same entry", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: { name: {} } });
			await store.lookup({ entry: "/x", shape, model: { price: {} } });

			expect(mock.calls).toEqual(["lookup", "lookup"]);

		});

		it("should share cache across different shapes for same entry and model", async () => {

			// shape is intentionally excluded from the cache key — see the IMPORTANT note on createCachingStore

			const shape2: Lazy<ResourceShape> = () => ({ kind: "resource", classes: [], parents: [], members: {} });
			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} });
			await store.lookup({ entry: "/x", shape: shape2, model: {} });

			expect(mock.calls).toEqual(["lookup"]);

		});

		// canonical() walks the model bottom-up, sorting object keys and array elements, so templates differing only
		// in property order or in the order of an order-insignificant option set collapse to the same cache key

		const equivalent: ReadonlyArray<readonly [string, Template, Template]> = [
			["flat property order", { name: {}, price: {} }, { price: {}, name: {} }],
			["nested object property order", { vendor: { name: {}, id: {} } }, { vendor: { id: {}, name: {} } }],
			["selection option order",
				{ items: { id: {}, "?tag": ["b", "a", "c"] } },
				{ items: { id: {}, "?tag": ["a", "b", "c"] } }]
		];

		it.each(equivalent)("should share a cache entry across equivalent models differing in %s", async (_label, first, second) => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: first });
			await store.lookup({ entry: "/x", shape, model: second });

			expect(mock.calls).toEqual(["lookup"]);

		});

		it("should not collide an absent field with one asked for", async () => {

			// `canonical` substitutes a sentinel for undefined to avoid `JSON.stringify(undefined) === undefined`
			// — a model eliding a field must canonicalise to a different key from one asking for it

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: { tag: undefined } });
			await store.lookup({ entry: "/x", shape, model: { tag: {} } });

			expect(mock.calls).toEqual(["lookup", "lookup"]);

		});

		it("should share in-flight promise for concurrent equivalent retrieves", async () => {

			const delegate = defer();

			let callCount = 0;
			const mock = MockStore({
				lookup: () => {
					callCount++;
					return delegate.promise;
				}
			});

			const store = createCachingStore(mock);

			const p1 = store.lookup({ entry: "/x", shape, model: {} });
			const p2 = store.lookup({ entry: "/x", shape, model: {} });

			delegate.resolve(undefined);
			await Promise.all([p1, p2]);

			expect(callCount).toBe(1);

		});

		it("should evict entry on delegate rejection", async () => {

			const error = new Error("fail");
			let callCount = 0;

			const mock = MockStore({
				lookup: () => {
					callCount++;
					return Promise.reject(error);
				}
			});

			const store = createCachingStore(mock);

			await expect(store.lookup({ entry: "/x", shape, model: {} })).rejects.toThrow("fail");
			await expect(store.lookup({ entry: "/x", shape, model: {} })).rejects.toThrow("fail");

			expect(callCount).toBe(2);

		});

		it("should not cache absent resources", async () => {

			const mock = MockStore({ lookup: () => Promise.resolve(undefined) });
			const store = createCachingStore(mock);

			await expect(store.lookup({ entry: "/x", shape, model: {} })).resolves.toBeUndefined();
			await expect(store.lookup({ entry: "/x", shape, model: {} })).resolves.toBeUndefined();

			expect(mock.calls).toEqual(["lookup", "lookup"]);

		});

		it("should not evict a newer in-flight entry when a replaced entry resolves as absent", async () => {

			const first = defer();
			const second = defer();

			const responses: Array<Promise<undefined>> = [first.promise, second.promise];
			let callCount = 0;

			const mock = MockStore({
				lookup: () => {
					callCount++;
					return responses.shift() ?? Promise.resolve(undefined);
				}
			});

			const store = createCachingStore(mock);

			const p1 = store.lookup({ entry: "/x", shape, model: {} });

			await store.create({ entry: "/x", shape, state: {} }); // invalidates /x

			const p2 = store.lookup({ entry: "/x", shape, model: {} }); // stores second.promise at /x

			first.resolve(undefined);
			await p1;

			const p3 = store.lookup({ entry: "/x", shape, model: {} }); // must share second.promise

			second.resolve(undefined);
			await Promise.all([p2, p3]);

			expect(callCount).toBe(2);

		});

		it("should not evict a newer in-flight entry when a replaced entry rejects", async () => {

			// Regression: the rejection catch handler must not drop a cache record that was
			// replaced by a later miss after invalidation. Sequence: miss1 stores promise1;
			// invalidate clears the key; miss2 stores promise2 at the same key; promise1
			// rejects — promise2's record must remain so concurrent callers keep sharing
			// the in-flight request.

			const first = defer();
			const second = defer();

			const responses: Array<Promise<undefined>> = [first.promise, second.promise];
			let callCount = 0;

			const mock = MockStore({
				lookup: () => {
					callCount++;
					return responses.shift() ?? Promise.resolve(undefined);
				}
			});

			const store = createCachingStore(mock);

			const p1 = store.lookup({ entry: "/x", shape, model: {} });
			p1.catch(() => { /* suppress unhandled rejection */ });

			await store.create({ entry: "/x", shape, state: {} }); // invalidates /x

			const p2 = store.lookup({ entry: "/x", shape, model: {} }); // stores second.promise at /x

			first.reject(new Error("stale"));
			await expect(p1).rejects.toThrow("stale");

			const p3 = store.lookup({ entry: "/x", shape, model: {} }); // must share second.promise

			second.resolve(undefined);
			await Promise.all([p2, p3]);

			expect(callCount).toBe(2);

		});

	});


	describe("locale keying", () => {

		it("should cache independently for different locales on same entry and model", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} }, { locale: ["en"] });
			await store.lookup({ entry: "/x", shape, model: {} }, { locale: ["it"] });

			expect(mock.calls).toEqual(["lookup", "lookup"]);

		});

		it("should return cached result for identical locales", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} }, { locale: ["en", "it"] });
			await store.lookup({ entry: "/x", shape, model: {} }, { locale: ["en", "it"] });

			expect(mock.calls).toEqual(["lookup"]);

		});

		it("should cache independently for different locale priority order", async () => {

			// the priority list is order-significant — order encodes negotiation preference, so a reversed
			// list selects content differently and must not share a cache entry

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} }, { locale: ["en", "it"] });
			await store.lookup({ entry: "/x", shape, model: {} }, { locale: ["it", "en"] });

			expect(mock.calls).toEqual(["lookup", "lookup"]);

		});

		it("should share cache for omitted and empty locale", async () => {

			// an omitted locale and an explicit empty list both express "no preference" and resolve to the
			// same content, so they collapse to a single cache entry

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} });
			await store.lookup({ entry: "/x", shape, model: {} }, { locale: [] });

			expect(mock.calls).toEqual(["lookup"]);

		});

	});


	describe("limit keying", () => {

		it("should cache independently for different limits on same entry and model", async () => {

			// limit injects a `#` pagination bound into the executed model, so distinct limits select
			// different result sets and must not share a cache entry

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} }, { limit: 50 });
			await store.lookup({ entry: "/x", shape, model: {} }, { limit: 100 });

			expect(mock.calls).toEqual(["lookup", "lookup"]);

		});

		it("should return cached result for identical limits", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} }, { limit: 50 });
			await store.lookup({ entry: "/x", shape, model: {} }, { limit: 50 });

			expect(mock.calls).toEqual(["lookup"]);

		});

		it("should share cache for omitted and unbounded (zero) limit", async () => {

			// an omitted limit and limit zero are both unbounded — neither injects a `#` bound — so they
			// resolve to the same content and collapse to a single cache entry

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} });
			await store.lookup({ entry: "/x", shape, model: {} }, { limit: 0 });

			expect(mock.calls).toEqual(["lookup"]);

		});

	});


	describe("query option keying", () => {

		// opts.plain and opts.depth only accept or reject a model — they never alter a successful payload — so they
		// are excluded from the cache key; retrievals differing only in these opts collapse to the same cache entry

		const excluded: ReadonlyArray<readonly [string, { readonly plain?: boolean; readonly depth?: number }, {
			readonly plain?: boolean;
			readonly depth?: number
		}]> = [
			["plain", { plain: true }, { plain: false }],
			["depth", { depth: 0 }, { depth: 5 }]
		];

		it.each(excluded)("should share a cache entry across retrievals differing only in %s", async (_opt, first, second) => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} }, first);
			await store.lookup({ entry: "/x", shape, model: {} }, second);

			expect(mock.calls).toEqual(["lookup"]);

		});

	});


	describe("delegate passthrough", () => {

		const passthrough: ReadonlyArray<readonly [string, Partial<Store>, (store: StoreClient) => Promise<unknown>, unknown]> = [
			["create", { create: () => Promise.resolve(undefined) }, store => store.create({
				entry: "/x",
				shape,
				state: {}
			}), undefined],
			["update", { update: () => Promise.resolve(undefined) }, store => store.update({
				entry: "/x",
				shape,
				state: {}
			}), undefined],
			["delete", { delete: () => Promise.resolve(undefined) }, store => store.delete({
				entry: "/x",
				shape
			}), undefined],
			["insert", { insert: () => Promise.resolve("/x") }, store => store.insert({
				entry: "/x",
				shape,
				state: {}
			}), "/x"],
			["remove", { remove: () => Promise.resolve("/x") }, store => store.remove({ entry: "/x", shape }), "/x"]
		];

		it.each(passthrough)("should return the delegate %s result", async (_mutator, override, call, expected) => {

			const store = createCachingStore(MockStore(override));

			expect(await call(store)).toBe(expected);

		});

	});


	describe("observe", () => {

		it("should delegate to underlying store", async () => {

			const observeSpy = vi.fn(() => () => {});
			const mock = MockStore({ observe: observeSpy });
			const store = createCachingStore(mock);

			// clear the internal subscription registered at construction time
			observeSpy.mockClear();

			const observer: StoreObserver = () => {};
			store.observe(observer);

			expect(observeSpy).toHaveBeenCalledWith(observer, undefined);

		});

		it("should forward resources parameter", async () => {

			const observeSpy = vi.fn(() => () => {});
			const mock = MockStore({ observe: observeSpy });
			const store = createCachingStore(mock);

			observeSpy.mockClear();

			const observer: StoreObserver = () => {};
			store.observe(observer, "/products/");

			expect(observeSpy).toHaveBeenCalledWith(observer, "/products/");

		});

		it("should propagate the delegate's unsubscribe", async () => {

			// the wrapper's observe returns whatever the delegate's observe returns; calling that
			// function must reach through to the configured unsubscribe spy

			const unsubscribeSpy = vi.fn();
			const mock = MockStore({ observe: () => unsubscribeSpy });
			const store = createCachingStore(mock);

			const unsubscribe = store.observe(() => {});
			unsubscribe();

			expect(unsubscribeSpy).toHaveBeenCalledOnce();

		});

	});


	describe("execute", () => {

		it("should delegate to underlying store", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.execute(() => Promise.resolve());

			expect(mock.calls).toEqual(["execute"]);

		});

		it("should return the task result", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			const result = await store.execute(() => Promise.resolve(RESULT));

			expect(result).toBe(RESULT);

		});

		it("should invalidate cache for writes within execute task", async () => {

			// the inner store passed to the task is the cache wrapper itself, so writes through
			// inner.create route through the wrapper's pre-commit invalidation before delegating

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} });

			await store.execute(inner => inner.create({ entry: "/x", shape, state: {} }));

			mock.calls.length = 0;
			await store.lookup({ entry: "/x", shape, model: {} });

			expect(mock.calls).toEqual(["lookup"]);

		});

	});


	describe("close", () => {

		it("should delegate close to the wrapped store", async () => {

			const closeSpy = vi.fn(() => Promise.resolve());
			const mock = MockStore({ close: closeSpy });
			const store = createCachingStore(mock);

			await store.close();

			expect(closeSpy).toHaveBeenCalledOnce();

		});

		it("should propagate close errors from the store", async () => {

			const error = new Error("close failed");
			const mock = MockStore({ close: () => Promise.reject(error) });
			const store = createCachingStore(mock);

			await expect(store.close()).rejects.toThrow("close failed");

		});

		it("should unsubscribe from store mutation events on close", async () => {

			// the internal observer registered at construction must be detached on close to release
			// the delegate's reference to the cache wrapper

			const unsubscribeSpy = vi.fn();

			const mock = MockStore({
				observe: () => unsubscribeSpy
			});

			const store = createCachingStore(mock);

			await store.close();

			expect(unsubscribeSpy).toHaveBeenCalledOnce();

		});

	});


	describe("invalidation", () => {

		const mutators: ReadonlyArray<readonly [string, (store: StoreClient) => Promise<unknown>]> = [
			["create", store => store.create({ entry: "/products/1", shape, state: {} })],
			["update", store => store.update({ entry: "/products/1", shape, state: {} })],
			["delete", store => store.delete({ entry: "/products/1", shape })],
			["insert", store => store.insert({ entry: "/products/1", shape, state: {} })],
			["remove", store => store.remove({ entry: "/products/1", shape })]
		];

		it.each(mutators)("should invalidate the cached entry on %s", async (mutator, mutate) => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/products/1", shape, model: {} });

			mock.calls.length = 0;

			await mutate(store);
			await store.lookup({ entry: "/products/1", shape, model: {} });

			expect(mock.calls).toEqual([mutator, "lookup"]);

		});

		it("should call match with write entry and cached entry", async () => {

			const matchSpy = vi.fn(() => true);
			const mock = MockStore();
			const store = createCachingStore(mock, { match: matchSpy });

			await store.lookup({ entry: "/products/1", shape, model: {} });

			matchSpy.mockClear();

			await store.create({ entry: "/products/2", shape, state: {} });

			expect(matchSpy).toHaveBeenCalledWith("/products/2", "/products/1");

		});

		it("should call match on the reactive invalidation path", async () => {

			// the match predicate governs both invalidation paths — the pre-commit write path above and the
			// reactive path fed by the delegate's mutation events; here a broadcast event must consult match
			// with the mutated identifier and each cached record's identifier

			const matchSpy = vi.fn(() => true);

			let capturedObserver: StoreObserver | undefined;

			const mock = MockStore({
				observe: observer => {
					capturedObserver = observer;
					return () => { capturedObserver = undefined; };
				}
			});

			const store = createCachingStore(mock, { match: matchSpy });

			await store.lookup({ entry: "/products/1", shape, model: {} });

			matchSpy.mockClear();

			capturedObserver?.({ "/products/2": true });

			expect(matchSpy).toHaveBeenCalledWith("/products/2", "/products/1");

		});

		it("should invalidate cache on mutations broadcast by store", async () => {

			// the reactive path: the cache subscribes to the delegate's mutation events and invalidates
			// on external writes (another client, a raw delegate reference inside execute, etc.)

			let capturedObserver: StoreObserver | undefined;

			const mock = MockStore({
				observe: observer => {
					capturedObserver = observer;
					return () => { capturedObserver = undefined; };
				}
			});

			const store = createCachingStore(mock);

			await store.lookup({ entry: "/x", shape, model: {} });

			// simulate a mutation event emitted by the underlying store
			capturedObserver?.({ "/x": true });

			mock.calls.length = 0;
			await store.lookup({ entry: "/x", shape, model: {} });

			expect(mock.calls).toEqual(["lookup"]);

		});

		it("should not cache results retrieved while a write is in flight", async () => {

			// Regression: a read concurrent with an in-flight write must not install its result
			// into the cache. Without this, a lookup that resolves before the write commits
			// would cache the pre-commit value, leaving a stale entry visible to other readers
			// in the window between the lookup resolving and the reactive observer firing.

			const update = defer<Reference>();
			const mock = MockStore({ update: () => update.promise });
			const store = createCachingStore(mock);

			// start the write — pre-commit invalidate runs; underlying update is pending
			const updatePromise = store.update({ entry: "/x", shape, state: {} });

			// concurrent lookup resolves while the write is still in flight
			await store.lookup({ entry: "/x", shape, model: {} });

			mock.calls.length = 0;

			// the in-flight lookup must not have cached its result — a second lookup must
			// still hit the delegate; if the cache held the stale value this would be a hit
			await store.lookup({ entry: "/x", shape, model: {} });

			expect(mock.calls).toEqual(["lookup"]);

			update.resolve("/x");
			await updatePromise;

		});

		it("should bypass cache for every concurrent reader during an in-flight write", async () => {

			// Same hazard as the single-reader case, but with multiple concurrent retrievers:
			// none of them may install a cache record while the write is pending — otherwise a
			// later retriever could share their in-flight promise and observe stale data.

			const update = defer<Reference>();
			const mock = MockStore({ update: () => update.promise });
			const store = createCachingStore(mock);

			const updatePromise = store.update({ entry: "/x", shape, state: {} });

			// fire two concurrent retrieves while the write is in flight
			await Promise.all([
				store.lookup({ entry: "/x", shape, model: {} }),
				store.lookup({ entry: "/x", shape, model: {} })
			]);

			mock.calls.length = 0;

			// a follow-up lookup must still miss — neither concurrent reader cached
			await store.lookup({ entry: "/x", shape, model: {} });

			expect(mock.calls).toEqual(["lookup"]);

			update.resolve("/x");
			await updatePromise;

		});

		it("should keep bypassing until every concurrent write to an entry settles", async () => {

			// the in-flight marker is reference-counted per entry, so overlapping writes to the same entry
			// each hold the bypass open; a retrieval is cacheable again only once the last write settles

			const first = defer<Reference>();
			const second = defer<Reference>();

			const updates: Array<Promise<Reference>> = [first.promise, second.promise];
			const mock = MockStore({ update: () => updates.shift() ?? Promise.resolve("/x") });
			const store = createCachingStore(mock);

			const w1 = store.update({ entry: "/x", shape, state: {} });
			const w2 = store.update({ entry: "/x", shape, state: {} });

			// first write settles while the second is still in flight — the bypass must remain open
			first.resolve("/x");
			await w1;

			await store.lookup({ entry: "/x", shape, model: {} }); // bypassed, not cached

			mock.calls.length = 0;
			await store.lookup({ entry: "/x", shape, model: {} }); // still a miss

			expect(mock.calls).toEqual(["lookup"]);

			// second write settles — the bypass clears and retrievals cache again
			second.resolve("/x");
			await w2;

			await store.lookup({ entry: "/x", shape, model: {} }); // miss, now cached

			mock.calls.length = 0;
			await store.lookup({ entry: "/x", shape, model: {} }); // hit

			expect(mock.calls).toEqual([]);

		});

		it("should retain entries when match returns false", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock, {
				match: (entry, cache) => entry === cache
			});

			await store.lookup({ entry: "/products/1", shape, model: {} });
			await store.lookup({ entry: "/products/2", shape, model: {} });

			mock.calls.length = 0;

			await store.create({ entry: "/products/1", shape, state: {} });

			await store.lookup({ entry: "/products/1", shape, model: {} }); // should miss
			await store.lookup({ entry: "/products/2", shape, model: {} }); // should hit

			expect(mock.calls).toEqual(["create", "lookup"]);

		});

	});


	describe("lru eviction", () => {

		it("should evict least recently used entry when size exceeded", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock, { size: 2 });

			await store.lookup({ entry: "/a", shape, model: {} });
			await store.lookup({ entry: "/b", shape, model: {} });
			await store.lookup({ entry: "/c", shape, model: {} }); // should evict /a

			mock.calls.length = 0;

			await store.lookup({ entry: "/c", shape, model: {} }); // hit
			await store.lookup({ entry: "/a", shape, model: {} }); // miss

			expect(mock.calls).toEqual(["lookup"]);

		});

		it("should refresh LRU on access", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock, { size: 2 });

			await store.lookup({ entry: "/a", shape, model: {} });
			await store.lookup({ entry: "/b", shape, model: {} });
			await store.lookup({ entry: "/a", shape, model: {} }); // refresh /a
			await store.lookup({ entry: "/c", shape, model: {} }); // should evict /b, not /a

			mock.calls.length = 0;

			await store.lookup({ entry: "/a", shape, model: {} }); // hit
			await store.lookup({ entry: "/b", shape, model: {} }); // miss

			expect(mock.calls).toEqual(["lookup"]);

		});

		it("should not evict entries when size is 0 (default)", async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			for (let i = 0; i < 10; i++) {
				await store.lookup({ entry: `/e/${i}`, shape, model: {} });
			}

			mock.calls.length = 0;

			for (let i = 0; i < 10; i++) {
				await store.lookup({ entry: `/e/${i}`, shape, model: {} });
			}

			expect(mock.calls).toEqual([]);

		});

	});


	describe("ttl eviction", () => {

		it("should evict expired entries", () => withFakeTimers(async () => {

			const mock = MockStore();
			const store = createCachingStore(mock, { ttl: TTL });

			await store.lookup({ entry: "/a", shape, model: {} });

			vi.advanceTimersByTime(EXPIRED);

			mock.calls.length = 0;

			await store.lookup({ entry: "/a", shape, model: {} }); // miss after expiration

			expect(mock.calls).toEqual(["lookup"]);

		}));

		it("should keep non-expired entries", () => withFakeTimers(async () => {

			const mock = MockStore();
			const store = createCachingStore(mock, { ttl: TTL });

			await store.lookup({ entry: "/a", shape, model: {} });

			vi.advanceTimersByTime(FRESH);

			mock.calls.length = 0;

			await store.lookup({ entry: "/a", shape, model: {} }); // hit

			expect(mock.calls).toEqual([]);

		}));

		it("should hit at exactly ttl ms (boundary)", () => withFakeTimers(async () => {

			// `expired` uses `age > ttl` (strict), so a record at exactly ttl ms is still fresh

			const mock = MockStore();
			const store = createCachingStore(mock, { ttl: TTL });

			await store.lookup({ entry: "/a", shape, model: {} });

			vi.advanceTimersByTime(TTL);

			mock.calls.length = 0;

			await store.lookup({ entry: "/a", shape, model: {} }); // hit at boundary

			expect(mock.calls).toEqual([]);

		}));

		it("should purge expired siblings on next miss", () => withFakeTimers(async () => {

			const mock = MockStore();
			const store = createCachingStore(mock, { ttl: TTL });

			await store.lookup({ entry: "/a", shape, model: {} });
			await store.lookup({ entry: "/b", shape, model: {} });

			vi.advanceTimersByTime(EXPIRED);

			// a miss on /c purges expired /a and /b
			await store.lookup({ entry: "/c", shape, model: {} });

			mock.calls.length = 0;

			await store.lookup({ entry: "/a", shape, model: {} }); // miss (purged)
			await store.lookup({ entry: "/b", shape, model: {} }); // miss (purged)

			expect(mock.calls).toEqual(["lookup", "lookup"]);

		}));

		it("should not expire entries when ttl is 0 (default)", () => withFakeTimers(async () => {

			const mock = MockStore();
			const store = createCachingStore(mock);

			await store.lookup({ entry: "/a", shape, model: {} });

			vi.advanceTimersByTime(FOREVER);

			mock.calls.length = 0;

			await store.lookup({ entry: "/a", shape, model: {} }); // still cached

			expect(mock.calls).toEqual([]);

		}));

	});

});
