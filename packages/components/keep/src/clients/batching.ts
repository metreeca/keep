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
 * Batching store client.
 *
 * Builds a {@link StoreClient} that coalesces concurrent requests of the same kind into a single
 * batch, so a connector can serve many requests with one backend round-trip. A connector author
 * supplies one {@link Handler} per request type to {@link createBatchingStore}; the returned client
 * routes every call through a {@link Broker} that queues like-typed requests and hands each handler
 * the whole batch it accumulated.
 *
 * Four request types partition the work, each with its own handler:
 *
 *  - **`detect`** — probes whether each {@link Detect} entry exists in the store
 *  - **`lookup`** — materialises each {@link Lookup} against its `model`; multi-valued slots reached
 *    by the model may be delegated to the `select` handler via {@link Broker.select}
 *  - **`select`** — materialises each {@link Select} collection (see `Mould` for the admitted
 *    forms); element resources reached by the query may be delegated to the `lookup` handler via
 *    {@link Broker.lookup}
 *  - **`modify`** — creates, updates, or deletes each {@link Modify} target
 *
 * Retrieval is driven by the requested `model` and `query`, not by the stored graph: `lookup` and
 * `select` hand work back and forth, `lookup` spawning a `select` for each multi-valued slot its
 * model reaches and `select` spawning a `lookup` for each element resource its query reaches. The
 * handover recurses through this alternation and bottoms out where the `model` or `query` stops
 * nesting, so each request descends exactly as deep as it asks for, however deep the underlying
 * graph runs.
 *
 * Handlers run concurrently and forward nested requests to one another through the {@link Broker}, so
 * a handler must not assume any ordering between handlers, and must await every nested promise it
 * issues before settling the request that depends on it. Correctness rests on this data dependency
 * alone, not on handler scheduling.
 *
 * @module
 */

import type { Property, ResourceShape } from "@metreeca/blue/resource";
import { type Delivery, eager } from "@metreeca/blue/value";
import type { Lazy, Optional } from "@metreeca/core";
import type { Tag } from "@metreeca/core/language";
import { immutable } from "@metreeca/core/structures";
import type { Reference, Resource } from "@metreeca/qest/state";
import type { Template } from "@metreeca/qest/model";
import type { Items, Mould } from "../_inference.js";
import type { StoreClient } from "../index.js";
import { createBroker } from "./batching.core.js";


/**
 * Requests accepted by {@link Broker}.
 */
export type Request =
	| Detect
	| Lookup
	| Select
	| Modify;

/**
 * Result of running a {@link Request}, narrowed by request variant:
 *
 *  - a {@link Detect} resolves to a `boolean` existence flag
 *  - a {@link Lookup} resolves to its materialised resource {@link @metreeca/blue/value!Delivery | Delivery}
 *  - a {@link Select} resolves to its materialised collection {@link @metreeca/blue/value!Delivery | Delivery}
 *  - a {@link Modify} resolves to its mutated entry's {@link Reference}
 *
 * @typeParam R The request whose result type is selected
 */
export type Response<R extends Request> =
	R extends Select<infer T> ? Items<T>
		: R extends Lookup<infer T, infer S> ? Delivery<S, T>
			: R extends Modify ? Reference
				: R extends Detect ? boolean // ;( keep it last: structurally the most general (entry only)
					: never;


/**
 * Resource existence request.
 *
 * Carries the `entry` to probe; resolves to whether that entry exists in the store.
 */
export type Detect = {

	readonly entry: Reference;

};

/**
 * Resource retrieval request.
 *
 * Carries a single resource (`entry` of `shape`), the `model` against which to materialise it, and
 * the `locale` priority driving language negotiation for its localised content (§6.2). Resolves to
 * the materialised resource.
 *
 * @typeParam T The resource model selecting the result shape
 */
export type Lookup<
	T extends Template = Template,
	S extends Lazy<ResourceShape> = Lazy<ResourceShape>
> = {

	readonly entry: Reference;
	readonly shape: S;
	readonly model: T;

	readonly locale: readonly Tag[];

};

