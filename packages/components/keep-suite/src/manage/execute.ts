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

import type { State } from "@metreeca/blue/value";
import type { Store, StoreClient } from "@metreeca/keep";
import { describe, expect, it } from "vitest";
import { collect, type TestFactory } from "../index.core.js";
import { collections, created, testProduct } from "../toys.core.js";
import { Product } from "../toys.js";


const { products } = collections;

// retrieval model projecting only the price slot, shared by transactional visibility probes
const priceModel = { price: {} };


/**
 * Atomicity conformance tests for {@link Store.execute}.
 *
 * These tests assert all-or-nothing commit: a transaction commits its writes only once the task resolves and discards
 * them on failure, regardless of the backend's isolation level. The batched mutation event (one event per committed
 * transaction, none on rollback) is part of the same contract and is covered under `notifications`. Atomicity is
 * best-effort: a connector applying mutations eagerly, with no rollback, ignores `"ManageExecuteAtomicity"`.
 */
export function testManageExecuteAtomicity(factory: TestFactory<Store>): void {

	describe("execute atomicity", () => {

		it("should resolve to the value returned by the task", factory(async ({ store }) => {

			const result = await store.execute(async () => 42);

			expect(result).toBe(42);

		}));

		it("should commit write operations on successful completion", factory(async ({ store }) => {

			const state = testProduct("TXN-001", "Transaction Test Product");

			await store.execute(async (s) => {
				await created(s, { entry: state.id, shape: Product, state });
			});

			const retrieved = await store.lookup({ shape: Product, entry: state.id, model: priceModel });

			expect(retrieved).toBeDefined();

		}));

		it.each([
			["sync", "TXN-002", "rollback"],
			["async", "TXN-004", "rejected"]
		] as const)("should roll back write operations if the task fails (%s)", (mode, sku, message) => factory(async ({ store }) => {

			// task termination via either sync throw or returned Promise.reject must roll back the buffered
			// create and surface the originating error as a promise rejection on execute()

			const state = testProduct(sku, "Rollback Test Product");

			await expect(store.execute(async (s) => {
				await created(s, { entry: state.id, shape: Product, state });
				if ( mode === "sync" ) {
					throw new Error(message);
				} else {
					return Promise.reject(new Error(message));
				}
			})).rejects.toThrow(message);

			const retrieved = await store.lookup({ shape: Product, entry: state.id, model: priceModel });

			expect(retrieved).toBeUndefined();

		})());

		it("should roll back mixed operations atomically on failure", factory(async ({ store, generate }) => {

			const existing = await generate(products[0], Product);
			const originalPrice = existing.price;

			const updateState = {
				...existing,
				price: 0.01
			};

			const newState = testProduct("TXN-008", "Mixed Rollback Product");

			await expect(store.execute(async (s) => {
				await s.update({ entry: updateState.id, shape: Product, state: updateState });
				await created(s, { entry: newState.id, shape: Product, state: newState });
				throw new Error("mixed rollback");
			})).rejects.toThrow("mixed rollback");

			// update should be rolled back

			const retrieved = await store.lookup({ shape: Product, entry: existing.id, model: priceModel });

			expect(retrieved?.price).toBe(originalPrice);

			// create should be rolled back

			const newRetrieved = await store.lookup({ shape: Product, entry: newState.id, model: priceModel });

			expect(newRetrieved).toBeUndefined();

		}));


		describe("notifications", () => {

			it("should not notify observers during the transaction", factory(async ({ store }) => {

				const { changes } = collect(store);

				const state = testProduct("TXN-OBS-001", "Mid-Txn Notification Check");

				await store.execute(async (s) => {

					await created(s, { entry: state.id, shape: Product, state });

					// observer must not have been called yet

					expect(changes).toHaveLength(0);

				});

			}));

			it("should notify observers once at commit time with batched changes", factory(async ({
				store,
				generate
			}) => {

				const { changes } = collect(store);

				const fresh = testProduct("TXN-OBS-002", "Batched Create");
				const existing = await generate(products[0], Product);

				await store.execute(async (s) => {

					await created(s, { entry: fresh.id, shape: Product, state: fresh });
					await s.update({
						entry: existing.id,
						shape: Product,
						state: { ...existing, price: 0.01 }
					});

				});

				// single batch with both changes

				expect(changes).toHaveLength(1);

				expect(changes[0]).toEqual({
					[fresh.id]: true,
					[existing.id]: true
				});

			}));

			it("should not notify observers if transaction rolls back", factory(async ({ store }) => {

				const { changes } = collect(store);

				const state = testProduct("TXN-OBS-003", "Rollback No Notify");

				await expect(store.execute(async (s) => {
					await created(s, { entry: state.id, shape: Product, state });
					throw new Error("rollback");
				})).rejects.toThrow("rollback");

				expect(changes).toHaveLength(0);

			}));

			it("should batch create and delete into a single notification", factory(async ({ store, generate }) => {

				const { changes } = collect(store);

				const fresh = testProduct("TXN-OBS-004", "Batch Mixed");
				const existing = await generate(products[0], Product);

				await store.execute(async (s) => {

					await created(s, { entry: fresh.id, shape: Product, state: fresh });
					await s.delete({ entry: existing.id, shape: Product });

				});

				expect(changes).toHaveLength(1);

				expect(changes[0]).toEqual({
					[fresh.id]: true,
					[existing.id]: false
				});

			}));

			it("should report last mutation status when same resource is mutated multiple times", factory(async ({
				store,
				generate
			}) => {

				const { changes } = collect(store);

				const existing = await generate(products[0], Product);

				await store.execute(async (s) => {

					await s.update({
						entry: existing.id,
						shape: Product,
						state: { ...existing, price: 0.01 }
					});
					await s.update({
						entry: existing.id,
						shape: Product,
						state: { ...existing, price: 0.02 }
					});

				});

				// single batch with last-write-wins semantics

				expect(changes).toHaveLength(1);

				expect(changes[0]).toEqual({
					[existing.id]: true
				});

			}));

			it("should respect resource filtering for batched notifications", factory(async ({ store, generate }) => {

				const existing = await generate(products[0], Product);

				const { changes: filtered } = collect(store, existing.id);
				const { changes: global } = collect(store);

				const unrelated = testProduct("TXN-OBS-005", "Filtered Out");

				await store.execute(async (s) => {

					await s.update({
						entry: existing.id,
						shape: Product,
						state: { ...existing, price: 0.01 }
					});
					await created(s, { entry: unrelated.id, shape: Product, state: unrelated });

				});

				// global observer sees entire batch

				expect(global).toHaveLength(1);

				expect(global[0]).toEqual({
					[existing.id]: true,
					[unrelated.id]: true
				});

				// filtered observer sees only matching subset

				expect(filtered).toHaveLength(1);

				expect(filtered[0]).toEqual({
					[existing.id]: true
				});

			}));

			([
				["a synchronous throw", "TXN-OBS-006",
					(): void => { throw new Error("observer failure"); }],
				["an async rejection", "TXN-OBS-007",
					(): Promise<void> => Promise.reject(new Error("observer failure"))]
			] as const).forEach(([kind, code, faulty]) => {

				it(`should ignore ${kind} from an observer during notification`, factory(async ({ store }) => {

					// the StoreObserver contract catches and ignores both synchronous throws and asynchronous
					// rejections, so one faulty observer cannot break batch delivery to the healthy collector

					store.observe(faulty);

					const { changes } = collect(store);

					const state = testProduct(code, "Observer Failure Ignored");

					await store.execute(async (s) => {
						await created(s, { entry: state.id, shape: Product, state });
					});

					expect(changes).toContainEqual({ [state.id]: true });

				}));

			});

		});

	});

}

