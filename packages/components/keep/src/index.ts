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
 * Core model-driven storage API.
 *
 * Persists and retrieves linked data resources independently of the backend holding them. Resources are described by
 * {@link ResourceShape shapes} defined with the [@metreeca/blue](https://github.com/metreeca/blue) validation library.
 * They are read and written as {@link Resource} states, {@link Template} retrieval templates and {@link Projection}
 * queries, following the data and query models of the [@metreeca/qest](https://github.com/metreeca/qest)
 * data-modelling library.
 *
 * A {@link StoreClient} defines the data operations a connector implements against its backend. A {@link Store} adds
 * mutation events, transactional execution and lifecycle management, and exposes both surfaces through one object.
 * Connectors typically obtain the management surface from {@link createManagingStore}.
 *
 * {@link StoreClient} implementations are expected to fully support the {@link Template | query language}
 * defined by [@metreeca/qest](https://github.com/metreeca/qest), including property selection, linked
 * resource expansion, filtering, ordering, and pagination.
 *
 * **CRUD Operations**
 *
 * The {@link StoreClient} interface supports conditional resource operations for standard CRUD workflows:
 *
 * - {@link StoreClient.lookup lookup} — Retrieve a resource, narrowed to a validated retrieval template
 * - {@link StoreClient.create create} — Add a resource from a validated state to a collection held by another resource
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
 * {@link Store.close close} releases the resources held by a store, such as database connections, file handles and
 * observer subscriptions.
 *
 * **Shape Validation**
 *
 * Request data is {@link validate | validated} against the supplied shape before it reaches the backend:
 *
 * - `model` is validated for {@link StoreClient.lookup lookup} and {@link StoreClient.create create}
 * - `state` is validated for {@link StoreClient.update update} and {@link StoreClient.insert insert} against the
 *   supplied shape, and for {@link StoreClient.create create} against the shape of the collected resources
 *
 * Validation failures surface as a {@link TraceError} carrying the collected failure trace.
 *
 * **Error Channel**
 *
 * Every {@link StoreClient} method returns a `Promise<…>`; **all** errors are delivered as promise
 * rejections, regardless of origin:
 *
 * - {@link !RangeError RangeError} — malformed `entry` (not an absolute IRI, contains `?` or `#`), a `state` whose
 * `id` conflicts with `entry` (not nested under it on creation, differing from it otherwise), or a `state` member
 * filling an identifier slot that is not a single path segment
 * - {@link TraceError} — `model` or `state` fails {@link validate} against the shape
 * - {@link Problem} — network, storage, or other processing failures
 *
 * Errors are therefore handled at the call site, with `await` and `try`/`catch` or a chained `.catch`. The rejection
 * type tells logic errors apart from process errors.
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
 *     name: {},
 *     price: {},
 *     vendor: { id: {}, name: {} }
 *   }
 * });
 *
 * // collection retrieval with filtering, ordering, and pagination
 *
 * const catalogue = await store.lookup({
 *   entry: "http://example.com/products/",
 *   shape: CatalogueShape,
 *   model: {
 *     products: {
 *       id: {},
 *       name: {},
 *       price: {},
 *       ">=price": 50,        // price ≥ 50
 *       "~name": "widget",    // name contains "widget"
 *       "^price": 1,          // sort by price ascending
 *       "@": 0,               // offset
 *       "#": 25               // limit
 *     }
 *   }
 * });
 * ```
 *
 * **Creating and Updating Resources**
 *
 * ```typescript
 * // creation within the collection holding the new resource, its identifier minted by the store unless stated
 *
 * const product = await store.create({
 *   entry: "http://example.com/products/",
 *   shape: CatalogueShape,
 *   model: { products: {} },
 *   state: {
 *     name: "Widget",
 *     price: 29.99,
 *     vendor: "http://example.com/vendors/acme"
 *   }
 * });
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
 *   await store.create({ entry: catalogue, shape: CatalogueShape, model: { products: {} }, state: product });
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
import type { Draft, Match, Model, Slice } from "@metreeca/blue/value";
import type { Lazy, Optional } from "@metreeca/core";
import type { Some } from "@metreeca/core/arrays";
import type { Awaitable } from "@metreeca/core/async";
import type { Tag } from "@metreeca/core/language";
import type { TraceError } from "@metreeca/core/trace";
import type { Problem } from "@metreeca/http/success";
import { type Projection, Template } from "@metreeca/qest/model";
import { type Reference, Resource } from "@metreeca/qest/state";
import type { createManagingStore } from "./stores/managing.js";


