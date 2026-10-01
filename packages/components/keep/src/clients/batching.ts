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
 * Lets a connector serve many concurrent store requests with few backend round-trips. Requests of the same kind are
 * coalesced into a single batch, and the connector supplies one batch {@link Handler} per kind. The resulting
 * {@link StoreClient} adds conditional CRUD semantics on top, so handlers apply each request unconditionally.
 *
 * Four request kinds partition the work, each with its own handler:
 *
 *  - **`detect`** — probes whether each {@link Detect} entry exists in the store
 *  - **`detail`** — materialises each {@link Detail} resource against its `model`; multi-valued members reached
 *    by the model may be handed to the `select` handler through {@link Broker.select}
 *  - **`select`** — materialises each {@link Select} collection against its `query`; element resources reached
 *    by the query may be handed to the `detail` handler through {@link Broker.detail}
 *  - **`modify`** — creates, updates, or deletes each {@link Modify} target, or links it to a collection
 *
 * Retrieval is driven by the requested `model` and `query`, not by the stored graph. A `detail` handler issues a
 * `select` for each multi-valued member its model reaches, and a `select` handler issues a `detail` for each element
 * resource its query reaches. Each request thus descends exactly as deep as its `model` or `query` nests, however
 * deep the underlying graph runs.
 *
 * > [!IMPORTANT]
 * > Handlers run concurrently and exchange nested requests through the {@link Broker}. A handler must not assume any
 * > ordering between handlers, and must await every nested request it issues before settling the request that
 * > depends on it.
 *
 * @module
 */

import type { Property, ResourceShape } from "@metreeca/blue/resource";
import { blueprint, collection, type Match } from "@metreeca/blue/value";
import { isString, type Lazy, type Optional } from "@metreeca/core";
import type { Tag } from "@metreeca/core/language";
import { immutable } from "@metreeca/core/values";
import type { Query, Slot, Template } from "@metreeca/qest/model";
import type { Reference, Resource, Value } from "@metreeca/qest/state";
import type { StoreClient } from "../index.js";
import { createBroker, mint } from "./batching.core.js";


/**
 * Requests accepted by {@link Broker}.
 */
export type Request =
	| Detect
	| Detail
	| Select
	| Modify;

/**
 * Result of running a {@link Request}, narrowed by request variant:
 *
 *  - a {@link Detect} resolves to a `boolean` existence flag
 *  - a {@link Detail} resolves to the materialised resource, typed by its shape and model
 *  - a {@link Select} resolves to the {@link Value | values} its collection holds, untyped since its shape is
 *    carried as a value rather than as a type parameter
 *  - a {@link Modify} resolves to its mutated entry's {@link Reference}
 *
 * @typeParam R The request whose result type is selected
 */
export type Response<R extends Request> =
	R extends Select ? readonly Value[]
		: R extends Detail<infer T, infer S> ? Match<S, T>
			: R extends Modify ? Reference
				: R extends Detect ? boolean // ;( keep it last: structurally the most general (entry only)
					: never;


/**
 * Resource existence request.
 *
 * Carries the `entry` to probe, and resolves to whether that entry exists in the store.
 */
export type Detect = {

	readonly entry: Reference;

};

/**
 * Resource retrieval request.
 *
 * Carries a single resource (`entry` of `shape`), the `model` to materialise it against, and the `locale` priority
 * for coalescing its localised content (QEST §6.2). Resolves to the materialised resource.
 *
 * @typeParam T The resource model selecting the members of the result
 * @typeParam S The shape describing the resource
 */
export type Detail<
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
 * Carries a single multi-valued property (`field` on `entry` of `shape`), the `query` describing its values, and the
 * `locale` priority for coalescing its localised content (QEST §6.2). Resolves to the materialised collection: items
 * for a template query, rows for a projection.
 *
 * @typeParam T The collection query selecting the form of the result
 */
export type Select<T extends Query<Slot> = Query<Slot>> = {

	readonly entry: Reference;
	readonly shape: Lazy<ResourceShape>;
	readonly field: Property;
	readonly query: T;

	readonly locale: readonly Tag[];

};

/**
 * Resource mutation request.
 *
 * Carries the `entry` to mutate (of `shape`) and the target `state` to persist. A present `state` creates or updates
 * the entry, and an omitted `state` deletes it. A request carrying a `link` instead adds `item` to the collection
 * held by `entry` under `property`, leaving the rest of the entry unchanged. Resolves to the {@link Reference} of the
 * mutated entry.
 */
export type Modify = {

	readonly entry: Reference;
	readonly shape: Lazy<ResourceShape>;
	readonly state?: Resource;

	readonly link?: {

		readonly property: Property;
		readonly item: Reference;

	};

};


/**
 * Batch handler for a single request type.
 *
 * Supplied by the connector to {@link createBatchingStore}, one per request type. A handler receives every request of
 * its type accumulated since the previous batch, together with a {@link Broker} for issuing nested requests. It
 * settles each {@link Deferred} in the batch with its result or error. The returned promise must resolve only once
 * every request in the batch has settled, including any nested requests issued through the broker.
 *
 * Batches are never empty, so handlers need not guard against an empty one.
 *
 * @typeParam R The request variant handled
 */
