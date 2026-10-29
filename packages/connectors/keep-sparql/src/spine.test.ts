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

import { getShapeProperties, type Property } from "@metreeca/blue/resource";
import type { Scope } from "@metreeca/core/scope";
import { Category } from "@metreeca/keep-suite/toys";
import type { Broker, Deferred, Detail, Detect, Request } from "@metreeca/keep/batching";
import type { Reference } from "@metreeca/qest/state";
import { named } from "@metreeca/trio";
import type { RepositoryClient, Tuple, Variable } from "@metreeca/wire-sparql";
import { describe, expect, it, vi } from "vitest";
import { all, collection, map, plain, read, resource, write } from "./spine.js";


const entries: readonly Reference[] = [
	"http://example.com/resources/0001",
	"http://example.com/resources/0002"
];


function batch(): readonly Deferred<Detect>[] {
	return entries.map(entry => ({
		request: { entry },
		resolve: vi.fn(),
		reject: vi.fn()
	}));
}

function details(): readonly Deferred<Detail>[] {
	return entries.map(entry => ({
		request: { entry, shape: Category, model: {}, locale: [] },
		resolve: vi.fn(),
		reject: vi.fn()
	}));
}

function client(tuples: () => Promise<readonly Tuple[]>): RepositoryClient {
	return {
		ask: vi.fn(),
		select: vi.fn(tuples),
		construct: vi.fn(),
		update: vi.fn(async () => undefined),
		merge: vi.fn(),
		store: vi.fn()
	};
}

function broker(): Broker {
	return {
		detect: vi.fn(),
		detail: vi.fn(async () => ({ name: "detailed" })) as Broker["detail"], // ;(cast) test mock of a generic method
		select: vi.fn(async () => ["selected"]),
		modify: vi.fn()
	};
}

/**
 * The value each request of `items` settled with, once every request has settled.
 */
async function settled(items: readonly Deferred<Request>[]): Promise<readonly unknown[]> {

	await vi.waitFor(() => items.forEach(({ resolve }) => expect(resolve).toHaveBeenCalled()));

	return items.map(({ resolve }) => vi.mocked(resolve).mock.calls[0]?.[0]);

}


