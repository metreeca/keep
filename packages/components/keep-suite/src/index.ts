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

/**
 * Connector conformance test suite.
 *
 * Provides reusable test suites that backend connector packages run to verify their {@link Store}
 * implementations satisfy the contracts defined by `@metreeca/keep`.
 *
 * {@link testStore} covers resource retrieval, CRUD operations, unconditional insert/remove, transaction execution,
 * change notifications, and lifecycle management.
 *
 * Connectors call {@link testStore} with a {@link StoreTestOptions} object that provisions store instances and loads
 * them with the {@link toys | sample dataset}.
 *
 * ```typescript
 * import { testStore } from "@metreeca/keep-suite";
 * import { describe } from "vitest";
 *
 * describe("my-connector", () => testStore({
 *   open: () => createMyStore(),
 *   contains: (id) => myStoreExists(id),
 *   includes: (resource, shape) => myStoreIncludes(resource, shape),
 *   excludes: (resource, shape) => myStoreExcludes(resource, shape),
 *   populate: () => myStorePopulate(),
 *   generate: (resource, shape) => myStoreGenerate(resource, shape)
 * }));
 * ```
 *
 * @group Components
 *
 * @module index
 */

import type { ResourceShape } from "@metreeca/blue/resource";
import type { Instance } from "@metreeca/blue/value";
import type { Eager, Lazy } from "@metreeca/core";
import type { Store, StoreClient } from "@metreeca/keep";
import type { Reference, Resource } from "@metreeca/qest/state";
import type { Awaitable } from "@vitest/utils";
import { afterAll, beforeAll, describe } from "vitest";
import type { TestFactory, TestFixture } from "./index.core.js";
import { testManageClose } from "./manage/close.js";
import { testManageExecuteAtomicity, testManageExecuteIsolation } from "./manage/execute.js";
import { testManageObserve } from "./manage/observe.js";
import { testPersistCreate } from "./persist/create.js";
import { testPersistDelete } from "./persist/delete.js";
import { testPersistInsert } from "./persist/insert.js";
import { testPersistRemove } from "./persist/remove.js";
import { testPersistUpdate } from "./persist/update.js";
import { testRetrieveExpression } from "./retrieve/expression.js";
import { testRetrieveLocalised } from "./retrieve/localised.js";
import { testRetrieveProjection } from "./retrieve/projection.js";
import { testRetrieveQuery } from "./retrieve/query.js";
import { testRetrieveSelection } from "./retrieve/selection.js";
import { testRetrieveTemplate } from "./retrieve/template.js";


/**
 * A recursively optional view of a resource state.
 *
 * Widens a state type so a probe may fill in only the slots a check is concerned with, at any nesting depth: every
 * property becomes optional and read-only, arrays keep their arity and element structure, and primitives are carried
 * over unchanged. Accepted by {@link StoreTestOptions.includes | includes} and
 * {@link StoreTestOptions.excludes | excludes} to state a targeted subset of facts rather than a whole state.
 *
 * @typeParam T The state type to widen
 */
export type DeepPartial<T> =
	T extends undefined | null | boolean | number | string ? T
		: T extends readonly unknown[] ? { readonly [K in keyof T]: DeepPartial<T[K]> }
			: T extends object ? { readonly [K in keyof T]?: DeepPartial<T[K]> }
				: T;

/**
 * Fact probe accepted for a resource shape.
 *
 * A {@link DeepPartial} instance of the shape where the shape is concrete, so a probe spells out only the slots it
 * asserts and each slot is held to its declared type; any resource where the shape is left abstract, as a helper
 * probing a slot by name against whichever shape it is handed can state no more than that.
 *
 * @typeParam S The resource shape the probe conforms to
 */
export type Probe<S extends Lazy<ResourceShape>> =
	ResourceShape extends Eager<S> ? Resource : DeepPartial<Instance<S>> & Resource;

/**
 * Sub-suite or test selector pattern accepted by {@link StoreTestOptions.target | target} and
 * {@link StoreTestOptions.ignore | ignore}.
 *
 * The literal branches enumerate the well-known sub-suite tags so editors can offer autocomplete on the canonical
 * names. The `(string & {})` branch keeps the union open to arbitrary substrings — typically a `describe` block name
 * or an individual test name — without losing literal suggestions.
 */
export type StoreTestPatterns =

	| "Retrieve"
	| "RetrieveTemplate"
	| "RetrieveQuery"
	| "RetrieveSelection"
	| "RetrieveProjection"
	| "RetrieveExpression"
	| "RetrieveLocalised"

	| "Persist"
	| "PersistCreate"
	| "PersistUpdate"
	| "PersistDelete"
	| "PersistInsert"
	| "PersistRemove"

	| "Manage"
	| "ManageObserve"
	| "ManageExecute"
	| "ManageExecuteAtomicity"
	| "ManageExecuteIsolation"
	| "ManageClose"

	| (string & {});

