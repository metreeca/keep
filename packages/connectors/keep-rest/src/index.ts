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
 * Gives an application access to a remote REST service through the standard {@link Store} API.
 * {@link createRESTStore} returns a store with the same surface as every other connector. Each data operation is
 * round-tripped to the service rather than applied to a local backing store.
 *
 * | Operation | HTTP | `Prefer` | Behaviour | Validated |
 * |---|---|---|---|---|
 * | {@link Store.lookup lookup} | `GET` | — | Template in query string; `404` → `undefined` | `model`, response |
 * | {@link Store.create create} | `POST` | — | Child IRI from `Location`; `409` → `undefined` | `model`, `state` |
 * | {@link Store.update update} | `PUT` | — | Conditional; `404` → `undefined` | `state` |
 * | {@link Store.delete delete} | `DELETE` | — | Conditional; `404` → `undefined` | — |
 * | {@link Store.insert insert} | `PUT` | `handling=lenient` | Unconditional upsert | `state` |
 * | {@link Store.remove remove} | `DELETE` | `handling=lenient` | Unconditional; `404` silently ignored | — |
 *
 * > [!IMPORTANT]
 * > Each mutating HTTP verb is shared by a conditional and an unconditional method, disambiguated through the
 * > RFC 7240 `Prefer` request header:
 * >
 * > - **Conditional** ({@link Store.update update} via `PUT`, {@link Store.delete delete} via `DELETE`) send bare
 * >   requests, so the server rejects a missing target with `404`.
 * > - **Unconditional** ({@link Store.insert insert} via `PUT`, {@link Store.remove remove} via `DELETE`) send
 * >   `Prefer: handling=lenient`, so a `PUT` against a missing resource becomes an upsert and a `DELETE` against one
 * >   succeeds silently.
 * >
 * > Servers that ignore the header degrade to the conditional behaviour: {@link Store.insert insert} against a
 * > missing resource then rejects with a `404` {@link @metreeca/http!Problem | Problem}.
 *
 * Beyond the per-operation miss codes tabulated above, every remote failure surfaces as a
 * {@link @metreeca/http!Problem | Problem} rejection. This covers non-OK responses as well as protocol anomalies on
 * otherwise successful responses, such as a missing `Location` header or a malformed response body. Callers therefore
 * handle every remote failure through a single rejection type.
 *
 * {@link Store.create create} posts only the `state` of the new resource. The `model` slice naming the collecting
 * property is validated locally but not sent, so the service identifies the collection from `entry` alone.
 *
 * {@link Store.create create} resolves the returned `Location` against the request `entry` per RFC 3986 § 5.2.
 * Standard merge semantics apply, so an `entry` without a trailing `/` strips its last path segment before merging.
 * The resolved IRI must lie strictly below the container `entry` resolves to, that is `entry` itself when it ends
 * with `/` and its parent otherwise: a `Location` outside that scope, whether on a foreign origin or elsewhere on the
 * same one, rejects with a {@link @metreeca/http!Problem | Problem}, so a misbehaving service can't make the caller
 * adopt a foreign child IRI. An unparseable `Location` surfaces as a {@link !RangeError RangeError} rather than a
 * {@link @metreeca/http!Problem | Problem}.
 *
 * {@link Store.lookup lookup} carries its `model` as a base64url query string, so any template (filter operators
 * such as `~name` and `>=price`, nested shapes, aggregates, collection pagination) survives transport intact. An
 * empty template omits the query string. The scope `locale` is forwarded as an `Accept-Language` header, with a
 * trailing `*` fallback so the service may answer in any language when none of the listed ones is available.
 *
 * IRIs on the origin of `entry` travel in root-relative form (`/…`), both in request templates and states and in
 * {@link Store.lookup lookup} responses. Root-relative references in a response are resolved against the origin of
 * `entry`, so the service may return them in place of absolute IRIs. Any other relative reference is rejected by
 * response validation.
 *
 * > [!IMPORTANT]
 * > `entry` parameters MUST be bare absolute IRIs with no query string (`?…`) or fragment (`#…`). A query string
 * > would collide with the template carried by {@link Store.lookup lookup}, and a fragment would be stripped by
 * > {@link !fetch fetch} before the request reached the wire. Non-conforming entries are rejected with a
 * > {@link !RangeError RangeError} on every method.
 *
 * Inputs are validated against the shape before the network call: `model` on {@link Store.lookup lookup} and
 * {@link Store.create create}, `state` on every mutation carrying one. The query-complexity bounds of the
 * {@link StoreScope | retrieval scope} are also enforced locally, so a rejected template never reaches the service.
 * Because the remote endpoint is untrusted by default, {@link Store.lookup lookup} responses are also validated
 * against the shape narrowed by the caller's `model`. Failures reject with a
 * {@link @metreeca/core!TraceError | TraceError} carrying `"invalid model"`, `"invalid state"`, or
 * `"invalid response"`, per the unified {@link Store} error channel.
 *
 * @see {@link https://www.rfc-editor.org/rfc/rfc3986 RFC 3986 — URI Generic Syntax}
 * @see {@link https://www.rfc-editor.org/rfc/rfc7240 RFC 7240 — Prefer Header for HTTP}
 * @see {@link https://www.rfc-editor.org/rfc/rfc9110 RFC 9110 — HTTP Semantics}
 *
 * @group Connectors
 *
 * @module index
 */

import { isError, isObject, type Optional } from "@metreeca/core";
import type { Tag } from "@metreeca/core/language";
import { getIRIBase, resolve } from "@metreeca/core/resource";
import { immutable } from "@metreeca/core/values";
import { Conflict, createFetch, NotFound } from "@metreeca/http";
import { type Problem, success } from "@metreeca/http/success";
import { transport } from "@metreeca/http/transport";
import type { Store, StoreScope } from "@metreeca/keep";
import { createManagingStore } from "@metreeca/keep/managing";
import { createValidatingStore } from "@metreeca/keep/validating";
import { encodeTemplate, type Template } from "@metreeca/qest/model";
import { decodeResource, encodeResource } from "@metreeca/qest/state";


/**
 * Creates a REST proxy store backed by a remote REST service.
 *
 * Exposes a remote REST service through the standard {@link Store} API, so an application drives it with the same
 * calls as any local backend. Each data operation round-trips to the service over the configured `fetch` transport.
 * The module description details the request and response contract, the validation rules and the miss-code handling.
 *
 * > [!IMPORTANT]
 * > **Transaction Isolation** — None. REST has no native transaction support: operations apply eagerly with no
 * > cross-call isolation, and a {@link Store.execute execute} task that throws after partial server-side mutations
 * > does not roll them back.
 *
 * > [!IMPORTANT]
 * > **Mutation Events** — Limited to mutations issued through this store; mutations from other clients sharing the
 * > remote service are not observed.
 *
 * @param options - Optional proxy options
 *
 * @returns An immutable {@link Store} proxying the remote REST service
 */
export function createRESTStore({

	trusted = false,

	fetch = globalThis.fetch

}: {

	/**
	 * Whether to accept {@link Store.lookup lookup} responses without validating them against the shape narrowed by
	 * the caller's `model`.
	 *
	 * Enabling it suits only a service trusted to deliver shape-conforming data, as responses then reach the caller
	 * unchecked.
	 *
	 * @defaultValue `false`, treating the remote endpoint as untrusted
	 */
	readonly trusted?: boolean

	/**
	 * {@link !fetch fetch}-compatible transport used for every HTTP request.
	 *
	 * A configured client adds authentication, custom headers, or other cross-cutting request handling.
	 *
	 * @defaultValue The global {@link !fetch fetch}
	 */
	readonly fetch?: typeof globalThis.fetch

} = {}): Store {

	const remote = createFetch(success(), transport(fetch));


	function retrieve(entry: string, model: Template, opts: Optional<StoreScope>) {

		const url = Object.keys(model).length === 0 ? entry
			: `${entry}?${encodeTemplate(model, { base: getIRIBase(entry), format: "base64" })}`;

		return remote(url, {

			method: "GET",

			headers: {
				"Accept": "application/json",
				...(opts?.locale?.length ? { "Accept-Language": acceptLanguage(opts.locale) } : {})
			}

		}).then(response => {

			// ;(cast) the decoded body is only resolved, not checked: the wrapping validating store validates it
			// against the requested shape and model, unless the endpoint is trusted to deliver conforming data

			return response.text().then(json => decodeResource(json, {

				lenient: true,
				base: getIRIBase(entry)

			}) as never).catch(e => {

				throw immutable<Problem>({
					detail: `malformed JSON in response to GET <${entry}>: ${isError(e) ? e.message : String(e)}`
				});

			});

		}).catch(e => {

			return isProblem(e, NotFound) ? undefined : Promise.reject(e);

		});

	}


	return createManagingStore(createValidatingStore(immutable({

		lookup({ entry, model }, opts) {

			return retrieve(entry, model, opts);

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

				const iri = resolve(entry, location);
				const container = resolve(entry, ".");

				if ( iri === container || !iri.startsWith(container) ) {
					throw immutable<Problem>({
						detail: `out-of-scope <Location> header <${iri}> in response to POST <${entry}>`
					});
				}

				return iri;

			}).catch(e => {

				return isProblem(e, Conflict) ? undefined : Promise.reject(e);

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

				return isProblem(e, NotFound) ? undefined : Promise.reject(e);

			});

		},

		delete({ entry }) {

			return remote(entry, {

				method: "DELETE"

			}).then(() => {

				return entry;

			}).catch(e => {

				return isProblem(e, NotFound) ? undefined : Promise.reject(e);

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

				return isProblem(e, NotFound) ? entry : Promise.reject(e); // unconditional remove — 404 is a silent
																		   // no-op

			});

		}

	}), {

		trusted

	}));


	/**
	 * Tests whether a caught value is a {@link @metreeca/http!Problem | Problem} carrying the given HTTP status.
	 *
	 * Tells expected miss codes (`404`, `409`) apart from every other {@link @metreeca/http!Problem | Problem}.
	 * {@link @metreeca/http!Problem | Problem} is an interface rather than a class, so any object with a matching
	 * numeric `status` property is accepted. This is sound because {@link @metreeca/http!createFetch | createFetch} is
	 * the only source of status-carrying errors in scope, and it always throws
	 * {@link @metreeca/http!Problem | Problem}-shaped values.
	 *
	 * @param error - Value caught from a proxy `.catch` branch
	 * @param status - HTTP status code to match against
	 *
	 * @returns true if `error` is an object whose `status` matches the expected code; false otherwise
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
