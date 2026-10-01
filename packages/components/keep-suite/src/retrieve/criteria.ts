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

import { isObject } from "@metreeca/core";
import { ascending, by, compound, descending, reverse } from "@metreeca/core/order";
import type { Criteria } from "@metreeca/qest/model";
import { beforeAll, describe, expect, it } from "vitest";
import { lookup, type TestFactory } from "../index.core.js";
import { collections } from "../toys.core.js";
import { Categories, Products, Resources, toys, Vendors } from "../toys.js";
import { catalogue, members } from "./index.js";


const { categories, products, vendors, images, videos } = collections;


export function testRetrieveCriteria(factory: TestFactory): void {

	const Catalogue = "https://data.example.net/products/";
	const CategoryCatalogue = "https://data.example.net/categories/";
	const VendorCatalogue = "https://data.example.net/vendors/";


	// §5.7.5 total-order oracles over the union-typed vendor leaves: undefined first, then by processing type,
	// then within each type by comparison (§5.7.1); `certified` spans the ladder xsd:boolean < numeric <
	// xsd:string, where the string tier holds both grade strings and gYear values, a gYear being an opaque
	// xsd:string rather than a processing type (§3, Appendix A.1.1), so it ranks and compares lexically alongside
	// the grades ("2020" before "A" by codepoint)

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

	function scoreOrder(a: undefined | number | string, b: undefined | number | string): number {
		const tier = (s: undefined | number | string): number =>
			s === undefined ? 0 : typeof s === "number" ? 1 : 2;
		return tier(a)-tier(b)
			|| (typeof a === "number" && typeof b === "number" ? a-b : 0)
			|| (typeof a === "string" && typeof b === "string" ? ascending(a, b) : 0);
	}


	describe("criteria", () => {

		beforeAll(factory(async ({ populate }) => { await populate(); }).hook);


		describe("filtering", () => {

			describe("comparison — §5.7.1", () => {

				const numericCases: ReadonlyArray<readonly [
					string, Criteria, (p: { price: number }) => boolean
				]> = [
					["<", { "<price": 20 }, p => p.price < 20],
					[">", { ">price": 50 }, p => p.price > 50],
					["<=", { "<=price": 25 }, p => p.price <= 25],
					[">=", { ">=price": 30 }, p => p.price >= 30]
				];

				numericCases.forEach(([op, selection, criteria]) => {

					it(`should filter by numeric ${op}`, factory(async ({ store }) => {

						const expected = products.filter(criteria);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {}, price: {} }, selection)
						}));

						expect(result).toHaveLength(expected.length);
						expect(result?.every(criteria)).toBe(true);

					}));

				});

				const temporalCases: ReadonlyArray<readonly [
					string, Criteria, (p: { launched?: string }) => boolean
				]> = [
					[
						"<",
						{ "<launched": "2024-01-01" },
						p => p.launched !== undefined && p.launched < "2024-01-01"
					],
					[
						">=",
						{ ">=launched": "2024-06-01" },
						p => p.launched !== undefined && p.launched >= "2024-06-01"
					]
				];

				temporalCases.forEach(([op, selection, criteria]) => {

					it(`should filter by temporal ${op}`, factory(async ({ store }) => {

						const expected = products.filter(criteria);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {}, launched: {} }, selection)
						}));

						expect(result).toHaveLength(expected.length);
						expect(result?.every(criteria)).toBe(true);

					}));

				});

				const stringCases: ReadonlyArray<readonly [
					string, Criteria, (p: { condition: string }) => boolean
				]> = [
					[">", { ">condition": "new" }, p => p.condition > "new"],
					["<=", { "<=condition": "new" }, p => p.condition <= "new"]
				];

				stringCases.forEach(([op, selection, criteria]) => {

					it(`should filter strings by ${op} under codepoint collation`, factory(async ({ store }) => {

						// §5.7.1: xsd:string targets compare under Unicode codepoint collation; the JS
						// `<`/`>` operators on the ASCII condition enum match that collation.

						const expected = products.filter(criteria);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {}, condition: {} }, selection)
						}));

						expect(result).toHaveLength(expected.length);
						expect(result?.every(criteria)).toBe(true);

					}));

				});

				it("should compare boolean targets under false < true ordering", factory(async ({ store }) => {

					// §5.7.1: xsd:boolean is ordered false < true. `featured` is the lone boolean
					// target and lives on Category, so `<true` selects every category whose value is
					// strictly less than true, i.e. featured === false.

					const expected = categories.filter(c => c.featured === false);

					const result = members(await store.lookup({
						entry: CategoryCatalogue,
						shape: Categories,
						model: catalogue({ id: {}, featured: {} }, {
							"<featured": true
						})
					}));

					expect(result).toHaveLength(expected.length);
					expect(result?.every(c => c.featured === false)).toBe(true);

				}));

				it("should exclude resources whose comparison target is absent", factory(async ({ store }) => {

					// §5.7.1: an absent target satisfies no comparison and is excluded, whatever the
					// bound; the two launched-less products MUST not appear.

					const criteria = (p: {
						launched?: string
					}) => p.launched !== undefined && p.launched > "1900-01-01";
					const expected = products.filter(criteria);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, launched: {} }, {
							">launched": "1900-01-01"
						})
					}));

					expect(result).toHaveLength(expected.length);
					expect(result?.every(criteria)).toBe(true);
					expect(expected.length).toBe(products.filter(p => p.launched !== undefined).length);

				}));

				it("should compare a multi-valued target by at-least-one-value semantics", factory(async ({ store }) => {

					// §5.7.1: a multi-valued target matches when at least one of its values satisfies the
					// bound; the filter selects the matching products as a set, without fanning out per
					// value. A mid-collection document URL is the bound, so only some products match.

					const ref = products[Math.floor(products.length/2)]!;
					const bound = ref.documents[Math.floor(ref.documents.length/2)]!;

					const criteria = (p: { documents?: readonly string[] }) => (p.documents ?? []).some(u => u > bound);
					const expected = products.filter(criteria).map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {} }, {
							">documents": bound
						})
					}));

					expect(result?.map(r => r.id).sort()).toEqual(expected);

				}));

				it("should compare through a union variant path (§5.7.1)", factory(async ({ store }) => {

					// §5.7.1 / §5.8: `address.latitude` is declared only on the Place variant of the
					// union-typed `address` slot, so the bound selects exactly the vendors whose
					// address resolves through that variant; vendors carrying the string or
					// PostalAddress variants have no value on the path and never match

					const expected = vendors
						.filter(v => isObject(v.address) && "latitude" in v.address && v.address.latitude > 0)
						.map(v => v.id)
						.sort();

					if ( expected.length === 0 ) { return; }

					const result = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue({ id: {} }, { ">address.latitude": 0 })
					}));

					expect(result?.map(v => v.id).sort()).toEqual(expected);

				}));

			});

			describe("text search — §5.7.2", () => {

				// §5.7.2: a value matches when it contains every whitespace-separated token as a
				// case-insensitive *substring*, with token order *not significant*. §A.2.5 rejects
				// word-prefix matching as non-portable. Shown on the plain-string `aliases` (no
				// coalescing — the coalesced `~` on a localised target lives in localised.ts, §6).
				// `aliases` is multi-valued, so a vendor matches existentially when at least one alias
				// contains every token (§3.2 multi-valued search).

				const matchSubstrings = (query: string) => (v: { aliases?: readonly string[] }) => {

					const tokens = query.toLowerCase().split(/\s+/).filter(token => token.length > 0);

					return (v.aliases ?? []).some(alias => {
						const haystack = alias.toLowerCase();
						return tokens.every(token => haystack.includes(token));
					});
				};

				const cases = [
					["a single substring token", "Toy"],
					["a case-insensitive token", "toymaster"],
					["every token regardless of order (token-order swap)", "Group ToyMaster"],
					["a mid-word substring, not just a word prefix", "aster"]
				];

				cases.forEach(([label, query]) => {

					it(`should match ${label} (§5.7.2)`, factory(async ({ store }) => {

						const criteria = matchSubstrings(query);
						const expected = vendors.filter(criteria);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, {
								"~aliases": query
							})
						}));

						// regression guard: order-swap and mid-word match under substring semantics but
						// not under the rejected ordered-word-prefix reading, so the set is non-empty
						expect(expected.length).toBeGreaterThan(0);
						expect(result?.map(v => v.id).sort()).toEqual(expected.map(v => v.id).sort());

					}));

				});

				it("should match diacritics sensitively while folding case (§5.7.2)", factory(async ({ store }) => {

					// §5.7.2 / A.2.5: matching is case-insensitive but diacritics-sensitive — the
					// accented city matches its accented upper-case spelling, never the stripped one

					const accented = vendors.filter(v =>
						typeof v.address === "object" && "city" in v.address
						&& v.address.city.toLowerCase().includes("nürnberg")
					);

					if ( accented.length === 0 ) { return; }

					const expected = accented.map(v => v.id).sort();

					const matched = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue({ id: {} }, { "~address.city": "NÜRNBERG" })
					}));

					const stripped = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue({ id: {} }, { "~address.city": "nurnberg" })
					}));

					expect(matched?.map(v => v.id).sort()).toEqual(expected);
					expect(stripped ?? []).toHaveLength(0);

				}));

				it("should search the string variant of a single union target (§5.7.2)", factory(async ({ store }) => {

					// §5.7.2: `~` applies to every xsd:string branch at once — over the single `address` union
					// it searches the plain-string variant, the node variants (PostalAddress / Place)
					// contributing no xsd:string value

					const query = "tokyo";

					const expected = vendors
						.filter(v => typeof v.address === "string" && v.address.toLowerCase().includes(query))
						.map(v => v.id).sort();

					expect(expected.length).toBeGreaterThan(0);

					const result = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue({ id: {} }, { "~address": query })
					}));

					expect(result?.map(v => v.id).sort()).toEqual(expected);

				}));

				it("should search the coalesced text of a sub-property through a union member (§5.7.2 / §6)", factory(async ({ store }) => {

					// §5.7.2 over §6: crossing the `address` union into the localised `label` sub-property, `~`
					// targets its coalesced value — an ordinary xsd:string — searched by substring

					const labelUnd = (v: typeof vendors[number]): string | undefined =>
						isObject(v.address) && "label" in v.address && typeof v.address.label.und === "string"
							? v.address.label.und
							: undefined;

					const query = "square";

					const expected = vendors
						.filter(v => (labelUnd(v) ?? "").toLowerCase().includes(query))
						.map(v => v.id).sort();

					expect(expected.length).toBeGreaterThan(0);

					const result = members(await store.lookup({
						entry: VendorCatalogue,
						shape: Vendors,
						model: catalogue({ id: {} }, { "~address.label": query })
					}));

					expect(result?.map(v => v.id).sort()).toEqual(expected);

				}));

			});

			describe("set matching `?` — §5.7.3", () => {

				it("should filter by disjunctive match", factory(async ({ store }) => {

					const criteria = (p: { condition: string }) =>
						p.condition === "new" || p.condition === "refurbished";
					const expected = products.filter(criteria);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, condition: {} }, {
							"?condition": ["new", "refurbished"]
						})
					}));

					expect(result).toHaveLength(expected.length);
					expect(result?.every(criteria)).toBe(true);

				}));

				it("should filter absent values via null option", factory(async ({ store }) => {

					const criteria = (p: { discount?: unknown }) => p.discount === undefined || p.discount === null;
					const expected = products.filter(criteria);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, discount: {} }, {
							"?discount": [null]
						})
					}));

					expect(result).toHaveLength(expected.length);
					expect(result?.every(criteria)).toBe(true);

				}));

				it("should filter absent or matching values via mixed null option", factory(async ({ store }) => {

					const criteria = (p: { discount?: number | null }) =>
						p.discount === undefined || p.discount === null || p.discount === -5;
					const expected = products.filter(criteria);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, discount: {} }, {
							"?discount": [null, -5]
						})
					}));

					expect(result).toHaveLength(expected.length);
					expect(result?.every(criteria)).toBe(true);

				}));

				it("should filter by root id disjunction", factory(async ({ store }) => {

					const first = products[0]!.id;
					const second = products[1]!.id;

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {} }, {
							"?id": [first, second]
						})
					}));

					expect(result?.map(p => p.id).sort()).toEqual([first, second].sort());

				}));

				it("should ignore an empty option set, leaving the collection unconstrained", factory(async ({ store }) => {

					// §5.7.3: by convention under `?` an empty option set carries no options to match
					// and MUST be ignored, so the collection comes back unconstrained.

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, condition: {} }, {
							"?condition": []
						})
					}));

					expect(result).toHaveLength(products.length);

				}));

				it("should accept a single bare option (§5.7.3)", factory(async ({ store }) => {

					// §5.7.3: an option set is a single option, an array of options, or a localised
					// dictionary map — the bare form matches as a singleton set

					const criteria = (p: { condition: string }) => p.condition === "new";
					const expected = products.filter(criteria);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, condition: {} }, {
							"?condition": "new"
						})
					}));

					expect(result).toHaveLength(expected.length);
					expect(result?.every(criteria)).toBe(true);

				}));

				it("should match temporal options by value rather than lexically (§5.7.3)", factory(async ({ store }) => {

					// §5.7.3: literal equality resolves in the processing type, so a value-equal instant in a
					// different timezone offset matches despite the distinct lexical form. Uses `instant`
					// (offset freedom), not `timestamp` (Z-only, one rigid lexical form per value)

					const posted = products.flatMap(p => p.reviews ?? []).map(r => r.posted).find(p => /Z$/.test(p));
					if ( posted === undefined ) { return; }

					const option = posted.replace(/Z$/, "+00:00");

					const expected = products
						.filter(p => (p.reviews ?? []).some(r => r.posted === posted))
						.map(p => p.id).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {} }, {
							"?reviews.posted": [option]
						})
					}));

					expect(option).not.toBe(posted);
					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));

			});

			describe("set matching `!` — §5.7.3", () => {

				it("should filter by conjunctive match, rejecting resources missing a required value", factory(async ({ store }) => {

					const category1100 = lookup(categories, { code: "1100" });
					const category1110 = lookup(categories, { code: "1110" });

					if ( category1100 === undefined || category1110 === undefined ) { return; }

					const criteria = (categoryIds: readonly string[]) =>
						categoryIds.includes(category1100.id) && categoryIds.includes(category1110.id);

					const expected = products.filter(p => criteria(p.categories));

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, categories: {} }, {
							"!categories": [category1100.id, category1110.id]
						})
					}));

					expect(result).toHaveLength(expected.length);
					expect(result?.every(p => criteria(p.categories))).toBe(true);

					// resources holding only one of the required categories must be rejected

					const singleCategoryProducts = products.filter(p => p.categories.length === 1);
					const resultIds = result?.map(p => p.id) ?? [];

					expect(singleCategoryProducts.every(p => !resultIds.includes(p.id))).toBe(true);

				}));

				it("should conjunctively match across a multi-step multi-valued path", factory(async ({ store }) => {

					// §5.7.3 over §5.8.1: the path `categories.code` resolves to the whole set of codes across a
					// product's categories, so the conjunction holds when every option is carried by some
					// category, never by one category alone

					const category1100 = lookup(categories, { code: "1100" });
					const category1110 = lookup(categories, { code: "1110" });

					if ( category1100 === undefined || category1110 === undefined ) { return; }

					const expected = products
						.filter(p => p.categories.includes(category1100.id) && p.categories.includes(category1110.id))
						.map(p => p.id).sort();

					expect(expected.length).toBeGreaterThan(0);
					expect(expected.length).toBeLessThan(products.filter(p => p.categories.includes(category1100.id)).length);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {} }, {
							"!categories.code": [category1100.code, category1110.code]
						})
					}));

					expect(result?.map(p => p.id).sort()).toEqual(expected);

				}));

				it("should select unset values with a null option", factory(async ({ store }) => {

					// §5.7.3: under `!` every option must hold, so `[null]` selects resources whose target
					// is unset (discount absent).

					const criteria = (p: { discount?: number }) => p.discount === undefined;
					const expected = products.filter(criteria);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, discount: {} }, {
							"!discount": [null]
						})
					}));

					expect(result).toHaveLength(expected.length);
					expect(result?.every(criteria)).toBe(true);

				}));

				it("should ignore an empty option set, leaving the collection unconstrained", factory(async ({ store }) => {

					// §5.7.3: the empty-set convention holds under `!` as under `?`: no options to
					// match, so the collection is left unconstrained.

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, categories: {} }, {
							"!categories": []
						})
					}));

					expect(result).toHaveLength(products.length);

				}));

				it("should match nothing when null accompanies a present-value option (§5.7.3)", factory(async ({ store }) => {

					// §5.7.3: under `!` every option must hold, so null beside a present value can
					// never be satisfied — null requires the target absent, the value requires it present

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, discount: {} }, {
							"!discount": [null, -5]
						})
					}));

					expect(result ?? []).toHaveLength(0);

				}));

				it("should satisfy only a singleton set on a single-valued target (§5.7.3)", factory(async ({ store }) => {

					// §5.7.3: a single-valued target satisfies only a single-element set — one stored
					// value cannot equal two distinct options

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, condition: {} }, {
							"!condition": ["new", "used"]
						})
					}));

					expect(result ?? []).toHaveLength(0);

				}));

			});

		});

		describe("sort order — §5.7.5", () => {

			const numericCases: ReadonlyArray<readonly [
				string,
					number | "asc" | "desc",
				(xs: ReadonlyArray<number>) => ReadonlyArray<number>
			]> = [
				["ascending by numeric entry (signed)", 1, xs => [...xs].sort(ascending)],
				["descending by numeric entry (signed)", -1, xs => [...xs].sort(descending)],
				["ascending by numeric entry (asc shorthand)", "asc", xs => [...xs].sort(ascending)],
				["descending by numeric entry (desc shorthand)", "desc", xs => [...xs].sort(descending)]
			];

			numericCases.forEach(([label, value, sorter]) => {

				it(`should order ${label}`, factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, price: {} }, {
							"^price": value
						})
					}));

					const prices = result?.map(p => p.price) ?? [];

					expect(prices).toEqual(sorter(prices));

				}));

			});

			it("should order ascending by string entry", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, condition: {} }, {
						"^condition": 1
					})
				}));

				const conditions = result?.map(p => p.condition) ?? [];

				expect(conditions).toEqual([...conditions].sort(ascending));

			}));

			it("should order an optional entry undefined-first", factory(async ({ store }) => {

				// §5.7.5: the sort order is total with undefined first; the two launched-less
				// products MUST lead, then the rest ascending by date (ISO dates collate
				// chronologically, matching codepoint order).

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, launched: {} }, {
						"^launched": 1
					})
				}));

				const launched = result?.map(p => p.launched) ?? [];
				const absentCount = products.filter(p => p.launched === undefined).length;

				expect(launched).toHaveLength(products.length);
				expect(launched.slice(0, absentCount).every(l => l === undefined)).toBe(true);
				expect(launched.slice(absentCount).every(l => l !== undefined)).toBe(true);

				const present = launched.slice(absentCount).filter((l): l is string => l !== undefined);
				expect(present).toEqual([...present].sort(ascending));

			}));

			it("should order a boolean entry false before true ascending", factory(async ({ store }) => {

				// §5.7.5: single-valued xsd:boolean ordering; ascending ranks false before true.

				const result = members(await store.lookup({
					entry: CategoryCatalogue,
					shape: Categories,
					model: catalogue({ id: {}, featured: {} }, {
						"^featured": 1
					})
				}));

				const featured = result?.map(c => c.featured) ?? [];
				const falseCount = categories.filter(c => c.featured === false).length;

				expect(featured).toHaveLength(categories.length);
				expect(featured.slice(0, falseCount).every(f => f === false)).toBe(true);
				expect(featured.slice(falseCount).every(f => f === true)).toBe(true);

			}));

			const precedenceCases: ReadonlyArray<readonly [
				string,
				Criteria,
				(rows: ReadonlyArray<{ condition: string; price: number }>) =>
					ReadonlyArray<{ condition: string; price: number }>
			]> = [
				[
					"support multi-key ordering",
					{ "^condition": 1, "^price": 2 },
					rows => [...rows].sort(compound(by(x => x.condition), by(x => x.price)))
				],
				[
					"respect 1-based precedence across multiple keys",
					{ "^condition": 1, "^price": -2 },
					rows => [...rows].sort(compound(by(x => x.condition), by(x => x.price, descending)))
				],
				[
					"apply the key with lower precedence number as primary",
					{ "^condition": -2, "^price": 1 },
					rows => [...rows].sort(compound(by(x => x.price), by(x => x.condition, descending)))
				]
			];

			precedenceCases.forEach(([label, selection, sorter]) => {

				it(`should ${label}`, factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, condition: {}, price: {} }, selection)
					}));

					const rows = result?.map(p => ({ condition: p.condition, price: p.price })) ?? [];

					expect(rows).toHaveLength(products.length);
					expect(rows).toEqual(sorter(rows));

				}));

			});

			it("should ignore a zero sort key (§5.7.5)", factory(async ({ store }) => {

				// §5.7.5: zero is ignored, so the key adds no ordering constraint and the
				// collection comes back complete, as if unsorted

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "^price": 0 })
				}));

				expect(result?.map(p => p.id).sort()).toEqual(products.map(p => p.id).sort());

			}));

		});

		describe("union-typed sort order — §5.7.5", () => {

			it("should order a union-typed column across processing-type tiers", factory(async ({ store }) => {

				// §5.7.5: the sort order is total across a union-typed key: undefined first, then by
				// processing type (numeric before xsd:string), then within each type by comparison. The
				// vendor `score` union carries numeric scores and string grades, so ordering yields the
				// score-less vendor first, then the numeric scores ascending, then the grades ascending.

				const expected = [...vendors]
					.sort(by(v => v.score, scoreOrder))
					.map(v => v.id);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "^score": 1 })
				})) ?? [];

				expect(result.map(r => r.id)).toEqual(expected);

			}));

			it("should order a union-typed column across the full processing-type ladder", factory(async ({ store }) => {

				// §5.7.5: the vendor `certified` union carries a value per processing-type tier, so
				// ascending order walks the whole ladder — undefined, xsd:boolean, numeric, then the
				// xsd:string tier, which holds both the grades and the opaque-string gYear (§3)

				const expected = [...vendors]
					.sort(by(v => v.certified, certifiedOrder))
					.map(v => v.id);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "^certified": 1 })
				})) ?? [];

				expect(result.map(r => r.id)).toEqual(expected);

			}));

			it("should reverse the whole total order on a descending union-typed key", factory(async ({ store }) => {

				// §5.7.5: a negative order traverses the same total order in reverse — the xsd:string
				// tier first, then numeric, xsd:boolean, with undefined last (the total order places
				// undefined lowest; A.2.3 relies on engines sorting it lowest natively, with no
				// direction-specific clause)

				const expected = [...vendors]
					.sort(reverse(by(v => v.certified, certifiedOrder)))
					.map(v => v.id);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "^certified": -1 })
				})) ?? [];

				expect(result.map(r => r.id)).toEqual(expected);

			}));

			it("should keep a union key's tier and value adjacent under multi-key precedence", factory(async ({ store }) => {

				// §5.7.5: a lower-precedence key applies only after the union-typed primary key's
				// full total order, tier and value alike; the numeric scores disagree with the code
				// order, so a secondary key leaking between the tier and the value would reorder
				// the numeric tier here

				const expected = [...vendors]
					.sort(compound(by(v => v.score, scoreOrder), by(v => v.code)))
					.map(v => v.id);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "^score": 1, "^code": 2 })
				})) ?? [];

				expect(result.map(r => r.id)).toEqual(expected);

			}));

			it("should keep page boundaries stable across processing-type tiers", factory(async ({ store }) => {

				// §5.7.6 over §5.7.5: slicing a union-ordered collection respects the same total
				// order; this page crosses the numeric/xsd:string tier boundary

				const expected = [...vendors]
					.sort(by(v => v.score, scoreOrder))
					.map(v => v.id)
					.slice(2, 4);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "^score": 1, "@": 2, "#": 2 })
				})) ?? [];

				expect(result.map(r => r.id)).toEqual(expected);

			}));

		});

		describe("union-typed matching — §5.7", () => {

			// Per-branch matching over the union-typed Vendor.score (variants: decimal, grade string):
			// admissibility is anchored on the option/bound type versus the declared variants — an
			// option or bound matching no variant is rejected; otherwise each value matches in its own
			// branch's regime, other branches contributing no match (§5.7 preamble).

			it("should reject an option matching no declared variant", factory(async ({ store }) => {

				await expect(store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "?score": [true] })
				})).rejects.toThrow();

			}));

			it("should accept a null option as typeless and select absent values", factory(async ({ store }) => {

				// blue Unions (constraint operands and text search): a bound or option over a union
				// follows the state rule (exactly one branch), EXCEPT a `null` option, which is
				// typeless and exempt: it is not rejected as matching no variant but selects
				// resources whose union-typed value is absent.

				const expected = vendors.filter(v => v.score === undefined).map(v => v.id).sort();

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "?score": [null] })
				}));

				expect(expected.length).toBeGreaterThan(0);
				expect(result?.map(v => v.id).sort()).toEqual(expected);

			}));

			it("should match options per branch across a mixed option set", factory(async ({ store }) => {

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
					model: catalogue({ id: {} }, { "?score": [numeric, grade] })
				}));

				expect(result?.map(v => v.id).sort()).toEqual(expected);

			}));

			it("should match a singleton conjunctive set in its branch", factory(async ({ store }) => {

				const grade = lookup(vendors, v => typeof v.score === "string")?.score;

				if ( grade === undefined ) { return; }

				const expected = vendors.filter(v => v.score === grade).map(v => v.id).sort();

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "!score": [grade] })
				}));

				expect(result?.map(v => v.id).sort()).toEqual(expected);

			}));

			it("should match a temporal union variant by a single-valued option", factory(async ({ store }) => {

				// `audited` is union(boolean, date); the date variant is the sole string-representable member,
				// so a date option targets it unambiguously and must resolve as xsd:date — the union leaf's
				// per-variant term typing, term-sensitive where boolean/numeric options are value-masked

				const expected = vendors.filter(v => v.audited === "2023-06-15").map(v => v.id).sort();

				expect(expected.length).toBeGreaterThan(0);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "?audited": ["2023-06-15"] })
				}));

				expect(result?.map(v => v.id).sort()).toEqual(expected);

			}));

			it("should match the boolean variant of the same union by a single-valued option", factory(async ({ store }) => {

				// control: the boolean variant renders the same term value-driven or shape-driven, so this
				// passes while the sibling date-variant match fails — isolating the datatype mistype

				const expected = vendors.filter(v => v.audited === true).map(v => v.id).sort();

				expect(expected.length).toBeGreaterThan(0);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "?audited": [true] })
				}));

				expect(result?.map(v => v.id).sort()).toEqual(expected);

			}));

			it("should compare the temporal variant of a union leaf by a date bound", factory(async ({ store }) => {

				// §5.7.1: a date bound resolves in the date variant of `audited`; term-sensitive, so the
				// bound must be typed xsd:date, not a plain string

				const expected = vendors
					.filter(v => typeof v.audited === "string" && v.audited >= "2023-06-15")
					.map(v => v.id).sort();

				expect(expected.length).toBeGreaterThan(0);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { ">=audited": "2023-06-15" })
				}));

				expect(result?.map(v => v.id).sort()).toEqual(expected);

			}));

			it("should conjunctively match the temporal variant of a union leaf by a single-valued option", factory(async ({ store }) => {

				const expected = vendors.filter(v => v.audited === "2023-06-15").map(v => v.id).sort();

				expect(expected.length).toBeGreaterThan(0);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "!audited": ["2023-06-15"] })
				}));

				expect(result?.map(v => v.id).sort()).toEqual(expected);

			}));

			it("should rank the focused temporal variant of a union leaf first", factory(async ({ store }) => {

				// focus the date carried by the highest-id vendor, so a broken focus (no match) leaves it
				// last under the id tiebreaker rather than passing spuriously off the id order

				const focus = "2020-03-10";
				const focal = vendors.filter(v => v.audited === focus).length;

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "+audited": [focus] })
				})) ?? [];

				// fixture invariant: every retrieved id is a sample vendor, and the focal date is the id-last one
				const flags = result.map(r => lookup(vendors, { id: r.id })!.audited === focus);

				expect(focal).toBeGreaterThan(0);
				expect(vendors[vendors.length-1]?.audited).toBe(focus);
				expect(result).toHaveLength(vendors.length);
				expect(flags.slice(0, focal).every(Boolean)).toBe(true);
				expect(flags.slice(focal).some(Boolean)).toBe(false);

			}));

			it("should order a union leaf across boolean and temporal tiers", factory(async ({ store }) => {

				// §5.7.5: a bare union leaf orders undefined-first, then by processing type — the `audited`
				// union spans xsd:boolean and a real temporal (xsd:date), exercising the temporal tier that
				// the opaque-gYear `certified` sort does not

				const auditedOrder = (a: undefined | boolean | string, b: undefined | boolean | string): number => {
					const tier = (x: undefined | boolean | string): number =>
						x === undefined ? 0 : typeof x === "boolean" ? 1 : 2;
					return tier(a)-tier(b)
						|| (typeof a === "boolean" && typeof b === "boolean" ? Number(a)-Number(b) : 0)
						|| (typeof a === "string" && typeof b === "string" ? ascending(a, b) : 0);
				};

				const expected = [...vendors]
					.sort(compound(by(v => v.audited, auditedOrder), by(v => v.id)))
					.map(v => v.id);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "^audited": 1 })
				})) ?? [];

				expect(result.map(r => r.id)).toEqual(expected);

			}));

			it("should compare only the numeric branch for a numeric bound", factory(async ({ store }) => {

				const criteria = (s: undefined | number | string): boolean => typeof s === "number" && s > 3;
				const expected = vendors.filter(v => criteria(v.score)).map(v => v.id).sort();

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { ">score": 3 })
				}));

				expect(expected.length).toBeGreaterThan(0);
				expect(result?.map(v => v.id).sort()).toEqual(expected);

			}));

			it("should compare only the string branch for a string bound", factory(async ({ store }) => {

				const criteria = (s: undefined | number | string): boolean => typeof s === "string" && s >= "B";
				const expected = vendors.filter(v => criteria(v.score)).map(v => v.id).sort();

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { ">=score": "B" })
				}));

				expect(expected.length).toBeGreaterThan(0);
				expect(result?.map(v => v.id).sort()).toEqual(expected);

			}));

			it("should rank the focused branch values first", factory(async ({ store }) => {

				const grade = lookup(vendors, v => typeof v.score === "string")?.score;

				if ( grade === undefined ) { return; }

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "+score": [grade] })
				})) ?? [];

				// fixture invariant: every retrieved id is a sample vendor
				const flags = result.map(r => lookup(vendors, { id: r.id })!.score === grade);
				const focal = vendors.filter(v => v.score === grade).length;

				expect(result).toHaveLength(vendors.length);
				expect(flags.slice(0, focal).every(Boolean)).toBe(true);
				expect(flags.slice(focal).some(Boolean)).toBe(false);

			}));

			it("should search every string branch of a union existentially", factory(async ({ store }) => {

				// blue Unions (constraint operands and text search): a `~` operand over a union-typed
				// property is not matched against the branches: it applies to every string branch
				// at once, filtering their values existentially. `Vendor.contacts` carries email and
				// phone string branches, so a token found in any email or phone contact matches.

				const criteria = (v: { contacts?: ReadonlyArray<unknown> }): boolean =>
					(v.contacts ?? []).some(c => typeof c === "string" && c.toLowerCase().includes("toymaster"));

				const expected = vendors.filter(criteria);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "~contacts": "toymaster" })
				}));

				expect(expected.length).toBeGreaterThan(0);
				expect(result?.map(v => v.id).sort()).toEqual(expected.map(v => v.id).sort());

			}));

			it("should not match a substring carried only by a node branch", factory(async ({ store }) => {

				// blue Unions: the non-string branches do not support `~`. A token present only in a
				// node-branch entry (a PostalAddress `city`) but in no email or phone contact filters
				// no branch, so the union-typed `~contacts` search returns nothing.

				const token = "nürnberg";

				const inNode = vendors.some(v => (v.contacts ?? []).some(c =>
					isObject(c) && "city" in c && c.city.toLowerCase().includes(token)));

				const inString = vendors.some(v => (v.contacts ?? []).some(c =>
					typeof c === "string" && c.toLowerCase().includes(token)));

				// fixture guard: the token must live in a node branch but in no string branch
				if ( !inNode || inString ) { return; }

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "~contacts": token })
				}));

				expect(result ?? []).toHaveLength(0);

			}));

		});

		describe("union-crossing paths — §5.7", () => {

			// Criteria operators over a path that crosses a union: either stepping THROUGH a union
			// member into a variant sub-property (`address.city` / `address.latitude` / `address.label`),
			// or landing on a union-typed leaf through an intermediate reference step (`vendor.score` /
			// `vendor.certified`). Both route the operand off a nested-branch anchor carrying the crossed
			// variant's own `Range` — the arm the direct-leaf matching/order suites, which anchor the
			// union owner as the entry resource, never reach. Each option operator is exercised across
			// every feasible option type and both single- and multi-valued option sets (§5.7.3).

			const vendorOf = (p: { readonly vendor: string }) => lookup(vendors, { id: p.vendor });

			const cityOf = (v: typeof vendors[number]): string | undefined =>
				isObject(v.address) && "city" in v.address ? v.address.city : undefined;

			const latitudeOf = (v: typeof vendors[number]): number | undefined =>
				isObject(v.address) && "latitude" in v.address ? v.address.latitude : undefined;

			const openedOf = (v: typeof vendors[number]): string | undefined =>
				isObject(v.address) && "opened" in v.address ? v.address.opened : undefined;

			const addressLabelOf = (v: typeof vendors[number]): string | undefined =>
				isObject(v.address) && "label" in v.address && typeof v.address.label.und === "string"
					? v.address.label.und
					: undefined;


			describe("through a union member", () => {

				// §5.7 over §5.5: the path steps through the union-typed `address` slot into a variant's
				// own sub-property, present only on vendors whose address resolves through that variant —
				// `city` on the PostalAddress branch, `latitude` on the Place branch, `label` (localised)
				// on both node branches. Vendors carrying another branch (or no address) never match.

				describe("comparison — §5.7.1", () => {

					const cases: ReadonlyArray<readonly [
						string, Criteria, (v: typeof vendors[number]) => boolean
					]> = [
						[">", { ">address.latitude": 0 }, v => {
							const l = latitudeOf(v);
							return l !== undefined && l > 0;
						}],
						["<", { "<address.latitude": 50 }, v => {
							const l = latitudeOf(v);
							return l !== undefined && l < 50;
						}],
						[">=", { ">=address.latitude": 40.758 }, v => {
							const l = latitudeOf(v);
							return l !== undefined && l >= 40.758;
						}],
						["string >=", { ">=address.city": "F" }, v => {
							const c = cityOf(v);
							return c !== undefined && c >= "F";
						}],
						["string <", { "<address.city": "G" }, v => {
							const c = cityOf(v);
							return c !== undefined && c < "G";
						}]
					];

					cases.forEach(([label, selection, criteria]) => {

						it(`should compare a variant sub-property (${label})`, factory(async ({ store }) => {

							const expected = vendors.filter(criteria).map(v => v.id).sort();

							if ( expected.length === 0 ) { return; }

							const result = members(await store.lookup({
								entry: VendorCatalogue,
								shape: Vendors,
								model: catalogue({ id: {} }, selection)
							}));

							expect(result?.map(v => v.id).sort()).toEqual(expected);

						}));

					});

				});

				describe("ordering — §5.7.5", () => {

					// undefined first, then the present values in comparison order; the vendors lacking the
					// bearing variant (or an address entirely) form the leading undefined block, ordered
					// among themselves by the deterministic id tiebreaker (§5.7.6)

					const cityOrder = (a: string | undefined, b: string | undefined): number =>
						(a === undefined ? 0 : 1)-(b === undefined ? 0 : 1)
						|| (typeof a === "string" && typeof b === "string" ? ascending(a, b) : 0);

					it("should order the collection by a string sub-property, undefined-first", factory(async ({ store }) => {

						const expected = [...vendors]
							.sort(compound(by(v => cityOf(v), cityOrder), by(v => v.id)))
							.map(v => v.id);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "^address.city": 1 })
						})) ?? [];

						expect(vendors.some(v => cityOf(v) !== undefined)).toBe(true);
						expect(result.map(r => r.id)).toEqual(expected);

					}));

					it("should place undefined last on a descending string sub-property", factory(async ({ store }) => {

						// §5.7.5 / A.2.3: `undefined` is the lowest tier of the total order and participates in
						// the sort direction, so a descending key reverses the whole order — present cities
						// descending, then the absent-city vendors last (mirroring the descending union-typed
						// key, and the "sorts lowest natively" backend mapping)

						const expected = [...vendors]
							.sort(compound(
								by(v => cityOf(v) === undefined ? 1 : 0),
								by(v => cityOf(v) ?? "", descending),
								by(v => v.id)
							))
							.map(v => v.id);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "^address.city": -1 })
						})) ?? [];

						expect(vendors.some(v => cityOf(v) !== undefined)).toBe(true);
						expect(result.map(r => r.id)).toEqual(expected);

					}));

				});

				describe("disjunctive match `?` — §5.7.3", () => {

					it("should match a string sub-property by a single-valued option", factory(async ({ store }) => {

						const expected = vendors.filter(v => cityOf(v) === "Nürnberg").map(v => v.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "?address.city": ["Nürnberg"] })
						}));

						expect(result?.map(v => v.id).sort()).toEqual(expected);

					}));

					it("should match a string sub-property by a multi-valued option", factory(async ({ store }) => {

						const expected = vendors
							.filter(v => cityOf(v) === "Nürnberg" || cityOf(v) === "Firenze")
							.map(v => v.id).sort();

						expect(expected.length).toBeGreaterThan(1);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "?address.city": ["Nürnberg", "Firenze"] })
						}));

						expect(result?.map(v => v.id).sort()).toEqual(expected);

					}));

					it("should match a numeric sub-property by a single-valued option", factory(async ({ store }) => {

						const expected = vendors.filter(v => latitudeOf(v) === 40.758).map(v => v.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "?address.latitude": [40.758] })
						}));

						expect(result?.map(v => v.id).sort()).toEqual(expected);

					}));

					it("should match a temporal sub-property by a single-valued option", factory(async ({ store }) => {

						// §5.7.3: `Place.opened` is an xsd:date sub-property reached through the `address` union
						// member — a term-sensitive operand (unlike the value-equality-masked city/latitude),
						// so a date option must resolve as xsd:date, not a plain string

						const expected = vendors.filter(v => openedOf(v) === "2018-06-01").map(v => v.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "?address.opened": ["2018-06-01"] })
						}));

						expect(result?.map(v => v.id).sort()).toEqual(expected);

					}));

					it("should match a localised sub-property by a single-string Dictionary-map option", factory(async ({ store }) => {

						// §5.7.3 over §6: a Dictionary-map option matches by tagged-value equality — the und entry
						// matches stored und-tagged labels; `address.label` is localised text on both node
						// variants, reached through the `address` union member

						const expected = vendors.filter(v => addressLabelOf(v) === "Nürnberg, Germany").map(v => v.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "?address.label": { und: "Nürnberg, Germany" } })
						}));

						expect(result?.map(v => v.id).sort()).toEqual(expected);

					}));

					it("should match a localised sub-property by an array-valued Dictionary-map option", factory(async ({ store }) => {

						// §5.7.3: an array-per-tag Dictionary-map option is an existential set — a resource matches
						// when its und-tagged label equals any listed value

						const expected = vendors
							.filter(v => addressLabelOf(v) === "Nürnberg, Germany" || addressLabelOf(v) === "Firenze, Italy")
							.map(v => v.id).sort();

						expect(expected.length).toBeGreaterThan(1);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, {
								"?address.label": { und: ["Nürnberg, Germany", "Firenze, Italy"] }
							})
						}));

						expect(result?.map(v => v.id).sort()).toEqual(expected);

					}));

					it("should select absent values on a variant sub-property by a null option", factory(async ({ store }) => {

						// §5.7.3: a null option is typeless and selects resources whose path value is absent —
						// every vendor whose address does not resolve through the city-bearing PostalAddress
						// branch (a Place, a plain string, or no address at all)

						const expected = vendors.filter(v => cityOf(v) === undefined).map(v => v.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "?address.city": [null] })
						}));

						expect(result?.map(v => v.id).sort()).toEqual(expected);

					}));

				});

				describe("conjunctive match `!` — §5.7.3", () => {

					it("should conjunctively match a variant sub-property by a singleton option", factory(async ({ store }) => {

						const expected = vendors.filter(v => cityOf(v) === "Nürnberg").map(v => v.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "!address.city": ["Nürnberg"] })
						}));

						expect(result?.map(v => v.id).sort()).toEqual(expected);

					}));

					it("should match nothing for a multi-valued conjunctive option on a single-valued sub-property", factory(async ({ store }) => {

						// §5.7.3: `!` requires every option to hold; a single-valued `address.city` cannot equal
						// two distinct cities at once, so a two-option conjunction selects nothing

						expect(vendors.some(v => cityOf(v) === "Nürnberg")).toBe(true);
						expect(vendors.some(v => cityOf(v) === "Firenze")).toBe(true);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "!address.city": ["Nürnberg", "Firenze"] })
						}));

						expect(result ?? []).toHaveLength(0);

					}));

					it("should conjunctively match a localised sub-property by a Dictionary-map option", factory(async ({ store }) => {

						const expected = vendors.filter(v => addressLabelOf(v) === "Nürnberg, Germany").map(v => v.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "!address.label": { und: "Nürnberg, Germany" } })
						}));

						expect(result?.map(v => v.id).sort()).toEqual(expected);

					}));

				});

				describe("focus `+` — §5.7.4", () => {

					it("should rank a focused variant sub-property first", factory(async ({ store }) => {

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "+address.city": ["Nürnberg"] })
						})) ?? [];

						// fixture invariant: every retrieved id is a sample vendor
						const flags = result.map(r => cityOf(lookup(vendors, { id: r.id })!) === "Nürnberg");
						const focal = vendors.filter(v => cityOf(v) === "Nürnberg").length;

						expect(focal).toBeGreaterThan(0);
						expect(result).toHaveLength(vendors.length);
						expect(flags.slice(0, focal).every(Boolean)).toBe(true);
						expect(flags.slice(focal).some(Boolean)).toBe(false);

					}));

					it("should rank a focused localised sub-property first by a Dictionary-map option", factory(async ({ store }) => {

						const result = members(await store.lookup({
							entry: VendorCatalogue,
							shape: Vendors,
							model: catalogue({ id: {} }, { "+address.label": { und: "Nürnberg, Germany" } })
						})) ?? [];

						// fixture invariant: every retrieved id is a sample vendor
						const flags = result.map(r => addressLabelOf(lookup(vendors, { id: r.id })!) === "Nürnberg, Germany");
						const focal = vendors.filter(v => addressLabelOf(v) === "Nürnberg, Germany").length;

						expect(focal).toBeGreaterThan(0);
						expect(result).toHaveLength(vendors.length);
						expect(flags.slice(0, focal).every(Boolean)).toBe(true);
						expect(flags.slice(focal).some(Boolean)).toBe(false);

					}));

				});

			});


			describe("onto a union leaf", () => {

				// The path steps through the required `vendor` reference and lands on the union-typed
				// `score` / `certified` leaf — a genuine union `Range` reached off a nested-branch
				// anchor, with no transform to collapse it (unlike expression.ts "path traversing a
				// union", which always carries a pipe). §5.7 per-branch semantics then apply: a typed
				// bound or option resolves in its own variant, other branches contributing no match.

				describe("comparison — §5.7.1", () => {

					it("should compare only the numeric branch through a union-valued path", factory(async ({ store }) => {

						const criteria = (p: typeof products[number]): boolean => {
							const s = vendorOf(p)?.score;
							return typeof s === "number" && s > 3;
						};
						const expected = products.filter(criteria).map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { ">vendor.score": 3 })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

					it("should compare only the string branch through a union-valued path", factory(async ({ store }) => {

						const criteria = (p: typeof products[number]): boolean => {
							const s = vendorOf(p)?.score;
							return typeof s === "string" && s >= "B";
						};
						const expected = products.filter(criteria).map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { ">=vendor.score": "B" })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

				});

				describe("ordering — §5.7.5", () => {

					it("should order across processing-type tiers through a union-valued path", factory(async ({ store }) => {

						const expected = [...products]
							.sort(compound(by(p => vendorOf(p)?.score, scoreOrder), by(p => p.id)))
							.map(p => p.id);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "^vendor.score": 1 })
						})) ?? [];

						expect(result.map(r => r.id)).toEqual(expected);

					}));

					it("should order across the full ladder through a union-valued path", factory(async ({ store }) => {

						const expected = [...products]
							.sort(compound(by(p => vendorOf(p)?.certified, certifiedOrder), by(p => p.id)))
							.map(p => p.id);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "^vendor.certified": 1 })
						})) ?? [];

						expect(result.map(r => r.id)).toEqual(expected);

					}));

					it("should reverse the total order on a descending union-valued path", factory(async ({ store }) => {

						const expected = [...products]
							.sort(compound(reverse(by(p => vendorOf(p)?.certified, certifiedOrder)), by(p => p.id)))
							.map(p => p.id);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "^vendor.certified": -1 })
						})) ?? [];

						expect(result.map(r => r.id)).toEqual(expected);

					}));

				});

				describe("disjunctive match `?` — §5.7.3", () => {

					it("should match the numeric branch by a single-valued option", factory(async ({ store }) => {

						const expected = products.filter(p => vendorOf(p)?.score === 4.5).map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "?vendor.score": [4.5] })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

					it("should match the grade branch by a single-valued option", factory(async ({ store }) => {

						const expected = products.filter(p => vendorOf(p)?.score === "A").map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "?vendor.score": ["A"] })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

					it("should match across branches by a multi-valued mixed-type option", factory(async ({ store }) => {

						const expected = products
							.filter(p => vendorOf(p)?.score === 4.5 || vendorOf(p)?.score === "B")
							.map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(1);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "?vendor.score": [4.5, "B"] })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

					it("should match the boolean branch of the full ladder by a single-valued option", factory(async ({ store }) => {

						const expected = products.filter(p => vendorOf(p)?.certified === true).map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "?vendor.certified": [true] })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

					it("should match the numeric branch of the full ladder by a single-valued option", factory(async ({ store }) => {

						// a decimal option is unambiguous over the certified ladder: it resolves only in the
						// numeric variant, other tiers contributing no match (§5.7.3). The grade and gYear
						// variants are both xsd:string-kind, so a string option cannot single one out and is
						// rejected upstream — a temporal option on this union leaf is not feasible

						const expected = products.filter(p => vendorOf(p)?.certified === 3.8).map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "?vendor.certified": [3.8] })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

					it("should match across ladder tiers by a multi-valued mixed-type option", factory(async ({ store }) => {

						const expected = products
							.filter(p => vendorOf(p)?.certified === true || vendorOf(p)?.certified === 3.8)
							.map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(1);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "?vendor.certified": [true, 3.8] })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

					it("should select absent values on a union leaf by a null option", factory(async ({ store }) => {

						const expected = products.filter(p => vendorOf(p)?.score === undefined).map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "?vendor.score": [null] })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

				});

				describe("conjunctive match `!` — §5.7.3", () => {

					it("should conjunctively match the grade branch by a singleton option", factory(async ({ store }) => {

						const expected = products.filter(p => vendorOf(p)?.score === "A").map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "!vendor.score": ["A"] })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

					it("should conjunctively match the boolean branch by a singleton option", factory(async ({ store }) => {

						const expected = products.filter(p => vendorOf(p)?.certified === true).map(p => p.id).sort();

						expect(expected.length).toBeGreaterThan(0);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "!vendor.certified": [true] })
						}));

						expect(result?.map(p => p.id).sort()).toEqual(expected);

					}));

				});

				describe("focus `+` — §5.7.4", () => {

					it("should rank a focused grade branch first", factory(async ({ store }) => {

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "+vendor.score": ["A"] })
						})) ?? [];

						// fixture invariant: every retrieved id is a sample product
						const flags = result.map(r => vendorOf(lookup(products, { id: r.id })!)?.score === "A");
						const focal = products.filter(p => vendorOf(p)?.score === "A").length;

						expect(focal).toBeGreaterThan(0);
						expect(result).toHaveLength(products.length);
						expect(flags.slice(0, focal).every(Boolean)).toBe(true);
						expect(flags.slice(focal).some(Boolean)).toBe(false);

					}));

					it("should rank a focused boolean branch first", factory(async ({ store }) => {

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, { "+vendor.certified": [true] })
						})) ?? [];

						// fixture invariant: every retrieved id is a sample product
						const flags = result.map(r => vendorOf(lookup(products, { id: r.id })!)?.certified === true);
						const focal = products.filter(p => vendorOf(p)?.certified === true).length;

						expect(focal).toBeGreaterThan(0);
						expect(result).toHaveLength(products.length);
						expect(flags.slice(0, focal).every(Boolean)).toBe(true);
						expect(flags.slice(focal).some(Boolean)).toBe(false);

					}));

				});

			});

		});

		describe("conjunctive match over a computed multi-valued path — §5.7.3", () => {

			// §5.7.3 (index.md:1136): `"!expression": options` requires every option to equal at least one
			// expression value. Over a multi-valued computed path — `abs:reviews.rating` fans one value per
			// review — the conjunction must hold across the whole computed value set: a product qualifies only
			// when every listed rating is carried by some review, not merely one of them (which would be `?`).

			const ratingsOf = (p: typeof products[number]): readonly number[] =>
				(p.reviews ?? []).map(r => r.rating);

			it("should require every option to match some computed value", factory(async ({ store }) => {

				const expected = products
					.filter(p => ratingsOf(p).includes(4) && ratingsOf(p).includes(5))
					.map(p => p.id).sort();

				// fixture guard: the conjunction must be strictly narrower than the disjunction, else the test
				// cannot tell `!` from `?`
				const disjunctive = products.filter(p => ratingsOf(p).includes(4) || ratingsOf(p).includes(5));

				expect(expected.length).toBeGreaterThan(0);
				expect(expected.length).toBeLessThan(disjunctive.length);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "!abs:reviews.rating": [4, 5] })
				}));

				expect(result?.map(p => p.id).sort()).toEqual(expected);

			}));

		});

		describe("conjunctive match over an aggregate — §5.7.3", () => {

			// §5.7.3: `!expression` requires every option to equal at least one expression value. A per-item
			// aggregate reduces to a single value, so a two-option conjunction over distinct values is
			// unsatisfiable — no product's max review rating can be both 4 and 5 at once. The disjunctive
			// `isIn` currently used for aggregate `!` wrongly admits products whose max rating is 4 or 5.

			const maxRatingOf = (p: typeof products[number]): number =>
				(p.reviews ?? []).reduce((max, r) => Math.max(max, r.rating), Number.NEGATIVE_INFINITY);

			it("should require every option to equal the aggregate value", factory(async ({ store }) => {

				// fixture guard: the disjunction is non-empty, so a passing (empty) result is meaningful
				const disjunctive = products.filter(p => maxRatingOf(p) === 4 || maxRatingOf(p) === 5);
				expect(disjunctive.length).toBeGreaterThan(0);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "!max:reviews.rating": [4, 5] })
				}));

				expect(result ?? []).toHaveLength(0);

			}));

		});

		describe("conjunctive match on id and type — §5.7.3", () => {

			// §5.7.3 applies to the special `id` / `type` steps as much as to properties: `!id`/`!type`
			// conjoin over the resource's identity / stored `rdf:type` set. A dropped constraint would leave
			// the collection unfiltered, so each test is framed so that "ignored" and "correct" diverge.

			it("should disjunctively match by id (`?` control)", factory(async ({ store }) => {

				const target = products[0];

				if ( target === undefined ) { return; }

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "?id": [target.id] })
				}));

				expect(result?.map(p => p.id)).toEqual([target.id]);

			}));

			it("should conjunctively match by id", factory(async ({ store }) => {

				const target = products[0];

				if ( target === undefined ) { return; }

				expect(products.length).toBeGreaterThan(1); // guard: an ignored `!id` returns the whole collection

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "!id": [target.id] })
				}));

				expect(result?.map(p => p.id)).toEqual([target.id]);

			}));

			it("should conjunctively match by type, selecting nothing for disjoint types", factory(async ({ store }) => {

				expect(products.length).toBeGreaterThan(0); // guard: an ignored `!type` returns the whole collection

				// no product is also a Category, so the conjunction over both types selects nothing
				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "!type": [toys.Product, toys.Category] })
				}));

				expect(result ?? []).toHaveLength(0);

			}));

			it("should disjunctively match by type (`?` control)", factory(async ({ store }) => {

				// control that `any` already handles `type`: no product is a Category, so `?type` selects none
				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "?type": [toys.Category] })
				}));

				expect(result ?? []).toHaveLength(0);

			}));

		});

		describe("match through a reverse-only reference — §5.7.3", () => {

			// `Category.lower` is a reverse-only foreign view over the monodirectional `upper` link (upper mirrors
			// broader): a category's `lower` are the categories whose `upper` points at it. A `!`/`?` option
			// relates to the anchor through `<option> upper <anchor>`, anchor in object position, so the match
			// must render the reverse predicate direction; a forward-only encoder drops `!lower`, leaving the
			// collection unfiltered. Exercised from a child: `!lower:[child]` selects the child's parent.

			const CategoryCatalogue2 = "https://data.example.net/categories/";

			it("should disjunctively match a reverse reference (`?` control)", factory(async ({ store }) => {

				const child = categories.find(cat => cat.broader !== undefined);

				if ( child?.broader === undefined ) { return; }

				const expected = categories.filter(cat => cat.id === child.broader).map(cat => cat.id).sort();

				const result = members(await store.lookup({
					entry: CategoryCatalogue2,
					shape: Categories,
					model: catalogue({ id: {} }, { "?lower": [child.id] })
				}));

				expect(result?.map(cat => cat.id).sort()).toEqual(expected);

			}));

			it("should conjunctively match a reverse reference", factory(async ({ store }) => {

				const child = categories.find(cat => cat.broader !== undefined);

				if ( child?.broader === undefined ) { return; }

				const expected = categories.filter(cat => cat.id === child.broader).map(cat => cat.id).sort();

				expect(expected.length).toBeGreaterThan(0);
				expect(expected.length).toBeLessThan(categories.length); // guard: ignored `!lower` returns all

				const result = members(await store.lookup({
					entry: CategoryCatalogue2,
					shape: Categories,
					model: catalogue({ id: {} }, { "!lower": [child.id] })
				}));

				expect(result?.map(cat => cat.id).sort()).toEqual(expected);

			}));

		});

		describe("transformed-path operand typing — §5.7 × §5.8", () => {

			// A transform stage drops the operand's effective type (the encoder threads no shape into a
			// staged constraint), so a term-sensitive operand is typed value-driven and mistyped. Numeric
			// transforms are masked by SPARQL value-equality; a temporal transform (min/max over the
			// single-valued Product.launched date) is not, so `!`/`+` over it must currently fail. The
			// compare/`?` witnesses live in expression.ts; these close the `!` and `+` operators.

			it("should conjunctively match a temporal-valued transform", factory(async ({ store }) => {

				const target = lookup(products, p => p.launched !== undefined)?.launched;

				if ( target === undefined ) { return; }

				const expected = products.filter(p => p.launched === target).map(p => p.id).sort();

				expect(expected.length).toBeGreaterThan(0);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "!min:launched": [target] })
				}));

				expect(result?.map(p => p.id).sort()).toEqual(expected);

			}));

			it("should focus-rank a temporal-valued transform", factory(async ({ store }) => {

				const target = lookup(products, p => p.launched !== undefined)?.launched;

				if ( target === undefined ) { return; }

				const focal = products.filter(p => p.launched === target).length;

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "+min:launched": [target] })
				})) ?? [];

				// fixture invariant: every retrieved id is a sample product
				const flags = result.map(r => lookup(products, { id: r.id })!.launched === target);

				expect(focal).toBeGreaterThan(0);
				expect(result).toHaveLength(products.length);
				expect(flags.slice(0, focal).every(Boolean)).toBe(true);
				expect(flags.slice(focal).some(Boolean)).toBe(false);

			}));

		});

		describe("sort focus — §5.7.4", () => {

			it("should rank the focused option group first (§5.7.4)", factory(async ({ store }) => {

				// §5.7.4: resources whose value is in the option set rank first; the rest keep their
				// order. The focused "refurbished" group MUST form the leading block: every leading
				// row matches and none appears after a non-match.

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, condition: {} }, {
						"+condition": ["refurbished"]
					})
				}));

				const conditions = result?.map(p => p.condition) ?? [];
				const focalCount = products.filter(p => p.condition === "refurbished").length;

				expect(conditions).toHaveLength(products.length);
				expect(conditions.slice(0, focalCount).every(c => c === "refurbished")).toBe(true);
				expect(conditions.slice(focalCount).every(c => c !== "refurbished")).toBe(true);

			}));

			it("should rank the focused reference group first (§5.7.4)", factory(async ({ store }) => {

				const vendorFixture = lookup(vendors, { code: "0001" });

				if ( vendorFixture === undefined ) { return; }

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, vendor: {} }, {
						"+vendor": [vendorFixture.id]
					})
				}));

				const vendorIds = result?.map(p => p.vendor) ?? [];
				const focalCount = products.filter(p => p.vendor === vendorFixture.id).length;

				expect(vendorIds).toHaveLength(products.length);
				expect(vendorIds.slice(0, focalCount).every(v => v === vendorFixture.id)).toBe(true);
				expect(vendorIds.slice(focalCount).every(v => v !== vendorFixture.id)).toBe(true);

			}));

			it("should rank absent values first with a null option (§5.7.4)", factory(async ({ store }) => {

				// §5.7.4: a null option ranks resources whose value is absent first; the discount-less
				// products form the leading block.

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, discount: {} }, {
						"+discount": [null]
					})
				}));

				const discounts = result?.map(p => p.discount) ?? [];
				const absentCount = products.filter(p => p.discount === undefined).length;

				expect(discounts).toHaveLength(products.length);
				expect(discounts.slice(0, absentCount).every(d => d === undefined)).toBe(true);
				expect(discounts.slice(absentCount).every(d => d !== undefined)).toBe(true);

			}));

			it("should override the regular sort criteria (§5.7.4)", factory(async ({ store }) => {

				// §5.7.4: focus overrides the regular sort — the focused group leads even though
				// ascending condition order would rank "new" first; the rest keep the sort order

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, condition: {} }, {
						"+condition": ["refurbished"],
						"^condition": 1
					})
				}));

				const conditions = result?.map(p => p.condition) ?? [];
				const focalCount = products.filter(p => p.condition === "refurbished").length;
				const rest = conditions.slice(focalCount);

				expect(conditions).toHaveLength(products.length);
				expect(conditions.slice(0, focalCount).every(c => c === "refurbished")).toBe(true);
				expect(rest).toEqual([...rest].sort(ascending));

			}));

		});

		describe("pagination — §5.7.6", () => {

			it("should support combined offset/limit with explicit zeros treated as no pagination",
				factory(async ({ store }) => {

					// Per `Criteria` docs (`resource.ts` @/#): "zero is ignored" for both operators.
					// Combined coverage: bounded slice, beyond-set offset, default range, zero-edge.

					const bounded = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {}, price: {} }, {
							"^price": 1,
							"@": 0,
							"#": 5
						})
					}));

					const beyond = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {} }, {
							"@": 10000,
							"#": 10
						})
					}));

					const limited = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {} }, {
							"#": 5
						})
					}));

					const unlimited = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {} })
					}));

					const zeros = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {} }, {
							"@": 0,
							"#": 0
						})
					}));

					expect(bounded?.length ?? 0).toBeLessThanOrEqual(5);
					expect(beyond ?? []).toHaveLength(0);
					expect(unlimited?.length ?? 0).toBeGreaterThanOrEqual(limited?.length ?? 0);
					expect(zeros).toHaveLength(products.length);

				}));

			it("should return the contiguous next page for a non-zero offset", factory(async ({ store }) => {

				// §5.7.6: the processor extends `^` with a deterministic tiebreaker for a total,
				// stable order, so the offset window is the genuine next page: disjoint from page 1
				// and contiguous with it over the same fully-ordered set.

				const page = (offset: number) => store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "^price": 1, "@": offset, "#": 10 })
				}).then(members);

				const ids1 = (await page(0) ?? []).map(p => p.id);
				const ids2 = (await page(10) ?? []).map(p => p.id);

				const full = (members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "^price": 1 })
				})) ?? []).map(p => p.id);

				expect(ids1).toHaveLength(10);
				expect(ids2.length).toBeGreaterThan(0);
				expect(ids1.some(entry => ids2.includes(entry))).toBe(false);
				expect([...ids1, ...ids2]).toEqual(full.slice(0, ids1.length+ids2.length));

			}));

			it("should limit by member, not by fanned row, when a member carries a multi-valued slot (§5.7.6)", factory(async ({ store }) => {

				// §5.6/§5.7.6: the limit bounds the collection's members, not the fanned SELECT rows. A member
				// carrying a multi-valued slot fans into one row per value, so a row-level limit returns fewer
				// whole members than requested. AF-001 alone carries three documents, so `#: 3` over the
				// document-bearing element must still yield three distinct members, each with all its documents.

				const limit = 3;

				const sliced = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, sku: {}, documents: {} }, { "^sku": 1, "#": limit })
				})) ?? [];

				expect(sliced).toHaveLength(Math.min(limit, products.length));

				// each limited member is whole — all its documents, not a single fanned row's worth

				sliced.forEach(member => {
					const product = lookup(products, { id: member.id });
					if ( product === undefined ) { return; }
					expect([...(member.documents ?? [])].sort()).toEqual([...product.documents].sort());
				});

			}));

			it("should offset by member, not by fanned row, when a member carries a multi-valued slot (§5.7.6)", factory(async ({ store }) => {

				// §5.6/§5.7.6: the offset skips whole members, not fanned rows. The id-only element binds one
				// row per member, fixing the member window after the offset; the document-bearing element under
				// the same order and offset must skip the same members, never a fraction of one member's rows.

				const order: Criteria = { "^sku": 1, "@": 2 };

				const identities = (members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, sku: {} }, order)
				})) ?? []).map(member => member.id);

				const documented = (members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, sku: {}, documents: {} }, order)
				})) ?? []).map(member => member.id);

				expect(documented).toEqual(identities);

			}));

		});

		describe("combined", () => {

			it("should combine multiple filters", factory(async ({ store }) => {

				const criteria = (p: { price: number; condition: string }) =>
					p.price >= 10 && p.price <= 50 && p.condition === "new";
				const expected = products.filter(criteria);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, price: {}, condition: {} }, {
						">=price": 10,
						"<=price": 50,
						"?condition": ["new"]
					})
				}));

				expect(result).toHaveLength(expected.length);
				expect(result?.every(criteria)).toBe(true);

			}));

			it("should combine filter and ordering", factory(async ({ store }) => {

				const criteria = (p: { price: number }) => p.price >= 20;

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, price: {} }, {
						">=price": 20,
						"^price": 1
					})
				}));

				const prices = result?.map(p => p.price) ?? [];

				expect(result?.every(criteria)).toBe(true);
				expect(prices).toEqual([...prices].sort(ascending));

			}));

			it("should combine filter, ordering, and slicing", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {}, price: {} }, {
						">=price": 10,
						"^price": 1,
						"@": 0,
						"#": 3
					})
				}));

				const prices = result?.map(p => p.price) ?? [];

				expect(result?.length ?? 0).toBeLessThanOrEqual(3);
				expect(result?.every(p => p.price >= 10)).toBe(true);
				expect(prices).toEqual([...prices].sort(ascending));

			}));

		});

		describe("empty selection elision — §5", () => {

			it("should elide an empty selection, returning the unconstrained collection", factory(async ({ store }) => {

				// §5: an empty selection is elided like empty templates, unions, and locales, so the
				// collection comes back unconstrained, exactly as with no selection attached.

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, {})
				}));

				expect(result).toHaveLength(products.length);

			}));

		});

		describe("constraint admissibility — §5.7", () => {

			// §5.7: a constraint whose target type or cardinality is not listed for its operator,
			// or whose bound or option type does not match the target's resolved type, is
			// unsupported and rejected; §5.7.6 likewise rejects negative or non-integer pagination.

			const rejected: ReadonlyArray<readonly [string, Criteria]> = [
				["text search over a numeric target", { "~price": "10" }],
				["comparison over a reference target", { "<vendor": "a" }],
				["sort over a multi-valued target", { "^documents": 1 }],
				["focus over a multi-valued target", { "+categories": ["https://data.example.net/categories/1000"] }],
				["a numeric bound over a string target", { ">=condition": 5 }],
				["a mismatched option type over a string target", { "?condition": [42] }],
				["a negative offset", { "@": -1 }],
				["a negative limit", { "#": -1 }],
				["a non-integer offset", { "@": 1.5 }],
				["a non-integer limit", { "#": 2.5 }]
			];

			it.each(rejected)("should reject %s", (_label, selection) => factory(async ({ store }) => {

				await expect(store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({ id: {} }, selection)
				})).rejects.toThrow();

			})());

		});

		describe("aggregation — ungrouped per-item reduction — §5.8.2.1", () => {

			// §5.8.2.1: a pure selection carries no projection, so the query is ungrouped. An
			// aggregate constraint then reduces over the values its path gathers from each item
			// under evaluation (§5.8.1), and the items are filtered, sorted, or ranked by that
			// per-item value. It is never a single collection-wide scalar, and a selection never
			// groups (grouping is fixed by the projection alone, exercised in projection.ts).
			// Targets are multi-valued paths (categories, reviews.rating) so the reduction is
			// material rather than degenerate over a single-valued slot.

			type P = typeof products[number];

			const ratings = (p: P): readonly number[] => (p.reviews ?? []).map(r => r.rating);
			const sumRatings = (p: P): number => ratings(p).reduce((sum, r) => sum+r, 0);
			const avgRatings = (p: P): undefined | number =>
				ratings(p).length === 0 ? undefined : sumRatings(p)/ratings(p).length;
			const minRatings = (p: P): undefined | number =>
				ratings(p).length === 0 ? undefined : Math.min(...ratings(p));
			const maxRatings = (p: P): undefined | number =>
				ratings(p).length === 0 ? undefined : Math.max(...ratings(p));

			describe("filtering", () => {

				const filterCases: ReadonlyArray<readonly [string, Criteria, (p: P) => boolean]> = [
					["count over a multi-valued reference", { ">=count:categories": 2 },
						p => p.categories.length >= 2],
					["sum over a multi-valued path", { ">=sum:reviews.rating": 8 },
						p => sumRatings(p) >= 8],
					["min over a multi-valued path", { ">=min:reviews.rating": 4 },
						p => {
							const m = minRatings(p);
							return m !== undefined && m >= 4;
						}],
					["max over a multi-valued path", { ">=max:reviews.rating": 5 },
						p => {
							const m = maxRatings(p);
							return m !== undefined && m >= 5;
						}],
					["avg over a multi-valued path", { ">=avg:reviews.rating": 4 },
						p => {
							const a = avgRatings(p);
							return a !== undefined && a >= 4;
						}]
				];

				filterCases.forEach(([label, selection, criteria]) => {

					it(`should filter items by ${label}`, factory(async ({ store }) => {

						const expected = products.filter(criteria);

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, selection)
						}));

						// regression guard: a per-item reduction selects a proper non-empty subset,
						// unlike the old whole-collection scalar that kept or dropped every item together
						expect(expected.length).toBeGreaterThan(0);
						expect(expected.length).toBeLessThan(products.length);
						expect(result?.map(p => p.id).sort()).toEqual(expected.map(p => p.id).sort());

					}));

				});

				it("should drop every item whose per-item reduction fails the predicate", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {} }, {
							">count:categories": 1000
						})
					}));

					expect(result ?? []).toHaveLength(0);

				}));

			});

			describe("sorting", () => {

				// §5.7.5 total order, undefined first; ties may fall either way under the
				// processor's deterministic tiebreaker, so the per-item value sequence is asserted
				// non-decreasing rather than pinned to a single permutation. The oracle is built by
				// partition rather than by comparator: Array.prototype.sort hoists undefined
				// elements to the END regardless of the comparator, which would silently invert
				// the undefined-first placement the spec mandates.
				const ascAgg = (values: readonly (undefined | number)[]): readonly (undefined | number)[] => [
					...values.filter(v => v === undefined),
					...values.flatMap(v => v === undefined ? [] : [v]).sort(ascending)
				];

				const sortCases: ReadonlyArray<readonly [string, Criteria, (p: P) => undefined | number]> = [
					["count", { "^count:categories": 1 }, p => p.categories.length],
					["sum", { "^sum:reviews.rating": 1 }, sumRatings],
					["min", { "^min:reviews.rating": 1 }, minRatings],
					["max", { "^max:reviews.rating": 1 }, maxRatings],
					["avg", { "^avg:reviews.rating": 1 }, avgRatings]
				];

				sortCases.forEach(([label, selection, value]) => {

					it(`should order items by per-item ${label}`, factory(async ({ store }) => {

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue({ id: {} }, selection)
						})) ?? [];

						// fixture invariant: every retrieved id is a sample product
						const values = result.map(r => value(lookup(products, { id: r.id })!));

						expect(result).toHaveLength(products.length);
						expect(values).toEqual(ascAgg(values));

					}));

				});

				it("should window items ordered by a per-item reduction (§5.7.6)", factory(async ({ store }) => {

					// §5.7.6 over §5.8.2.1: the window applies to the items ordered by their own reduced value, so a
					// descending count with a limit yields the most-categorised products, every one of them above
					// the count of any product left out

					const limit = 3;

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue({ id: {} }, { "^count:categories": -1, "#": limit })
					})) ?? [];

					const counts = result.map(r => lookup(products, { id: r.id })!.categories.length);
					const floor = Math.min(...counts);
					const left = products.filter(p => !result.some(r => r.id === p.id)).map(p => p.categories.length);

					expect(result).toHaveLength(limit);
					expect(counts).toEqual([...counts].sort(descending));
					expect(left.every(n => n <= floor)).toBe(true);

				}));

			});

		});

		describe("type / inheritance — §5.7.3", () => {

			const ResourceCatalogue = "https://data.example.net/resources/";

			const everyResource = [...categories, ...vendors, ...products, ...images, ...videos];

			it("should span every subtype of a supertype collection", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: ResourceCatalogue,
					shape: Resources,
					model: catalogue({ id: {} })
				})) ?? [];

				expect(new Set(result.map(r => r.id)))
					.toEqual(new Set(everyResource.map(r => r.id)));

			}));

			it("should match subtypes under an explicit supertype type filter", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: ResourceCatalogue,
					shape: Resources,
					model: catalogue({ id: {} }, { "?type": [toys.Resource] })
				})) ?? [];

				expect(new Set(result.map(r => r.id)))
					.toEqual(new Set(everyResource.map(r => r.id)));

			}));

			it("should narrow to one subtype under an explicit leaf type filter", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: ResourceCatalogue,
					shape: Resources,
					model: catalogue({ id: {} }, { "?type": [toys.Category] })
				})) ?? [];

				expect(new Set(result.map(r => r.id)))
					.toEqual(new Set(categories.map(r => r.id)));

			}));

		});

	});

}
