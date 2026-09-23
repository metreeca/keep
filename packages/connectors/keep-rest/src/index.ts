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
 * REST/JSON proxy connector.
 *
 * Exposes the {@link createRESTStore} factory, returning an immutable store that forwards every
 * {@link Store} call to a remote REST endpoint. Callers see the same {@link Store} surface as every other connector,
 * with each operation round-tripped to the service rather than applied to a local backing store.
 *
 * | Operation | HTTP | `Prefer` | Behaviour | Validated |
 * |---|---|---|---|---|
 * | {@link Store.lookup lookup} | `GET` | — | Template in query string; `404` → `undefined` | `model`, response
 * |
 * | {@link Store.create create} | `POST` | — | Child IRI from `Location` header; `409` → `undefined` | `state` |
 * | {@link Store.update update} | `PUT` | — | Conditional; `404` → `undefined` | `state` |
 * | {@link Store.delete delete} | `DELETE` | — | Conditional; `404` → `undefined` | — |
 * | {@link Store.insert insert} | `PUT` | `handling=lenient` | Unconditional upsert | `state` |
 * | {@link Store.remove remove} | `DELETE` | `handling=lenient` | Unconditional; `404` silently ignored | — |
 *
 * > [!IMPORTANT]
 * > Each HTTP verb is shared by a conditional and an unconditional method, disambiguated through the RFC 7240
 * > `Prefer` request header:
 * >
 * > - **Conditional** ({@link Store.update update} via `PUT`, {@link Store.delete delete} via `DELETE`)
 * send bare
 * >   requests, so the server rejects a missing target with `404`.
 * > - **Unconditional** ({@link Store.insert insert} via `PUT`, {@link Store.remove remove} via `DELETE`)
 * send
 * >   `Prefer: handling=lenient`, so a `PUT` against a missing resource becomes an upsert and a `DELETE` against one
 * >   succeeds silently.
 * >
 * > Servers that ignore the header degrade to the conditional `404` behaviour.
 *
 * Beyond the per-operation miss codes tabulated above, every other failure surfaces as a
 * {@link @metreeca/http!Problem | Problem} rejection: non-OK responses as well as protocol anomalies on
 * otherwise-successful responses (a missing `Location` header, a malformed response body). Callers therefore observe
 * a single rejection type for all error origins.
 *
 * {@link Store.create create} resolves the returned `Location` against the request `entry` per RFC 3986 § 5.2
 * and
 * returns it verbatim, including across origins: the proxy applies no same-origin or path-containment check, so
 * callers MUST trust the service's choice of child IRI. Standard merge semantics apply, so an `entry` without a
 * trailing `/` strips its last path segment before merging. An unparseable `Location` surfaces as a `RangeError`
 * rather than a {@link @metreeca/http!Problem | Problem}.
 *
 * {@link Store.lookup lookup} encodes its `model` as a URL-safe base64 query string, so any template (filter
 * operators such as `~name` and `>=price`, nested shapes, aggregates) survives transport intact; an empty template
 * omits the query string.
 *
 * > [!IMPORTANT]
 * > `entry` parameters MUST be bare absolute IRIs with no query string (`?…`) or fragment (`#…`): a query string
 * > would collide with the base64 template appended by {@link Store.lookup lookup}, and a fragment would be
 * stripped
 * > by `fetch` before the request reached the wire. The wrapping
 * > {@link createValidatingStore} rejects non-conforming entries with a
 * > `RangeError` on every method.
 *
 * The wrapping {@link createValidatingStore} validates inputs
 * (`model` on {@link Store.lookup lookup}, `state` on every mutation) against the shape before the network
 * call. Because the remote endpoint is untrusted, {@link Store.lookup lookup} responses are re-validated
 * locally against the shape narrowed by the caller's `model`. Failures reject with a
 * {@link @metreeca/core!TraceError | TraceError} carrying `"invalid model"`, `"invalid state"`, or
 * `"invalid response"`, per the unified {@link Store} error channel.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc3986 RFC 3986 — URI Generic Syntax}
 * @see {@link https://www.rfc-editor.org/rfc/rfc7240 RFC 7240 — Prefer Header for HTTP}
 * @see {@link https://www.rfc-editor.org/rfc/rfc9110 RFC 9110 — HTTP Semantics}
 *
 * @group Connectors
 *
 * @module
 */

import { isError, isObject } from "@metreeca/core";
import type { Tag } from "@metreeca/core/language";
import { getIRIBase, resolve } from "@metreeca/core/resource";
import { immutable } from "@metreeca/core/values";
import { createFetch } from "@metreeca/http";
import { type Problem, success } from "@metreeca/http/success";
import { transport } from "@metreeca/http/transport";
import type { Store } from "@metreeca/keep";
import { createManagingStore } from "@metreeca/keep/managing";
import { createValidatingStore } from "@metreeca/keep/validating";
import { encodeResource } from "@metreeca/qest/state";
import { encodeTemplate } from "@metreeca/qest/model";


/**
 * Creates a REST proxy store backed by a remote REST service.
 *
 * Exposes a remote REST service through the standard {@link Store} API, so an application drives it with the same
 * calls as any local backend. Each operation round-trips to the service over `fetch`; observers see only mutations
 * issued through this store, and the module description carries the full request/response contract, validation rules,
 * and miss-code handling.
 *
 * > [!IMPORTANT]
 * > **Transaction Isolation** — None. REST has no native transaction support; operations apply eagerly with
 * > no cross-call isolation, and a {@link Store.execute execute} task that throws after
 * > partial server-side mutations does not roll them back.
 *
 * > [!IMPORTANT]
 * > **Mutation Events** — Limited to mutations issued through this store; mutations from other clients
 * > sharing the remote service are not observed.
 *
 * @param fetch - Fetch-compatible transport used for every HTTP request; defaults to the global
 *   `fetch`
 * @param options - Optional proxy options
 *
 * @returns An immutable {@link Store} whose methods round-trip every call to the remote
 *   REST service
 */
export function createRESTStore(fetch: typeof globalThis.fetch = globalThis.fetch, {

	trusted = false

}: {

	/**
	 * Whether to skip re-validation of {@link Store.lookup lookup} responses against the projected shape.
	 *
	 * @defaultValue `false`, treating the remote endpoint as untrusted
	 */
	readonly trusted?: boolean

} = {}): Store {

	const remote = createFetch(success(), transport(fetch));


	return createManagingStore(createValidatingStore(immutable({

		lookup({ entry, model }, opts) {

			const url = Object.keys(model).length === 0 ? entry
				: `${entry}?${encodeTemplate(model, { base: getIRIBase(entry), format: "base64" })}`;

			return remote(url, {

				method: "GET",

				headers: {
					"Accept": "application/json",
					...(opts?.locale?.length ? { "Accept-Language": acceptLanguage(opts.locale) } : {})
				}

			}).then(response => {

				return response.json().catch(e => {
					throw immutable<Problem>({
						detail: `malformed JSON in response to GET <${entry}>: ${isError(e) ? e.message : String(e)}`
					});
				});

			}).catch(e => {

				return isProblem(e, 404) ? undefined : Promise.reject(e);

			});

		},


		create({ entry, state }) {

			return remote(entry, {

				method: "POST",

				headers: {
					"Content-Type": "application/json"
				},

				body: encodeResource(state, { base: getIRIBase(entry) })

			}).then(response => {

				const location = response.headers.get("Location");

				if ( location === null ) {
					throw immutable<Problem>({ detail: `missing <Location> header in response to POST <${entry}>` });
				}

				return resolve(entry, location);

			}).catch(e => {

				return isProblem(e, 409) ? undefined : Promise.reject(e);

			});

		},

		update({ entry, state }) {

			return remote(entry, {

				method: "PUT",

				headers: {
					"Content-Type": "application/json"
				},

				body: encodeResource(state, { base: getIRIBase(entry) })

			}).then(() => {

				return entry;

			}).catch(e => {

				return isProblem(e, 404) ? undefined : Promise.reject(e);

			});

		},

		delete({ entry }) {

			return remote(entry, {

				method: "DELETE"

			}).then(() => {

				return entry;

			}).catch(e => {

				return isProblem(e, 404) ? undefined : Promise.reject(e);

			});

		},


		insert({ entry, state }) {

			return remote(entry, {

				method: "PUT",

				headers: {
					"Content-Type": "application/json",
					"Prefer": "handling=lenient"
				},

				body: encodeResource(state, { base: getIRIBase(entry) })

			}).then(() => {

				return entry;

			}).catch(e => {

				return Promise.reject(e); // unconditional insert — all errors propagate as-is

			});

		},

		remove({ entry }) {

			return remote(entry, {

				method: "DELETE",

				headers: {
					"Prefer": "handling=lenient"
				}

			}).then(() => {

				return entry;

			}).catch(e => {

				return isProblem(e, 404) ? entry : Promise.reject(e); // unconditional remove — 404 is a silent no-op

			});

		}

	}), {

		trusted

	}));


	/**
	 * Tests whether a caught value is a {@link @metreeca/http!Problem | Problem} carrying the given HTTP status.
	 *
	 * Used by the per-method `.catch` branches to tell expected miss codes (`404`, `409`) apart
	 * from every other {@link @metreeca/http!Problem | Problem}. {@link @metreeca/http!Problem | Problem} is an
	 * interface rather than a class, so any object with a matching numeric `status` property is accepted; this is sound
	 * because {@link @metreeca/http!createFetch | createFetch} is the only error source in scope and always throws
	 * {@link @metreeca/http!Problem | Problem}-shaped values.
	 *
	 * @param error - Value caught from a proxy `.catch` branch
	 * @param status - HTTP status code to match against
	 *
	 * @returns `true` if `error` is an object whose `status` matches the expected code; `false`
	 *     otherwise
	 */
	function isProblem(error: unknown, status: number): boolean {
		return isObject(error) && error.status === status;
	}

	/**
	 * Builds an RFC 9110 `Accept-Language` header value from a locale priority list.
	 *
	 * Assigns each tag a descending quality factor by its position and appends a `*` wildcard fallback at the lowest
	 * factor so the server always has an acceptable last resort. With `total` set to `locale.length + 1` (reserving
	 * the lowest rung for the wildcard), the tag at position `k` weighs `(total - k) / total` and `*` weighs
	 * `1 / total`, each rounded to three decimal places. Every range carries an explicit `q`, including the
	 * most-preferred tag (`q=1`).
	 *
	 * @param locale - Non-empty language-negotiation priority list, most-preferred first
	 *
	 * @returns A comma-separated `Accept-Language` value carrying descending `q` weights and a trailing `*` fallback
	 *
	 * @see {@link https://www.rfc-editor.org/rfc/rfc9110#name-accept-language RFC 9110 § 12.5.4 Accept-Language}
	 */
	function acceptLanguage(locale: readonly Tag[]): string {

		const total = locale.length+1; // +1 reserves the lowest rung for the `*` wildcard fallback

		return [
			...locale.map((tag, index) => weighted(tag, (total-index)/total)),
			weighted("*", 1/total)
		].join(", ");

	}

	/**
	 * Formats a language range with an explicit quality factor.
	 *
	 * @param range   - Language tag or the `*` wildcard
	 * @param quality - Quality factor in `(0, 1]`, rendered with up to three decimal places
	 *
	 * @returns The `range;q=<quality>` token
	 */
	function weighted(range: string, quality: number): string {
		return `${range};q=${Number(quality.toFixed(3))}`;
	}

}
