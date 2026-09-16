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

import { id, required, resource } from "@metreeca/blue/resource";
import { string } from "@metreeca/blue/string";
import { decodeBase64 } from "@metreeca/core/base64";
import { TraceError } from "@metreeca/core/trace";
import { type StoreClient, type StoreObserver } from "@metreeca/keep";
import { describe, expect, it, type Mock, vi } from "vitest";
import { createRESTStore } from "./index.js";


const base = "http://example.com";

const shape = resource({ id: id(), name: required(string()) });


type FetchMock = Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;


function mockFetcher(handler: (url: string, init?: RequestInit) => Response): FetchMock {
	return vi.fn(((input: RequestInfo | URL, init?: RequestInit) => {

		const url = typeof input === "string" ? input
			: input instanceof URL ? input.toString()
				: input.url;

		return Promise.resolve(handler(url, init));

	}) as typeof fetch) as FetchMock;
}

function jsonResponse(body: unknown, status: number = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		statusText: statusText(status),
		headers: { "Content-Type": "application/json", ...headers }
	});
}

function emptyResponse(status: number = 204, headers: Record<string, string> = {}): Response {
	return new Response(null, {
		status,
		statusText: statusText(status),
		headers
	});
}

function statusText(status: number): string {

	const texts: Record<number, string> = {
		200: "OK",
		201: "Created",
		204: "No Content",
		404: "Not Found",
		409: "Conflict",
		500: "Internal Server Error"
	};

	return texts[status] ?? "";

}


