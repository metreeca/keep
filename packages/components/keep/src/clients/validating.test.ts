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

import { number } from "@metreeca/blue/number";
import { reference } from "@metreeca/blue/reference";
import { id, multiple, optional, required, resource } from "@metreeca/blue/resource";
import { string } from "@metreeca/blue/string";
import { TraceError } from "@metreeca/core/trace";
import { describe, expect, it, vi } from "vitest";
import type { StoreClient } from "../index.js";
import { createManagingStore } from "../stores/managing.js";
import { createValidatingStore } from "./validating.js";

describe("createValidatingStore", () => {

	const shape = resource({
		id: id(),
		name: required(string()),
		price: required(number())
	});

	const entry = "http://example.com/products/1";

	const fullModel = { id: {}, name: {}, price: {} };
	const fullState = { name: "Widget", price: 1 };

	const Target = resource({ name: required(string()) });
	const nested = resource({ items: multiple(reference(Target)) });

	const Captive = resource({ id: id(), label: required(string()) });
	const captor = resource({ child: optional(reference(Captive), { captive: true }) });
	const captors = resource({ items: multiple(reference(captor)) });
	// ;(cast) test fixture: an inline captive batch the draft type rejects, to exercise the runtime depth cap
	const captiveBatch = { child: { id: "http://example.com/inner/1", label: "x" } } as never;

	const catalogue = "http://example.com/products/";
	const Catalogue = resource({ items: multiple(reference(shape)) });


	// Localised cast: vi.fn cannot preserve StoreClient["lookup"]'s `<T extends Template>`
	// generic, so the type narrows once here instead of at every call site.
	function retrieveStub(impl: (request: { entry: string }) => unknown): StoreClient["lookup"] {
		return vi.fn(async request => impl(request)) as unknown as StoreClient["lookup"];
	}

	function stubStore(overrides: Partial<StoreClient> = {}): StoreClient {
		return {
			lookup: retrieveStub(({ entry: e }) => ({ id: e, name: "n", price: 1 })),
			create: vi.fn(async ({ entry: e }) => e),
			update: vi.fn(async ({ entry: e }) => e),
			delete: vi.fn(async ({ entry: e }) => e),
			insert: vi.fn(async ({ entry: e }) => e),
			remove: vi.fn(async ({ entry: e }) => e),
			...overrides
		};
	}


	describe("entry validation", () => {

		const callers: ReadonlyArray<[string, (s: StoreClient, e: string) => Promise<unknown>]> = [
			["detail", (s, e) => s.lookup({ entry: e, shape, model: fullModel })],
			["create", (s, e) => s.create({ entry: e, shape: Catalogue, model: { items: {} }, state: fullState })],
			["update", (s, e) => s.update({ entry: e, shape, state: fullState })],
			["delete", (s, e) => s.delete({ entry: e, shape })],
			["insert", (s, e) => s.insert({ entry: e, shape, state: fullState })],
			["remove", (s, e) => s.remove({ entry: e, shape })]
		];

		it.each(callers)("should reject %s with RangeError on non-absolute entry", async (_, call) => {
			const store = createValidatingStore(stubStore());
			await expect(call(store, "/relative")).rejects.toBeInstanceOf(RangeError);
		});

		it.each([["query", `${entry}?x`], ["fragment", `${entry}#x`]] as const)(
			"should reject detail with RangeError on entry with %s", async (_, malformed) => {
				const store = createValidatingStore(stubStore());
				await expect(store.lookup({ entry: malformed, shape, model: fullModel }))
					.rejects.toBeInstanceOf(RangeError);
			}
		);

	});

	describe("input validation", () => {

		it("should reject with TraceError on model that doesn't match the shape", async () => {
			const store = createValidatingStore(stubStore());
			await expect(store.lookup({
				entry, shape, model: { name: 42 } as never
			})).rejects.toBeInstanceOf(TraceError);
		});

		it("should reject with TraceError on collection model that doesn't match the shape", async () => {
			const store = createValidatingStore(stubStore());
			await expect(store.lookup({
				entry, shape: nested, model: { items: { name: 42 } } as never
			})).rejects.toBeInstanceOf(TraceError);
		});

		it("should reject create with TraceError on a collection slice that doesn't match the shape", async () => {
			const store = createValidatingStore(stubStore());
			await expect(store.create({
				entry: catalogue, shape: Catalogue, model: { itms: {} }, state: fullState
			} as never)).rejects.toBeInstanceOf(TraceError);
		});

		it("should reject create with TraceError on a slice naming a property collecting no resources", async () => {
			const Tagged = resource({ items: multiple(reference(shape)), tags: multiple(string()) });
			const store = createValidatingStore(stubStore());
			await expect(store.create({
				entry: catalogue, shape: Tagged, model: { tags: {} }, state: fullState
			} as never)).rejects.toBeInstanceOf(TraceError);
		});

		it("should reject create with RangeError on a state id not nested under the collection", async () => {
			const inner = stubStore();
			const store = createValidatingStore(inner);
			await expect(store.create({
				entry: catalogue, shape: Catalogue, model: { items: {} },
				state: { id: "http://example.com/elsewhere/1", ...fullState }
			})).rejects.toBeInstanceOf(RangeError);
			expect(inner.create).not.toHaveBeenCalled();
		});

		it("should hand create the collected shape and the validated state", async () => {
			const inner = stubStore();
			const store = createValidatingStore(inner);
			await store.create({ entry: catalogue, shape: Catalogue, model: { items: {} }, state: fullState });
			expect(vi.mocked(inner.create).mock.calls[0]?.[0]).toEqual({
				entry: catalogue, shape: Catalogue, model: { items: {} }, state: fullState
			});
		});

		it.each(["update", "insert"] as const)("should reject %s with RangeError on a state id differing from entry",
			async method => {
				const inner = stubStore();
				const store = createValidatingStore(inner);
				await expect(store[method]({
					entry,
					shape,
					state: { id: "http://example.com/products/2", ...fullState }
				}))
					.rejects.toBeInstanceOf(RangeError);
				expect(inner[method]).not.toHaveBeenCalled();
			}
		);

		it.each(["update", "insert"] as const)("should accept %s with a state id matching entry", async method => {
			const inner = stubStore();
			const store = createValidatingStore(inner);
			await expect(store[method]({ entry, shape, state: { id: entry, ...fullState } })).resolves.toBe(entry);
		});

		const stateCallers: ReadonlyArray<[string, (s: StoreClient) => Promise<unknown>]> = [
			["create", s => s.create({
				entry: catalogue,
				shape: Catalogue,
				model: { items: {} },
				state: { name: 42 } as never
			})],
			["update", s => s.update({ entry, shape, state: { name: 42 } as never })],
			["insert", s => s.insert({ entry, shape, state: { name: 42 } as never })]
		];

		it.each(stateCallers)("should reject %s with TraceError on state that doesn't match the shape",
			async (_, call) => {
				const store = createValidatingStore(stubStore());
				await expect(call(store)).rejects.toBeInstanceOf(TraceError);
			}
		);

		it("should accept a lazy shape thunk", async () => {
			const inner = stubStore();
			const store = createValidatingStore(inner);
			await store.create({ entry: catalogue, shape: () => Catalogue, model: { items: {} }, state: fullState });
			expect(inner.create).toHaveBeenCalledOnce();
		});

	});

	// Default behaviour (untrusted source): the inner store may return non-conforming
	// data (for example, a remote REST connector), so the response is validated against the
	// shape narrowed by the caller's `model` template. Constraints on unrequested fields don't apply.
	describe("untrusted source (default)", () => {

		it("should accept a response conforming to a full-shape projection", async () => {
			const inner = stubStore({
				lookup: retrieveStub(({ entry: e }) => ({ id: e, name: "Widget", price: 9.99 }))
			});
			const store = createValidatingStore(inner);
			const result = await store.lookup({ entry, shape, model: fullModel });
			expect(result).toEqual({ id: entry, name: "Widget", price: 9.99 });
		});

		it("should return an immutable response", async () => {
			const inner = stubStore({
				lookup: retrieveStub(({ entry: e }) => ({ id: e, name: "Widget", price: 9.99 }))
			});
			const store = createValidatingStore(inner);
			const result = await store.lookup({ entry, shape, model: fullModel });
			expect(Object.isFrozen(result)).toBeTruthy();
		});

		it("should accept an undefined response (404 / miss)", async () => {
			const inner = stubStore({
				lookup: retrieveStub(() => undefined)
			});
			const store = createValidatingStore(inner);
			const result = await store.lookup({ entry, shape, model: fullModel });
			expect(result).toBeUndefined();
		});

		it("should reject a response with the wrong type for a projected entry", async () => {
			const inner = stubStore({
				lookup: retrieveStub(() => ({ price: "not-a-number" }))
			});
			const store = createValidatingStore(inner);
			await expect(store.lookup({
				entry, shape, model: { price: {} }
			})).rejects.toBeInstanceOf(TraceError);
		});

		it("should accept a partial-projection response (unrequested required fields not enforced)", async () => {
			const inner = stubStore({
				lookup: retrieveStub(({ entry: e }) => ({ id: e, price: 9.99 }))
			});
			const store = createValidatingStore(inner);
			const result = await store.lookup({ entry, shape, model: { id: {}, price: {} } });
			expect(result).toEqual({ id: entry, price: 9.99 });
		});

		it("should reject a response missing a requested required entry", async () => {
			const inner = stubStore({
				lookup: retrieveStub(({ entry: e }) => ({ id: e }))
			});
			const store = createValidatingStore(inner);
			await expect(store.lookup({
				entry, shape, model: { id: {}, price: {} }
			})).rejects.toBeInstanceOf(TraceError);
		});

		it("should accept a collection conforming to the collected shape", async () => {
			const inner = stubStore({ lookup: retrieveStub(() => ({ items: [{ name: "x" }] })) });
			const store = createValidatingStore(inner);
			await expect(store.lookup({ entry, shape: nested, model: { items: { name: {} } } }))
				.resolves.toEqual({ items: [{ name: "x" }] });
		});

		it("should reject a collection with an item not matching the collected shape", async () => {
			const inner = stubStore({ lookup: retrieveStub(() => ({ items: [{ name: 42 }] })) });
			const store = createValidatingStore(inner);
			await expect(store.lookup({ entry, shape: nested, model: { items: { name: {} } } }))
				.rejects.toBeInstanceOf(TraceError);
		});

	});

	// Trusted source: the inner store is assumed to return shape-conforming data
	// (for example, a local SPARQL connector that computes the result itself), so the
	// response is passed through without re-validation.

	describe("trusted source (trusted: true)", () => {

		it("should pass through a response unchanged without re-validation", async () => {
			const inner = stubStore({
				lookup: retrieveStub(() => ({ price: "not-a-number" }))
			});
			const store = createValidatingStore(inner, { trusted: true });
			const result = await store.lookup({ entry, shape, model: { price: {} } });
			expect(result).toEqual({ price: "not-a-number" });
		});

		it("should return an immutable response", async () => {
			const inner = stubStore({
				lookup: retrieveStub(({ entry: e }) => ({ id: e, name: "Widget", price: 9.99 }))
			});
			const store = createValidatingStore(inner, { trusted: true });
			const result = await store.lookup({ entry, shape, model: fullModel });
			expect(Object.isFrozen(result)).toBeTruthy();
		});

	});

	describe("delegate store inside execute task", () => {

		it("should validate state on calls made through the task's store parameter", async () => {
			const inner = stubStore();
			const store = createManagingStore(createValidatingStore(inner));

			await expect(store.execute(async s => {
				await s.create({
					entry: catalogue,
					shape: Catalogue,
					model: { items: {} },
					state: { name: 42 } as never
				});
			})).rejects.toBeInstanceOf(TraceError);

			expect(inner.create).not.toHaveBeenCalled();
		});

		it("should validate entry on calls made through the task's store parameter", async () => {
			const inner = stubStore();
			const store = createManagingStore(createValidatingStore(inner));

			await expect(store.execute(async s => {
				await s.create({ entry: "/relative", shape: Catalogue, model: { items: {} }, state: fullState });
			})).rejects.toBeInstanceOf(RangeError);

			expect(inner.create).not.toHaveBeenCalled();
		});

	});

	// Query safety caps: the retrieval scope plain/depth/limit are forwarded into the model template validation,
	// restricting query complexity for untrusted clients. Enforced on the input model, independently
	// of response re-validation, so the cases pin them with trusted: true.
	describe("query safety caps", () => {

		it("should reject a model carrying aggregate transforms when plain is true", async () => {
			const store = createValidatingStore(stubStore(), { trusted: true });
			await expect(store.lookup({
				entry, shape: nested, model: { items: { "total=count:": {} } }
			}, { plain: true })).rejects.toBeInstanceOf(TraceError);
		});

		it("should reject a nested model when depth is zero", async () => {
			const store = createValidatingStore(stubStore(), { trusted: true });
			await expect(store.lookup({
				entry, shape: nested, model: { items: { name: {} } }
			}, { depth: 0 })).rejects.toBeInstanceOf(TraceError);
		});

		it("should accept a bare-reference model when depth is zero (references admitted, nesting rejected)", async () => {
			const store = createValidatingStore(stubStore(), { trusted: true });
			await expect(store.lookup({
				entry, shape: nested, model: { items: {} }
			}, { depth: 0 })).resolves.toBeDefined();
		});

		it("should reject a model whose pagination constraint exceeds the limit", async () => {
			const store = createValidatingStore(stubStore(), { trusted: true });
			await expect(store.lookup({
				entry, shape: nested, model: { items: { "#": 101 } }
			}, { limit: 100 })).rejects.toBeInstanceOf(TraceError);
		});

		it("should inject the limit as a default pagination bound into the forwarded model", async () => {
			const inner = stubStore();
			const store = createValidatingStore(inner, { trusted: true });
			await store.lookup({ entry, shape: nested, model: { items: { name: {} } } }, { limit: 50 });
			expect(inner.lookup).toHaveBeenCalledWith(
				{ entry, shape: nested, model: { items: { name: {}, "#": 50 } } },
				{ limit: 50 }
			);
		});

	});

	// Captive expansion depth: create/update/insert always validate state at depth 0, rejecting inline captive
	// batches until cascading captive writes are supported (https://github.com/metreeca/keep/issues/4).
	describe("captive expansion depth cap", () => {

		it("should reject an inline captive batch on create (always capped at depth 0)", async () => {
			const store = createValidatingStore(stubStore());
			await expect(store.create({ entry: catalogue, shape: captors, model: { items: {} }, state: captiveBatch }))
				.rejects.toBeInstanceOf(TraceError);
		});

		it("should reject an inline captive batch on update (always capped at depth 0)", async () => {
			const store = createValidatingStore(stubStore());
			await expect(store.update({ entry, shape: captor, state: captiveBatch }))
				.rejects.toBeInstanceOf(TraceError);
		});

		it("should reject an inline captive batch on insert (always capped at depth 0)", async () => {
			const inner = stubStore();
			const store = createValidatingStore(inner);
			await expect(store.insert({ entry, shape: captor, state: captiveBatch }))
				.rejects.toBeInstanceOf(TraceError);
			expect(inner.insert).not.toHaveBeenCalled();
		});

	});

});