describe("read", () => {

	const owner = "?owner";

	/**
	 * A decoder settling each request with whether it was handed any row, recording what it was handed.
	 */
	function decoder() {
		return vi.fn((_: Scope<Variable>, __: Deferred<Detect>, rows: readonly Tuple[]) => plain(rows.length > 0));
	}


	it("hands each request the rows binding its own entry, in solution order", async () => {

		const [one, two] = entries;
		const items = batch();

		const decode = decoder();

		const tuples: readonly Tuple[] = [
			{ [owner]: named(two), "?v": named("http://example.com/a") },
			{ [owner]: named(one), "?v": named("http://example.com/b") },
			{ [owner]: named(two), "?v": named("http://example.com/c") },
			{ "?v": named("http://example.com/d") }
		];

		await read(items, client(async () => tuples), broker(), {
			encode: () => "select",
			owner: () => owner,
			decode
		});

		expect(decode.mock.calls.map(([, item, rows]) => [item.request.entry, rows.length])).toEqual([
			[one, 1],
			[two, 2]
		]);

	});

	it("runs no query and decodes every request from no rows when the pass encodes nothing", async () => {

		const items = batch();
		const repository = client(async () => []);

		const decode = decoder();

		await read(items, repository, broker(), {
			encode: () => undefined,
			owner: () => owner,
			decode
		});

		expect(repository.select).not.toHaveBeenCalled();
		expect(decode.mock.calls.map(([, , rows]) => rows)).toEqual([[], []]);

	});

	it("settles each request with its decoded value", async () => {

		const [one] = entries;
		const items = batch();

		await read(items, client(async () => []), broker(), {
			encode: () => "select",
			owner: () => owner,
			decode: (_, { request: { entry } }) => plain(entry === one)
		});

		expect(await settled(items)).toEqual([true, false]);

	});

	it("rejects every request of a failing query and settles normally", async () => {

		const items = batch();
		const failure = new Error("unavailable");

		const decode = decoder();

		await read(items, client(async () => { throw failure; }), broker(), {
			encode: () => "select",
			owner: () => owner,
			decode
		});

		expect(decode).not.toHaveBeenCalled();
		items.forEach(({ reject }) => expect(reject).toHaveBeenCalledWith(failure));

	});

	it("rejects a request its decoder throws on and settles the others", async () => {

		const [one] = entries;
		const items = batch();
		const failure = new Error("undecodable");

		await read(items, client(async () => []), broker(), {
			encode: () => "select",
			owner: () => owner,
			decode: (_, { request: { entry } }) => entry === one ? plain(true) : (() => { throw failure; })()
		});

		await vi.waitFor(() => {
			expect(items[0].resolve).toHaveBeenCalledWith(true);
			expect(items[1].reject).toHaveBeenCalledWith(failure);
		});

	});


	describe("with nested requests", () => {

		const field = property("narrower");

		function property(name: string): Property {

			const member = getShapeProperties(Category)[name];

			if ( member?.kind !== "property" ) {
				throw new Error(`undefined property <${name}>`);
			}

			return member;

		}


		it("completes a value from the resource the detail pass materialises", async () => {

			const [one] = entries;
			const items = details().slice(0, 1);

			await read(items, client(async () => []), broker(), {
				encode: () => "select",
				owner: () => owner,
				decode: () => map(
					resource({ entry: one, shape: Category, model: { name: {} }, locale: [] }, resource => resource["name"]),
					filled => ({ nested: { kept: true, filled } })
				)
			});

			expect(await settled(items)).toEqual([{ nested: { kept: true, filled: "detailed" } }]);

		});

		it("completes a value from the collection the select pass materialises", async () => {

			const [one] = entries;
			const items = details().slice(0, 1);

			await read(items, client(async () => []), broker(), {
				encode: () => "select",
				owner: () => owner,
				decode: () => map(
					collection({ entry: one, shape: Category, field, query: {}, locale: [] }, values => values),
					narrower => ({ first: "first", narrower, third: "third" })
				)
			});

			expect(await settled(items)).toEqual([{ first: "first", narrower: ["selected"], third: "third" }]);

		});

		it("hands each gathered value the responses of its own requests, in request order", async () => {

			const [one, two] = entries;
			const items = details().slice(0, 1);

			const detail = vi.fn(async ({ entry }: { entry: Reference }) => ({ name: entry })) as Broker["detail"]; // ;(cast) test mock of a generic method

			await read(items, client(async () => []), { ...broker(), detail }, {
				encode: () => "select",
				owner: () => owner,
				decode: () => map(all([
					resource({ entry: two, shape: Category, model: {}, locale: [] }, resource => resource["name"]),
					map(all([
						collection({ entry: one, shape: Category, field, query: {}, locale: [] }, values => values),
						resource({ entry: one, shape: Category, model: {}, locale: [] }, resource => resource["name"])
					]), ([narrower, name]) => ({ narrower, name }))
				]), ([outer, inner]) => ({ outer, inner }))
			});

			expect(await settled(items)).toEqual([{ outer: two, inner: { narrower: ["selected"], name: one } }]);

		});

		it("runs every nested request at once", async () => {

			const [one, two] = entries;
			const items = details().slice(0, 1);
			const channel = broker();

			await read(items, client(async () => []), channel, {
				encode: () => "select",
				owner: () => owner,
				decode: () => map(all([
					resource({ entry: one, shape: Category, model: {}, locale: [] }, resource => resource),
					resource({ entry: two, shape: Category, model: {}, locale: [] }, resource => resource)
				]), ([first, second]) => ({ first, second }))
			});

			await settled(items);

			expect(vi.mocked(channel.detail).mock.calls.map(([{ entry }]) => entry)).toEqual([one, two]);

		});

		it("rejects a request whose nested request fails", async () => {

			const [one] = entries;
			const items = details().slice(0, 1);
			const failure = new Error("unfillable");

			await read(items, client(async () => []), {
				...broker(),
				select: vi.fn(async () => { throw failure; })
			}, {
				encode: () => "select",
				owner: () => owner,
				decode: () => collection({ entry: one, shape: Category, field, query: {}, locale: [] }, narrower => ({ narrower }))
			});

			await vi.waitFor(() => expect(items[0].reject).toHaveBeenCalledWith(failure));

		});

	});

});

describe("write", () => {

	it("applies the update and settles every request with its decoded value", async () => {

		const items = batch();
		const repository = client(async () => []);

		await write(items, repository, {
			encode: () => "update",
			decode: (_, { request: { entry } }) => entry === entries[0]
		});

		expect(repository.update).toHaveBeenCalledWith("update");
		expect(await settled(items)).toEqual([true, false]);

	});

	it("rejects every request of a failing update and settles normally", async () => {

		const items = batch();
		const failure = new Error("unavailable");

		const repository = {
			...client(async () => []),
			update: vi.fn(async () => { throw failure; })
		};

		await write(items, repository, {
			encode: () => "update",
			decode: vi.fn()
		});

		items.forEach(({ reject }) => expect(reject).toHaveBeenCalledWith(failure));

	});

});
