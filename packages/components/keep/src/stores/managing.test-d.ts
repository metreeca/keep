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
import type { Store } from "../index.js";
import { createManagingStore } from "./managing.js";


describe("createManagingStore", () => {

	test("takes the management options alone", () => {
		expectTypeOf<Parameters<typeof createManagingStore>["length"]>().toEqualTypeOf<1>();
	});

	test("requires an execute option", () => {
		expectTypeOf<{}>().not.toExtend<Parameters<typeof createManagingStore>[0]>();
		expectTypeOf<Pick<Store, "observe" | "close">>().not.toExtend<Parameters<typeof createManagingStore>[0]>();
	});

	test("accepts an execute option alone", () => {
		expectTypeOf<Pick<Store, "execute">>().toExtend<Parameters<typeof createManagingStore>[0]>();
	});

});
