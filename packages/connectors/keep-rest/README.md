# @metreeca/keep-rest

[![npm](https://img.shields.io/npm/v/@metreeca/keep-rest)](https://www.npmjs.com/package/@metreeca/keep-rest)

REST/JSON proxy connector for the [@metreeca/keep](https://github.com/metreeca/keep) model-driven linked data storage
framework.

Gives an application access to a remote REST service through the same
[`Store`](https://metreeca.github.io/keep/modules/_metreeca_keep.html) API as every other connector: each data operation
is round-tripped to the service rather than applied to a local backing store. Inputs are shape-validated before the
request is sent. Retrieval responses are validated as well, since the remote service is treated as untrusted by default.

> [!IMPORTANT]
> **Transaction Isolation** — None. REST has no native transaction support: operations apply eagerly with no
> cross-call isolation, and an `execute` task that throws after partial server-side mutations does not roll them back.

> [!IMPORTANT]
> **Mutation Events** — Limited to mutations issued through this store; mutations from other clients sharing the remote
> service are not observed.

# Installation

```shell
npm install @metreeca/keep-rest
```

# Usage

> [!NOTE]
>
> This section introduces essential concepts; for complete coverage, see the
> [API reference](https://metreeca.github.io/keep/modules/_metreeca_keep-rest.html).

## Wiring a Store

Call `createRESTStore` to obtain a `Store` proxying a remote REST service over the global `fetch`:

```typescript
import { createRESTStore } from "@metreeca/keep-rest";

const store = createRESTStore();

const product = await store.lookup({
	entry: "http://example.com/products/1",
	shape: ProductShape,
	model: {
		name: {},
		price: {}
	}
});
```

Pass a `fetch`-compatible transport as the `fetch` option to route requests through a configured client, for instance
one adding authentication headers. Pass `trusted: true` to skip validation of retrieval responses, but only when the
remote service is trusted to deliver shape-conforming data.

# Support

- open an [issue](https://github.com/metreeca/keep/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/metreeca/keep/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/metreeca/keep?tab=Apache-2.0-1-ov-file) file for details.
