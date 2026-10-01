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

import type { ResourceShape } from "@metreeca/blue/resource";
import type { State } from "@metreeca/blue/value";
import type { Lazy, Optional } from "@metreeca/core";
import { TraceError } from "@metreeca/core/trace";
import type { StoreClient } from "@metreeca/keep";
import type { Reference, Resource } from "@metreeca/qest/state";
import { describe, expect, it } from "vitest";
import { lookup, type TestFactory, type TestTools } from "../index.core.js";
import { collections, created, loose, testProduct } from "../toys.core.js";
import { Category, Product, toys, Vendor, Vendors } from "../toys.js";


const { categories, vendors, products } = collections;


/**
 * Writes a state through the operation under test.
 *
 * Routes a creation through the catalogue collecting the resource, as the store contract anchors it, and an update
 * or insertion to the resource itself, so that a test parameterised over the three writes states one request.
 *
 * @param store - The store to write to
 * @param op - The write operation under test
 * @param request - The identifier of the resource, the shape describing it and the state to write
 *
 * @returns The promise the write resolves to
 */
function write(store: StoreClient, op: "create" | "update" | "insert", { entry, shape, state }: {

	readonly entry: Reference;
	readonly shape: Lazy<ResourceShape>;
	readonly state: Resource;

}): Promise<Optional<Reference>> {
	return op === "create" ? created(store, { entry, shape, state })
		: store[op]({ entry, shape, state: loose(state) });
}


/**
 * Asserts that none of the given embedded items remain under a captor in the store.
 *
 * Probes each item scoped to its captor (`includes({ id, [slot]: [item] }, shape)`), so an identical embedded resource
 * under a different captor cannot mask a real removal. Confirms that embedded children and cascaded references are
 * gone.
 */
async function expectAbsent(
	includes: TestTools["includes"],
	shape: Lazy<ResourceShape>,
	id: Reference,
	slot: string,
	items: readonly Resource[]
): Promise<void> {

	const present = await Promise.all(items.map(item => includes({ id, [slot]: [item] }, shape)));

	present.forEach(p => expect(p).toBeFalsy());

}


/**
 * Shared body for the `create`, `insert` and `update` persist conformance suites.
 *
 * The three operations share storage semantics for forward and reverse triple writes, embedded resource handling
 * and union variant encoding, but differ on the return-value contract (new vs existing resource handling),
 * absence-semantics applicability (`create` is exempt, since a full state at creation time has nothing to retract)
 * and op-specific link-semantics scenarios. Branching on `op` is confined to the `contract` block and to scenario
 * registration filters that gate inapplicable cases per op.
 */
