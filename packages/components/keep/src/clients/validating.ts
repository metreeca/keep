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
 * Validating store wrapper.
 *
 * Wraps a plain {@link StoreClient} with shape-driven validation of entries, models, and states
 * before delegating, and optional re-validation of retrieval responses.
 *
 * @module
 */

import { validate } from "@metreeca/blue";
import type { Delivery } from "@metreeca/blue/value";
import type { Optional } from "@metreeca/core";
import { immutable } from "@metreeca/core/structures";
import { TraceError } from "@metreeca/core/trace";

import { isReference, type Reference } from "@metreeca/qest/state";

import type { Store, StoreClient } from "../index.js";


/**
 * Creates a validating store backed by a delegate.
 *
 * Each method validates the relevant inputs against the supplied shape before delegating to `store`:
 *
 * - `entry` is checked for absolute-IRI form (no query string, no fragment) — failures rejected as `RangeError`
 * - `state.id`, when present, is checked for equality with `entry` — mismatches rejected as `RangeError`, since
 *   the entry identifies the target and a contradicting payload identity is a caller error
 * - `model` is validated as a {@link @metreeca/blue!validate | template} for
 *   {@link StoreClient.lookup lookup}, with the `lookup` `plain`/`depth`/`limit` opts forwarded as
 *   query-complexity caps
 * - `state` is validated as a resource for {@link StoreClient.create create}/
 *   {@link StoreClient.update update}/{@link StoreClient.insert insert}; `create` and
 * `update` always cap captive expansion at depth `0` (inline captive batches rejected), while `insert` honours its
 * `depth` opt
 *   (omitted leaves expansion unbounded)
 *
 * The `trusted` opt controls whether {@link StoreClient.lookup lookup} responses are re-validated
 * against the shape narrowed by the caller's `model` template before surfacing. Defaults to `false`
 * — connectors whose backing source isn't trusted to deliver shape-conforming data (for example, a
 * remote REST endpoint) get the safe default. Local stores that compute results themselves should
 * pass `trusted: true` to skip the redundant pass.
 *
 * Validation failures surface as {@link @metreeca/core!TraceError | TraceError} or `RangeError` rejections per the
 * unified {@link Store} error channel.
 *
 * @param store - Inner StoreClient to delegate to after validation
 * @param options - Optional validation options
 * @param options.trusted - When `true`, skips re-validation of the {@link StoreClient.lookup lookup}
 *     response against the shape narrowed by the caller's `model`; defaults to `false`
 *
 * @returns An immutable {@link StoreClient} wrapping `store` with input validation
 */
export function createValidatingStore(store: StoreClient, {

	trusted = false

}: {

	readonly trusted?: boolean

} = {}): StoreClient {

	return immutable({

		async lookup({ entry, shape, model }, opts) {

			return store.lookup({

				entry: assertEntry(entry),
				shape,

				model: validate<typeof model>(model, { ...opts, shape, model: true })({
					value: value => value,
					trace: trace => { throw new TraceError("invalid model", trace ?? []); }
				})

			}, opts).then(result => {

				// ;(cast) blue validates the response against the very shape and model the store was given, so the
				// value it hands back is the requested instance; blue resolves the leaf types from the shape while
				// the store's own signature still reads them off the model (see `_inference.ts`)

				return (trusted || result === undefined ? immutable(result) : validate(result, { shape, model })({
					value: value => value,
					trace: trace => { throw new TraceError("invalid response", trace ?? []); }
				})) as Optional<Delivery<typeof shape, typeof model>>;

			});

		},


		async create({ entry, shape, state }) {

			return store.create({

				entry: assertEntry(entry),
				shape,

				state: validate(state, { shape, depth: 0 })({
					value: value => value,
					trace: trace => { throw new TraceError("invalid state", trace ?? []); }
				})

			});

		},

		async update({ entry, shape, state }) {

			return store.update({

				entry: assertEntry(entry),
				shape,

				state: validate(state, { shape, depth: 0 })({
					value: value => value,
					trace: trace => { throw new TraceError("invalid state", trace ?? []); }
				})

			});

		},

		async delete({ entry, shape }) {

			return store.delete({ entry: assertEntry(entry), shape });

		},


		async insert({ entry, shape, state }, opts) {

			return store.insert({

				entry: assertEntry(entry),
				shape,

				state: validate(state, { ...opts, shape })({
					value: value => value,
					trace: trace => { throw new TraceError("invalid state", trace ?? []); }
				})

			}, opts);

		},

		async remove({ entry, shape }) {

			return store.remove({

				entry: assertEntry(entry),
				shape

			});

		}

	});


	function assertEntry(entry: Reference): Reference {

		if ( !isReference(entry) ) {
			throw new RangeError(`expected absolute IRI <${entry}>`);
		}

		if ( entry.includes("?") || entry.includes("#") ) {
			throw new RangeError(`unexpected query or fragment in <${entry}>`);
		}

		return entry;

	}

}
