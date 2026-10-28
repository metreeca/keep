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
import type { Lazy } from "@metreeca/core";
import { createScope } from "@metreeca/core/scope";
import { createFlake } from "@metreeca/keep-flake";
import { Category, Product, toys } from "@metreeca/keep-suite/toys";
import type { Resource } from "@metreeca/qest/state";
import { type SPARQL, variable } from "@metreeca/wire-sparql";
import { describe, expect, it, vi } from "vitest";
import { encode } from "./encode.js";


describe("encode", () => {

	describe("with a state", () => {

		const entry = "http://example.com/resources/0001";


		function update(shape: Lazy<ResourceShape>, state: Resource): SPARQL {
			return encode(createScope(variable), [{
				request: { entry, shape, state },
				flake: createFlake(shape),
				resolve: vi.fn(),
				reject: vi.fn()
			}]);
		}

		/**
		 * The `where` clause of the clearing operation, the first in the update.
		 */
		function retraction(update: SPARQL): string {

			const start = update.indexOf(" where {") + " where {".length;
			const end = update.indexOf("}; ", start);

			return update.slice(start, end < 0 ? update.length - 1 : end);

		}


		it("retracts each owned edge in an arm of its own", async () => {

			const matches = retraction(update(Category, { code: "0001", featured: true }));

			// the type edge plus the ten owned properties (`narrower` and `lower` are foreign)

			expect(matches).not.toContain("optional {");
			expect(matches.match(/ union /g)).toHaveLength(10);

		});

		it("reaches the edges of an embedded resource through the edge owning it", async () => {

			const matches = retraction(update(Product, { sku: "0001" }));

			expect(matches).not.toContain("optional {");

			expect(matches).toMatch(new RegExp(
				`\\{ <${entry}> <${toys.reviews}> (\\?\\d+) \\. \\1 <${toys.rating}> \\?\\d+ \\. \\}`
			));

		});

	});

});
