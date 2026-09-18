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
 * SQL-backed store implementation using PGlite.
 *
 * Provides a {@link @metreeca/keep!TxnStore TxnStore} implementation backed by a
 * {@link https://pglite.dev/ PGlite} embedded PostgreSQL instance.
 *
 * @module index
 */

import type { PGlite, Transaction } from "@electric-sql/pglite";
import { audit } from "@metreeca/blue";
import { isString } from "@metreeca/core";
import { immutable } from "@metreeca/core/nested";
import { isIRI, nests } from "@metreeca/core/resource";
import type { Model } from "@metreeca/qest/model";
import type { Reference, Resource } from "@metreeca/qest/state";
import type { Store, StoreListener, TxnStore } from "../../../index.js";
import { create } from "./persist/create.js";
import { del } from "./persist/delete.js";
import { insert } from "./persist/insert.js";
import { remove } from "./persist/remove.js";
import { update } from "./persist/update.js";
import { retrieve } from "./retrieve/index.js";


/**
 * Create a SQL-backed transactional store.
 *
 * @param db - The PGlite instance to use as the storage backend
 *
 * @returns A transactional store backed by `db`
 */
export function createPGliteStore(db: PGlite): TxnStore {

	let active: undefined | Transaction;

	const listeners = new Map<StoreListener, readonly Reference[]>();
	const mutations = new Map<Reference, boolean>();


	const store: TxnStore = immutable({

		retrieve<T extends Model>(id: Reference, model: T): Promise<undefined | T> {

			if ( !isIRI(id, "absolute") ) {
				throw new RangeError(`expected absolute IRI <${id}>`);
			}

			const shape = audit(model, { scope: "model" });

			if ( !shape ) {
				throw new TypeError("expected model validated with model scope");
			}

			return run((tx) => retrieve(tx, id, model, shape));

		},


		create(state: Resource): Promise<undefined | Reference> {

			const shape = audit(state, { scope: "value" });

			if ( !shape ) {
				throw new TypeError("expected state validated with value scope");
			}

			return run((tx) => create(tx, state, shape).then(id => dispatch(id, true)));

		},

		update(state: Resource): Promise<undefined | Reference> {

			const shape = audit(state, { scope: "value" });

			if ( !shape ) {
				throw new TypeError("expected state validated with value scope");
			}

			return run((tx) => update(tx, state, shape).then(id => dispatch(id, true)));

		},

		delete(entry: Resource): Promise<undefined | Reference> {

			const shape = audit(entry, { scope: "*" });

			if ( !shape ) {
				throw new TypeError("expected entry validated with value or entry scope");
			}

			return run((tx) => del(tx, entry, shape).then(id => dispatch(id, false)));

		},


		insert(state: Resource): Promise<undefined | Reference> {

			const shape = audit(state, { scope: "value" });

			if ( !shape ) {
				throw new TypeError("expected state validated with value scope");
			}

			return run((tx) => insert(tx, state, shape).then(id => dispatch(id, true)));

		},

		remove(entry: Resource): Promise<undefined | Reference> {

			const shape = audit(entry, { scope: "*" });

			if ( !shape ) {
				throw new TypeError("expected entry validated with value or entry scope");
			}

			return run((tx) => remove(tx, entry, shape).then(id => dispatch(id, false)));

		},


		listen(listener: StoreListener, resources?: Reference | readonly Reference[]): () => void {

			if ( Array.isArray(resources) && resources.length === 0 ) {

				listeners.delete(listener);

			} else {

				listeners.set(
					listener, resources === undefined ? []
						: isString(resources) ? [resources]
							: [...resources]
				);

			}

			return () => { listeners.delete(listener); };

		},

		close(): Promise<void> {

			listeners.clear();

			return Promise.resolve();

		},


		execute<V>(task: (store: Store) => V | Promise<V>): Promise<V> {

			return run(() => task(store));

		}

	});


	return store;


	function run<V>(task: (txn: Transaction) => V | Promise<V>): Promise<V> {

		if ( active ) {

			return Promise.resolve(task(active));

		} else {

			return db.transaction(async (tx) => {

				try {

					return await task(active = tx);

				} finally {

					active = undefined;

				}

			}).then(result => {

				if ( mutations.size > 0 ) {

					const batch = Object.fromEntries(mutations);

					new Map(listeners).forEach((resources, listener) => {

						// filter batch to matching resources

						const event = resources.length === 0 ? batch : Object.fromEntries(
							Object.entries(batch).filter(([id]) =>
								resources.some(r => nests(r, id))
							)
						);

						if ( Object.keys(event).length > 0 ) {

							try { listener(event); } catch { /* listener failures are silently ignored */ }

						}

					});

				}

				return result;

			}).finally(() => {

				mutations.clear();

			});

		}

	}

	function dispatch(id: undefined | Reference, exists: boolean): undefined | Reference {

		if ( id !== undefined ) {
			mutations.set(id, exists);
		}

		return id;

	}

}
