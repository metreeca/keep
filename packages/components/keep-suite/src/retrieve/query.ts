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
 * Per-arm coverage of selection on multi-valued properties of a directly-retrieved resource.
 *
 * Consolidates the collection-retrieval contract in one place: the multi-valued
 * {@link @metreeca/qest/template!Placeholders} arms — a bare `Locales`, `[Placeholder, Selection?]`, and
 * `[Union, Selection?]` — against single-resource retrievals. Localised slots carry no inline
 * `Selection` (`Locales` reaches `Placeholders` as its own arm, never a `Query` element), so the
 * `Locales` arm is exercised bare only; the `[Placeholder, Selection?]` and `[Union, Selection?]`
 * arms are exercised both bare and with a `Selection` (filter / order / slice) attached in the
 * tuple's second slot. The `[Projection, Selection?]` arm is exclusively covered by
 * `projection.ts` (catalogue-scoped); cross-cutting selection on projection sub-collections is
 * tracked as a follow-up gap.
 *
 * Catalogue-scoped selection is covered by `selection.ts`; this suite focuses on the case
 * where the multi-valued slot lives on the resource itself.
 *
 * @module retrieve/query
 */

import { dictionary } from "@metreeca/blue/dictionary";
import { reference } from "@metreeca/blue/reference";
import { id, multiple, required, resource } from "@metreeca/blue/resource";
import { string, url } from "@metreeca/blue/string";
import { union } from "@metreeca/blue/union";
import { isObject } from "@metreeca/core";
import { beforeAll, describe, expect, it } from "vitest";
import { model } from "../_model.js";
import { lookup, type TestFactory } from "../index.core.js";
import { collections } from "../toys.core.js";
import { Category, Contacts, Image, Media, Product, Products, Vendor, Video } from "../toys.js";
import { catalogue, collection, members } from "./index.js";


const { products, vendors } = collections;


