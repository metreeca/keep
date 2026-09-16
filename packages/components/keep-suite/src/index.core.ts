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

import { isFunction } from "@metreeca/core";
import type { Some } from "@metreeca/core/arrays";
import type { Store, StoreClient } from "@metreeca/keep";
import type { Reference, Resource } from "@metreeca/qest/resource";
import type { StoreTestOptions } from "./index.js";


/**
 * Test utilities extracted from {@link StoreTestOptions} and provided to test callbacks.
 *
 * Bundles the `contains`, `includes`, `excludes`, `generate`, and `populate` helpers that sub-suite tests use to verify
 * store outcomes, create isolated test resources, and seed the store with sample data.
 */
export type TestTools = Pick<StoreTestOptions, "contains" | "includes" | "excludes" | "generate" | "populate">;

/**
 * Subset of vitest's fixture surface consumed by the {@link TestFactory} wrapper.
 *
 * Vitest 4 destructures the first callback argument and resolves named fixtures, so `task` MUST appear as a
 * destructured property to avoid the fixture parser rejecting a non-destructured parameter. The wrapper only relies
 * on `type`, `fullTestName`, `name`, and `context.skip`, populated exclusively in test contexts.
 */
export type TestFixture = {
	readonly task?: {
		readonly type?: string;
		readonly name: string;
		readonly fullTestName?: string;
		readonly context?: { readonly skip?: () => void };
	};
};

/**
 * Wraps a test body with store lifecycle management, returning a Vitest-compatible callback.
 *
 * The default callable is shaped for `it`, accepting vitest's `{ task }` fixture and applying target/ignore
 * filters at the test level. A no-arg `hook` variant is exposed for `beforeAll`/`afterAll`/`beforeEach`/`afterEach`,
 * where vitest refuses fixture access.
 *
 * The test body receives the shared `store` plus `open`, the provisioning callback that mints a fresh store instance —
 * used by lifecycle tests (e.g. `close`) that need a dedicated store they can tear down without affecting the shared
 * one.
 *
 * @typeParam S - The store type under test, defaults to {@link StoreClient}
 */
export type TestFactory<S extends StoreClient = StoreClient> = (test: (context: {

	readonly store: S;
	readonly open: StoreTestOptions<S>["open"];

} & TestTools) => Promise<void>) => ((fixture?: TestFixture) => Promise<void>) & { readonly hook: () => Promise<void> };


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function lookup<T extends Resource>(
	items: readonly T[],
	pattern: Partial<T> | ((item: T) => boolean)
): undefined | T {

	return items.find(isFunction(pattern) ? pattern
		: item => Object.entries(pattern).every(([k, v]) => item[k] === v)
	);

}


/**
 * Registers a mutation observer that accumulates the emitted change batches.
 *
 * Centralises the observer-buffer boilerplate shared by the manage sub-suites: the returned `changes` array grows as
 * the store emits batches, and `unsubscribe` detaches the registration.
 *
 * @param store - The store to observe
 * @param resources - Optional resource filter forwarded to {@link Store.observe}
 *
 * @returns The growing batch array and the unsubscribe handle
 */
export function collect(
	store: Store,
	resources?: Some<Reference>
): { readonly changes: ReadonlyArray<Record<Reference, boolean>>; readonly unsubscribe: () => void } {

	const changes: Record<Reference, boolean>[] = [];

	const unsubscribe = store.observe(c => { changes.push(c); }, resources);

	return { changes, unsubscribe };

}
