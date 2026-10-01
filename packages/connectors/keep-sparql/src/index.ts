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
 * Composes a pluggable {@link Repository} into a fully-featured {@link Store} via
 * {@link createSPARQLStore}, translating Store-level read and write operations into SPARQL queries and updates.
 * Application developers select a ready-made connector (Oxigraph, HTTP, …) or implement {@link Repository}
 * directly to support a new SPARQL backend.
 *
 * The SPARQL layer shared by every connector is defined in `@metreeca/wire-sparql`:
 * {@link @metreeca/wire-sparql!SPARQL | SPARQL} text and {@link @metreeca/wire-sparql!Tuple | Tuple} solution rows.
 * The RDF data model those rows carry is defined in `@metreeca/trio`: {@link @metreeca/trio!Triple | Triple}
 * statements and {@link @metreeca/trio!Term | Term} values ({@link @metreeca/trio!Named | Named},
 * {@link @metreeca/trio!Blank | Blank}, {@link @metreeca/trio!Tagged | Tagged}, {@link @metreeca/trio!Typed | Typed}),
 * together with the {@link @metreeca/trio!named | named}/{@link @metreeca/trio!tagged |
 * tagged}/{@link @metreeca/trio!typed | typed} constructors used to mint
 * {@link @metreeca/trio!Term | Term} values from backend results.
 *
 * **Wiring a Connector**
 *
 * Pick a ready-made connector and feed it to {@link createSPARQLStore} to obtain a store:
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
 * To support a new SPARQL backend, implement a {@link @metreeca/wire-sparql!Repository | Repository} and use
 * {@link @metreeca/trio!named | named}, {@link @metreeca/trio!tagged | tagged}, and
 * {@link @metreeca/trio!typed | typed} to lift backend node values into the shared
 * {@link @metreeca/trio!Term | Term} representation. The reference implementation in
 * `@metreeca/wire-sparql-oxigraph` exemplifies the pattern:
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
import { detect } from "./detect/index.js";
import { detail } from "./detail/index.js";
import { modify } from "./modify/index.js";
import { select } from "./select/index.js";


const logger = log(import.meta.url);


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Creates a SPARQL store backed by a {@link Repository}.
 *
 * Each StoreClient call (standalone or inside {@link Store.execute execute}) is dispatched through a fresh
 * {@link Repository} scope obtained from {@link Repository.execute repository.execute}, so concurrent calls share no
 * transaction. Inside {@link Store.execute execute}, the user task receives a StoreClient wired to the scoped
 * Repository; mutations are batched and flushed to the repository as a single update when the task completes, then
 * committed by the repository transaction. Queries within the task do not observe the task's own pending mutations
 * (no read-your-own-writes); split dependent reads across separate `execute` calls.
 *
 * > [!IMPORTANT]
 * > **Transaction Isolation** — Determined by the supplied {@link Repository}.
 *
 * > [!IMPORTANT]
 * > **Mutation Events** — Limited to mutations issued through this store; mutations from other clients on the
 * > underlying repository are not observed.
 *
 * > [!IMPORTANT]
 * > Updates issued within `execute` are always buffered and flushed as a single update on commit, regardless of
 * > native transaction support. Native transactions remain relevant nonetheless, isolating the task's reads
 * > for consistency.
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
