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

import { getShapeProperties, type Property, type ResourceShape } from "@metreeca/blue/resource";
import { error, type Lazy } from "@metreeca/core";
import { Category, Product } from "@metreeca/keep-suite/toys";
import type { Broker, Deferred, Select } from "@metreeca/keep/batching";
import type { Query, Slot } from "@metreeca/qest/model";
import type { Reference } from "@metreeca/qest/state";
import { xsd } from "@metreeca/core/datatype";
import { named, typed } from "@metreeca/trio";
import type { RepositoryClient, SPARQL } from "@metreeca/wire-sparql";
import { data, insert, pattern, update } from "@metreeca/wire-sparql/builder";
import { createOxiRepository } from "@metreeca/wire-sparql-oxigraph";
import { describe, expect, it, type Mock, vi } from "vitest";
import { select } from "./index.js";


describe("select", () => {

	const field = property("narrower");

	const broker: Broker = {
		detect: vi.fn(),
		detail: vi.fn(),
		select: vi.fn(),
		modify: vi.fn()
	};


	function property(name: string, shape: Lazy<ResourceShape> = Category): Property {

		const member = getShapeProperties(shape)[name];

		if ( member?.kind !== "property" ) {
			throw new Error(`undefined property <${name}>`);
		}

		return member;

	}

	function entries(count: number): readonly Reference[] {
		return Array.from({ length: count }, (_, index) => `http://example.com/categories/${index}`);
	}

	function request(entry: Reference, query: Query<Slot>): Deferred<Select> {
		return {
			request: { entry, shape: Category, field, query, locale: [] },
			resolve: vi.fn(),
			reject: vi.fn()
		};
	}

	function client(): RepositoryClient & { readonly select: Mock<(query: SPARQL) => Promise<readonly []>> } {
		return {
			ask: vi.fn(),
			select: vi.fn(async () => []),
			construct: vi.fn(),
			update: vi.fn(),
			merge: vi.fn(),
			store: vi.fn()
		};
	}

	/**
	 * The owners one query binds, read off its first `values` block.
	 */
	function bound(query: SPARQL): number {
		return query.match(/values \(\?\d+\) \{[^}]*}/)?.[0].match(/<[^>]+>/g)?.length ?? 0;
	}


	it("binds every owner of the batch in one query", async () => {

		const repository = client();

		await select(entries(3).map(entry => request(entry, {})), repository, broker);

		expect(repository.select.mock.calls.map(([query]) => bound(query))).toEqual([3]);

	});

	it("settles every request of the batch", async () => {

		const batch = entries(3).map(entry => request(entry, {}));

		await select(batch, client(), broker);

		await vi.waitFor(() => batch.forEach(({ resolve }) => expect(resolve).toHaveBeenCalled()));

	});


	describe("with a window over several owners", () => {

		// the window is applied by the server for every owner: a query over several owners returns exactly the
		// rows within each owner's window, so the decoder never pages through the pooled rows of every owner

		const documents = property("documents", Product);

		const owners: readonly Reference[] = [
			"http://example.com/products/0001",
			"http://example.com/products/0002"
		];

		const values: readonly string[] = [
			"http://example.com/documents/a",
			"http://example.com/documents/b",
			"http://example.com/documents/c"
		];


		async function repository(): Promise<RepositoryClient & { readonly rows: number[] }> {

			const forward = documents.forward ?? error(new Error("undefined forward predicate"));
			const oxigraph = createOxiRepository();

			await oxigraph.update(update(insert(data(owners.flatMap(owner =>
				values.map(value => pattern([named(owner), named(forward), typed(value)]))
			)))));

			const rows: number[] = [];

			return {

				...oxigraph,

				rows,

				select: query => oxigraph.select(query).then(tuples => {
					rows.push(tuples.length);
					return tuples;
				})

			};

		}

		function windowed(entry: Reference, query: Query<Slot>): Deferred<Select> {
			return {
				request: { entry, shape: Product, field: documents, query, locale: [] },
				resolve: vi.fn(),
				reject: vi.fn()
			};
		}


		it("returns the windowed rows of every owner", async () => {

			const client = await repository();

			const batch = owners.map(owner => windowed(owner, { "^": 1, "@": 1, "#": 1 }));

			await select(batch, client, broker);

			expect(client.rows).toEqual([owners.length]);

			await vi.waitFor(() => batch.forEach(({ resolve }) =>
				expect(resolve).toHaveBeenCalledWith([values[1]])
			));

		});

		it("keeps the server window for a single owner", async () => {

			const client = await repository();

			const batch = [windowed(owners[0], { "^": 1, "#": 2 })];

			await select(batch, client, broker);

			expect(client.rows).toEqual([2]);

			await vi.waitFor(() => batch.forEach(({ resolve }) =>
				expect(resolve).toHaveBeenCalledWith([values[0], values[1]])
			));

		});

	});

	describe("with a sort key over several owners", () => {

		// every owner's arm projects the sort keys the outer ordering reads, so the members of each owner come
		// out in the order and within the window the query states, whatever other owners share the query

		const owners: readonly Reference[] = [
			"http://example.com/categories/a",
			"http://example.com/categories/b"
		];

		/**
		 * The children of each owner, by code, inserted in no sort order.
		 */
		const children: ReadonlyMap<Reference, readonly string[]> = new Map([
			[owners[0], ["0002", "0003", "0001"]],
			[owners[1], ["0005", "0004"]]
		]);


		function child(owner: Reference, code: string): Reference {
			return `${owner}/${code}`;
		}

		async function repository(): Promise<RepositoryClient> {

			const narrower = field.forward ?? error(new Error("undefined forward predicate"));
			const code = property("code").forward ?? error(new Error("undefined forward predicate"));
			const oxigraph = createOxiRepository();

			await oxigraph.update(update(insert(data([...children].flatMap(([owner, codes]) => codes.flatMap(value => [
				pattern([named(owner), named(narrower), named(child(owner, value))]),
				pattern([named(child(owner, value)), named(code), typed(value, xsd.string)])
			]))))));

			return oxigraph;

		}


		it("returns every owner's members in its own sort order and window", async () => {

			const client = await repository();

			const batch = owners.map(owner => request(owner, { "^code": -1, "#": 2 }));

			await select(batch, client, broker);

			await vi.waitFor(() => batch.forEach(({ request: { entry }, resolve }) =>
				expect(resolve).toHaveBeenCalledWith(
					[...(children.get(entry) ?? [])].sort().reverse().slice(0, 2).map(code => child(entry, code))
				)
			));

		});

	});

});