export function testPersistWrite(op: "create" | "update" | "insert", factory: TestFactory): void {

	const applies = (...ops: ReadonlyArray<"create" | "update" | "insert">): boolean => ops.includes(op);

	describe(op, () => {

		describe("contract", () => {

			if ( applies("create", "insert") ) {

				it("should return the resource id for a new resource", factory(async ({ store }) => {

					const code = op === "create" ? "NEW-001" : "INS-001";
					const state = testProduct(code, `${op === "create" ? "New Test" : "Inserted"} Product`,
						{ price: 19.99, stock: 10 }
					);

					expect(await write(store, op, { entry: state.id, shape: Product, state })).toBe(state.id);

				}));

			}

			if ( applies("create") ) {

				it("should return undefined for an existing resource", factory(async ({ store, generate }) => {

					const existing = await generate(products[0], Product);

					expect(await created(store, {
						entry: existing.id,
						shape: Product,
						state: existing
					})).toBeUndefined();

				}));

			}

			if ( applies("update", "insert") ) {

				it("should return the resource id for an existing resource", factory(async ({ store, generate }) => {

					const existing = await generate(products[0], Product);

					const state = {
						...existing,
						price: 99.99
					};

					expect(await write(store, op, { entry: state.id, shape: Product, state })).toBe(existing.id);

				}));

			}

			if ( applies("update") ) {

				it("should return undefined for a non-existent resource", factory(async ({ store }) => {

					const state = testProduct("MISSING-001", "Non-Existent Product", { price: 49.99, stock: 0 });

					expect(await store.update({
						entry: state.id,
						shape: Product,
						state: loose(state)
					})).toBeUndefined();

				}));

			}

			if ( applies("create", "insert") ) {

				it("should not affect other resources in the collection", factory(async ({
					store,
					generate,
					includes
				}) => {

					const existing = await generate(op === "create" ? products[0] : products[1], Product);

					const code = op === "create" ? "NEW-005" : "INS-003";
					const state = testProduct(code, op === "create" ? "Isolated Product" : "Isolated Insert",
						{ price: 12.99, stock: 3 }
					);

					await write(store, op, { entry: state.id, shape: Product, state });

					expect(await includes(existing, Product)).toBeTruthy();

				}));

			}

			it("should reject with RangeError a state id differing from the entry", factory(async ({ store }) => {

				// the entry identifies the target; a state carrying a different id contradicts it and is rejected
				// rather than silently resolved either way: for a creation, the target is the collection, which the
				// stated id has to be nested under

				const code = { create: "MISMATCH-001", update: "MISMATCH-002", insert: "MISMATCH-003" }[op];
				const state = testProduct(code, "Mismatched Id Product");

				await expect(op === "create"
					? store.create({
						entry: "https://data.example.net/vendors/",
						shape: Vendors,
						model: { members: {} },
						state: loose(state)
					})
					: store[op]({
						entry: "https://data.example.net/products/MISMATCH-OTHER",
						shape: Product,
						state
					})
				).rejects.toBeInstanceOf(RangeError);

			}));

			it("should reject with TraceError for an unvalidated state", factory(async ({ store }) => {

				await expect(write(store, op, {
					entry: "https://data.example.net/products/UNVALIDATED-001", shape: Product, state: {
						id: "https://data.example.net/products/UNVALIDATED-001",
						name: { en: "Unvalidated Product" },
						price: 9.99
					}
				})).rejects.toBeInstanceOf(TraceError);

			}));

		});

		describe("scalar properties", () => {

			if ( applies("create") ) {

				it("should persist literal scalars", factory(async ({ store, includes }) => {

					const state = testProduct("NEW-002", "Retrievable Product", { price: 14.99, stock: 20 });

					await created(store, { entry: state.id, shape: Product, state });

					expect(await includes(state, Product)).toBeTruthy();

				}));

				it("should persist multi-reference arrays", factory(async ({ store, includes }) => {

					const state = testProduct("NEW-004", "Multi-Ref Product", {
						price: 34.99,
						stock: 15,
						vendor: "https://data.example.net/vendors/0002",
						categories: [
							"https://data.example.net/categories/1000",
							"https://data.example.net/categories/2000"
						]
					});

					await created(store, { entry: state.id, shape: Product, state });

					expect(await includes(state, Product)).toBeTruthy();

				}));

			}

			if ( applies("insert") ) {

				it("should write the full class lineage", factory(async ({ store, includes }) => {

					// `rdf:type` carries the resource's whole class ancestry (`class ∪ classes`), so an
					// exact-match query on any supertype reaches the instance (class-lineage retrieval)

					const lineage = testProduct("INS-LIN", "Lineage Product", { price: 9.99, stock: 1 });

					await store.insert({ entry: lineage.id, shape: Product, state: lineage });

					expect(await includes({ id: lineage.id, type: toys.Product }, Product)).toBeTruthy();

				}));

				it("should persist the inserted resource", factory(async ({ store, includes }) => {

					const state = testProduct("INS-002", "Retrievable Inserted Product", { price: 14.99, stock: 20 });

					await store.insert({ entry: state.id, shape: Product, state: loose(state) });

					expect(await includes(state, Product)).toBeTruthy();

				}));

			}

			if ( applies("update") ) {

				it("should persist the updated state", factory(async ({ store, generate, includes }) => {

					const existing = await generate(products[0], Product);

					const state = {
						...existing,
						price: 77.77
					};

					await store.update({ entry: state.id, shape: Product, state: loose(state) });

					expect(await includes(state, Product)).toBeTruthy();

				}));

				it("should persist all updated fields consistently", factory(async ({ store, generate, includes }) => {

					const existing = await generate(products[0], Product);

					const state: State<typeof Product> = {
						...existing,
						name: { en: "Completely Updated Name" },
						price: 55.55,
						stock: 999,
						condition: "refurbished"
					};

					await store.update({ entry: state.id, shape: Product, state: loose(state) });

					expect(await includes(state, Product)).toBeTruthy();

				}));

				it("should update reference fields", factory(async ({ store, generate, includes, excludes }) => {

					const existing = await generate(products[0], Product);

					const state = {
						...existing,
						vendor: "https://data.example.net/vendors/0002"
					};

					await store.update({ entry: state.id, shape: Product, state: loose(state) });

					expect(await includes(state, Product)).toBeTruthy();

					// both forward and reverse triples of the previous vendor link must be gone

					expect(await excludes({ id: existing.id, vendor: existing.vendor }, Product)).toBeTruthy();

				}));

			}

			if ( applies("insert") ) {

				it("should replace the state of an existing resource", factory(async ({
					store,
					generate,
					includes,
					excludes
				}) => {

					const existing = await generate(products[0], Product);

					const state = {
						...existing,
						price: 77.77
					};

					await store.insert({ entry: state.id, shape: Product, state: loose(state) });

					expect(await includes(state, Product)).toBeTruthy();
					expect(await excludes({ id: existing.id, price: existing.price }, Product)).toBeTruthy();

				}));

				it("should replace a previously inserted resource with new state", factory(async ({
					store,
					includes,
					excludes
				}) => {

					const state = testProduct("INS-004", "First Insert", { price: 10.00, stock: 5 });

					await store.insert({ entry: state.id, shape: Product, state: loose(state) });

					const replaced = {
						...state,
						price: 20.00
					};

					await store.insert({ entry: replaced.id, shape: Product, state: replaced });

					expect(await includes(replaced, Product)).toBeTruthy();
					expect(await excludes({ id: state.id, price: state.price }, Product)).toBeTruthy();

				}));

			}

			if ( applies("update", "insert") ) {

				const verb = op === "insert" ? "inserted" : "updated";

				it.each([
					[`${verb} as undefined`, undefined],
					[`${verb} as empty array`, [] as readonly string[]]
				])("should remove scalar slot when %s", (_form, empty) => factory(async ({
					store,
					generate,
					includes,
					excludes
				}) => {

					const withWarranty = lookup(products, p => p.warranty !== undefined);

					if ( !withWarranty ) { return; }

					const existing = await generate(withWarranty, Product);

					const state: Resource = { ...existing, warranty: empty };

					await write(store, op, { entry: existing.id, shape: Product, state });

					expect(await includes({ ...existing, warranty: undefined }, Product)).toBeTruthy();
					expect(await excludes({ id: existing.id, warranty: existing.warranty }, Product)).toBeTruthy();

				})());

			}

		});

		describe("array properties", () => {

			if ( applies("create") ) {

				it("should persist arrays of embedded resources", factory(async ({ store, includes }) => {

					// inline literal (not testProduct) so the embedded review can carry an `und` plain-string label

					const state: State<typeof Product> = {

						id: "https://data.example.net/products/NEW-003",
						type: "https://data.example.net/toys#Product",
						label: { en: "Product With Reviews" },
						sku: "NEW-003",
						name: { en: "Product With Reviews" },
						documents: ["https://data.example.net/documents/NEW-003-1.pdf"],
						condition: "new",
						price: 24.99,
						stock: 5,
						vendor: "https://data.example.net/vendors/0001",
						categories: ["https://data.example.net/categories/1000"],
						reviews: [
							{
								label: { und: "2026-01-15 / Test User" },
								comment: { en: "Great product for testing embedded creation" },
								author: "Test User",
								posted: "2026-01-15T10:00:00.000Z",
								rating: 4,
								content: { en: "Great product for testing embedded creation" }
							}
						],
						created: "2026-01-01T00:00:00.000Z"

					};

					await created(store, { entry: state.id, shape: Product, state });

					expect(await includes(state, Product)).toBeTruthy();

				}));

			}

			if ( applies("update", "insert") ) {

				it(`should replace embedded resources on ${op === "insert" ? "upsert" : "update"}`, factory(async ({
					store,
					generate,
					includes
				}) => {

					const existing = await generate(products[0], Product);

					const oldReviews = existing.reviews!;

					const state = op === "insert"
						? {
							...existing,
							reviews: [
								{
									label: { und: "2026-03-01T09:00:00.000Z / Upsert Reviewer" },
									author: "Upsert Reviewer",
									posted: "2026-03-01T09:00:00.000Z",
									rating: 2,
									content: { en: "Replaced via insert upsert" }
								}
							]
						}
						: {
							...existing,
							reviews: [
								{
									label: { und: "2026-02-01 / Updated Reviewer" },
									comment: { en: "This review replaced all previous reviews in the update" },
									author: "Updated Reviewer",
									posted: "2026-02-01T12:00:00.000Z",
									rating: 3,
									content: { en: "This review replaced all previous reviews in the update" }
								}
							]
						};

					await write(store, op, { entry: state.id, shape: Product, state });

					expect(await includes(state, Product)).toBeTruthy();

					// the previous embedded reviews must no longer be present

					await expectAbsent(includes, Product, state.id, "reviews", oldReviews);

				}));

				it.each([
					[`${op === "insert" ? "inserted" : "updated"} with empty array`, [] as readonly Resource[]],
					[`${op === "insert" ? "inserted" : "updated"} as undefined`, undefined]
				])("should clear embedded resources when %s", (_form, empty) => factory(async ({
					store,
					generate,
					includes
				}) => {

					const withReviews = lookup(products, p => !!p.reviews?.length);

					if ( !withReviews ) { return; }

					const existing = await generate(withReviews, Product);

					const reviews = existing.reviews!;

					const state: Resource = { ...existing, reviews: empty };

					await write(store, op, { entry: existing.id, shape: Product, state });

					expect(await includes({ ...existing, reviews: undefined }, Product)).toBeTruthy();

					await expectAbsent(includes, Product, existing.id, "reviews", reviews);

				})());

				it("should drop empty embedded element from multi-valued slot", factory(async ({
					store,
					generate,
					includes
				}) => {

					// Empty `{}` element in a multi-valued embedded slot must be dropped at persist time
					// per data-structure guideline (empty nested resource as element → element dropped)

					const existing = await generate(products[0], Product);

					const survivor = op === "insert"
						? {
							label: { und: "2026-03-02T10:00:00.000Z / Kept Reviewer" },
							author: "Kept Reviewer",
							posted: "2026-03-02T10:00:00.000Z",
							rating: 4,
							content: { en: "Surviving review after empty element drop" }
						}
						: {
							label: { und: "2026-04-01 / Survivor Reviewer" },
							comment: { en: "This review survives the empty-element drop" },
							author: "Survivor Reviewer",
							posted: "2026-04-01T08:00:00.000Z",
							rating: 4,
							content: { en: "This review survives the empty-element drop" }
						};

					const state: Resource = {
						...existing,
						reviews: [survivor, {}]
					};

					await write(store, op, { entry: existing.id, shape: Product, state });

					expect(await includes({ ...existing, reviews: [survivor] }, Product)).toBeTruthy();

				}));

			}

			if ( applies("update", "insert") ) {

				it.each([
					["undefined", undefined],
					["empty array", [] as readonly string[]]
				])("should reject a required array slot cleared to %s", (_form, empty) => factory(async ({
					store,
					generate
				}) => {

					// `categories` is required (min 1); clearing the slot leaves it empty, violating cardinality
					// and surfacing as TraceError at validation time. Validation precedes the existence check,
					// so the rejection holds for update and insert alike

					const existing = await generate(products[0], Product);

					const state: Resource = { ...existing, categories: empty };

					await expect(write(store, op, { entry: existing.id, shape: Product, state }))
						.rejects.toBeInstanceOf(TraceError);

				})());

			}

			if ( applies("update", "insert") ) {

				it("should elide duplicate array elements (set semantics, §4.2)", factory(async ({
					store,
					generate,
					includes
				}) => {

					// §4.2: arrays follow set semantics — duplicate values are ignored, so the
					// persisted state equals the deduplicated set

					const sample = lookup(vendors, v => (v.aliases?.length ?? 0) > 0);

					if ( !sample ) { return; }

					const existing = await generate(sample, Vendor);

					const state: Resource = { ...existing, aliases: ["Dup Alias", "Dup Alias", "Other Alias"] };

					await write(store, op, { entry: existing.id, shape: Vendor, state });

					expect(await includes({ ...existing, aliases: ["Dup Alias", "Other Alias"] }, Vendor)).toBeTruthy();

				}));

			}

			if ( applies("update") ) {

				it("should remove old embedded resources when replacing with fewer", factory(async ({
					store,
					generate,
					includes
				}) => {

					const withReviews = lookup(products, p => {
						const { reviews } = p;
						return reviews !== undefined && reviews.length >= 2;
					});

					if ( !withReviews ) { return; }

					const existing = await generate(withReviews, Product);
					const oldReviews = existing.reviews!;

					const state = {
						...existing,
						reviews: [oldReviews[0]]
					};

					await store.update({ entry: state.id, shape: Product, state: loose(state) });

					expect(await includes(state, Product)).toBeTruthy();

					await expectAbsent(includes, Product, state.id, "reviews", oldReviews.slice(1));

				}));

				it.each([
					["updated as undefined", undefined],
					["updated as empty array", [] as readonly string[]]
				])("should remove array slot when %s", (_form, empty) => factory(async ({
					store,
					generate,
					includes,
					excludes
				}) => {

					const withKeywords = lookup(products, p => !!p.keywords?.length);

					if ( !withKeywords ) { return; }

					const existing = await generate(withKeywords, Product);

					const state: Resource = { ...existing, keywords: empty };

					await store.update({ entry: existing.id, shape: Product, state: loose(state) });

					expect(await includes({ ...existing, keywords: undefined }, Product)).toBeTruthy();
					expect(await excludes({ id: existing.id, keywords: existing.keywords }, Product)).toBeTruthy();

				})());

			}

		});

		describe("localised properties", () => {

			if ( applies("create") ) {

				it("should persist localised maps", factory(async ({ store, includes }) => {

					const state = testProduct("NEW-006", "Localised Product", {
						price: 14.99,
						stock: 20,
						name: { en: "Localised Product", it: "Prodotto Localizzato" },
						description: {
							en: "Rich multilingual description",
							it: "Descrizione multilingua completa"
						}
					});

					await created(store, { entry: state.id, shape: Product, state });

					expect(await includes(state, Product)).toBeTruthy();

				}));

			}

			it("should reject a mixed scalar/array localised map (§4.3)", factory(async ({ store }) => {

				// §4.3: within a single dictionary map values are uniformly scalar or uniformly array;
				// mixed content is rejected

				const code = { create: "MIX-001", update: "MIX-002", insert: "MIX-003" }[op];
				const sample = testProduct(code, "Mixed Map Product");

				const state: Resource = {
					...sample,
					// ;(cast) negative-test payload — a §4.3-violating mixed map, deliberately outside the Localised
					// type
					description: {
						en: "Long enough english description",
						de: ["Long enough german description"]
					} as Resource[string]
				};

				await expect(write(store, op, { entry: sample.id, shape: Product, state }))
					.rejects.toBeInstanceOf(TraceError);

			}));

			it("should reject an empty tag entry on a single-string-per-tag map (§4.3)", factory(async ({ store }) => {

				// §4: an empty array stands as a tag's value only where the per-tag shape is an array per tag;
				// a property fixing a single string per tag holds the entry malformed, the empty map being the
				// form a localised value carrying no content is stated in

				const code = { create: "TAG-001", update: "TAG-002", insert: "TAG-003" }[op];
				const sample = testProduct(code, "Empty Entry Product");

				const state: Resource = { ...sample, description: { en: [] } };

				await expect(write(store, op, { entry: sample.id, shape: Product, state }))
					.rejects.toBeInstanceOf(TraceError);

			}));

			if ( applies("update", "insert") ) {

				const verb = op === "insert" ? "inserted" : "updated";

				it.each([
					[`${verb} as undefined`, undefined],
					[`${verb} as empty object`, {}],
					[`${verb} as empty ${op === "insert" ? "array shorthand" : "array"}`, [] as readonly string[]]
				])("should remove localised slot when %s", (_form, empty) => factory(async ({
					store,
					generate,
					includes,
					excludes
				}) => {

					const withDescription = lookup(products, p => p.description !== undefined);

					if ( !withDescription ) { return; }

					const existing = await generate(withDescription, Product);

					const state: Resource = { ...existing, description: empty };

					await write(store, op, { entry: existing.id, shape: Product, state });

					expect(await includes({ ...existing, description: undefined }, Product)).toBeTruthy();
					expect(await excludes({
						id: existing.id,
						description: existing.description
					}, Product)).toBeTruthy();

				})());

				it(`should remove array-per-tag localised slot when ${verb} as empty tag entries (§4.3)`, factory(async ({
					store,
					generate,
					includes,
					excludes
				}) => {

					// §4: an empty array is dropped where it stands as a tag's value, so a map whose every entry
					// is empty carries no content and leaves the owning property omitted

					const withKeywords = lookup(products, p => !!p.keywords?.length);

					if ( !withKeywords ) { return; }

					const existing = await generate(withKeywords, Product);

					const state: Resource = { ...existing, keywords: { en: [] } };

					await write(store, op, { entry: existing.id, shape: Product, state });

					expect(await includes({ ...existing, keywords: undefined }, Product)).toBeTruthy();
					expect(await excludes({ id: existing.id, keywords: existing.keywords }, Product)).toBeTruthy();

				}));

			}

		});

		describe("union properties", () => {

			const PostalAddressTest = {
				label: { und: "TestCity, TestCountry" },
				street: "Test Street 1",
				city: "TestCity",
				zip: "12345",
				country: "TestCountry"
			};

			const PostalAddressFirst = {
				label: { und: "FirstCity, FirstCountry" },
				street: "First Street 1",
				city: "FirstCity",
				zip: "11111",
				country: "FirstCountry"
			};

			const PostalAddressSecond = {
				label: { und: "SecondCity, SecondCountry" },
				street: "Second Street 2",
				city: "SecondCity",
				zip: "22222",
				country: "SecondCountry"
			};

			const PostalAddressMixed = {
				label: { und: "TestCity, TestCountry" },
				street: "Test Street 2",
				city: "TestCity",
				zip: "12345",
				country: "TestCountry"
			};

			const PostalAddressSwitched = {
				label: { und: "SwitchedCity, SwitchedCountry" },
				street: "Switched Street 1",
				city: "SwitchedCity",
				zip: "54321",
				country: "SwitchedCountry"
			};

			const PostalAddressUpdated = {
				label: { und: "UpdatedCity, UpdatedCountry" },
				street: "Updated Street 2",
				city: "UpdatedCity",
				zip: "67890",
				country: "UpdatedCountry"
			};

			/**
			 * Per-op union test row.
			 *
			 * The `value` entry decides whether the test sets the union slot to a new value, clears it, or leaves it
			 * untouched (insert upsert preservation). The `expected` entry captures any persist-time normalisation
			 * (for example, empty-element drop) applied to the slot value.
			 */
			interface UnionCase {
				readonly label: string;
				readonly applicable: ReadonlyArray<"create" | "update" | "insert">;
				readonly slot: "address" | "contacts" | "score" | "certified";
				/**
				 * Vendor sample picker (insert/update); ignored on create.
				 */
				readonly pick?: (v: Resource) => boolean;
				/**
				 * Identifier seed for create's standalone state.
				 */
				readonly code?: string;
				/**
				 * Slot value to persist; `"preserve"` means leave the existing slot alone (insert upsert),
				 * `undefined` means explicitly clear the slot.
				 */
				readonly value: Resource[string] | "preserve";
				/**
				 * Persist-time normalised slot value used in the `includes` probe (defaults to `value`).
				 */
				readonly expected?: Resource[string];
			}

			// branch row content per op so case-table values reflect each op's intended scenario
			// while keeping `applicable` filters drive the registered test set

			const cases: readonly UnionCase[] = [

				// single-valued slot — primitive variant (create + insert)
				{
					label: op === "create"
						? "primitive variants in flat encoding"
						: "persist primitive variant in single-valued slot",
					applicable: ["create", "insert"],
					slot: "address",
					pick: v => typeof v.address === "string",
					value: op === "create" ? "1 Test Street, TestCity, TestCountry" : "preserve",
					code: "9902"
				},

				// single-valued slot — embedded variant (create + insert)
				{
					label: op === "create"
						? "embedded variants in flat encoding"
						: "persist embedded variant in single-valued slot",
					applicable: ["create", "insert"],
					slot: "address",
					pick: v => v.address !== undefined && typeof v.address === "object",
					value: op === "create" ? PostalAddressTest : "preserve",
					code: "9901"
				},

				// multi-valued slot — primitives only
				{
					label: op === "create"
						? "primitives-only multi-valued unions"
						: op === "insert"
							? "persist primitives-only multi-valued union"
							: "update primitives-only multi-valued union",
					applicable: ["create", "update", "insert"],
					slot: "contacts",
					pick: op === "insert"
						? v => Array.isArray(v.contacts) && v.contacts.length > 0
							&& v.contacts.every(c => typeof c === "string")
						: () => true,
					value: op === "create"
						? ["primitives@test.example.net", "+15550202"]
						: op === "insert"
							? "preserve"
							: ["primitives@test.example.net", "+15550505"],
					code: "9904"
				},

				// multi-valued slot — embeddeds only
				{
					label: op === "create"
						? "embeddeds-only multi-valued unions"
						: op === "insert"
							? "persist embeddeds-only multi-valued union"
							: "update embeddeds-only multi-valued union",
					applicable: ["create", "update", "insert"],
					slot: "contacts",
					pick: () => true,
					value: op === "create"
						? [PostalAddressFirst, PostalAddressSecond]
						: op === "insert"
							? "preserve"
							: [PostalAddressFirst, PostalAddressSecond],
					code: "9905"
				},

				// multi-valued slot — mixed primitives and embeddeds
				{
					label: op === "create"
						? "mixed-variant multi-valued unions"
						: op === "insert"
							? "persist mixed-variant multi-valued union"
							: "update mixed-variant multi-valued union",
					applicable: ["create", "update", "insert"],
					slot: "contacts",
					pick: v => Array.isArray(v.contacts)
						&& v.contacts.some(c => typeof c === "string")
						&& v.contacts.some(c => typeof c === "object"),
					value: op === "create"
						? [
							"contacts@test.example.net",
							"+15550101",
							PostalAddressMixed
						]
						: op === "insert"
							? "preserve"
							: [
								"updated@test.example.net",
								"+15559999",
								PostalAddressUpdated
							],
					code: "9903"
				},

				// multi-valued slot — empty `{}` element gets dropped at persist time
				{
					label: op === "create"
						? "drop empty union elements from multi-valued slot"
						: op === "insert"
							? "drop empty `{}` element from multi-valued union"
							: "drop empty union element from multi-valued slot",
					applicable: ["create", "update", "insert"],
					slot: "contacts",
					pick: () => true,
					value: op === "create"
						? ["drop@test.example.net", {}, "+15550303"]
						: op === "insert"
							? ["drop-insert@test.example.net", {}, "+15550404"]
							: ["drop-update@test.example.net", {}, "+15550606"],
					expected: op === "create"
						? ["drop@test.example.net", "+15550303"]
						: op === "insert"
							? ["drop-insert@test.example.net", "+15550404"]
							: ["drop-update@test.example.net", "+15550606"],
					code: "9906"
				},

				// single-valued slot — variant switches (insert + update)
				{
					label: op === "insert"
						? "switch single-valued union from primitive to embedded"
						: "switch single union variant from primitive to embedded",
					applicable: ["update", "insert"],
					slot: "address",
					pick: v => typeof v.address === "string",
					value: PostalAddressSwitched
				},

				{
					label: op === "insert"
						? "switch single-valued union from embedded to primitive"
						: "switch single union variant from embedded to primitive",
					applicable: ["update", "insert"],
					slot: "address",
					pick: v => v.address !== undefined && typeof v.address === "object",
					value: "Switched to plain string address"
				},

				// single-valued slot — absence (insert + update)
				{
					label: op === "insert"
						? "remove single-valued union when inserted as undefined"
						: "remove single union slot when updated as undefined",
					applicable: ["update", "insert"],
					slot: "address",
					pick: v => v.address !== undefined,
					value: undefined
				},

				{
					label: op === "insert"
						? "remove single-valued union when inserted as empty object"
						: "remove single union slot when updated as empty object",
					applicable: ["update", "insert"],
					slot: "address",
					pick: v => v.address !== undefined,
					value: {},
					expected: undefined
				},

				// multi-valued slot — absence (insert + update)
				{
					label: op === "insert"
						? "remove multi-valued union when inserted as empty array"
						: "remove multi-valued union slot when updated as empty array",
					applicable: ["update", "insert"],
					slot: "contacts",
					pick: v => Array.isArray(v.contacts) && v.contacts.length > 0,
					value: [],
					expected: undefined
				},

				{
					label: op === "insert"
						? "remove multi-valued union when inserted as undefined"
						: "remove multi-valued union slot when updated as undefined",
					applicable: ["update", "insert"],
					slot: "contacts",
					pick: v => Array.isArray(v.contacts) && v.contacts.length > 0,
					value: undefined
				},

				// literal-variant unions (§3.3): Vendor.score is union(decimal[0..5], grade string) and
				// Vendor.certified is union(boolean, decimal[0..5], grade string, year). Every variant is a
				// literal, so the storage branch is fixed purely by the value's domain membership — one row
				// per branch confirms persistence selects exactly the matching branch.

				{
					label: "a decimal score by its matching branch",
					applicable: ["create"],
					slot: "score",
					value: 4.2,
					code: "9910"
				},
				{
					label: "a grade score by its matching branch",
					applicable: ["create"],
					slot: "score",
					value: "A",
					code: "9911"
				},
				{
					label: "a boolean certified by its matching branch",
					applicable: ["create"],
					slot: "certified",
					value: true,
					code: "9912"
				},
				{
					label: "a decimal certified by its matching branch",
					applicable: ["create"],
					slot: "certified",
					value: 4,
					code: "9913"
				},
				{
					label: "a grade certified by its matching branch",
					applicable: ["create"],
					slot: "certified",
					value: "B",
					code: "9914"
				},
				{
					label: "a year certified by its matching branch",
					applicable: ["create"],
					slot: "certified",
					value: "2001",
					code: "9915"
				},

				// literal-variant switches (insert + update): switching a literal union to a value on a
				// different branch must retract the old branch's triple and write the new one (§3.3),
				// the literal-union analogue of the node-union primitive/embedded switches above

				{
					label: op === "insert"
						? "switch single-valued literal union score from decimal to grade"
						: "switch literal union score from decimal to grade",
					applicable: ["update", "insert"],
					slot: "score",
					pick: v => typeof v.score === "number",
					value: "C"
				},

				{
					label: op === "insert"
						? "switch single-valued literal union certified from decimal to year"
						: "switch literal union certified from decimal to year",
					applicable: ["update", "insert"],
					slot: "certified",
					pick: v => typeof v.certified === "number",
					value: "2003"
				}

			];

			const applicableCases = cases.filter(c => c.applicable.includes(op));

			if ( applicableCases.length > 0 ) {

				const titleTemplate = op === "create" ? "should persist $label" : "should $label";

				it.each(applicableCases)(titleTemplate, ({ slot, pick, value, expected, code }) =>
					factory(async ({ store, generate, includes }) => {

						if ( op === "create" ) {

							// create builds a fresh resource carrying the union value directly

							const id = `https://data.example.net/vendors/${code!}`;

							const state: Resource = {

								id,
								type: "https://data.example.net/toys#Vendor",
								label: { und: `Union Vendor ${code!}` },
								code: code!,
								name: `Union Vendor ${code!}`,
								email: `union${code!}@test.example.net`,
								homepage: "https://www.test.example.net",
								[slot]: value === "preserve" ? undefined : value,
								created: "2026-01-01T00:00:00.000Z"

							};

							await created(store, { entry: id, shape: Vendor, state });

							const probe = expected === undefined
								? state
								: { ...state, [slot]: expected };

							expect(await includes(probe, Vendor)).toBeTruthy();

						} else {

							// insert/update reuse an existing vendor sample

							const sample = lookup(vendors, pick!);

							if ( !sample ) { return; }

							const existing = await generate(sample, Vendor);

							const state: Resource = value === "preserve"
								? { ...existing, name: `Vendor With ${slot} (${op})` }
								: { ...existing, [slot]: value };

							await write(store, op, { entry: existing.id, shape: Vendor, state });

							const probe: Resource = value === "preserve"
								? state
								: expected === undefined
									? state
									: { ...existing, [slot]: expected };

							expect(await includes(probe, Vendor)).toBeTruthy();

						}

					})()
				);

			}

			it("should reject an unsatisfiable union state value", factory(async ({ store }) => {

				// §3.3: a state value matching no declared variant is unsatisfiable. A score of 9 lies
				// outside the decimal[0..5] domain and is not a grade string, so it singles out no branch.
				// Validation rejects ahead of the existence check, so the failure holds across ops.
				//
				// An ambiguous state value (matching several variants) is unreachable with the suite's
				// shapes, whose union variants are deliberately disjoint (disjointness is a modelling
				// requirement, blue Unions). Ambiguity is a write-side (sh:xone) concern only: on read
				// a placeholder matching several branches is accepted and retrieves each (sh:or, §5.5).

				const code = { create: "9920", update: "9921", insert: "9922" }[op];
				const id = `https://data.example.net/vendors/${code}`;

				const state: Resource = {
					id,
					type: "https://data.example.net/toys#Vendor",
					label: { und: `Unsatisfiable Vendor ${code}` },
					code,
					name: `Unsatisfiable Vendor ${code}`,
					email: `unsat${code}@test.example.net`,
					homepage: "https://www.test.example.net",
					score: 9,
					created: "2026-01-01T00:00:00.000Z"
				};

				await expect(write(store, op, { entry: id, shape: Vendor, state }))
					.rejects.toBeInstanceOf(TraceError);

			}));

		});

		describe("link semantics", () => {

			if ( applies("create", "insert") ) {

				it(`should persist forward and reverse ${op === "create" ? "link triples" : "links"}`, factory(async ({
					store,
					generate,
					includes
				}) => {

					// Category.broader has forward toys.broader and reverse toys.narrower

					const parent = op === "create"
						? "https://data.example.net/categories/1000"
						: (await generate(lookup(categories, { code: "1000" })!, Category)).id;

					const childId = op === "create"
						? "https://data.example.net/categories/9900"
						: "https://data.example.net/categories/9920";

					const state = {

						id: childId,
						type: "https://data.example.net/toys#Category",
						label: { en: op === "create" ? "Test Child Category" : "Test Broader Insert Child" },
						code: op === "create" ? "9900" : "9920",
						title: { en: op === "create" ? "Test Child Category" : "Test Broader Insert Child" },
						featured: false,
						broader: parent,
						upper: parent,
						created: "2026-01-01T00:00:00.000Z"

					};

					await write(store, op, { entry: state.id, shape: Category, state });

					expect(await includes(state, Category)).toBeTruthy();

					// targeted probe: the inverse triple <parent> toys:narrower <child> must surface
					// through the foreign-derived `narrower` view on the parent category

					expect(await includes({ id: parent, narrower: [state.id] }, Category)).toBeTruthy();

				}));

			}

			if ( applies("create") ) {

				it("should persist forward and reverse triples for scalar reference slot", factory(async ({
					store,
					includes
				}) => {

					// Product.vendor has forward toys.vendor and reverse toys.products;
					// the inverse triple must surface through Vendor.products foreign view

					const vendor = "https://data.example.net/vendors/0001";

					const state = testProduct("NEW-007", "Forward-Reverse Product", { price: 21.99, stock: 7, vendor });

					await created(store, { entry: state.id, shape: Product, state });

					// forward triple <product> toys:vendor <vendor>

					expect(await includes({ id: state.id, vendor }, Product)).toBeTruthy();

					// reverse triple <vendor> toys:products <product> surfaced through the foreign view

					expect(await includes({ id: vendor, products: [state.id] }, Vendor)).toBeTruthy();

				}));

				it("should silently ignore a foreign reference slot in create state", factory(async ({
					store,
					contains,
					excludes
				}) => {

					// Category.narrower is a foreign view; an absent foreign slot must pass validation
					// and write no triples through the slot — pre-probe confirms target absence,
					// post-probe via `excludes` confirms no narrower-derived triples were materialised

					const id = "https://data.example.net/categories/9931";

					expect(await contains(id)).toBeFalsy();

					const state = {

						id,
						type: "https://data.example.net/toys#Category",
						label: { en: "Foreign Silent Parent" },
						code: "9931",
						title: { en: "Foreign Silent Parent" },
						featured: false,
						narrower: undefined,
						created: "2026-01-01T00:00:00.000Z"

					};

					await created(store, { entry: id, shape: Category, state });

					// no narrower-derived triple should have been materialised through the foreign slot

					expect(await excludes({
						id,
						narrower: ["https://data.example.net/categories/1100"]
					}, Category)).toBeTruthy();

				}));

			}

			it("should reject state carrying foreign reference payload", factory(async ({ store }) => {

				// Category.narrower is a foreign view; validation must reject attempts to write through it.
				// Validation precedes the existence check, so the rejection holds across create, update and insert.

				const code = { create: "9930", update: "9932", insert: "9933" }[op];
				const id = `https://data.example.net/categories/${code}`;

				await expect(write(store, op, {
					entry: id,
					shape: Category,
					state: {
						id,
						type: "https://data.example.net/toys#Category",
						label: { en: "Foreign Write Parent" },
						code,
						title: { en: "Foreign Write Parent" },
						featured: false,
						narrower: ["https://data.example.net/categories/9910"],
						created: "2026-01-01T00:00:00.000Z"
					}
				})).rejects.toBeInstanceOf(TraceError);

			}));

			if ( applies("insert") ) {

				it("should preserve foreign references", factory(async ({ store, generate, includes }) => {

					const parent = lookup(categories, c => c.narrower !== undefined);

					if ( !parent ) { return; }

					const narrower = parent.narrower!;
					const child = lookup(categories, c => narrower.includes(c.id));

					if ( !child ) { return; }

					const clonedParent = await generate(parent, Category);
					const clonedChild = await generate({ ...child, broader: clonedParent.id }, Category);

					await store.insert({
						entry: clonedParent.id,
						shape: Category,
						state: clonedParent
					});

					expect(await includes(clonedChild, Category)).toBeTruthy();

				}));

			}

			if ( applies("update") ) {

				it("should preserve foreign references from other resources", factory(async ({
					store,
					generate,
					includes
				}) => {

					const child = lookup(categories, c => c.broader !== undefined);

					if ( !child ) { return; }

					const broaderId = child.broader;
					const broader = lookup(categories, { id: broaderId });

					if ( !broader ) { return; }

					const clonedParent = await generate(broader, Category);
					const clonedChild = await generate({ ...child, broader: clonedParent.id }, Category);

					const state = {
						...clonedParent,
						title: { en: "Updated Broader Title" }
					};

					await store.update({ entry: state.id, shape: Category, state });

					expect(await includes(clonedChild, Category)).toBeTruthy();

				}));

				it("should rewrite reverse triples when reverse-bearing slot is updated", factory(async ({
					store,
					generate,
					includes,
					excludes
				}) => {

					// Updating `Category.broader` (forward: toys.broader, reverse: toys.narrower)
					// must write the new `narrower` inverse triple AND retract the old one.

					const child = lookup(categories, c => c.broader !== undefined);

					if ( !child ) { return; }

					const oldParent = lookup(categories, { id: child.broader });

					if ( !oldParent ) { return; }

					const newParent = lookup(categories,
						c => c.id !== oldParent.id && c.id !== child.id && c.broader === undefined
					);

					if ( !newParent ) { return; }

					const clonedOld = await generate(oldParent, Category);
					const clonedNew = await generate(newParent, Category);
					const clonedChild = await generate({ ...child, broader: clonedOld.id }, Category);

					const state = {
						...clonedChild,
						broader: clonedNew.id
					};

					await store.update({ entry: state.id, shape: Category, state });

					expect(await includes({ id: clonedNew.id, narrower: [clonedChild.id] }, Category)).toBeTruthy();
					expect(await excludes({ id: clonedOld.id, narrower: [clonedChild.id] }, Category)).toBeTruthy();

				}));

			}

		});

	});

}

