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
import { type Branch, createFlake, type Flake } from "@metreeca/keep-flake";
import { Category, Vendor } from "@metreeca/keep-suite/toys";
import type { Template } from "@metreeca/qest/model";
import { variable } from "@metreeca/wire-sparql";
import { describe, expect, it } from "vitest";
import { column, entries, schema } from "./schema.js";


describe("schema", () => {

	/**
	 * The branch of `flake` at `path`.
	 */
	function at(flake: Flake, first: string, ...rest: readonly string[]): Branch {
		return rest.reduce<Branch>((node, step) => (node.entries ?? {})[step], (flake.entries ?? {})[first]);
	}

	/**
	 * The forms of the columns of the branch at `path`, in plan order.
	 */
	function forms(shape: Lazy<ResourceShape>, model: Template, first: string, ...rest: readonly string[]): readonly string[] {

		const flake = createFlake(shape, model);

		return (schema(flake).get(at(flake, first, ...rest)) ?? []).map(({ form }) => form);

	}


	it("binds a scalar property to one value column", async () => {
		expect(forms(Category, { code: {} }, "code")).toEqual(["value"]);
	});

	it("binds a localised property to one tagged column", async () => {
		expect(forms(Category, { title: { en: {} } }, "title")).toEqual(["tagged"]);
	});

	it("binds the properties nested under an expanded reference", async () => {
		expect(forms(Category, { broader: { code: {} } }, "broader")).toEqual(["value"]);
		expect(forms(Category, { broader: { code: {} } }, "broader", "code")).toEqual(["value"]);
	});

	it("binds a union property to one column per requested variant", async () => {
		expect(forms(Vendor, { score: {} }, "score")).toEqual(["value", "value"]);
		expect(forms(Vendor, { address: { "0": {}, "1": { city: {} } } }, "address")).toEqual(["value", "value"]);
		expect(forms(Vendor, { origin: { "0": {}, "1": { latitude: {} } } }, "origin")).toEqual(["tagged", "value"]);
	});

	it("binds no column for markers and collections", async () => {
		expect(schema(createFlake(Category, { id: {}, type: {}, narrower: {} })).size).toBe(0);
	});


	describe("column", () => {

		it("keys the columns of a union property on the branch and the variant", async () => {

			const scope = createScope(variable);

			const flake = createFlake(Vendor, { score: {} });
			const branch = at(flake, "score");

			const variables = (schema(flake).get(branch) ?? []).map(candidate => column(scope, candidate));

			expect(new Set(variables).size).toBe(2);
			expect(variables).not.toContain(scope.resolve(branch));

		});

		it("keys any other column on the branch alone", async () => {

			const scope = createScope(variable);

			const flake = createFlake(Category, { code: {} });
			const branch = at(flake, "code");

			expect((schema(flake).get(branch) ?? []).map(candidate => column(scope, candidate))).toEqual([scope.resolve(branch)]);

		});

	});

	describe("entries", () => {

		it("descends into the branches of an expanded reference", async () => {

			const flake = createFlake(Category, { broader: { code: {} } });

			const [broader] = schema(flake).get(at(flake, "broader")) ?? [];

			expect(entries(broader).map(({ path }) => path)).toEqual([["broader", "code"]]);

		});

		it("descends into the branches a union variant declares", async () => {

			const flake = createFlake(Vendor, { address: { "0": { city: {} } } });

			const columns = schema(flake).get(at(flake, "address")) ?? [];

			expect(columns.flatMap(candidate => entries(candidate).map(({ path }) => path.join("."))))
				.toEqual(["address.city"]);

		});

		it("descends nowhere under a localised variant", async () => {

			const flake = createFlake(Category, { title: {} });

			const [title] = schema(flake).get(at(flake, "title")) ?? [];

			expect(entries(title)).toEqual([]);

		});

	});

});