/**
 * Collection retrieval request.
 *
 * Carries a single multi-valued property (`field` on `entry` of `shape`), the `query` describing the
 * shape of its values (one of the `Mould` arms), and the `locale` priority driving language
 * negotiation for its localised content (§6.2). Resolves to the materialised collection.
 *
 * @typeParam T The collection query selecting the result shape
 */
export type Select<T extends Mould = Mould> = {

	readonly entry: Reference;
	readonly shape: Lazy<ResourceShape>;
	readonly field: Property;
	readonly query: T;

	readonly locale: readonly Tag[];

};

/**
 * Resource mutation request.
 *
 * Carries the `entry` to mutate (of `shape`) and the target `state` to persist: a present `state`
 * creates or updates the entry, an omitted `state` deletes it. Resolves to the mutated entry's
 * {@link Reference}.
 */
export type Modify = {

	readonly entry: Reference;
	readonly shape: Lazy<ResourceShape>;
	readonly state?: Resource

};


/**
 * Batch handler for a single request type.
 *
 * Supplied by the connector author to {@link createBatchingStore}, one per request type. Receives the
 * whole batch the {@link Broker} has accumulated for this type, together with the broker for issuing
 * nested requests, and settles each {@link Deferred} in the batch with its result or error. The
 * returned promise must resolve only once every request the handler owns has settled, including any
 * nested requests issued through the broker.
 *
 * The broker never dispatches an empty batch, so the handler need not guard against one.
 *
 * @typeParam R The request variant handled
 */
export type Handler<R extends Request> = {

	(batch: readonly Deferred<R>[], broker: Broker): Promise<void>

}

/**
 * A queued request paired with its promise-resolution hooks.
 *
 * Each batch a {@link Handler} receives is an array of `Deferred` entries. The handler reads each
 * `request`, then calls `resolve` with its result (typed by {@link Response | Response<R>}) or
 * `reject` with an error, once the backend round-trip and any nested requests issued through the
 * {@link Broker} have settled.
 *
 * @typeParam R The queued request variant: a {@link Detect} probe, a {@link Lookup} resource fetch,
 *     a {@link Select} collection fetch, or a {@link Modify} mutation
 */
export type Deferred<R extends Request> = {

	readonly request: R;

	resolve(value: Response<R>): void;

	reject(error: unknown): void;

};


/**
 * Request-submission surface over the batching {@link Handler | handlers}.
 *
 * Brokers each store request (detection, lookup, selection, modification) to its handler: a call
 * enqueues the request and returns a promise that settles with the request's result. Held both by
 * outside callers, as the entry point, and by handlers, to delegate nested work to a sibling
 * handler.
 */
export type Broker = {

	/**
	 * Enqueue a {@link Detect} request.
	 *
	 * @param request The entry to probe
	 *
	 * @returns A promise resolving to `true` when the request's entry exists in the store; `false`
	 * otherwise
	 */
	detect(request: Detect): Promise<boolean>;

	/**
	 * Enqueue a {@link Lookup} request.
	 *
	 * Carries no existence precondition: an entry with no stored state resolves to an empty instance of
	 * the request's `model` rather than rejecting.
	 *
	 * @param request The resource and model to materialise
	 *
	 * @returns A promise resolving to the materialised {@link @metreeca/blue/value!Delivery | Delivery} of the request's `model` (the
	 * resource value), settled once the owning batch and any nested promises needed to assemble its
	 * value have resolved
	 */
	lookup<S extends Lazy<ResourceShape>, T extends Template>(request: Lookup<T, S>): Promise<Delivery<S, T>>;

	/**
	 * Enqueue a {@link Select} request.
	 *
	 * Carries no existence precondition: an entry with no matching members resolves to an empty
	 * collection rather than rejecting.
	 *
	 * @param request The property and query to materialise
	 *
	 * @returns A promise resolving to the materialised {@link @metreeca/blue/value!Delivery | Delivery} of the request's `query` (one
	 * of the tuple-wrapped `Mould` arms), settled once the owning batch and any nested promises
	 * needed to assemble its value have resolved
	 */
	select<T extends Mould>(request: Select<T>): Promise<Items<T>>;

	/**
	 * Enqueue a {@link Modify} request.
	 *
	 * Mutates unconditionally, with no existence precondition: a present `state` upserts the entry,
	 * creating it when absent; an omitted `state` deletes it leniently, resolving as a no-op when
	 * absent.
	 *
	 * @param request The entry and target state to persist
	 *
	 * @returns A promise resolving to the mutated entry's {@link Reference}, settled once the owning
	 * batch has completed
	 */
	modify(request: Modify): Promise<Reference>;

};


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates a batching store client backed by a set of request handlers.
 *
 * Routes every {@link StoreClient} call through a {@link Broker} that coalesces concurrent requests
 * into batches and dispatches each batch through the matching `handlers` entry. Adds conditional CRUD
 * semantics on top of the handlers: existence is probed through the `detect` handler before a create,
 * update, or delete is delegated to `modify`, sparing each handler that bookkeeping.
 *
 * The `modify` handler is additionally wrapped so the batching layer, not the storage handler,
 * enforces the §4.1 state-`id` constraint: a request whose `state` carries an `id` other than its
 * `entry` is rejected on its own before dispatch, and a backend failure is settled as a rejection
 * across the surviving batch rather than surfaced as a handler throw. The wrapped handler thus always
 * receives a non-empty batch of pre-validated requests to apply unconditionally.
 *
 * @param handlers The batch handlers, one per request type, dispatching detect, lookup, select, and
 *     modify requests
 *
 * @returns An immutable {@link StoreClient} that batches its requests through the broker
 *
 * @throws {RangeError} If a create or update `state` carries an `id` that differs from its `entry`
 */