/**
 * Shared body for the `delete` and `remove` persist conformance suites.
 *
 * The two operations share storage semantics (full-resource drop with reverse and captive cascades) and differ only
 * in the return-value contract: `delete` returns the identifier only if the resource existed, while `remove` is
 * idempotent and always returns it. Branching on `op` is therefore confined to the `contract` describe block.
 */
export function testPersistClear(op: "delete" | "remove", factory: TestFactory): void {

	describe(op, () => {

		describe("contract", () => {

			it("should return the resource id for an existing resource", factory(async ({ store, generate }) => {

				const existing = await generate(products[0], Product);

				expect(await store[op]({
					entry: existing.id,
					shape: Product
				})).toBe(existing.id);

			}));

			it(op === "delete"
					? "should return undefined for a non-existent resource"
					: "should return the resource id for a non-existent resource",
				factory(async ({ store }) => {

					const missing = "https://data.example.net/products/MISSING-001";

					const result = await store[op]({
						entry: missing,
						shape: Product
					});

					if ( op === "delete" ) {
						expect(result).toBeUndefined();
					} else {
						expect(result).toBe(missing);
					}

				})
			);

			it("should clear the full class lineage", factory(async ({ store, generate, excludes }) => {

				const existing = await generate(products[0], Product);

				await store[op]({ entry: existing.id, shape: Product });

				expect(await excludes({ id: existing.id, type: toys.Product }, Product)).toBeTruthy();

			}));

			it(`should leave no traces of the ${op === "delete" ? "deleted" : "removed"} resource`, factory(async ({
				store,
				generate,
				includes
			}) => {

				const existing = await generate(products[0], Product);

				await store[op]({ entry: existing.id, shape: Product });

				expect(await includes(existing, Product)).toBeFalsy();

			}));

			it("should not affect other resources in the collection", factory(async ({ store, generate, includes }) => {

				const toDrop = await generate(products[0], Product);
				const toKeep = await generate(products[1], Product);

				await store[op]({ entry: toDrop.id, shape: Product });

				expect(await includes(toKeep, Product)).toBeTruthy();

			}));

			it(`should be idempotent on repeated ${op === "delete" ? "deletion" : "removal"}`, factory(async ({
				store,
				generate
			}) => {

				const existing = await generate(products[0], Product);

				expect(await store[op]({
					entry: existing.id,
					shape: Product
				})).toBe(existing.id);

				const second = await store[op]({ entry: existing.id, shape: Product });

				if ( op === "delete" ) {
					expect(second).toBeUndefined();
				} else {
					expect(second).toBe(existing.id);
				}

			}));

		});

		describe("scalar properties", () => {

			it(`should ${op} a resource with self-referential reference`, factory(async ({
				store,
				generate,
				includes
			}) => {

				const withParent = lookup(categories, c => c.broader !== undefined);

				if ( !withParent ) { return; }

				const existing = await generate(withParent, Category);

				expect(await store[op]({ entry: existing.id, shape: Category })).toBe(existing.id);

				expect(await includes(existing, Category)).toBeFalsy();

			}));

		});

		describe("array properties", () => {

			it(`should remove embedded resources on ${op}`, factory(async ({ store, generate, includes }) => {

				const withReviews = lookup(products, p => !!p.reviews?.length);

				if ( !withReviews ) { return; }

				const existing = await generate(withReviews, Product);

				const reviews = existing.reviews!;

				await store[op]({ entry: existing.id, shape: Product });

				expect(await includes(existing, Product)).toBeFalsy();

				await expectAbsent(includes, Product, existing.id, "reviews", reviews);

			}));

		});

		describe("union properties", () => {

			it(`should remove embedded union variants on captor ${op}`, factory(async ({
				store,
				generate,
				includes
			}) => {

				const withPostalAddress = lookup(vendors,
					v => v.address !== undefined && typeof v.address === "object"
				);

				if ( !withPostalAddress ) { return; }

				const existing = await generate(withPostalAddress, Vendor);

				await store[op]({ entry: existing.id, shape: Vendor });

				expect(await includes(existing, Vendor)).toBeFalsy();

			}));

			it(`should remove mixed-variant multi-valued unions on captor ${op}`, factory(async ({
				store,
				generate,
				includes
			}) => {

				const withMixedContacts = lookup(vendors, v =>
					Array.isArray(v.contacts)
					&& v.contacts.some(c => typeof c === "string")
					&& v.contacts.some(c => typeof c === "object")
				);

				if ( !withMixedContacts ) { return; }

				const existing = await generate(withMixedContacts, Vendor);

				await store[op]({ entry: existing.id, shape: Vendor });

				expect(await includes(existing, Vendor)).toBeFalsy();

			}));

		});

		describe("link semantics", () => {

			it(`should clean up forward and reverse links on ${op}`, factory(async ({
				store,
				generate,
				includes,
				excludes
			}) => {

				const withBroader = lookup(categories, c => c.broader !== undefined);

				if ( !withBroader ) { return; }

				const broaderSample = lookup(categories, { id: withBroader.broader });

				if ( !broaderSample ) { return; }

				const clonedParent = await generate(broaderSample, Category);
				const child = await generate({ ...withBroader, broader: clonedParent.id }, Category);

				await store[op]({ entry: child.id, shape: Category });

				// forward link: child and its broader reference should be removed

				expect(await includes(child, Category)).toBeFalsy();

				// reverse link: <parent> toys:narrower <child> retracted

				expect(await excludes({ id: clonedParent.id, narrower: [child.id] }, Category)).toBeTruthy();

				// reverse link: broader target should not be corrupted

				expect(await includes(clonedParent, Category)).toBeTruthy();

			}));

			it(`should clear foreign references on ${op}`, factory(async ({ store, generate, includes, excludes }) => {

				const parent = lookup(categories, c => c.narrower !== undefined);

				if ( !parent ) { return; }

				const narrower = parent.narrower!;
				const child = lookup(categories, c => narrower.includes(c.id));

				if ( !child ) { return; }

				const clonedParent = await generate(parent, Category);
				const clonedChild = await generate({ ...child, broader: clonedParent.id }, Category);

				await store[op]({ entry: clonedParent.id, shape: Category });

				expect(await includes(clonedParent, Category)).toBeFalsy();

				// the child loses only its link to the dropped parent — its own facts survive

				expect(await excludes({ id: clonedChild.id, broader: clonedParent.id }, Category)).toBeTruthy();
				expect(await includes({ id: clonedChild.id, code: clonedChild.code }, Category)).toBeTruthy();

			}));

			it(`should clear all object-position references on ${op}`, factory(async ({
				store,
				generate,
				includes,
				excludes
			}) => {

				const parent = lookup(categories, c => {
					const { narrower } = c;
					return narrower !== undefined && narrower.length >= 2;
				});

				if ( !parent ) { return; }

				const narrower = parent.narrower!;

				const childSamples = narrower
					.map(id => lookup(categories, { id })!)
					.filter(Boolean);

				if ( childSamples.length < 2 ) { return; }

				const clonedParent = await generate(parent, Category);

				const children = await Promise.all(childSamples.map(child =>
					generate({ ...child, broader: clonedParent.id }, Category)
				));

				await store[op]({ entry: clonedParent.id, shape: Category });

				expect(await includes(clonedParent, Category)).toBeFalsy();

				// every child loses its link to the dropped parent while keeping its own facts

				const links = await Promise.all(children.map(child =>
					excludes({ id: child.id, broader: clonedParent.id }, Category)
				));

				const survivors = await Promise.all(children.map(child =>
					includes({ id: child.id, code: child.code }, Category)
				));

				links.forEach(link => expect(link).toBeTruthy());
				survivors.forEach(survivor => expect(survivor).toBeTruthy());

			}));

		});

		// captive lifecycle and cascading captive writes deferred —
		// tracked in https://github.com/metreeca/keep/issues/4

	});

}
