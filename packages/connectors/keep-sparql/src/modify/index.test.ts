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

import { reference } from "@metreeca/blue/reference";
import { multiple, required, resource } from "@metreeca/blue/resource";
import { string } from "@metreeca/blue/string";
import { error } from "@metreeca/core";
import { collections, identify, Product, toys } from "@metreeca/keep-suite/toys";
import type { Deferred, Modify } from "@metreeca/keep/batching";
import type { Reference, Resource } from "@metreeca/qest/state";
import { named, type Term, typed } from "@metreeca/trio";
import type { Repository } from "@metreeca/wire-sparql";
import { data, insert, pattern, select, update, variable, where } from "@metreeca/wire-sparql/builder";
import { createOxiRepository } from "@metreeca/wire-sparql-oxigraph";
import { describe, expect, it, vi } from "vitest";
import { modify } from "./index.js";


describe("modify", () => {

	/**
	 * The sample product carrying reviews, the suite's own fixture: the encoder writes nothing for a state satisfying
	 * no variant of the shape, so a hand-built state would have to restate every required member.
	 */
	const sample: Resource = collections.products.find(product => product["reviews"] !== undefined)
		?? error(new Error("undefined sample product carrying reviews"));

	const entry: Reference = identify(sample, Product);
	const other: Reference = "http://example.com/products/0002";

	const { reviews: _, ...bare } = sample;

	function request(state: undefined | Resource): Deferred<Modify> {
		return {
			request: { entry, shape: Product, state },
			resolve: vi.fn(),
			reject: vi.fn()
		};
	}

	/**
	 * A repository holding the entry with an embedded review, written by the connector itself, and an unrelated
	 * triple on another product, written by hand, which no mutation of the entry may touch.
	 */
	async function repository(): Promise<Repository> {

		const oxigraph = createOxiRepository();

		await oxigraph.update(update(insert(data(pattern([named(other), named(toys.sku), typed("0002")])))));

		await modify([request(sample)], oxigraph);

		return oxigraph;

	}

	/**
	 * Every triple in the repository, as its subject, predicate and object terms.
	 */
	async function triples(repository: Repository): Promise<readonly (readonly (undefined | Term)[])[]> {
		return (await repository.select(select([variable("?s"), variable("?p"), variable("?o")], where(pattern(["?s", "?p", "?o"])))))
			.map(tuple => [tuple["?s"], tuple["?p"], tuple["?o"]]);
	}

	function is(term: undefined | Term, iri: string): boolean {
		return term?.kind === "named" && term.iri === iri;
	}


	it("clears the edges of an embedded resource through the edge owning it", async () => {

		const client = await repository();

		expect((await triples(client)).some(([, p]) => is(p, toys.rating))).toBe(true);

		await modify([request(bare)], client);

		const remaining = await triples(client);

		expect(remaining.some(([, p]) => is(p, toys.rating))).toBe(false);
		expect(remaining.some(([, p]) => is(p, toys.reviews))).toBe(false);
		expect(remaining.some(([s]) => is(s, other))).toBe(true);

	});

	it("settles every request with its entry", async () => {

		const client = await repository();

		const batch = [request(bare)];

		await modify(batch, client);

		await vi.waitFor(() => batch.forEach(({ resolve }) => expect(resolve).toHaveBeenCalledWith(entry)));

	});


	describe("with edges stored in one direction", () => {

		// a graph loaded by other means may carry one direction of a two-way property only: an update still clears
		// such an owned edge, a removal still reaches the cascaded resource through it

		const forward = "http://example.com/vendors/forward";
		const reverse = "http://example.com/vendors/reverse";


		it("clears an owned edge stored in either direction alone on update", async () => {

			const client = await repository();

			await client.update(update(insert(data(
				pattern([named(entry), named(toys.vendor), named(forward)]),
				pattern([named(reverse), named(toys.products), named(entry)])
			))));

			await modify([request(bare)], client);

			const remaining = await triples(client);

			expect(remaining.some(([s, p, o]) => is(s, entry) && is(p, toys.vendor) && is(o, forward))).toBe(false);
			expect(remaining.some(([s, p, o]) => is(s, reverse) && is(p, toys.products) && is(o, entry))).toBe(false);
			expect(remaining.some(([s, p]) => is(s, entry) && is(p, toys.vendor))).toBe(true);

		});

		it("reaches a cascaded resource linked in either direction alone on removal", async () => {

			// a captive two-way property, which the sample shapes do not declare

			const Part = resource({ class: toys.Review }, { name: required(string) });

			const Box = resource({ class: toys.Product }, {
				parts: multiple(reference(Part), { forward: toys.media, reverse: toys.products, captive: true })
			});

			const box = "http://example.com/boxes/0001";
			const parts: readonly Reference[] = ["http://example.com/parts/forward", "http://example.com/parts/reverse"];

			const client = createOxiRepository();

			await client.update(update(insert(data(
				pattern([named(box), named(toys.sku), typed("box")]),
				pattern([named(box), named(toys.media), named(parts[0])]),
				pattern([named(parts[1]), named(toys.products), named(box)]),
				...parts.map(part => pattern([named(part), named(toys.name), typed(part)]))
			))));

			await modify([{ request: { entry: box, shape: Box, state: undefined }, resolve: vi.fn(), reject: vi.fn() }], client);

			const remaining = await triples(client);

			expect(remaining.some(([s]) => is(s, box))).toBe(false);
			parts.forEach(part => expect(remaining.some(([s]) => is(s, part))).toBe(false));

		});

	});

});
