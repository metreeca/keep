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

import { describe, expectTypeOf, test } from "vitest";
import type { Name } from "./_inference.js";


describe("Name", () => {

	describe("plain identifier passthrough", () => {

		test("plain identifier passes through", () => {
			expectTypeOf<Name<"name">>().toEqualTypeOf<"name">();
		});

	});

	describe("binding extraction", () => {

		test("path binding extracts the identifier portion", () => {
			expectTypeOf<Name<"vendorName=vendor.name">>().toEqualTypeOf<"vendorName">();
		});

		test("transform binding extracts the identifier portion", () => {
			expectTypeOf<Name<"releaseYear=year:releaseDate">>().toEqualTypeOf<"releaseYear">();
		});

		test("aggregate binding extracts the identifier portion", () => {
			expectTypeOf<Name<"count=count:">>().toEqualTypeOf<"count">();
		});

		test("multiple equals signs split at the first occurrence", () => {
			expectTypeOf<Name<"a=b=c">>().toEqualTypeOf<"a">();
		});

	});

	describe("selection key drop", () => {

		test("comparison-operator key drops to never", () => {
			expectTypeOf<Name<"<price">>().toEqualTypeOf<never>();
			expectTypeOf<Name<">price">>().toEqualTypeOf<never>();
			expectTypeOf<Name<"<=price">>().toEqualTypeOf<never>();
			expectTypeOf<Name<">=price">>().toEqualTypeOf<never>();
		});

		test("matching-operator key drops to never", () => {
			expectTypeOf<Name<"~label">>().toEqualTypeOf<never>();
			expectTypeOf<Name<"?category">>().toEqualTypeOf<never>();
			expectTypeOf<Name<"!tag">>().toEqualTypeOf<never>();
		});

		test("ordering-operator key drops to never", () => {
			expectTypeOf<Name<"+focus">>().toEqualTypeOf<never>();
			expectTypeOf<Name<"^sort">>().toEqualTypeOf<never>();
		});

		test("pagination keys drop to never", () => {
			expectTypeOf<Name<"@">>().toEqualTypeOf<never>();
			expectTypeOf<Name<"#">>().toEqualTypeOf<never>();
		});

	});

});