export function testRetrieveQuery(factory: TestFactory): void {

	const Catalogue = "https://data.example.net/products/";

	describe("lookup query", () => {

		beforeAll(factory(async ({ populate }) => { await populate(); }).hook);


		describe("locale — §5.3", () => {

			// Localised properties are inherently multi-valued (qest §10) and carry no inline
			// `Selection` — `Locales` reaches `Placeholders` as its own arm, never a `Query` element. Filtering or
			// ordering by a localised value attaches at the enclosing collection's `Selection` through an
			// `Expression`, with the target language supplied out-of-band, never inline on the slot.

			it("should lookup every requested tag without selection", factory(async ({ store }) => {

				const target = lookup(products, p => isObject(p.keywords));

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Product,
					model: model(resource({ keywords: multiple(dictionary({ languageIn: ["en"] })) }))
				});

				expect(result?.keywords).toBeDefined();

			}));

			it("should lookup only tags matching the requested range", factory(async ({ store }) => {

				const target = lookup(products, p => Object.keys(p.keywords ?? {}).length > 1);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Product,
					model: model(resource({ keywords: multiple(dictionary({ languageIn: ["en"] })) }))
				});

				expect(Object.keys(result?.keywords ?? {})).toEqual(["en"]);

			}));

		});


		describe("[placeholder] (scalar collection) — §5.5", () => {

			// Bare `[Placeholder]` with no Selection attached. Selection on scalar primitives is
			// expressed through the second tuple slot `[Placeholder, Selection]`,
			// here authored through the local `collection(element, selection)` helper.

			it("should lookup every element without selection", factory(async ({ store }) => {

				const target = lookup(vendors, v => (v.aliases?.length ?? 0) > 0);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: model(resource({ aliases: multiple(string()) }))
				});

				expect(result?.aliases?.length ?? 0).toBeGreaterThan(0);

			}));

			it("should filter via attached selection on string length", factory(async ({ store }) => {

				const target = lookup(vendors, v => (v.aliases?.length ?? 0) > 0);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: { aliases: collection(string(), { ">=length:": 4 }) }
				});

				(result?.aliases ?? []).forEach(a => expect(a.length).toBeGreaterThanOrEqual(4));

			}));

			it("should order via attached selection", factory(async ({ store }) => {

				const target = lookup(vendors, v => (v.aliases?.length ?? 0) > 1);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: { aliases: collection(string(), { "^": "asc" }) }
				});

				const aliases = result?.aliases ?? [];

				expect([...aliases]).toEqual([...aliases].sort());

			}));

			it("should limit via attached selection", factory(async ({ store }) => {

				const target = lookup(vendors, v => (v.aliases?.length ?? 0) > 1);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: { aliases: collection(string(), { "#": 1 }) }
				});

				expect(result?.aliases?.length ?? 0).toBeLessThanOrEqual(1);

			}));

			it("should offset via attached selection", factory(async ({ store }) => {

				// `@` is the slice operator paired with `#` (limit): offsetting past the first element
				// of a set drops exactly one value, whatever the default order.

				const target = lookup(vendors, v => (v.aliases?.length ?? 0) > 1);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: { aliases: collection(string(), { "@": 1 }) }
				});

				expect(result?.aliases?.length ?? 0).toBe((target.aliases?.length ?? 0)-1);

			}));

		});


		describe("[union, selection?] — §5.5", () => {

			// Multi-valued union elements covering primitive and embedded Template branches —
			// `Vendor.contacts` mixes string variants (email, phone) and a PostalAddress embedded
			// resource branch. Union shape shared with the template suite via `Contacts`.

			it("should lookup mixed-branch elements without selection", factory(async ({ store }) => {

				const target = lookup(vendors, v => (v.contacts?.length ?? 0) > 0);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: model(resource({ contacts: multiple(Contacts) }))
				});

				expect(result?.contacts?.length ?? 0).toBeGreaterThan(0);

			}));

			it("should preserve per-branch nested template expansion", factory(async ({ store }) => {

				const target = lookup(vendors, v => v.contacts?.some(c => isObject(c)) ?? false);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: model(resource({ contacts: multiple(Contacts) }))
				});

				const embedded = (result?.contacts ?? []).filter(c => typeof c !== "string");

				embedded.forEach(c => {
					if ( "latitude" in c ) {
						expect(c.latitude).toBeDefined();
						expect(c.longitude).toBeDefined();
					} else {
						expect(c.street).toBeDefined();
						expect(c.city).toBeDefined();
					}
				});

			}));

			it("should filter elements by a variant-only path (§5.7.1)", factory(async ({ store }) => {

				// §5.7.1 / §5.8: `latitude` is declared only on the Place variant of the contacts
				// member union, so the bound selects exactly the Place elements satisfying it;
				// string and PostalAddress elements carry no value on the path and never match

				const target = lookup(vendors, v =>
					v.contacts?.some(c => isObject(c) && "latitude" in c) ?? false
				);

				if ( target === undefined || target.contacts === undefined ) { return; }

				const expected = target.contacts.filter(c =>
					isObject(c) && "latitude" in c && c.latitude > 0
				);

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: { contacts: collection(Contacts, { ">latitude": 0 }) }
				});

				expect(result?.contacts).toHaveLength(expected.length);

			}));

			it("should limit elements via attached selection", factory(async ({ store }) => {

				const target = lookup(vendors, v => (v.contacts?.length ?? 0) > 1);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: { contacts: collection(Contacts, { "#": 1 }) }
				});

				expect(result?.contacts?.length ?? 0).toBeLessThanOrEqual(1);

			}));

			it("should order union elements by a branch-only path, undefined-first (§5.7.5)", factory(async ({ store }) => {

				// §5.8.1: `street` resolves only on the PostalAddress branch; on the string branches it
				// is undefined. §5.7.5 total order places undefined first, so the string elements
				// precede the PostalAddress element.

				const target = lookup(vendors, v =>
					(v.contacts ?? []).some(c => typeof c === "object")
					&& (v.contacts ?? []).some(c => typeof c === "string")
				);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: { contacts: collection(Contacts, { "^street": 1 }) }
				});

				const got = result?.contacts ?? [];
				const firstObject = got.findIndex(c => typeof c === "object");

				expect(firstObject).toBeGreaterThan(0);
				expect(got.slice(firstObject).every(c => typeof c === "object")).toBe(true);

			}));

		});


		describe("[union, selection?] — heterogeneous reference variants (media) — §5.5", () => {

			// Product.media: multiple(union(reference(Image), reference(Video))) — a captive gallery whose
			// items are two DIFFERENT resource shapes (Image {width,height} vs Video {duration}). The slot
			// keys "0"/"1" are opaque (§5.4): each nested Template singles out its branch by structure
			// ({width,height} → Image, {duration} → Video), and every item MUST decode under the branch
			// matching its own variant, not merely the first nested variant.

			it("should decode each media item under its own variant branch", factory(async ({ store }) => {

				const target = lookup(products, { sku: "AF-001" });

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Product,
					model: model(resource({ media: multiple(union(Image, Video)) }))
				});

				const items = result?.media ?? [];

				expect(items).toHaveLength(2);
				expect(items.some(m => "width" in m && "height" in m)).toBe(true);  // image branch
				expect(items.some(m => "duration" in m)).toBe(true);               // video branch

			}));

			it("should retrieve the common reference subset across union branches", factory(async ({ store }) => {

				// A bare reference placeholder over the media union matches every branch by kind (§5.4)
				// and retrieves each item's shared reference identity — the id common to both the Image
				// and Video branches — rather than any branch-specific structure.

				const target = lookup(products, { sku: "AF-001" });

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Product,
					model: model(resource({ media: multiple(Media) }))
				});

				const expected = [...(target.media ?? [])].sort();
				const got = [...(result?.media ?? [])].sort();

				expect(got).toEqual(expected);

			}));

		});


		describe("contract", () => {

			// qest §5.4, §10.2, §11.3 — vacuous template / locale / union forms must elide as
			// if the property were omitted from the enclosing template.

			it("should preserve focus when a multi-valued slot is empty", factory(async ({ store }) => {

				const target = lookup(vendors, v => v.aliases === undefined || v.aliases.length === 0);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Vendor,
					model: model(resource({
						id: id(),
						code: required(string()),
						aliases: multiple(string())
					}))
				});

				expect(result?.id).toBe(target.id);
				expect(result?.code).toBe(target.code);
				expect(result).not.toHaveProperty("aliases");

			}));

			it("should retain sibling scalars when a multi-valued slot is requested", factory(async ({ store }) => {

				const target = lookup(products, p => isObject(p.keywords));

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Product,
					model: model(resource({
						sku: required(string()),
						keywords: multiple(dictionary({ languageIn: ["en"] }))
					}))
				});

				expect(result?.sku).toBe(target.sku);

			}));

		});


		describe("[template] (structured collection) — reconstruction §5.5", () => {

			// A collection retrieved with a nested Template element returns structured members, each
			// reconstructed from its own row-group. When a member carries multi-valued slots, the flat
			// SELECT fans the cross-product of their values (documents × categories), so reconstruction
			// MUST regroup by member identity and de-duplicate each slot — never surface the cross-product
			// as duplicate members or repeated values.

			it("should reconstruct each member's multi-valued slots without cross-product duplication", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						id: id(),
						documents: multiple(url()),
						categories: multiple(reference(Category))
					}))
				})) ?? [];

				// one member per product — not one per (document, category) pair

				expect(result).toHaveLength(products.length);

				result.forEach(member => {

					const product = lookup(products, { id: member.id });

					if ( product === undefined ) { return; }

					// each slot carries its member's own de-duplicated value set, the cross-product collapsed

					expect([...(member.documents ?? [])].sort()).toEqual([...product.documents].sort());
					expect([...(member.categories ?? [])].sort()).toEqual([...product.categories].sort());

				});

			}));

		});


		describe("multiple slots on one resource — §5.5", () => {

			// reading several multi-valued slots in a single lookup settles each slot independently: the values
			// of one slot never leak into another and none is dropped, whether the lookup reaches one slot
			// (a single-request batch) or many (a multi-request batch)

			it("should reconstruct a single multi-valued slot", factory(async ({ store }) => {

				const target = lookup(products, p => p.documents.length > 0);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Product,
					model: model(resource({ documents: multiple(url()) }))
				});

				expect([...(result?.documents ?? [])].sort()).toEqual([...target.documents].sort());

			}));

			it("should apply an independent window to each of two batched slots", factory(async ({ store }) => {

				// two windowed sub-collections in one lookup enqueue two select requests, batched into one
				// round and demultiplexed by the guard column: each slot's own offset/limit applies to its
				// own stream, never bleeding across (counts are order-independent, so no sort key is needed)

				const target = lookup(products, p => p.documents.length >= 2 && p.categories.length >= 2);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Product,
					model: {
						documents: collection(url(), { "#": 1 }),
						categories: collection(reference(Category), { "@": 1 })
					}
				});

				expect(result?.documents).toHaveLength(1);
				expect(result?.categories).toHaveLength(target.categories.length-1);

			}));

			it("should reconstruct two multi-valued slots independently", factory(async ({ store }) => {

				const target = lookup(products, p => p.documents.length > 0 && p.categories.length > 0);

				if ( target === undefined ) { return; }

				const result = await store.lookup({
					entry: target.id,
					shape: Product,
					model: model(resource({
						documents: multiple(url()),
						categories: multiple(reference(Category))
					}))
				});

				expect([...(result?.documents ?? [])].sort()).toEqual([...target.documents].sort());
				expect([...(result?.categories ?? [])].sort()).toEqual([...target.categories].sort());

			}));

		});

	});

}
