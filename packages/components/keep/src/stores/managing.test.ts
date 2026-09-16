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

import { number } from "@metreeca/blue/number";
import { id, required, resource } from "@metreeca/blue/resource";
import { string } from "@metreeca/blue/string";
import { describe, expect, it, vi } from "vitest";
import type { StoreClient, StoreObserver } from "../index.js";
import { createManagingStore } from "./managing.js";


const shape = resource({
	id: id(),
	name: required(string()),
	price: required(number())
});

const entry = "http://example.com/products/1";
const entryA = "http://example.com/a";
const entryB = "http://example.com/b";

const fullModel = { id: "", name: "", price: 0 };
const fullState = { name: "Widget", price: 1 };


// Localised cast: vi.fn cannot preserve Store["lookup"]'s `<T extends Template>`
// generic, so the type narrows once here instead of at every call site.
function retrieveStub(impl: (specs: { entry: string }) => unknown): StoreClient["lookup"] {
	return vi.fn(async specs => impl(specs)) as unknown as StoreClient["lookup"];
}

function stubStore(overrides: Partial<StoreClient> = {}): StoreClient {
	return {
		lookup: retrieveStub(({ entry: e }) => ({ id: e, name: "n", price: 1 })),
		create: vi.fn(async ({ entry: e }) => e),
		update: vi.fn(async ({ entry: e }) => e),
		delete: vi.fn(async ({ entry: e }) => e),
		insert: vi.fn(async ({ entry: e }) => e),
		remove: vi.fn(async ({ entry: e }) => e),
		...overrides
	};
}


