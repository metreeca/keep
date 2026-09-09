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

import { dictionary } from "@metreeca/blue/dictionary";
import { byte, decimal, integer } from "@metreeca/blue/number";
import { reference } from "@metreeca/blue/reference";
import { id, resource, type } from "@metreeca/blue/resource";
import { date, instant, string, url } from "@metreeca/blue/string";
import { union } from "@metreeca/blue/union";
import { model, multiple, optional, required } from "@metreeca/blue/value";
import { isObject, isString } from "@metreeca/core";
import type { Resource } from "@metreeca/qest/resource";
import type { Instance, Template } from "@metreeca/qest/template";
import { beforeAll, describe, expect, it } from "vitest";
import { lookup, type TestFactory } from "../index.core.js";
import { collections } from "../toys.core.js";
import {
	Address,
	Category,
	Certified,
	Contacts,
	PostalAddress,
	Product,
	Products,
	Score,
	toys,
	Vendor
} from "../toys.js";


const { categories, products, vendors } = collections;


const withAddress = lookup(vendors, v => v.address !== undefined);
const withContacts = lookup(vendors, v => (v.contacts?.length ?? 0) > 0);


export function testRetrieveTemplate(factory: TestFactory): void {

	const AF001 = lookup(products, { sku: "AF-001" })!;


	describe("lookup template", () => {

		beforeAll(factory(async ({ populate }) => { await populate(); }).hook);


		describe("contract", () => {

			// Each case pairs an entry+model with an assertion run against the awaited
			// `store.lookup` invocation: rejection cases assert via `rejects`, success
			// cases assert against the resolved value.

			type ContractCase = {
				readonly entry: string;
				readonly model: Template;
				readonly assert: (call: Promise<undefined | Instance<Template>>) => Promise<unknown>;
			};

			const cases: ReadonlyArray<readonly [string, ContractCase]> = [

				["reject with RangeError for invalid model", {
					entry: AF001.id,
					model: { price: "not a number" },
					assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
				}],

				["reject with RangeError for a relative IRI", {
					entry: "relative/path",
					model: { price: 0 },
					assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
				}],

				["reject with RangeError for an empty IRI", {
					entry: "",
					model: { price: 0 },
					assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
				}],

				["reject with RangeError for an entry with a query string", {
					entry: `${AF001.id}?probe=1`,
					model: { price: 0 },
					assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
				}],

				["reject with RangeError for an entry with a fragment", {
					entry: `${AF001.id}#probe`,
					model: { price: 0 },
					assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
				}],

				["reject a query tuple over a single-valued property (§5.5)", {
					entry: AF001.id,
					model: { price: [0] },
					assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
				}],

				["reject a collection tuple with more than two elements (§5.2)", {
					entry: AF001.id,
					// the fixture stays intentionally malformed to assert the runtime RangeError for an
					// over-length collection tuple (§5.2)
					model: { reviews: [{ author: "" }, { "^posted": 1 }, { "#": 1 }] },
					assert: call => expect(call).rejects.toBeInstanceOf(RangeError)
				}],

				["return undefined for unknown ids", {
					entry: "https://data.example.net/products/UNKNOWN",
					model: model(resource({ price: required(decimal()) })),
					assert: async call => expect(await call).toBeUndefined()
				}],

				["project only id", {
					entry: AF001.id,
					model: model(resource({ id: id() })),
					assert: async call => expect((await call)?.id).toBe(AF001.id)
				}],

				["project only type", {
					entry: AF001.id,
					model: model(resource({ class: toys.Product }, { type: type() })),
					assert: async call => expect((await call)?.type).toBe(AF001.type)
				}],

				["project id and type together", {
					entry: AF001.id,
					model: model(resource({ class: toys.Product }, { id: id(), type: type() })),
					assert: async call => {
						const result = await call;
						expect(result?.id).toBe(AF001.id);
						expect(result?.type).toBe(AF001.type);
					}
				}]

			];

			it.each(cases)("should %s", (_, { entry, model: m, assert }) => factory(async ({ store }) => {

				await assert(store.lookup({ shape: Product, entry, model: m }));

			})());

			it("should return an immutable copy", factory(async ({ store }) => {

				const result = await store.lookup({
					entry: AF001.id,
					shape: Product,
					model: { price: 1, vendor: { name: "x" } }
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

		describe("scalar properties — §5.2", () => {

			describe("literals", () => {

				it("should project requested scalar fields", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							sku: required(string()),
							price: required(decimal()),
							stock: required(integer()),
							condition: required(string())
						}))
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
						model: model(resource({
							price: required(decimal())
						}))
					});

					expect(result?.price).toBe(AF001.price);
					expect(result).not.toHaveProperty("sku");
					expect(result).not.toHaveProperty("name");

				}));

				it("should ignore literal placeholder values, matching only their type (§5.1)", factory(async ({ store }) => {

					// §5.1: the actual value of a literal placeholder is immaterial; only its type
					// matters, so a non-zero placeholder retrieves the stored value, not itself

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { sku: "PLACEHOLDER", price: 42 }
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
						model: model(resource({
							sku: required(string()),
							launched: optional(date())
						}))
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
						model: model(resource({
							vendor: required(reference(Vendor))
						}))
					});

					expect(result?.vendor).toBe(AF001.vendor);

				}));

				it("should return an optional reference as id when present", factory(async ({ store }) => {

					const child = lookup(categories, { code: "1100" })!;

					const result = await store.lookup({
						entry: child.id,
						shape: Category,
						model: model(resource({
							broader: optional(reference(Category))
						}))
					});

					expect(result?.broader).toBe(child.broader);

				}));

				it("should return an optional reference as undefined when absent", factory(async ({ store }) => {

					const root = lookup(categories, { code: "1000" })!;

					const result = await store.lookup({
						entry: root.id,
						shape: Category,
						model: model(resource({
							broader: optional(reference(Category))
						}))
					});

					expect(result?.broader).toBeUndefined();

				}));

				it.each([
					["an absolute IRI", "https://example.com/vendors/1"],
					["a root-relative reference", "/vendors/"],
					["a relative reference", "vendors/1"],
					["the empty string", ""]
				])("should accept %s as a reference placeholder (§5.2)", (_label, placeholder) => factory(async ({ store }) => {

					// §5.2: a reference placeholder's value is immaterial and never returned; only its kind
					// matters, and any string satisfying the IRI-reference production (the empty string,
					// relative, root-relative, or absolute) matches the reference variant — it need not be a
					// legal or absolute value

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { vendor: placeholder }
					});

					expect(result?.vendor).toBe(AF001.vendor);

				})());

				it("should reject a string outside the IRI-reference production (§5.2)", factory(async ({ store }) => {

					// §5.2: a string that could not reference a resource (here, one with spaces and angle
					// brackets) satisfies no reference variant by kind and is rejected

					await expect(store.lookup({
						entry: AF001.id,
						shape: Product,
						model: { vendor: "not a valid <iri>" }
					})).rejects.toBeInstanceOf(RangeError);

				}));

			});

			describe("references (expanded)", () => {

				it("should expand a scalar reference with properties", factory(async ({ store }) => {

					const expected = lookup(vendors, { id: AF001.vendor })!;

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							vendor: required(resource({
								name: required(string()),
								email: required(string()),
								code: required(string())
							}))
						}))
					});

					expect(result?.vendor?.name).toBe(expected.name);
					expect(result?.vendor?.email).toBe(expected.email);
					expect(result?.vendor?.code).toBe(expected.code);

				}));

				it("should exclude unrequested fields on an expanded reference", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							vendor: required(resource({
								name: required(string())
							}))
						}))
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
						model: model(resource({
							broader: optional(resource({
								code: required(string()),
								title: required(dictionary({ en: "" }))
							}))
						}))
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
						model: model(resource({
							title: required(dictionary({ en: "" })),
							broader: optional(resource({
								title: required(dictionary({ en: "" })),
								broader: optional(resource({
									title: required(dictionary({ en: "" }))
								}))
							}))
						}))
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
						model: model(resource({ class: toys.Product }, {
							id: id(),
							type: type(),
							vendor: required(resource({
								name: required(string())
							}))
						}))
					});

					expect(result?.id).toBe(AF001.id);
					expect(result?.type).toBe(AF001.type);
					expect(result?.vendor?.name).toBe(expected.name);

				}));

			});

		});

		describe("array properties — §5.2", () => {

			describe("literals", () => {

				it("should project multi-valued scalar fields", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							documents: multiple(url())
						}))
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
						model: model(resource({
							aliases: multiple(string())
						}))
					});

					expect(result).not.toHaveProperty("aliases");

				}));

			});

			describe("references (id-only)", () => {

				it("should return multi-valued references as array of ids", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							categories: multiple(reference(Category))
						}))
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
						model: model(resource({
							categories: multiple(resource({
								code: required(string()),
								title: required(dictionary({ en: "" }))
							}))
						}))
					});

					expect(result?.categories).toHaveLength(AF001.categories.length);

					result?.categories?.forEach(c => {
						const fixture = lookup(fixtures, { code: c.code })!;
						expect(c.title?.en).toBe(fixture.title.en);
					});

				}));

			});

			describe("embedded resources", () => {

				it("should lookup embedded resources inline", factory(async ({ store }) => {

					const reviews = AF001.reviews!;

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							reviews: multiple(resource({
								author: required(string()),
								rating: required(byte({ minInclusive: 1, maxInclusive: 5 }))
							}))
						}))
					});

					expect(result?.reviews).toBeInstanceOf(Array);
					expect(result?.reviews).toHaveLength(reviews.length);
					expect(result?.reviews?.map(r => r.author).sort())
						.toEqual(reviews.map(r => r.author).sort());

				}));

				it("should lookup all fields of embedded resources", factory(async ({ store }) => {

					const reviews = AF001.reviews!;

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							reviews: multiple(resource({
								author: required(string()),
								posted: required(instant()),
								rating: required(byte({ minInclusive: 1, maxInclusive: 5 })),
								content: required(dictionary({ en: "" }))
							}))
						}))
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
						model: model(resource({
							reviews: multiple(resource({
								author: required(string()),
								rating: required(integer({ minInclusive: 1, maxInclusive: 5 }))
							}))
						}))
					});

					expect(result).not.toHaveProperty("reviews");

				}));

			});

		});

		describe("localised properties — §5.3", () => {

			describe("canonical map form", () => {

				it("should lookup single-valued localised by language range", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							name: required(dictionary({ en: "" }))
						}))
					});

					expect(result?.name?.en).toBe(AF001.name.en);

				}));

				it("should exclude tags outside the requested range", factory(async ({ store }) => {

					const multiTag = lookup(products, p => Object.keys(p.name ?? {}).length > 1);

					if ( multiTag === undefined ) { return; }

					const result = await store.lookup({
						entry: multiTag.id,
						shape: Product,
						model: model(resource({
							name: required(dictionary({ en: "" }))
						}))
					});

					expect(Object.keys(result?.name ?? {})).toEqual(["en"]);

				}));

				it("should lookup exactly the requested tag subset", factory(async ({ store }) => {

					const enDe = lookup(products, p => ["en", "de"].every(t => t in (p.name ?? {})));

					if ( enDe === undefined ) { return; }

					const result = await store.lookup({
						entry: enDe.id,
						shape: Product,
						model: model(resource({
							name: required(dictionary({ en: "", de: "" }))
						}))
					});

					expect(Object.keys(result?.name ?? {}).sort()).toEqual(["de", "en"]);

				}));

				it("should include regional subtags matching a basic language range (§5.3)", factory(async ({ store }) => {

					// §5.3 / RFC 4647 basic filtering: a tag-range key matches a tag when equal to it or
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
						model: model(resource({
							name: required(dictionary({ en: "" }))
						}))
					});

					expect(Object.keys(result?.name ?? {}).map(tag => tag.toLowerCase()).sort())
						.toEqual(["en", "en-us"]);
					expect(Object.values(result?.name ?? {}).sort())
						.toEqual(expected.sort());

				}));

				it("should lookup multi-valued localised by language range", factory(async ({ store }) => {

					// §5.3: a multi-valued localised slot is retrieved as one tag-keyed map whose value is
					// the tag's string array (`{ en: [...] }`), not an array of singleton maps.

					const keywords = AF001.keywords?.en ?? [];

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							keywords: multiple(dictionary({ en: "" }))
						}))
					});

					expect(result?.keywords?.en).toEqual(expect.arrayContaining([...keywords]));
					expect(result?.keywords?.en).toHaveLength(keywords.length);

				}));

				it("should include regional subtags in an array-per-tag basic language range (§5.3)", factory(async ({ store }) => {

					// §5.3 / RFC 4647 basic filtering on the array-per-tag path: the `en` range retrieves
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
						model: model(resource({
							keywords: multiple(dictionary({ en: "" }))
						}))
					});

					expect(Object.keys(result?.keywords ?? {}).map(tag => tag.toLowerCase()).sort())
						.toEqual(["en", "en-us"]);
					expect(Object.values(result?.keywords ?? {}).flat().sort())
						.toEqual(expected);

				}));

			});

			describe("wildcard tag range", () => {

				it("should lookup single-valued localised as full tag-range map", factory(async ({ store }) => {

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							name: required(dictionary())
						}))
					});

					expect(result?.name).toEqual(AF001.name);

				}));

				it("should lookup multi-valued localised as full tag-range map", factory(async ({ store }) => {

					// §5.3: under the `*` wildcard range the multi-valued localised slot returns its full
					// tag-keyed map, each tag carrying its string array.

					const keywords = AF001.keywords?.en ?? [];

					const result = await store.lookup({
						entry: AF001.id,
						shape: Product,
						model: model(resource({
							keywords: multiple(dictionary())
						}))
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
						model: model(resource({
							description: optional(dictionary({ en: "" }))
						}))
					});

					expect(result).not.toHaveProperty("description");

				}));

			});

		});

		describe("union properties — §5.4", () => {

			// §5.4: a union-typed property is addressable only through the keyed form, an object whose
			// keys are opaque non-negative integer strings. The active branch is NOT fixed by the key
			// (keys carry no positional meaning) but by matching each alternative placeholder against
			// the property's declared variants BY KIND, its value immaterial: a literal alternative
			// matches every variant of its processing kind, a reference alternative every reference
			// variant, and a template alternative every nested-resource variant its structure fits.
			// An alternative MAY match several variants, retrieving each, but MUST match at least one —
			// one matching no variant is unsatisfiable and rejected. A literal or reference alternative
			// does not tell same-kind variants apart and so requests them all; a template's structure
			// discriminates the resource variants it fits. Union no longer admits a localised branch
			// (qest redefinition), so the former "localised variant" test has been removed.

			describe("via union shape", () => {

				// model derives the keyed form from the union() shape, emitting one placeholder per branch;
				// each placeholder matches its branch by kind (literal, reference) or structure (template),
				// its value immaterial, and retrieval returns whichever branch the stored value belongs to,
				// not by the slot key.

				it("should lookup a single-valued union via the union shape", factory(async ({ store }) => {

					const addressed = vendors.filter(v => v.address !== undefined);

					await Promise.all(addressed.map(async vendor => {

						const result = await store.lookup({
							entry: vendor.id,
							shape: Vendor,
							model: model(resource({
								address: optional(Address)
							}))
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

				it("should reject a bare placeholder over a union-typed property (§5.4)", factory(async ({ store }) => {

					// §5.4: a union-typed property is addressable only through the keyed variant form,
					// so a bare placeholder over it is mismatched and MUST be rejected, whichever single
					// branch it may resemble. The bare string placeholder resembles the string branch.

					const strAddr = lookup(vendors, v => typeof v.address === "string");

					if ( strAddr === undefined ) { return; }

					await expect(store.lookup({
						entry: strAddr.id,
						shape: Vendor,
						model: { address: "" }
					})).rejects.toBeInstanceOf(RangeError);

				}));

				it("should lookup a multi-valued union via the union shape", factory(async ({ store }) => {

					if ( !withContacts ) { return; }

					const result = await store.lookup({
						entry: withContacts.id,
						shape: Vendor,
						model: model(resource({
							contacts: multiple(Contacts)
						}))
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
						model: model(resource({
							address: optional(Address)
						}))
					});

					expect(result?.address).toBeUndefined();

				}));

				it("should omit an absent multi-valued union", factory(async ({ store }) => {

					const noContacts = lookup(vendors, v => !v.contacts?.length);

					if ( !noContacts ) { return; }

					const result = await store.lookup({
						entry: noContacts.id,
						shape: Vendor,
						model: model(resource({
							contacts: multiple(Contacts)
						}))
					});

					expect(result).not.toHaveProperty("contacts");

				}));

			});

			describe("keyed form", () => {

				it("should single out the embedded branch by structure under an opaque key", factory(async ({ store }) => {

					// The slot key "0" carries no positional meaning; the nested Template derived from the
					// PostalAddress shape via model() is what singles out the PostalAddress branch among the
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
						model: model(resource({ address: optional(union(PostalAddress)) }))
					});

					expect(isObject(result?.address)).toBe(true);

					if ( isObject(result?.address) ) {
						expect(result.address.street).toBe(withPostalAddress.address.street);
						expect(result.address.city).toBe(withPostalAddress.address.city);
					}

				}));

				it("should single out a multi-valued embedded branch by structure", factory(async ({ store }) => {

					// Same opaque-key discrimination over a multi-valued union: the nested Template derived
					// from the PostalAddress shape via model() singles out the PostalAddress branch of
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
						model: model(resource({ contacts: multiple(union(PostalAddress)) }))
					});

					expect(result?.contacts).toBeInstanceOf(Array);
					expect(result?.contacts).toHaveLength(expected.length);

				}));

				it("should skip a branch the placeholder does not single out", factory(async ({ store }) => {

					// A plain-string alternative singles out the string branch by kind; a vendor whose
					// address is stored on the PostalAddress branch has no value there, so the slot is
					// skipped and no address is returned.

					const withPostalAddress = lookup(vendors,
						v => isObject(v.address)
					);

					if ( !withPostalAddress ) { return; }

					const result = await store.lookup({
						entry: withPostalAddress.id,
						shape: Vendor,
						model: {
							address: { "0": "any address" }
						}
					});

					expect(result?.address).toBeUndefined();

				}));

				it.each<[string, () => { id: string } | undefined, Template]>([

					// §5.4: keys are an opaque integer namespace disjoint from property identifiers,
					// so mixing an identifier key in is rejected.
					["mixed key spaces on single-valued union", () => withAddress, {
						address: {
							"0": "any address",
							"name": ""
						}
					}],
					["mixed key spaces on multi-valued union", () => withContacts, {
						contacts: [{
							"0": "any@contact.example.net",
							"name": ""
						}]
					}],

					// §5.4: an alternative matching no declared variant is unsatisfiable. A numeric
					// placeholder matches none of the string / PostalAddress / Place address variants;
					// a boolean matches none of the email / phone / PostalAddress / Place contact variants.
					["an unsatisfiable alternative on single-valued union", () => withAddress, { address: { "0": 0 } }],
					["an unsatisfiable alternative on multi-valued union", () => withContacts, { contacts: [{ "0": true }] }]

				])("should reject %s", (_label, fixture, m) => factory(async ({ store }) => {

					const f = fixture();

					if ( !f ) { return; }

					await expect(store.lookup({ entry: f.id, shape: Vendor, model: m }))
						.rejects.toBeInstanceOf(RangeError);

				})());

			});

			describe("literal variants — kind matching", () => {

				// Vendor.score is union(decimal[0..5], grade string /^[A-F]$/) and Vendor.certified is
				// union(boolean, decimal[0..5], grade string, year). Each alternative matches its branch
				// by processing kind, its value immaterial (§5.4). Score's two variants differ in kind
				// (number vs string), so kind alone tells them apart; certified's grade and year variants
				// share the string kind, so a string alternative matches both and retrieval returns
				// whichever branch the stored value belongs to.

				it.each<[string, (v: Resource) => boolean]>([
					["decimal", v => typeof v.score === "number"],
					["grade", v => typeof v.score === "string"]
				])("should retrieve a %s-valued score by matching its branch", (_kind, pick) => factory(async ({ store }) => {

					const vendor = lookup(vendors, pick);

					if ( !vendor ) { return; }

					// model() derives one placeholder per branch (decimal number, grade string); each
					// matches its branch by kind, and only the branch carrying the stored value contributes

					const result = await store.lookup({
						entry: vendor.id,
						shape: Vendor,
						model: model(resource({ score: optional(Score) }))
					});

					expect(result?.score).toBe(vendor.score);

				})());

				it.each<[string, (v: Resource) => boolean]>([
					["boolean", v => typeof v.certified === "boolean"],
					["decimal", v => typeof v.certified === "number"],
					["grade", v => typeof v.certified === "string" && /^[A-F]$/.test(v.certified)],
					["year", v => typeof v.certified === "string" && /^\d{4}$/.test(v.certified)]
				])("should retrieve a %s-valued certified across the four-branch union", (_kind, pick) =>
					factory(async ({ store }) => {

						const vendor = lookup(vendors, pick);

						if ( !vendor ) { return; }

						// model() derives one placeholder per branch (boolean / decimal / grade / year),
						// each matched by kind; the two string variants (grade, year) are both matched by
						// the string placeholders, and only the branch carrying the stored value contributes

						const result = await store.lookup({
							entry: vendor.id,
							shape: Vendor,
							model: model(resource({ certified: optional(Certified) }))
						});

						expect(result?.certified).toBe(vendor.certified);

					})()
				);

				it.each<[string, (v: Resource) => boolean]>([
					["grade", v => typeof v.certified === "string" && /^[A-F]$/.test(v.certified)],
					["year", v => typeof v.certified === "string" && /^\d{4}$/.test(v.certified)]
				])("should retrieve a %s-valued certified via a single same-kind string alternative", (_kind, pick) =>
					factory(async ({ store }) => {

						const vendor = lookup(vendors, pick);

						if ( !vendor ) { return; }

						// §5.4: a single string alternative matches BOTH string variants (grade and year)
						// by kind — a literal alternative does not tell same-kind variants apart, so it
						// requests both, and retrieval returns whichever the stored value belongs to. The
						// empty placeholder value is immaterial.

						const result = await store.lookup({
							entry: vendor.id,
							shape: Vendor,
							model: { certified: { "0": "" } }
						});

						expect(result?.certified).toBe(vendor.certified);

					})()
				);

				it("should accept a kind-matching alternative whose value is out of domain (§5.4)", factory(async ({ store }) => {

					// §5.4: a placeholder's value is immaterial — 9 lies outside the decimal[0..5] domain
					// but is a number, so it matches the decimal branch by kind and retrieves the stored score.

					const vendor = lookup(vendors, v => typeof v.score === "number");

					if ( !vendor ) { return; }

					const result = await store.lookup({
						entry: vendor.id,
						shape: Vendor,
						model: { score: { "0": 9 } }
					});

					expect(result?.score).toBe(vendor.score);

				}));

				it("should reject an alternative whose kind matches no variant (§5.4)", factory(async ({ store }) => {

					// §5.4: score is union(decimal, grade string); a boolean placeholder matches neither
					// the number nor the string variant by kind, so it is unsatisfiable and rejected.

					const vendor = lookup(vendors, v => v.score !== undefined);

					if ( !vendor ) { return; }

					await expect(store.lookup({
						entry: vendor.id,
						shape: Vendor,
						model: { score: { "0": true } }
					})).rejects.toBeInstanceOf(RangeError);

				}));

			});

		});

		describe("empty-form elision", () => {

			// Per `@metreeca/qest/template` (resource.ts): empty `Template` / `Union` / `Locales`
			// / `Projection` payloads, and collection tuples whose element object is empty (an
			// empty `{}` element optionally paired with a `Selection` in the second slot),
			// are vacuous — processors must ignore them as if the owning property were omitted
			// from the enclosing template, discarding any attached `Selection` constraints.
			// At the top level, form-serialised selection-only substitution is a server concern;
			// the storage layer returns an empty object after the existence test succeeds, and
			// `undefined` otherwise (assumed true for virtual resources).

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

				it("should return empty object for empty template on virtual resource", factory(async ({ store }) => {

					// Virtual collections have no backing triples — the existence test is assumed
					// true, so the empty-template shortcut must still yield `{}`.

					const result = await store.lookup({
						entry: "https://data.example.net/products/",
						shape: Products,
						model: {}
					});

					expect(result).toEqual({});

				}));

			});

			// Per-leaf elision cases: each entry pairs the elided slot (property name) with the
			// model fragment carrying the vacuous payload and a primary probe — a closure
			// confirming a sibling entry still resolves while the elided slot is dropped from
			// the result. Each case packs its own fixture lookup so absent fixtures skip silently.

			type ElisionCase = {
				readonly fixture: () => undefined | { readonly id: string };
				readonly shape: typeof Product | typeof Vendor;
				readonly slot: string;
				readonly model: Template;
				readonly probe: (result: undefined | Instance<Template>) => void;
			};

			const elidesFromProduct = (slot: string): ElisionCase["probe"] => result => {
				expect(result?.price).toBe(AF001.price);
				expect(result).not.toHaveProperty(slot);
			};

			const elidesFromVendor = (
				expected: undefined | { readonly name: string },
				slot: string
			): ElisionCase["probe"] => result => {
				expect(result?.name).toBe(expected?.name);
				expect(result).not.toHaveProperty(slot);
			};

			const elisionCases: ReadonlyArray<readonly [string, ElisionCase]> = [

				["scalar reference slot with empty Template", {
					fixture: () => AF001, shape: Product, slot: "vendor",
					model: { price: 1, vendor: {} },
					probe: elidesFromProduct("vendor")
				}],

				["array slot with empty Template in singleton tuple", {
					fixture: () => AF001, shape: Product, slot: "reviews",
					model: { price: 1, reviews: [{}] },
					probe: elidesFromProduct("reviews")
				}],

				["array slot with Selection-only tuple", {
					fixture: () => AF001, shape: Product, slot: "reviews",
					model: { price: 1, reviews: [{}, { "^posted": 1 }] },
					probe: elidesFromProduct("reviews")
				}],

				["localised slot with empty Locales map", {
					fixture: () => AF001, shape: Product, slot: "name",
					model: { price: 1, name: {} },
					probe: elidesFromProduct("name")
				}],

				["single-valued union slot with empty Union", {
					fixture: () => withAddress, shape: Vendor, slot: "address",
					model: { name: "x", address: {} },
					probe: elidesFromVendor(withAddress, "address")
				}],

				["multi-valued union slot with empty singleton tuple", {
					fixture: () => withContacts, shape: Vendor, slot: "contacts",
					model: { name: "x", contacts: [{}] },
					probe: elidesFromVendor(withContacts, "contacts")
				}],

				["multi-valued union slot with Selection-only tuple", {
					fixture: () => withContacts, shape: Vendor, slot: "contacts",
					model: { name: "x", contacts: [{}, { "^": 1 }] },
					probe: elidesFromVendor(withContacts, "contacts")
				}]

			];

			it.each(elisionCases)("should elide %s", (_, {
				fixture,
				shape,
				model: m,
				probe
			}) => factory(async ({ store }) => {

				const f = fixture();

				if ( !f ) { return; }

				const result = await store.lookup({ entry: f.id, shape, model: m });

				probe(result);

			})());

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
						model: model(resource({
							narrower: multiple(reference(Category))
						}))
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
						model: model(resource({
							narrower: multiple(resource({
								code: required(string()),
								title: required(dictionary({ en: "" }))
							}))
						}))
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
						model: model(resource({
							narrower: multiple(reference(Category))
						}))
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
						model: model(resource({
							narrower: multiple(reference(Category))
						}))
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
