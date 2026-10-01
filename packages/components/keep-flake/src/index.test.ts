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
import { decimal, integer } from "@metreeca/blue/number";
import { getShapeTarget, reference } from "@metreeca/blue/reference";
import { id, multiple, optional, required, resource, type } from "@metreeca/blue/resource";
import { string } from "@metreeca/blue/string";
import { getShapeBranches, union, type UnionShape } from "@metreeca/blue/union";
import { eager, effective, type Range } from "@metreeca/blue/value";
import type { Identifier } from "@metreeca/core";
import { createNamespace } from "@metreeca/core/resource";
import { PostalAddress, Product, Vendor } from "@metreeca/keep-suite/toys";
import type { Probe, Query, Slot, Template, Transform } from "@metreeca/qest/model";
import { describe, expect, expectTypeOf, it } from "vitest";
import { getQueryEntries, getUnionBranches, getUnionPlaceholders } from "./index.core.js";
import type { Branch, Entries, Flake } from "./index.js";
import {
	createFlake,
	createQueryFlake,
	getFlakeProjection,
	getFlakeVariant,
	isModelBranch,
	isProbeBranch,
	isQueryBranch,
	isRequiredFlake
} from "./index.js";


/**
 * The first branch reached by descending `steps` from a coordinate, throwing if any step is unreached.
 */
function at(node: Flake | Branch, ...steps: readonly Identifier[]): Branch {
	return steps.reduce<Branch>((current, step) => {
		const branch = (current.entries ?? {})[step];
		if ( branch === undefined ) { throw new Error(`no branch at step <${step}>`); }
		return branch;
	}, node as Branch);
}

/**
 * The property-major descent record at a coordinate.
 */
function props(node: Flake | Branch): Entries {
	return node.entries ?? {};
}

/**
 * The branches the union variant at `index` declares, keyed by property name — located by the names the
 * variant's target declares, since a name shared across variants folds to one branch. The coordinate's
 * flattened {@link Flake.range | range} carries the variants directly, so a root member union and a
 * branch's union range read alike.
 */
function variant(node: Flake | Branch, index: number): Record<Identifier, Branch> {
	const variants = getShapeBranches(node.range.shape);
	if ( variants.length <= 1 ) { throw new Error("not a union coordinate"); }
	const target = getShapeTarget(variants[index]);
	return Object.fromEntries(
		Object.entries(node.entries ?? {}).filter(([name]) => target?.members[name] !== undefined)
	);
}

/**
 * Checks whether the union variant at `index` declares any reached property.
 */
function hasVariant(node: Flake | Branch, index: number): boolean {
	return Object.keys(variant(node, index)).length > 0;
}


