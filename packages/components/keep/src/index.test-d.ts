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
import { id, multiple, optional, required, resource } from "@metreeca/blue/resource";
import { string } from "@metreeca/blue/string";
import type { Optional } from "@metreeca/core";
import type { Value } from "@metreeca/qest/state";
import { describe, expectTypeOf, test } from "vitest";
import type { StoreClient } from "./index.js";


const Vendor = resource({

	id: id(),

	name: required(string())

});

const Product = resource({

	id: id(),

	name: required(string()),

	vendor: optional(reference(Vendor)),
	vendors: multiple(reference(Vendor))

});

const entry = "http://example.com/products/1";


// the checks are stated over a client handed in as an argument, as type tests never run the calls they state

describe("StoreClient", () => {

	describe("lookup", () => {

		test("types the result by a template consistent with the shape", async () => {
			(client: StoreClient) => expectTypeOf(client.lookup({
				entry,
				shape: Product,
				model: { name: {}, vendor: { name: {} } }
			})).resolves.toEqualTypeOf<Optional<{
				readonly name: string,
				readonly vendor?: undefined | { readonly name: string }
			}>>();
		});

		test("rejects a member the shape doesn't carry next to ones it does", async () => {
			(client: StoreClient) => client.lookup({
				entry,
				shape: Product,
				model: {
					name: {},
					// @ts-expect-error a member the shape doesn't carry
					nme: {}
				}
			});
		});

		test("rejects a form the range doesn't admit", async () => {
			(client: StoreClient) => client.lookup({
				entry,
				shape: Product,
				model: {
					// @ts-expect-error a scalar member admits no nested template
					name: { length: {} }
				}
			});
		});

		test("types the items of a collection by a template consistent with the collected shape, criteria included", async () => {
			(client: StoreClient) => expectTypeOf(client.lookup({
				entry,
				shape: Product,
				model: { vendors: { name: {}, "~name": "acme", "#": 10 } }
			})).resolves.toEqualTypeOf<Optional<{
				readonly vendors?: undefined | readonly { readonly name: string }[]
			}>>();
		});

		test("types the rows of a collection by a projection, criteria included", async () => {
			(client: StoreClient) => expectTypeOf(client.lookup({
				entry,
				shape: Product,
				model: { vendors: { "vendor=name": {}, "^vendor": "asc" } }
			})).resolves.toEqualTypeOf<Optional<{
				readonly vendors?: undefined | readonly { readonly vendor: Optional<Value> }[]
			}>>();
		});

	});

	describe("create", () => {

		test("admits a state the collected shape describes, its identifier left out", async () => {
			(client: StoreClient) => client.create({
				entry, shape: Product, model: { vendors: {} }, state: { name: "Acme" }
			});
		});

		test("admits a state stating its identifier", async () => {
			(client: StoreClient) => client.create({
				entry, shape: Product, model: { vendors: {} }, state: { id: `${entry}/vendors/1`, name: "Acme" }
			});
		});

		test("rejects a state missing a required member", async () => {
			(client: StoreClient) => client.create({
				// @ts-expect-error a required member left out
				entry, shape: Product, model: { vendors: {} }, state: { id: entry }
			});
		});

		test("rejects a state carrying a member the collected shape doesn't describe", async () => {
			(client: StoreClient) => client.create({
				// @ts-expect-error a member the collected shape doesn't describe
				entry, shape: Product, model: { vendors: {} }, state: { name: "Acme", nme: "x" }
			});
		});

		test("rejects a state valuing a member outside its range", async () => {
			(client: StoreClient) => client.create({
				// @ts-expect-error a string member valued by a number
				entry, shape: Product, model: { vendors: {} }, state: { name: 42 }
			});
		});

		test("rejects a slice naming a property collecting at most one value", async () => {
			(client: StoreClient) => client.create({
				// @ts-expect-error a single-valued member collects nothing
				entry, shape: Product, model: { vendor: {} }, state: { name: "Acme" }
			});
		});

	});

	describe("update", () => {

		test("admits a state the shape describes", async () => {
			(client: StoreClient) => client.update({ entry, shape: Product, state: { name: "Widget" } });
		});

		test("rejects a state valuing a member outside its range", async () => {
			// @ts-expect-error a string member valued by a number
			(client: StoreClient) => client.update({ entry, shape: Product, state: { name: 42 } });
		});

	});

	describe("insert", () => {

		test("admits a state the shape describes", async () => {
			(client: StoreClient) => client.insert({ entry, shape: Product, state: { name: "Widget" } });
		});

		test("rejects a state valuing a member outside its range", async () => {
			// @ts-expect-error a string member valued by a number
			(client: StoreClient) => client.insert({ entry, shape: Product, state: { name: 42 } });
		});

	});

});
