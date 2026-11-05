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
import { createScope, type Scope } from "@metreeca/core/scope";
import { type Branch, createFlake, type Flake } from "@metreeca/keep-flake";
import { Category, toys, Vendor } from "@metreeca/keep-suite/toys";
import type { Deferred, Detail } from "@metreeca/keep/batching";
import type { Template } from "@metreeca/qest/model";
import type { Reference } from "@metreeca/qest/state";
import { named, tagged, typed } from "@metreeca/trio";
import { type Tuple, variable, type Variable } from "@metreeca/wire-sparql";
import { xsd } from "@metreeca/core/datatype";
import { describe, expect, it, vi } from "vitest";
import { decode } from "./decode.js";
import { column, schema } from "./schema.js";


describe("decode", () => {

	const entry: Reference = "http://example.com/categories/0001";
	const parent: Reference = "http://example.com/categories/0000";


	function at(flake: Flake, first: string, ...rest: readonly string[]): Branch {
		return rest.reduce<Branch>((node, step) => (node.entries ?? {})[step], (flake.entries ?? {})[first]);
	}

	function request(shape: Lazy<ResourceShape>, model: Template, locale: readonly string[] = ["en"]): Deferred<Detail> {
		return {
			request: { entry, shape, model, locale },
			resolve: vi.fn(),
			reject: vi.fn()
		};
	}

	/**
	 * Decodes `model` for the entry from `rows`, each row built from the plan by `cells`.
	 */
	function decoded(
		model: Template,
		cells: (scope: Scope<Variable>, flake: Flake) => readonly Tuple[],
		shape: Lazy<ResourceShape> = Category
	) {

		const scope = createScope(variable);
		const flake = createFlake(shape, model);

		return decode(scope, flake, schema(flake), request(shape, model), cells(scope, flake));

	}

	function value(scope: Scope<Variable>, flake: Flake, ...path: readonly [string, ...string[]]): Variable {
		return column(scope, (schema(flake).get(at(flake, ...path)) ?? [])[0]);
	}


	it("decodes the markers from the entry and the shape", async () => {

		const { details, selects, build } = decoded({ id: {}, type: {} }, () => []);

		expect(build([], [])).toEqual({ id: entry, type: toys.Category });
		expect(details).toEqual([]);
		expect(selects).toEqual([]);

	});

	it("decodes a scalar property from its column", async () => {

		const { build } = decoded({ code: {}, featured: {} }, (scope, flake) => [{
			[scope.resolve(flake)]: named(entry),
			[value(scope, flake, "code")]: typed("0001"),
			[value(scope, flake, "featured")]: typed("true", xsd.boolean)
		}]);

		expect(build([], [])).toEqual({ code: "0001", featured: true });

	});

	it("omits a property none of whose columns bound", async () => {

		const { build } = decoded({ code: {} }, (scope, flake) => [{
			[scope.resolve(flake)]: named(entry)
		}]);

		expect(build([], [])).toEqual({});

	});

	it("coalesces a localised property to the label the locale picks", async () => {

		const { build } = decoded({ title: {} }, (scope, flake) => [
			{ [scope.resolve(flake)]: named(entry), [value(scope, flake, "title")]: tagged("Titolo", "it") },
			{ [scope.resolve(flake)]: named(entry), [value(scope, flake, "title")]: tagged("Title", "en") }
		]);

		expect(build([], [])).toEqual({ title: "Title" });

	});

	it("collects a localised property retrieved structurally into a dictionary", async () => {

		const { build } = decoded({ title: { "*": {} } }, (scope, flake) => [
			{ [scope.resolve(flake)]: named(entry), [value(scope, flake, "title")]: tagged("Titolo", "it") },
			{ [scope.resolve(flake)]: named(entry), [value(scope, flake, "title")]: tagged("Title", "en") }
		]);

		expect(build([], [])).toEqual({ title: { it: "Titolo", en: "Title" } });

	});

	it("decodes a union property off the column of the variant that bound", async () => {

		const { build } = decoded({ score: {} }, (scope, flake) => {

			const grade = (schema(flake).get(at(flake, "score")) ?? []).find(({ variant }) => variant.kind === "string");

			return grade === undefined ? [] : [{
				[scope.resolve(flake)]: named(entry),
				[column(scope, grade)]: typed("A")
			}];

		}, Vendor);

		expect(build([], [])).toEqual({ score: "A" });

	});

	it("decodes an expanded reference from the columns under it", async () => {

		const { build } = decoded({ broader: { code: {} } }, (scope, flake) => [{
			[scope.resolve(flake)]: named(entry),
			[value(scope, flake, "broader")]: named(parent),
			[value(scope, flake, "broader", "code")]: typed("0000")
		}]);

		expect(build([], [])).toEqual({ broader: { code: "0000" } });

	});

	it("reads a multi-valued property off the collection its select request materialises", async () => {

		const { details, selects, build } = decoded({ code: {}, narrower: { "#": 2 } }, (scope, flake) => [{
			[scope.resolve(flake)]: named(entry),
			[value(scope, flake, "code")]: typed("0001")
		}]);

		expect(details).toEqual([]);
		expect(selects).toHaveLength(1);
		expect(selects[0]).toMatchObject({ entry, query: { "#": 2 }, locale: ["en"] });

		expect(build([], [[parent]])).toEqual({ code: "0001", narrower: [parent] });

	});

	it("omits a multi-valued property whose collection resolves to no content", async () => {

		const { build } = decoded({ narrower: { "#": 2 } }, () => []);

		expect(build([], [[]])).toEqual({});

	});


});