describe("createFlake", () => {

	const ns = createNamespace("https://example.org/ns#", [

		"Thing",
		"Tag",
		"Postal",

		"label",
		"description",
		"info",
		"count",
		"tags",
		"keywords",
		"archived",
		"parent",
		"children",
		"address",
		"street",
		"city",
		"name"

	]);


	function Thing() {
		return resource({

			space: ns,
			class: ns.Thing

		}, {

			id: id(),
			type: type(),

			label: required(string),
			description: optional(dictionary()),
			info: optional(dictionary({ languageIn: ["en", "de"] })),

			count: required(integer),

			tags: multiple(Tag),
			keywords: multiple(dictionary()),
			archived: optional(reference(Tag), { captive: true }),
			parent: optional(reference(Thing)),
			children: multiple(reference(Thing), { foreign: true }),

			address: optional(union(string(), Postal))

		});
	}

	function Tag() {
		return resource({

			space: ns

		}, {

			label: required(string)

		});
	}

	function Postal() {
		return resource({

			space: ns,
			class: ns.Postal

		}, {

			street: required(string),
			city: required(string)

		});
	}


	describe("shape mode", () => {

		describe("root", () => {

			it("has empty path", async () => {

				expect(createFlake(Thing).path).toEqual([]);

			});

			it("has empty pipe — navigation root carries no transform", async () => {

				expect(createFlake(Thing).pipe).toEqual([]);

			});

		});

		describe("scalar root", () => {

			it.each([
				["string", string()],
				["number", decimal()],
				["dictionary", dictionary()]
			] as const)("yields a degenerate leaf flake on a %s shape", async (_, shape) => {

				const flake = createFlake(shape);

				expect(flake.entries).toBeUndefined();
				expect(flake.path).toEqual([]);
				expect(flake.pipe).toEqual([]);

			});

		});

		describe("walk", () => {

			describe("includes every shape entry", () => {

				it("keeps the id entry as a branch with entry.kind 'id'", async () => {

					expect(at(createFlake(Thing), "id").entry.kind).toBe("id");

				});

				it("keeps the type entry as a branch with entry.kind 'type'", async () => {

					expect(at(createFlake(Thing), "type").entry.kind).toBe("type");

				});

				it("keeps every property entry", async () => {

					const flake = createFlake(Thing);

					expect("label" in props(flake)).toBe(true);
					expect("description" in props(flake)).toBe(true);
					expect("info" in props(flake)).toBe(true);
					expect("count" in props(flake)).toBe(true);
					expect("tags" in props(flake)).toBe(true);
					expect("archived" in props(flake)).toBe(true);
					expect("parent" in props(flake)).toBe(true);
					expect("children" in props(flake)).toBe(true);
					expect("address" in props(flake)).toBe(true);

				});

				it("never carries a query annotation", async () => {

					const flake = createFlake(Thing);

					expect(at(flake, "id").drain).toBeUndefined();
					expect(at(flake, "label").drain).toBeUndefined();
					expect(at(flake, "tags").drain).toBeUndefined();
					expect(at(flake, "archived").drain).toBeUndefined();
					expect(at(flake, "address").drain).toBeUndefined();

				});

			});

			describe("descent", () => {

				it("scalar property is a leaf with empty components", async () => {

					expect(at(createFlake(Thing), "label").entries).toBeUndefined();

				});

				it("localised property is a leaf with empty components", async () => {

					expect(at(createFlake(Thing), "description").entries).toBeUndefined();

				});

				it("plain reference is a leaf (no descent — would cycle)", async () => {

					expect(at(createFlake(Thing), "parent").entries).toBeUndefined();

				});

				it("foreign reference is a leaf (no descent)", async () => {

					expect(at(createFlake(Thing), "children").entries).toBeUndefined();

				});

				it("captive reference descends into the resolved target shape", async () => {

					const archived = at(createFlake(Thing), "archived");

					expect("label" in props(archived)).toBe(true);
					expect(at(archived, "label").path).toEqual(["archived", "label"]);

				});

				it("union with embedded variant produces a descent for that variant", async () => {

					const address = at(createFlake(Thing), "address");

					// the .string variant is a plain string (non-descending) → omitted
					// the .Postal variant is the embedded Postal → included with its properties
					expect(hasVariant(address, 0)).toBe(false);
					expect(hasVariant(address, 1)).toBe(true);

					const v1 = variant(address, 1);
					expect("street" in v1).toBe(true);
					expect("city" in v1).toBe(true);

				});

			});

		});

	});

	describe("model mode", () => {

		describe("root", () => {

			it("has empty path", async () => {

				expect(createFlake(Thing, {}).path).toEqual([]);

			});

			it("has empty pipe — navigation root carries no transform", async () => {

				expect(createFlake(Thing, {}).pipe).toEqual([]);

			});

			it("starts with an empty Properties record on the empty model", async () => {

				expect(props(createFlake(Thing, {}))).toEqual({});

			});

			it("carries the retrieval model on Flake.drain", async () => {

				const template = { label: {} } as Template;

				expect(createFlake(Thing, template).drain).toEqual({ form: "template", query: template });

			});

		});

		describe("scalar root", () => {

			it.each([
				["string", string()],
				["number", decimal()],
				["dictionary", dictionary()]
			] as const)("yields a degenerate leaf flake on a %s shape, ignoring the template", async (_, shape) => {

				const flake = createFlake(shape, { label: {} } as Template);

				expect(flake.entries).toBeUndefined();

			});

			it.each([
				["literal", 0],
				["atomic", {}]
			] as const)("yields a degenerate leaf flake on a primitive %s model", async (_, model) => {

				const flake = createFlake(decimal(), model as Template);

				expect(flake.entries).toBeUndefined();

			});

		});


		describe("id / type entries", () => {

			it("keeps the id template entry as a branch with entry.kind 'id'", async () => {

				const flake = createFlake(Thing, { id: {} } as Template);

				expect(at(flake, "id").entry.kind).toBe("id");

			});

			it("keeps the type template entry as a branch with entry.kind 'type'", async () => {

				const flake = createFlake(Thing, { type: {} } as Template);

				expect(at(flake, "type").entry.kind).toBe("type");

			});

			it("id / type branches have empty components and no query", async () => {

				const flake = createFlake(Thing, { id: {}, type: {} } as Template);

				expect(at(flake, "id").entries).toBeUndefined();
				expect(at(flake, "id").drain).toBeUndefined();
				expect(at(flake, "type").entries).toBeUndefined();
				expect(at(flake, "type").drain).toBeUndefined();

			});

		});


		describe("scalar property", () => {

			it("becomes a leaf branch with no query", async () => {

				const flake = createFlake(Thing, { label: {} } as Template);

				expect(at(flake, "label").entry.kind).toBe("property");
				expect(Array.isArray(at(flake, "label").drain?.query)).toBe(false);
				expect(at(flake, "label").entries).toBeUndefined();

			});

			it("path extends from the root", async () => {

				const flake = createFlake(Thing, { label: {} } as Template);

				expect(at(flake, "label").path).toEqual(["label"]);

			});

		});


		describe("multi-valued slot", () => {

			it("array placeholder becomes a terminal branch carrying the user model in query", async () => {

				const flake = createFlake(Thing, { tags: { label: {} } } as Template);
				const tags = at(flake, "tags");

				expect(tags.entry.kind).toBe("property");
				expect(tags.drain).toEqual({ form: "template", query: { label: {} } });
				expect(tags.entries).toBeUndefined();

			});

			it("locale-map placeholder on a localised range is a leaf resolved in the resources pass", async () => {

				const flake = createFlake(Thing, { description: { en: {} } } as Template);
				const description = at(flake, "description");

				// single-valued localised slots are single structured values, not collections — the
				// drain is a Model (not a Query tuple), so gather assembles the `Localised` value from
				// the source model directly in the resources pass

				expect(Array.isArray(description.drain?.query)).toBe(false);
				expect(description.entries).toBeUndefined();

			});

			it("string shorthand placeholder on a single-valued localised range is a leaf resolved in the resources pass", async () => {

				const flake = createFlake(Thing, { description: {} } as Template);
				const description = at(flake, "description");

				expect(Array.isArray(description.drain?.query)).toBe(false);
				expect(description.entries).toBeUndefined();

			});

			it("array-per-tag localised placeholder carries the coalesced model in query, retaining the dictionary shape", async () => {

				const flake = createFlake(Thing, { keywords: {} } as Template);
				const keywords = at(flake, "keywords");

				// an array-per-tag localised property coalesces as a multi-valued string collection, so
				// it carries a `query` arm like any multi-valued slot; the dictionary range shape is retained
				// on the branch so the encoder can emit winning-tag coalescing (§6.2)

				const field = keywords.entry;
				if ( field.kind !== "property" ) { throw new Error("expected a property entry"); }

				expect(keywords.drain).toEqual({ form: "atomic", query: {} });
				expect(eager(field.range.shape).kind).toBe("dictionary");
				expect(keywords.entries).toBeUndefined();

			});

		});


		describe("single-valued reference", () => {

			it("atomic placeholder is a leaf (empty components)", async () => {

				const flake = createFlake(Thing, { parent: {} } as Template);
				const parent = at(flake, "parent");

				expect(parent.drain?.query).toEqual({});
				expect(parent.entries).toBeUndefined();

			});

			it("object placeholder recurses through the resolved target shape", async () => {

				const flake = createFlake(Thing, { parent: { label: {} } } as Template);

				expect(at(flake, "parent", "label")).toBeDefined();
				expect(at(flake, "parent", "label").path).toEqual(["parent", "label"]);

			});

		});


		describe("union-ranged single-valued property", () => {

			// §5.5: union slot keys are opaque — the branch is fixed by matching the placeholder's
			// form against the declared variants, never by the key. The nested template
			// { city } structurally singles out the Postal variant whatever integer key carries it,
			// so an arbitrary key "7" routes it to the Postal branch (member index 1).

			it("routes a nested template to the variant it structurally matches", async () => {

				const flake = createFlake(Thing, { address: { "7": { city: {} } } } as Template);
				const address = at(flake, "address");

				expect(hasVariant(address, 1)).toBe(true);

			});

			it("each variant entry is a Properties record (no entry, no path of its own)", async () => {

				const flake = createFlake(Thing, { address: { "7": { city: {} } } } as Template);
				const v1 = variant(at(flake, "address"), 1);

				expect("entry" in v1).toBe(false);
				expect("path" in v1).toBe(false);

			});

			it("variant Properties hold the requested branches with extended path", async () => {

				const flake = createFlake(Thing, { address: { "7": { city: {} } } } as Template);
				const city = variant(at(flake, "address"), 1)["city"];

				expect(city.entry.kind).toBe("property");
				expect(city.path).toEqual(["address", "city"]);

			});

			it("routes each branch to its matched variant under opaque keys", async () => {

				const flake = createFlake(Thing, {
					address: { "0": { city: {} }, "1": {} }
				});
				const address = at(flake, "address");

				// keys carry no positional meaning: the template alternative structurally matches Postal
				// (kept, with its city branch) and the atomic alternative matches every variant as a
				// non-descending leaf (§5.3, contributes no branch), regardless of which key holds which
				expect(hasVariant(address, 1)).toBe(true);
				expect(variant(address, 1)["city"]).toBeDefined();

			});

		});


		describe("filtering", () => {

			it("filters out selector keys", async () => {

				const flake = createQueryFlake(Thing, { label: {}, "<": 5, "@": 0 });

				expect(at(flake, "label")).toBeDefined();
				expect("<" in props(flake)).toBe(false);
				expect("@" in props(flake)).toBe(false);

			});

			it("keeps an atomic placeholder — `{}` asks for the value, it does not elide the slot", async () => {

				const flake = createFlake(Thing, { label: {}, parent: {} } as Template);

				expect(at(flake, "label")).toBeDefined();
				expect("parent" in props(flake)).toBe(true);

			});

			it("filters properties not declared on the shape", async () => {

				const flake = createFlake(Thing, { label: {}, bogus: {} } as Template);

				expect(at(flake, "label")).toBeDefined();
				expect("bogus" in props(flake)).toBe(false);

			});

		});


		describe("model placeholder", () => {

			it("stashes a scalar property's placeholder on Branch.drain", async () => {

				const flake = createFlake(Thing, { label: {} } as Template);

				expect(at(flake, "label").drain).toEqual({ form: "atomic", query: {} });

			});

			it("stashes a localised slot's Locale map on Branch.drain", async () => {

				const flake = createFlake(Thing, { description: { en: {} } } as Template);

				expect(at(flake, "description").drain).toEqual({ form: "locale", query: { en: {} } });

			});

			it("stashes a single-valued reference's nested template on Branch.drain", async () => {

				const flake = createFlake(Thing, { parent: { label: {} } } as Template);

				expect(at(flake, "parent").drain).toEqual({ form: "template", query: { label: {} } });

			});

			it("stashes the union placeholder on the branch and the per-variant template on each variant", async () => {

				// the slot key "7" is opaque and stashed verbatim on the branch drain; the { city }
				// placeholder is routed to the Postal variant (member index 1) by structure, not by key
				const flake = createFlake(Thing, { address: { "7": { city: {} } } } as Template);
				const address = at(flake, "address");
				const [text, postal] = getShapeBranches(address.range.shape);

				expect(address.drain?.form).toBe("union");
				expect(address.drain?.query).toEqual({ "7": { city: {} } });
				expect(variant(address, 1)["city"].drain).toEqual({ form: "atomic", query: {} });

				// the variants each alternative reaches are resolved once, on the drain, each under its own drain

				if ( address.drain?.form !== "union" ) { throw new Error("expected a union drain"); }

				expect(address.drain.variants.has(text)).toBe(false);
				expect(address.drain.variants.get(postal)).toEqual({ form: "template", query: { city: {} } });

			});

			it("resolves an atomic alternative to every variant it can stand for", async () => {

				// an embedded resource states no identifier to come back as, so the atomic reaches the string
				// variant alone

				const flake = createFlake(Thing, { address: {} } as Template);
				const address = at(flake, "address");
				const [text, postal] = getShapeBranches(address.range.shape);

				if ( address.drain?.form !== "union" ) { throw new Error("expected a union drain"); }

				expect(address.drain.variants.get(text)).toEqual({ form: "atomic", query: {} });
				expect(address.drain.variants.has(postal)).toBe(false);

			});

			it("resolves a single template alternative to the variants it fits", async () => {

				const flake = createFlake(Thing, { address: { city: {} } } as Template);
				const address = at(flake, "address");
				const [text, postal] = getShapeBranches(address.range.shape);

				if ( address.drain?.form !== "union" ) { throw new Error("expected a union drain"); }

				expect(address.drain.variants.has(text)).toBe(false);
				expect(address.drain.variants.get(postal)).toEqual({ form: "template", query: { city: {} } });

			});

			it("rejects a form the property does not admit", async () => {

				expect(() => createFlake(Thing, { label: { nope: {} } } as Template)).toThrow(RangeError);
				expect(() => createFlake(Thing, { parent: { "n=label": {} } } as Template)).toThrow(RangeError);

			});

			it("carries the requested node as the drain on multi-valued slots", async () => {

				const flake = createFlake(Thing, { tags: { label: {} } } as Template);

				expect(at(flake, "tags").drain?.query).toEqual({ label: {} });

			});

			it("leaves model unset on id / type branches", async () => {

				const flake = createFlake(Thing, { id: {}, type: {} } as Template);

				expect(at(flake, "id").drain).toBeUndefined();
				expect(at(flake, "type").drain).toBeUndefined();

			});

			it("leaves model unset in shape mode", async () => {

				expect(at(createFlake(Thing), "label").drain).toBeUndefined();

			});

		});

	});

	describe("query mode", () => {

		// Single-valued localised slots are not a collection query arm — they are a single structured
		// `Localised` value resolved in the resources pass (gather), never reaching `createQueryFlake`.
		// Array-per-tag localised slots, by contrast, coalesce as a multi-valued string collection and
		// do carry a query arm (model-mode coverage above), retaining the dictionary shape for the encoder's
		// winning-tag coalescing.

		describe("root", () => {

			it("carries the retrieval query on Flake.drain", async () => {

				const query = { label: {} };

				expect(createFlake(Thing, query).drain).toEqual({ form: "template", query });

			});

		});

		describe("[Placeholder] arm", () => {

			it("primitive scalar collection produces empty components and no projection", async () => {

				const flake = createQueryFlake(string(), {});

				expect(flake.entries).toBeUndefined();
				expect(flake.drain?.alias).toBeUndefined();

			});

			it("primitive numeric collection has no components", async () => {

				const flake = createQueryFlake(decimal(), {});

				expect(flake.entries).toBeUndefined();

			});

		});

		describe("[Union & Criteria] arm", () => {

			it("attaches root selection constraints from operator probes", async () => {

				const flake = createQueryFlake(Product, { "<price": 100 });

				expect(at(flake, "price").lt).toBe(100);

			});

			it("never sets projection markers — bare identifiers are path descents, not bindings", async () => {

				const flake = createQueryFlake(Product, { name: {}, "<price": 100 });

				expect(flake.drain?.alias).toBeUndefined();

			});

			it("routes a union member placeholder to its structurally matched variant", async () => {

				const Address = () => union(string(), PostalAddress);
				const flake = createQueryFlake(Address, { "0": { city: {} } });

				// key "0" is opaque: the { city } placeholder structurally singles out the PostalAddress
				// variant (member index 1), not the string variant the key would positionally name
				expect(hasVariant(flake, 1)).toBe(true);
				expect(variant(flake, 1)["city"]?.drain).toEqual({ alias: "city", form: "atomic", query: {} });

			});

			it("splits a union node's key space, criteria apart from alternatives", async () => {

				const Address = () => union(string(), PostalAddress);
				const flake = createQueryFlake(Address, { "#": 10, "0": { city: {} } });

				// a union node carries the collection's criteria alongside its alternatives (§5.6): the key
				// space tells the two apart, the bearing union shape making every remaining key an
				// alternative (§5.5), so neither kind is decided by inspecting one key in isolation

				expect(flake.limit).toBe(10);
				expect(variant(flake, 1)["city"]?.drain).toEqual({ alias: "city", form: "atomic", query: {} });

			});

		});

		describe("[Projection & Criteria] arm", () => {

			it("marks identity binding's coord with the binding alias and model", async () => {

				const flake = createQueryFlake(Product, { "n=name": {} });

				expect(at(flake, "name").drain).toEqual({ alias: "n", form: "atomic", query: {} });

			});

			it("carries the projection on the root drain", async () => {

				const query = { "n=name": {}, "#": 10 };

				expect(createQueryFlake(Product, query).drain).toEqual({ form: "projection", query });

			});

			it("marks path binding's leaf only — not intermediates", async () => {

				const flake = createQueryFlake(Product, { "v=vendor.name": {} });

				expect(at(flake, "vendor").drain?.alias).toBeUndefined();
				expect(at(flake, "vendor", "name").drain).toEqual({ alias: "v", form: "atomic", query: {} });

			});

			it("marks pipe binding's stage only — not the bearing branch", async () => {

				const flake = createQueryFlake(Product, { "y=year:launched": {} });

				expect(at(flake, "launched").drain?.alias).toBeUndefined();
				expect(at(flake, "launched").transforms?.["year"]?.drain).toEqual({
					alias: "y",
					form: "atomic",
					query: {}
				});

			});

			it("marks aggregate-at-root binding on the root transforms axis", async () => {

				const flake = createQueryFlake(Product, { "c=count:": {} });

				expect(flake.transforms?.["count"]?.drain).toEqual({ alias: "c", form: "atomic", query: {} });

			});

			it("explores every binding's expression independently", async () => {

				const flake = createQueryFlake(Product, {
					"n=name": {},
					"v=vendor.name": {},
					"y=year:launched": {}
				});

				expect(at(flake, "name").drain).toEqual({ alias: "n", form: "atomic", query: {} });
				expect(at(flake, "vendor", "name").drain).toEqual({ alias: "v", form: "atomic", query: {} });
				expect(at(flake, "launched").transforms?.["year"]?.drain).toEqual({
					alias: "y",
					form: "atomic",
					query: {}
				});

			});

			it("traverses union variants for nested paths via implicit variant routing", async () => {

				const flake = createQueryFlake(Vendor, { "c=address.city": {} });
				const address = at(flake, "address");

				expect(address.drain?.alias).toBeUndefined();
				expect(hasVariant(address, 1)).toBe(true);
				expect(variant(address, 1)["city"]?.drain).toEqual({ alias: "c", form: "atomic", query: {} });

			});

			it("combines projection and constraint at the same coord", async () => {

				const flake = createQueryFlake(Product, { "n=name": {}, "~name": "toy" });

				expect(at(flake, "name").drain).toEqual({ alias: "n", form: "atomic", query: {} });
				expect(at(flake, "name").like).toBe("toy");

			});

			it("folds a resource binding's nested template into the terminal's properties (§5.2)", async () => {

				const flake = createQueryFlake(Product, { "v=vendor": { name: {} } });

				expect(at(flake, "vendor").drain).toEqual({ alias: "v", form: "template", query: { name: {} } });
				expect(at(flake, "vendor", "name").drain).toEqual({ form: "atomic", query: {} });

			});

			it("folds a nested template under a multi-step path terminal", async () => {

				const flake = createQueryFlake(Product, { "v=vendor": { name: {} } });

				expect(at(flake, "vendor", "name").entry.kind).toBe("property");

			});

			it("folds a union-crossing binding to a single branch with a disjunction range (§5.2, §5.8.1)", async () => {

				// media crosses the Image|Video union — Image.subject → Product, Video.subject → Category, under the
				// shared `subject` predicate — so the binding is one cell (§5.2) whose range is the disjunction
				// (§5.8.1), not one subject branch per media variant

				const flake = createQueryFlake(Product, {
					"s=media.subject": {
						"0": { name: {} },
						"1": { title: {} }
					}
				});

				const subject = at(flake, "media", "subject");

				expect(getShapeBranches(subject.range.shape)).toHaveLength(2);        // disjunction [Product,
				// Category]
				expect(subject.drain?.alias).toBe("s");

				expect(variant(subject, 0)["name"]?.drain).toEqual({ form: "atomic", query: {} });     // Product arm
				expect(variant(subject, 1)["title"]?.drain).toEqual({ form: "atomic", query: {} });    // Category arm

			});

			it("folds a union-crossing scalar binding to a single heterogeneous range", async () => {

				// media.caption crosses the Image|Video union — Image.caption is a plain string, Video.caption a
				// localised text, under the shared `caption` predicate — so the binding is one cell whose range
				// carries both kinds, never a caption branch per media variant

				const flake = createQueryFlake(Product, { "cap=media.caption": {} });

				const caption = at(flake, "media", "caption");

				expect(getShapeBranches(caption.range.shape).map(v => v.kind)).toEqual(["string", "dictionary"]);
				expect(caption.drain?.alias).toBe("cap");

			});

			it("folds a union binding's variant template into the terminal's properties", async () => {

				const flake = createQueryFlake(Vendor, { "a=address": { "0": { street: {} } } });

				expect(at(flake, "address").drain?.alias).toBe("a");
				expect(variant(at(flake, "address"), 1)["street"]?.drain).toEqual({ form: "atomic", query: {} });

			});

		});

		describe("constraints", () => {

			it.each([
				["lt", "<price", "price", 50],
				["gt", ">price", "price", 10],
				["lte", "<=price", "price", 50],
				["gte", ">=price", "price", 10],
				["like", "~name", "name", "toy"],
				["any", "?condition", "condition", ["new", "used"]],
				["all", "!condition", "condition", ["new"]],
				["focus", "+condition", "condition", ["new"]],
				["order", "^price", "price", 1]
			] as const)("populates %s slot at the path coordinate", async (slot, key, prop, value) => {

				const flake = createQueryFlake(Product, { [key]: value } as Query<Slot>);

				expect(at(flake, prop)[slot]).toEqual(value);

			});

			it("descends through transforms for piped constraints", async () => {

				const flake = createQueryFlake(Product, { ">=year:launched": 2020 });

				expect(at(flake, "launched").transforms?.["year"]?.gte).toBe(2020);
				expect(at(flake, "launched").transforms?.["year"]?.pipe).toEqual(["year"]);

			});

			it("transform stage carries the parent's path alongside its pipe", async () => {

				const flake = createQueryFlake(Product, { ">=year:launched": 2020 });
				const stage = at(flake, "launched").transforms?.["year"];

				expect(stage?.path).toEqual(["launched"]);
				expect(stage?.pipe).toEqual(["year"]);

			});

			it("descends through multi-step pipe to the deepest stage", async () => {

				const flake = createQueryFlake(Product, { "<round:avg:price": 100 });

				const avg = at(flake, "price").transforms?.["avg"];
				const round = avg?.transforms?.["round"];

				expect(avg).toBeDefined();
				expect(round).toBeDefined();
				expect(round?.lt).toBe(100);

			});

			it("nested transform stages carry the same parent path and accumulate pipe", async () => {

				const flake = createQueryFlake(Product, { "<round:avg:price": 100 });

				const avg = at(flake, "price").transforms?.["avg"];
				const round = avg?.transforms?.["round"];

				expect(avg?.path).toEqual(["price"]);
				expect(avg?.pipe).toEqual(["avg"]);
				expect(round?.path).toEqual(["price"]);
				expect(round?.pipe).toEqual(["round", "avg"]);

			});

			it("combines multiple constraints on the same path", async () => {

				const flake = createQueryFlake(Product, { ">=price": 10, "<=price": 100 });

				expect(at(flake, "price").gte).toBe(10);
				expect(at(flake, "price").lte).toBe(100);

			});

			it("populates root constraints from empty-path expressions", async () => {

				const flake = createQueryFlake(Product, { "~": "search" });

				expect(flake.like).toBe("search");

			});

			it("populates root transforms from aggregate expressions", async () => {

				const flake = createQueryFlake(Product, { "<count:": 100 });

				expect(flake.transforms?.["count"]?.lt).toBe(100);

			});

		});

		describe("stage effective shape", () => {

			it("infers an aggregate stage as a single value", async () => {

				const flake = createQueryFlake(Product, { "<count:": 100 });
				const value = flake.transforms?.["count"]?.range;

				expect(value?.maxCount).toBe(1);
				expect(value?.minCount).toBe(1);

			});

			it("infers an aggregate over a property as a single numeric value", async () => {

				const flake = createQueryFlake(Product, { ">=avg:price": 0 });
				const value = at(flake, "price").transforms?.["avg"]?.range;

				if ( value === undefined ) { throw new Error("expected a range"); }

				expect(value.maxCount).toBe(1);
				expect(value.minCount).toBeUndefined();

				// a non-union range resolves to a single value shape, not a multi-variant disjunction
				expect(getShapeBranches(value.shape).map(branch => branch.kind)).toEqual(["number"]);

			});

			it("preserves source cardinality across a scalar transform", async () => {

				// launched is single-valued (optional date); a scalar transform preserves maxCount

				const flake = createQueryFlake(Product, { "y=year:launched": {} });
				const value = at(flake, "launched").transforms?.["year"]?.range;

				expect(value?.maxCount).toBe(1);
				expect(value?.minCount).toBeUndefined();

			});

			it("composes the effective shape through a multi-stage pipe", async () => {

				const flake = createQueryFlake(Product, { "<round:avg:price": 100 });

				const avg = at(flake, "price").transforms?.["avg"]?.range;
				const round = at(flake, "price").transforms?.["avg"]?.transforms?.["round"]?.range;

				expect(avg?.maxCount).toBe(1);
				expect(round?.maxCount).toBe(1);

			});

			it("rejects a domain-incompatible pipe", async () => {

				// year applied to a dictionary property has no surviving variant, so the pipe is ill-typed (§5.8.2);
				// models are validated at the Keep boundary, so reaching the flake builder is a contract
				// violation surfaced as an error

				expect(() => createQueryFlake(Product, { "y=year:name": {} })).toThrow();

			});

		});

		describe("branch effective range", () => {

			it("resolves a required single-valued property to its typed range", async () => {

				const name = at(createFlake(Vendor), "name");

				expect(name.range.maxCount).toBe(1);
				expect(getShapeBranches(name.range.shape)[0].kind).toBe("string");

			});

			it("carries the multi-valued cardinality of a repeatable property", async () => {

				const aliases = at(createFlake(Vendor), "aliases");

				expect(aliases.range.maxCount).toBeUndefined();

			});

			it("admits every variant of a union-ranged property", async () => {

				const audited = at(createFlake(Vendor), "audited");

				expect(getShapeBranches(audited.range.shape).length).toBe(2);

			});

			it("resolves an id marker to the single IRI range", async () => {

				const marker = at(createFlake(Vendor), "id");

				expect(marker.range.maxCount).toBe(1);
				expect(getShapeBranches(marker.range.shape)[0].kind).toBe("string");

			});

			it("matches blue's effective resolution over the branch path", async () => {

				const name = at(createFlake(Vendor), "name");
				const probe: Probe = { target: "probe", path: name.path, pipe: name.pipe };

				expect(name.range).toEqual(effective(Vendor, probe));

			});

			it("populates the range in model mode", async () => {

				const name = at(createFlake(Vendor, { name: {} } as Template), "name");
				const probe: Probe = { target: "probe", path: name.path, pipe: name.pipe };

				expect(name.range).toEqual(effective(Vendor, probe));

			});

			it("populates the range in query mode", async () => {

				const name = at(createQueryFlake(Vendor, { "n=name": {} }), "name");
				const probe: Probe = { target: "probe", path: name.path, pipe: name.pipe };

				expect(name.range).toEqual(effective(Vendor, probe));

			});

		});

		describe("pagination", () => {

			it("populates offset from @ key on root", async () => {

				const flake = createQueryFlake(Product, { "@": 10 });

				expect(flake.offset).toBe(10);

			});

			it("populates limit from # key on root", async () => {

				const flake = createQueryFlake(Product, { "#": 25 });

				expect(flake.limit).toBe(25);

			});

			it("populates both pagination keys on root", async () => {

				const flake = createQueryFlake(Product, { "@": 5, "#": 10 });

				expect(flake.offset).toBe(5);
				expect(flake.limit).toBe(10);

			});

		});

		describe("scalar root", () => {

			it.each([
				["string", string()],
				["number", decimal()],
				["dictionary", dictionary()]
			] as const)("yields a leaf flake on a %s shape", async (_, shape) => {

				const flake = createQueryFlake(shape, {});

				expect(flake.entries).toBeUndefined();

			});

			it("attaches root selection constraints on a numeric scalar root", async () => {

				const flake = createQueryFlake(decimal(), { "<": 100, ">": 10 });

				expect(flake.lt).toBe(100);
				expect(flake.gt).toBe(10);

			});

		});

		describe("tree shape", () => {

			it("root flake has empty path", async () => {

				expect(createQueryFlake(Product, { "<price": 0 }).path).toEqual([]);

			});

			it("nested branches extend the path recursively", async () => {

				const flake = createQueryFlake(Product, { "v=vendor.name": {} });

				expect(at(flake, "vendor").path).toEqual(["vendor"]);
				expect(at(flake, "vendor", "name").path).toEqual(["vendor", "name"]);

			});

			it("creates a sparse tree (only paths touched by entries)", async () => {

				const flake = createQueryFlake(Product, { "<price": 100 });

				expect("price" in props(flake)).toBe(true);
				expect("name" in props(flake)).toBe(false);
				expect("vendor" in props(flake)).toBe(false);

			});

			it("each branch carries the corresponding shape entry kind", async () => {

				const flake = createQueryFlake(Product, { "<price": 0, "n=name": {} });

				expect(at(flake, "price").entry.kind).toBe("property");
				expect(at(flake, "name").entry.kind).toBe("property");

			});

			it("variant fork shares the parent property's path; entries inside use the extended path", async () => {

				const flake = createQueryFlake(Vendor, { "c=address.city": {} });
				const address = at(flake, "address");
				const city = variant(address, 1)["city"];

				expect(address.path).toEqual(["address"]);
				expect(city.path).toEqual(["address", "city"]);

			});

		});

	});

	describe("union-crossing names", () => {

		// `name` and `owner` are declared by both item variants, with differing ranges for `name`: union
		// coherence (§3.2) makes each one property, reached through one branch whose range is the disjunction
		// of the per-variant declarations (§5.8.1)

		const Owner = resource({ name: optional(string()), code: optional(string()) });
		const Label = resource({
			name: optional(string()),
			code: optional(string()),
			owner: optional(reference(Owner))
		});
		const Count = resource({ name: optional(integer()), owner: optional(reference(Owner)) });

		const Holder = resource({ item: optional(union(Label, Count)) });


		it("types a name as mapping to a single branch", async () => {

			expectTypeOf<Entries[Identifier]>().toEqualTypeOf<Branch>();

		});

		it("folds a shared name to one branch in shape mode", async () => {

			const name = props(at(createFlake(Holder), "item")).name;

			expect(name.path).toEqual(["item", "name"]);
			expect(getShapeBranches(name.range.shape)).toHaveLength(2);

		});

		it("folds a shared name to one branch in model mode", async () => {

			const name = props(at(createFlake(Holder, { item: { name: {} } } as Template), "item")).name;

			expect(name.path).toEqual(["item", "name"]);
			expect(name.drain?.query).toEqual({});

		});

		it("folds the requests alternatives state for a shared name into one drain", async () => {

			const owner = props(at(createFlake(Holder, {
				item: { "0": { owner: { name: {} } }, "1": { owner: { code: {} } } }
			} as Template), "item")).owner;

			expect(owner.drain).toEqual({ form: "template", query: { name: {}, code: {} } });
			expect(Object.keys(props(owner)).sort()).toEqual(["code", "name"]);

		});

		it("folds a projected path and a binding's nested template naming it to one branch in query mode", async () => {

			const name = props(at(createQueryFlake(Product, {
				"v=vendor": { name: {} },
				"n=vendor.name": {}
			}), "vendor")).name;

			expect(name.drain?.alias).toBe("n");

		});

	});

	describe("immutability", () => {

		it("shape mode returns a deeply frozen Flake", async () => {

			const flake = createFlake(Thing);

			expect(Object.isFrozen(flake)).toBe(true);
			expect(Object.isFrozen(flake.entries!)).toBe(true);
			expect(Object.isFrozen(at(flake, "archived"))).toBe(true);
			expect(Object.isFrozen(at(flake, "archived").entries)).toBe(true);

		});

		it("model mode returns a deeply frozen Flake", async () => {

			const flake = createFlake(Thing, { label: {}, parent: { label: {} } } as Template);

			expect(Object.isFrozen(flake)).toBe(true);
			expect(Object.isFrozen(flake.entries!)).toBe(true);
			expect(Object.isFrozen(at(flake, "parent"))).toBe(true);
			expect(Object.isFrozen(at(flake, "parent").entries)).toBe(true);

		});

		it("query mode returns a deeply frozen Flake", async () => {

			const flake = createQueryFlake(Product, { "v=vendor.name": {}, "<price": 0 });

			expect(Object.isFrozen(flake)).toBe(true);
			expect(Object.isFrozen(flake.entries!)).toBe(true);
			expect(Object.isFrozen(at(flake, "vendor"))).toBe(true);
			expect(Object.isFrozen(at(flake, "vendor").entries)).toBe(true);

		});

	});

});

