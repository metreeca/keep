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
 * Detail-pass driver.
 *
 * Materialises every queued {@link Detail} request in a batch with a single `select` query against the repository.
 * Single-valued properties are read from that query, while multi-valued properties are forwarded to the select pass
 * through the {@link Broker}, the only channel between passes. The handler returns without waiting for the
 * forwarded requests, so the select pass can run them within the same batching round.
 *
 * @module index
 */

import type { ResourceShape } from "@metreeca/blue/resource";
import type { Lazy } from "@metreeca/core";
import { createScope } from "@metreeca/core/scope";
import { equals } from "@metreeca/core/values";
import { createFlake, type Flake, isModelBranch } from "@metreeca/keep-flake";
import type { Broker, Deferred, Detail } from "@metreeca/keep/batching";
import type { Template } from "@metreeca/qest/model";
import type { Reference } from "@metreeca/qest/state";
import { type RepositoryClient, type Tuple, type Variable, variable as toVariable } from "@metreeca/wire-sparql";
import { bounded, grouped } from "../index.core.js";
import { decode } from "./decode.js";
import { encode } from "./encode.js";


/**
 * The requests sharing one detail plan: the same shape and a structurally equal model.
 */
type Group = {

	readonly shape: Lazy<ResourceShape>;
	readonly model: Template;
	readonly flake: Flake;

	readonly items: readonly Deferred<Detail>[];

}


/**
 * Resolves a batch of detail requests through shared `select` queries, binding at most `Chunk` entries each.
 *
 * Requests sharing a shape and a structurally equal model form a group, planned once with {@link createFlake}. All
 * entries are read together, so the queries grow with the number of distinct plans and linearly with the number of
 * entries, never with their product, and a batch over the cap runs as several queries. Groups reading no
 * single-valued property join no query, and no query runs if none does. Their requests still resolve: `id` and
 * `type` come from the entry and the shape, multi-valued ones from the select pass.
 *
 * @param batch The queued detail requests to resolve
 * @param client The repository the query runs against
 * @param broker The channel forwarding multi-valued properties to the select pass
 *
 * @returns A promise settling once the results of every query have been handed to the decoder
 */
export async function detail(
	batch: readonly Deferred<Detail>[],
	client: RepositoryClient,
	broker: Broker
): Promise<void> {

	const scope = createScope(toVariable);

	const groups = grouped<Deferred<Detail>, Group>(batch,
		({ shape, model }, { request }) => shape === request.shape && equals(model, request.model),
		item => ({
			shape: item.request.shape,
			model: item.request.model,
			flake: createFlake(item.request.shape, item.request.model),
			items: [item]
		})
	);

	// drop groups whose union arms would be empty (only id/type or collection slots) from the fetch;
	// they still flow through delivery, where decode yields id/type inline and routes collections

	const effective = groups.filter(({ flake }) =>
		Object.values(flake.entries ?? {}).some(isModelBranch)
	);

	const inert = groups.filter(group => !effective.includes(group));

	await Promise.all(bounded(effective).map(query => client
		.select(encode(scope, query.map(({ flake, items }) =>
			({ entries: items.map(({ request }) => request.entry), flake })
		)))
		.then(tuples => deliver(query, tuples))
	));

	deliver(inert, []);


	/**
	 * Hands each request of `groups` to the decoder with the rows of `tuples` binding its own entry: the rows of
	 * one query for the groups that query read, no rows for the groups that contributed to no query.
	 */
	function deliver(groups: readonly Group[], tuples: readonly Tuple[]): void {
		decode(scope, groups.flatMap(({ flake, items }) => items.map(item =>
			({ ...item, flake, tuples: rows(tuples, scope.resolve(flake), item.request.entry) })
		)), broker);
	}

	/**
	 * The solution rows of one request: the rows whose `subject` column binds `entry`.
	 */
	function rows(tuples: readonly Tuple[], subject: Variable, entry: Reference): readonly Tuple[] {
		return tuples.filter(tuple => {

			const bound = tuple[subject];

			return bound !== undefined && bound.kind === "named" && bound.iri === entry;

		});
	}

}