/**
 * Sub-suite and test selection for a conformance run.
 *
 * Pairs an {@link StoreTestScope.target | target} and {@link StoreTestScope.ignore | ignore} list of
 * {@link StoreTestPatterns}, matched as substrings against test paths to narrow which sub-suites and tests execute.
 * Mixed into {@link StoreTestOptions}; with both omitted the full suite runs.
 */
export type StoreTestScope = {

	/**
	 * Execute only the sub-suites or tests whose path contains any of the given patterns.
	 *
	 * Patterns are matched as substrings against the full test path, formed by joining the well-known sub-suite tag
	 * (`PersistUpdate`, `RetrieveTemplate`, …) with the inner `describe`/`it` names using ` > ` as separator —
	 * e.g. `PersistUpdate > update > contract > should return the resource id for an existing resource`.
	 *
	 * Well-known sub-suite tags are listed inline as autocomplete hints; arbitrary patterns are accepted via the
	 * `(string & {})` branch and may target individual `describe` blocks or test names. When omitted (or empty), every
	 * sub-suite and test runs unless ignored.
	 */
	readonly target?: ReadonlyArray<StoreTestPatterns>;

	/**
	 * Ignore sub-suites or tests whose path contains any of the given patterns.
	 *
	 * Same matching semantics as {@link target}. An ignore match always wins: a path matched by both `target` and
	 * `ignore` is skipped.
	 */
	readonly ignore?: ReadonlyArray<StoreTestPatterns>;

}

/**
 * Options for running a store conformance suite.
 *
 * @typeParam S - The store type to test, defaults to {@link StoreClient}
 */
export interface StoreTestOptions<S extends StoreClient = StoreClient> extends StoreTestScope {

	/**
	 * Opens a store instance with the required schema but no sample data.
	 *
	 * Called once before all tests, paired with {@link StoreTestOptions.close | close} for teardown. Sample data is
	 * loaded separately via {@link StoreTestOptions.populate | populate}.
	 */
	readonly open: () => Awaitable<S>;

	/**
	 * Closes the store instance after all tests complete.
	 */
	readonly close?: () => Awaitable<void>;


	/**
	 * Checks whether the store contains a resource with the given identifier.
	 *
	 * Returns true if the resource has any stored data at all; false otherwise. Unlike
	 * {@link StoreTestOptions.includes | includes}, this performs an identity-only check without verifying specific
	 * property values.
	 *
	 * @param entry - The resource identifier to check
	 */
	readonly contains: (entry: Reference) => Awaitable<boolean>;

	/**
	 * Checks whether every fact described by a resource is present in the store.
	 *
	 * Returns `true` if every fact described by `resource` (scalar values, references, nested structures) is present;
	 * `false` otherwise. Used by mutation tests to verify persisted content without depending on
	 * {@link StoreClient.lookup}.
	 *
	 * Accepts partial resources: only the slots explicitly set on `resource` contribute facts — omitted slots produce
	 * no triples and are not checked. Full validated states behave as whole-state equality checks; narrower probes
	 * assert a targeted subset of facts.
	 *
	 * @typeParam S - The resource shape the probe and its facts conform to
	 *
	 * @param entry - A resource (possibly partial) whose specified facts must all be present
	 * @param shape - The resource shape describing the resource structure
	 */
	readonly includes: <S extends Lazy<ResourceShape>>(entry: Probe<S>, shape: S) => Awaitable<boolean>;

	/**
	 * Checks whether every fact described by a resource is absent from the store.
	 *
	 * Returns `true` if none of the facts described by `resource` (scalar values, references, nested structures) are
	 * present; `false` if any fact is still present. Mirror of {@link StoreTestOptions.includes | includes}: where
	 * `includes` asserts all-present,
	 * `excludes` asserts all-absent.
	 *
	 * Accepts partial resources under the same semantics as {@link StoreTestOptions.includes | includes}: only
	 * explicitly-set slots contribute facts. Passing a full state yields an always-false check (operations leave at
	 * least some facts behind); probes should narrow to the exact slots whose triples are expected to be gone.
	 *
	 * @typeParam S - The resource shape the probe and its facts conform to
	 *
	 * @param entry - A resource (typically partial) whose specified facts must all be absent
	 * @param shape - The resource shape describing the resource structure
	 */
	readonly excludes: <S extends Lazy<ResourceShape>>(entry: Probe<S>, shape: S) => Awaitable<boolean>;


	/**
	 * Populates the store with the {@link toys | sample dataset}.
	 *
	 * Must clear all existing data and perform a full reload: any resources created, updated, or deleted by previous
	 * tests must be removed so that only the original sample data is present.
	 *
	 * Called by individual sub-suites via `beforeAll` to populate or repopulate the store before their tests run.
	 */
	readonly populate: () => Awaitable<void>;