/**
 * Model-driven resource store.
 *
 * Extends {@link StoreClient} with management facilities: mutation events, transactional execution, and lifecycle.
 * This is the store surface returned by connector factories and by wrappers like {@link createManagingStore}. The data
 * surface stays a standalone {@link StoreClient}, so it can be implemented and passed around on its own: for example,
 * the client handed to an {@link Store.execute execute} task carries no `execute` of its own.
 *
 * Every data method on a store is individually atomic, even when called outside {@link Store.execute execute} and
 * regardless of the number of server round-trips it may require.
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
	 * Each call creates an independent registration. Multiple registrations of the same observer coexist and fire
	 * independently: the observer is invoked once per matching registration for each mutation batch. The returned
	 * handle detaches **only** its own registration. Calling it more than once is a no-op, and other registrations of
	 * the same observer are unaffected. Detaching is the only way to stop receiving events: a repeated `observe` call
	 * never replaces an earlier registration.
	 *
	 * `resources` is the filter for the registration:
	 *
	 * - `undefined` (omitted) — no filter; the observer fires for every mutation
	 * - a single {@link Reference} — fires for mutations to that resource and its
	 *   {@link @metreeca/core!isNestedIRI | descendants}
	 * - a collection of references — an array, a set, an iterator, or any other iterable; fires for mutations
	 *   matching any element and its descendants
	 * - an empty collection — ignored; no registration is created and the returned handle is a no-op
	 *
	 * The filter is read once, when the registration is created. Single-pass iterables are safe to pass, and later
	 * changes to the collection leave the registration untouched.
	 *
	 * > [!NOTE]
	 * > The observer receives only resource identifiers and an existence flag, not the mutated state. Event payloads
	 * > stay small even when a single transaction mutates many resources, and each observer can fetch the data it
	 * > needs with {@link StoreClient.lookup lookup}.
	 *
	 * @param observer - Mutation observer invoked with each batch of matching mutations
	 * @param resources - Filter (a single reference, a collection of references, or omitted for no filter)
	 *
	 * @returns A function that detaches **this** registration
	 *
	 * @throws {@link !Error Error} if the store has been {@link Store.close closed}
	 */
	observe(observer: StoreObserver, resources?: Some<Reference>): () => void;

	/**
	 * Execute a task within a store transaction.
	 *
	 * All operations performed by the task are executed atomically. If the task completes successfully, all
	 * mutations are committed and {@link Store.observe registered observers} receive a single mutation event
	 * listing all affected resources. If the task throws or rejects, no mutations are committed and no events are
	 * notified. This includes logic errors ({@link !RangeError RangeError}, {@link TraceError}) raised by inner
	 * {@link StoreClient} calls. The error is propagated to the caller as a promise rejection.
	 *
	 * The task receives its own {@link StoreClient} for the transaction. Operations performed through it belong to
	 * the transaction and commit together, separately from any other `execute` running at the same time.
	 *
	 * > [!WARNING]
	 * > `execute` is not re-entrant. Transaction boundaries are flat: a task cannot open a nested transaction, and
	 * > composed operations must share a single outer call.
	 *
	 * > [!WARNING]
	 * > The task MUST NOT retain or use the {@link StoreClient} it receives after `execute` settles. Implementations
	 * > may back it with transaction-scoped state, such as buffered mutations or a bound backend scope, that is
	 * > flushed or discarded on completion, so any later call has undefined behaviour.
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
	 * propagated by `task`, including a {@link !RangeError RangeError} or {@link TraceError} from inner validation or a
	 * {@link Problem} from a transactional, network, storage, or other processing failure
	 *
	 * @throws {@link !Error Error} if the store has been {@link Store.close closed}
	 */
	execute<V>(task: (store: StoreClient) => Awaitable<V>): Promise<V>;

	/**
	 * Release resources held by this store.
	 *
	 * Frees underlying resources such as database connections or file handles. Calling `close` on an
	 * already-closed store has no effect. Implementations with no resources to release MAY return a
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
 * Persists and retrieves linked data resources as shape-validated states and query projections. This is the data
 * surface a connector implements against its backend, and the client a {@link Store.execute execute} task works
 * through.
 */
export interface StoreClient {