describe("createManagingStore", () => {

	describe("delegation", () => {

		it("should forward lookup to the inner store", async () => {
			const inner = stubStore();
			const store = createManagingStore(inner);
			await store.lookup({ entry, shape, model: fullModel });
			expect(inner.lookup).toHaveBeenCalledWith({ entry, shape, model: fullModel }, undefined);
		});

		it("should forward each mutation to the inner store", async () => {
			const inner = stubStore();
			const store = createManagingStore(inner);
			await store.create({ entry, shape, state: fullState });
			await store.update({ entry, shape, state: fullState });
			await store.delete({ entry, shape });
			await store.insert({ entry, shape, state: fullState });
			await store.remove({ entry, shape });
			expect(inner.create).toHaveBeenCalledTimes(1);
			expect(inner.update).toHaveBeenCalledTimes(1);
			expect(inner.delete).toHaveBeenCalledTimes(1);
			expect(inner.insert).toHaveBeenCalledTimes(1);
			expect(inner.remove).toHaveBeenCalledTimes(1);
		});

	});

	describe("notifications", () => {

		it("should not notify on lookup", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			store.observe(observer);
			await store.lookup({ entry, shape, model: fullModel });
			expect(observer).not.toHaveBeenCalled();
		});

		it("should notify with upsert flag on create/update/insert", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			store.observe(observer);
			await store.create({ entry, shape, state: fullState });
			await store.update({ entry, shape, state: fullState });
			await store.insert({ entry, shape, state: fullState });
			expect(observer).toHaveBeenCalledTimes(3);
			expect(observer).toHaveBeenCalledWith({ [entry]: true });
		});

		it("should notify with removal flag on delete/remove", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			store.observe(observer);
			await store.delete({ entry, shape });
			await store.remove({ entry, shape });
			expect(observer).toHaveBeenCalledTimes(2);
			expect(observer).toHaveBeenCalledWith({ [entry]: false });
		});

		// the conditional mutators resolve to undefined when the precondition fails (create on an existing
		// resource, update/delete on a missing one); an undefined result records no mutation and fires no event

		const conditional: ReadonlyArray<readonly [string, (store: StoreClient) => Promise<unknown>]> = [
			["create", store => store.create({ entry, shape, state: fullState })],
			["update", store => store.update({ entry, shape, state: fullState })],
			["delete", store => store.delete({ entry, shape })]
		];

		it.each(conditional)("should skip notification when %s resolves undefined", async (_mutator, mutate) => {
			const inner = stubStore({
				create: vi.fn(async () => undefined),
				update: vi.fn(async () => undefined),
				delete: vi.fn(async () => undefined)
			});
			const store = createManagingStore(inner);
			const observer = vi.fn<StoreObserver>();
			store.observe(observer);
			await mutate(store);
			expect(observer).not.toHaveBeenCalled();
		});

		it("should swallow async observer rejections without breaking other observers", async () => {
			const store = createManagingStore(stubStore());
			const calls: string[] = [];

			store.observe(async () => {
				calls.push("rejecting");
				throw new Error("observer failure");
			});

			store.observe(() => {
				calls.push("ok");
			});

			await store.create({ entry, shape, state: fullState });

			// let any unhandled rejection surface
			await new Promise(resolve => setTimeout(resolve, 0));

			expect(calls).toEqual(["rejecting", "ok"]);
		});

		it("should swallow synchronous observer throws without breaking other observers", async () => {
			const store = createManagingStore(stubStore());
			const calls: string[] = [];

			store.observe(() => {
				calls.push("throwing");
				throw new Error("observer failure");
			});

			store.observe(() => {
				calls.push("ok");
			});

			await store.create({ entry, shape, state: fullState });

			// let the swallowed rejection settle
			await new Promise(resolve => setTimeout(resolve, 0));

			expect(calls).toEqual(["throwing", "ok"]);
		});

		it("should filter mutations to descendants of watched resources", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			store.observe(observer, "http://example.com/products/");

			await store.create({ entry, shape, state: fullState });
			await store.create({ entry: "http://example.com/vendors/acme", shape, state: fullState });

			expect(observer).toHaveBeenCalledTimes(1);
			expect(observer).toHaveBeenCalledWith({ [entry]: true });
		});

		it("should treat each observe call as an independent registration", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			store.observe(observer, "http://example.com/products/");
			store.observe(observer, "http://example.com/vendors/");

			await store.create({ entry, shape, state: fullState });
			await store.create({ entry: "http://example.com/vendors/acme", shape, state: fullState });

			expect(observer).toHaveBeenCalledTimes(2);
			expect(observer).toHaveBeenNthCalledWith(1, { [entry]: true });
			expect(observer).toHaveBeenNthCalledWith(2, { "http://example.com/vendors/acme": true });
		});

		it("should detach only the registration of the invoked unsubscribe handle", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			const unsub1 = store.observe(observer, "http://example.com/products/");
			store.observe(observer, "http://example.com/vendors/");
			unsub1();

			await store.create({ entry, shape, state: fullState });
			await store.create({ entry: "http://example.com/vendors/acme", shape, state: fullState });

			expect(observer).toHaveBeenCalledTimes(1);
			expect(observer).toHaveBeenCalledWith({ "http://example.com/vendors/acme": true });
		});

		it("should be safe to invoke an unsubscribe handle twice", () => {
			const store = createManagingStore(stubStore());
			const unsub = store.observe(vi.fn<StoreObserver>());
			unsub();
			expect(() => unsub()).not.toThrow();
		});

		it("should fire nothing for a registration with an empty resources array", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			store.observe(observer, []);

			await store.create({ entry, shape, state: fullState });

			expect(observer).not.toHaveBeenCalled();
		});

		it("should detach the registration when the unsubscribe handle is invoked", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			const unsubscribe = store.observe(observer);
			unsubscribe();

			await store.create({ entry, shape, state: fullState });

			expect(observer).not.toHaveBeenCalled();
		});

	});


	describe("observe delegation", () => {

		it("should forward the observe call to the supplied management.observe", () => {
			const innerObserve = vi.fn(() => () => {});
			const store = createManagingStore(stubStore(), { observe: innerObserve });
			const observer = vi.fn<StoreObserver>();
			const resources = "http://example.com/products/";
			store.observe(observer, resources);
			expect(innerObserve).toHaveBeenCalledWith(observer, [resources]);
		});

		it("should forward a normalised filter, leaving single-pass iterables intact for the delegate", () => {
			const innerObserve = vi.fn(() => () => {});
			const store = createManagingStore(stubStore(), { observe: innerObserve });
			const observer = vi.fn<StoreObserver>();
			const resources = new Set(["http://example.com/products/", "http://example.com/vendors/"]);
			store.observe(observer, resources.values());
			expect(innerObserve).toHaveBeenCalledWith(observer, [...resources]);
		});

		it("should also call the inner unsubscribe when the wrapper's unsubscribe is invoked", () => {
			const innerUnsubscribe = vi.fn();
			const innerObserve = vi.fn(() => innerUnsubscribe);
			const store = createManagingStore(stubStore(), { observe: innerObserve });
			const unsubscribe = store.observe(vi.fn<StoreObserver>());
			unsubscribe();
			expect(innerUnsubscribe).toHaveBeenCalledOnce();
		});

	});

	describe("execute", () => {

		it("should pass a Store wrapper to the task and batch its mutations into one event", async () => {
			const inner = stubStore();
			const store = createManagingStore(inner);
			const observer = vi.fn<StoreObserver>();
			store.observe(observer);

			await store.execute(async s => {
				await s.create({ entry: entryA, shape, state: fullState });
				await s.update({ entry: entryB, shape, state: fullState });
			});

			expect(observer).toHaveBeenCalledOnce();
			expect(observer).toHaveBeenCalledWith({
				[entryA]: true,
				[entryB]: true
			});
		});

		it("should not notify observer during task execution", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			store.observe(observer);

			await store.execute(async s => {
				await s.create({ entry: entryA, shape, state: fullState });
				expect(observer).not.toHaveBeenCalled();
				await s.update({ entry: entryB, shape, state: fullState });
				expect(observer).not.toHaveBeenCalled();
			});

			expect(observer).toHaveBeenCalledOnce();
		});

		it("should discard pending events if the task throws", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			store.observe(observer);

			await expect(store.execute(async s => {
				await s.create({ entry, shape, state: fullState });
				throw new Error("boom");
			})).rejects.toThrow("boom");

			expect(observer).not.toHaveBeenCalled();
		});

		it("should isolate concurrent top-level execute calls", async () => {
			const store = createManagingStore(stubStore());
			const batches: Record<string, boolean>[] = [];
			store.observe(m => { batches.push(m); });

			let releaseFirst!: () => void;
			const firstBlocker = new Promise<void>(resolve => { releaseFirst = resolve; });

			const first = store.execute(async s => {
				await s.create({ entry: entryA, shape, state: fullState });
				await firstBlocker;
			});

			const second = store.execute(async s => {
				await s.create({ entry: entryB, shape, state: fullState });
			});

			await second;

			expect(batches).toHaveLength(1);
			expect(batches[0]).toEqual({ [entryB]: true });

			releaseFirst();
			await first;

			expect(batches).toHaveLength(2);
			expect(batches[1]).toEqual({ [entryA]: true });
		});

		it("should apply last-write-wins for the same resource within a batched event", async () => {
			const store = createManagingStore(stubStore());
			const observer = vi.fn<StoreObserver>();
			store.observe(observer);

			await store.execute(async s => {
				await s.create({ entry, shape, state: fullState });
				await s.delete({ entry, shape });
			});

			expect(observer).toHaveBeenCalledOnce();
			expect(observer).toHaveBeenCalledWith({ [entry]: false });
		});

	});

	describe("error propagation", () => {

		it("should convert a sync throw from the inner store into a rejection on lookup", async () => {
			const inner = stubStore({
				lookup: (() => { throw new Error("sync"); }) as unknown as StoreClient["lookup"]
			});
			const store = createManagingStore(inner);

			const result = store.lookup({ entry, shape, model: fullModel });
			expect(result).toBeInstanceOf(Promise);
			await expect(result).rejects.toBeInstanceOf(Error);
		});

		it("should convert a sync throw from the inner store into a rejection on mutation", async () => {
			const inner = stubStore({
				create: (() => { throw new Error("sync"); }) as unknown as StoreClient["create"]
			});
			const store = createManagingStore(inner);

			const result = store.create({ entry, shape, state: fullState });
			expect(result).toBeInstanceOf(Promise);
			await expect(result).rejects.toBeInstanceOf(Error);
		});

	});

	describe("close", () => {

		it("should delegate to the supplied close callback", async () => {
			const close = vi.fn(async () => {});
			const store = createManagingStore(stubStore(), { close });
			await store.close();
			expect(close).toHaveBeenCalledOnce();
		});

		it("should resolve to a no-op when close is omitted", async () => {
			const store = createManagingStore(stubStore());
			await expect(store.close()).resolves.toBeUndefined();
		});

	});

	describe("transactional execute opt", () => {

		function executeSpy(inner: StoreClient) {
			const calls: number[] = [];
			const fn = <V>(task: (scope: StoreClient) => V | Promise<V>): Promise<V> => {
				calls.push(calls.length+1);
				return Promise.resolve(task(inner)) as Promise<V>;
			};
			return Object.assign(fn, { calls });
		}

		function rejectingExecute(message: string) {
			return <V>(_task: (scope: StoreClient) => V | Promise<V>): Promise<V> => Promise.reject(new Error(message));
		}

		it("should wrap each standalone lookup in the supplied execute opt", async () => {
			const inner = stubStore();
			const execute = executeSpy(inner);
			const store = createManagingStore(inner, { execute });
			await store.lookup({ entry, shape, model: fullModel });
			expect(execute.calls).toHaveLength(1);
		});

		it("should wrap each standalone mutation in the supplied execute opt", async () => {
			const inner = stubStore();
			const execute = executeSpy(inner);
			const store = createManagingStore(inner, { execute });
			await store.create({ entry, shape, state: fullState });
			await store.update({ entry, shape, state: fullState });
			await store.delete({ entry, shape });
			await store.insert({ entry, shape, state: fullState });
			await store.remove({ entry, shape });
			expect(execute.calls).toHaveLength(5);
		});

		it("should wrap the entire task in the supplied execute opt and not re-wrap inner calls", async () => {
			const inner = stubStore();
			const execute = executeSpy(inner);
			const store = createManagingStore(inner, { execute });

			await store.execute(async s => {
				await s.create({ entry: entryA, shape, state: fullState });
				await s.update({ entry: entryB, shape, state: fullState });
			});

			expect(execute.calls).toHaveLength(1);
		});

		it("should propagate execute opt rejection (rollback semantics)", async () => {
			const store = createManagingStore(stubStore(), { execute: rejectingExecute("rollback") });

			await expect(store.create({ entry, shape, state: fullState })).rejects.toThrow("rollback");
		});

		it("should propagate execute opt rejection from a task (atomic rollback across calls)", async () => {
			const store = createManagingStore(stubStore(), { execute: rejectingExecute("rollback") });
			const observer = vi.fn<StoreObserver>();
			store.observe(observer);

			await expect(store.execute(async s => {
				await s.create({ entry, shape, state: fullState });
			})).rejects.toThrow("rollback");

			expect(observer).not.toHaveBeenCalled();
		});

	});

});
