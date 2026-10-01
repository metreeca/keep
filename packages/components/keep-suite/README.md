# @metreeca/keep-suite

[![npm](https://img.shields.io/npm/v/@metreeca/keep-suite)](https://www.npmjs.com/package/@metreeca/keep-suite)

Connector conformance test suite for the [@metreeca/keep](https://github.com/metreeca/keep) model-driven linked data
storage framework.

Provides shared test fixtures and a conformance harness for verifying that storage connector implementations correctly
handle resource retrieval, CRUD operations, transactions, and mutation events. Intended for storage connector
developers.

# Installation

```shell
npm install @metreeca/keep-suite
npm install vitest
```

> [!IMPORTANT]
> [Vitest](https://vitest.dev/) >= 4.0.0 is a peer dependency and must be installed separately. No special
> `vitest.config.ts` is required: standard Vitest configuration works.

Connector packages add the suite and Vitest under `devDependencies`:

```json
{
  "devDependencies": {
    "@metreeca/keep-suite": "^0.11.0",
    "vitest": "^4.0.0"
  }
}
```

# Usage

Import `testStore` and call it inside a `describe` block with callbacks that provision and manage your store:

```typescript
import { testStore } from "@metreeca/keep-suite";
import { describe } from "vitest";

describe("my-connector", () => testStore({

	open: () => createMyStore(), // create a store instance with schema but no data

	contains: id => myExists(id), // check if a resource exists at all
	includes: (resource, shape) => myIncludes(resource, shape), // check if all facts of a resource are present
	excludes: (resource, shape) => myExcludes(resource, shape), // check if all facts of a resource are absent

	populate: () => myPopulate(), // reload the sample dataset
	generate: (resource, shape) => myGenerate(resource, shape), // insert a copy with a unique id for mutation tests

	close: () => myClose() // optional: release resources after all tests

}));
```

The suite registers sub-suites for retrieval, create, update, delete, insert, remove, transactions, mutation events, and
lifecycle. See the [API reference](https://metreeca.github.io/keep/modules/_metreeca_keep-suite.html) for the full list.
Filter sub-suites or individual tests with `target` and `ignore`. Patterns are matched as substrings against the full
test path (well-known sub-suite tag plus inner `describe`/`it` names, joined by ` > `):

```typescript
describe("my-connector", () => testStore({

	// ... callbacks ...

	target: ["Retrieve", "PersistCreate"], // run only retrieval and create suites
	ignore: ["should report last mutation status"] // skip a specific test by name

}));
```

> [!IMPORTANT]
> The `ManageExecuteIsolation` sub-suite assumes snapshot transaction isolation, and the `ManageClose` sub-suite
> assumes that closing a store makes it reject further operations. A connector whose store provides weaker isolation,
> or implements `close` as a no-op, adds the matching tag to `ignore`.

## Test Dataset

Tests run against a toy catalogue dataset with 62 products, 11 hierarchical categories, and 5 vendors. The dataset
exercises cardinality variants, data types, structural patterns, and query operations.

Resource [shapes][shapes] ([source][shapes-src]) are defined using [@metreeca/blue](https://github.com/metreeca/blue),
the declarative modelling language that drives the entire @metreeca/keep storage framework. [Sample data][data] is
loaded by the `populate` callback before each retrieval sub-suite.

[shapes]: https://metreeca.github.io/keep/modules/_metreeca_keep-suite.toys.html

[shapes-src]: https://github.com/metreeca/keep/blob/main/packages/components/keep-suite/src/toys.ts

[data]: https://metreeca.github.io/keep/variables/_metreeca_keep-suite.toys.collections.html

## Backends Requiring an Endpoint

For backends accessed via an external endpoint URL, gate the suite on environment availability with `describe.skipIf`
so it skips cleanly when the endpoint is unset:

```typescript
const ENDPOINT = process.env.MY_BACKEND_ENDPOINT;

describe.skipIf(!ENDPOINT)("my-connector", () => testStore({

	open: () => createMyStore({ endpoint: ENDPOINT! }),

	// ... remaining callbacks ...

}));
```

## Backends Requiring a Runtime

For backends that cannot be embedded in Node and have no readily available cloud endpoint, spin up an ephemeral
container with [testcontainers-node](https://node.testcontainers.org/) in `beforeAll` and stop it in `afterAll`; the
`open` callback closes over the resolved endpoint URL. Because `populate` resets state on each call via the connector's
own write path, a single container is shared across sub-suites without recreating it.

> [!WARNING]
> Testcontainers requires a Docker-compatible runtime (Docker Desktop, Podman, Rancher Desktop, Colima, or remote
> `DOCKER_HOST`).

Add `testcontainers` under `devDependencies`:

```shell
npm install testcontainers --save-dev
```

```json
{
  "devDependencies": {
    "testcontainers": "^12.1.0"
  }
}
```

Then wire the container around the suite:

```typescript
import { testStore } from "@metreeca/keep-suite";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe } from "vitest";

describe("my-connector", () => {

	let container: StartedTestContainer;
	let endpoint: string;

	beforeAll(async () => {

		container = await new GenericContainer("my-backend:latest")
			.withExposedPorts(5432)
			.start();

		endpoint = `http://${container.getHost()}:${container.getMappedPort(5432)}`;

	}, 120_000);

	afterAll(() => container?.stop());

	testStore({
		open: () => createMyStore({ endpoint }),
		// ... remaining callbacks ...
	});

});
```

For larger datasets, copy a dump into the container with `withCopyFilesToContainer` and trigger the backend's native
bulk loader before tests start. This is typically far faster than per-record inserts, though not worth the overhead for
the toy fixture.

# Support

- open an [issue](https://github.com/metreeca/keep/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/metreeca/keep/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/metreeca/keep?tab=Apache-2.0-1-ov-file) file for details.