	/**
	 * Look up a resource.
	 *
	 * Retrieves the resource identified by `entry`. The result holds only the members named by the `model`
	 * {@link Template}, and expands the linked resources the template reaches. Values are typed after the `shape`:
	 * the template states which members are wanted, not what they are.
	 *
	 * Multi-valued members are retrieved as collections. Filtering, ordering and pagination constraints are stated
	 * under the member name, next to its retrieval keys. A {@link Projection} stated there in place of a template
	 * returns rows of computed values, keyed by the names of its bindings. A collection with no matching item is
	 * omitted from the result, like any other member without a value.
	 *
	 * > [!NOTE]
	 * > `shape` and `model` are kept distinct so that a single `shape` can serve many retrieval templates. For
	 * > example, a server may wire one `shape` at startup and accept any admissible `model` decoded from each client
	 * > request. A template retrieving every member the shape declares MUST be written out explicitly.
	 *
	 * > [!CAUTION]
	 * > By default, `model` templates support the full query language, including aggregate transforms and nested
	 * > expansion. When exposing retrieval to untrusted clients, restrict query complexity through the
	 * > {@link StoreScope | scope}: set `plain` to `true`, `depth` to `0` or a positive value, and/or `limit` to a
	 * > maximum result set size.
	 *
	 * @typeParam S - The shape driving the retrieval
	 * @typeParam T - The retrieval template, naming only members the shape carries
	 *
	 * @param request - The resource to retrieve, the shape describing it and the template narrowing it
	 * @param scope - The {@link StoreScope | retrieval scope}, bounding `model` and setting the locale priority
	 *
	 * @returns A promise resolving to an immutable copy of the resource data narrowed to the members `model` names,
	 * or to `undefined` if the resource is not present in the store; rejects with a {@link !RangeError RangeError} if
	 * `entry` is not an absolute IRI, a {@link TraceError} if `model` doesn't {@link validate} against the shape,
	 * or a {@link Problem} on network, storage, or other processing errors
	 *
	 * @throws {@link !Error Error} if the store has been {@link Store.close closed}
	 */
	lookup<S extends Lazy<ResourceShape>, T extends Model<S, T>>(request: StoreLookup<S, T>, scope?: StoreScope): Promise<Optional<Match<S, T>>>;

	/**
	 * Create a resource.
	 *
	 * Adds a new resource to a collection held by the resource identified by `entry`. The collecting property is the
	 * single multi-valued property named by `model`, and the new resource is stored as described by the shape that
	 * property ranges over. Nothing is created if a resource already exists under the identifier of the new one.
	 *
	 * The new resource is identified by the `id` of its `state`, which must be nested under `entry`. If `id` is left
	 * out, the store mints one under `entry`, following the identifier {@link ResourceShape.pattern | pattern} declared
	 * by the collected shape, if any. Each `{name}` slot is filled with the like-named member of `state`, which must
	 * be a single path segment. Any other slot is filled with an opaque segment. A remote store may leave the choice
	 * of identifier to the service holding the collection.
	 *
	 * Specific reference kinds are handled as follows:
	 *
	 * - {@link ResourceShape | embedded references} — cascades recursively with the same semantics
	 * - {@link @metreeca/blue/resource!PropertyConstraints.captive | captive references} — accepted only as bare
	 * IRI references; inline captive batches are rejected, as `state` is always validated at depth `0`
	 * - {@link @metreeca/blue/resource!PropertyConstraints.foreign | foreign references} — skipped, as their
	 * data is owned by the defining resource
	 *
	 * @typeParam S - The shape driving the creation, describing the collecting resource
	 * @typeParam T - The collection slice, naming the collecting property
	 *
	 * @param request - The resource collecting the new one, the shape describing it, the slice naming the collecting
	 * property and the initial state of the new resource
	 *
	 * @returns A promise resolving to the {@link Reference} identifying the created resource, or to `undefined`
	 * if a resource already exists under that identifier; rejects with a {@link !RangeError RangeError} if `entry` is
	 * not an absolute IRI, if `state` carries an `id` not nested under `entry` or if a member filling an identifier
	 * slot is not a single path segment, a {@link TraceError} if `model` or `state` doesn't {@link validate}
	 * against the shape, or a {@link Problem} on network, storage, or other processing errors
	 *
	 * @throws {@link !Error Error} if the store has been {@link Store.close closed}
	 *
	 * @see {@link StoreClient.insert insert} for unconditional insertion under a known identifier
	 */
	create<S extends Lazy<ResourceShape>, T extends Slice<S, T>>(request: StoreCreate<S, T>): Promise<Optional<Reference>>;