describe("flake methods", () => {

	const marker = id();

	// a throwaway effective range the locus-method helpers ignore
	const range: Range = { minCount: undefined, maxCount: undefined, shape: string() };


	/**
	 * A root {@link Flake} carrying the given constraint / property / transform / projection slots.
	 */
	function root(slots: Partial<Flake>): Flake {
		return { path: [], pipe: [], range, ...slots };
	}

	/**
	 * A child {@link Branch} carrying the given slots, with a throwaway `entry` the helpers ignore.
	 */
	function branch(slots: Partial<Flake>): Branch {
		return { path: [], pipe: [], range, entry: marker, ...slots };
	}

	/**
	 * A transform {@link Flake} over the given pipe.
	 */
	function stage(pipe: readonly Transform[], slots: Partial<Flake> = {}): Flake {
		return { path: [], pipe, range, ...slots };
	}


	describe("isRequiredFlake", () => {

		it("is false with no constraint", async () => {
			expect(isRequiredFlake(root({}))).toBe(false);
		});

		it("is true on a value bound", async () => {
			expect(isRequiredFlake(root({ gt: 5 }))).toBe(true);
		});

		it("is true on a like constraint", async () => {
			expect(isRequiredFlake(root({ like: "term" }))).toBe(true);
		});

		it("is true on an any / all set with a non-null option", async () => {
			expect(isRequiredFlake(root({ any: ["x"] }))).toBe(true);
			expect(isRequiredFlake(root({ all: ["x"] }))).toBe(true);
		});

		it("is false on a null-only any / all set", async () => {
			expect(isRequiredFlake(root({ any: [null] }))).toBe(false);
			expect(isRequiredFlake(root({ all: [null] }))).toBe(false);
		});

		it("is false on an empty option set", async () => {
			expect(isRequiredFlake(root({ any: [] }))).toBe(false);
		});

		it("is false on ranking and pagination slots", async () => {
			expect(isRequiredFlake(root({ focus: ["x"] }))).toBe(false);
			expect(isRequiredFlake(root({ order: 1 }))).toBe(false);
			expect(isRequiredFlake(root({ offset: 5 }))).toBe(false);
			expect(isRequiredFlake(root({ limit: 5 }))).toBe(false);
		});

		it("is true on a non-aggregate piped constraint", async () => {
			expect(isRequiredFlake(root({ transforms: { lower: stage(["lower"], { gt: "m" }) } }))).toBe(true);
		});

		it("is false on a constraint behind an aggregate pipe", async () => {
			expect(isRequiredFlake(root({ transforms: { count: stage(["count"], { gt: 1 }) } }))).toBe(false);
		});

		it("propagates required up a nested child path", async () => {
			expect(isRequiredFlake(root({ entries: { parent: branch({ gt: 5 }) } }))).toBe(true);
		});

	});

	describe("getFlakeProjection", () => {

		it("is empty when no node projects", async () => {
			expect(getFlakeProjection(root({}))).toEqual({});
		});

		it("indexes a root projection by its alias", async () => {
			const node = root({ drain: { alias: "r", form: "atomic", query: {} } });
			expect(getFlakeProjection(node).r).toEqual(node);
		});

		it("indexes a projection on a transform stage", async () => {
			const counted = stage(["count"], { drain: { alias: "c", form: "atomic", query: {} } });
			expect(getFlakeProjection(root({ transforms: { count: counted } })).c).toEqual(counted);
		});

		it("indexes a projection on a nested branch", async () => {
			const child = branch({ drain: { alias: "p", form: "atomic", query: {} } });
			expect(getFlakeProjection(root({ entries: { parent: child } })).p).toEqual(child);
		});

		it("collects projections across all axes, keyed by alias", async () => {
			const counted = stage(["count"], { drain: { alias: "c", form: "atomic", query: {} } });
			const child = branch({ drain: { alias: "p", form: "atomic", query: {} } });
			const node = root({
				drain: { alias: "r", form: "atomic", query: {} },
				transforms: { count: counted },
				entries: { parent: child }
			});
			expect(Object.keys(getFlakeProjection(node)).sort()).toEqual(["c", "p", "r"]);
		});

	});

});

