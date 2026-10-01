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

import type { Store } from "@metreeca/keep";
import { describe, expect, it } from "vitest";
import type { TestFactory } from "../index.core.js";
import { base, Product } from "../toys.js";


// absolute IRI shared by the post-close probes; the resource need not exist, only the store must be closed
const closedEntry = `${base}products/AF001`;


/**
 * Store lifecycle conformance tests for {@link Store.close}.
 *
 * Asserts the strong contract: closing is idempotent, and a closed store rejects any further operation. A store with
 * no resources to release MAY implement `close` as a resolved no-op and stay usable afterwards; connectors doing so
 * opt out of this sub-suite by ignoring `"ManageClose"`. Each test closes a dedicated store minted through `open`,
 * leaving the shared store untouched.
 */
export function testManageClose(factory: TestFactory<Store>): void {

	describe("close", () => {

		it("should resolve when close is invoked", factory(async ({ open }) => {

			const store = await open();

			await expect(store.close()).resolves.toBeUndefined();

		}));

		it("should be idempotent on repeated close", factory(async ({ open }) => {

			const store = await open();

			await store.close();
			await expect(store.close()).resolves.toBeUndefined();

		}));

		([
			["detail", (s: Store) => s.lookup({ entry: closedEntry, shape: Product, model: { id: {} } })],
			["delete", (s: Store) => s.delete({ entry: closedEntry, shape: Product })],
			["execute", (s: Store) => s.execute(async () => undefined)],
			["observe", (s: Store) => s.observe(() => {})]
		] as const).forEach(([op, operate]) => {

			it(`should reject a ${op} once closed`, factory(async ({ open }) => {

				const store = await open();

				await store.close();

				// a real close releases the store's resources, so any subsequent operation — read, write,
				// transaction, or registration — MUST throw synchronously per the closed-store contract
				expect(() => operate(store)).toThrow(Error);

			}));

		});

	});

}
