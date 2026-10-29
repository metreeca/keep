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
import { createQueryFlake, getFlakeProjection } from "@metreeca/keep-flake";
import { Category, Vendor } from "@metreeca/keep-suite/toys";
import type { Query, Slot } from "@metreeca/qest/model";
import { variable } from "@metreeca/wire-sparql";
import { describe, expect, it } from "vitest";
import { column, schema } from "./schema.js";


describe("schema", () => {

	/**
	 * The forms of the columns of the cell projected under `alias`, in projection order.
	 */
	function forms(shape: Lazy<ResourceShape>, query: Query<Slot>, alias: string): readonly string[] {

		const flake = createQueryFlake(shape, query);
		const cell = getFlakeProjection(flake)[alias];

		return (schema(flake).get(cell) ?? []).map(({ form }) => form);

	}


	it("projects the member of a plain collection as one value column", async () => {

		const flake = createQueryFlake(Category, {});

		const columns = schema(flake).get(flake) ?? [];

		expect(columns.map(({ form, variant: { kind } }) => [form, kind])).toEqual([["value", "resource"]]);

	});

	it("projects a literal binding as one value column", async () => {
		expect(forms(Category, { "code=code": {} }, "code")).toEqual(["value"]);
	});

	it("projects a transform binding as one computed column", async () => {
		expect(forms(Category, { "total=count:": {} }, "total")).toEqual(["computed"]);
	});

	it("projects a localised binding as its label", async () => {
		expect(forms(Category, { "title=title": {} }, "title")).toEqual(["label"]);
	});

	it("projects a localised binding under a locale as its owner", async () => {
		expect(forms(Category, { "title=title": { "*": {} } }, "title")).toEqual(["owner"]);
	});

	it("projects a union binding as one column per requested variant", async () => {
		expect(forms(Vendor, { "score=score": {} }, "score")).toEqual(["value", "value"]);
		expect(forms(Vendor, { "address=address": { "0": {}, "1": { city: {} } } }, "address")).toEqual(["value", "value"]);
	});

	it("projects the text variant of a union binding by its own alternative", async () => {
		expect(forms(Vendor, { "origin=origin": { "0": { "*": {} } } }, "origin")).toEqual(["owner"]);
		expect(forms(Vendor, { "origin=origin": { "0": {}, "1": { latitude: {} } } }, "origin")).toEqual(["label", "value"]);
	});


	describe("column", () => {

		it("keys the shards of a union cell on the cell and the variant", async () => {

			const scope = createScope(variable);

			const flake = createQueryFlake(Vendor, { "score=score": {} });
			const cell = getFlakeProjection(flake)["score"];

			const variables = (schema(flake).get(cell) ?? []).map(candidate => column(scope, candidate));

			expect(new Set(variables).size).toBe(2);
			expect(variables).not.toContain(scope.resolve(cell));

		});

		it("keys any other column on the cell alone", async () => {

			const scope = createScope(variable);

			const flake = createQueryFlake(Category, { "code=code": {} });
			const cell = getFlakeProjection(flake)["code"];

			expect((schema(flake).get(cell) ?? []).map(candidate => column(scope, candidate))).toEqual([scope.resolve(cell)]);

		});

	});

});
