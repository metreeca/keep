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
 * Model-driven storage API.
 *
 * Splits the storage surface across two interfaces: {@link StoreClient} carries the CRUD and data-loading methods
 * that read and write linked-data resources described as {@link Resource} states and {@link Template} retrieval
 * templates from the [@metreeca/qest](https://github.com/metreeca/qest) data-modelling library, validated against
 * {@link ResourceShape shapes} defined using the [@metreeca/blue](https://github.com/metreeca/blue) validation
 * library; {@link Store} extends it with management facilities (mutation events, transactional execution, lifecycle).
 * Connectors compose the two — typically via {@link createManagingStore} —
 * into a single store exposing both surfaces through one object.
 *
 * {@link StoreClient} implementations are expected to fully support the {@link Template | query language}
 * defined by [@metreeca/qest](https://github.com/metreeca/qest), including property selection, linked
 * resource expansion, filtering, ordering, and pagination.
 *
 * **CRUD Operations**
 *
 * The {@link StoreClient} interface supports conditional resource operations for standard CRUD workflows:
 *
 * - {@link StoreClient.lookup lookup} — Retrieve a resource matching a validated retrieval template
 * - {@link StoreClient.create create} — Create a resource from a validated state
 * - {@link StoreClient.update update} — Replace a resource state with a validated state
 * - {@link StoreClient.delete delete} — Delete a resource identified by a validated entry
 *
 * **Data Loading**
 *
 * For direct data loading, the following unconditional operations bypass existence checks:
 *
 * - {@link StoreClient.insert insert} — Unconditionally upsert a resource from a validated state
 * - {@link StoreClient.remove remove} — Unconditionally remove a resource identified by a validated entry
 *
 * **Transactions**
 *
 * {@link Store.execute execute} groups multiple operations into an atomic unit of work; see
 * {@link Store} for isolation semantics.
 *
 * **Mutation Events**
 *
 * {@link Store.observe observe} registers a {@link StoreObserver} for resource mutations, optionally filtered
 * by resource identifiers and their descendants.
 *
 * **Lifecycle**
 *
 * Every store exposes a {@link Store.close close} method that releases underlying resources
 * (database connections, file handles, observer subscriptions). Implementations with no resources to release
 * MAY return a resolved no-op.
 *
 * **Shape Validation**
 *
 * Resource data is automatically {@link validate | validated} against the supplied shape:
 *
 * - `model` is validated for {@link StoreClient.lookup lookup}
 * - `state` is validated for {@link StoreClient.create create}, {@link StoreClient.update update},
 * and {@link StoreClient.insert insert}
 *
 * Validation failures surface as a {@link TraceError} carrying the collected failure trace.
 *
 * **Error Channel**
 *
 * Every {@link StoreClient} method returns a `Promise<…>`; **all** errors are delivered as promise
 * rejections, regardless of origin:
 *
 * - `RangeError` — malformed `entry` (not an absolute IRI, contains `?` or `#`) or a `state` carrying an `id`
 * differing from `entry`
 * - {@link TraceError} — `model` or `state` fails {@link validate} against the shape
 * - {@link Problem} — network, storage, or other processing failures
 *
 * Callers should `await` and `try`/`catch` (or chain `.catch`) at the call site; the rejection
 * type discriminates logic errors from process errors.
 *
 * **Retrieving Resources**
 *
 * ```typescript
 * // single resource retrieval with explicit template
 *
 * const product = await store.lookup({
 *   entry: "http://example.com/products/1",
 *   shape: ProductShape,
 *   model: {
 *     name: "",
 *     price: 0,
 *     vendor: { id: "", name: "" }
 *   }
 * });
 *
 * // retrieval using the shape's own model as template
 *
 * const full = await store.lookup({
 *   entry: "http://example.com/products/1",
 *   shape: ProductShape,
 *   model: model(ProductShape)
 * });
 *
 * // collection retrieval with filtering, ordering, and pagination
 *
 * const catalog = await store.lookup({
 *   entry: "http://example.com/products/",
 *   shape: ProductShape,
 *   model: {
 *     products: [{
 *       id: "",
 *       name: "",
 *       price: 0,
 *       ">=price": 50,        // price ≥ 50
 *       "~name": "widget",    // name contains "widget"
 *       "^price": 1,          // sort by price ascending
 *       "@": 0,               // offset
 *       "#": 25               // limit
 *     }]
 *   }
 * });
 * ```
 *
 * **Creating and Updating Resources**
 *
 * ```typescript
 * await store.create({ entry: "http://example.com/products/42", shape: ProductShape, state: {
 *   id: "http://example.com/products/42",
 *   name: "Widget",
 *   price: 29.99,
 *   vendor: "http://example.com/vendors/acme"
 * } });
 *
 * await store.update({ entry: "http://example.com/products/42", shape: ProductShape, state: {
 *   id: "http://example.com/products/42",
 *   name: "Widget",
 *   price: 39.99,
 *   vendor: "http://example.com/vendors/acme"
 * } });
 * ```
 *
 * **Deleting Resources**
 *
 * ```typescript
 * await store.delete({ entry: "http://example.com/products/42", shape: ProductShape });
 * ```
 *
 * **Loading Data**
 *
 * ```typescript
 * // unconditionally upsert (create or replace)
 * await store.insert({ entry: "http://example.com/products/42", shape: ProductShape, state: {
 *   id: "http://example.com/products/42",
 *   name: "Widget",
 *   price: 39.99,
 *   vendor: "http://example.com/vendors/acme"
 * } });
 *
 * // unconditionally remove (silently succeeds if absent)
 * await store.remove({ entry: "http://example.com/products/42", shape: ProductShape });
 * ```
 *
 * **Observing Mutations**
 *
 * ```typescript
 * const unsubscribe = store.observe(mutations => {
 *   for (const [id, exists] of Object.entries(mutations)) {
 *     console.log(exists ? "upserted" : "removed", id);
 *   }
 * }, "http://example.com/products/");
 *
 * unsubscribe(); // stop receiving events
 * ```
 *
 * **Executing Transactions**
 *
 * ```typescript
 * await store.execute(async store => {
 *   await store.create({ entry: product.id, shape: ProductShape, state: product });
 *   await store.update({ entry: inventory.id, shape: InventoryShape, state: inventory });
 * });
 * ```
 *
 * > [!NOTE]
 * > The [Transaction Design](./index.md) companion document covers the design rationale for transaction semantics,
 * > including cross-backend isolation levels and concurrency models.
 *
 * @document ./index.md
 *
 * @group Components
 *
 * @module index
 */

import type { validate } from "@metreeca/blue";
import type { ResourceShape } from "@metreeca/blue/resource";
import type { Lazy } from "@metreeca/core";
import type { Tag } from "@metreeca/core/language";
import type { TraceError } from "@metreeca/core/trace";
import type { Problem } from "@metreeca/http/success";
import { type Reference, Resource } from "@metreeca/qest/resource";
import { Instance, Template } from "@metreeca/qest/template";

import type { createManagingStore } from "./stores/managing.js";


/**
 * Model-driven resource store.
 *
 * Extends {@link StoreClient} with management facilities — mutation events, transactional execution, and lifecycle —
 * to form the store surface produced by factories like
 * {@link createManagingStore}. The data surface is factored into a standalone
 * {@link StoreClient} so it can be implemented and passed around on its own (for example, the inner client handed to
 * {@link Store.execute execute} carries no `execute` of its own), while consumers of a store reach both
 * surfaces through the same object.
 *
 * Data methods on a store — {@link StoreClient.lookup lookup}, {@link StoreClient.create create},
 * {@link StoreClient.update update}, {@link StoreClient.delete delete}, {@link StoreClient.insert insert}, and
 * {@link StoreClient.remove remove} — are individually atomic even when executed outside
 * {@link Store.execute execute}, regardless of the number of server round-trips they may internally require.
 *
 * > [!IMPORTANT]
 * > Implementations provide best-effort transaction isolation, targeting snapshot isolation where the backend
 * > supports it and degrading gracefully to the maximum level achievable by the underlying storage, down to no
 * > isolation at all. Each implementation **must** document its supported isolation level. Implementations not
 * > supporting atomic updates natively **must** emulate them by buffering and deferring mutations until commit time.
 *
 * > [!IMPORTANT]
 * > Implementations provide best-effort mutation event signalling, targeting notification for all mutations on the
 * > backing storage layer and degrading gracefully to signalling only events generated by calls to the mutation
 * > methods on the store. Each implementation **must** document its supported event scope.
 */
export interface Store extends StoreClient {

	/**
	 * Observe mutation events.
	 *
	 * Each call mints an independent registration; multiple registrations of the same observer coexist and
	 * fire independently — the observer is invoked once per matching registration per mutation batch. The
	 * returned handle detaches **only** that registration; calling it more than once is a no-op and other
	 * registrations of the same observer are unaffected. Detachment is the only supported way to stop
	 * receiving events — repeated `observe` calls do not replace any prior registration.
	 *
	 * `resources` is the filter for the registration:
	 *
	 * - `undefined` (omitted) — no filter; the observer fires for every mutation
	 * - a single {@link Reference} — fires for mutations to that resource and its
	 *   {@link @metreeca/core!isNestedIRI | descendants}
	 * - an array of references — fires for mutations matching any element and its descendants
	 * - an empty array — ignored; no registration is created and the returned handle is a no-op
	 *
	 * > [!NOTE]
	 * > The observer receives only resource identifiers and an existence flag — not the mutated state.
	 * > This keeps event payloads small even when many resources are mutated within a single transaction,
	 * > and lets each observer fetch whatever data envelope it needs via {@link StoreClient.lookup lookup}.
	 *
	 * @param observer - Mutation observer invoked with each batch of matching mutations
	 * @param resources - Filter (single reference, array of references, or omitted for no filter)
	 *
	 * @returns A function that detaches **this** registration
	 *
	 * @throws `Error` if the store has been {@link Store.close closed}
	 */
	observe(observer: StoreObserver, resources?: Reference | readonly Reference[]): () => void;

	/**
	 * Execute a task within a store transaction.
	 *
	 * All operations performed during the task are executed atomically. If the task completes successfully, all
	 * mutations are committed and {@link Store.observe registered observers} receive a single mutation event
	 * containing all affected resources. If the task throws or rejects — including logic errors (`RangeError`,
	 * {@link TraceError}) raised by inner {@link StoreClient} calls — no mutations are executed, no events are
	 * notified, and the error is propagated to the caller as a promise rejection.
	 *
	 * The task is handled its own {@link StoreClient} for the transaction. Operations performed through it belong to
	 * the transaction and commit together, kept separate from any other `execute` running at the same time.
	 *
	 * > [!WARNING]
	 * > `execute` is not re-entrant: transaction boundaries are flat, so a task cannot open a nested transaction
	 * > and compositions must share a single outer call site.
	 *
	 * > [!WARNING]
	 * > The task MUST NOT retain or use the {@link StoreClient} it receives after `execute` settles: implementations
	 * > may back it with transaction-scoped state (buffered mutations, a bound backend scope) that is flushed or
	 * > discarded on completion, so any later call has undefined behaviour.
	 *
	 * > [!WARNING]
	 * > **Atomicity is mandatory; isolation is best-effort.** The task's mutations and their events always commit
	 * > all-or-nothing. `SNAPSHOT` is the suggested read-isolation level; each implementation declares the level it
	 * > actually provides. An implementation with neither native transactions nor `SNAPSHOT` isolation MUST buffer
	 * > the mutations and events, commit them as one batch on success, and drop the buffer on failure (a synchronous
	 * > throw or a rejected promise).
	 *
	 * @typeParam V - Return type of the task
	 *
	 * @param task - Async or sync function performing store operations within the transaction
	 *
	 * @returns A promise resolving to the value returned by `task`; rejects with any error raised or
	 * propagated by `task`, including a `RangeError`/{@link TraceError} from inner Store validation or a
	 * {@link Problem} from a transactional, network, storage, or other processing failure
	 *
	 * @throws `Error` if the store has been {@link Store.close closed}
	 */
	execute<V>(task: (store: StoreClient) => V | Promise<V>): Promise<V>;

	/**
	 * Release resources held by this store.
	 *
	 * Frees underlying resources such as database connections or file handles. Calling `close` on an
	 * already-closed store has no effect; implementations with no resources to release MAY return a
	 * resolved no-op.
	 *
	 * @returns A promise resolving when all resources have been released; rejects with a {@link Problem} if a
	 * clean-up error occurs
	 */
	close(): Promise<void>;

}

/**
 * Model-driven resource CRUD operations.
 *
 * Persists and retrieves linked data resources as shape-validated states and query projections.
 */
export interface StoreClient {

	/**
	 * Retrieve a resource.
	 *
	 * The result is shaped by the `model` {@link Template}: plain identifier properties are resolved from the
	 * shape's {@link Instance}\<T\> type, while computed bindings are derived from the template value.
	 *
	 * > [!NOTE]
	 * > `shape` and `model` are kept distinct so that a single `shape` can serve many retrieval templates —
	 * > for example, a server wiring one `shape` at startup and accepting any admissible `model` decoded
	 * > from the client request on each call. Callers wanting a template addressing every slot the shape
	 * > declares MUST author it explicitly.
	 *
	 * > [!CAUTION]
	 * > By default, `model` templates support the full query language, including aggregate transforms and nested
	 * > expansion. When exposing retrieval to untrusted clients, restrict query complexity as required by setting
	 * > `plain` to `true`, `depth` to `0` or a positive value, and/or `limit` to a maximum result set size.
	 *
	 * @typeParam T - The retrieval template type
	 *
	 * @param request - Retrieval specifications
	 * @param request.entry - Absolute identifier of the resource to be retrieved
	 * @param request.shape - Resource shape driving the operation
	 * @param request.model - Retrieval template defining the data envelope
	 * @param opts - Optional retrieval options
	 * @param opts.locale - {@link Tag} priority list driving language negotiation for localised content; entries are
	 * matched in order of preference against the language tags available for each localised value. Implementations
	 * default this to `["und"]` when omitted
	 * @param opts.plain - When `true`, rejects `model` templates carrying aggregate transforms (`count`, `sum`, `min`,
	 * `max`, `avg`); defaults to `false`, admitting the full query language
	 * @param opts.depth - Maximum depth admitted for nested `model` expansion and query probe paths, each nesting
	 * level or path segment counting against the budget; `0` rejects any nested template while still accepting IRI
	 * references; omission leaves expansion unbounded
	 * @param opts.limit - Maximum value admitted for the `#` pagination constraint in `model` selections; a positive
	 * value caps the result set, rejecting any `#` exceeding it or set to `0` (unbounded) and injecting itself as a
	 * default where `#` is absent; omission, like `0`, leaves result sets unbounded
	 *
	 * @returns A promise resolving to an immutable copy of the resource data matching the specified model,
	 * or to `undefined` if the resource is not present in the store; rejects with a `RangeError` if `entry`
	 * is not an absolute IRI, a {@link TraceError} if `model` doesn't {@link validate} against the shape,
	 * or a {@link Problem} on network, storage, or other processing errors
	 *
	 * @throws `Error` if the store has been {@link Store.close closed}
	 */
	lookup<T extends Template>(request: {

		readonly entry: Reference;
		readonly shape: Lazy<ResourceShape>;
		readonly model: T;

	}, opts?: {

		locale?: readonly Tag[]

		plain?: boolean
		depth?: number
		limit?: number

	}): Promise<undefined | Instance<T>>;


	/**
	 * Create a resource.
	 *
	 * Stores the resource's own data if the resource doesn't already exist. Specific reference kinds are handled
	 * as follows:
	 *
	 * - {@link ResourceShape | embedded references} — cascades recursively with the same semantics
	 * - {@link @metreeca/blue/resource!PropertyConstraints.captive | captive references} — accepted only as bare
	 * IRI references; inline captive batches are rejected, as `state` is always validated at depth `0`. Use
	 * {@link StoreClient.insert insert} to embed a captive tree in a single batch
	 * - {@link @metreeca/blue/resource!PropertyConstraints.foreign | foreign references} — skipped, as their
	 * data is owned by the defining resource
	 *
	 * @param request - Creation specifications
	 * @param request.entry - Absolute identifier of the target resource
	 * @param request.shape - Resource shape driving the operation
	 * @param request.state - Initial property values for the new resource
	 *
	 * @returns A promise resolving to the `entry` {@link Reference} of the created resource, or to `undefined`
	 * if the resource already exists; rejects with a `RangeError` if `entry` is not an absolute IRI or if
	 * `state` carries an `id` differing from `entry`, a {@link TraceError} if `state` doesn't {@link validate}
	 * against the shape, or a {@link Problem} on network, storage, or other processing errors
	 *
	 * @throws `Error` if the store has been {@link Store.close closed}
	 *
	 * @see {@link StoreClient.insert insert} for unconditional insertion
	 */
	create(request: {

		readonly entry: Reference;
		readonly shape: Lazy<ResourceShape>;
		readonly state: Resource

	}): Promise<undefined | Reference>;

	/**
	 * Update a resource.
	 *
	 * Replaces the resource's own data if the resource already exists, fully removing any previously existing
	 * embedded data. Specific reference kinds are handled as follows:
	 *
	 * - {@link ResourceShape | embedded references} — cascades recursively with the same semantics
	 * - {@link @metreeca/blue/resource!PropertyConstraints.captive | captive references} — accepted only as bare
	 * IRI references; inline captive batches are rejected, as `state` is always validated at depth `0`. Use
	 * {@link StoreClient.insert insert} to embed a captive tree in a single batch
	 * - {@link @metreeca/blue/resource!PropertyConstraints.foreign | foreign references} — skipped, as their
	 * data is owned by the defining resource
	 *
	 * @param request - Update specifications
	 * @param request.entry - Absolute identifier of the target resource
	 * @param request.shape - Resource shape driving the operation
	 * @param request.state - Complete replacement state for the resource
	 *
	 * @returns A promise resolving to the `entry` {@link Reference} of the updated resource, or to `undefined`
	 * if the resource doesn't exist; rejects with a `RangeError` if `entry` is not an absolute IRI or if
	 * `state` carries an `id` differing from `entry`, a {@link TraceError} if `state` doesn't {@link validate}
	 * against the shape, or a {@link Problem} on network, storage, or other processing errors
	 *
	 * @throws `Error` if the store has been {@link Store.close closed}
	 *
	 * @see {@link StoreClient.insert insert} for unconditional insertion
	 */
	update(request: {

		readonly entry: Reference;
		readonly shape: Lazy<ResourceShape>;
		readonly state: Resource

	}): Promise<undefined | Reference>;

	/**
	 * Delete a resource.
	 *
	 * Removes the resource's own data and clears references to it from other resources, if the resource exists.
	 * Specific reference kinds are handled as follows:
	 *
	 * - {@link ResourceShape | embedded references} — cascades recursively with the same semantics
	 * - {@link @metreeca/blue/resource!PropertyConstraints.captive | captive references} — cascade-deleted with
	 * the same semantics
	 *
	 * @param request - Deletion specifications
	 * @param request.entry - Absolute identifier of the target resource
	 * @param request.shape - Resource shape driving the operation
	 *
	 * @returns A promise resolving to the `entry` {@link Reference} of the deleted resource, or to `undefined`
	 * if the resource doesn't exist; rejects with a `RangeError` if `entry` is not an absolute IRI, or a
	 * {@link Problem} on network, storage, or other processing errors
	 *
	 * @throws `Error` if the store has been {@link Store.close closed}
	 *
	 * @see {@link StoreClient.remove remove} for unconditional removal
	 */
	delete(request: {

		readonly entry: Reference;
		readonly shape: Lazy<ResourceShape>;

	}): Promise<undefined | Reference>;


	/**
	 * Insert a resource.
	 *
	 * Unconditionally inserts or replaces the resource's own data, fully removing any previously existing embedded
	 * data. Specific reference kinds are handled as follows:
	 *
	 * - {@link ResourceShape | embedded references} — cascades recursively with the same semantics
	 * - {@link @metreeca/blue/resource!PropertyConstraints.captive | captive references} — accepted as bare IRI
	 * references or, up to `opts.depth` nesting levels, as inline batches creating or updating the captive tree
	 * - {@link @metreeca/blue/resource!PropertyConstraints.foreign | foreign references} — skipped, as their
	 * data is owned by the defining resource
	 *
	 * > [!CAUTION]
	 * > By default, resources accept captive reference expansion to unbounded depth. To enforce a strict insertion
	 * > process that admits only bare references, set `opts.depth` to `0` to reject all expansion; set it to a positive
	 * > value to cap the nesting depth admitted.
	 *
	 * @param request - Insertion specifications
	 * @param request.entry - Absolute identifier of the target resource
	 * @param request.shape - Resource shape driving the operation
	 * @param request.state - Complete resource state to be inserted
	 * @param opts - Optional insertion options
	 * @param opts.depth - Maximum nesting depth for expanding `captive` reference values as inline target resource
	 * states, each expansion level counting against the budget; `0` rejects all expansion, accepting bare IRI
	 * references only; omission leaves expansion unbounded
	 *
	 * @returns A promise resolving to the `entry` {@link Reference} of the inserted resource; rejects with a
	 * `RangeError` if `entry` is not an absolute IRI or if `state` carries an `id` differing from `entry`, a
	 * {@link TraceError} if `state` doesn't {@link validate} against the shape, or a {@link Problem} on
	 * network, storage, or other processing errors
	 *
	 * @throws `Error` if the store has been {@link Store.close closed}
	 *
	 * @see {@link StoreClient.create create} for conditional creation
	 * @see {@link StoreClient.update update} for conditional replacement
	 */
	insert(request: {

		readonly entry: Reference;
		readonly shape: Lazy<ResourceShape>;
		readonly state: Resource

	}, opts?: {

		readonly depth?: number

	}): Promise<Reference>;

	/**
	 * Remove a resource.
	 *
	 * Unconditionally removes the resource's own data and clears references to it from other resources. Specific
	 * reference kinds are handled as follows:
	 *
	 * - {@link ResourceShape | embedded references} — cascades recursively with the same semantics
	 * - {@link @metreeca/blue/resource!PropertyConstraints.captive | captive references} — cascade-removed with
	 * the same semantics
	 *
	 * @param request - Removal specifications
	 * @param request.entry - Absolute identifier of the target resource
	 * @param request.shape - Resource shape driving the operation
	 *
	 * @returns A promise resolving to the `entry` {@link Reference} of the removed resource; rejects with a
	 * `RangeError` if `entry` is not an absolute IRI, or a {@link Problem} on network, storage, or other
	 * processing errors
	 *
	 * @throws `Error` if the store has been {@link Store.close closed}
	 *
	 * @see {@link StoreClient.delete delete} for conditional removal
	 */
	remove(request: {

		readonly entry: Reference;
		readonly shape: Lazy<ResourceShape>;

	}): Promise<Reference>;

}

/**
 * Store mutation observer.
 *
 * Receives batched mutation events. Registered via {@link Store.observe}.
 */
export interface StoreObserver {

	/**
	 * Receive a batch of mutation events.
	 *
	 * Each entry maps a mutated resource id to an existence flag: `true` if the resource was
	 * {@link StoreClient.create created}, {@link StoreClient.update updated}, or {@link StoreClient.insert inserted};
	 * `false` if it was {@link StoreClient.delete deleted} or {@link StoreClient.remove removed}. When the same
	 * resource is mutated multiple times within a batch, last-write-wins semantics apply.
	 *
	 * > [!NOTE]
	 * > Observers may be sync or async. Both synchronous throws and asynchronous rejections are caught and
	 * > silently ignored so that one faulty observer cannot break delivery to others.
	 *
	 * @param mutations - Record mapping resource identifiers to existence flags
	 *     (`true` for upserted, `false` for removed)
	 */
	(mutations: { readonly [entry: Reference]: boolean }): void | Promise<void>;

}