export type Handler<R extends Request> = {

	(batch: readonly Deferred<R>[], broker: Broker): Promise<void>

}

/**
 * A queued request paired with its promise-resolution hooks.
 *
 * Each batch a {@link Handler} receives is an array of `Deferred` entries. For each entry, the handler reads the
 * `request` and settles it, calling `resolve` with its result (typed by {@link Response | Response<R>}) or `reject`
 * with an error.
 *
 * @typeParam R The queued request variant: a {@link Detect} probe, a {@link Detail} resource fetch,
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
 * Routes each request (detection, detail, selection, modification) to the handler for its type. Each call queues the
 * request for the next batch and returns a promise that settles with its result. Handlers receive a broker to hand
 * nested work to a sibling handler.
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
	 * Enqueue a {@link Detail} request.
	 *
	 * Carries no existence precondition: an entry with no stored state resolves to an empty instance of
	 * the request's `model` rather than rejecting.
	 *
	 * @param request The resource and model to materialise
	 *
	 * @returns A promise resolving to the resource materialised against the request's `model`, settled once the
	 *     owning batch and any nested requests needed to assemble it have resolved
	 */
	detail<S extends Lazy<ResourceShape>, T extends Template>(request: Detail<T, S>): Promise<Match<S, T>>;

	/**
	 * Enqueue a {@link Select} request.
	 *
	 * Carries no existence precondition: an entry with no matching members resolves to an empty
	 * collection rather than rejecting.
	 *
	 * @param request The property and query to materialise
	 *
	 * @returns A promise resolving to the values the collection holds as the request's `query` narrows them,
	 *     items for a template and rows for a projection, settled once the owning batch and any nested requests
	 *     needed to assemble them have resolved
	 */
	select<T extends Query<Slot>>(request: Select<T>): Promise<readonly Value[]>;

	/**
	 * Enqueue a {@link Modify} request.
	 *
	 * Mutates unconditionally, with no existence precondition. A present `state` upserts the entry, creating it if
	 * absent. An omitted `state` deletes the entry, and is a no-op if the entry is absent.
	 *
	 * @param request The entry and target state to persist, or the collection link to add
	 *
	 * @returns A promise resolving to the {@link Reference} of the mutated entry, settled once the owning
	 * batch has completed
	 */
	modify(request: Modify): Promise<Reference>;

};


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates a batching store client backed by a set of request handlers.
 *
 * Coalesces concurrent {@link StoreClient} calls into batches, each served by the matching `handlers` entry. The
 * client adds conditional CRUD semantics on top of the handlers: `create`, `update` and `delete` probe for existence
 * through the `detect` handler before handing the mutation to `modify`. `create` mints the identifier of the new
 * resource, if its state names none, and links it to the collecting resource.
 *
 * The `modify` handler receives only requests whose `state` carries no `id` other than their `entry`. A request
 * failing this check is rejected on its own, and the rest of the batch still applies. If the `modify` handler throws,
 * the error rejects every request in its batch.
 *
 * @param handlers The batch handlers, one per request type
 *
 * @returns An immutable {@link StoreClient} serving its requests in batches through `handlers`
 *
 * @throws {@link !RangeError RangeError} If an update or insert `state` carries an `id` that differs from its `entry`,
 *     or if a create `state` member filling an identifier slot is not a single path segment
 */
export function createBatchingStore(handlers: {

	detect: Handler<Detect>
	detail: Handler<Detail>
	select: Handler<Select>
	modify: Handler<Modify>

}): StoreClient {

	const broker = createBroker({

		...handlers,

		async modify(batch, broker) {

			const items = batch.filter(({ request: { entry, state }, reject }) => {

				// reject each request whose state id contradicts its entry on its own, so the
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

		} = {}): Promise<Optional<Match<S, T>>> {

			return await broker.detect({ entry })
				? broker.detail({ entry, shape, model, locale })
				: undefined;

		},

		async create({ entry, shape, model, state }) {

			// the new resource is stored under the identifier its state names, or under one minted for it off the
			// blueprint of the collection; either way it is the resource probed for existence and written, not the
			// collection

			const target = collection(shape, model);
			const plan = blueprint(shape, model);
			const { id }: Resource = state;

			const child = isString(id) ? id : mint(entry, plan, state);

			// a collection a plain property holds is linked to its new member; one exposed through
			// a foreign property is a view over the member's own link and reaches it on its own

			return await broker.detect({ entry: child }) ? undefined
				: broker.modify({ entry: child, shape: plan, state }).then(created => target.foreign
					? created
					: broker.modify({ entry, shape, link: { property: target, item: created } }).then(() => created)
				);

		},

		async update({ entry, shape, state }) {

			// the entry identifies the target: a state carrying a different id contradicts it

			const { id }: Resource = state;

			if ( id !== undefined && id !== entry ) {
				throw new RangeError(`mismatched state id <${String(id)}> for entry <${entry}>`);
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
