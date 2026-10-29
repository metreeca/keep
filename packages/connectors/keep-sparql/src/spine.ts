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
 * Pass spine.
 *
 * Runs a batch of requests through one repository operation and settles each request on its own. A pass supplies the
 * operation text and the decoder of one request, while the spine provides what every pass shares:
 *
 *  - a variable scope that encoder and decoder agree on;
 *  - a single round trip per batch;
 *  - the solution rows of each request, selected by the entry they bind;
 *  - the nested requests a {@link Decoded | decoded value} depends on, run through the {@link Broker};
 *  - failure isolation: a failing operation rejects the requests it served and no other, and the handler always
 *    settles normally, so one failure never aborts the batching run or the requests of other batches in it.
 *
 * Decoders are pure: they turn solution rows into a {@link Decoded | decoded value} and never issue a request. The
 * spine runs the nested requests the value needs and completes it, so a decoder can be tested from literal rows and
 * literal responses alone, with no broker to mock and no repository to query against.
 *
 * @module
 */

import { createScope, type Scope } from "@metreeca/core/scope";
import type { Broker, Deferred, Detail, Request, Response, Select } from "@metreeca/keep/batching";
import type { Reference, Resource, Value } from "@metreeca/qest/state";
import { type RepositoryClient, type SPARQL, type Tuple, type Variable, variable } from "@metreeca/wire-sparql";


/**
 * A decoded value awaiting the responses of the nested requests it depends on.
 *
 * A decoder returns the requests it could not answer from its own rows and the function completing the value once their
 * responses are in hand: the resources the detail requests materialise and the collections the select requests
 * materialise, each list in the order of its requests. A value depending on no request is complete as it is. Decoded
 * values compose: {@link all} gathers a list of them and {@link map} converts one, so a decoder builds its value bottom
 * up and leaves running the requests to the spine, which does so once for the whole value.
 *
 * @typeParam T The decoded value type
 */
export type Decoded<T> = {

	/**
	 * The resources to materialise through the detail pass before the value can be completed.
	 */
	readonly details: readonly Detail[];

	/**
	 * The collections to materialise through the select pass before the value can be completed.
	 */
	readonly selects: readonly Select[];

	/**
	 * Completes the value from the responses of the nested requests, in request order.
	 */
	readonly build: (resources: readonly Resource[], collections: readonly (readonly Value[])[]) => T;

};


/**
 * The pass-specific half of a reading pass.
 *
 * @typeParam R The request kind the pass serves
 */
export type Reading<R extends Request> = {

	/**
	 * Encodes the `select` query reading the whole batch, or nothing when the batch's plan reads nothing.
	 */
	readonly encode: (scope: Scope<Variable>) => undefined | SPARQL;

	/**
	 * The column binding the entry a solution row belongs to.
	 */
	readonly owner: (scope: Scope<Variable>) => Variable;

	/**
	 * Decodes one request from the solution rows binding its own entry, in solution order, into the response the
	 * request's kind defines, awaiting the nested requests the spine runs before settling it.
	 */
	readonly decode: (scope: Scope<Variable>, item: Deferred<R>, rows: readonly Tuple[]) => Decoded<Response<R>>;

};

/**
 * The pass-specific half of a writing pass.
 *
 * @typeParam R The request kind the pass serves
 */
export type Writing<R extends Request> = {

	/**
	 * Encodes the update applying the whole batch.
	 */
	readonly encode: (scope: Scope<Variable>) => SPARQL;

	/**
	 * Decodes one request into the response the request's kind defines, once the update has been applied.
	 */
	readonly decode: (scope: Scope<Variable>, item: Deferred<R>) => Response<R>;

};


/**
 * Creates a decoded value that depends on no request.
 *
 * @typeParam T The value type
 *
 * @param value The value
 *
 * @returns The decoded value, depending on no request
 */
export function plain<T>(value: T): Decoded<T> {
	return { details: [], selects: [], build: () => value };
}

/**
 * Creates a decoded value read off a resource the detail pass materialises.
 *
 * @typeParam T The value type
 *
 * @param request The detail request materialising the resource
 * @param read Reads the value off the materialised resource
 *
 * @returns The decoded value, depending on `request`
 */
export function resource<T>(request: Detail, read: (resource: Resource) => T): Decoded<T> {
	return { details: [request], selects: [], build: ([resource]) => read(resource) };
}

/**
 * Creates a decoded value read off a collection the select pass materialises.
 *
 * @typeParam T The value type
 *
 * @param request The select request materialising the collection
 * @param read Reads the value off the materialised collection
 *
 * @returns The decoded value, depending on `request`
 */
export function collection<T>(request: Select, read: (values: readonly Value[]) => T): Decoded<T> {
	return { details: [], selects: [request], build: (_, [values]) => read(values) };
}

/**
 * Gathers decoded values into one decoded list.
 *
 * @typeParam T The value type
 *
 * @param items The decoded values to gather
 *
 * @returns The decoded list of the values of `items`, in order, depending on every request they depend on
 */
