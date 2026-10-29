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

import { Category } from "@metreeca/keep-suite/toys";
import type { Broker, Deferred, Detail } from "@metreeca/keep/batching";
import type { Template } from "@metreeca/qest/model";
import type { Reference } from "@metreeca/qest/state";
import type { RepositoryClient, SPARQL } from "@metreeca/wire-sparql";
import { describe, expect, it, type Mock, vi } from "vitest";
import { detail } from "./index.js";


describe("detail", () => {

	const model: Template = { featured: {}, code: {} };

	const broker: Broker = {
		detect: vi.fn(),
		detail: vi.fn(),
		select: vi.fn(async () => []),
		modify: vi.fn()
	};


	function entries(count: number): readonly Reference[] {
		return Array.from({ length: count }, (_, index) => `http://example.com/categories/${index}`);
	}

	function request(entry: Reference, model: Template): Deferred<Detail> {
		return {
			request: { entry, shape: Category, model, locale: [] },
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
	 * The entries one query binds, read off its first `values` block.
	 */
	function bound(query: SPARQL): number {
		return query.match(/values \(\?\d+\) \{[^}]*}/)?.[0].match(/<[^>]+>/g)?.length ?? 0;
	}


	it("binds every entry of the batch in one query", async () => {

		const repository = client();

		await detail(entries(3).map(entry => request(entry, model)), repository, broker);

		expect(repository.select.mock.calls.map(([query]) => bound(query))).toEqual([3]);

	});

	it("runs no query for a plan reading no single-valued property", async () => {

		const repository = client();

		const batch = entries(2).map(entry => request(entry, { id: {}, narrower: {} }));

		await detail(batch, repository, broker);

		expect(repository.select).not.toHaveBeenCalled();

		await vi.waitFor(() => batch.forEach(({ resolve }) => expect(resolve).toHaveBeenCalled()));

	});

	it("settles every request of the batch", async () => {

		const batch = entries(3).map(entry => request(entry, model));

		await detail(batch, client(), broker);

		await vi.waitFor(() => batch.forEach(({ resolve }) => expect(resolve).toHaveBeenCalled()));

	});

});
