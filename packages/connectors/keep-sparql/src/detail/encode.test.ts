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

import { createScope } from "@metreeca/core/scope";
import { createFlake } from "@metreeca/keep-flake";
import { Category } from "@metreeca/keep-suite/toys";
import type { Template } from "@metreeca/qest/model";
import type { Reference } from "@metreeca/qest/state";
import { type SPARQL, variable } from "@metreeca/wire-sparql";
import { describe, expect, it } from "vitest";
import { encode } from "./encode.js";


describe("encode", () => {

	/**
	 * Two scalar leaves (one scalar arm), two localised leaves (one arm each): three arms, five columns including
	 * the subject.
	 */
	const model: Template = { featured: {}, code: {}, label: {}, title: { en: {} } };

	const entries: readonly Reference[] = [
		"http://example.com/categories/0001",
		"http://example.com/categories/0002",
		"http://example.com/categories/0003"
	];


	function query(groups: readonly { readonly entries: readonly Reference[]; readonly model: Template }[]): SPARQL {
		return encode(createScope(variable), groups.map(({ entries, model }) =>
			({ entries, flake: createFlake(Category, model) })
		));
	}

	function arms(query: SPARQL): readonly string[] {
		return query.match(/values \(\?\d+\) \{[^}]*}/g) ?? [];
	}

	function columns(query: SPARQL): number {
		return new Set(query.match(/\?\d+/g)).size;
	}


	describe("with a single group", () => {

		it("opens every arm with the group's entries", async () => {

			const bindings = arms(query([{ entries, model }]));

			expect(bindings).toHaveLength(3);

			bindings.forEach(binding => entries.forEach(entry =>
				expect(binding).toContain(`(<${entry}>)`)
			));

		});

		it("keeps the arm count independent of the entry count", async () => {

			expect(arms(query([{ entries: entries.slice(0, 1), model }]))).toHaveLength(3);
			expect(arms(query([{ entries, model }]))).toHaveLength(3);

		});

		it("keeps the column count independent of the entry count", async () => {

			expect(columns(query([{ entries: entries.slice(0, 1), model }]))).toBe(5);
			expect(columns(query([{ entries, model }]))).toBe(5);

		});

	});

	describe("with several groups", () => {

		it("binds each group on a subject of its own", async () => {

			const [first, second] = entries;

			const bindings = arms(query([
				{ entries: [first], model },
				{ entries: [second], model }
			]));

			expect(bindings).toHaveLength(6);

			expect(bindings.filter(binding => binding.includes(`(<${first}>)`))).toHaveLength(3);
			expect(bindings.filter(binding => binding.includes(`(<${second}>)`))).toHaveLength(3);

			expect(new Set(bindings.map(binding => binding.match(/\?\d+/)?.[0]))).toHaveProperty("size", 2);

		});

		it("sums the columns of the groups", async () => {

			const [first, second] = entries;

			expect(columns(query([
				{ entries: [first], model },
				{ entries: [second], model }
			]))).toBe(10);

		});

	});

});