	/**
	 * Generates an isolated copy of a sample resource with a unique identifier and inserts it into the store.
	 *
	 * Used by mutation tests to create isolated resources that do not conflict with the sample dataset or other tests.
	 *
	 * @param sample - The sample resource to use as template, validated with `value` scope
	 * @param shape - The resource shape describing the resource structure
	 *
	 * @returns The inserted copy with a unique `id`
	 */
	readonly generate: <S extends Lazy<ResourceShape>>(sample: Instance<S> & Resource, shape: S) => Awaitable<Instance<S>>;

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Runs the store conformance suite.
 *
 * Registers sub-suites for resource retrieval, CRUD operations, unconditional insert/remove, change notifications, and
 * lifecycle management. Sub-suites and individual tests can be filtered with
 * {@link StoreTestOptions.target | target} and {@link StoreTestOptions.ignore | ignore}.
 *
 * @param options - The store provisioning and lifecycle callbacks
 */
export function testStore(options: StoreTestOptions<Store>): void {

	describe("store conformance", () => test(options, {

		testRetrieveTemplate,
		testRetrieveQuery,
		testRetrieveSelection,
		testRetrieveProjection,
		testRetrieveExpression,
		testRetrieveLocalised,

		testPersistCreate,
		testPersistUpdate,
		testPersistDelete,
		testPersistInsert,
		testPersistRemove,

		testManageExecuteAtomicity,
		testManageExecuteIsolation,
		testManageObserve,
		testManageClose

	}));

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates a test factory and registers all sub-suites with target/ignore filtering.
 *
 * Builds the store once via `beforeAll` and closes it via `afterAll`, then registers every sub-suite. Each test body
 * is wrapped so that, at runtime, the test path is matched against
 * {@link StoreTestOptions.target | target}/{@link StoreTestOptions.ignore | ignore} and skipped via
 * `ctx.skip()` when filtered out.
 *
 * Must be called inside a `describe` block so that `beforeAll`/`afterAll` hooks are registered in the correct scope.
 *
 * @param options - The store provisioning and lifecycle callbacks
 * @param suites - A named map of sub-suite registration functions
 */
function test<S extends StoreClient>(
	{ open, contains, includes, excludes, generate, populate, close, target, ignore }: StoreTestOptions<S>,
	suites: Record<string, (factory: TestFactory<S>) => void>
): void {

	let store: S;

	beforeAll(async () => {
		store = await open();
	});

	afterAll(async () => {
		await close?.();
	});

	Object.entries(suites).forEach(([k, v]) => {

		const tag = k.replace(/^test/, "");

		v(test => {

			const body = (): Promise<void> =>
				test({ store, open, contains, includes, excludes, generate, populate });

			const wrapper = async ({ task }: TestFixture = {}): Promise<void> => {

				// IntelliJ workaround — the bundled vitest reporter's `getOutcome` misclassifies the runtime
				// `ctx.skip()` below as FAILED: it treats only collection-time skips as skipped, so runtime skips
				// (`result.state === "skip"`) fall through to the FAILED branch. Re-apply after every JS-plugin
				// update by adding the missing branch to `getOutcome()` in:
				//
				//   <IDE config>/plugins/javascript-plugin/helpers/vitest-intellij/vitest-intellij-util.js
				//
				//   if (result.state === 'skip') return Tree.TestOutcome.SKIPPED;
				//
				// No exact upstream ticket; tracked under JetBrains YouTrack project WEB
				// (https://youtrack.jetbrains.com/issues/WEB).

				if ( task?.type === "test" && filtered(task, tag, target, ignore) ) {

					task.context?.skip?.();

				} else {

					await body();

				}

			};

			return Object.assign(wrapper, { hook: body });

		});

	});

}


/**
 * Decides whether the current test should be skipped based on target/ignore patterns.
 *
 * Patterns are substring-matched against the synthetic test path produced by {@link pathOf}; an `ignore` match
 * wins over `target`.
 */
function filtered(
	task: NonNullable<TestFixture["task"]>,
	tag: string,
	include: ReadonlyArray<string> | undefined,
	exclude: ReadonlyArray<string> | undefined
): boolean {

	const path = pathOf(task, tag);

	const isExcluded = exclude?.some(p => path.includes(p)) ?? false;
	const isIncluded = !include?.length || include.some(p => path.includes(p));

	return isExcluded || !isIncluded;

}


/**
 * Constructs the synthetic match path for a test task, prepending the well-known sub-suite tag.
 *
 * The vitest `fullTestName` encodes the full `describe`/`it` chain (excluding the file path); the outer
 * `store conformance > ` wrapper is stripped so user patterns can target either the sub-suite tag or any inner
 * describe/test segment.
 */
function pathOf(task: NonNullable<TestFixture["task"]>, tag: string): string {

	const root = "store conformance > ";
	const full = task.fullTestName ?? task.name;
	const start = full.indexOf(root);
	const inner = start >= 0 ? full.slice(start+root.length) : full;

	return inner ? `${tag} > ${inner}` : tag;

}
