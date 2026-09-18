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
 * Localised retrieval conformance: coalesced access (single-string and string-array) under language negotiation.
 *
 * Covers the {@link https://www.rfc-editor.org/ QEST} §6 split between **structural** access (tag-preserving,
 * exercised by the template/query suites) and **coalesced** access (a localised property reduced to a plain string, or
 * an array of plain strings for an array-per-tag property, under language negotiation). Negotiation is driven by the
 * `locale` priority list passed to
 * `store.lookup` (defaulting to `["und"]` when omitted, §6.2): a property whose map carries the priority's first
 * present tag coalesces to that value, and one carrying none of the priority tags coalesces to `undefined`. With no
 * `locale` the whole priority is the single tag `und`, so an und-less property such as `Product.name` coalesces away.
 *
 * @module retrieve/localised
 */

import type { Tag } from "@metreeca/core/language";
import { ascending, by } from "@metreeca/core/order";
import type { Criteria } from "@metreeca/qest/model";
import { beforeAll, describe, expect, it } from "vitest";
import { lookup, type TestFactory } from "../index.core.js";
import { collections } from "../toys.core.js";
import { Products, Vendors } from "../toys.js";
import { catalogue, members } from "./index.js";


const { products, vendors } = collections;


/**
 * Single-string-per-tag localised value.
 *
 * The scalar branch of the QEST `Dictionary` umbrella, mapping each language {@link Tag | tag} to a single string.
 * Carried by single-valued localised properties such as `Vendor.label` and `Product.name`.
 */
type Local = { readonly [tag: Tag]: string };

/**
 * String-array-per-tag localised value.
 *
 * The multi-valued branch of the QEST `Dictionary` umbrella, mapping each language {@link Tag | tag} to a string array.
 * Carried by multi-valued localised properties such as `Product.keywords`.
 */
type Locals = { readonly [tag: Tag]: readonly string[] };


