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
 * Virtual retrieval conformance: resources derived from the store rather than held in it.
 *
 * Covers the `virtual` lookup request as a whole: presence without a stored entry, the special fields, single-valued
 * members read off whatever the entry holds, multi-valued members read off the resources their range describes by
 * class rather than off stored links, criteria stated over them, and link-driven expansion below them.
 *
 * @module retrieve/virtual
 */

import { beforeAll, describe, expect, it } from "vitest";
import type { TestFactory } from "../index.core.js";
import { catalogues, collections } from "../toys.core.js";
import { base, Products, Resources, toys } from "../toys.js";
import { catalogue } from "./index.js";


const { products, vendors } = collections;


export function testRetrieveVirtual(factory: TestFactory): void {

	// an entry no sample resource is stored under, so every member it exposes is derived

	const Derived = `${base}derived/products/`;

	describe("virtual", () => {

		beforeAll(factory(async ({ populate }) => { await populate(); }).hook);


		describe("contract", () => {

			it("should return undefined for an unstored entry when held", factory(async ({ store }) => {

				const result = await store.lookup({
					entry: Derived,
					shape: Products,
					model: catalogue({ sku: {} })
				});

				expect(result).toBeUndefined();

			}));

			it("should return a resource for an unstored entry when virtual", factory(async ({ store }) => {

				const result = await store.lookup({
					virtual: true,
					entry: Derived,
					shape: Products,
					model: catalogue({ sku: {} })
				});

				expect(result).toBeDefined();

			}));

			it("should read the special fields off the entry and the shape", factory(async ({ store }) => {

				const result = await store.lookup({
					virtual: true,
					entry: Derived,
					shape: Products,
					model: { id: {}, type: {} }
				});

				expect(result).toEqual({ id: Derived, type: toys.Collection });

			}));

			it("should read single-valued members off what the entry holds", factory(async ({ store }) => {

				// the stored vendors catalogue holds a label of its own, read as it stands

				const result = await store.lookup({
					virtual: true,
					entry: catalogues.vendors.id,
					shape: Products,
					model: { label: { en: {} } }
				});

				expect(result?.label).toEqual(catalogues.vendors.label);

			}));

		});


		describe("members", () => {

			it("should retrieve every resource of the member class without stored links", factory(async ({ store }) => {

				const result = await store.lookup({
					virtual: true,
					entry: Derived,
					shape: Products,
					model: catalogue({ id: {} })
				});

				expect(new Set(result?.members?.map(({ id }) => id))).toEqual(new Set(products.map(({ id }) => id)));

			}));

			it("should retrieve the member class regardless of the links the entry holds", factory(async ({ store }) => {

				// the stored vendors catalogue links vendors, which the Products shape never reaches

				const result = await store.lookup({
					virtual: true,
					entry: catalogues.vendors.id,
					shape: Products,
					model: catalogue({ id: {} })
				});

				expect(new Set(result?.members?.map(({ id }) => id))).toEqual(new Set(products.map(({ id }) => id)));

			}));

			it("should span the subtypes of the member class", factory(async ({ store }) => {

				const result = await store.lookup({
					virtual: true,
					entry: Derived,
					shape: Resources,
					model: catalogue({ id: {} })
				});

				const retrieved = new Set(result?.members?.map(({ id }) => id));

				[...products, ...vendors].forEach(({ id }) => expect(retrieved).toContain(id));

			}));

			it("should apply criteria to the derived members", factory(async ({ store }) => {

				const expected = products.map(({ sku }) => sku).sort().slice(0, 3);

				const result = await store.lookup({
					virtual: true,
					entry: Derived,
					shape: Products,
					model: catalogue({ sku: {} }, { "^sku": 1, "#": 3 })
				});

				expect(result?.members?.map(({ sku }) => sku)).toEqual(expected);

			}));

			it("should expand the derived members through their stored links", factory(async ({ store }) => {

				const result = await store.lookup({
					virtual: true,
					entry: Derived,
					shape: Products,
					model: catalogue({ vendor: { id: {} } })
				});

				const known = new Set(vendors.map(({ id }) => id));

				expect(result?.members?.length).toBeGreaterThan(0);

				result?.members?.forEach(({ vendor }) => expect(known).toContain(vendor.id));

			}));

			it("should omit a derived collection matching no resource", factory(async ({ store }) => {

				const result = await store.lookup({
					virtual: true,
					entry: Derived,
					shape: Products,
					model: catalogue({ sku: {} }, { "~sku": "no-such-sku" })
				});

				expect(result?.members).toBeUndefined();

			}));

		});

	});

}