export function all<T>(items: readonly Decoded<T>[]): Decoded<readonly T[]> {

	return {

		details: items.flatMap(({ details }) => details),
		selects: items.flatMap(({ selects }) => selects),

		build: (resources, collections) => items.reduce<{

			readonly values: readonly T[];
			readonly details: number;
			readonly selects: number

		}>(({ values, details, selects }, item) => ({

			values: [...values, item.build(
				resources.slice(details, details + item.details.length),
				collections.slice(selects, selects + item.selects.length)
			)],

			details: details + item.details.length,
			selects: selects + item.selects.length

		}), { values: [], details: 0, selects: 0 }).values

	};

}

/**
 * Converts a decoded value.
 *
 * @typeParam T The value type
 * @typeParam U The converted value type
 *
 * @param decoded The decoded value to convert
 * @param mapper Converts the completed value
 *
 * @returns The decoded converted value, depending on the requests `decoded` depends on
 */
export function map<T, U>({ details, selects, build }: Decoded<T>, mapper: (value: T) => U): Decoded<U> {
	return { details, selects, build: (resources, collections) => mapper(build(resources, collections)) };
}


/**
 * Runs a reading pass over a batch.
 *
 * Each request is decoded from the rows binding its own entry and settles with the completed value, or with the
 * error raised while decoding or completing it. A request matching no row is decoded from no rows, so it settles as
 * the pass decides rather than hanging. A query failure rejects every request of the batch. The returned promise
 * does not wait for the nested requests decoded values depend on, which run in a later batching round.
 *
 * @param batch The requests to serve, sharing one plan
 * @param client The repository the query runs against
 * @param broker The channel running the nested requests decoded values depend on
 * @param pass The encoder, owner column and decoder of the pass
 *
 * @returns A promise resolving once every request has been decoded or rejected
 */
export function read<R extends Request>(
	batch: readonly Deferred<R>[],
	client: RepositoryClient,
	broker: Broker,
	pass: Reading<R>
): Promise<void> {

	const scope = createScope(variable);

	const query = pass.encode(scope);

	return settle(batch,
		query === undefined ? Promise.resolve(new Map())
			: client.select(query).then(tuples => owned(tuples, pass.owner(scope))),
		(item, rows) => Promise.resolve()
			.then(() => pass.decode(scope, item, rows))
			.then(decoded => complete(decoded, broker))
	);

}

/**
 * Runs a writing pass over a batch.
 *
 * Applies the update the pass encodes and settles each request through the pass decoder. An update failure rejects
 * every request of the batch and the returned promise still resolves, so the handler never fails the batching run.
 *
 * @param batch The requests to apply
 * @param client The repository the update is applied against
 * @param pass The encoder and decoder of the pass
 *
 * @returns A promise resolving once every request has been settled
 */
export function write<R extends Request>(
	batch: readonly Deferred<R>[],
	client: RepositoryClient,
	pass: Writing<R>
): Promise<void> {

	const scope = createScope(variable);

	return settle(batch,
		client.update(pass.encode(scope)).then(() => new Map()),
		item => Promise.resolve().then(() => pass.decode(scope, item))
	);

}


/**
 * Settles every request of a batch once `rows` resolves. Each request settles with the value `decode` returns from
 * its own rows, or with the error `decode` raises. If `rows` fails, every request is rejected with that error. The
 * returned promise resolves in either case, once every request has been decoded or rejected.
 */
function settle<R extends Request>(
	batch: readonly Deferred<R>[],
	rows: Promise<ReadonlyMap<Reference, readonly Tuple[]>>,
	decode: (item: Deferred<R>, rows: readonly Tuple[]) => Promise<Response<R>>
): Promise<void> {

	return rows.then(
		index => batch.forEach(item => decode(item, index.get(item.request.entry) ?? []).then(
			value => item.resolve(value),
			(error: unknown) => item.reject(error)
		)),
		(error: unknown) => batch.forEach(({ reject }) => reject(error))
	);

}

/**
 * Completes a decoded value through the broker: every nested request is run at once, and the value is built from their
 * responses once every one of them has settled, so a failing request fails the value as a whole.
 */
function complete<T>({ details, selects, build }: Decoded<T>, broker: Broker): Promise<T> {

	return Promise.all([
		Promise.all(details.map(request => broker.detail(request))),
		Promise.all(selects.map(request => broker.select(request)))
	]).then(([resources, collections]) => build(resources, collections));

}

/**
 * Indexes the solution rows of a query by the entry bound in their `owner` column, in solution order. A row binding
 * no named node on that column belongs to no request and is left out of the index.
 */
function owned(tuples: readonly Tuple[], owner: Variable): ReadonlyMap<Reference, readonly Tuple[]> {

	// the index is filled in place: rebuilding it per row would copy it once per solution, quadratic in the
	// result, which is the cost the batched passes exist to avoid (sw-developer:code, performance-critical hot path)

	return tuples.reduce((index, tuple) => {

		const bound = tuple[owner];

		return bound?.kind === "named"
			? index.set(bound.iri, [...(index.get(bound.iri) ?? []), tuple])
			: index;

	}, new Map<Reference, readonly Tuple[]>());

}
