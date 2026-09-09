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

import { reference } from "@metreeca/blue/reference";
import { type Property, resource, type ResourceShape } from "@metreeca/blue/resource";
import { eager, optional } from "@metreeca/blue/value";
import type { Lazy } from "@metreeca/core";
import type { Reference } from "@metreeca/qest/resource";
import type { Query, Template } from "@metreeca/qest/template";
import { describe, expect, it } from "vitest";
import { createBroker } from "./batching.core.js";
import { type Broker, createBatchingStore, type Detect, type Lookup, type Modify, type Select } from "./batching.js";


declare const process: {
	on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
	off(event: "unhandledRejection", listener: (reason: unknown) => void): void;
};


describe("createBatchingStore", () => {

	const shape: Lazy<ResourceShape> = () => ({ kind: "resource", model: {}, entries: {} });
	const virtualShape: Lazy<ResourceShape> = () => ({ kind: "resource", model: {}, entries: {}, virtual: true });

	const entry: Reference = "http://example.com/r";

	// backs the store with stub handlers: `detect` reports the listed entries as present, `lookup`
	// resolves a fixed instance, and `modify` resolves to the target entry. `detected`, `looked`, and
	// `modified` capture what reached each handler so tests can assert the conditional routing.

	function batchedStore(present: readonly Reference[] = []) {

		const detected: Reference[] = [];
		const looked: Lookup[] = [];
		const modified: Modify[] = [];
		const instance = {};

		const store = createBatchingStore({
			async detect(batch, _) {
				batch.forEach(d => {
					detected.push(d.request.entry);
					d.resolve(present.includes(d.request.entry));
				});
			},
			async lookup(batch, _) {
				batch.forEach(d => {
					looked.push(d.request);
					d.resolve(instance);
				});
			},
			async select() {},
			async modify(batch, _) {
				batch.forEach(d => {
					modified.push(d.request);
					d.resolve(d.request.entry);
				});
			}
		});

		return { store, detected, looked, modified, instance };

	}

	describe("lookup", () => {

		it("returns the looked-up instance for a present resource", async () => {

			const { store, looked, instance } = batchedStore([entry]);

			const result = await store.lookup({ entry, shape, model: {} });

			expect(result).toBe(instance);
			expect(looked).toHaveLength(1);

		});

		it("returns undefined for an absent resource without looking it up", async () => {

			const { store, looked } = batchedStore([]);

			const result = await store.lookup({ entry, shape, model: {} });

			expect(result).toBeUndefined();
			expect(looked).toEqual([]);

		});

		it("skips the existence probe for a virtual shape", async () => {

			// the entry is absent, yet a virtual shape is looked up regardless of stored state

			const { store, looked, instance } = batchedStore([]);

			const result = await store.lookup({ entry, shape: virtualShape, model: {} });

			expect(result).toBe(instance);
			expect(looked).toHaveLength(1);

		});

		it("defaults the locale to und when none is supplied", async () => {

			const { store, looked } = batchedStore([entry]);

			await store.lookup({ entry, shape, model: {} });

			expect(looked[0].locale).toEqual(["und"]);

		});

		it("forwards an explicitly supplied locale", async () => {

			const { store, looked } = batchedStore([entry]);

			await store.lookup({ entry, shape, model: {} }, { locale: ["en", "und"] });

			expect(looked[0].locale).toEqual(["en", "und"]);

		});

	});

	describe("create", () => {

		it("mutates an absent resource and resolves to its entry", async () => {

			const { store, modified } = batchedStore([]);

			const result = await store.create({ entry, shape, state: { label: "x" } });

			expect(result).toBe(entry);
			expect(modified).toHaveLength(1);
			expect(modified[0].state).toEqual({ label: "x" });

		});

		it("returns undefined for an existing resource without mutating", async () => {

			const { store, modified } = batchedStore([entry]);

			const result = await store.create({ entry, shape, state: { label: "x" } });

			expect(result).toBeUndefined();
			expect(modified).toEqual([]);

		});

		it("accepts a state whose id matches the entry", async () => {

			const { store } = batchedStore([]);

			const result = await store.create({ entry, shape, state: { id: entry } });

			expect(result).toBe(entry);

		});

		it("rejects a state whose id contradicts the entry", async () => {

			const { store } = batchedStore([]);

			await expect(store.create({ entry, shape, state: { id: "http://example.com/other" } }))
				.rejects.toThrow(RangeError);

		});

	});

	describe("update", () => {

		it("mutates an existing resource and resolves to its entry", async () => {

			const { store, modified } = batchedStore([entry]);

			const result = await store.update({ entry, shape, state: { label: "x" } });

			expect(result).toBe(entry);
			expect(modified[0].state).toEqual({ label: "x" });

		});

		it("returns undefined for an absent resource without mutating", async () => {

			const { store, modified } = batchedStore([]);

			const result = await store.update({ entry, shape, state: { label: "x" } });

			expect(result).toBeUndefined();
			expect(modified).toEqual([]);

		});

		it("accepts a state whose id matches the entry", async () => {

			const { store } = batchedStore([entry]);

			const result = await store.update({ entry, shape, state: { id: entry } });

			expect(result).toBe(entry);

		});

		it("rejects a state whose id contradicts the entry", async () => {

			const { store } = batchedStore([entry]);

			await expect(store.update({ entry, shape, state: { id: "http://example.com/other" } }))
				.rejects.toThrow(RangeError);

		});

	});

	describe("delete", () => {

		it("mutates an existing resource with no state and resolves to its entry", async () => {

			const { store, modified } = batchedStore([entry]);

			const result = await store.delete({ entry, shape });

			expect(result).toBe(entry);
			expect(modified).toHaveLength(1);
			expect(modified[0].state).toBeUndefined();

		});

		it("returns undefined for an absent resource without mutating", async () => {

			const { store, modified } = batchedStore([]);

			const result = await store.delete({ entry, shape });

			expect(result).toBeUndefined();
			expect(modified).toEqual([]);

		});

	});

	describe("insert", () => {

		it("mutates unconditionally even when the resource already exists", async () => {

			// create would probe existence and no-op on an existing entry; insert bypasses the probe
			// and mutates regardless

			const { store, detected, modified } = batchedStore([entry]);

			const result = await store.insert({ entry, shape, state: { label: "x" } });

			expect(result).toBe(entry);
			expect(detected).toEqual([]);
			expect(modified).toHaveLength(1);
			expect(modified[0].state).toEqual({ label: "x" });

		});

	});

	describe("remove", () => {

		it("mutates unconditionally with no state even when the resource is absent", async () => {

			// delete would probe existence and no-op on an absent entry; remove bypasses the probe and
			// mutates regardless

			const { store, detected, modified } = batchedStore([]);

			const result = await store.remove({ entry, shape });

			expect(result).toBe(entry);
			expect(detected).toEqual([]);
			expect(modified).toHaveLength(1);
			expect(modified[0].state).toBeUndefined();

		});

	});

});

