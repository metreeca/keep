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

import type { Identifier } from "@metreeca/core";
import { type Branch, createQueryFlake, type Flake, isConstrainedFlake, isDrainedFlake } from "@metreeca/keep-flake";
import { Product } from "@metreeca/keep-suite/toys";
import { describe, expect, it } from "vitest";


/**
 * The first branch reached by descending `steps` from a coordinate, throwing if any step is unreached.
 */
function at(node: Flake | Branch, ...steps: readonly Identifier[]): Branch {
	return steps.reduce<Branch>((current, step) => {
		const branches = (current.entries ?? {})[step];
		if ( branches === undefined || branches.length === 0 ) { throw new Error(`no branch at step <${step}>`); }
		return branches[0];
	}, node as Branch);
}


describe("retrieved", () => {

	it("surfaces a branch whose value is projected through a transform stage", async () => {

		// `year:launched` binds its projection alias on the launched branch's `year` transform stage, not on
		// the branch itself, so the branch surfaces a retrieved value only along its transform axis

		const flake = createQueryFlake(Product, { "y=year:launched": {} });

		expect(isDrainedFlake(at(flake, "launched"))).toBeTruthy();

	});

});

describe("constrains", () => {

	it("surfaces a branch constrained through a transform stage", async () => {

		// `>=year:launched` lands its bound on the launched branch's `year` transform stage, not on the
		// branch itself, so the branch carries a constraint only along its transform axis

		const flake = createQueryFlake(Product, { ">=year:launched": 2020 });

		expect(isConstrainedFlake(at(flake, "launched"))).toBeTruthy();

	});

});
