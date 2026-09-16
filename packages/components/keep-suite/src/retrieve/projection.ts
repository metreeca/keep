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

import { boolean } from "@metreeca/blue/boolean";
import { dictionary } from "@metreeca/blue/dictionary";
import { decimal, integer } from "@metreeca/blue/number";
import { reference } from "@metreeca/blue/reference";
import { id, type Member, multiple, optional, required, resource } from "@metreeca/blue/resource";
import { string, url } from "@metreeca/blue/string";
import { union } from "@metreeca/blue/union";
import { isObject } from "@metreeca/core";
import { ascending, by, compound, descending } from "@metreeca/core/order";
import type { Resource } from "@metreeca/qest/resource";
import type { Selection } from "@metreeca/qest/template";
import { beforeAll, describe, expect, it } from "vitest";
import { lookup, type TestFactory } from "../index.core.js";
import { collections } from "../toys.core.js";
import { Categories, Products, toys, Vendor, Vendors } from "../toys.js";
import { catalogue, members } from "./index.js";


const { categories, products, vendors } = collections;


export function testRetrieveProjection(factory: TestFactory): void {

	const Catalogue = "https://data.example.net/products/";
	const VendorsCatalogue = "https://data.example.net/vendors/";
	const CategoryCatalogue = "https://data.example.net/categories/";
	const AF001 = lookup(products, { sku: "AF-001" })!;


	function lenient<V, R>(fn: (x: V) => R): (v: undefined | V) => undefined | R {
		return v => v === undefined ? undefined : fn(v);
	}

	const countBy = <T>(items: readonly T[], key: (item: T) => string): Record<string, number> =>
		items.reduce<Record<string, number>>((acc, item) => ({ ...acc, [key(item)]: (acc[key(item)] ?? 0)+1 }), {});


	describe("lookup projection — §5.6", () => {

		beforeAll(factory(async ({ populate }) => { await populate(); }).hook);


		describe("computed on single resource", () => {

			describe("scalar transforms", () => {

				interface ScalarCase {
					readonly kind: "numeric" | "textual" | "temporal";
					readonly name: string;
					readonly pipe: string;
					readonly field: "change" | "price" | "sku" | "launched" | "created";
					readonly shape: Member;
					readonly fn: (v: undefined | Resource[string]) => undefined | Resource[string];
				}

				const cases: readonly ScalarCase[] = [

					{
						kind: "numeric", name: "absChange", pipe: "abs", field: "change", shape: optional(decimal),
						fn: lenient((v: Resource[string]) => Math.abs(v as number))
					},
					{
						kind: "numeric", name: "floorPrice", pipe: "floor", field: "price", shape: optional(decimal()),
						fn: lenient((v: Resource[string]) => Math.floor(v as number))
					},
					{
						kind: "numeric", name: "ceilPrice", pipe: "ceil", field: "price", shape: optional(decimal()),
						fn: lenient((v: Resource[string]) => Math.ceil(v as number))
					},
					{
						kind: "numeric", name: "roundPrice", pipe: "round", field: "price", shape: optional(decimal()),
						fn: lenient((v: Resource[string]) => Math.round(v as number))
					},

					{
						kind: "textual", name: "lowerSku", pipe: "lower", field: "sku", shape: optional(string()),
						fn: lenient((v: Resource[string]) => (v as string).toLowerCase())
					},
					{
						kind: "textual", name: "upperSku", pipe: "upper", field: "sku", shape: optional(string()),
						fn: lenient((v: Resource[string]) => (v as string).toUpperCase())
					},
					{
						kind: "textual", name: "skuLen", pipe: "length", field: "sku", shape: optional(integer),
						fn: lenient((v: Resource[string]) => (v as string).length)
					},

					{
						kind: "temporal", name: "launchYear", pipe: "year", field: "launched", shape: optional(integer),
						fn: lenient((v: Resource[string]) => new Date(v as string).getUTCFullYear())
					},
					{
						kind: "temporal",
						name: "launchMonth",
						pipe: "month",
						field: "launched",
						shape: optional(integer),
						fn: lenient((v: Resource[string]) => new Date(v as string).getUTCMonth()+1)
					},
					{
						kind: "temporal", name: "launchDay", pipe: "day", field: "launched", shape: optional(integer),
						fn: lenient((v: Resource[string]) => new Date(v as string).getUTCDate())
					},
					{
						kind: "temporal",
						name: "createdHours",
						pipe: "hours",
						field: "created",
						shape: optional(integer),
						fn: lenient((v: Resource[string]) => new Date(v as string).getUTCHours())
					},
					{
						kind: "temporal",
						name: "createdMinutes",
						pipe: "minutes",
						field: "created",
						shape: optional(integer),
						fn: lenient((v: Resource[string]) => new Date(v as string).getUTCMinutes())
					},
					{
						kind: "temporal",
						name: "createdSeconds",
						pipe: "seconds",
						field: "created",
						shape: optional(decimal),
						fn: lenient((v: Resource[string]) =>
							new Date(v as string).getUTCSeconds()+new Date(v as string).getUTCMilliseconds()/1000)
					}

				];

				it.each(cases)("should compute $kind $name as $pipe from $entry", async ({
					name,
					pipe,
					field,
					shape,
					fn
				}) => {

					await factory(async ({ store }) => {

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue(resource({ [`${name}=${pipe}:${field}`]: shape }), {
								"?id": [AF001.id]
							})
						}));

						expect(result).toHaveLength(1);
						expect(result?.[0]?.[name]).toBe(fn(AF001[field]));

					})();

				});

			});

			describe("aggregate transforms on singleton set", () => {

				it.each([
					["cnt", "count", "price", optional(integer), 1],
					["minPrice", "min", "price", optional(decimal()), AF001.price],
					["maxPrice", "max", "price", optional(decimal()), AF001.price],
					["minSku", "min", "sku", optional(string()), AF001.sku],
					["maxLaunched", "max", "launched", optional(string()), AF001.launched],
					["totalStock", "sum", "stock", optional(decimal), AF001.stock],
					["avgPrice", "avg", "price", optional(decimal), AF001.price]
				] as const)("should compute %s as %s on %s", async (name, pipe, field, shape, expected) => {

					await factory(async ({ store }) => {

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue(resource({ [`${name}=${pipe}:${field}`]: shape }), {
								"?id": [AF001.id]
							})
						}));

						expect(result).toHaveLength(1);
						expect(result?.[0]?.[name]).toBe(expected);

					})();

				});

			});

			describe("aggregate domains — §5.8.2.1", () => {

				it("should reduce boolean targets with min and max", factory(async ({ store }) => {

					// xsd:boolean is ordered false < true (§5.7.1), so min/max over the whole
					// category collection straddle the mixed featured flags

					const flags = categories.map(c => c.featured);

					const result = members(await store.lookup({
						entry: CategoryCatalogue,
						shape: Categories,
						model: catalogue(resource({
							"low=min:featured": optional(boolean),
							"high=max:featured": optional(boolean)
						}))
					}));

					expect(result).toHaveLength(1);
					expect(result?.[0]?.low).toBe(flags.reduce((a, b) => a && b));
					expect(result?.[0]?.high).toBe(flags.reduce((a, b) => a || b));

				}));

			});

			describe("transform pipelines", () => {

				it("should compose scalar transforms in pipeline", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ "floorAbs=floor:abs:change": optional(decimal) }), {
							"?id": [AF001.id]
						})
					}));

					expect(result).toHaveLength(1);
					expect(result?.[0]?.floorAbs).toBe(Math.floor(Math.abs(AF001.change!)));

				}));

				it("should compose aggregate with scalar transform", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ "roundAvg=round:avg:price": optional(decimal) }), {
							"?id": [AF001.id]
						})
					}));

					expect(result).toHaveLength(1);
					expect(result?.[0]?.roundAvg).toBe(Math.round(AF001.price!));

				}));

			});

			describe("transforms on id/type — out-of-domain (§5.8.2)", () => {

				// id/type resolve as references, outside the processing space (§3). The string transforms
				// lower/upper/length require xsd:string (§5.8.2.3) and the aggregates min/max exclude
				// reference (§5.8.2.1), so on a reference target they are out-of-domain on valid input: a
				// scalar transform yields undefined (§5.8.2), and an aggregate drops every value, leaving
				// the empty-set undefined. count alone admits any value, references included (§5.8.2.1).

				it.each([
					["lowerId", "lower", "id", optional(string())],
					["upperId", "upper", "id", optional(string())],
					["idLen", "length", "id", optional(integer)],
					["lowerType", "lower", "type", optional(string())],
					["typeLen", "length", "type", optional(integer)],
					["minId", "min", "id", optional(string())],
					["maxId", "max", "id", optional(string())],
					["minType", "min", "type", optional(string())]
				] as const)("should resolve %s to undefined on a reference target", async (name, pipe, field, shape) => {

					await factory(async ({ store }) => {

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue(resource({ [`${name}=${pipe}:${field}`]: shape }), {
								"?id": [AF001.id]
							})
						}));

						expect(result).toHaveLength(1);
						expect(result?.[0]?.[name]).toBeUndefined();

					})();

				});

				it.each([
					["cntId", "count", "id"],
					["cntType", "count", "type"]
				] as const)("should count %s on a reference target", async (name, pipe, field) => {

					await factory(async ({ store }) => {

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue(resource({ [`${name}=${pipe}:${field}`]: optional(integer) }), {
								"?id": [AF001.id]
							})
						}));

						expect(result).toHaveLength(1);
						expect(result?.[0]?.[name]).toBe(1);

					})();

				});

			});

			describe("aggregate over reference and union targets — §5.8.2.1", () => {

				// min/max/sum/avg exclude references (§5.8.2.1): unlike the id/type markers (whose range is
				// an IRI-typed xsd:string, domain-compatible then runtime-excluded to undefined), a genuine
				// reference-kind property (`vendor`, `categories`) is statically incompatible with the
				// literal/numeric aggregate domains, so the pipe is rejected outright (§5.8.2). count admits
				// any value and still reduces.

				it.each([
					["minVendor", "min", "vendor"],
					["maxVendor", "max", "vendor"],
					["sumCategory", "sum", "categories"],
					["avgCategory", "avg", "categories"]
				] as const)("should reject %s over a reference property", async (name, pipe, field) => {

					await factory(async ({ store }) => {

						await expect(store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue(resource({ [`${name}=${pipe}:${field}`]: optional(string()) }), {
								"?id": [AF001.id]
							})
						})).rejects.toThrow();

					})();

				});

				it("should count a multi-valued reference property", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ "cnt=count:categories": required(integer) }), {
							"?id": [AF001.id]
						})
					}));

					expect(result).toHaveLength(1);
					expect(result?.[0]?.cnt).toBe(AF001.categories.length);

				}));

				it("should aggregate a union-typed literal path in a projection cell", factory(async ({ store }) => {

					// §5.6/§5.8.2.1: an aggregate over a union path (Vendor.score = decimal | grade) is
					// admitted — both variants are literal — unlike an aggregate over a reference kind, which
					// is rejected. count reduces over every value the path gathers, spanning both variants.
					// (min/max over a mixed-datatype union are unspecified — no single total order the backend
					// MIN/MAX honours — so only the kind-agnostic count is asserted here.)

					const defined = vendors
						.map(v => v.score)
						.filter((s): s is number | string => s !== undefined);

					const result = members(await store.lookup({
						entry: VendorsCatalogue,
						shape: Vendors,
						model: catalogue(resource({
							"cnt=count:score": required(integer)
						}))
					}));

					expect(result).toHaveLength(1);
					expect(result?.[0]?.cnt).toBe(defined.length);

				}));

			});

			describe("incompatible transforms rejected (§5.8.2)", () => {

				// §5.8.2: transforms MUST be well-typed — a transform whose domain admits no value of its
				// input step's type is incompatible and processors MUST reject the pipe (never defer to a
				// runtime undefined). lower/upper/length need xsd:string, abs/floor need numeric,
				// year/month/etc. need temporal; each pairing below is domain-incompatible.

				it.each([
					["yearOfPrice", "year", "price", optional(integer)],
					["lenOfPrice", "length", "price", optional(integer)],
					["lowerOfPrice", "lower", "price", optional(string)],
					["absOfSku", "abs", "sku", optional(decimal)]
				] as const)("should reject %s as an incompatible transform", async (name, pipe, field, shape) => {

					await factory(async ({ store }) => {

						await expect(store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue(resource({ [`${name}=${pipe}:${field}`]: shape }), {
								"?id": [AF001.id]
							})
						})).rejects.toThrow();

					})();

				});

				it("should resolve hours of a date to undefined — no time component (§5.8.2.4)", factory(async ({ store }) => {

					// §A.1.1: a date carries no time-of-day, so the hours accessor is undefined even
					// though launched is in the temporal domain.

					const target = lookup(products, p => p.launched !== undefined);

					if ( target === undefined ) { return; }

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ "h=hours:launched": optional(integer) }), {
							"?id": [target.id]
						})
					}));

					expect(result).toHaveLength(1);
					expect(result?.[0]?.h).toBeUndefined();

				}));

				it("should extract time-of-day components from a time (§5.8.2.4)", factory(async ({ store }) => {

					const target = lookup(vendors, v => v.opens !== undefined);
					const opens = target?.opens;

					if ( target === undefined || opens === undefined ) { return; }

					const [hh, mm] = opens.split(":");

					const result = members(await store.lookup({
						entry: VendorsCatalogue,
						shape: Vendors,
						model: catalogue(resource({
							"h=hours:opens": optional(integer),
							"m=minutes:opens": optional(integer)
						}), {
							"?id": [target.id]
						})
					}));

					expect(result).toHaveLength(1);
					expect(result?.[0]?.h).toBe(Number(hh));
					expect(result?.[0]?.m).toBe(Number(mm));

				}));

				it("should resolve year of a time to undefined — no date component (§5.8.2.4)", factory(async ({ store }) => {

					// §A.1.1: a time carries no date, so the year accessor is undefined even though
					// opens is in the temporal domain.

					const target = lookup(vendors, v => v.opens !== undefined);

					if ( target === undefined ) { return; }

					const result = members(await store.lookup({
						entry: VendorsCatalogue,
						shape: Vendors,
						model: catalogue(resource({ "y=year:opens": optional(integer) }), {
							"?id": [target.id]
						})
					}));

					expect(result).toHaveLength(1);
					expect(result?.[0]?.y).toBeUndefined();

				}));

			});

			describe("null propagation", () => {

				it("should return undefined for transform on absent optional entry", factory(async ({ store }) => {

					const noLaunched = lookup(products, p => p.launched === undefined);

					if ( !noLaunched ) { return; }

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ "launchYear=year:launched": optional(integer) }), {
							"?id": [noLaunched.id]
						})
					}));

					expect(result).toHaveLength(1);
					expect(result?.[0]?.launchYear).toBeUndefined();

				}));

			});

			describe("mixed plain and computed properties", () => {

				it("should return both plain and computed properties together", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"price=price": optional(decimal()),
							"floorPrice=floor:price": optional(decimal()),
							"launchYear=year:launched": optional(integer)
						}), {
							"?id": [AF001.id]
						})
					}));

					expect(result).toHaveLength(1);
					expect(result?.[0]?.price).toBe(AF001.price);
					expect(result?.[0]?.floorPrice).toBe(Math.floor(AF001.price!));
					expect(result?.[0]?.launchYear).toBe(new Date(AF001.launched!).getUTCFullYear());

				}));

			});

		});

		describe("bindings", () => {

			it("should retrieve a bare identifier as a template entry, not a projection binding", factory(async ({ store }) => {

				// a collection element whose keys are all bare identifiers is a template, not a projection
				// (qest §5.6: a projection is told by its `=`-bearing binding keys); the entry is retrieved by
				// descent, yielding the same flat value an explicit `price=price` binding would without being a
				// projection

				const expected = products.map(p => p.price).sort();

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"price": required(decimal())
					}))
				}));

				expect(result).toHaveLength(products.length);
				expect(result?.map(p => p.price).sort()).toEqual(expected);

			}));

			it("should accept explicit name=expression binding", factory(async ({ store }) => {

				// §5.6 distinct rows: equal computed years collapse to one row, and the launched-less
				// products fold into a single omitted-label row (undefined-key equality)

				const years = products.flatMap(p => p.launched !== undefined ? [new Date(p.launched).getUTCFullYear()] : []);
				const distinctYears = [...new Set(years)].sort(ascending);
				const anyAbsent = products.some(p => p.launched === undefined);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"launchYear=year:launched": required(decimal)
					}))
				})) ?? [];

				expect(result).toHaveLength(distinctYears.length+(anyAbsent ? 1 : 0));
				expect(result.filter(r => "launchYear" in r).map(r => r.launchYear).sort(ascending)).toEqual(distinctYears);
				expect(result.filter(r => !("launchYear" in r))).toHaveLength(anyAbsent ? 1 : 0);

			}));

			it("should project path-based bindings", factory(async ({ store }) => {

				// §5.6 distinct rows: many products share a vendor, so the projected vendor names
				// collapse to the distinct set

				const expected = [...new Set(products.map(p => lookup(vendors, { id: p.vendor })!.name))].sort();

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"vendorName=vendor.name": required(string())
					}))
				}));

				expect([...new Set(result?.map(p => p.vendorName))].sort()).toEqual(expected);
				expect(result).toHaveLength(expected.length);

			}));

			it("should project path ending with id", factory(async ({ store }) => {

				// §5.6 distinct rows: the projected vendor reference collapses to the distinct set of
				// referenced vendors

				const expected = [...new Set(products.map(p => p.vendor))].sort();

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"vendorId=vendor.id": required(string())
					}))
				}));

				expect([...new Set(result?.map(p => p.vendorId))].sort()).toEqual(expected);
				expect(result).toHaveLength(expected.length);

			}));

			it("should project path ending with type", factory(async ({ store }) => {

				// §5.6 distinct rows: every product's vendor shares one type, so the projection
				// collapses to a single row

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"vendorType=vendor.type": required(string())
					}))
				}));

				expect(result).toHaveLength(1);
				expect(result?.[0]?.vendorType).toBe(toys.Vendor);

			}));

			it.each([["id"], ["type"]])("should reject path with %s in middle", step => factory(async ({ store }) => {

				await expect(store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						[`broken=vendor.${step}.name`]: required(string)
					}))
				})).rejects.toThrow();

			})());

			it.each([
				["duplicate binding names", Catalogue, Products,
					{ "foo=price": required(decimal), "foo=stock": required(decimal) }],
				["shorthand and explicit bindings sharing a name", VendorsCatalogue, Vendors,
					{ "name": required(string), "name=email": required(string) }]
			] as const)("should reject %s", (_label, entry, shape, projection) => factory(async ({ store }) => {

				await expect(store.lookup({
					entry,
					shape,
					model: catalogue(resource(projection))
				})).rejects.toThrow();

			})());

			it("should project multi-transform pipe over multi-step path", factory(async ({ store }) => {

				// abs:length: — length yields a non-negative integer, so abs is a structural no-op;
				// the composition exercises multi-transform pipe over a multi-step path. §5.6 distinct
				// rows collapse equal computed lengths

				const expected = [...new Set(products.map(p => lookup(vendors, { id: p.vendor })!.name.length))].sort(ascending);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"nameLen=abs:length:vendor.name": required(integer)
					}))
				}));

				expect([...new Set(result?.map(p => p.nameLen))].sort(ascending)).toEqual(expected);
				expect(result).toHaveLength(expected.length);

			}));

			it("should project aggregate over empty path", factory(async ({ store }) => {

				// `count:` with empty path denotes an aggregate over the root collection —
				// it reduces the collection to a single scalar projection row.

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"total=count:": required(decimal)
					}))
				}));

				expect(result).toHaveLength(1);
				expect(result?.[0]?.total).toBe(products.length);

			}));

		});

		describe("projected value forms", () => {

			it("should project reference-typed binding as id", factory(async ({ store }) => {

				// §5.6 distinct rows: many products share a vendor, so the projected references
				// collapse to the distinct set

				const expected = [...new Set(products.map(p => p.vendor))].sort();

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"vendor=vendor": required(reference(Vendor))
					}))
				}));

				expect([...new Set(result?.map(p => p.vendor))].sort()).toEqual(expected);
				expect(result).toHaveLength(expected.length);

			}));

			it("should project embedded-template binding inline", factory(async ({ store }) => {

				// the id binding keeps one row per product (§5.6): without it the shared vendors would
				// collapse, obscuring the embedded-template expansion this test exercises

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"id=id": id(),
						"vendor=vendor": required(resource({
							name: required(string())
						}))
					}))
				}));

				expect(result).toHaveLength(products.length);
				result?.forEach(p => {
					const expected = lookup(vendors, v => v.name === p.vendor.name);
					expect(expected).toBeDefined();
				});

			}));

			it("should project a union-crossing path mixing string and dictionary kinds", factory(async ({ store }) => {

				// §P6 linchpin: a path crossing the Media union to the divergent `caption` property resolves
				// to a heterogeneous [string, dictionary] range (blue `Range` note). Each media member's
				// caption must surface under its own kind in the same composite cell across the fanned rows:
				// the plain-string Image.caption as a bare string, the localised Video.caption as a Dictionary map.
				// The mix is requested through the keyed form (a string alternative and a Locales alternative),
				// since blue union() cannot hold a dictionary variant — a [string, dictionary] cell has no blue-shape
				// spelling.

				const image = collections.images[0];
				const video = collections.videos[0];

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue({
						"id=id": "",
						"cap=media.caption": { "0": "", "1": { "*": "" } }
					}, {
						"?id": [AF001.id]
					})
				}));

				const caps = (result ?? []).map(r => r.cap).filter(c => c !== undefined);

				expect(caps).toContainEqual(image.caption);
				expect(caps).toContainEqual(video.caption);

			}));

			it("should project a union-typed binding by branch matching", factory(async ({ store }) => {

				// fixture invariant: every product references an existing vendor
				const expected = products.map(p => lookup(vendors, { id: p.vendor })!.address);
				const present = expected.filter(a => a !== undefined);
				const strings = present.filter(a => typeof a === "string").sort();

				// the id binding keeps one row per product (§5.6): without it the shared vendor addresses
				// would collapse, obscuring the per-branch matching this test exercises

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"id=id": id(),
						"addr=vendor.address": optional(union(
							string(),
							resource({
								street: required(string()),
								city: required(string())
							}),
							resource({
								latitude: required(decimal()),
								longitude: required(decimal())
							})
						))
					}))
				}));

				expect(result).toHaveLength(products.length);

				// each cell carries its vendor's branch value, the branch singled out by matching the
				// keyed alternative (string by kind, each embedded branch by structure), not by key

				const cells = (result ?? []).map(r => r.addr).filter(a => a !== undefined);

				expect(cells).toHaveLength(present.length);
				expect(cells.filter(c => typeof c === "string").sort()).toEqual(strings);

				cells.filter(c => typeof c !== "string").forEach(c => {
					if ( "latitude" in c ) {
						expect(c.latitude).toBeDefined();
						expect(c.longitude).toBeDefined();
					} else {
						expect(c.street).toBeDefined();
						expect(c.city).toBeDefined();
					}
				});

			}));

			it("should expand a media.subject multistep path under each branch's resource shape", factory(async ({ store }) => {

				// media.subject crosses the media union — Image.subject → Product, Video.subject → Category —
				// so the path's effective type is union(Product, Category). Each projected subject MUST expand
				// under the branch matching its own variant, not merely the first branch the path resolves to.

				const rows = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"id=id": id(),
						"subj=media.subject": optional(union(
							resource({ name: required(dictionary({ uniqueLang: true, languageIn: ["en"] })) }),
							resource({ title: required(dictionary({ uniqueLang: true, languageIn: ["en"] })) })
						))
					}))
				})) ?? [];

				// the sample wires media to a single product; select its rows by the presence of the fanned
				// `subj` cell rather than a hardcoded id, and skip when no media fixture is present

				const subjects = rows.flatMap(r => r.subj === undefined ? [] : [r.subj]);

				if ( subjects.length === 0 ) { return; }

				expect(subjects.some(s => isObject(s) && "name" in s)).toBe(true);   // image → Product subject
				expect(subjects.some(s => isObject(s) && "title" in s)).toBe(true);  // video → Category subject

			}));

			it("should reject a plain placeholder over a union-typed binding (§5.4)", factory(async ({ store }) => {

				// §5.4: a union-typed property is addressable only through the keyed variant form; a plain
				// placeholder over it is mismatched and MUST be rejected, whichever single branch it may
				// resemble. `Vendor.address` is union-typed, so the bare string binding is invalid.

				await expect(store.lookup({
					entry: VendorsCatalogue,
					shape: Vendors,
					model: catalogue(resource({
						"addr=address": optional(string())
					}))
				})).rejects.toThrow();

			}));

			// Union no longer admits a localised branch (qest redefinition), so the former
			// localised-union-variant projection test has been removed.

			// The default `{ "": Placeholder }` form has been removed under the redesign
			// (a Selection now attaches as the second tuple slot `[Placeholder, Selection]`), so no
			// default-form projection test belongs here.

			it("should reject a multi-valued projection value (§5.6)", factory(async ({ store }) => {

				await expect(store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"docs=documents": multiple(url())
					}))
				})).rejects.toThrow();

			}));

		});

		describe("outer-join composition", () => {

			// Each binding contributes its own outer-join sub-pattern against the focus row;
			// the projection emits the cross-product of those sub-patterns with the focus row
			// preserved. An empty binding contributes a single row with its cell as `undefined`
			// rather than collapsing the cross-product.

			it("should fan two multi-valued bindings into their full cross-product (§5.6)", factory(async ({ store }) => {

				// §5.6: two multi-valued projection bindings emit the cross-product of their values —
				// one row per (category, document) pair per product — never regrouped into arrays. A
				// product empty on either axis preserves a single row with that label omitted, so the
				// per-product row count is max(1, |categories|) × max(1, |documents|).

				const rowsFor = (p: typeof products[number]): number =>
					Math.max(1, p.categories.length)*Math.max(1, p.documents.length);

				const expectedRows = products.reduce((sum, p) => sum+rowsFor(p), 0);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"sku=sku": required(string()),
						"category=categories.id": required(string()),
						"document=documents": required(url)
					}))
				}));

				expect(result).toHaveLength(expectedRows);

				const countsBySku = countBy(result ?? [], r => r.sku as string);
				products.forEach(p => expect(countsBySku[p.sku]).toBe(rowsFor(p)));

			}));

			it("should fan out a multi-valued path as one row per resolved value", factory(async ({ store }) => {

				const expectedRows = products.reduce((sum, p) => sum+p.documents.length, 0);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"sku=sku": required(string()),
						"document=documents": required(url)
					}))
				}));

				expect(result).toHaveLength(expectedRows);

				const countsBySku = countBy(result ?? [], r => r.sku as string);
				products.forEach(p => expect(countsBySku[p.sku]).toBe(p.documents.length));

			}));

			it("should fan out via multi-valued intermediate step", factory(async ({ store }) => {

				const expectedRows = products.reduce((sum, p) => sum+p.categories.length, 0);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"sku=sku": required(string()),
						"category=categories.id": required(string())
					}))
				}));

				expect(result).toHaveLength(expectedRows);

				const countsBySku = countBy(result ?? [], r => r.sku as string);
				products.forEach(p => expect(countsBySku[p.sku]).toBe(p.categories.length));

			}));

			it("should preserve focus rows with the label omitted for absent optional scalars", factory(async ({ store }) => {

				// §5.6: outer-join row preservation at the path level. Products with `launched ===
				// undefined` still appear as rows, but a binding that resolves to no value has its
				// label OMITTED from the row, not present as `undefined`.

				const expectedAbsent = products.filter(p => p.launched === undefined).length;

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"sku=sku": required(string()),
						"launched=launched": optional(string())
					}))
				})) ?? [];

				expect(result).toHaveLength(products.length);

				const absentRows = result.filter(r => !("launched" in r));
				expect(absentRows).toHaveLength(expectedAbsent);
				absentRows.forEach(r => expect(r).not.toHaveProperty("launched"));

			}));

			interface CrossProductCase {
				readonly label: string;
				readonly vendor: string;
				readonly aliases: number;
				readonly contacts: number;
				readonly rows: number;
			}

			const crossProductCases: readonly CrossProductCase[] = [
				{ label: "cartesian (both populated)", vendor: "0001", aliases: 2, contacts: 4, rows: 8 },
				{ label: "outer-join (one side empty)", vendor: "0002", aliases: 0, contacts: 2, rows: 2 },
				{ label: "outer-join (both empty)", vendor: "0003", aliases: 0, contacts: 0, rows: 1 }
			];

			it.each(crossProductCases)("should compose two multi-valued bindings via $label",
				async ({ vendor, aliases, contacts, rows }) => {

					await factory(async ({ store }) => {

						const v = lookup(vendors, x => x.id === `${VendorsCatalogue}${vendor}`);

						if ( !v ) { return; }

						// §5.4: the union-typed `contacts` binding is addressable only through the
						// keyed form, one placeholder per branch matched by kind (email and phone share the
						// string kind) or structure (the PostalAddress and Place templates)

						const result = members(await store.lookup({
							entry: VendorsCatalogue,
							shape: Vendors,
							model: catalogue(resource({
								"alias=aliases": optional(string),
								"contact=contacts": optional(union(
									// §5.4: a single string alternative matches BOTH same-kind string variants
									// (email and phone) by kind, its value immaterial; the two templates match the
									// node variants by structure
									string(),
									resource({
										street: required(string()),
										city: required(string())
									}),
									resource({
										latitude: required(decimal()),
										longitude: required(decimal())
									})
								))
							}), {
								"?id": [v.id]
							})
						}));

						expect(result).toHaveLength(rows);

						// §5.6 empty-side outer-join: a binding with no resolved values preserves a single
						// row but has its label OMITTED, rather than collapsing the cross-product or
						// appearing as a present `undefined` cell.

						if ( aliases === 0 ) { (result ?? []).forEach(r => expect(r).not.toHaveProperty("alias")); }
						if ( contacts === 0 ) { (result ?? []).forEach(r => expect(r).not.toHaveProperty("contact")); }

					})();

				}
			);

		});

		describe("distinct rows — §5.6", () => {

			// §5.6: a projection yields the set of distinct binding tuples. Rows sharing the same cell
			// values collapse — folding both cross-product fan-out duplicates and equal tuples
			// contributed by different items — unless an identifying binding keeps them apart.

			it("should collapse cross-item duplicate tuples into one row", factory(async ({ store }) => {

				// condition is low-cardinality across the collection, so projecting it alone yields one
				// row per distinct condition rather than one per product

				const expected = [...new Set(products.map(p => p.condition))].sort();

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"condition=condition": required(string())
					}))
				}));

				expect([...new Set(result?.map(r => r.condition))].sort()).toEqual(expected);
				expect(result).toHaveLength(expected.length);

			}));

			it("should collapse rows with a shared omitted label (undefined-key equality)", factory(async ({ store }) => {

				// §5.6: a pair of omitted labels counts as equal, so the products with no launched date
				// fold into a single label-less row rather than one row each

				const anyAbsent = products.some(p => p.launched === undefined);

				if ( !anyAbsent ) { return; }

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"launched=launched": optional(string())
					}))
				})) ?? [];

				expect(result.filter(r => !("launched" in r))).toHaveLength(1);

			}));

			it("should keep otherwise-equal items apart with an identifying binding", factory(async ({ store }) => {

				// §5.6: an id binding makes every item's tuple unique, restoring one row per item even
				// when the sibling cell values coincide

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"id=id": id(),
						"condition=condition": required(string())
					}))
				}));

				expect(result).toHaveLength(products.length);

			}));

		});

		// §9.2 / §5.6: a localised projection binding yields ONE complete Localised cell per focus
		// row — all tags matching the binding's TagRange patterns in a single tag-keyed map — via
		// deferred two-pass expansion, never a per-(focus, tag) fan-out. Focus rows with no
		// matching tag are preserved with the label omitted (§5.6).
		describe("localised projection — §5.6", () => {

			it("should yield one complete cell per focus for the wildcard pattern", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"label=name": required(dictionary({ uniqueLang: true }))
					}))
				}));

				// one row per focus, with every name tag regrouped into its focus cell (no fan-out)

				expect(result).toHaveLength(products.length);
				result?.forEach(r => expect(Object.keys(r.label as Record<string, string>).length).toBeGreaterThan(0));

				const totalTags = result?.reduce((s, r) => s+Object.keys(r.label as Record<string, string>).length, 0) ?? 0;
				expect(totalTags).toBe(products.reduce((s, p) => s+Object.keys(p.name ?? {}).length, 0));

			}));

			it("should filter by a single tag-range pattern", factory(async ({ store }) => {

				// Every product carries an `en` name, so the `en` range matches all focus rows; each
				// focus cell carries only its `en*` tags.

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"label=name": required(dictionary({ uniqueLang: true, languageIn: ["en"] }))
					}))
				}));

				expect(result).toHaveLength(products.length);
				result?.forEach(r => {
					const cell = r.label as Record<string, string>;
					Object.keys(cell).forEach(tag => expect(tag).toMatch(/^en/));
				});

			}));

			it("should combine multiple tag-range patterns into one cell per focus", factory(async ({ store }) => {

				const expectedRows = products.filter(p => p.name?.en !== undefined || p.name?.fr !== undefined).length;

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"label=name": required(dictionary({ uniqueLang: true, languageIn: ["en", "fr"] }))
					}))
				}));

				expect(result).toHaveLength(expectedRows);
				result?.forEach(r => {
					const cell = r.label as Record<string, string>;
					Object.keys(cell).forEach(tag => expect(tag).toMatch(/^(en|fr)/));
				});

			}));

			it("should preserve focus rows with the label omitted for non-matching tag", factory(async ({ store }) => {

				// description is optional; products without an `en` description still appear once,
				// with the binding's label OMITTED from the row (§5.6 outer-join optionality).

				const presentEn = products.filter(p => p.description?.en !== undefined).length;
				const missingEn = products.filter(p => p.description?.en === undefined).length;

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"sku=sku": required(string()),
						"desc=description": optional(dictionary({ uniqueLang: true, languageIn: ["en"] }))
					}))
				}));

				expect(result).toHaveLength(presentEn+missingEn);
				expect(result?.filter(r => !("desc" in r))).toHaveLength(missingEn);

			}));

			it("should aggregate the coalesced strings of a localised path (§5.8.1, §6.2)", factory(async ({ store }) => {

				// coalesce-first: under locale ["en"] each name contributes its coalesced en string, an
				// ordinary xsd:string thereafter, so min: reduces the collection to the codepoint-least name

				const names = products
					.map(p => p.name?.en)
					.filter((n): n is string => n !== undefined);

				const expected = [...names].sort(ascending)[0];

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"first=min:name": required(string)
					}))
				}, { locale: ["en"] }));

				expect(result).toHaveLength(1);
				expect(result?.[0]?.first).toBe(expected);

			}));

			it("should apply a scalar transform to the coalesced string of a localised path (§5.8.1, §6.2)", factory(async ({ store }) => {

				// coalesce-first under the und default: each und-tagged vendor label coalesces to its
				// und string, so length: maps each row to the label's character count (ungrouped)

				const expected = vendors
					.map(v => v.label?.und)
					.filter((l): l is string => l !== undefined)
					.map(l => l.length)
					.sort(ascending);

				const result = members(await store.lookup({
					entry: VendorsCatalogue,
					shape: Vendors,
					model: catalogue(resource({
						"len=length:label": required(integer)
					}))
				})) ?? [];

				expect(result.map(r => r.len).sort(ascending)).toEqual(expected);

			}));

			it("should contribute no value for an array-per-tag localised step (§6.2)", factory(async ({ store }) => {

				// an array-per-tag property cannot coalesce, so the step contributes no value and the
				// piped aggregate evaluates under the empty-set rules: count: totals 0 despite stored keywords

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"kw=count:keywords": required(integer)
					}))
				}));

				expect(result).toHaveLength(1);
				expect(result?.[0]?.kw).toBe(0);

			}));

			// §5.6: a structural locale binding counts as a single value and does not fan out rows, so the
			// localised cell is one complete `Localised` per focus; composing with a non-localised sibling
			// yields one row per focus (no per-tag cartesian).
			it("should compose with non-localised siblings without per-tag fan-out", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"sku=sku": required(string()),
						"label=name": required(dictionary({ uniqueLang: true }))
					}))
				}));

				// one row per focus — each sku appears exactly once, paired with its complete name cell

				expect(result).toHaveLength(products.length);

				const skus = result?.map(r => r.sku as string) ?? [];
				expect(new Set(skus).size).toBe(skus.length);

			}));

		});

		describe("grouping", () => {

			interface GroupCase {
				readonly label: string;
				readonly key: string;
				readonly shape: Member;
				readonly groups: number;
				readonly check: (key: Resource[string]) => boolean;
			}

			const cases: readonly GroupCase[] = [

				{
					label: "plain key",
					key: "condition=condition",
					shape: required(string()),
					groups: new Set(products.map(p => p.condition)).size,
					check: k => typeof k === "string"
				},
				{
					label: "path key",
					key: "vendorName=vendor.name",
					shape: required(string()),
					groups: new Set(products.map(p => lookup(vendors, { id: p.vendor })!.name)).size,
					check: k => typeof k === "string"
				}

			];

			it.each(cases)("should group by $label", async ({ key, shape, groups, check }) => {

				await factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							[key]: shape,
							"cnt=count:sku": required(decimal)
						}))
					}));

					expect(result).toHaveLength(groups);
					expect(result?.every(r => check(r[key.split("=")[0]]))).toBe(true);

				})();

			});

			it("should group an optional computed key with one group for the absent key (§5.8.2.1)",
				factory(async ({ store }) => {

					// §5.8.2.1: grouping on the optional computed key year:launched. Rows whose key is
					// undefined (the launched-less products) collapse into one additional group whose
					// output row OMITS the key, extending the no-value rule of §5.6.

					const name = "launchYear";

					const years = products.flatMap(p =>
						p.launched !== undefined ? [new Date(p.launched).getUTCFullYear()] : []
					);
					const distinctYears = new Set(years).size;
					const anyAbsent = products.some(p => p.launched === undefined);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"launchYear=year:launched": optional(integer),
							"cnt=count:sku": required(decimal)
						}))
					})) ?? [];

					expect(result).toHaveLength(distinctYears+(anyAbsent ? 1 : 0));
					expect(result.filter(r => !(name in r))).toHaveLength(anyAbsent ? 1 : 0);
					expect(result.filter(r => name in r).every(r => typeof r[name] === "number")).toBe(true);

				}));

			it("should fan a multi-valued grouping key into one group per value (§5.8.2.1)",
				factory(async ({ store }) => {

					// §5.8.2.1: grouping applies to the fanned-out rows, so a multi-valued grouping-key
					// binding fans an item into one group per value: a product in two categories
					// contributes to both category groups. The group count is the number of distinct
					// category memberships, and each group's count is its membership size.

					const byCategory = products.reduce<Record<string, number>>((acc, p) =>
						p.categories.reduce((a, c) => ({ ...a, [c]: (a[c] ?? 0)+1 }), acc), {});

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"category=categories.id": required(string()),
							"cnt=count:sku": required(decimal)
						}))
					})) ?? [];

					expect(result).toHaveLength(Object.keys(byCategory).length);
					result.forEach(r => expect(r.cnt).toBe(byCategory[String(r.category)]));

				}));

		});

		describe("composition", () => {

			interface CompositionCase {
				readonly label: string;
				readonly projection: Record<string, Member>;
				readonly expected: number;
				readonly verify: (result: readonly Resource[]) => void;
			}

			const groupCount = new Set(products.map(p => p.condition)).size;

			function avgOf(group: readonly typeof products[number][]): number {
				return group.reduce((s, p) => s+(p.price as number), 0)/group.length;
			}

			const cases: readonly CompositionCase[] = [

				{
					label: "projected fields only (P)",
					projection: {
						"price=price": required(decimal()),
						"stock=stock": required(decimal)
					},
					// §5.6 distinct rows: products sharing a (price, stock) tuple collapse to one row
					expected: new Set(products.map(p => `${p.price}|${p.stock}`)).size,
					verify: result => {
						const expected = [...new Set(products.map(p => `${p.price}|${p.stock}`))].sort();
						const actual = result.map(r => `${r.price}|${r.stock}`).sort();
						expect(actual).toEqual(expected);
					}
				},
				{
					label: "aggregate fields only (A)",
					projection: {
						"totalCount=count:sku": required(decimal),
						"avgPrice=avg:price": required(decimal)
					},
					expected: 1,
					verify: result => {
						expect(result[0]?.totalCount).toBe(products.length);
						expect(result[0]?.avgPrice as number).toBeCloseTo(avgOf(products), 5);
					}
				},
				{
					label: "projected then aggregate (P A)",
					projection: {
						"condition=condition": required(string()),
						"avgPrice=avg:price": required(decimal)
					},
					expected: groupCount,
					verify: result => {
						expect(new Set(result.map(r => r.condition)))
							.toEqual(new Set(products.map(p => p.condition)));
						result.forEach(r => {
							const group = products.filter(p => p.condition === r.condition);
							expect(r.avgPrice as number).toBeCloseTo(avgOf(group), 5);
						});
					}
				},
				{
					label: "aggregate then projected (A P)",
					projection: {
						"avgPrice=avg:price": required(decimal()),
						"condition=condition": required(string())
					},
					expected: groupCount,
					verify: result => {
						expect(new Set(result.map(r => r.condition)))
							.toEqual(new Set(products.map(p => p.condition)));
						result.forEach(r => {
							const group = products.filter(p => p.condition === r.condition);
							expect(r.avgPrice as number).toBeCloseTo(avgOf(group), 5);
						});
					}
				},
				{
					label: "projected, aggregate, projected (P A P)",
					projection: {
						"condition=condition": required(string()),
						"avgPrice=avg:price": required(decimal),
						"stock=stock": required(decimal)
					},
					expected: new Set(products.map(p => `${p.condition}|${p.stock}`)).size,
					verify: result => {
						expect(new Set(result.map(r => `${r.condition}|${r.stock}`)))
							.toEqual(new Set(products.map(p => `${p.condition}|${p.stock}`)));
						result.forEach(r => {
							const group = products.filter(p => p.condition === r.condition && p.stock === r.stock);
							expect(r.avgPrice as number).toBeCloseTo(avgOf(group), 5);
						});
					}
				}

			];

			it.each(cases)("should support $label", async ({ projection, expected, verify }) => {

				await factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource(projection))
					}));

					expect(result).toHaveLength(expected);
					verify(result ?? []);

				})();

			});

		});

		describe("selection interaction", () => {

			describe("filtering on projected rows", () => {

				it("should filter on scalar fields in projected queries", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"price=price": required(decimal())
						}), {
							">=price": 20
						})
					}));

					expect(result?.every(p => p.price >= 20)).toBe(true);

				}));

				it("should filter on aggregate expressions in aggregate queries", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"condition=condition": required(string()),
							"cnt=count:sku": required(decimal)
						}), {
							">=count:sku": 2
						})
					}));

					expect(result?.every(p => p.cnt >= 2)).toBe(true);

				}));

				it("should filter groups by a count aggregate over a marker (§5.7 HAVING, §5.8.2)", factory(async ({ store }) => {

					// §5.7 + §5.8.2.1: in a grouped query an aggregate constraint filters groups (HAVING).
					// `count` is the sole aggregate valid over a marker (§5.8.2), so `>=count:id` keeps only
					// the condition groups holding at least the threshold many items, exercising the marker
					// branch of the group-filter pass that the property case above covers for a property.

					const threshold = 5;

					const expected = Object.entries(countBy(products, p => p.condition))
						.filter(([, n]) => n >= threshold)
						.map(([condition]) => condition)
						.sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"condition=condition": required(string()),
							"cnt=count:id": required(decimal)
						}), {
							">=count:id": threshold
						})
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(expected.length).toBeLessThan(new Set(products.map(p => p.condition)).size);
					expect(result?.map(r => r.condition).sort()).toEqual(expected);
					expect(result?.every(r => r.cnt >= threshold)).toBe(true);

				}));

				it("should filter groups by a substring match over an aggregate (§5.7.2 HAVING)", factory(async ({ store }) => {

					// §5.7.2 + §5.8.2.1: a string-valued aggregate (`min` over the xsd:string sku) is a substring
					// target; grouped, the `~` constraint filters groups (HAVING), keeping those whose reduced value
					// contains the search token.

					const minSku = (condition: string) =>
						products.filter(p => p.condition === condition).map(p => p.sku).sort()[0];
					const conditions = [...new Set(products.map(p => p.condition))];
					const token = minSku("new");
					const expected = conditions.filter(c => minSku(c).toLowerCase().includes(token.toLowerCase())).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"condition=condition": required(string()),
							"cnt=count:sku": required(decimal)
						}), {
							"~min:sku": token
						})
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(expected.length).toBeLessThan(conditions.length);
					expect(result?.map(r => r.condition).sort()).toEqual(expected);

				}));

				it("should filter groups by a disjunctive match over an aggregate (§5.7.3 HAVING)", factory(async ({ store }) => {

					// §5.7.3 + §5.8.2.1: a `?` set match over an aggregate keeps groups whose reduced value is one of
					// the options; grouped, it filters groups (HAVING).

					const minSku = (condition: string) =>
						products.filter(p => p.condition === condition).map(p => p.sku).sort()[0];
					const conditions = [...new Set(products.map(p => p.condition))];
					const options = [minSku("new"), minSku("used")];
					const expected = conditions.filter(c => options.includes(minSku(c))).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"condition=condition": required(string()),
							"cnt=count:sku": required(decimal)
						}), {
							"?min:sku": options
						})
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(expected.length).toBeLessThan(conditions.length);
					expect(result?.map(r => r.condition).sort()).toEqual(expected);

				}));

				it("should filter groups by a conjunctive match over an aggregate (§5.7.3 HAVING)", factory(async ({ store }) => {

					// §5.7.3 + §5.8.2.1: `!` over a single-valued aggregate satisfies only a single-element option
					// set, so `!min:sku` keeps the groups whose reduced value equals the sole option; grouped, it
					// filters groups (HAVING).

					const minSku = (condition: string) =>
						products.filter(p => p.condition === condition).map(p => p.sku).sort()[0];
					const conditions = [...new Set(products.map(p => p.condition))];
					const target = minSku("new");
					const expected = conditions.filter(c => minSku(c) === target).sort();

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"condition=condition": required(string()),
							"cnt=count:sku": required(decimal)
						}), {
							"!min:sku": [target]
						})
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(expected.length).toBeLessThan(conditions.length);
					expect(result?.map(r => r.condition).sort()).toEqual(expected);

				}));

				it("should filter on both scalar and aggregate in mixed queries", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"condition=condition": required(string()),
							"avgPrice=avg:price": required(decimal)
						}), {
							"?condition": ["new"],
							">=avg:price": 10
						})
					}));

					expect(result?.every(p => p.condition === "new" && p.avgPrice >= 10)).toBe(true);

				}));

				it("should filter on non-projected fields", factory(async ({ store }) => {

					// §5.6 distinct rows: filtering restricts the items, then equal projected prices
					// collapse

					const expected = [...new Set(products.filter(p => p.condition === "new").map(p => p.price))];

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"price=price": required(decimal())
						}), {
							"?condition": ["new"]
						})
					}));

					expect(result).toHaveLength(expected.length);

				}));

				it("should not group when the aggregate appears only in the selection (ungrouped per-item reduction, §5.8.2.1)", factory(async ({ store }) => {

					// §5.8.2.1: grouping is fixed by the projection alone. With a non-aggregate
					// projection the query stays ungrouped, so a selection aggregate reduces over each
					// item's own values rather than grouping the collection. `count:categories` is
					// per-item here, keeping one row per product that carries at least two categories.

					const expected = products.filter(p => p.categories.length >= 2);

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"sku=sku": required(string())
						}), {
							">=count:categories": 2
						})
					}));

					expect(expected.length).toBeGreaterThan(0);
					expect(result?.map(r => r.sku).sort()).toEqual(expected.map(p => p.sku).sort());

				}));

				it("should apply non-aggregate filters pre-grouping, restricting per-group aggregates", factory(async ({ store }) => {

					const threshold = 50;
					const expectedCountsByVendor = new Map<string, number>();
					products
						.filter(p => p.price >= threshold)
						.forEach(p => expectedCountsByVendor.set(p.vendor, (expectedCountsByVendor.get(p.vendor) ?? 0)+1));

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"vendor=vendor": required(reference(Vendor)),
							"cnt=count:sku": required(decimal)
						}), {
							">=price": threshold
						})
					}));

					expect(result?.length).toBe(expectedCountsByVendor.size);
					result?.forEach(r => {
						expect(r.cnt).toBe(expectedCountsByVendor.get(r.vendor as string));
					});

				}));

				it("should combine pre-grouping and post-grouping filters", factory(async ({ store }) => {

					const priceThreshold = 50;
					const countThreshold = 2;

					const countsByCondition = new Map<string, number>();
					products
						.filter(p => p.price >= priceThreshold)
						.forEach(p => countsByCondition.set(p.condition, (countsByCondition.get(p.condition) ?? 0)+1));
					const expected = [...countsByCondition.entries()]
						.filter(([, n]) => n >= countThreshold)
						.sort(([a], [b]) => a.localeCompare(b));

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"condition=condition": required(string()),
							"cnt=count:sku": required(decimal)
						}), {
							">=price": priceThreshold,
							">=count:sku": countThreshold
						})
					}));

					expect(result?.length).toBe(expected.length);
					expect(result?.map(r => [r.condition, r.cnt] as const).sort(([a], [b]) => String(a).localeCompare(String(b))))
						.toEqual(expected);

				}));

			});

			describe("sorting on projected rows", () => {

				it("should sort on scalar fields in projected queries", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"price=price": required(decimal())
						}), {
							"^price": 1
						})
					}));

					const prices = result?.map(p => p.price) ?? [];

					expect(prices).toEqual([...prices].sort(ascending));

				}));

				it("should sort on aggregate expressions", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"condition=condition": required(string()),
							"cnt=count:sku": required(decimal)
						}), {
							"^count:sku": 1
						})
					}));

					const counts = result?.map(p => p.cnt) ?? [];

					expect(counts).toEqual([...counts].sort(ascending));

				}));

				it("should sort on a union-typed projected binding across processing-type tiers", factory(async ({ store }) => {

					// §5.7.5 in the projection arm: a union-typed `score` binding sorts projected
					// rows by the same total order as a plain selection — undefined first, then
					// numeric, then xsd:string, then within each tier by comparison

					const tier = (s: undefined | number | string): number =>
						s === undefined ? 0 : typeof s === "number" ? 1 : 2;

					const expected = [...vendors]
						.sort(by(v => v.score, (a, b) =>
							tier(a)-tier(b)
							|| (typeof a === "number" && typeof b === "number" ? a-b : 0)
							|| (typeof a === "string" && typeof b === "string" ? ascending(a, b) : 0)))
						.map(v => v.code);

					const result = members(await store.lookup({
						entry: VendorsCatalogue,
						shape: Vendors,
						model: catalogue(resource({
							// §5.2/§5.4: placeholder values are immaterial — the bare string() matches
							// Vendor.code by kind, and the score union's alternatives match their branches
							// by kind (decimal → number, grade → string), so neither placeholder need be a
							// legal value of its property
							"code=code": required(string()),
							"score=score": optional(union(decimal(), string()))
						}), {
							"^score": 1
						})
					}));

					expect(result?.map(r => r.code)).toEqual(expected);

				}));

				it("should sort on non-projected fields", factory(async ({ store }) => {

					// §5.6 distinct rows: only price is projected, so equal prices collapse regardless
					// of the non-projected sort key

					const expected = new Set(products.map(p => p.price)).size;

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"price=price": required(decimal())
						}), {
							"^condition": 1
						})
					}));

					expect(result).toHaveLength(expected);

				}));

				const rejectKeyCases: ReadonlyArray<readonly [string, Selection]> = [
					["ordering", { "^vendor": 1 }],
					["focus", { "+vendor": [vendors[0].id] }]
				];

				it.each(rejectKeyCases)("should reject a non-aggregate %s key that matches no grouping-key binding (§5.8.2.1)", (_label, selection) => factory(async ({ store }) => {

					// §5.8.2.1: under grouped semantics (the `cnt` aggregate binding groups by the
					// non-aggregate `condition` binding) a non-aggregate ordering or focus expression
					// MUST match, verbatim, an existing grouping-key binding. `vendor` matches none, so
					// the constraint is rejected; grouping is never inferred from a sort or focus key.

					await expect(store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"condition=condition": required(string()),
							"cnt=count:sku": required(decimal)
						}), selection)
					})).rejects.toThrow();

				})());

			});

			describe("focusing on projected rows", () => {

				it("should prioritise matching resources when focus targets a non-projected entry",
					factory(async ({ store }) => {

						// Focus operator reorders rows rather than filtering them — the projected
						// schema (surname-only) is unchanged but rows whose `condition` matches the
						// focus value appear first.

						const result = members(await store.lookup({
							entry: Catalogue,
							shape: Products,
							model: catalogue(resource({
								"sku=sku": required(string())
							}), {
								"+condition": ["refurbished"]
							})
						}));

						expect(result).toHaveLength(products.length);

					}));

			});

			describe("slicing on projected rows", () => {

				it("should slice projected queries via offset and limit", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"price=price": required(decimal())
						}), {
							"^price": 1,
							"@": 0,
							"#": 3
						})
					}));

					expect(result?.length ?? 0).toBeLessThanOrEqual(3);

				}));

				it("should slice grouped rows", factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"condition=condition": required(string()),
							"cnt=count:sku": required(decimal)
						}), {
							"#": 2
						})
					}));

					expect(result?.length ?? 0).toBeLessThanOrEqual(2);

				}));

				it("should apply filter, order, and slice together on projected rows (§5.6)", factory(async ({ store }) => {

					// §5.6 + §5.7: filter, order, and slice all apply to the projected schema. Filter
					// price >= 10, order by price ascending, limit 5; the qualifying rows come back
					// ordered and bounded.

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({
							"price=price": required(decimal())
						}), {
							">=price": 10,
							"^price": 1,
							"#": 5
						})
					})) ?? [];

					const prices = result.map(r => r.price);

					expect(result.length).toBeLessThanOrEqual(5);
					expect(prices.every(p => p >= 10)).toBe(true);
					expect(prices).toEqual([...prices].sort(ascending));

				}));

			});

		});

		describe("grouped analytics with nested probes", () => {

			it("should group by a path key with count and multi-key sort (§5.8.2.1)", factory(async ({ store }) => {

				// Group by vendor name (a path key), count per group, and sort by count DESC (precedence
				// 1) then vendor name ASC (precedence 2). §5.8.2.1: a non-aggregate ordering key MUST
				// reference an existing grouping key, so the secondary sorts by the projected vendor.name
				// rather than by a non-ordered reference such as vendor.id.

				const byVendor = products.reduce<Record<string, number>>((acc, p) => {
					// fixture invariant: every product references an existing vendor
					const name = lookup(vendors, { id: p.vendor })!.name;
					return { ...acc, [name]: (acc[name] ?? 0)+1 };
				}, {});

				const expected = Object.entries(byVendor)
					.map(([name, count]) => ({ name, count }))
					.sort(compound(by(x => x.count, descending), by(x => x.name)));

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"vendorName=vendor.name": required(string()),
						"cnt=count:sku": required(decimal)
					}), {
						"^count:sku": -1,
						"^vendor.name": 2
					})
				})) ?? [];

				const actual = result.map(r => ({ name: r.vendorName, count: r.cnt }));

				expect(actual).toEqual(expected);

			}));

			it("should compose the full facet pipeline in one query (§5.8.2.1)", factory(async ({ store }) => {

				// One faceted query exercising the whole grouped pipeline: σ-pre (non-aggregate filter
				// restricting items before grouping), γ (grouping key + count), σ-agg (aggregate filter
				// keeping only groups whose count passes, HAVING), τ-agg (sort by count DESC) with a
				// deterministic secondary grouping key, and slice. Per §5.8.2.1 the non-aggregate filter
				// restricts items pre-grouping and the aggregate filter restricts groups post-aggregation.

				const counts = products
					.filter(p => p.price >= 10)
					.reduce<Record<string, number>>((acc, p) => ({
						...acc,
						[p.condition]: (acc[p.condition] ?? 0)+1
					}), {});

				const expected = Object.entries(counts)
					.filter(([, n]) => n >= 2)
					.map(([condition, cnt]) => ({ condition, cnt }))
					.sort(compound(by(x => x.cnt, descending), by(x => x.condition)))
					.slice(0, 5);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"condition=condition": required(string()),
						"cnt=count:sku": required(decimal)
					}), {
						">=price": 10,
						">=count:sku": 2,
						"^count:sku": -1,
						"^condition": 2,
						"#": 5
					})
				})) ?? [];

				const actual = result.map(r => ({ condition: r.condition, cnt: r.cnt }));

				expect(actual).toEqual(expected);

			}));

			it("should sort grouped rows by an unprojected aggregate (§5.8.2.1)", factory(async ({ store }) => {

				// §5.8.2.1: aggregate ordering constraints are independent of the projected bindings, so an aggregate
				// MAY drive the order without being projected. Grouping is triggered by the projected
				// total aggregate and keyed by condition; the groups order by descending count, unprojected.

				const counts = products.reduce<Record<string, number>>(
					(acc, p) => ({ ...acc, [p.condition]: (acc[p.condition] ?? 0)+1 }), {});
				const expected = Object.entries(counts).sort(by(e => e[1], descending)).map(([condition]) => condition);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"condition=condition": required(string()),
						"total=sum:stock": required(decimal)
					}), {
						"^count:sku": -1
					})
				})) ?? [];

				expect(result.map(r => r.condition)).toEqual(expected);

			}));

			it("should aggregate over a multi-valued path with bag semantics (§5.8.2.1)", factory(async ({ store }) => {

				// §5.8.2.1 bag semantics: an aggregate counts every contributing value with no dedup, so
				// count:categories over the whole collection totals each product's category memberships.

				const expected = products.reduce((s, p) => s+p.categories.length, 0);

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({ "total=count:categories": required(decimal) }))
				})) ?? [];

				expect(result[0]?.total).toBe(expected);

			}));

			it("should rank a grouping-key value first under focus (§5.7.4)", factory(async ({ store }) => {

				// §5.7.4 + §5.8.2.1: focus on the grouping key ranks the matching group first. Group by
				// condition, count per group, focus "refurbished".

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"condition=condition": required(string()),
						"cnt=count:sku": required(decimal)
					}), {
						"+condition": ["refurbished"]
					})
				})) ?? [];

				expect(result[0]?.condition).toBe("refurbished");

			}));

		});

		describe("empty-set aggregates", () => {

			const impossibleFilter: Selection = { ">price": 999999 };

			it.each([
				{ name: "count", binding: "cnt=count:sku", expected: 0 },
				{ name: "sum", binding: "total=sum:price", expected: 0 },
				{ name: "avg", binding: "average=avg:price", expected: undefined },
				{ name: "min", binding: "minimum=min:price", expected: undefined },
				{ name: "max", binding: "maximum=max:price", expected: undefined }
			])("should return $name $expected on empty set", async ({ binding, expected }) => {

				await factory(async ({ store }) => {

					const result = members(await store.lookup({
						entry: Catalogue,
						shape: Products,
						model: catalogue(resource({ [binding]: required(decimal()) }), impossibleFilter)
					}));

					expect(result?.[0]?.[binding.split("=")[0]]).toBe(expected);

				})();

			});

			it("should return empty result set for impossible filter without aggregates", factory(async ({ store }) => {

				const result = members(await store.lookup({
					entry: Catalogue,
					shape: Products,
					model: catalogue(resource({
						"price=price": required(decimal())
					}), impossibleFilter)
				}));

				expect(result).toHaveLength(0);

			}));

		});

	});

}