describe("branch methods", () => {

	/**
	 * The union-typed `address` branch of a {@link Vendor} query touching one property per node variant:
	 * `city` singles out the {@link PostalAddress} variant (member index 1), `latitude` the {@link Place}
	 * variant (member index 2); the leading string variant (member index 0) declares neither.
	 */
	function addressBranch(): Branch {
		const flake = createQueryFlake(Vendor, { "c=address.city": {}, "g=address.latitude": {} });
		return at(flake, "address");
	}

	/**
	 * The union shape borne by a coordinate, throwing when it is not a union.
	 */
	function asUnion(node: Branch): UnionShape {
		const shape = node.entry.kind === "property" ? eager(node.entry.range.shape) : undefined;
		if ( shape === undefined || shape.kind !== "union" ) { throw new Error("expected a union coordinate"); }
		return shape;
	}

	const leafName = (branch: Branch): Identifier => branch.path[branch.path.length-1];


	describe("isModelBranch", () => {

		it("is true for a single-valued property carrying a Model drain", async () => {
			expect(isModelBranch(at(createFlake(Product, { name: {} } as Template), "name"))).toBe(true);
		});

		it("is true for a property with an absent drain (shape mode)", async () => {
			expect(isModelBranch(at(createFlake(Product), "name"))).toBe(true);
		});

		it("is false for a multi-valued property carrying a Query drain", async () => {
			expect(isModelBranch(at(createFlake(Product, { categories: { name: {} } } as Template), "categories")))
				.toBe(false);
		});

		it("is false for an id / type marker branch", async () => {
			const flake = createFlake(Product, { id: {}, type: {} } as Template);

			expect(isModelBranch(at(flake, "id"))).toBe(false);
			expect(isModelBranch(at(flake, "type"))).toBe(false);
		});

	});

	describe("isQueryBranch", () => {

		it("is true for a multi-valued property carrying a Query drain", async () => {
			expect(isQueryBranch(at(createFlake(Product, { categories: { name: {} } } as Template), "categories")))
				.toBe(true);
		});

		it("is false for a single-valued property carrying a Model drain", async () => {
			expect(isQueryBranch(at(createFlake(Product, { name: {} } as Template), "name"))).toBe(false);
		});

		it("is false for a property with an absent drain (shape mode)", async () => {
			expect(isQueryBranch(at(createFlake(Product), "name"))).toBe(false);
		});

		it("is false for an id / type marker branch", async () => {
			const flake = createFlake(Product, { id: {}, type: {} } as Template);

			expect(isQueryBranch(at(flake, "id"))).toBe(false);
			expect(isQueryBranch(at(flake, "type"))).toBe(false);
		});

	});

	describe("isProbeBranch", () => {

		it("is true for a query-projected branch carrying an alias", async () => {
			expect(isProbeBranch(at(createQueryFlake(Product, { "n=name": {} }), "name"))).toBe(true);
		});

		it("is false for a model-drain branch without an alias", async () => {
			expect(isProbeBranch(at(createFlake(Product, { name: {} } as Template), "name"))).toBe(false);
		});

		it("is false for a property with an absent drain (shape mode)", async () => {
			expect(isProbeBranch(at(createFlake(Product), "name"))).toBe(false);
		});

	});

	describe("getBranchSlice", () => {

		it("keeps the branches the given variant declares", async () => {
			const address = addressBranch();

			expect(getFlakeVariant(address, getShapeBranches(asUnion(address))[1]).map(leafName)).toEqual(["city"]);
		});

		it("slices along the shape axis, isolating each variant's branches", async () => {
			const address = addressBranch();

			expect(getFlakeVariant(address, getShapeBranches(asUnion(address))[2]).map(leafName)).toEqual(["latitude"]);
		});

		it("is empty for a variant that declares no reached property", async () => {
			const address = addressBranch();

			expect(getFlakeVariant(address, getShapeBranches(asUnion(address))[0])).toEqual([]);
		});

		it("returns every branch of a non-union resource node", async () => {
			const vendor = at(createQueryFlake(Product, { "v=vendor.name": {}, "s=vendor.code": {} }), "vendor");
			const field = vendor.entry;

			if ( field.kind !== "property" ) { throw new Error("expected a property entry"); }

			expect(getFlakeVariant(vendor, eager(field.range.shape)).map(leafName).sort()).toEqual(["code", "name"]);
		});

		it("attributes a union-crossing branch to every variant declaring its predicate", async () => {

			// media.caption crosses the Image|Video union under the shared `caption` predicate, so the folded
			// branch belongs to both media variants, not only the first one whose entry it carries

			const media = at(createQueryFlake(Product, { "cap=media.caption": {} }), "media");
			const branches = getShapeBranches(asUnion(media));

			expect(getFlakeVariant(media, branches[0]).map(leafName)).toEqual(["caption"]);  // Image
			expect(getFlakeVariant(media, branches[1]).map(leafName)).toEqual(["caption"]);  // Video
		});

	});

});

