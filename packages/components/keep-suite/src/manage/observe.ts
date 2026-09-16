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

import type { Instance } from "@metreeca/blue/value";
import type { Store, StoreClient, StoreObserver } from "@metreeca/keep";
import type { Reference } from "@metreeca/qest/resource";
import { describe, expect, it } from "vitest";
import { collect, type TestFactory } from "../index.core.js";
import { collections, testProduct } from "../toys.core.js";
import { base, Product } from "../toys.js";


const { products } = collections;


export function testManageObserve(factory: TestFactory<Store>): void {

	describe("observe", () => {

		it("should return an unsubscribe function", factory(async ({ store }) => {

			const unsubscribe = store.observe(() => {});

			expect(typeof unsubscribe).toBe("function");

		}));


		describe("notifications", () => {

			it.each([
				["create of a new resource", "OBS-001", true,
					(s: StoreClient, p: ReturnType<typeof testProduct>) => s.create({
						entry: p.id,
						shape: Product,
						state: p
					})],
				["insert of a new resource", "OBS-INS-001", true,
					(s: StoreClient, p: ReturnType<typeof testProduct>) => s.insert({
						entry: p.id,
						shape: Product,
						state: p
					})],
				["remove of a non-existent resource", "OBS-GHOST-001", false,
					(s: StoreClient, p: ReturnType<typeof testProduct>) => s.remove({ entry: p.id, shape: Product })]
			] as const)("should notify on %s", (_label, sku, flag, mutate) => factory(async ({ store }) => {

				const { changes } = collect(store);

				const product = testProduct(sku, `Observed ${sku}`);

				await mutate(store, product);

				expect(changes).toContainEqual({ [product.id]: flag });

			})());

			it.each([
				["update", true,
					(s: StoreClient, e: Instance<typeof Product>) => s.update({
						entry: e.id,
						shape: Product,
						state: { ...e, price: 55.55 }
					})],
				["insert", true,
					(s: StoreClient, e: Instance<typeof Product>) => s.insert({
						entry: e.id,
						shape: Product,
						state: { ...e, price: 66.66 }
					})],
				["delete", false,
					(s: StoreClient, e: Instance<typeof Product>) => s.delete({ entry: e.id, shape: Product })],
				["remove", false,
					(s: StoreClient, e: Instance<typeof Product>) => s.remove({ entry: e.id, shape: Product })]
			] as const)("should notify on %s of an existing resource", (_op, flag, mutate) => factory(async ({
				store,
				generate
			}) => {

				const { changes } = collect(store);

				const existing = await generate(products[0], Product);

				await mutate(store, existing);

				expect(changes).toContainEqual({ [existing.id]: flag });

			})());

			it("should not notify when create finds an existing resource", factory(async ({ store, generate }) => {

				// a conditional create that resolves undefined mutates nothing, so no event fires

				const existing = await generate(products[0], Product);

				const { changes } = collect(store);

				await store.create({ entry: existing.id, shape: Product, state: existing });

				expect(changes).toHaveLength(0);

			}));

			it("should not notify when update misses the resource", factory(async ({ store }) => {

				// a conditional update that resolves undefined mutates nothing, so no event fires

				const missing = testProduct("OBS-MISS-001", "Missing Update Product");

				const { changes } = collect(store);

				await store.update({ entry: missing.id, shape: Product, state: missing });

				expect(changes).toHaveLength(0);

			}));

		});

		describe("resource filtering", () => {

			it("should notify only for a single watched resource", factory(async ({ store, generate }) => {

				const target = await generate(products[0], Product);
				const other = await generate(products[1], Product);

				const { changes } = collect(store, target.id);

				await store.update({ entry: target.id, shape: Product, state: { ...target, price: 11.11 } });
				await store.update({ entry: other.id, shape: Product, state: { ...other, price: 22.22 } });

				expect(changes).toContainEqual({ [target.id]: true });
				expect(changes).not.toContainEqual({ [other.id]: true });

			}));

			it("should notify for multiple watched resources", factory(async ({ store, generate }) => {

				const target1 = await generate(products[0], Product);
				const target2 = await generate(products[1], Product);
				const other = await generate(products[2], Product);

				const { changes } = collect(store, [target1.id, target2.id]);

				await store.update({ entry: target1.id, shape: Product, state: { ...target1, price: 1.00 } });
				await store.update({ entry: target2.id, shape: Product, state: { ...target2, price: 2.00 } });
				await store.update({ entry: other.id, shape: Product, state: { ...other, price: 3.00 } });

				expect(changes).toContainEqual({ [target1.id]: true });
				expect(changes).toContainEqual({ [target2.id]: true });
				expect(changes).not.toContainEqual({ [other.id]: true });

			}));

			it("should not notify for non-descendant resources", factory(async ({ store }) => {

				const { changes } = collect(store, `${base}vendors/`);

				await store.create({
					entry: `${base}products/OBS-NONDESC-001`,
					shape: Product,
					state: testProduct("OBS-NONDESC-001", "Non-Descendant Product", { price: 5.00 })
				});

				expect(changes).toHaveLength(0);

			}));

			it("should notify for descendant resources", factory(async ({ store }) => {

				const { changes } = collect(store, `${base}products/`);

				await store.create({
					entry: `${base}products/OBS-002`,
					shape: Product,
					state: testProduct("OBS-002", "Descendant Product", { price: 15.00, stock: 3 })
				});

				expect(changes).toContainEqual({ [`${base}products/OBS-002`]: true });

			}));

		});

		describe("multiple observers", () => {

			it("should notify all concurrent observers", factory(async ({ store }) => {

				const { changes: changes1 } = collect(store);
				const { changes: changes2 } = collect(store);

				await store.create({
					entry: `${base}products/OBS-MULTI-001`,
					shape: Product,
					state: testProduct("OBS-MULTI-001", "Multi-Observer Product")
				});

				const expected = { [`${base}products/OBS-MULTI-001`]: true };

				expect(changes1).toContainEqual(expected);
				expect(changes2).toContainEqual(expected);

			}));

			it("should not affect remaining observers when one unsubscribes", factory(async ({ store }) => {

				const { changes: changes1, unsubscribe: unsub1 } = collect(store);
				const { changes: changes2 } = collect(store);

				unsub1();

				await store.create({
					entry: `${base}products/OBS-UNSUB-001`,
					shape: Product,
					state: testProduct("OBS-UNSUB-001", "Selective Unsub Product")
				});

				expect(changes1).toHaveLength(0);
				expect(changes2).toContainEqual({ [`${base}products/OBS-UNSUB-001`]: true });

			}));

		});

		describe("registration semantics", () => {

			it("should treat each observe call as an independent registration", factory(async ({ store, generate }) => {

				const changes: Record<Reference, boolean>[] = [];

				const observer: StoreObserver = c => { changes.push(c); };

				const target1 = await generate(products[0], Product);
				const target2 = await generate(products[1], Product);

				store.observe(observer, target1.id);
				store.observe(observer, target2.id);

				await store.update({ entry: target1.id, shape: Product, state: { ...target1, price: 1.00 } });
				await store.update({ entry: target2.id, shape: Product, state: { ...target2, price: 2.00 } });

				expect(changes).toContainEqual({ [target1.id]: true });
				expect(changes).toContainEqual({ [target2.id]: true });

			}));

			it("should fire one event per matching registration when filters overlap", factory(async ({
				store,
				generate
			}) => {

				const changes: Record<Reference, boolean>[] = [];

				const observer: StoreObserver = c => { changes.push(c); };

				const target = await generate(products[0], Product);

				store.observe(observer);
				store.observe(observer, target.id);

				await store.update({ entry: target.id, shape: Product, state: { ...target, price: 1.00 } });

				expect(changes.filter(c => c[target.id] === true)).toHaveLength(2);

			}));

			it("should detach only the registration of the invoked unsubscribe handle", factory(async ({ store }) => {

				const changes: Record<Reference, boolean>[] = [];

				const observer: StoreObserver = c => { changes.push(c); };

				const unsub1 = store.observe(observer, `${base}products/`);
				store.observe(observer, `${base}vendors/`);

				unsub1();

				await store.create({
					entry: `${base}products/OBS-REG-001`,
					shape: Product,
					state: testProduct("OBS-REG-001", "Detached A", { price: 1.00 })
				});

				expect(changes).toHaveLength(0);

			}));

			it("should be safe to invoke an unsubscribe handle twice", factory(async ({ store }) => {

				const observer: StoreObserver = () => undefined;
				const unsub = store.observe(observer);

				unsub();

				expect(() => unsub()).not.toThrow();

			}));

			it("should not fire for a registration with an empty resources array", factory(async ({ store }) => {

				const { changes } = collect(store, []);

				await store.create({
					entry: `${base}products/OBS-REG-002`,
					shape: Product,
					state: testProduct("OBS-REG-002", "Empty Filter", { price: 2.00 })
				});

				expect(changes).toHaveLength(0);

			}));

		});

		describe("unsubscribe", () => {

			it("should stop events after unsubscribe", factory(async ({ store }) => {

				const { changes, unsubscribe } = collect(store);

				unsubscribe();

				await store.create({
					entry: `${base}products/OBS-003`,
					shape: Product,
					state: testProduct("OBS-003", "Silent Product", { price: 25.00, stock: 7 })
				});

				expect(changes).toHaveLength(0);

			}));

		});

	});

}