	/**
	 * Update a resource.
	 *
	 * Replaces the resource's own data if the resource already exists, fully removing any previously existing
	 * embedded data. Specific reference kinds are handled as follows:
	 *
	 * - {@link ResourceShape | embedded references} — cascades recursively with the same semantics
	 * - {@link @metreeca/blue/resource!PropertyConstraints.captive | captive references} — accepted only as bare
	 * IRI references; inline captive batches are rejected, as `state` is always validated at depth `0`
	 * - {@link @metreeca/blue/resource!PropertyConstraints.foreign | foreign references} — skipped, as their
	 * data is owned by the defining resource
	 *
	 * @typeParam S - The shape driving the update, describing the state
	 *
	 * @param request - The resource to update, the shape validating it and its replacement state
	 *
	 * @returns A promise resolving to the `entry` {@link Reference} of the updated resource, or to `undefined`
	 * if the resource doesn't exist; rejects with a {@link !RangeError RangeError} if `entry` is not an absolute IRI
	 * or if `state` carries an `id` differing from `entry`, a {@link TraceError} if `state` doesn't {@link validate}
	 * against the shape, or a {@link Problem} on network, storage, or other processing errors
	 *
	 * @throws {@link !Error Error} if the store has been {@link Store.close closed}
	 *
	 * @see {@link StoreClient.insert insert} for unconditional insertion
	 */
	update<S extends Lazy<ResourceShape>>(request: StoreUpdate<S>): Promise<Optional<Reference>>;

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
	 * @typeParam S - The shape driving the deletion, identifying the data cascaded with the resource
	 *
	 * @param request - The resource to delete and the shape identifying the data cascade-deleted with it
	 *
	 * @returns A promise resolving to the `entry` {@link Reference} of the deleted resource, or to `undefined`
	 * if the resource doesn't exist; rejects with a {@link !RangeError RangeError} if `entry` is not an absolute IRI,
	 * or a {@link Problem} on network, storage, or other processing errors
	 *
	 * @throws {@link !Error Error} if the store has been {@link Store.close closed}
	 *
	 * @see {@link StoreClient.remove remove} for unconditional removal
	 */
	delete<S extends Lazy<ResourceShape>>(request: StoreDelete<S>): Promise<Optional<Reference>>;


	/**
	 * Insert a resource.
	 *
	 * Unconditionally inserts or replaces the resource's own data, fully removing any previously existing embedded
	 * data. Specific reference kinds are handled as follows:
	 *
	 * - {@link ResourceShape | embedded references} — cascades recursively with the same semantics
	 * - {@link @metreeca/blue/resource!PropertyConstraints.captive | captive references} — accepted only as bare
	 * IRI references; inline captive batches are rejected, as `state` is always validated at depth `0`
	 * - {@link @metreeca/blue/resource!PropertyConstraints.foreign | foreign references} — skipped, as their
	 * data is owned by the defining resource
	 *
	 * @typeParam S - The shape driving the insertion, describing the state
	 *
	 * @param request - The resource to insert, the shape validating it and its state
	 *
	 * @returns A promise resolving to the `entry` {@link Reference} of the inserted resource; rejects with a
	 * {@link !RangeError RangeError} if `entry` is not an absolute IRI or if `state` carries an `id` differing from
	 * `entry`, a {@link TraceError} if `state` doesn't {@link validate} against the shape, or a {@link Problem} on
	 * network, storage, or other processing errors
	 *
	 * @throws {@link !Error Error} if the store has been {@link Store.close closed}
	 *
	 * @see {@link StoreClient.create create} for conditional creation
	 * @see {@link StoreClient.update update} for conditional replacement
	 */
	insert<S extends Lazy<ResourceShape>>(request: StoreUpdate<S>): Promise<Reference>;

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
	 * @typeParam S - The shape driving the removal, identifying the data cascaded with the resource
	 *
	 * @param request - The resource to remove and the shape identifying the data cascade-removed with it
	 *
	 * @returns A promise resolving to the `entry` {@link Reference} of the removed resource; rejects with a
	 * {@link !RangeError RangeError} if `entry` is not an absolute IRI, or a {@link Problem} on network, storage, or
	 * other processing errors
	 *
	 * @throws {@link !Error Error} if the store has been {@link Store.close closed}
	 *
	 * @see {@link StoreClient.delete delete} for conditional removal
	 */
	remove<S extends Lazy<ResourceShape>>(request: StoreDelete<S>): Promise<Reference>;

}

/**
 * Store retrieval scope.
 *
 * Bounds the aggregates, nesting depth and page size a {@link StoreClient.lookup lookup} admits in its `model`, and
 * sets the locale priority for its localised content. Every member is optional. An empty scope admits any `model`
 * the shape validates, and resolves localised content against the undetermined `und` tag alone.
 */
