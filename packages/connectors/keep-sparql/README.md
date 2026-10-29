# @metreeca/keep-sparql

[![npm](https://img.shields.io/npm/v/@metreeca/keep-sparql)](https://www.npmjs.com/package/@metreeca/keep-sparql)

SPARQL 1.1 repository connector for the [@metreeca/keep](https://github.com/metreeca/keep) model-driven linked data
storage framework.

Translates @metreeca/keep storage operations into SPARQL queries and updates against a pluggable graph backend.
Application developers can pick one of the [ready-made connectors](https://github.com/metreeca/wire#installation) or
implement the [@metreeca/wire-sparql](https://github.com/metreeca/wire/tree/main/packages/wire-sparql) `Repository`
interface to support a new SPARQL backend.

> [!IMPORTANT]
> **Transaction Isolation** — Determined by the supplied `Repository`: each connector documents the level it provides
> on its factory function. Mutations issued within a store transaction are always buffered and applied as a single
> update on commit.

> [!IMPORTANT]
> **Mutation Events** — Limited to mutations issued through the store; mutations from other clients on the underlying
> repository are not observed.

> [!IMPORTANT]
> **Embedded Resources** — Named by IRIs in the repository, never by blank nodes. The store skolemises the embedded
> resources it writes, and a graph loaded by other means must be skolemised before the store reads it. A blank node
> found where an embedded resource is expected fails the whole retrieval with a `RangeError`, so no embedded resource
> and none of the content requested under it ever goes silently missing from a retrieved result.

# Installation

Install the framework together with a backend connector from the
[@metreeca/wire](https://github.com/metreeca/wire) SPARQL connector collection:

```shell
npm install @metreeca/keep-sparql
npm install @metreeca/wire-sparql-oxigraph    # or another backend connector
```

# Usage

> [!NOTE]
>
> This section introduces essential concepts; for complete coverage, see the
> [API reference](https://metreeca.github.io/keep/modules/_metreeca_keep-sparql.html).

## Wiring a Store

Pass any [@metreeca/wire-sparql](https://github.com/metreeca/wire/tree/main/packages/wire-sparql) `Repository`
connector to `createSPARQLStore` to obtain a fully functional `Store`:

```typescript
import { createSPARQLStore } from "@metreeca/keep-sparql";
import { createOxiRepository } from "@metreeca/wire-sparql-oxigraph";

const store = createSPARQLStore(createOxiRepository());

const product = await store.lookup({
	entry: "http://example.com/products/1",
	shape: ProductShape,
	model: {
		name: {},
		price: {}
	}
});
```

The store caps how it queries the repository: `batch` is the most entries one query binds (default `500`) and `burst`
the most queries in flight at once (default `8`); `0` lifts a cap. Lower them for a backend behind a gateway with a
short request limit or a tight connection pool, and raise them where the backend takes more and a round trip costs more
than a larger query, as it does over a slow link to a remote backend serving few clients:

```typescript
const store = createSPARQLStore(createOxiRepository(), { batch: 200, burst: 4 });
```

## Implementing a Connector

A backend connector is a [@metreeca/wire-sparql](https://github.com/metreeca/wire/tree/main/packages/wire-sparql)
`Repository`: implement `ask`, `select`, `construct`, `update`, `execute`, and `close`, lifting backend node values into
the shared [@metreeca/trio](https://github.com/metreeca/trio) `Term` representation with the `named`, `tagged`, and
`typed` constructors. `createSPARQLStore` then turns any such connector into a `Store`.

See [@metreeca/wire-sparql-oxigraph](https://github.com/metreeca/wire/tree/main/packages/wire-sparql-oxigraph) for a
complete reference connector.

# Verified Backends

This SPARQL connector has been exercised against the
[@metreeca/keep-suite](https://github.com/metreeca/keep/tree/main/packages/components/keep-suite) conformance suite on
the backends and versions below, through the listed connectors.

| Engine                       | Version | Storage       | Connectors                                      |
|------------------------------|---------|---------------|-------------------------------------------------|
| [Eclipse RDF4J][rdf4j]       | 6.1.0   | MemoryStore   | `createHTTPRepository`, `createRDF4JRepository` |
| [Eclipse RDF4J][rdf4j]       | 6.1.0   | NativeStore   | `createHTTPRepository`, `createRDF4JRepository` |
| [Eclipse RDF4J][rdf4j]       | 6.1.0   | LmdbStore     | `createHTTPRepository`, `createRDF4JRepository` |
| [Apache Jena Fuseki][fuseki] | 6.2.0   | MemoryDataset | `createHTTPRepository`                          |
| [Apache Jena Fuseki][fuseki] | 6.2.0   | TDB1          | `createHTTPRepository`                          |
| [Apache Jena Fuseki][fuseki] | 6.2.0   | TDB2          | `createHTTPRepository`                          |
| [Oxigraph][oxigraph]         | 0.5.13  | in-memory     | `createOxiRepository`                           |
| [Oxigraph][oxigraph]         | 0.5.13  | disk          | `createHTTPRepository`                          |

[rdf4j]: https://rdf4j.org/

[fuseki]: https://jena.apache.org/

[oxigraph]: https://oxigraph.org/

# Support

- open an [issue](https://github.com/metreeca/keep/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/metreeca/keep/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/metreeca/keep?tab=Apache-2.0-1-ov-file) file for details.
