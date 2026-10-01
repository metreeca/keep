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

import { isObject, isString } from "@metreeca/core";
import { beforeAll, describe, expect, it } from "vitest";
import { lookup, type TestFactory } from "../index.core.js";
import { collections } from "../toys.core.js";
import { Category, Product, Products, Vendor, Vendors } from "../toys.js";


const { categories, products, vendors } = collections;


const withContacts = lookup(vendors, v => (v.contacts?.length ?? 0) > 0);


export function testRetrieveTemplate(factory: TestFactory): void {

	const AF001 = lookup(products, { sku: "AF-001" })!;


	describe("template", () => {

		beforeAll(factory(async ({ populate }) => { await populate(); }).hook);


		describe("scalar properties — §5.3", () => {

			describe("literals", () => {

				it("should project requested scalar fields", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { sku: {}, price: {}, stock: {}, condition: {} }
					});

					expect(result?.sku).toBe(AF001.sku);
					expect(result?.price).toBe(AF001.price);
					expect(result?.stock).toBe(AF001.stock);
					expect(result?.condition).toBe(AF001.condition);

				}));

				it("should exclude fields not specified in the model", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { price: {} }
					});

					expect(result?.price).toBe(AF001.price);
					expect(result).not.toHaveProperty("sku");
					expect(result).not.toHaveProperty("name");

				}));

				it("should retrieve a leaf through the atomic placeholder (§5.3)", factory(async ({ store }) => {

					// §5.3: a placeholder carries no value of its own, so every leaf is the atomic `{}` and the
					// retrieved value comes back under the property's own key

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { sku: {}, price: {} }
					});

					expect(result?.sku).toBe(AF001.sku);
					expect(result?.price).toBe(AF001.price);

				}));

				it("should return undefined for an absent optional scalar", factory(async ({ store }) => {

					const noLaunched = lookup(products, p => p.launched === undefined);

					if ( !noLaunched ) { return; }

					const result = await store.lookup({
						entry: noLaunched.id,
						shape: Product,
						model: { sku: {}, launched: {} }
					});

					expect(result?.sku).toBe(noLaunched.sku);
					expect(result?.launched).toBeUndefined();

				}));

			});

			describe("references (id-only)", () => {

				it("should return a required scalar reference as id", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { vendor: {} }
					});

					expect(result?.vendor).toBe(AF001.vendor);

				}));

				it("should return an optional reference as id when present", factory(async ({ store }) => {

					const child = lookup(categories, { code: "1100" })!;

					const result = await store.lookup({
						entry: child.id,
						shape: Category,
						model: { broader: {} }
					});

					expect(result?.broader).toBe(child.broader);

				}));

				it("should return an optional reference as undefined when absent", factory(async ({ store }) => {

					const root = lookup(categories, { code: "1000" })!;

					const result = await store.lookup({
						entry: root.id,
						shape: Category,
						model: { broader: {} }
					});

					expect(result?.broader).toBeUndefined();

				}));

				// the reference-placeholder cases the previous notation carried — any string satisfying the
				// IRI-reference production accepted as a placeholder, anything else rejected — have no subject:
				// a placeholder carries no value of its own, so a reference is asked for through the atomic `{}`

			});

			describe("references (expanded)", () => {

				it("should expand a scalar reference with properties", factory(async ({ store }) => {

					const expected = lookup(vendors, { id: AF001.vendor })!;

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { vendor: { name: {}, email: {}, code: {} } }
					});

					expect(result?.vendor?.name).toBe(expected.name);
					expect(result?.vendor?.email).toBe(expected.email);
					expect(result?.vendor?.code).toBe(expected.code);

				}));

				it("should exclude unrequested fields on an expanded reference", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { vendor: { name: {} } }
					});

					expect(result?.vendor?.name).toBeDefined();
					expect(result?.vendor).not.toHaveProperty("email");
					expect(result?.vendor).not.toHaveProperty("code");

				}));

				it("should expand self-referential reference with properties", factory(async ({ store }) => {

					const child = lookup(categories, { code: "1100" })!;
					const parent = lookup(categories, { id: child.broader! })!;

					const result = await store.lookup({
						entry: child.id,
						shape: Category,
						model: { broader: { code: {}, title: { en: {} } } }
					});

					expect(result?.broader?.code).toBe(parent.code);
					expect(result?.broader?.title?.en).toBe(parent.title.en);

				}));

				it("should expand nested references three levels deep", factory(async ({ store }) => {

					const leaf = lookup(categories, { code: "1110" })!;
					const mid = lookup(categories, { code: "1100" })!;
					const root = lookup(categories, { code: "1000" })!;

					const result = await store.lookup({
						entry: leaf.id,
						shape: Category,
						model: {
							title: { en: {} },
							broader: { title: { en: {} }, broader: { title: { en: {} } } }
						}
					});

					expect(result?.title?.en).toBe(leaf.title.en);
					expect(result?.broader?.title?.en).toBe(mid.title.en);
					expect(result?.broader?.broader?.title?.en).toBe(root.title.en);

				}));

				it("should project root id and type together with expanded reference", factory(async ({ store }) => {

					const expected = lookup(vendors, { id: AF001.vendor })!;

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { id: {}, type: {}, vendor: { name: {} } }
					});

					expect(result?.id).toBe(AF001.id);
					expect(result?.type).toBe(AF001.type);
					expect(result?.vendor?.name).toBe(expected.name);

				}));

			});

		});

		describe("array properties — §5.3", () => {

			describe("literals", () => {

				it("should project multi-valued scalar fields", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { documents: {} }
					});

					expect(result?.documents).toBeInstanceOf(Array);
					expect([...(result?.documents ?? [])].sort()).toEqual([...AF001.documents].sort());

				}));

				// a true plain-literal array (`Vendor.aliases`, `multiple(string())`): an absent optional
				// one is omitted, never surfaced as an empty array (localised absence lives under
				// `localised properties`, so this stays a pure literal-array probe)
				it("should omit an absent optional array", factory(async ({ store }) => {

					const noAliases = lookup(vendors, v => v.aliases === undefined);

					if ( !noAliases ) { return; }

					const result = await store.lookup({
						entry: noAliases.id,
						shape: Vendor,
						model: { aliases: {} }
					});

					expect(result).not.toHaveProperty("aliases");

				}));

			});

			describe("references (id-only)", () => {

				it("should return multi-valued references as array of ids", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { categories: {} }
					});

					expect(result?.categories).toBeInstanceOf(Array);
					expect(result?.categories).toHaveLength(AF001.categories.length);
					expect([...(result?.categories ?? [])].sort())
						.toEqual([...AF001.categories].sort());

				}));

			});

			describe("references (expanded)", () => {

				it("should expand multi-valued references with properties", factory(async ({ store }) => {

					const fixtures = AF001.categories.map(id => lookup(categories, { id })!);

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { categories: { code: {}, title: { en: {} } } }
					});

					expect(result?.categories).toHaveLength(AF001.categories.length);

					result?.categories?.forEach(c => {
						const fixture = lookup(fixtures, { code: c.code })!;
						expect(c.title?.en).toBe(fixture.title.en);
					});

				}));

			});

			describe("embedded resources", () => {

				it("should detail embedded resources inline", factory(async ({ store }) => {

					const reviews = AF001.reviews!;

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { reviews: { author: {}, rating: {} } }
					});

					expect(result?.reviews).toBeInstanceOf(Array);
					expect(result?.reviews).toHaveLength(reviews.length);
					expect(result?.reviews?.map(r => r.author).sort())
						.toEqual(reviews.map(r => r.author).sort());

				}));

				it("should detail all fields of embedded resources", factory(async ({ store }) => {

					const reviews = AF001.reviews!;

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { reviews: { author: {}, posted: {}, rating: {}, content: { en: {} } } }
					});

					expect(result?.reviews).toHaveLength(reviews.length);

					result?.reviews?.forEach(r => {
						const fixture = lookup(reviews, { author: r.author })!;
						expect(r.posted).toBe(fixture.posted);
						expect(r.rating).toBe(fixture.rating);
						expect(r.content?.en).toBe(fixture.content.en);
					});

				}));

				it("should omit the slot for a resource with no embedded", factory(async ({ store }) => {

					const noReviews = lookup(products, p => !p.reviews?.length);

					if ( !noReviews ) { return; }

					const result = await store.lookup({
						entry: noReviews.id,
						shape: Product,
						model: { reviews: { author: {}, rating: {} } }
					});

					expect(result).not.toHaveProperty("reviews");

				}));

			});

		});

		describe("localised properties — §5.4", () => {

			describe("canonical map form", () => {

				it("should detail single-valued localised by language range", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { name: { en: {} } }
					});

					expect(result?.name?.en).toBe(AF001.name.en);

				}));

				it("should exclude tags outside the requested range", factory(async ({ store }) => {

					const multiTag = lookup(products, p => Object.keys(p.name ?? {}).length > 1);

					if ( multiTag === undefined ) { return; }

					const result = await store.lookup({
						entry: multiTag.id,
						shape: Product,
						model: { name: { en: {} } }
					});

					expect(Object.keys(result?.name ?? {})).toEqual(["en"]);

				}));

				it("should detail exactly the requested tag subset", factory(async ({ store }) => {

					const enDe = lookup(products, p => ["en", "de"].every(t => t in (p.name ?? {})));

					if ( enDe === undefined ) { return; }

					const result = await store.lookup({
						entry: enDe.id,
						shape: Product,
						model: { name: { en: {}, de: {} } }
					});

					expect(Object.keys(result?.name ?? {}).sort()).toEqual(["de", "en"]);

				}));

				it("should include regional subtags matching a basic language range (§5.4)", factory(async ({ store }) => {

					// §5.4 / RFC 4647 basic filtering: a tag-range key matches a tag when equal to it or
					// carrying it as a subtag prefix, returning ALL matching tags. The `en` range therefore
					// retrieves both the `en` and the regional `en-US` entries of a product carrying one,
					// never just the exact `en` tag.

					const regional = lookup(products, p => "en-US" in (p.name ?? {}));

					if ( regional === undefined ) { return; }

					// values of the tags the `en` range admits; language tags are case-insensitive
					// (RFC 5646 §2.1.1), so a backend MAY canonicalise `en-US` to `en-us`, and the tag
					// case is compared case-insensitively while the values must round-trip exactly
					const expected = Object.entries(regional.name)
						.filter(([tag]) => tag === "en" || tag === "en-US")
						.map(([, value]) => value);

					const result = await store.lookup({
						entry: regional.id,
						shape: Product,
						model: { name: { en: {} } }
					});

					expect(Object.keys(result?.name ?? {}).map(tag => tag.toLowerCase()).sort())
						.toEqual(["en", "en-us"]);
					expect(Object.values(result?.name ?? {}).sort())
						.toEqual(expected.sort());

				}));

				it("should detail multi-valued localised by language range", factory(async ({ store }) => {

					// §5.4: a multi-valued localised slot is retrieved as one tag-keyed map whose value is
					// the tag's string array (`{ en: [...] }`), not an array of singleton maps.

					const keywords = AF001.keywords?.en ?? [];

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { keywords: { en: {} } }
					});

					expect(result?.keywords?.en).toEqual(expect.arrayContaining([...keywords]));
					expect(result?.keywords?.en).toHaveLength(keywords.length);

				}));

				it("should include regional subtags in an array-per-tag basic language range (§5.4)", factory(async ({ store }) => {

					// §5.4 / RFC 4647 basic filtering on the array-per-tag path: the `en` range retrieves
					// both the `en` and the regional `en-US` keyword sets of a product carrying one, each
					// under its own tag; language tags are case-insensitive (RFC 5646 §2.1.1).

					const regional = lookup(products, p => "en-US" in (p.keywords ?? {}));

					if ( regional === undefined ) { return; }

					const expected = Object.entries(regional.keywords ?? {})
						.filter(([tag]) => tag === "en" || tag === "en-US")
						.flatMap(([, values]) => values)
						.sort();

					const result = await store.lookup({
						entry: regional.id,
						shape: Product,
						model: { keywords: { en: {} } }
					});

					expect(Object.keys(result?.keywords ?? {}).map(tag => tag.toLowerCase()).sort())
						.toEqual(["en", "en-us"]);
					expect(Object.values(result?.keywords ?? {}).flat().sort())
						.toEqual(expected);

				}));

			});

			describe("wildcard tag range", () => {

				it("should detail single-valued localised as full tag-range map", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { name: { "*": {} } }
					});

					expect(result?.name).toEqual(AF001.name);

				}));

				it("should detail multi-valued localised as full tag-range map", factory(async ({ store }) => {

					// §5.4: under the `*` wildcard range the multi-valued localised slot returns its full
					// tag-keyed map, each tag carrying its string array.

					const keywords = AF001.keywords?.en ?? [];

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { keywords: { "*": {} } }
					});

					expect(result?.keywords?.en).toEqual(expect.arrayContaining([...keywords]));
					expect(result?.keywords?.en).toHaveLength(keywords.length);

				}));

			});

			describe("absence semantics", () => {

				it("should omit an absent optional localised", factory(async ({ store }) => {

					const noDescription = lookup(products, p => p.description === undefined);

					if ( !noDescription ) { return; }

					const result = await store.lookup({
						entry: noDescription.id,
						shape: Product,
						model: { description: { en: {} } }
					});

					expect(result).not.toHaveProperty("description");

				}));

			});

		});

		describe("union properties — §5.5", () => {

			// §5.5: a union-typed property is addressed directly by a single placeholder or through the
			// keyed form, an object whose keys are opaque non-negative integer strings. The active branch
			// is NOT fixed by the key (keys carry no positional meaning) but by matching each alternative
			// placeholder against the property's declared variants BY FORM (§5.3): the atomic matches
			// every variant it can stand for, and a template alternative every nested-resource variant
			// its properties are valid on. An alternative MAY match several variants, retrieving each,
			// but MUST match at least one — one matching no variant is unsatisfiable and rejected. The
			// atomic does not tell variants apart and so requests them all; a template's structure
			// discriminates the resource variants it fits. Union no longer admits a localised branch
			// (qest redefinition), so the former "localised variant" test has been removed.

			describe("via union shape", () => {

				// model derives the keyed form from the union() shape, emitting one placeholder per branch;
				// each placeholder matches the branches it fits by form (§5.5: the atomic every branch it can
				// stand for, a template the nested-resource branches it is valid on), and retrieval returns
				// whichever branch the stored value belongs to, not by the slot key.

				it("should detail a single-valued union via the union shape", factory(async ({ store }) => {

					const addressed = vendors.filter(v => v.address !== undefined);

					await Promise.all(addressed.map(async vendor => {

						const result = await store.lookup({
							entry: vendor.id,
							shape: Vendor,
							model: {
								address: {
									"0": {},
									"1": {
										label: { und: {}, en: {}, de: {}, fr: {}, it: {} },
										street: {},
										city: {},
										zip: {},
										country: {},
										comment: { en: {}, de: {}, fr: {}, it: {} }
									},
									"2": {
										label: { und: {}, en: {}, de: {}, fr: {}, it: {} },
										latitude: {},
										longitude: {},
										opened: {},
										comment: { en: {}, de: {}, fr: {}, it: {} }
									}
								}
							}
						});

						expect(result?.address).toBeDefined();

						if ( isString(vendor.address) ) {
							expect(result?.address).toBe(vendor.address);
						}

						if ( isObject(vendor.address) ) {

							const address = result?.address;

							expect(isObject(address)).toBe(true);

							if ( isObject(address) && "street" in vendor.address ) {
								expect("street" in address && address.street).toBe(vendor.address.street);
								expect("city" in address && address.city).toBe(vendor.address.city);
							}

							if ( isObject(address) && "latitude" in vendor.address ) {
								expect("latitude" in address && address.latitude).toBe(vendor.address.latitude);
								expect("longitude" in address && address.longitude).toBe(vendor.address.longitude);
							}

						}

					}));

				}));

				it("should detail each member's single-valued union independently across a collection", factory(async ({ store }) => {

					// the members of a collection are expanded together, so each must come back under the branch
					// its own stored value singles out, never under the branch of a sibling member sharing the union

					const result = await store.lookup({
						entry: "https://data.example.net/vendors/",
						shape: Vendors,
						model: {
							members: {
								id: {},
								address: {
									"0": {},
									"1": { street: {}, city: {} },
									"2": { latitude: {}, longitude: {} }
								}
							}
						}
					});

					expect(result?.members).toHaveLength(vendors.length);

					vendors.forEach(vendor => {

						const address = result?.members?.find(member => member.id === vendor.id)?.address;

						if ( isString(vendor.address) ) {
							expect(address).toBe(vendor.address);
						} else if ( isObject(vendor.address) && "street" in vendor.address ) {
							expect(isObject(address) && "street" in address ? address.street : undefined).toBe(vendor.address.street);
						} else if ( isObject(vendor.address) && "latitude" in vendor.address ) {
							expect(isObject(address) && "latitude" in address ? address.latitude : undefined).toBe(vendor.address.latitude);
						} else {
							expect(address).toBeUndefined();
						}

					});

				}));

				it("should detail two union properties sharing variant shapes independently", factory(async ({ store }) => {

					// `address` and `contacts` both carry the PostalAddress and Place variants: each slot must come
					// back from its own stored values, the shared variant shapes never conflating the two

					const target = lookup(vendors, v =>
						isObject(v.address) && "street" in v.address && (v.contacts ?? []).some(c => isObject(c))
					);

					if ( target === undefined || !isObject(target.address) || !("street" in target.address) ) { return; }

					const result = await store.lookup({
						entry: target.id,
						shape: Vendor,
						model: {
							address: { "0": {}, "1": { street: {} }, "2": { latitude: {} } },
							contacts: { "0": {}, "1": {}, "2": { street: {} }, "3": { latitude: {} } }
						}
					});

					expect(isObject(result?.address) && "street" in result.address ? result.address.street : undefined)
						.toBe(target.address.street);
					expect(result?.contacts).toHaveLength(target.contacts?.length ?? 0);

				}));

				it("should accept an atomic placeholder over a union-typed property (§5.3)", factory(async ({ store }) => {

					// §5.3: the atomic placeholder asks for the value as it stands and so reaches every variant
					// coming back as one, a union-typed property included; the keyed form is what tells the
					// alternatives apart when they are to be retrieved to different depths

					const strAddr = lookup(vendors, v => typeof v.address === "string");

					if ( strAddr === undefined ) { return; }

					const result = await store.lookup({
						entry: strAddr.id,
						shape: Vendor,
						model: { address: {} }
					});

					expect(result?.address).toBe(strAddr.address);

				}));

				it("should detail a multi-valued union via the union shape", factory(async ({ store }) => {

					if ( !withContacts ) { return; }

					const result = await store.lookup({
						entry: withContacts.id,
						shape: Vendor,
						model: {
							contacts: {
								"0": {},
								"1": {},
								"2": {
									label: { und: {}, en: {}, de: {}, fr: {}, it: {} },
									street: {},
									city: {},
									zip: {},
									country: {},
									comment: { en: {}, de: {}, fr: {}, it: {} }
								},
								"3": {
									label: { und: {}, en: {}, de: {}, fr: {}, it: {} },
									latitude: {},
									longitude: {},
									opened: {},
									comment: { en: {}, de: {}, fr: {}, it: {} }
								}
							}
						}
					});

					expect(result?.contacts).toBeInstanceOf(Array);
					expect(result?.contacts).toHaveLength(withContacts.contacts!.length);

				}));

				it("should return undefined for absent optional single union", factory(async ({ store }) => {

					const noAddress = lookup(vendors, v => v.address === undefined);

					if ( !noAddress ) { return; }

					const result = await store.lookup({
						entry: noAddress.id,
						shape: Vendor,
						model: {
							address: {
								"0": {},
								"1": {
									label: { und: {}, en: {}, de: {}, fr: {}, it: {} },
									street: {},
									city: {},
									zip: {},
									country: {},
									comment: { en: {}, de: {}, fr: {}, it: {} }
								},
								"2": {
									label: { und: {}, en: {}, de: {}, fr: {}, it: {} },
									latitude: {},
									longitude: {},
									opened: {},
									comment: { en: {}, de: {}, fr: {}, it: {} }
								}
							}
						}
					});

					expect(result?.address).toBeUndefined();

				}));

				it("should omit an absent multi-valued union", factory(async ({ store }) => {

					const noContacts = lookup(vendors, v => !v.contacts?.length);

					if ( !noContacts ) { return; }

					const result = await store.lookup({
						entry: noContacts.id,
						shape: Vendor,
						model: {
							contacts: {
								"0": {},
								"1": {},
								"2": {
									label: { und: {}, en: {}, de: {}, fr: {}, it: {} },
									street: {},
									city: {},
									zip: {},
									country: {},
									comment: { en: {}, de: {}, fr: {}, it: {} }
								},
								"3": {
									label: { und: {}, en: {}, de: {}, fr: {}, it: {} },
									latitude: {},
									longitude: {},
									opened: {},
									comment: { en: {}, de: {}, fr: {}, it: {} }
								}
							}
						}
					});

					expect(result).not.toHaveProperty("contacts");

				}));

			});

			describe("keyed form", () => {

				it("should single out the embedded branch by structure under an opaque key", factory(async ({ store }) => {

					// The slot key "0" carries no positional meaning; the nested Template addressing the
					// PostalAddress members is what singles out the PostalAddress branch among the
					// string / PostalAddress / Place variants — proving discrimination is by structure, not by
					// key index. Partial keyed form (one alternative) so only that branch is requested.

					const withPostalAddress = lookup(vendors,
						v => isObject(v.address) && "street" in v.address
					);

					if ( !withPostalAddress
						|| !isObject(withPostalAddress.address)
						|| !("street" in withPostalAddress.address) ) { return; }

					const result = await store.lookup({
						entry: withPostalAddress.id,
						shape: Vendor,
						model: {
							address: {
								"0": {
									label: { und: {}, en: {}, de: {}, fr: {}, it: {} },
									street: {},
									city: {},
									zip: {},
									country: {},
									comment: { en: {}, de: {}, fr: {}, it: {} }
								}
							}
						}
					});

					expect(isObject(result?.address)).toBe(true);

					if ( isObject(result?.address) && "street" in result.address ) {
						expect(result.address.street).toBe(withPostalAddress.address.street);
						expect(result.address.city).toBe(withPostalAddress.address.city);
					}

				}));

				it("should single out a multi-valued embedded branch by structure", factory(async ({ store }) => {

					// Same opaque-key discrimination over a multi-valued union: the nested Template addressing
					// the PostalAddress members singles out the PostalAddress branch of
					// Vendor.contacts regardless of the slot key "0". Partial keyed form (one alternative)
					// so only the postal branch is requested and the other contact branches are skipped.

					const withPostalContact = lookup(vendors,
						v => Array.isArray(v.contacts) && v.contacts.some(c => isObject(c) && "street" in c)
					);

					if ( !withPostalContact || !Array.isArray(withPostalContact.contacts) ) { return; }

					const expected = withPostalContact.contacts.filter(c => isObject(c) && "street" in c);

					const result = await store.lookup({
						entry: withPostalContact.id,
						shape: Vendor,
						model: {
							contacts: {
								"0": {
									label: { und: {}, en: {}, de: {}, fr: {}, it: {} },
									street: {},
									city: {},
									zip: {},
									country: {},
									comment: { en: {}, de: {}, fr: {}, it: {} }
								}
							}
						}
					});

					expect(result?.contacts).toBeInstanceOf(Array);
					expect(result?.contacts).toHaveLength(expected.length);

				}));

				// the branch-skipping case the previous notation carried singled a branch out by the kind of its
				// placeholder value; the atomic `{}` reaches every variant coming back as a value (§5.3), so a
				// branch is no longer skipped by the placeholder

				// the out-of-domain case the previous notation carried stated a placeholder value outside the
				// variant domain; a placeholder carries no value of its own any more (§5.3)

				it("should reject an alternative matching no variant (§5.5)", factory(async ({ store }) => {

					// §5.3, §5.5: score is union(decimal, grade string); a template alternative matches only
					// nested-resource variants, and score declares none, so it is unsatisfiable and rejected.

					const vendor = lookup(vendors, v => v.score !== undefined);

					if ( !vendor ) { return; }

					await expect(store.lookup({
						entry: vendor.id,
						shape: Vendor,
						// @ts-expect-error the unsatisfiable alternative is rejected by the type as well
						model: { score: { "0": { name: {} } } }
					})).rejects.toBeInstanceOf(RangeError);

				}));

			});

		});

		describe("empty-form elision", () => {

			// A top-level template stating no property requests nothing of the resource (§5.1): the storage
			// layer returns an empty object after the existence test succeeds, and `undefined` otherwise.
			// Below the top level `{}` is the atomic (§5.3), a request
			// for the property's own value rather than an omission.

			describe("top-level", () => {

				it("should return empty object for empty template on existing resource", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: {}
					});

					expect(result).toEqual({});

				}));

				it("should return undefined for empty template on unknown resource", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: "https://data.example.net/products/UNKNOWN",
						shape: Product,
						model: {}
					});

					expect(result).toBeUndefined();

				}));

				it("should return empty object for empty template on a collection resource", factory(async ({ store }) => {

					// a catalogue is a stored resource like any other, so the empty-template shortcut yields `{}`
					// once its existence test succeeds

					const result = await store.lookup({
						entry: "https://data.example.net/products/",
						shape: Products,
						model: {}
					});

					expect(result).toEqual({});

				}));

			});
			// The per-leaf elision cases the previous notation carried have no subject under the reworked
			// model: `{}` is the atomic placeholder, a request for the property's own value, so no template
			// fragment states an omission any more and a key left out is the only way to not ask for a slot.


		});

		describe("link semantics", () => {

			describe("reverse predicates and foreign references", () => {

				// `Category.broader` carries `forward: toys.broader, reverse: toys.narrower` — both
				// triples are written by the `broader` slot. `Category.narrower` is a `foreign`
				// reference exposing those reverse triples as a read-only view. The two concerns
				// observe the same triples through the same slot, so they share a single
				// full-state probe via `includes`.

				it("should yield reverse-written triples through the foreign slot", factory(async ({
					store,
					includes
				}) => {

					const parent = lookup(categories, { code: "1000" })!;
					const children = categories.filter(c => c.broader === parent.id);

					if ( children.length === 0 ) { return; }

					expect(await includes({
						id: parent.id,
						narrower: children.map(c => c.id)
					}, Category)).toBe(true);

					const result = await store.lookup({
						entry: parent.id,
						shape: Category,
						model: { narrower: {} }
					});

					expect(result?.narrower).toBeInstanceOf(Array);
					expect(result?.narrower).toHaveLength(children.length);
					result?.narrower?.forEach(n => {
						expect(children.map(c => c.id)).toContain(n);
					});

				}));

			});

			describe("foreign references", () => {

				it("should expand a foreign reference with properties", factory(async ({ store }) => {

					const parent = lookup(categories, { code: "1000" })!;
					const children = categories.filter(c => c.broader === parent.id);

					const result = await store.lookup({
						entry: parent.id,
						shape: Category,
						model: { narrower: { code: {}, title: { en: {} } } }
					});

					expect(result?.narrower).toHaveLength(children.length);

					result?.narrower?.forEach(c => {
						const fixture = lookup(children, { code: c.code })!;
						expect(c.title?.en).toBe(fixture.title.en);
					});

				}));

				it("should omit the slot for a leaf foreign reference", factory(async ({ store }) => {

					const leaf = lookup(categories, { code: "1110" })!;

					const result = await store.lookup({
						entry: leaf.id,
						shape: Category,
						model: { narrower: {} }
					});

					expect(result).not.toHaveProperty("narrower");

				}));

				it("should not write or delete triples on retrieval through a foreign slot", factory(async ({
					store,
					includes,
					contains
				}) => {

					// Foreign references are read-only views over the target property's triples;
					// retrieval through the slot must be a pure read.

					const parent = lookup(categories, { code: "1000" })!;
					const children = categories.filter(c => c.broader === parent.id);

					if ( children.length === 0 ) { return; }

					const childrenIds = children.map(c => c.id);

					const beforeExists = await contains(parent.id);
					const beforeIncludes = await includes({
						id: parent.id,
						narrower: childrenIds
					}, Category);

					await store.lookup({
						entry: parent.id,
						shape: Category,
						model: { narrower: {} }
					});

					expect(await contains(parent.id)).toBe(beforeExists);
					expect(await includes({
						id: parent.id,
						narrower: childrenIds
					}, Category)).toBe(beforeIncludes);

				}));

			});

		});

	});

}
