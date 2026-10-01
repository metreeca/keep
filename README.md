# @metreeca/keep

[![npm](https://img.shields.io/npm/v/@metreeca/keep)](https://www.npmjs.com/package/@metreeca/keep)

Turnkey model-driven storage for linked data resources.

**@metreeca/keep** stores and retrieves linked data resources independently of the backend holding them, driven by the
resource models that describe them:

- **Model-Driven Storage**: data models defined with [@metreeca/blue](https://github.com/metreeca/blue) drive storage
	and validation
- **Declarative Operations**: CRUD operations on linked data resources without hand-written queries
- **Pluggable Connectors**: one storage API over every supported backend, through interchangeable connector packages

| Layer      | Package                                                 | Description                       |
|------------|---------------------------------------------------------|-----------------------------------|
| Components | [@metreeca/keep]                                        | Core model-driven storage API     |
|            | [@metreeca/keep-flake]                                  | Shape-driven traversal trees      |
|            | [@metreeca/keep-suite]                                  | Connector conformance test suite  |
| Connectors | [@metreeca/keep-rest]                                   | REST/JSON proxy connector         |
|            | [*upcoming*](https://github.com/metreeca/keep/issues/1) | [SQL:2011] database connector     |
|            | [*upcoming*](https://github.com/metreeca/keep/issues/2) | [GQL:2024] graph connector        |
|            | [@metreeca/keep-sparql]                                 | [SPARQL 1.1] repository connector |

[@metreeca/keep]: https://metreeca.github.io/keep/modules/_metreeca_keep.html

[@metreeca/keep-flake]: https://metreeca.github.io/keep/modules/_metreeca_keep-flake.html

[@metreeca/keep-suite]: https://metreeca.github.io/keep/modules/_metreeca_keep-suite.html

[@metreeca/keep-sparql]: https://metreeca.github.io/keep/modules/_metreeca_keep-sparql.html

[@metreeca/keep-rest]: https://metreeca.github.io/keep/modules/_metreeca_keep-rest.html

[SQL:2011]: https://www.iso.org/standard/53681.html

[GQL:2024]: https://www.iso.org/standard/76120.html

[SPARQL 1.1]: https://www.w3.org/TR/sparql11-overview/


# Installation

Pick the connector for your backend from the table above and install it. The connector pulls in the framework packages
it needs, so you don't install them yourself.

Some connectors also need a separate backend library, such as a driver, runtime or client. The connector README lists
any such requirement.

```shell
npm install @metreeca/keep-<connector>    # connector from the table above
npm install <backend-package>             # backend library, if the connector requires one
```

> [!WARNING]
>
> TypeScript consumers must use `"moduleResolution": "nodenext"/"node16"/"bundler"` in `tsconfig.json`.
> The legacy `"node"` resolver is not supported.


# Usage

> [!NOTE]
>
> Each package documents its own API in its README and API reference; for complete coverage, see the
> [API reference](https://metreeca.github.io/keep/).

An application obtains a store from a backend connector, then reads and writes resources against the models describing
them, whatever the backend. For example, with the SPARQL connector over an RDF4J Server repository:

```ts
import { createSPARQLStore } from "@metreeca/keep-sparql";
import { createRDF4JRepository } from "@metreeca/wire-sparql-rdf4j";

const store = createSPARQLStore(createRDF4JRepository({
	server: "http://localhost:8080/rdf4j-server",
	repository: "products"
}));

const product = await store.lookup({
	entry: "http://example.com/products/1",
	shape: ProductShape,
	model: {
		name: {},
		price: {},
		vendor: { id: {}, name: {} }
	}
});
```

# Support

- open an [issue](https://github.com/metreeca/keep/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/metreeca/keep/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/metreeca/keep?tab=Apache-2.0-1-ov-file) file for details.
