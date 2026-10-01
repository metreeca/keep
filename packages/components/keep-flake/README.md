# @metreeca/keep-flake

[![npm](https://img.shields.io/npm/v/@metreeca/keep-flake)](https://www.npmjs.com/package/@metreeca/keep-flake)

Shape-driven traversal trees for connectors of the [@metreeca/keep](https://github.com/metreeca/keep) model-driven
linked data storage framework.

Gathers a resource shape and its optional retrieval template or collection query into a single traversal tree. A
connector walks that tree directly, instead of matching the raw shape against the raw request at every step. As
everywhere in the framework, the tree is driven entirely by the supplied resource shape, with no hardcoded property
names or dataset-specific assumptions.

# Installation

```shell
npm install @metreeca/keep-flake
```

# Usage

> [!NOTE]
>
> This section introduces essential concepts; for complete coverage, see the
> [API reference](https://metreeca.github.io/keep/modules/_metreeca_keep-flake.html).

This package serves connector authors building backends for
[@metreeca/keep](https://github.com/metreeca/keep#installation). Connectors depending on it pull it in automatically, so
application code does not normally install it directly.

The package builds three flavours of traversal tree:

- **shape** — the full structural reach of a resource shape, for operations driven by the shape alone, such as mutations
- **model** — the properties a retrieval template addresses, each with the retrieval requested for it
- **query** — a collection member shape tagged with the constraints, ordering, pagination, and projections a collection
  query states

# Support

- open an [issue](https://github.com/metreeca/keep/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/metreeca/keep/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/metreeca/keep?tab=Apache-2.0-1-ov-file) file for details.