describe("createRESTStore", () => {

	describe("entry validation", () => {

		const callers: Array<readonly [string, (store: StoreClient, entry: string) => Promise<unknown>]> = [
			["lookup", (store, entry) => store.lookup({ entry, shape, model: { id: "", name: "" } })],
			["create", (store, entry) => store.create({ entry, shape, state: { name: "X" } })],
			["update", (store, entry) => store.update({ entry, shape, state: { name: "X" } })],
			["delete", (store, entry) => store.delete({ entry, shape })],
			["insert", (store, entry) => store.insert({ entry, shape, state: { name: "X" } })],
			["remove", (store, entry) => store.remove({ entry, shape })]
		];

		const malformed: Array<readonly [string, string]> = [
			["non-absolute", "/products/1"],
			["query", `${base}/products/1?foo`],
			["fragment", `${base}/products/1#frag`]
		];

		const cases = callers.flatMap(([method, call]) =>
			malformed.map(([kind, entry]) => [method, kind, entry, call] as const));

		it.each(cases)("should reject %s on %s entry with RangeError",
			async (_method, _kind, entry, call) => {

				const fetcher = mockFetcher(() => emptyResponse());
				const store = createRESTStore(fetcher);

				await expect(call(store, entry)).rejects.toBeInstanceOf(RangeError);
				expect(fetcher).not.toHaveBeenCalled();

			});

	});


	describe("lookup", () => {

		it("should send GET request to entry", async () => {

			const fetcher = mockFetcher(() => jsonResponse({ id: `${base}/products/1`, name: "Widget" }));
			const store = createRESTStore(fetcher);

			await store.lookup({ entry: `${base}/products/1`, shape, model: { id: "", name: "" } });

			expect(fetcher).toHaveBeenCalledOnce();

			const [url, init] = fetcher.mock.calls[0];

			expect(url).toContain("/products/1");
			expect(init?.method).toBe("GET");
			expect(init?.headers).toEqual(expect.objectContaining({ "Accept": "application/json" }));

		});

		describe("locale negotiation", () => {

			const cases: ReadonlyArray<readonly [string, readonly string[], string]> = [
				["a single locale", ["en"], "en;q=1, *;q=0.5"],
				["two locales with descending q", ["en", "it"], "en;q=1, it;q=0.667, *;q=0.333"],
				["three locales with descending q", ["en", "it", "de"], "en;q=1, it;q=0.75, de;q=0.5, *;q=0.25"]
			];

			it.each(cases)("should forward %s as Accept-Language", async (_label, locale, expected) => {

				const fetcher = mockFetcher(() => jsonResponse({ id: `${base}/products/1`, name: "Widget" }));
				const store = createRESTStore(fetcher);

				await store.lookup({ entry: `${base}/products/1`, shape, model: { id: "", name: "" } }, { locale });

				const [, init] = fetcher.mock.calls[0];

				expect(init?.headers).toEqual(expect.objectContaining({ "Accept-Language": expected }));

			});

			it("should omit Accept-Language when no locale is supplied", async () => {

				const fetcher = mockFetcher(() => jsonResponse({ id: `${base}/products/1`, name: "Widget" }));
				const store = createRESTStore(fetcher);

				await store.lookup({ entry: `${base}/products/1`, shape, model: { id: "", name: "" } });

				const [, init] = fetcher.mock.calls[0];

				expect(init?.headers).not.toHaveProperty("Accept-Language");

			});

			it("should omit Accept-Language for an empty locale list", async () => {

				const fetcher = mockFetcher(() => jsonResponse({ id: `${base}/products/1`, name: "Widget" }));
				const store = createRESTStore(fetcher);

				await store.lookup({ entry: `${base}/products/1`, shape, model: { id: "", name: "" } }, { locale: [] });

				const [, init] = fetcher.mock.calls[0];

				expect(init?.headers).not.toHaveProperty("Accept-Language");

			});

		});

		it("should encode the model as a base64 query string", async () => {

			const fetcher = mockFetcher(() => jsonResponse({ id: `${base}/products/1`, name: "Widget" }));
			const store = createRESTStore(fetcher);

			const model = { id: "", name: "" };
			await store.lookup({ entry: `${base}/products/1`, shape, model });

			const [url] = fetcher.mock.calls[0];
			const query = (url as string).split("?")[1];
			const decoded = JSON.parse(decodeBase64(query));

			expect(decoded).toEqual(model);

		});

		it("should omit the query string for an empty template", async () => {

			const fetcher = mockFetcher(() => jsonResponse({}));
			const store = createRESTStore(fetcher);

			await store.lookup({ entry: `${base}/products/1`, shape, model: {} });

			const [url] = fetcher.mock.calls[0];

			expect(url).toBe(`${base}/products/1`);

		});

		it("should return parsed response data", async () => {

			const fetcher = mockFetcher(() => jsonResponse({ id: `${base}/products/1`, name: "Widget" }));
			const store = createRESTStore(fetcher);

			const result = await store.lookup({ entry: `${base}/products/1`, shape, model: { id: "", name: "" } });

			expect(result).toEqual({ id: `${base}/products/1`, name: "Widget" });

		});

		it("should return undefined on 404", async () => {

			const fetcher = mockFetcher(() => emptyResponse(404));
			const store = createRESTStore(fetcher);

			const result = await store.lookup({ entry: `${base}/products/999`, shape, model: { id: "", name: "" } });

			expect(result).toBeUndefined();

		});

		it("should reject with Problem on server error", async () => {

			const fetcher = mockFetcher(() => emptyResponse(500));
			const store = createRESTStore(fetcher);

			await expect(store.lookup({
				entry: `${base}/products/1`, shape, model: { id: "", name: "" }
			})).rejects.toMatchObject({ status: 500 });

		});

		it("should reject with Problem on malformed JSON response", async () => {

			const fetcher = mockFetcher(() => new Response("not json {{{", {
				status: 200,
				statusText: "OK",
				headers: { "Content-Type": "application/json" }
			}));

			const store = createRESTStore(fetcher);

			await expect(store.lookup({
				entry: `${base}/products/1`, shape, model: { id: "", name: "" }
			})).rejects.toMatchObject({ detail: expect.stringMatching(/malformed JSON/) });

		});

		it("should reject with TraceError on model that doesn't match the shape", async () => {

			const fetcher = mockFetcher(() => jsonResponse({ id: `${base}/products/1`, name: "Widget" }));
			const store = createRESTStore(fetcher);

			await expect(store.lookup({
				entry: `${base}/products/1`, shape, model: { id: "", name: 42 } as never // wrong type
			})).rejects.toBeInstanceOf(TraceError);

			expect(fetcher).not.toHaveBeenCalled();

		});

		it("should reject with TraceError on response that doesn't match the shape", async () => {

			const fetcher = mockFetcher(() => jsonResponse({ name: 42 })); // number where string expected
			const store = createRESTStore(fetcher);

			await expect(store.lookup({
				entry: `${base}/products/1`, shape, model: { id: "", name: "" }
			})).rejects.toBeInstanceOf(TraceError);

		});

		it("should skip response validation when trusted", async () => {

			const fetcher = mockFetcher(() => jsonResponse({ name: 42 })); // violates the shape
			const store = createRESTStore(fetcher, { trusted: true });

			const result = await store.lookup({ entry: `${base}/products/1`, shape, model: { id: "", name: "" } });

			expect(result).toEqual({ name: 42 });

		});

		it("should not emit mutation events", async () => {

			const fetcher = mockFetcher(() => jsonResponse({ id: `${base}/x`, name: "W" }));
			const store = createRESTStore(fetcher);
			const observer = vi.fn<StoreObserver>();

			store.observe(observer);
			await store.lookup({ entry: `${base}/x`, shape, model: { id: "", name: "" } });

			expect(observer).not.toHaveBeenCalled();

		});

	});

	describe("create", () => {

		it("should send POST request with body", async () => {

			const fetcher = mockFetcher(() => emptyResponse(201, { "Location": `${base}/products/42` }));
			const store = createRESTStore(fetcher);

			await store.create({ entry: `${base}/products/`, shape, state: { name: "Widget" } });

			const [url, init] = fetcher.mock.calls[0];

			expect(url).toBe(`${base}/products/`);
			expect(init?.method).toBe("POST");
			expect(JSON.parse(init?.body as string)).toEqual({ name: "Widget" });

		});

		it("should return the resolved Location on success", async () => {

			const fetcher = mockFetcher(() => emptyResponse(201, { "Location": `${base}/products/42` }));
			const store = createRESTStore(fetcher);

			expect(await store.create({ entry: `${base}/products/`, shape, state: { name: "Widget" } }))
				.toBe(`${base}/products/42`);

		});

		it("should return undefined on 409 conflict", async () => {

			const fetcher = mockFetcher(() => emptyResponse(409));
			const store = createRESTStore(fetcher);

			expect(await store.create({ entry: `${base}/products/`, shape, state: { name: "Widget" } }))
				.toBeUndefined();

		});

		it("should reject with Problem on server error", async () => {

			const fetcher = mockFetcher(() => emptyResponse(500));
			const store = createRESTStore(fetcher);

			await expect(store.create({ entry: `${base}/products/`, shape, state: { name: "Widget" } }))
				.rejects.toMatchObject({ status: 500 });

		});

		it("should reject with Problem when Location header is missing", async () => {

			const fetcher = mockFetcher(() => emptyResponse(201));
			const store = createRESTStore(fetcher);

			await expect(store.create({
				entry: `${base}/products/`, shape, state: { name: "Widget" }
			})).rejects.toMatchObject({ detail: expect.stringMatching(/missing <Location> header/) });

		});

		it("should reject with TraceError on state that doesn't match the shape", async () => {

			const fetcher = mockFetcher(() => emptyResponse(201));
			const store = createRESTStore(fetcher);

			await expect(store.create({
				entry: `${base}/products/`, shape, state: { name: 42 } as never // wrong type
			})).rejects.toBeInstanceOf(TraceError);

			expect(fetcher).not.toHaveBeenCalled();

		});

		it("should notify with Location header when present", async () => {

			const fetcher = mockFetcher(() => emptyResponse(201, { "Location": `${base}/products/42` }));
			const store = createRESTStore(fetcher);
			const observer = vi.fn<StoreObserver>();

			store.observe(observer);
			await store.create({ entry: `${base}/products/`, shape, state: { name: "Widget" } });

			expect(observer).toHaveBeenCalledWith({ [`${base}/products/42`]: true });

		});

		it("should resolve a relative Location against entry", async () => {

			const fetcher = mockFetcher(() => emptyResponse(201, { "Location": "/products/42" }));
			const store = createRESTStore(fetcher);
			const observer = vi.fn<StoreObserver>();

			store.observe(observer);
			await store.create({ entry: `${base}/products/`, shape, state: { name: "Widget" } });

			expect(observer).toHaveBeenCalledWith({ [`${base}/products/42`]: true });

		});

		it("should strip the last path segment when resolving a relative Location against a non-directory entry", async () => {

			const fetcher = mockFetcher(() => emptyResponse(201, { "Location": "42" }));
			const store = createRESTStore(fetcher);

			expect(await store.create({ entry: `${base}/products/1`, shape, state: { name: "Widget" } }))
				.toBe(`${base}/products/42`);

		});

		it("should return a cross-origin Location verbatim", async () => {

			const foreign = "http://cdn.example.net/products/42";
			const fetcher = mockFetcher(() => emptyResponse(201, { "Location": foreign }));
			const store = createRESTStore(fetcher);

			expect(await store.create({ entry: `${base}/products/`, shape, state: { name: "Widget" } }))
				.toBe(foreign);

		});

		it("should throw on a malformed Location", async () => {

			const fetcher = mockFetcher(() => emptyResponse(201, { "Location": "not a url {{{" }));
			const store = createRESTStore(fetcher);

			await expect(store.create({
				entry: `${base}/products/`, shape, state: { name: "Widget" }
			})).rejects.toThrow(RangeError);

		});

	});

	describe("update", () => {

		it("should send PUT request with body and no Prefer header", async () => {

			const fetcher = mockFetcher(() => emptyResponse(204));
			const store = createRESTStore(fetcher);

			await store.update({ entry: `${base}/products/1`, shape, state: { name: "Updated" } });

			const [url, init] = fetcher.mock.calls[0];

			expect(url).toBe(`${base}/products/1`);
			expect(init?.method).toBe("PUT");
			expect(JSON.parse(init?.body as string)).toEqual({ name: "Updated" });
			expect(init?.headers).not.toHaveProperty("Prefer");

		});

		it("should return entry on success", async () => {

			const fetcher = mockFetcher(() => emptyResponse(204));
			const store = createRESTStore(fetcher);

			expect(await store.update({ entry: `${base}/products/1`, shape, state: { name: "Updated" } }))
				.toBe(`${base}/products/1`);

		});

		it("should return undefined on 404", async () => {

			const fetcher = mockFetcher(() => emptyResponse(404));
			const store = createRESTStore(fetcher);

			expect(await store.update({ entry: `${base}/products/999`, shape, state: { name: "X" } }))
				.toBeUndefined();

		});

		it("should reject with Problem on server error", async () => {

			const fetcher = mockFetcher(() => emptyResponse(500));
			const store = createRESTStore(fetcher);

			await expect(store.update({ entry: `${base}/products/1`, shape, state: { name: "X" } }))
				.rejects.toMatchObject({ status: 500 });

		});

		it("should reject with TraceError on state that doesn't match the shape", async () => {

			const fetcher = mockFetcher(() => emptyResponse(204));
			const store = createRESTStore(fetcher);

			await expect(store.update({
				entry: `${base}/products/1`, shape, state: { name: 42 } as never
			})).rejects.toBeInstanceOf(TraceError);

			expect(fetcher).not.toHaveBeenCalled();

		});

		it("should notify observer on update", async () => {

			const fetcher = mockFetcher(() => emptyResponse(204));
			const store = createRESTStore(fetcher);
			const observer = vi.fn<StoreObserver>();

			store.observe(observer);
			await store.update({ entry: `${base}/products/1`, shape, state: { name: "Updated" } });

			expect(observer).toHaveBeenCalledWith({ [`${base}/products/1`]: true });

		});

	});

	describe("delete", () => {

		it("should send DELETE request with no Prefer header", async () => {

			const fetcher = mockFetcher(() => emptyResponse(204));
			const store = createRESTStore(fetcher);

			await store.delete({ entry: `${base}/products/1`, shape });

			const [url, init] = fetcher.mock.calls[0];

			expect(url).toBe(`${base}/products/1`);
			expect(init?.method).toBe("DELETE");
			expect(init?.headers ?? {}).not.toHaveProperty("Prefer");

		});

		it("should return entry on success", async () => {

			const fetcher = mockFetcher(() => emptyResponse(204));
			const store = createRESTStore(fetcher);

			expect(await store.delete({ entry: `${base}/products/1`, shape }))
				.toBe(`${base}/products/1`);

		});

		it("should return undefined on 404", async () => {

			const fetcher = mockFetcher(() => emptyResponse(404));
			const store = createRESTStore(fetcher);

			expect(await store.delete({ entry: `${base}/products/999`, shape }))
				.toBeUndefined();

		});

		it("should reject with Problem on server error", async () => {

			const fetcher = mockFetcher(() => emptyResponse(500));
			const store = createRESTStore(fetcher);

			await expect(store.delete({ entry: `${base}/products/1`, shape }))
				.rejects.toMatchObject({ status: 500 });

		});

		it("should notify observer on delete", async () => {

			const fetcher = mockFetcher(() => emptyResponse(204));
			const store = createRESTStore(fetcher);
			const observer = vi.fn<StoreObserver>();

			store.observe(observer);
			await store.delete({ entry: `${base}/products/1`, shape });

			expect(observer).toHaveBeenCalledWith({ [`${base}/products/1`]: false });

		});

	});

	describe("insert", () => {

		it("should PUT resource unconditionally with Prefer: handling=lenient", async () => {

			const fetcher = mockFetcher(() => emptyResponse(200));
			const store = createRESTStore(fetcher);

			await store.insert({ entry: `${base}/products/1`, shape, state: { name: "Widget" } });

			const [url, init] = fetcher.mock.calls[0];

			expect(url).toBe(`${base}/products/1`);
			expect(init?.method).toBe("PUT");
			expect(JSON.parse(init?.body as string)).toEqual({ name: "Widget" });
			expect(init?.headers).toEqual(expect.objectContaining({ "Prefer": "handling=lenient" }));

		});

		it("should return entry on success", async () => {

			const fetcher = mockFetcher(() => emptyResponse(200));
			const store = createRESTStore(fetcher);

			expect(await store.insert({ entry: `${base}/products/1`, shape, state: { name: "Widget" } }))
				.toBe(`${base}/products/1`);

		});

		it("should propagate 404 from a server that ignores Prefer: handling=lenient", async () => {

			const fetcher = mockFetcher(() => emptyResponse(404));
			const store = createRESTStore(fetcher);

			await expect(store.insert({ entry: `${base}/products/1`, shape, state: { name: "Widget" } }))
				.rejects.toMatchObject({ status: 404 });

		});

		it("should reject with TraceError on state that doesn't match the shape", async () => {

			const fetcher = mockFetcher(() => emptyResponse(200));
			const store = createRESTStore(fetcher);

			await expect(store.insert({
				entry: `${base}/products/1`, shape, state: { name: 42 } as never
			})).rejects.toBeInstanceOf(TraceError);

			expect(fetcher).not.toHaveBeenCalled();

		});

		it("should notify observer on insert", async () => {

			const fetcher = mockFetcher(() => emptyResponse(200));
			const store = createRESTStore(fetcher);
			const observer = vi.fn<StoreObserver>();

			store.observe(observer);
			await store.insert({ entry: `${base}/products/1`, shape, state: { name: "Widget" } });

			expect(observer).toHaveBeenCalledWith({ [`${base}/products/1`]: true });

		});

	});

	describe("remove", () => {

		it("should DELETE entry unconditionally with Prefer: handling=lenient", async () => {

			const fetcher = mockFetcher(() => emptyResponse(204));
			const store = createRESTStore(fetcher);

			await store.remove({ entry: `${base}/products/1`, shape });

			const [url, init] = fetcher.mock.calls[0];

			expect(url).toBe(`${base}/products/1`);
			expect(init?.method).toBe("DELETE");
			expect(init?.headers).toEqual(expect.objectContaining({ "Prefer": "handling=lenient" }));

		});

		it("should return entry on success", async () => {

			const fetcher = mockFetcher(() => emptyResponse(204));
			const store = createRESTStore(fetcher);

			expect(await store.remove({ entry: `${base}/products/1`, shape }))
				.toBe(`${base}/products/1`);

		});

		it("should silently return entry on 404", async () => {

			const fetcher = mockFetcher(() => emptyResponse(404));
			const store = createRESTStore(fetcher);

			expect(await store.remove({ entry: `${base}/products/999`, shape }))
				.toBe(`${base}/products/999`);

		});

		it("should reject with Problem on server error", async () => {

			const fetcher = mockFetcher(() => emptyResponse(500));
			const store = createRESTStore(fetcher);

			await expect(store.remove({ entry: `${base}/products/1`, shape }))
				.rejects.toMatchObject({ status: 500 });

		});

		it("should notify observer on 404", async () => {

			const fetcher = mockFetcher(() => emptyResponse(404));
			const store = createRESTStore(fetcher);
			const observer = vi.fn<StoreObserver>();

			store.observe(observer);
			await store.remove({ entry: `${base}/products/999`, shape });

			expect(observer).toHaveBeenCalledWith({ [`${base}/products/999`]: false });

		});

		it("should notify observer on remove", async () => {

			const fetcher = mockFetcher(() => emptyResponse(204));
			const store = createRESTStore(fetcher);
			const observer = vi.fn<StoreObserver>();

			store.observe(observer);
			await store.remove({ entry: `${base}/products/1`, shape });

			expect(observer).toHaveBeenCalledWith({ [`${base}/products/1`]: false });

		});

	});

});