export function testRetrieveLocalised(factory: TestFactory): void {

	const VendorCatalogue = "https://data.example.net/vendors/";
	const ProductCatalogue = "https://data.example.net/products/";

	const coalesce = (value: Local): string | undefined => value.und;
	const enOf = (value: Local): string | undefined => value.en;
	const deOf = (value: Local): string | undefined => value.de;
	const sorted = (xs: readonly string[]): readonly string[] => [...xs].sort(ascending);

	// a localised property is delivered at the arity its own shape states, so a coalesced request on an
	// array-per-tag property hands back the winning tag's set; the shape-driven typing does not tell the two
	// access forms apart, the template no longer stating which was asked for

	const coalesced = (value: unknown): readonly string[] => (value ?? []) as readonly string[]; // ;(cast)
	const setOf = (value: Locals | undefined, priority: readonly string[]): readonly string[] => {
		if ( value === undefined ) {
			return [];
		} else {
			const tag = priority.find(t => value[t] !== undefined);
			return tag === undefined ? [] : value[tag];
		}
	};


	describe("lookup localised", () => {

		beforeAll(factory(async ({ populate }) => { await populate(); }).hook);


		describe("coalesced access — §6.2", () => {

			it("should coalesce a single-valued und-tagged property to a plain string", factory(async ({ store }) => {

				// §6.2: with no Accept-Language the whole priority defaults to the single tag `und`, so a
				// single-valued localised property whose map carries an `und` entry coalesces to that
				// string. The vendor `label` is stored und-tagged, so each row's coalesced label is its
				// und value.

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {}, label: {} })
				})) ?? [];

				expect(result).toHaveLength(vendors.length);

				vendors.forEach(v => {
					const row = result.find(r => r.id === v.id);
					expect(row?.label).toBe(coalesce(v.label));
				});

			}));

			it("should coalesce a property without an und entry to undefined under the und default", factory(async ({ store }) => {

				// §6.2: coalescing yields `undefined` when the map holds none of the priority's tags.
				// `Product.name` carries en/de/fr/it but no `und`, so under the `und` default it coalesces
				// to `undefined` and the label is omitted from each row.

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {}, name: {} })
				})) ?? [];

				expect(result).toHaveLength(products.length);
				result.forEach(r => expect(r.name).toBeUndefined());

			}));

			it("should default the locale priority to [und] when omitted (§6.2)", factory(async ({ store }) => {

				// §6.2: a processor MUST default the locale priority to ["und"] when no `locale` is supplied.
				// On the und-less `Product.name`, omitting `locale` therefore coalesces exactly as ["und"]
				// does (to `undefined`), and differently from a priority the map can satisfy such as ["en"] —
				// so the default is specifically ["und"], not "locale ignored".

				const model = catalogue({ id: {}, name: {} });
				const names = (rows: readonly { readonly id: string; readonly name?: unknown }[]) =>
					[...rows].sort(by(r => r.id)).map(r => r.name);

				const omitted = names(members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model
				})) ?? []);
				const und = names(members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model
				}, { locale: ["und"] })) ?? []);
				const en = names(members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model
				}, { locale: ["en"] })) ?? []);

				expect(omitted).toEqual(und);
				expect(omitted).not.toEqual(en);

			}));

			it("should lookup one property both structurally and coalesced (§6)", factory(async ({ store }) => {

				// §6: the same single-valued localised property is accessible both ways within one suite —
				// structurally (a tag-range map, tag-preserving) and coalesced (a plain string).

				const v = lookup(vendors, vendor => vendor.label !== undefined);

				if ( v === undefined ) { return; }

				const structural = (members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {}, label: { "*": {} } })
				})) ?? []).find(r => r.id === v.id);

				const coalesced = (members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {}, label: {} })
				})) ?? []).find(r => r.id === v.id);

				expect(structural?.label).toEqual(v.label);
				expect(coalesced?.label).toBe(coalesce(v.label));

			}));

		});


		describe("coalesced constraints — §6", () => {

			it("should order a collection by a coalesced localised property (§5.7.5)", factory(async ({ store }) => {

				// §6: ordering by a single-valued localised property targets its coalesced value. The
				// vendor label is und-tagged, so under the und default it coalesces to the und string and
				// the collection orders by that string under codepoint collation (§5.7.1).

				const expected = [...vendors]
					.sort(by(x => coalesce(x.label) ?? ""))
					.map(v => v.id);

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "^label": 1 })
				})) ?? [];

				expect(result.map(r => r.id)).toEqual(expected);

			}));

			it("should filter a collection by a coalesced localised property (§5.7.1)", factory(async ({ store }) => {

				// §6: a plain-string operand on a single-valued localised target constrains its coalesced
				// value as an ordinary string, here under codepoint comparison (§5.7.1).

				const bound = "M";
				const expected = vendors.filter(v => (coalesce(v.label) ?? "") >= bound).map(v => v.id).sort();

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { ">=label": bound })
				})) ?? [];

				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should substring-search a collection by a coalesced localised property (§5.7.2)", factory(async ({ store }) => {

				// §6 + §5.7.2: a plain-string `~` operand targets the coalesced value; tokens match as
				// case-insensitive substrings regardless of order. "Giochi Piccoli" matches the coalesced
				// "Piccoli Giochi Srl" (order-swapped), confirming substring + order-insignificance on the
				// coalesced string.

				const query = "Giochi Piccoli";
				const tokens = query.toLowerCase().split(/\s+/);
				const criteria = (v: { label: Local }): boolean => {
					const haystack = (coalesce(v.label) ?? "").toLowerCase();
					return tokens.every(token => haystack.includes(token));
				};
				const expected = vendors.filter(criteria).map(v => v.id).sort();

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "~label": query })
				})) ?? [];

				expect(expected.length).toBeGreaterThan(0);
				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should set-match a collection by a coalesced localised property (§5.7.3)", factory(async ({ store }) => {

				// §6: a plain (untagged) option on a single-valued localised target matches its coalesced
				// value by string equality (§5.7.3), as opposed to a tagged option which matches
				// structurally per tag.

				const option = "ToyMaster GmbH";
				const expected = vendors.filter(v => coalesce(v.label) === option).map(v => v.id).sort();

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "?label": [option] })
				})) ?? [];

				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should focus a collection by a coalesced localised property (§5.7.4)", factory(async ({ store }) => {

				// §6: a plain option under `+` ranks resources whose coalesced value is in the option set
				// first (§5.7.4), keeping the rest of the order.

				const option = "ToyMaster GmbH";
				const focal = lookup(vendors, v => coalesce(v.label) === option);

				if ( focal === undefined ) { return; }

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {} }, { "+label": [option] })
				})) ?? [];

				expect(result).toHaveLength(vendors.length);
				expect(result[0]?.id).toBe(focal.id);

			}));

		});


		describe("structural matching — §5.7.3", () => {

			it("should set-match a localised property by tagged option", factory(async ({ store }) => {

				// §5.7.3: a localised text option set matches by tagged-value equality; the `en` entry
				// matches stored values tagged `en`, independent of language negotiation.

				const target = lookup(products, p => enOf(p.name) !== undefined);

				if ( target === undefined ) { return; }

				const enName = enOf(target.name);

				if ( enName === undefined ) { return; }

				const expected = products.filter(p => enOf(p.name) === enName).map(p => p.id).sort();

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "?name": { en: enName } })
				})) ?? [];

				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should set-match a localised property by tagged option under `!`", factory(async ({ store }) => {

				// §5.7.3: tagged-value equality holds under `!` as under `?` — the singleton en
				// option must equal a stored en-tagged value

				const target = lookup(products, p => enOf(p.name) !== undefined);
				const enName = target === undefined ? undefined : enOf(target.name);

				if ( enName === undefined ) { return; }

				const expected = products.filter(p => enOf(p.name) === enName).map(p => p.id).sort();

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "!name": { en: enName } })
				})) ?? [];

				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should set-match a localised property by a single-tag multi-valued option", factory(async ({ store }) => {

				// §5.7.3: an array-per-tag option is an existential set — a resource matches when its
				// en-tagged value equals any listed value, so both listed names are selected. A processor
				// that stringifies the value array instead of expanding it would match neither.

				const first = lookup(products, p => enOf(p.name) !== undefined);

				if ( first === undefined ) { return; }

				const enName1 = enOf(first.name);

				if ( enName1 === undefined ) { return; }

				const second = lookup(products, p => enOf(p.name) !== undefined && enOf(p.name) !== enName1);

				if ( second === undefined ) { return; }

				const enName2 = enOf(second.name);

				if ( enName2 === undefined ) { return; }

				const expected = products
					.filter(p => enOf(p.name) === enName1 || enOf(p.name) === enName2)
					.map(p => p.id).sort();

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "?name": { en: [enName1, enName2] } })
				})) ?? [];

				expect(expected.length).toBeGreaterThan(1);
				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should set-match a localised property by a multi-tag single-valued option", factory(async ({ store }) => {

				// §5.7.3: a multi-tag option matches existentially per tag — a resource matches when its en
				// value equals the en entry OR its de value equals the de entry. The de entry is drawn from a
				// different product, so a processor that keeps only the first tag would drop that match.

				const enTarget = lookup(products, p => enOf(p.name) !== undefined);

				if ( enTarget === undefined ) { return; }

				const enName = enOf(enTarget.name);

				if ( enName === undefined ) { return; }

				const deTarget = lookup(products, p => deOf(p.name) !== undefined && p.id !== enTarget.id);

				if ( deTarget === undefined ) { return; }

				const deName = deOf(deTarget.name);

				if ( deName === undefined ) { return; }

				const expected = products
					.filter(p => enOf(p.name) === enName || deOf(p.name) === deName)
					.map(p => p.id).sort();

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "?name": { en: enName, de: deName } })
				})) ?? [];

				expect(expected).toContain(deTarget.id);
				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should set-match a localised property by a multi-tag multi-valued option", factory(async ({ store }) => {

				// §5.7.3: tags and per-tag value arrays flatten into one existential set — a resource matches
				// on any listed en value or the listed de value. The de entry singles out a third product, so a
				// processor that keeps only the first tag or stringifies the value arrays would miss matches.

				const first = lookup(products, p => enOf(p.name) !== undefined);

				if ( first === undefined ) { return; }

				const enName1 = enOf(first.name);

				if ( enName1 === undefined ) { return; }

				const second = lookup(products, p => enOf(p.name) !== undefined && enOf(p.name) !== enName1);

				if ( second === undefined ) { return; }

				const enName2 = enOf(second.name);

				if ( enName2 === undefined ) { return; }

				const deTarget = lookup(products, p =>
					deOf(p.name) !== undefined && p.id !== first.id && p.id !== second.id);

				if ( deTarget === undefined ) { return; }

				const deName = deOf(deTarget.name);

				if ( deName === undefined ) { return; }

				const expected = products
					.filter(p => enOf(p.name) === enName1 || enOf(p.name) === enName2 || deOf(p.name) === deName)
					.map(p => p.id).sort();

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "?name": { en: [enName1, enName2], de: [deName] } })
				})) ?? [];

				expect(expected).toContain(deTarget.id);
				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should conjunctively set-match a localised property by a multi-tag option under `!`", factory(async ({ store }) => {

				// §5.7.3: under `!` every tagged option must hold, so an en entry from one product paired with a
				// de entry from another selects only resources carrying BOTH tagged values — none here, since
				// names are distinct per product. A processor that keeps only the first tag would drop the de
				// conjunct and wrongly match the en-only product.

				const enTarget = lookup(products, p => enOf(p.name) !== undefined);

				if ( enTarget === undefined ) { return; }

				const enName = enOf(enTarget.name);

				if ( enName === undefined ) { return; }

				const deTarget = lookup(products, p => deOf(p.name) !== undefined && p.id !== enTarget.id);

				if ( deTarget === undefined ) { return; }

				const deName = deOf(deTarget.name);

				if ( deName === undefined ) { return; }

				const expected = products
					.filter(p => enOf(p.name) === enName && deOf(p.name) === deName)
					.map(p => p.id).sort();

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "!name": { en: enName, de: deName } })
				})) ?? [];

				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

		});


		describe("language negotiation — §6.1", () => {

			it("should coalesce to the requested priority language", factory(async ({ store }) => {

				// §6.2: coalescing selects the value of the first priority tag present in the map. With
				// locale ["en"], a name carrying an `en` entry coalesces to its `en` value, unlike the
				// und default which yields undefined for the und-less Product.name.

				const target = lookup(products, p => enOf(p.name) !== undefined);

				if ( target === undefined ) { return; }

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {}, name: {} })
				}, { locale: ["en"] })) ?? [];

				const row = result.find(r => r.id === target.id);
				expect(row?.name).toBe(enOf(target.name));

			}));

			it("should fall through to the next priority tag when the first is absent", factory(async ({ store }) => {

				// §6.1/§6.2: priority tags are matched in order; an absent leading tag falls through. No
				// name carries `zxx`, so locale ["zxx","de"] coalesces to the `de` value.

				const target = lookup(products, p => deOf(p.name) !== undefined);

				if ( target === undefined ) { return; }

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {}, name: {} })
				}, { locale: ["zxx", "de"] })) ?? [];

				const row = result.find(r => r.id === target.id);
				expect(row?.name).toBe(deOf(target.name));

			}));

			it("should order a collection by a coalesced localised property in the requested language (§5.7.5)", factory(async ({ store }) => {

				// §6 + §5.7.5: ordering by a single-valued localised property targets its coalesced value
				// under the request locale. With locale ["en"], products order by their coalesced en name
				// under codepoint collation (§5.7.1).

				const enName = (value: Local): string => enOf(value) ?? "";
				const expected = [...products].sort(by(p => enName(p.name))).map(p => p.id);

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "^name": 1 })
				}, { locale: ["en"] })) ?? [];

				expect(result.map(r => r.id)).toEqual(expected);

			}));

			it("should coalesce each cell independently, mixing languages across the response (§6.3)", factory(async ({ store }) => {

				// §6.3: coalescing resolves each cell independently, so one response may carry different
				// languages per row. Product.description has uneven tag coverage, so with locale
				// ["it","de","en"] each description coalesces to the first of those tags present in its
				// own map — different per product, mixing languages across the response.

				const priority = ["it", "de", "en"];
				const tagOf = (value: Local): string | undefined => priority.find(t => value[t] !== undefined);
				const coalesceBy = (value: Local): string | undefined => {
					const tag = tagOf(value);
					return tag === undefined ? undefined : value[tag];
				};

				const described = products.filter(p => p.description !== undefined);

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {}, description: {} })
				}, { locale: priority })) ?? [];

				described.forEach(p => {
					const row = result.find(r => r.id === p.id);
					expect(row?.description).toBe(coalesceBy(p.description!));
				});

				// the response genuinely mixes languages: described rows resolve to more than one tag
				expect(new Set(described.map(p => tagOf(p.description!))).size).toBeGreaterThan(1);

			}));

			it("should take an out-of-band priority literally, without appending und (§6.2)", factory(async ({ store }) => {

				// §6.2: an out-of-band priority is literal — the trailing und belongs to the §6.1
				// negotiation derivation and processors MUST NOT append it. The und-tagged vendor
				// labels hold no en entry, so a literal ["en"] priority coalesces them away instead
				// of falling back to their und values.

				const result = members(await store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {}, label: {} })
				}, { locale: ["en"] })) ?? [];

				expect(result).toHaveLength(vendors.length);
				result.forEach(r => expect(r.label).toBeUndefined());

			}));

		});


		describe("coalesced array-per-tag access — §5.3/§6.2", () => {

			// §5.3/§6.2: a coalesced array-per-tag property behaves as an ordinary multi-valued string
			// collection — the winning tag's value set reduced to plain strings under language
			// negotiation. `Product.keywords` is array-per-tag over en/de/fr/it with no `und` entry, so
			// under the `und` default it coalesces away and under ["en"] it coalesces to each product's
			// en keyword set.

			const EN: readonly string[] = ["en"];

			// §5.4: a localised property is asked for coalesced through the atomic placeholder, which yields the
			// label resolved under the request.s language priority; the tag-range map asks for it structurally
			const COALESCED = {};

			it("should coalesce an array-per-tag property to a plain-string array", factory(async ({ store }) => {

				// §6.2: the coalesced `[""]` form reduces the winning tag's value set to a plain string
				// array; under ["en"] each keyworded product's row carries its en keyword set (a set, so
				// order is immaterial).

				const keyworded = products.filter(p => setOf(p.keywords, EN).length > 0);

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {}, keywords: COALESCED })
				}, { locale: EN })) ?? [];

				expect(keyworded.length).toBeGreaterThan(0);

				keyworded.forEach(p => {
					const row = result.find(r => r.id === p.id);
					expect(sorted(coalesced(row?.keywords))).toEqual(sorted(setOf(p.keywords, EN)));
				});

			}));

			it("should coalesce an array-per-tag property without the priority tag to undefined", factory(async ({ store }) => {

				// §6.2: with no priority tag present the coalesced set is empty, so the property is
				// omitted from each row. Keywords carry no `und`, so under the und default they coalesce
				// away, exactly as the single-valued und-less `Product.name` does.

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {}, keywords: COALESCED })
				})) ?? [];

				expect(result).toHaveLength(products.length);
				result.forEach(r => expect(r.keywords).toBeUndefined());

			}));

			it("should coalesce each array-per-tag cell independently, mixing languages across the response (§6.3)", factory(async ({ store }) => {

				// §6.3: coalescing resolves each cell independently, so one response may carry different
				// languages per row. Keywords have uneven tag coverage, so with ["it","de","en"] each
				// product's keyword set resolves to the first of those tags present in its own map.

				const priority = ["it", "de", "en"];
				const tagOf = (value: Locals | undefined): string | undefined =>
					value === undefined ? undefined : priority.find(t => value[t] !== undefined);
				const keyworded = products.filter(p => setOf(p.keywords, priority).length > 0);

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {}, keywords: COALESCED })
				}, { locale: priority })) ?? [];

				keyworded.forEach(p => {
					const row = result.find(r => r.id === p.id);
					expect(sorted(coalesced(row?.keywords))).toEqual(sorted(setOf(p.keywords, priority)));
				});

				// the response genuinely mixes languages: resolved tags span more than one language
				expect(new Set(keyworded.map(p => tagOf(p.keywords))).size).toBeGreaterThan(1);

			}));

			it("should substring-search a collection by a coalesced array-per-tag property (§5.7.2)", factory(async ({ store }) => {

				// §6 + §5.7.2: a coalesced multi-valued target is searchable existentially — a product
				// matches when at least one of its coalesced keywords contains the query token.

				const query = "dino";
				const matches = (p: typeof products[number]): boolean =>
					setOf(p.keywords, EN).some(k => k.toLowerCase().includes(query));
				const expected = products.filter(matches).map(p => p.id).sort();

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "~keywords": query })
				}, { locale: EN })) ?? [];

				expect(expected.length).toBeGreaterThan(0);
				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should compare a collection by a coalesced array-per-tag property by at-least-one-value (§5.7.1)", factory(async ({ store }) => {

				// §6 + §5.7.1: a comparison over a coalesced multi-valued target matches existentially —
				// a product matches when at least one coalesced keyword satisfies the bound under
				// codepoint comparison.

				const bound = "t";
				const expected = products.filter(p => setOf(p.keywords, EN).some(k => k >= bound)).map(p => p.id).sort();

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { ">=keywords": bound })
				}, { locale: EN })) ?? [];

				expect(expected.length).toBeGreaterThan(0);
				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should set-match a collection by a coalesced array-per-tag property (§5.7.3)", factory(async ({ store }) => {

				// §6 + §5.7.3: a plain option set over a coalesced multi-valued target matches
				// existentially — a product matches when at least one coalesced keyword equals an option.

				const options = ["dinosaur", "space"];
				const matches = (p: typeof products[number]): boolean =>
					setOf(p.keywords, EN).some(k => options.includes(k));
				const expected = products.filter(matches).map(p => p.id).sort();

				const result = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { "?keywords": options })
				}, { locale: EN })) ?? [];

				expect(expected.length).toBeGreaterThan(0);
				expect(result.map(r => r.id).sort()).toEqual(expected);

			}));

			it("should aggregate a coalesced array-per-tag set per item (§5.8.1)", factory(async ({ store }) => {

				// §6 + §5.8.1: the coalesced step contributes the winning-tag value set, so the aggregate
				// reduces over real values. Under ["en"] a `>=count 1` bound admits every keyworded
				// product; under the und default the coalesced set is empty, so the same bound admits
				// none.

				const expected = products.filter(p => setOf(p.keywords, EN).length >= 1).map(p => p.id).sort();

				const en = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { ">=count:keywords": 1 })
				}, { locale: EN })) ?? [];

				const und = members(await store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, { ">=count:keywords": 1 })
				})) ?? [];

				expect(expected.length).toBeGreaterThan(0);
				expect(en.map(r => r.id).sort()).toEqual(expected);
				expect(und).toHaveLength(0);

			}));

			const rejectedKeys: ReadonlyArray<readonly [string, Criteria]> = [
				["sort", { "^keywords": 1 }],
				["focus", { "+keywords": ["gadget"] }]
			];

			it.each(rejectedKeys)("should reject a direct %s over a coalesced array-per-tag property as a multi-valued target", (_label, selection) => factory(async ({ store }) => {

				// §5.7.4/§5.7.5: sort and focus are single-valued contexts, so a multi-valued coalesced
				// set is no more a sort or focus key than any other multi-valued property.

				await expect(store.lookup({
					entry: ProductCatalogue,
					shape: Products,
					model: catalogue({ id: {} }, selection)
				}, { locale: EN })).rejects.toThrow();

			})());

			// the per-tag arity cases the previous notation carried — `[""]` admissible only over an array-per-tag
			// property and `""` only over a single-string one — have no subject: a coalesced request is the atomic
			// `{}` whatever the property, the arity coming from the shape rather than from the placeholder (§5.4)

			const extendedRanges: ReadonlyArray<readonly [string, string]> = [
				["a trailing-wildcard subtag", "de-*"],
				["a leading-wildcard subtag", "*-CH"]
			];

			it.each(extendedRanges)("should reject %s extended language range as a tag-range key (§5.3)", (_label, range) => factory(async ({ store }) => {

				// §5.3: a tag-range key MUST be a basic language range (a subtag sequence or the standalone `*`
				// wildcard). An extended range carrying `*` in a leading, interior, or trailing subtag position
				// (`de-*`, `*-CH`) MUST be rejected, while the basic `*` wildcard stays admissible.

				await expect(store.lookup({
					entry: VendorCatalogue,
					shape: Vendors,
					model: catalogue({ id: {}, label: { [range]: {} } })
				})).rejects.toThrow();

			})());

		});

	});

}
