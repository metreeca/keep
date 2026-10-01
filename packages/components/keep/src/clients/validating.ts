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
 * Guards a {@link StoreClient} against malformed requests, checking entries, models and states against the request
 * shape before they reach the backend. Retrieval responses from untrusted sources can be re-validated as well.
 *
 * @module
 */

import { validate } from "@metreeca/blue";
import type { ResourceShape } from "@metreeca/blue/resource";
import { blueprint, type Match } from "@metreeca/blue/value";
import { error, type Lazy, type Optional } from "@metreeca/core";
import { isNestedIRI } from "@metreeca/core/resource";
import { TraceError } from "@metreeca/core/trace";
import { immutable } from "@metreeca/core/values";
import type { Template } from "@metreeca/qest/model";
import { isReference, type Reference, type Resource } from "@metreeca/qest/state";
import type { Store, StoreClient, StoreScope } from "../index.js";


/**
 * Creates a validating store backed by a delegate.
 *
 * Each method validates its inputs against the supplied shape before forwarding the request to `store`:
 *
 * - `entry` must be an absolute IRI with no query string and no fragment; otherwise the request is rejected with a
 *   {@link !RangeError RangeError}
 * - `model` is validated as a {@link @metreeca/blue!validate | template} for {@link StoreClient.lookup lookup},
 *   within the query-complexity bounds (`plain`, `depth`, `limit`) of the caller's
 *   {@link StoreScope | retrieval scope}, and as a collection slice for {@link StoreClient.create create}
 * - `state.id`, if present, must be nested under `entry` for {@link StoreClient.create create}, and equal to `entry`
 *   for {@link StoreClient.update update} and {@link StoreClient.insert insert}; otherwise the request is rejected
 *   with a {@link !RangeError RangeError}
 * - `state` is validated as a resource with captive expansion capped at depth `0`, so inline captive batches are
 *   rejected; {@link StoreClient.create create} validates it against the shape of the collected resources, and
 *   {@link StoreClient.update update} and {@link StoreClient.insert insert} against the supplied shape
 *
 * The `trusted` option controls whether {@link StoreClient.lookup lookup} responses are re-validated against the
 * shape, as narrowed by the caller's `model`. It defaults to `false`, the safe choice for connectors whose source may
 * deliver non-conforming data, such as a remote REST endpoint. Local stores that compute results themselves can pass
 * `trusted: true` to skip the redundant check.
 *
 * Validation failures surface as {@link @metreeca/core!TraceError | TraceError} or {@link !RangeError RangeError}
 * rejections, in line with the unified {@link Store} error channel.
 *
 * @param store - Inner StoreClient receiving the validated requests
 * @param options - Optional validation options
 *
 * @returns An immutable {@link StoreClient} wrapping `store` with input validation
 */
export function createValidatingStore(store: StoreClient, {

	trusted = false

}: {

	/**
	 * Whether to skip re-validation of {@link StoreClient.lookup lookup} responses against the shape, as narrowed by
	 * the caller's `model`.
	 *
	 * @defaultValue `false`, treating the wrapped store as untrusted
	 */
	readonly trusted?: boolean

} = {}): StoreClient {

	return immutable({

		async lookup({ entry, shape, model }, opts) {

			return store.lookup({

				entry: assertEntry(entry),
				shape,

				model: assertModel(model, shape, opts)

			}, opts).then(result => {

				// ;(cast) blue types the validated copy by its own `Delivery` inference rather than by the `Match`
				// the store states; the copy is returned, rather than the raw response, as it carries the verdict

				return (trusted || result === undefined ? immutable(result) : validate(result, { shape, model })({
					value: value => value,
					trace: trace => { throw new TraceError("invalid response", trace ?? []); }
				})) as Optional<Match<typeof shape, typeof model>>;

			});

		},

		async create({ entry, shape, model, state }) {

			const $entry = assertEntry(entry);

			const $model = validate<typeof model>(model, { shape, model: true })({
				value: value => value,
				trace: trace => { throw new TraceError("invalid model", trace ?? []); }
			});

			// the new resource is validated against the shape the collecting property ranges over, and a stated
			// identifier is held to the collection it is created through

			const plan = blueprint(shape, $model);
			const { id }: Resource = state;

			const $state: typeof state = id === undefined || isReference(id) && isNestedIRI($entry, id) ? state
				: error(new RangeError(`state id <${String(id)}> not nested under entry <${entry}>`));

			// the validator hands back the state itself where it passes, so the typed input is relayed as it
			// stands once the check has run, the blueprint being resolved at runtime rather than typed

			validate($state, { shape: plan, depth: 0 })({
				value: () => undefined,
				trace: trace => { throw new TraceError("invalid state", trace ?? []); }
			});

			return store.create({ entry: $entry, shape, model: $model, state: $state });

		},

		async update({ entry, shape, state }) {

			const $entry = assertEntry(entry);

			return store.update({

				entry: $entry,
				shape,

				state: validate(assertIdentity($entry, state), { shape, depth: 0 })({
					value: () => state,
					trace: trace => { throw new TraceError("invalid state", trace ?? []); }
				})

			});

		},

		async delete({ entry, shape }) {

			return store.delete({ entry: assertEntry(entry), shape });

		},


		async insert({ entry, shape, state }) {

			const $entry = assertEntry(entry);

			return store.insert({

				entry: $entry,
				shape,

				state: validate(assertIdentity($entry, state), { shape, depth: 0 })({
					value: () => state,
					trace: trace => { throw new TraceError("invalid state", trace ?? []); }
				})

			});

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

	function assertIdentity<T extends Resource>(entry: Reference, state: T): T {

		const { id }: Resource = state;

		return id === undefined || id === entry ? state
			: error(new RangeError(`mismatched state id <${String(id)}> for entry <${entry}>`));

	}

	function assertModel<T extends Template>(model: T, shape: Lazy<ResourceShape>, opts: StoreScope = {}): T {

		return validate<T>(model, { ...opts, shape, model: true })({
			value: value => value,
			trace: trace => { throw new TraceError("invalid model", trace ?? []); }
		});

	}

}