export type StoreScope = {

	/**
	 * {@link Tag} priority list driving language negotiation for localised content.
	 *
	 * Entries are matched in order of preference against the language tags available for each localised value.
	 *
	 * @defaultValue `["und"]`
	 */
	locale?: readonly Tag[]

	/**
	 * Whether to reject `model` templates carrying aggregate transforms (`count`, `sum`, `min`, `max`, `avg`),
	 * admitting retrieval but not computation.
	 *
	 * @defaultValue `false`, admitting the full query language
	 */
	plain?: boolean

	/**
	 * Maximum nesting admitted for `model` expansion and query probe paths.
	 *
	 * Each nested resource or path segment counts against the budget. `0` rejects any nested template, but still
	 * admits IRI references.
	 *
	 * @defaultValue Unbounded
	 */
	depth?: number

	/**
	 * Maximum page size admitted for the `#` pagination constraint on `model` collections.
	 *
	 * A positive value caps the result set. A `#` exceeding it, or set to `0` (unbounded), is rejected, and a
	 * collection with no `#` is held to it. `0` leaves result sets unbounded.
	 *
	 * @defaultValue `0`
	 */
	limit?: number

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
	(mutations: { readonly [entry: Reference]: boolean }): Awaitable<void>;

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Store lookup request.
 *
 * Names the resource to retrieve with {@link StoreClient.lookup lookup}, the shape describing it and the template
 * narrowing the result.
 *
 * @typeParam S - The shape driving the retrieval
 * @typeParam T - The retrieval template, naming only members the shape carries
 */
export type StoreLookup<S extends Lazy<ResourceShape>, T extends Model<S, T>> = {

	/**
	 * Absolute identifier of the resource to be retrieved.
	 */
	readonly entry: Reference;

	/**
	 * Resource shape the retrieval is validated against, possibly deferred to break definition cycles.
	 */
	readonly shape: S;

	/**
	 * Retrieval template defining the data envelope of the result.
	 *
	 * The template names only members carried by `shape`, each in a form its range admits. Multi-valued members may
	 * also state filtering, ordering and pagination constraints, or a projection in place of a template.
	 */
	readonly model: T;

}

/**
 * Store creation request.
 *
 * Names the resource collecting a new one with {@link StoreClient.create create}, the property holding the
 * collection and the initial state of the new resource.
 *
 * @typeParam S - The shape driving the creation, describing the collecting resource
 * @typeParam T - The collection slice, naming the collecting property
 */
export type StoreCreate<S extends Lazy<ResourceShape>, T extends Slice<S, T>> = {

	/**
	 * Absolute identifier of the resource collecting the new one.
	 */
	readonly entry: Reference;

	/**
	 * Resource shape the creation is validated against, describing the collecting resource, possibly deferred to
	 * break definition cycles.
	 */
	readonly shape: S;

	/**
	 * Collection slice naming the multi-valued property of `shape` that collects the new resource.
	 */
	readonly model: T;

	/**
	 * Initial state of the new resource; an explicit `id` must be nested under `entry`.
	 */
	readonly state: Draft<S, T>

}

/**
 * Store update request.
 *
 * Names the resource to store with {@link StoreClient.update update} or {@link StoreClient.insert insert}, the shape
 * describing it and the complete state replacing its current data.
 *
 * @typeParam S - The shape driving the persistence, describing the state
 */
export type StoreUpdate<S extends Lazy<ResourceShape>> = {

	/**
	 * Absolute identifier of the resource to be persisted.
	 */
	readonly entry: Reference;

	/**
	 * Resource shape `state` is validated against, possibly deferred to break definition cycles.
	 */
	readonly shape: S;

	/**
	 * Complete state for the resource, as `shape` describes it, replacing any existing data; its `id`, if stated,
	 * must match `entry`.
	 */
	readonly state: Draft<S>

}

/**
 * Store deletion request.
 *
 * Names the resource to discard with {@link StoreClient.delete delete} or {@link StoreClient.remove remove} and the
 * shape identifying the data discarded with it.
 *
 * @typeParam S - The shape driving the deletion, identifying the data cascaded with the resource
 */
export type StoreDelete<S extends Lazy<ResourceShape>> = {

	/**
	 * Absolute identifier of the resource to be discarded.
	 */
	readonly entry: Reference;

	/**
	 * Resource shape identifying the embedded and captive data discarded with the resource, possibly deferred to
	 * break definition cycles.
	 */
	readonly shape: S;

}