export function createBatchingStore(handlers: {

	detect: Handler<Detect>
	lookup: Handler<Lookup>
	select: Handler<Select>
	modify: Handler<Modify>

}): StoreClient {

	const broker = createBroker({

		...handlers,

		async modify(batch, broker) {

			const items = batch.filter(({ request: { entry, state }, reject }) => {

				// reject each request whose state id contradicts its entry (§4.1) on its own, so the
				// rest of the batch still applies and the check stays out of storage-specific handlers

				const matching = state?.id === undefined || state.id === entry;

				if ( !matching ) {
					reject(new RangeError(`mismatched state id <${String(state?.id)}> for entry <${entry}>`));
				}

				return matching;

			});

			if ( items.length > 0 ) {

				// on backend failure, reject the surviving batch rather than throw: the broker
				// treats a handler throw as a run-wide fault and propagates it to sibling queues

				try {

					await handlers.modify(items, broker);

				} catch ( error ) {

					items.forEach(({ reject }) => reject(error));

				}

			}

		}

	});

	return immutable({

		async lookup<S extends Lazy<ResourceShape>, T extends Template>({ entry, shape, model }: {

			entry: Reference,
			shape: S,
			model: T

		}, {

			locale = ["und"]

		}: {

			locale?: readonly Tag[]

		} = {}): Promise<Optional<Delivery<S, T>>> {

			// virtual resources have no stored state of their own: their members are derived from
			// selection constraints rather than from stored content, so the existence probe is skipped.

			return eager(shape).virtual || await broker.detect({ entry })
				? broker.lookup({ entry, shape, model, locale })
				: undefined;

		},


		async create({ entry, shape, state }) {

			// the entry identifies the target: a state carrying a different id contradicts it (§4.1)

			if ( state.id !== undefined && state.id !== entry ) {
				throw new RangeError(`mismatched state id <${String(state.id)}> for entry <${entry}>`);
			}

			return await broker.detect({ entry })
				? undefined
				: broker.modify({ entry, shape, state });

		},

		async update({ entry, shape, state }) {

			// the entry identifies the target: a state carrying a different id contradicts it (§4.1)

			if ( state.id !== undefined && state.id !== entry ) {
				throw new RangeError(`mismatched state id <${String(state.id)}> for entry <${entry}>`);
			}

			return await broker.detect({ entry })
				? broker.modify({ entry, shape, state })
				: undefined;

		},

		async delete({ entry, shape }) {

			return await broker.detect({ entry })
				? broker.modify({ entry, shape })
				: undefined;

		},


		insert(insert) {
			return broker.modify(insert);
		},

		remove(remove) {
			return broker.modify(remove);
		}

	});

}
