# @metreeca/keep

[![npm](https://img.shields.io/npm/v/@metreeca/keep)](https://www.npmjs.com/package/@metreeca/keep)

Turnkey model-driven storage for linked data resources.

> [!NOTE] Provisional notes:
>
> - Storage layer for model-driven linked data management
> - Data models defined using [@metreeca/blue](https://github.com/metreeca/blue)
> - Declarative CRUD operations on linked data resources without hand-written queries

| Layer      | Package                                                 | Description                       |
|------------|---------------------------------------------------------|-----------------------------------|
| Components | [@metreeca/keep]                                        | Core model-driven storage API     |
|            | [@metreeca/keep-flake]                                  | Shape-driven query representation |
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

[SPARQL 1.1]: https://www.w3.org/TR/sparql11-update/


# Installation

Install the connector framework for your target query language together with a backend connector from the
[@metreeca/wire] SPARQL connector collection. All required framework packages are resolved automatically as transitive
dependencies. Some connectors also require a backend runtime or client library as a separate peer dependency: check the
connector README for details.

```shell
npm install @metreeca/keep-sparql              # connector framework
npm install @metreeca/wire-sparql-<backend>    # backend connector from the @metreeca/wire collection
npm install <runtime-or-client>                # if required by the connector
```

> [!WARNING]
>
> TypeScript consumers must use `"moduleResolution": "nodenext"/"node16"/"bundler"` in `tsconfig.json`.
> The legacy `"node"` resolver is not supported.

See the [@metreeca/wire] connector collection for the available SPARQL backend connectors, their peer dependencies, and
verified engines.

[@metreeca/wire]: https://github.com/metreeca/wire#installation


# Usage

> [!NOTE]
>
> This section introduces essential concepts; for complete coverage, see the
> [API reference](https://metreeca.github.io/keep/).

{TBD: usage overview and examples}

# Support

- open an [issue](https://github.com/metreeca/keep/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/metreeca/keep/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/metreeca/keep?tab=Apache-2.0-1-ov-file) file for details.
