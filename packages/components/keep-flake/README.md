# @metreeca/keep-flake

[![npm](https://img.shields.io/npm/v/@metreeca/keep-flake)](https://www.npmjs.com/package/@metreeca/keep-flake)

Shape-driven traversal trees for connectors of the [@metreeca/keep](https://github.com/metreeca/keep) model-driven
linked data storage framework.

Reorganises a resource shape and its optional retrieval model or collection query into a single traversal tree that any
shape-driven processor walks in place of correlating the raw shape with the raw input at every step. Like every package
in the framework, the representation is driven entirely by the supplied resource shape, with no hardcoded property names
or dataset-specific assumptions.

# Installation

```shell
npm install @metreeca/keep-flake
```

# Usage

> [!NOTE]
>
> This section introduces essential concepts; for complete coverage, see the
> [API reference](https://metreeca.github.io/keep/modules/_metreeca_keep-flake.html).

This package is consumed by connector authors building backends for
[@metreeca/keep](https://github.com/metreeca/keep#installation); it is pulled in automatically as a transitive
dependency of the connector frameworks and is not normally installed directly by application code.

# Support

- open an [issue](https://github.com/metreeca/keep/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/metreeca/keep/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/metreeca/keep?tab=Apache-2.0-1-ov-file) file for details.