describe("union methods", () => {

	const Owner = resource({ name: optional(string()), code: optional(string()) });
	const Dealer = resource({ name: optional(string()), code: optional(string()), owner: optional(reference(Owner)) });

	const text = string();
	const link = reference(Dealer);
	const label = dictionary();


	describe("getUnionBranches", () => {

		describe("a single alternative", () => {

			it("reaches every variant an atomic stands for", async () => {

				expect(getUnionBranches(union(text, link), {})).toEqual([[text, {}], [link, {}]]);

			});

			it("reaches the nested-resource variants a template is valid on", async () => {

				expect(getUnionBranches(union(text, link), { name: {} })).toEqual([[link, { name: {} }]]);

			});

			it("is returned without the criteria riding on the query", async () => {

				expect(getUnionBranches(union(text, link), { name: {}, "#": 10 })).toEqual([[link, { name: {} }]]);

			});

			it("reaches nothing where it matches no variant", async () => {

				expect(getUnionBranches(union(text, link), { nope: {} })).toEqual([]);

			});

			it("reaches the variants of a nested union", async () => {

				expect(getUnionBranches(union(union(text, link), label), {})).toEqual([[text, {}], [link, {}], [label, {}]]);

			});

		});

		describe("a keyed union", () => {

			it("pairs each alternative with every variant it reaches", async () => {

				expect(getUnionBranches(union(text, link), { "0": { name: {} }, "1": {} })).toEqual([
					[link, { name: {} }],
					[text, {}],
					[link, {}]
				]);

			});

			it("is told apart from the criteria riding on it", async () => {

				expect(getUnionBranches(union(text, link), {
					"0": { name: {} },
					"#": 10
				})).toEqual([[link, { name: {} }]]);

			});

			it("is recognised by canonical branch keys alone", async () => {

				expect(getUnionBranches(union(text, link), { "07": {} })).toEqual([]);

			});

		});

	});

	describe("getUnionPlaceholders", () => {

		it("maps each variant to the alternative reaching it", async () => {

			expect(getUnionPlaceholders(union(text, link), {
				"0": {},
				"1": { name: {} }
			})).toEqual(new Map<unknown, unknown>([
				[text, {}],
				[link, { name: {} }]
			]));

		});

		it("resolves the variants of a nested union", async () => {

			expect(getUnionPlaceholders(union(union(text, link), label), { "0": {} })).toEqual(new Map<unknown, unknown>([
				[text, {}],
				[link, {}],
				[label, {}]
			]));

		});

		describe("alternatives reaching the same variant", () => {

			it("fold a template over the atomic, whatever their order", async () => {

				expect(getUnionPlaceholders(union(text, link), {
					"0": { name: {} },
					"1": {}
				})).toEqual(new Map<unknown, unknown>([
					[link, { name: {} }],
					[text, {}]
				]));

			});

			it("fold a locale over the atomic", async () => {

				expect(getUnionPlaceholders(union(text, label), {
					"0": { "*": {} },
					"1": {}
				})).toEqual(new Map<unknown, unknown>([
					[label, { "*": {} }],
					[text, {}]
				]));

			});

			it("merge the keys of their templates", async () => {

				expect(getUnionPlaceholders(union(text, link), { "0": { name: {} }, "1": { code: {} } }))
					.toEqual(new Map<unknown, unknown>([
						[link, { name: {}, code: {} }]
					]));

			});

			it("merge nested templates recursively", async () => {

				expect(getUnionPlaceholders(union(text, link), {
					"0": { owner: { name: {} } },
					"1": { owner: { code: {} } }
				})).toEqual(new Map<unknown, unknown>([
					[link, { owner: { name: {}, code: {} } }]
				]));

			});

		});

	});

});

describe("query methods", () => {

	describe("getQueryEntries", () => {

		it("lists retrieval entries in stated order", async () => {

			expect(getQueryEntries({ name: {}, vendor: { name: {} } }))
				.toEqual([["name", {}], ["vendor", { name: {} }]]);

		});

		it("leaves criteria behind", async () => {

			expect(getQueryEntries({ name: {}, "~name": "widget", "^name": "asc", "@": 0, "#": 25 }))
				.toEqual([["name", {}]]);

		});

		it("returns entries as stated, whatever the retrieval form", async () => {

			expect(getQueryEntries({ "n=name": {} })).toEqual([["n=name", {}]]);
			expect(getQueryEntries({ "0": {} })).toEqual([["0", {}]]);
			expect(getQueryEntries({ en: {} })).toEqual([["en", {}]]);

		});

		it("types entries as keys paired with the queries they state, whatever the retrieval form", async () => {

			expectTypeOf(getQueryEntries).returns.toEqualTypeOf<readonly (readonly [string, Query<Slot>])[]>();

		});

	});

});