/**
 * Transaction-isolation conformance tests for {@link Store.execute}.
 *
 * These tests assume the suggested **SNAPSHOT** level and assert its read-visibility semantics: reads taken through
 * the client handed to the task observe the transaction's start snapshot. The transaction's own uncommitted writes
 * stay invisible until commit, and concurrent transactions do not see each other's pending writes. A connector
 * providing a weaker level ignores `"ManageExecuteIsolation"`, independently of `"ManageExecuteAtomicity"`.
 */
export function testManageExecuteIsolation(factory: TestFactory<Store>): void {

	describe("execute isolation", () => {

		it("should not observe an own buffered create within the transaction", factory(async ({ store }) => {

			// the buffered create must not be visible to lookup() calls made through the same per-call Store:
			// callers observe the pre-transaction snapshot, in which the resource does not yet exist

			const state = testProduct("TXN-003", "Invisible Create Product");

			await store.execute(async (s) => {

				await created(s, { entry: state.id, shape: Product, state });

				const retrieved = await s.lookup({ shape: Product, entry: state.id, model: priceModel });

				expect(retrieved).toBeUndefined();

			});

		}));

		it.each([
			["update", (s: StoreClient, e: State<typeof Product>) => s.update({
				entry: e.id,
				shape: Product,
				state: { ...e, price: 0.01 }
			})],
			["insert", (s: StoreClient, e: State<typeof Product>) => s.insert({
				entry: e.id,
				shape: Product,
				state: { ...e, price: 0.02 }
			})],
			["delete", (s: StoreClient, e: State<typeof Product>) => s.delete({ entry: e.id, shape: Product })]
		] as const)("should not observe an own buffered %s within the transaction", (_op, mutate) => factory(async ({
			store,
			generate
		}) => {

			// a mutation buffered inside execute() must not be visible to lookup() calls made through the same
			// per-call Store: the read observes the pre-transaction snapshot, so the resource keeps its original
			// price (and stays present for a buffered delete) until commit

			const existing = await generate(products[0], Product);

			await store.execute(async (s) => {

				await mutate(s, existing);

				const retrieved = await s.lookup({ shape: Product, entry: existing.id, model: priceModel });

				expect(retrieved?.price).toBe(existing.price);

			});

		})());

		it("should observe initial store state for reads", factory(async ({ store, generate }) => {

			const existing = await generate(products[0], Product);

			const result = await store.execute(async (s) => {
				return s.lookup({ shape: Product, entry: existing.id, model: priceModel });
			});

			expect(result).toBeDefined();

		}));


		describe("concurrency", () => {

			// gate-coordinated concurrent execute() calls: each gate is resolved by the *other* task to enforce a
			// strict interleaving of buffered writes, so the test reliably exercises the overlapping-buffer window
			// regardless of microtask ordering on the host connector

			it.each([
				["A", "TXN-CONCUR-A"],
				["B", "TXN-CONCUR-B"]
			] as const)("should isolate a succeeding transaction from a concurrent one when %s fails", (failer, sku) => factory(async ({ store }) => {

				const stateA = testProduct(`${sku}-A`, "Concurrent Tx A");
				const stateB = testProduct(`${sku}-B`, "Concurrent Tx B");

				let bEntered: () => void;
				const bEnters = new Promise<void>(resolve => { bEntered = resolve; });

				// A is held open until B has buffered its write, so the failing side's rollback (whichever it is)
				// overlaps with the other side's pending buffer and the isolation contract is exercised

				let aMayFinish: () => void;
				const aWaits = new Promise<void>(resolve => { aMayFinish = resolve; });

				const a = store.execute(async (s) => {
					await created(s, { entry: stateA.id, shape: Product, state: stateA });
					bEntered();         // hand off to B
					await aWaits;        // hold A open until B has buffered its write
					if ( failer === "A" ) {
						throw new Error("A fails");
					}
				});

				const b = store.execute(async (s) => {
					await bEnters;       // wait until A has buffered its write
					await created(s, { entry: stateB.id, shape: Product, state: stateB });
					aMayFinish();       // release A so it can throw or commit
					if ( failer === "B" ) {
						throw new Error("B fails");
					}
				});

				const [aResult, bResult] = await Promise.allSettled([a, b]);

				expect(aResult.status).toBe(failer === "A" ? "rejected" : "fulfilled");
				expect(bResult.status).toBe(failer === "B" ? "rejected" : "fulfilled");

				// the succeeding side's write must be visible; the failing side's must be rolled back

				const retrievedA = await store.lookup({ entry: stateA.id, shape: Product, model: priceModel });
				const retrievedB = await store.lookup({ entry: stateB.id, shape: Product, model: priceModel });

				if ( failer === "A" ) {
					expect(retrievedA).toBeUndefined();
					expect(retrievedB).toBeDefined();
				} else {
					expect(retrievedA).toBeDefined();
					expect(retrievedB).toBeUndefined();
				}

			})());

			it("should commit both writes when concurrent transactions both succeed", factory(async ({ store }) => {

				// the failure cases above exercise rollback against a concurrent buffer; this is the
				// happy path — two strictly interleaved transactions, neither failing, must BOTH commit
				// without either clobbering the other's pending write

				const stateA = testProduct("TXN-CONCUR-OK-A", "Concurrent Tx OK A");
				const stateB = testProduct("TXN-CONCUR-OK-B", "Concurrent Tx OK B");

				let bEntered: () => void;
				const bEnters = new Promise<void>(resolve => { bEntered = resolve; });

				let aMayFinish: () => void;
				const aWaits = new Promise<void>(resolve => { aMayFinish = resolve; });

				const a = store.execute(async (s) => {
					await created(s, { entry: stateA.id, shape: Product, state: stateA });
					bEntered();         // hand off to B
					await aWaits;        // hold A open until B has buffered its write
				});

				const b = store.execute(async (s) => {
					await bEnters;       // wait until A has buffered its write
					await created(s, { entry: stateB.id, shape: Product, state: stateB });
					aMayFinish();       // release A so it can commit
				});

				await Promise.all([a, b]);

				// both committed writes must be visible

				expect(await store.lookup({ entry: stateA.id, shape: Product, model: priceModel })).toBeDefined();
				expect(await store.lookup({ entry: stateB.id, shape: Product, model: priceModel })).toBeDefined();

			}));

		});

	});

}
