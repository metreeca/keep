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
 * SPARQL 1.1 repository connector.
 *
 * Turns any SPARQL 1.1 {@link Repository} into a fully featured {@link Store}, so shape-driven retrieval and
 * persistence run against a graph backend without hand-written queries. A ready-made connector from the
 * {@link https://github.com/metreeca/wire @metreeca/wire} collection (Oxigraph, generic HTTP endpoints, RDF4J, …)
 * covers the common backends; a new backend is supported by implementing {@link Repository} directly.
 *
 * **Wiring a Connector**
 *
 * A ready-made connector is passed to {@link createSPARQLStore} to obtain a store:
 *
 * ```typescript
 * import { createSPARQLStore } from "@metreeca/keep-sparql";
 * import { createOxiRepository } from "@metreeca/wire-sparql-oxigraph";
 *
 * const store = createSPARQLStore(createOxiRepository());
 *
 * await store.create({
 *     entry: "http://example.com/products/",
 *     shape: CatalogueShape,
 *     model: { products: {} },
 *     state: { name: "Widget", price: 9.99 }
 * });
 * ```
 *
 * **Implementing a Connector**
 *
 * A new SPARQL backend is supported by implementing a {@link @metreeca/wire-sparql!Repository | Repository}. The
 * repository exchanges {@link @metreeca/wire-sparql!SPARQL | SPARQL} text and
 * {@link @metreeca/wire-sparql!Tuple | Tuple} solution rows, whose values are `@metreeca/trio`
 * {@link @metreeca/trio!Term | Term} values. Backend node values are lifted into terms with the
 * {@link @metreeca/trio!named | named}, {@link @metreeca/trio!tagged | tagged} and {@link @metreeca/trio!typed | typed}
 * constructors. The reference implementation in `@metreeca/wire-sparql-oxigraph` follows this pattern:
 *
 * ```typescript
 * import { named, tagged, type Term, typed } from "@metreeca/trio";
 * import { type Repository } from "@metreeca/wire-sparql";
 *
 * function decode(node: BackendNode): Term {
 *     return node.kind === "iri" ? named(node.iri)
 *         : node.kind === "language" ? tagged(node.text, node.language)
 *             : typed(node.text, node.datatype);
 * }
 *
 * export function createMyRepository(): Repository {
 *     // ... satisfy ask/select/construct/update/execute/close against the backend
 * }
 * ```
 *
 * @see {@link https://www.w3.org/TR/sparql11-query/ SPARQL 1.1 Query Language}
 * @see {@link https://www.w3.org/TR/sparql11-update/ SPARQL 1.1 Update}
 * @see {@link https://www.w3.org/TR/rdf11-concepts/ RDF 1.1 Concepts and Abstract Syntax}
 *
 * @group Connectors
 *
 * @module index
 */

import type { Store, StoreClient } from "@metreeca/keep";
import { createBatchingStore } from "@metreeca/keep/batching";
import { createManagingStore } from "@metreeca/keep/managing";
import { createValidatingStore } from "@metreeca/keep/validating";
import { log } from "@metreeca/tape";
import {
	createBufferingRepository,
	createLoggingRepository,
	type Repository,
	type RepositoryClient
} from "@metreeca/wire-sparql";
import { detail } from "./detail/index.js";
import { detect } from "./detect/index.js";
import { modify } from "./modify/index.js";
import { select } from "./select/index.js";


const logger = log(import.meta.url);


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates a SPARQL store backed by a {@link Repository}.
 *
 * Every data call runs in its own {@link Repository.execute | repository transaction}, so concurrent calls share no
 * transaction state. Inside {@link Store.execute | execute}, the task receives a {@link StoreClient} bound to a single
 * repository transaction: its mutations are buffered and flushed to the repository as one update when the task
 * completes, then committed with the transaction. Queries within the task do not observe the task's own pending
 * mutations, so a read depending on a write must run in a separate `execute` call.
 *
 * > [!IMPORTANT]
 * > **Transaction Isolation** — Determined by the supplied {@link Repository}: native transactions keep the reads of
 * > an `execute` task consistent, while its mutations are always buffered and applied as a single update on commit.
 *
 * > [!IMPORTANT]
 * > **Mutation Events** — Limited to mutations issued through this store; mutations from other clients on the
 * > underlying repository are not observed.
 *
 * @param repository - The repository for SPARQL query, update, and transaction execution
 *
 * @returns An immutable {@link Store}
 */
export function createSPARQLStore(repository: Repository): Store {

	const buffering = createBufferingRepository(
		createLoggingRepository(repository, message => logger.debug`${message}`)
	);


	return createManagingStore(store(buffering), {

		execute: task => buffering.execute(async repository => task(store(repository))),
		close: () => buffering.close()

	});


	function store(client: RepositoryClient): StoreClient {

		return createValidatingStore(createBatchingStore({

			detect: (batch) => detect(batch, client),
			detail: (batch, broker) => detail(batch, client, broker),
			select: (batch, broker) => select(batch, client, broker),
			modify: (batch) => modify(batch, client)

		}), {

			trusted: true

		});

	}

}
