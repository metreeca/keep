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
 * Lookup contract conformance: what `store.lookup` hands back as a whole, independently of the template, collection,
 * criteria, projection, expression and localised machinery the sibling `retrieve/*` suites exercise.
 *
 * Covers entry validation, the `undefined` resolution for a missing resource, special-field retrieval and the
 * immutability of the delivered copy.
 *
 * @module retrieve/contract
 */

import type { Optional } from "@metreeca/core";
import type { Template } from "@metreeca/qest/model";
import type { Resource } from "@metreeca/qest/state";
import { beforeAll, describe, expect, it } from "vitest";
import { lookup, type TestFactory } from "../index.core.js";
import { collections } from "../toys.core.js";
import { Product } from "../toys.js";


const { products } = collections;


export function testRetrieveContract(factory: TestFactory): void {

	const AF001 = lookup(products, { sku: "AF-001" })!;


	describe("contract", () => {

		beforeAll(factory(async ({ populate }) => { await populate(); }).hook);


		// Each case pairs an entry+model with an assertion run against the awaited
		// `store.lookup` invocation: rejection cases assert via `rejects`, success
		// cases assert against the resolved value.

		type ContractCase = {
			readonly entry: string;
			readonly model: Template;
			readonly assert: (call: Promise<Optional<Resource>>) => Promise<unknown>;
		};

		const cases: ReadonlyArray<readonly [string, ContractCase]> = [

			// the model-typing cases the previous notation carried — a typed leaf stating the wrong type, a
			// query tuple over a single-valued property, an over-length collection tuple — have no subject
			// under the reworked model: every leaf is the atomic `{}` and a collection carries its criteria
			// on the entry naming it, so none of those forms is statable

			["reject with RangeError for a relative IRI", {
				entry: "relative/path",
				model: { price: {} },
				assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
			}],

			["reject with RangeError for an empty IRI", {
				entry: "",
				model: { price: {} },
				assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
			}],

			["reject with RangeError for an entry with a query string", {
				entry: `${AF001.id}?probe=1`,
				model: { price: {} },
				assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
			}],

			["reject with RangeError for an entry with a fragment", {
				entry: `${AF001.id}#probe`,
				model: { price: {} },
				assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
			}],

			["return undefined for unknown ids", {
				entry: "https://data.example.net/products/UNKNOWN",
				model: { price: {} },
				assert: async call => expect(await call).toBeUndefined()
			}],

			["project only id", {
				entry: AF001.id,
				model: { id: {} },
				assert: async call => expect((await call)?.id).toBe(AF001.id)
			}],

			["project only type", {
				entry: AF001.id,
				model: { type: {} },
				assert: async call => expect((await call)?.type).toBe(AF001.type)
			}],

			["project id and type together", {
				entry: AF001.id,
				model: { id: {}, type: {} },
				assert: async call => {
					const result = await call;
					expect(result?.id).toBe(AF001.id);
					expect(result?.type).toBe(AF001.type);
				}
			}]

		];

		it.each(cases)("should %s", (_, { entry, model: m, assert }) => factory(async ({ store }) => {

			// ;(cast) a contract case states its model as the wide `Template`, so the delivery it resolves is
			// the wide resource the assertions read values off

			await assert(store.lookup({ shape: Product, entry, model: m }) as Promise<Optional<Resource>>);

		})());

		it("should return an immutable copy", factory(async ({ store }) => {

			const result = await store.lookup({
				entry: AF001.id,
				shape: Product,
				model: { price: {}, vendor: { name: {} } }
			});

			expect(result?.vendor).toBeDefined();

			expect(() => {
				(result as any).price = 0; // ;(cast) runtime immutability probe past readonly typing
			}).toThrow();

			expect(() => {
				(result?.vendor as any).name = ""; // ;(cast) runtime immutability probe past readonly typing
			}).toThrow();

		}));

	});

}
