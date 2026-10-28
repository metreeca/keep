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
import { createScope, type Scope } from "@metreeca/core/scope";
import { createQueryFlake } from "@metreeca/keep-flake";
import { Category } from "@metreeca/keep-suite/toys";
import type { Broker } from "@metreeca/keep/batching";
import type { Query, Slot } from "@metreeca/qest/model";
import type { Reference } from "@metreeca/qest/state";
import { named, typed } from "@metreeca/trio";
import { type Tuple, variable, type Variable } from "@metreeca/wire-sparql";
import { describe, expect, it, vi } from "vitest";
import { decode } from "./decode.js";
import type { Group } from "./encode.js";


describe("decode", () => {

	const field = property("narrower");

	const owners: readonly Reference[] = [
		"http://example.com/categories/0001",
		"http://example.com/categories/0002"
	];

	const members: readonly Reference[] = [
		"http://example.com/categories/0010",
		"http://example.com/categories/0020",
		"http://example.com/categories/0030"
	];

	const broker: Broker = {
		detect: vi.fn(),
		detail: vi.fn(),
		select: vi.fn(),
		modify: vi.fn()
	};


	function property(name: string): Property {

		const member = getShapeProperties(Category)[name];

		if ( member?.kind !== "property" ) {
			throw new Error(`undefined property <${name}>`);
		}

		return member;

	}

	function group(entries: readonly Reference[], query: Query<Slot> = {}): Group {
		return {
			field, query, locale: [],
			flake: createQueryFlake(field.range.shape, query),
			items: entries.map(entry => ({
				request: { entry, shape: Category, field, query, locale: [] },
				resolve: vi.fn(),
				reject: vi.fn()
			}))
		};
	}

	/**
	 * One solution row of `group` at `index`: the stamp, the owner and the member.
	 */
	function row(scope: Scope<Variable>, groups: readonly Group[], index: number, owner: Reference, member: Reference): Tuple {
		return {
			[scope.resolve(groups)]: typed(String(index)),
			[scope.resolve(groups[index])]: named(owner),
			[scope.resolve(groups[index].flake)]: named(member)
		};
	}

	async function settled(group: Group, index: number): Promise<unknown> {

		const { resolve } = group.items[index];

		await vi.waitFor(() => expect(resolve).toHaveBeenCalled());

		return vi.mocked(resolve).mock.calls[0]?.[0];

	}


	it("hands each owner its own rows in row order", async () => {

		const scope = createScope(variable);

		const [one, two] = owners;
		const groups = [group(owners)];

		decode(scope, groups, broker, [
			row(scope, groups, 0, one, members[2]),
			row(scope, groups, 0, one, members[0]),
			row(scope, groups, 0, two, members[1])
		]);

		expect(await settled(groups[0], 0)).toEqual([members[2], members[0]]);
		expect(await settled(groups[0], 1)).toEqual([members[1]]);

	});

	it("settles an owner without rows with an empty collection", async () => {

		const scope = createScope(variable);

		const [one] = owners;
		const groups = [group(owners)];

		decode(scope, groups, broker, [
			row(scope, groups, 0, one, members[0])
		]);

		expect(await settled(groups[0], 1)).toEqual([]);

	});

	it("windows the rows of each owner of a sliced query", async () => {

		const scope = createScope(variable);

		const [one, two] = owners;
		const groups = [group(owners, { "@": 1, "#": 1 })];

		decode(scope, groups, broker, [
			row(scope, groups, 0, one, members[0]),
			row(scope, groups, 0, one, members[1]),
			row(scope, groups, 0, one, members[2]),
			row(scope, groups, 0, two, members[0])
		]);

		expect(await settled(groups[0], 0)).toEqual([members[1]]);
		expect(await settled(groups[0], 1)).toEqual([]);

	});

	it("keeps the rows of a single owner as the server windowed them", async () => {

		const scope = createScope(variable);

		const [one] = owners;
		const groups = [group([one], { "@": 1, "#": 1 })];

		decode(scope, groups, broker, [
			row(scope, groups, 0, one, members[1])
		]);

		expect(await settled(groups[0], 0)).toEqual([members[1]]);

	});

	it("tells the groups apart by their stamp", async () => {

		const scope = createScope(variable);

		const [one, two] = owners;
		const groups = [group([one]), group([two], { "#": 1 })];

		decode(scope, groups, broker, [
			row(scope, groups, 0, one, members[0]),
			row(scope, groups, 1, two, members[1])
		]);

		expect(await settled(groups[0], 0)).toEqual([members[0]]);
		expect(await settled(groups[1], 0)).toEqual([members[1]]);

	});

});
