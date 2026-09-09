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
 * Expression conformance: the `pipe:path` spectrum (§5.8) targeted by selection and projection keys.
 *
 * Centralises the property-path and transform-pipe machinery once — path special steps (`id`/`type`), multi-step
 * paths, scalar/aggregate/composition pipes, the empty-path and component-mix matrix — so the selection and
 * projection suites only spot-check that an expression works in their respective positions.
 *
 * @module retrieve/expression
 */

import { boolean } from "@metreeca/blue/boolean";
import { decimal } from "@metreeca/blue/number";
import { reference } from "@metreeca/blue/reference";
import { id, resource } from "@metreeca/blue/resource";
import { date, string, url } from "@metreeca/blue/string";
import { multiple, optional, required } from "@metreeca/blue/value";
import { ascending, by } from "@metreeca/core/order";
import type { Selection } from "@metreeca/qest/template";
import { beforeAll, describe, expect, it } from "vitest";
import { lookup, type TestFactory } from "../index.core.js";
import { collections } from "../toys.core.js";
import { Categories, Products, Vendor, Vendors } from "../toys.js";
import { catalogue, collection, members } from "./index.js";


const { categories, products, vendors } = collections;


export function testRetrieveExpression(factory: TestFactory): void {

	const Catalogue = "https://data.example.net/products/";
	const CategoryCatalogue = "https://data.example.net/categories/";
	const VendorCatalogue = "https://data.example.net/vendors/";


	describe("lookup expression", () => {

		beforeAll(factory(async ({ populate }) => { await populate(); }).hook);


		describe("paths — §5.8.1", () => {

			it("should filter by multi-step path", factory(async ({ store }) => {

				const expected = products.filter(p => {
					const v = (lookup(vendors, { id: p.vendor }))!;
					return v.founded !== undefined && v.founded >= "2000";
				});

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						id: id(),
						vendor: required(resource({ name: required(string()) }))
					}), {
						">=vendor.founded": "2000"
					})
				}));

				expect(result).toHaveLength(expected.length);

			}));

			it("should filter by path ending with id", factory(async ({ store }) => {

				const vendorFixture = lookup(vendors, { code: "0001" });

				if ( vendorFixture === undefined ) { return; }

				const expected = products.filter(p => p.vendor === vendorFixture.id);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						id: id(),
						vendor: required(reference(Vendor))
					}), {
						"?vendor.id": [vendorFixture.id]
					})
				}));

				expect(result).toHaveLength(expected.length);
				expect(result?.every(p => p.vendor === vendorFixture.id)).toBe(true);

			}));

			it("should filter by path ending with type", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						id: id()
					}), {
						"?vendor.type": [vendors[0].type]
					})
				}));

				expect(result).toHaveLength(products.length);

			}));

			it("should order by multi-step path", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						id: id(),
						vendor: required(resource({ name: required(string()) }))
					}), {
						"^vendor.name": 1
					})
				}));

				const names = result?.map(p => p.vendor.name) ?? [];

				expect(names).toEqual([...names].sort());

			}));

		});

		describe("pipes — §5.8.2", () => {

			describe("singleton scalar transform", () => {

				it("should filter by year from temporal", factory(async ({ store }) => {

					const criteria = (p: { launched?: string }) =>
						p.launched !== undefined && new Date(p.launched).getUTCFullYear() >= 2024;
					const expected = products.filter(criteria);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							id: id(),
							launched: optional(date())
						}), {
							">=year:launched": 2024
						})
					}));

					expect(result).toHaveLength(expected.length);
					expect(result?.every(criteria)).toBe(true);

				}));

				it("should filter by string length", factory(async ({ store }) => {

					const criteria = (p: { sku: string }) => p.sku.length >= 6;
					const expected = products.filter(criteria);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							id: id(),
							sku: required(string())
						}), {
							">=length:sku": 6
						})
					}));

					expect(result).toHaveLength(expected.length);
					expect(result?.every(criteria)).toBe(true);

				}));

				it("should order by computed year", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							id: id(),
							launched: optional(date())
						}), {
							"^year:launched": 1
						})
					}));

					expect(result).toHaveLength(products.length);

				}));

			});

			describe("multi-transform scalar chain", () => {

				it("should filter by chained scalar transforms", factory(async ({ store }) => {

					const criteria = (p: { change?: number }) =>
						p.change !== undefined && Math.floor(Math.abs(p.change)) >= 2;
					const expected = products.filter(criteria);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							id: id(),
							change: optional(decimal())
						}), {
							">=floor:abs:change": 2
						})
					}));

					expect(result?.every(criteria)).toBe(true);
					expect(result).toHaveLength(expected.length);

				}));

			});

			describe("mixed scalar-aggregate chain", () => {

				it("should filter by scalar wrapping aggregate", factory(async ({ store }) => {

					// `round:avg:price` — under the ungrouped per-item reduction (§5.8.2.1) `avg`
					// reduces over each item's own values (the single price), then `round` (scalar)
					// is applied on top, so the constraint admits the items whose rounded price
					// clears the bound.

					const avg = products.reduce((s, p) => s+p.price, 0)/products.length;
					const roundedAvg = Math.round(avg);

					const expected = products.filter(p => Math.round(p.price) >= roundedAvg).map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							id: id()
						}), {
							">=round:avg:price": roundedAvg
						})
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(expected.length).toBeLessThan(products.length);
					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));

				it("should filter by aggregate wrapping scalar", factory(async ({ store }) => {

					// `sum:length:documents` — `length` (scalar) maps each document URL to its character
					// count, then `sum` (aggregate) reduces them per item under the ungrouped
					// per-item reduction (§5.8.2.1), filtering products by their total URL length

					const total = (p: { documents: readonly string[] }): number =>
						p.documents.reduce((s, u) => s+u.length, 0);

					const bound = Math.round(products.map(total).reduce((s, t) => s+t, 0)/products.length);
					const expected = products.filter(p => total(p) >= bound).map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), {
							">=sum:length:documents": bound
						})
					}));

					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));

			});

			describe("empty path", () => {

				it("should filter by aggregate pipe over the root collection", factory(async ({ store }) => {

					// `count:` with empty path denotes an aggregate over the input collection —
					// the filter is on a single scalar, so the collection is either kept whole
					// or dropped entirely.

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							id: id()
						}), {
							">=count:": 1
						})
					}));

					expect(result).toHaveLength(products.length);

				}));

				it("should filter a scalar sub-collection by scalar pipe", factory(async ({ store }) => {

					// `length:` with empty path filters each URL of the scalar sub-collection
					// `Product.documents` by string length, exercising scalar pipe with empty path
					// against a multi-valued plain string property.

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({
							id: "",
							documents: collection(url(), {
								">=length:": 30
							})
						})
					}));

					result?.forEach(p => {
						(p.documents ?? []).forEach(text => expect(text.length).toBeGreaterThanOrEqual(30));
					});

				}));

			});

		});

		describe("component mixes — §5.8", () => {

			// Cartesian matrix: `(pipe, path)` ∈ {empty, singleton, multi}².
			// Every cell carries at least one assertion. Cells that reuse semantics from focused
			// `pipes`/`paths` tests above (singleton×multi `>=vendor.founded`, empty×empty
			// `>=count:` aggregate, etc.) are restated here under bespoke selection keys to
			// keep the matrix self-contained.

			it("should support empty pipe × empty path (root identity)", factory(async ({ store }) => {

				const target = products[0]!.id;

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({ id: id() }), {
						"?id": [target]
					})
				}));

				expect(result?.map(p => p.id)).toEqual([target]);

			}));

			it("should support empty pipe × singleton path (plain property step)",
				factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							id: id(),
							price: required(decimal())
						}), {
							">=price": 30
						})
					}));

					expect(result?.every(p => p.price >= 30)).toBe(true);

				}));

			it("should support empty pipe × multi-step path (nested property)",
				factory(async ({ store }) => {

					const expected = products.filter(p => {
						const v = lookup(vendors, { id: p.vendor });
						return v?.founded !== undefined && v.founded >= "2000";
					});

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							id: id(),
							vendor: required(resource({ name: required(string()) }))
						}), {
							">=vendor.founded": "2000"
						})
					}));

					expect(result).toHaveLength(expected.length);

				}));

			it("should support singleton pipe × empty path (aggregate on root collection)",
				factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), {
							">=count:": 1
						})
					}));

					expect(result).toHaveLength(products.length);

				}));

			it("should support singleton pipe × singleton path", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						id: id(),
						sku: required(string())
					}), {
						"^length:sku": 1
					})
				}));

				const lengths = result?.map(p => p.sku.length) ?? [];

				expect(lengths).toEqual([...lengths].sort(ascending));

			}));

			it("should support singleton pipe × multi-step path", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						id: id(),
						vendor: required(resource({ name: required(string()) }))
					}), {
						"^length:vendor.name": 1
					})
				}));

				const nameLengths = result?.map(p => p.vendor.name.length) ?? [];

				expect(nameLengths).toEqual([...nameLengths].sort(ascending));

			}));

			it("should support multi-transform pipe × empty path (scalar wrapping aggregate)",
				factory(async ({ store }) => {

					// `round:avg:price` — aggregate then scalar over the root collection;
					// the predicate is satisfied for any non-negative average price.

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), {
							">=round:avg:price": 0
						})
					}));

					expect(result).toHaveLength(products.length);

				}));

			it("should support multi-transform pipe × singleton path", factory(async ({ store }) => {

				// abs:length:sku — abs is structurally a no-op on length, but the composition
				// exercises a multi-transform pipe over a singleton path.

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						id: id(),
						sku: required(string())
					}), {
						"^abs:length:sku": 1
					})
				}));

				const lengths = result?.map(p => p.sku.length) ?? [];

				expect(lengths).toEqual([...lengths].sort(ascending));

			}));

			it("should support multi-transform pipe × multi-step path", factory(async ({ store }) => {

				// abs:length: — length yields a non-negative integer, so abs is a structural
				// no-op; the composition exercises multi-transform pipe over a multi-step path.

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						id: id(),
						vendor: required(resource({ name: required(string()) }))
					}), {
						"^abs:length:vendor.name": 1
					})
				}));

				const nameLengths = result?.map(p => p.vendor.name.length) ?? [];

				expect(nameLengths).toEqual([...nameLengths].sort(ascending));

			}));

		});

		describe("rejection — §5.8", () => {

			// §5.8.1: paths referencing unknown properties are rejected; §5.8.2: pipes referencing
			// unknown transforms, and ill-formed pipes applying more than one aggregate, are rejected.

			const rejected: ReadonlyArray<readonly [string, Selection]> = [
				["an unknown property (§5.8.1)", { ">=unknown": 1 }],
				["an unknown nested property (§5.8.1)", { ">=vendor.unknown": 1 }],
				["an unknown transform (§5.8.2)", { ">=bogus:price": 1 }],
				["an aggregate-after-aggregate pipe (§5.8.2)", { ">=sum:count:": 1 }]
			];

			it.each(rejected)("should reject %s", (_label, selection) => factory(async ({ store }) => {

				await expect(store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({ id: id() }), selection)
				})).rejects.toThrow();

			})());

		});


		describe("transformed-entry constraint typing — §5.7 × §5.8", () => {

			// Every selection operator targets a possibly-probed expression, so a constraint value MUST be
			// typed against the transform's EFFECTIVE range (blue `effective()`, a RangeShape) — not the
			// declared property type. These cases apply each operator to a transformed value whose effective
			// type is non-numeric or multi-variant, where the value-driven typing exercised by the numeric
			// bound/sort cases above (masked by SPARQL numeric value-equality) breaks. A transform across a
			// union either collapses to the surviving variant (a scalar drops out-of-domain variants) or
			// preserves the whole literal-variant set (a `min`/`max` partial aggregate), the latter forcing
			// cross-tier ordering exactly as a direct union key would (§5.7.5).

			beforeAll(factory(async ({ populate }) => { await populate(); }).hook);


			function scoreOrder(a: undefined | number | string, b: undefined | number | string): number {
				const tier = (s: undefined | number | string): number =>
					s === undefined ? 0 : typeof s === "number" ? 1 : 2;
				return tier(a)-tier(b)
					|| (typeof a === "number" && typeof b === "number" ? a-b : 0)
					|| (typeof a === "string" && typeof b === "string" ? ascending(a, b) : 0);
			}

			function certifiedTier(v: undefined | boolean | number | string): number {
				return v === undefined ? 0
					: typeof v === "boolean" ? 1
						: typeof v === "number" ? 2
							: 3;
			}

			function certifiedOrder(
				a: undefined | boolean | number | string,
				b: undefined | boolean | number | string
			): number {
				return certifiedTier(a)-certifiedTier(b)
					|| (typeof a === "boolean" && typeof b === "boolean" ? Number(a)-Number(b) : 0)
					|| (typeof a === "number" && typeof b === "number" ? a-b : 0)
					|| (typeof a === "string" && typeof b === "string" ? ascending(a, b) : 0);
			}


			describe("non-numeric effective type via transform", () => {

				// boolean effective via min/max over the single-valued Category.featured (the per-item
				// aggregate reduces to the value itself); value-driven typing skips the boolean-rank path

				it("should compare a boolean-valued transform", factory(async ({ store }) => {

					const expected = categories.filter(c => c.featured === true).map(c => c.id).sort();

					const result = members(await store.lookup({
						entry: CategoryCatalogue,
						shape: Categories,
						model: catalogue(resource({ id: id() }), { ">=min:featured": true })
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(result?.map(c => c.id).sort()).toEqual(expected);

				}));

				it("should order by a boolean-valued transform", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: CategoryCatalogue,
						shape: Categories,
						model: catalogue(resource({ id: id(), featured: required(boolean) }), { "^min:featured": 1 })
					})) ?? [];

					const flags = result.map(c => c.featured);

					expect(flags).toEqual([...flags].sort((a, b) => Number(a)-Number(b)));

				}));

				it("should set-match a boolean-valued transform", factory(async ({ store }) => {

					const expected = categories.filter(c => c.featured === true).map(c => c.id).sort();

					const result = members(await store.lookup({
						entry: CategoryCatalogue,
						shape: Categories,
						model: catalogue(resource({ id: id() }), { "?min:featured": [true] })
					}));

					expect(result?.map(c => c.id).sort()).toEqual(expected);

				}));

				it("should focus a boolean-valued transform", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: CategoryCatalogue,
						shape: Categories,
						model: catalogue(resource({
							id: id(),
							featured: required(boolean)
						}), { "+min:featured": [true] })
					})) ?? [];

					const flags = result.map(c => c.featured);
					const firstFalse = flags.indexOf(false);
					const lastTrue = flags.lastIndexOf(true);

					expect(firstFalse === -1 || lastTrue < firstFalse).toBe(true);

				}));


				// temporal effective via min/max over the single-valued optional Product.launched (date)

				it("should compare a temporal-valued transform", factory(async ({ store }) => {

					const criteria = (p: {
						launched?: string
					}) => p.launched !== undefined && p.launched >= "2024-01-01";
					const expected = products.filter(criteria).map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), { ">=min:launched": "2024-01-01" })
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));

				it("should order by a temporal-valued transform", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id(), launched: optional(date()) }), { "^min:launched": 1 })
					})) ?? [];

					const dates = result.map(p => p.launched).filter((d): d is string => d !== undefined);

					expect(dates).toEqual([...dates].sort(ascending));

				}));

				it("should set-match a temporal-valued transform", factory(async ({ store }) => {

					const target = lookup(products, p => p.launched !== undefined)?.launched;

					if ( target === undefined ) { return; }

					const expected = products.filter(p => p.launched === target).map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), { "?min:launched": [target] })
					}));

					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));


				// string effective via lower/upper (returns the same string processing type)

				it("should compare a string-valued transform", factory(async ({ store }) => {

					const criteria = (p: { condition: string }) => p.condition.toLowerCase() >= "refurbished";
					const expected = products.filter(criteria).map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), { ">=lower:condition": "refurbished" })
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));

				it("should order by a string-valued transform", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id(), sku: required(string()) }), { "^upper:sku": 1 })
					})) ?? [];

					const skus = result.map(p => p.sku.toUpperCase());

					expect(skus).toEqual([...skus].sort(ascending));

				}));

				it("should set-match a string-valued transform", factory(async ({ store }) => {

					const expected = products.filter(p => p.condition.toLowerCase() === "new").map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), { "?lower:condition": ["new"] })
					}));

					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));

				it("should substring-search a string-valued transform", factory(async ({ store }) => {

					const criteria = (p: { sku: string }) => p.sku.toUpperCase().includes("AF");
					const expected = products.filter(criteria).map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), { "~upper:sku": "AF" })
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));

			});


			describe("transform across a union", () => {

				// A scalar transform across a union drops variants outside its domain, collapsing to the
				// surviving variant (`abs` over Score keeps the decimal branch, drops the grade). A partial
				// aggregate (`min`/`max`) preserves every literal variant, so the effective range stays multi-
				// variant and a comparison resolves to one variant while ordering walks the tiers.

				it("should compare a union collapsed to one variant by a scalar transform", factory(async ({ store }) => {

					const criteria = (v: { score?: number | string }) =>
						typeof v.score === "number" && Math.abs(v.score) >= 4;
					const expected = vendors.filter(criteria).map(v => v.id).sort();

					const result = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue(resource({ id: id() }), { ">=abs:score": 4 })
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(result?.map(v => v.id).sort()).toEqual(expected);

				}));

				it("should set-match a union collapsed to one variant by a scalar transform", factory(async ({ store }) => {

					const numeric = lookup(vendors, v => typeof v.score === "number")?.score;

					if ( typeof numeric !== "number" ) { return; }

					const expected = vendors.filter(v => v.score === numeric).map(v => v.id).sort();

					const result = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue(resource({ id: id() }), { "?abs:score": [Math.abs(numeric)] })
					}));

					expect(result?.map(v => v.id).sort()).toEqual(expected);

				}));

				it("should order a union preserved across variants by a min aggregate", factory(async ({ store }) => {

					// min over the single-valued Score reduces to the value itself but keeps BOTH literal
					// variants in the effective range, so ordering walks the tiers (numeric before grade)
					// exactly as a direct ^score would (§5.7.5)

					const expected = [...vendors].sort(by(v => v.score, scoreOrder)).map(v => v.id);

					const result = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue(resource({ id: id() }), { "^min:score": 1 })
					})) ?? [];

					expect(result.map(v => v.id)).toEqual(expected);

				}));

				it("should order the full ladder preserved by a max aggregate", factory(async ({ store }) => {

					const expected = [...vendors].sort(by(v => v.certified, certifiedOrder)).map(v => v.id);

					const result = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue(resource({ id: id() }), { "^max:certified": 1 })
					})) ?? [];

					expect(result.map(v => v.id)).toEqual(expected);

				}));

				it("should compare only the numeric variant of a union-preserving aggregate", factory(async ({ store }) => {

					const criteria = (v: { score?: number | string }) => typeof v.score === "number" && v.score > 3;
					const expected = vendors.filter(criteria).map(v => v.id).sort();

					const result = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue(resource({ id: id() }), { ">min:score": 3 })
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(result?.map(v => v.id).sort()).toEqual(expected);

				}));

				it("should set-match across variants of a union-preserving aggregate", factory(async ({ store }) => {

					const numeric = lookup(vendors, v => typeof v.score === "number")?.score;
					const grade = lookup(vendors, v => typeof v.score === "string")?.score;

					if ( numeric === undefined || grade === undefined ) { return; }

					const expected = vendors
						.filter(v => v.score === numeric || v.score === grade)
						.map(v => v.id)
						.sort();

					const result = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue(resource({ id: id() }), { "?min:score": [numeric, grade] })
					}));

					expect(result?.map(v => v.id).sort()).toEqual(expected);

				}));

				it("should conjunctively match a variant of a union-preserving aggregate", factory(async ({ store }) => {

					const grade = lookup(vendors, v => typeof v.score === "string")?.score;

					if ( grade === undefined ) { return; }

					const expected = vendors.filter(v => v.score === grade).map(v => v.id).sort();

					const result = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue(resource({ id: id() }), { "!min:score": [grade] })
					}));

					expect(result?.map(v => v.id).sort()).toEqual(expected);

				}));

			});


			describe("path traversing a union", () => {

				// The path steps THROUGH a union-valued property before the transform applies: `vendor.score`
				// / `vendor.certified` cross the single Vendor reference into its literal-variant union. A
				// plain scalar collapses the crossed union to the surviving variant; a `min`/`max` aggregate
				// preserves the whole ladder, so ordering must still walk the processing-type tiers.

				const vendorOf = (p: { vendor: string }) => lookup(vendors, { id: p.vendor });

				it("should compare a union collapsed to one variant through a union-valued path", factory(async ({ store }) => {

					const criteria = (p: { vendor: string }) => {
						const s = vendorOf(p)?.score;
						return typeof s === "number" && Math.abs(s) >= 4;
					};
					const expected = products.filter(criteria).map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), { ">=abs:vendor.score": 4 })
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));

				it("should order across the full ladder through a union-valued path", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), { "^min:vendor.certified": 1 })
					})) ?? [];

					const tiers = result.map(r => {
						const product = lookup(products, { id: r.id });
						return certifiedTier(product === undefined ? undefined : vendorOf(product)?.certified);
					});

					expect(tiers).toEqual([...tiers].sort((a, b) => a-b));

				}));

			});


			describe("term-sensitive operators over numeric transforms", () => {

				// Completeness: the ?/+ operators over a numeric transform. SPARQL numeric value-equality
				// usually masks the typing here, but the matrix must still lock them against the refactor.

				it("should set-match a numeric scalar transform", factory(async ({ store }) => {

					const criteria = (p: { launched?: string }) =>
						p.launched !== undefined && new Date(p.launched).getUTCFullYear() === 2024;
					const expected = products.filter(criteria).map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), { "?year:launched": [2024] })
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));

				it("should focus a numeric aggregate transform", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ id: id() }), { "+count:categories": [1] })
					})) ?? [];

					expect(result.length).toBe(products.length);

				}));

			});

		});

	});

}
