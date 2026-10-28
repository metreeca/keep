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
import type { Tag } from "@metreeca/core/language";
import { createScope } from "@metreeca/core/scope";
import { createQueryFlake } from "@metreeca/keep-flake";
import { Category } from "@metreeca/keep-suite/toys";
import type { Query, Slot } from "@metreeca/qest/model";
import type { Reference } from "@metreeca/qest/state";
import { type SPARQL, variable } from "@metreeca/wire-sparql";
import { describe, expect, it, vi } from "vitest";
import { encode, type Group } from "./encode.js";


describe("encode", () => {

	const field = property("narrower");

	const entries: readonly Reference[] = [
		"http://example.com/categories/0001",
		"http://example.com/categories/0002",
		"http://example.com/categories/0003"
	];


	function property(name: string): Property {

		const member = getShapeProperties(Category)[name];

		if ( member?.kind !== "property" ) {
			throw new Error(`undefined property <${name}>`);
		}

		return member;

	}

	function group(entries: readonly Reference[], query: Query<Slot> = {}, locale: readonly Tag[] = []): Group {
		return {
			field, query, locale,
			flake: createQueryFlake(field.range.shape, query),
			items: entries.map(entry => ({
				request: { entry, shape: Category, field, query, locale },
				resolve: vi.fn(),
				reject: vi.fn()
			}))
		};
	}

	function query(...groups: readonly Group[]): SPARQL {
		return encode(createScope(variable), groups);
	}

	function bindings(query: SPARQL): readonly string[] {
		return query.match(/values \(\?\d+\) \{[^}]*}/g) ?? [];
	}


	describe("with a single group", () => {

		it("binds every owner in one arm", async () => {

			const encoded = query(group(entries));

			expect(bindings(encoded)).toHaveLength(1);
			expect(encoded).not.toContain(" union ");

			entries.forEach(entry => expect(encoded).toContain(`(<${entry}>)`));

		});

		it("binds the owners of a sliced query in one arm", async () => {

			const encoded = query(group(entries, { "@": 1, "#": 1 }));

			expect(bindings(encoded)).toHaveLength(1);
			expect(encoded).not.toContain(" union ");

		});

		it("projects the owner next to the stamp and orders by it first", async () => {

			const encoded = query(group(entries));

			const stamp = encoded.match(/\(0 as (\?\d+)\)/)?.[1];
			const owner = encoded.match(/values \((\?\d+)\)/)?.[1];

			expect(encoded).toContain(`select distinct (0 as ${stamp}) ${owner} `);
			expect(encoded).toContain(`order by asc(${owner}) `);

		});

		it("groups aggregates by the owner", async () => {

			const encoded = query(group(entries, { "total=count:id": {} }));

			const owner = encoded.match(/values \((\?\d+)\)/)?.[1];

			expect(encoded).toContain(`group by ${owner}`);

		});

	});

	describe("with the window", () => {

		it("keeps the server window for a single owner", async () => {

			const encoded = query(group(entries.slice(0, 1), { "@": 1, "#": 2 }));

			expect(encoded).toContain("offset 1");
			expect(encoded).toContain("limit 2");

		});

		it("drops the server window for several owners", async () => {

			const encoded = query(group(entries, { "@": 1, "#": 2 }));

			expect(encoded).not.toContain("offset ");
			expect(encoded).not.toContain("limit ");

		});

	});

	describe("with several groups", () => {

		it("joins the groups under an outer query stamped and ordered by owner", async () => {

			const [first, second, third] = entries;

			const encoded = query(
				group([first, second]),
				group([third], { "#": 1 })
			);

			const [one, two] = bindings(encoded).map(binding => binding.match(/\?\d+/)?.[0]);
			const stamp = encoded.match(/\(0 as (\?\d+)\)/)?.[1];

			expect(bindings(encoded)).toHaveLength(2);
			expect(encoded).toContain(" union ");
			expect(one).not.toBe(two);

			const outer = encoded.slice(encoded.lastIndexOf("order by "));

			expect(outer).toContain(`order by asc(${stamp}) asc(${one}) `);
			expect(outer).toContain(`asc(${two}) `);

		});

	});

});