describe("createBroker", () => {

	// minimal self-referential shape: createBroker is shape-agnostic, so any resource carrying a
	// single property suffices to populate the request payloads.

	function Node() {
		return resource({
			broader: optional(reference(Node))
		});
	}

	const shape: Lazy<ResourceShape> = Node;

	const broaderEntry = eager(Node).entries["broader"];
	if ( broaderEntry.kind !== "property" ) {
		throw new Error("expected <broader> to be a property entry");
	}
	const property: Property = broaderEntry;

	const resourceModel: Template = {};
	const collectionModel: Query = ["http://example.com/element"];


	function lookupRequest(overrides?: Partial<Lookup>): Lookup {
		return {
			entry: "http://example.com/r",
			shape,
			model: resourceModel,
			locale: ["und"],
			...overrides
		};
	}

	function selectRequest(overrides?: Partial<Select>): Select {
		return {
			entry: "http://example.com/r",
			shape,
			field: property,
			query: collectionModel,
			locale: ["und"],
			...overrides
		};
	}

	function detectRequest(overrides?: Partial<Detect>): Detect {
		return {
			entry: "http://example.com/r",
			...overrides
		};
	}

	function modifyRequest(overrides?: Partial<Modify>): Modify {
		return {
			entry: "http://example.com/r",
			shape,
			...overrides
		};
	}

	// Flush the loader to quiescence: a macrotask runs only after the detached drain's whole
	// microtask chain has settled (or blocked on an external promise), so assertions observe the
	// final state regardless of how many microtask rounds the drain took.

	async function flush(): Promise<void> {
		await new Promise<void>(resolve => setTimeout(resolve));
	}


	describe("detect handler", () => {

		it("resolves a present entry to true via the handler", async () => {

			const loader = createBroker({
				async lookup() {},
				async select() {},
				async modify() {},
				async detect(batch, _) { batch.forEach(d => d.resolve(true)); }
			});

			const result = await loader.detect(detectRequest());

			expect(result).toBe(true);

		});

		it("resolves an absent entry to false via the handler", async () => {

			const loader = createBroker({
				async lookup() {},
				async select() {},
				async modify() {},
				async detect(batch, _) { batch.forEach(d => d.resolve(false)); }
			});

			const result = await loader.detect(detectRequest());

			expect(result).toBe(false);

		});

	});

	describe("lookup handler", () => {

		it("resolves a single resource request via the handler", async () => {

			const expected = {};

			const loader = createBroker({
				async lookup(batch, _) { batch.forEach(d => d.resolve(expected)); },
				async select() {},
				async modify() {},
				async detect() {}
			});

			const result = await loader.lookup(lookupRequest());

			expect(result).toBe(expected);

		});

		it("rejects when the handler rejects the deferred", async () => {

			const error = new Error("boom");

			const loader = createBroker({
				async lookup(batch, _) { batch.forEach(d => d.reject(error)); },
				async select() {},
				async modify() {},
				async detect() {}
			});

			await expect(loader.lookup(lookupRequest())).rejects.toBe(error);

		});

	});

	describe("select handler", () => {

		it("resolves a single collection request via the handler", async () => {

			const expected: readonly string[] = [];

			const loader = createBroker({
				async lookup() {},
				async select(batch, _) { batch.forEach(d => d.resolve(expected)); },
				async modify() {},
				async detect() {}
			});

			const result = await loader.select(selectRequest());

			expect(result).toBe(expected);

		});

	});

	describe("modify handler", () => {

		it("resolves a single mutation to its entry reference via the handler", async () => {

			const expected = "http://example.com/m";

			const loader = createBroker({
				async lookup() {},
				async select() {},
				async modify(batch, _) { batch.forEach(d => d.resolve(d.request.entry)); },
				async detect() {}
			});

			const result = await loader.modify(modifyRequest({ entry: expected }));

			expect(result).toBe(expected);

		});

	});

	describe("batching", () => {

		// the drain machinery is handler-agnostic: coalescing and ordering are exercised once through
		// the lookup handler and hold identically for every other handler.

		it("coalesces a synchronous burst into one handler call", async () => {

			let calls = 0;
			let batchSize = 0;

			const loader = createBroker({
				async lookup(batch, _) {
					calls++;
					batchSize = batch.length;
					batch.forEach(d => d.resolve({}));
				},
				async select() {},
				async modify() {},
				async detect() {}
			});

			await Promise.all([
				loader.lookup(lookupRequest({ entry: "http://example.com/a" })),
				loader.lookup(lookupRequest({ entry: "http://example.com/b" }))
			]);

			expect(calls).toBe(1);
			expect(batchSize).toBe(2);

		});

		it("preserves submission order within a batch", async () => {

			const captured: Reference[] = [];

			const loader = createBroker({
				async lookup(batch, _) {
					batch.forEach(d => {
						captured.push(d.request.entry);
						d.resolve({});
					});
				},
				async select() {},
				async modify() {},
				async detect() {}
			});

			await Promise.all([
				loader.lookup(lookupRequest({ entry: "http://example.com/x" })),
				loader.lookup(lookupRequest({ entry: "http://example.com/y" }))
			]);

			expect(captured).toEqual(["http://example.com/x", "http://example.com/y"]);

		});

	});

	describe("dispatch", () => {

		it("routes by request shape regardless of submission order", async () => {

			const seen: string[] = [];

			const loader = createBroker({
				async lookup(batch, _) {
					batch.forEach(d => {
						seen.push(`R[${d.request.entry}]`);
						d.resolve({});
					});
				},
				async select(batch, _) {
					batch.forEach(d => {
						seen.push(`C[${d.request.entry}]`);
						d.resolve([]);
					});
				},
				async modify() {},
				async detect() {}
			});

			await Promise.all([
				loader.select(selectRequest({ entry: "http://example.com/c" })),
				loader.lookup(lookupRequest({ entry: "http://example.com/r" }))
			]);

			expect(seen).toContain("R[http://example.com/r]");
			expect(seen).toContain("C[http://example.com/c]");

		});

		it("runs the lookup handler before the select handler in the same round", async () => {

			const seq: string[] = [];

			const loader = createBroker({
				async lookup(batch, _) {
					seq.push("R");
					batch.forEach(d => d.resolve({}));
				},
				async select(batch, _) {
					seq.push("C");
					batch.forEach(d => d.resolve([]));
				},
				async modify() {},
				async detect() {}
			});

			// submit the select request first to ensure ordering is by handler, not by submission

			await Promise.all([
				loader.select(selectRequest()),
				loader.lookup(lookupRequest())
			]);

			expect(seq).toEqual(["R", "C"]);

		});

	});

	describe("nested retrieval", () => {

		it("makes selects queued by the lookup handler visible to the same drain", async () => {

			let collectionsRan = 0;

			const loader = createBroker({
				async lookup(batch, inner) {
					inner.select(selectRequest()).catch(() => {});
					batch.forEach(d => d.resolve({}));
				},
				async select(batch, _) {
					collectionsRan++;
					batch.forEach(d => d.resolve([]));
				},
				async modify() {},
				async detect() {}
			});

			await loader.lookup(lookupRequest());
			// the nested collection is resolved within the same drain; flush to quiescence to observe it.
			await flush();

			expect(collectionsRan).toBe(1);

		});

		it("defers lookups queued by the select handler to a later round", async () => {

			const seq: string[] = [];

			const loader = createBroker({
				async lookup(batch, _) {
					seq.push(`R[${batch.map(d => d.request.entry).join(",")}]`);
					batch.forEach(d => d.resolve({}));
				},
				async select(batch, inner) {
					seq.push(`C[${batch.map(d => d.request.entry).join(",")}]`);
					inner.lookup(lookupRequest({ entry: "http://example.com/nested" })).catch(() => {});
					batch.forEach(d => d.resolve([]));
				},
				async modify() {},
				async detect() {}
			});

			await loader.select(selectRequest({ entry: "http://example.com/c" }));
			await flush();

			expect(seq).toEqual([
				"C[http://example.com/c]",
				"R[http://example.com/nested]"
			]);

		});

		it("orders nested selects before next-round lookups", async () => {

			const seq: string[] = [];
			let resourceCount = 0;
			let r2Done!: Promise<unknown>;

			const loader = createBroker({
				async lookup(batch, inner) {
					resourceCount++;
					seq.push(`R[${batch.map(d => d.request.entry).join(",")}]`);
					if ( resourceCount === 1 ) {
						inner.select(selectRequest({ entry: "http://example.com/c" })).catch(() => {});
						r2Done = inner.lookup(lookupRequest({ entry: "http://example.com/r2" }));
					}
					batch.forEach(d => d.resolve({}));
				},
				async select(batch, _) {
					seq.push(`C[${batch.map(d => d.request.entry).join(",")}]`);
					batch.forEach(d => d.resolve([]));
				},
				async modify() {},
				async detect() {}
			});

			await loader.lookup(lookupRequest({ entry: "http://example.com/r1" }));
			await r2Done;

			expect(seq).toEqual([
				"R[http://example.com/r1]",
				"C[http://example.com/c]",
				"R[http://example.com/r2]"
			]);

		});

		it("iterates until both queues are quiescent", async () => {

			let signalQuiescent!: () => void;
			const quiescent = new Promise<void>(resolve => { signalQuiescent = resolve; });
			let depth = 0;

			const loader = createBroker({
				async lookup(batch, inner) {
					depth++;
					if ( depth < 4 ) {
						inner.lookup(lookupRequest({ entry: `http://example.com/d${depth}` })).catch(() => {});
					} else {
						signalQuiescent();
					}
					batch.forEach(d => d.resolve({}));
				},
				async select() {},
				async modify() {},
				async detect() {}
			});

			await loader.lookup(lookupRequest());
			await quiescent;

			expect(depth).toBe(4);

		});

	});

	describe("error handling", () => {

		it("rejects every pending resource entry when the handler throws", async () => {

			const error = new Error("boom");

			const loader = createBroker({
				async lookup() { throw error; },
				async select() {},
				async modify() {},
				async detect() {}
			});

			const p1 = loader.lookup(lookupRequest({ entry: "http://example.com/a" }));
			const p2 = loader.lookup(lookupRequest({ entry: "http://example.com/b" }));

			await expect(p1).rejects.toBe(error);
			await expect(p2).rejects.toBe(error);

		});

		it("leaves an independent handler unpoisoned when the lookup handler throws", async () => {

			const error = new Error("boom");

			const loader = createBroker({
				async lookup() { throw error; },
				async select(batch, _) { batch.forEach(d => d.resolve([])); },
				async modify() {},
				async detect() {}
			});

			const rp = loader.lookup(lookupRequest());
			const cp = loader.select(selectRequest());

			// handlers drain concurrently: the failing lookup handler rejects its own entry, while the
			// independent select handler settles on its own rather than being cross-poisoned

			await expect(rp).rejects.toBe(error);
			await expect(cp).resolves.toEqual([]);

		});

		it("preserves already-settled deferreds when the handler throws afterwards", async () => {

			const expected = { tag: "first" };
			const error = new Error("boom");

			const loader = createBroker({
				async lookup(batch, _) {
					batch[0].resolve(expected);
					throw error;
				},
				async select() {},
				async modify() {},
				async detect() {}
			});

			const first = loader.lookup(lookupRequest({ entry: "http://example.com/a" }));
			const second = loader.lookup(lookupRequest({ entry: "http://example.com/b" }));

			await expect(first).resolves.toBe(expected);
			await expect(second).rejects.toBe(error);

		});

		it("does not leak an unhandled rejection from the drain microtask", async () => {

			const captured: unknown[] = [];
			const handler = (reason: unknown): void => { captured.push(reason); };

			process.on("unhandledRejection", handler);

			try {

				const error = new Error("boom");

				const loader = createBroker({
					async lookup() { throw error; },
					async select() {},
					async modify() {},
					async detect() {}
				});

				await expect(loader.lookup(lookupRequest())).rejects.toBe(error);
				// give the runtime two macrotasks for any deferred unhandled-rejection event
				await new Promise(resolve => setTimeout(resolve, 10));

				expect(captured).toEqual([]);

			} finally {

				process.off("unhandledRejection", handler);

			}

		});

		it("recovers after an error so subsequent retrieves drain normally", async () => {

			const error = new Error("first run boom");
			let throwOnce = true;

			const loader = createBroker({
				async lookup(batch, _) {
					if ( throwOnce ) {
						throwOnce = false;
						throw error;
					}
					batch.forEach(d => d.resolve({ ok: true }));
				},
				async select() {},
				async modify() {},
				async detect() {}
			});

			await expect(loader.lookup(lookupRequest())).rejects.toBe(error);
			await expect(loader.lookup(lookupRequest())).resolves.toEqual({ ok: true });

		});

		it("rejects entries pushed during the failing handler's await window", async () => {

			const error = new Error("boom");
			let inner: Broker | undefined;
			let release!: () => void;
			const gate = new Promise<void>(resolve => { release = resolve; });

			const loader = createBroker({
				async lookup(_, l) {
					inner = l;
					await gate;
					throw error;
				},
				async select() {},
				async modify() {},
				async detect() {}
			});

			const first = loader.lookup(lookupRequest({ entry: "http://example.com/a" }));
			// wait for the lookup handler to start
			await flush();
			const late = inner!.lookup(lookupRequest({ entry: "http://example.com/late" }));
			release();

			await expect(first).rejects.toBe(error);
			await expect(late).rejects.toBe(error);

		});

	});

	describe("idle kick", () => {

		it("kicks a fresh drain after the previous one settles quiescent", async () => {

			let calls = 0;

			const loader = createBroker({
				async lookup(batch, _) {
					calls++;
					batch.forEach(d => d.resolve({}));
				},
				async select() {},
				async modify() {},
				async detect() {}
			});

			await loader.lookup(lookupRequest({ entry: "http://example.com/a" }));
			await loader.lookup(lookupRequest({ entry: "http://example.com/b" }));

			expect(calls).toBe(2);

		});

		it("does not kick a redundant drain on nested loader.lookup", async () => {

			let calls = 0;

			const loader = createBroker({
				async lookup(batch, inner) {
					calls++;
					if ( calls === 1 ) {
						inner.lookup(lookupRequest({ entry: "http://example.com/nested" })).catch(() => {});
					}
					batch.forEach(d => d.resolve({}));
				},
				async select() {},
				async modify() {},
				async detect() {}
			});

			await loader.lookup(lookupRequest({ entry: "http://example.com/root" }));
			await flush();

			// exactly two rounds: one for the root, one for the nested entry, no extra kicks
			expect(calls).toBe(2);

		});

	});

});
