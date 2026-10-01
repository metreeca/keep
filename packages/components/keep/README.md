# @metreeca/keep

[![npm](https://img.shields.io/npm/v/@metreeca/keep)](https://www.npmjs.com/package/@metreeca/keep)

Core model-driven storage API for the [@metreeca/keep](https://github.com/metreeca/keep) linked data storage framework.

Defines the backend-agnostic `StoreClient` and `Store` interfaces for persisting and retrieving linked data resources as
shape-validated states and query projections. Resource shapes are defined using
[@metreeca/blue](https://github.com/metreeca/blue); resource states and retrieval templates follow the data and query
models defined by [@metreeca/qest](https://github.com/metreeca/qest). Actual storage is delegated to backend
[connector packages](https://github.com/metreeca/keep#installation).

# Installation

```shell
npm install @metreeca/keep
```

# Usage

> [!NOTE]
>
> This section introduces essential concepts; for complete coverage, see the
> [API reference](https://metreeca.github.io/keep/modules/_metreeca_keep.html).

| Module                                  | Description              |
|-----------------------------------------|--------------------------|
| [@metreeca/keep][keep]                  | Model-driven storage API |
| **Stores**                              |                          |
| [@metreeca/keep/caching][caching]       | Caching store wrapper    |
| [@metreeca/keep/managing][managing]     | Managing store wrapper   |
| **Store Clients**                       |                          |
| [@metreeca/keep/validating][validating] | Validating store wrapper |
| [@metreeca/keep/batching][batching]     | Batching store client    |

[keep]: https://metreeca.github.io/keep/modules/_metreeca_keep.html

[validating]: https://metreeca.github.io/keep/modules/_metreeca_keep.validating.html

[batching]: https://metreeca.github.io/keep/modules/_metreeca_keep.batching.html

[caching]: https://metreeca.github.io/keep/modules/_metreeca_keep.caching.html

[managing]: https://metreeca.github.io/keep/modules/_metreeca_keep.managing.html

All store methods accept an `entry` that MUST be an absolute IRI without query string or fragment: non-conforming
entries reject with `RangeError`. `create` takes as `entry` the resource holding the collection, and as `model` the
multi-valued property holding it; an `id` stated in a `create` state MUST be nested under `entry`. `model` and `state`
are validated against the supplied shape; validation failures reject with a `TraceError`. Network, storage, and other
processing errors reject with a structured `Problem`.

## Retrieving Resources

```typescript
// single resource retrieval

const product = await store.lookup({
	entry: "http://example.com/products/1",
	shape: ProductShape,
	model: {
		name: {},
		price: {},
		vendor: {
			id: {},
			name: {}
		}
	}
});

// collection retrieval with filtering, ordering, and pagination

const catalogue = await store.lookup({
	entry: "http://example.com/products/",
	shape: CatalogueShape,
	model: {
		products: {
			id: {},
			name: {},
			price: {},
			">=price": 50,        // price ≥ 50
			"~name": "widget",    // name contains "widget"
			"^price": 1,          // sort by price ascending
			"@": 0,               // offset
			"#": 25               // limit
		}
	}
});
```

## Creating and Updating Resources

```typescript
// creation within the collection holding the new resource, its identifier minted by the store unless stated

const product = await store.create({
	entry: "http://example.com/products/", shape: CatalogueShape, model: { products: {} }, state: {
		name: "Widget",
		price: 29.99,
		vendor: "http://example.com/vendors/acme"
	}
});

await store.update({
	entry: "http://example.com/products/42", shape: ProductShape, state: {
		id: "http://example.com/products/42",
		name: "Widget",
		price: 39.99,
		vendor: "http://example.com/vendors/acme"
	}
});
```

## Deleting Resources

```typescript
await store.delete({ entry: "http://example.com/products/42", shape: ProductShape });
```

## Loading Data

```typescript
// unconditionally upsert (create or replace)

await store.insert({
	entry: "http://example.com/products/42", shape: ProductShape, state: {
		id: "http://example.com/products/42",
		name: "Widget",
		price: 39.99,
		vendor: "http://example.com/vendors/acme"
	}
});

// unconditionally remove (silently succeeds if absent)

await store.remove({ entry: "http://example.com/products/42", shape: ProductShape });
```

## Observing Mutations

```typescript
const unsubscribe = store.observe(mutations => {
	for (const [id, exists] of Object.entries(mutations)) {
		console.log(exists ? "upserted" : "removed", id);
	}
}, "http://example.com/products/");

unsubscribe(); // stop receiving events
```

The second argument scopes the observer to the given resources and their descendants: pass a single reference or any
collection of them, omit it to receive all mutations, or pass an empty collection to skip registration altogether.

## Executing Transactions

```typescript
await store.execute(async store => {
	await store.create({ entry: catalogue, shape: CatalogueShape, model: { products: {} }, state: product });
	await store.update({ entry: inventory.id, shape: InventoryShape, state: inventory });
});
```

Cross-backend isolation semantics, concurrency models, and the buffer-and-flush emulation pattern are documented in the
[Transaction Design](https://metreeca.github.io/keep/documents/_metreeca_keep.Transaction_Design.html) companion
document.

# Implementing Connectors

A backend connector implements the bare `StoreClient` interface against its native primitives, then wraps it with the
`createValidatingStore` helper from
[@metreeca/keep/validating](https://metreeca.github.io/keep/modules/_metreeca_keep.validating.html) for shape-driven
input validation and `createManagingStore` from
[@metreeca/keep/managing](https://metreeca.github.io/keep/modules/_metreeca_keep.managing.html) for mutation events,
transactional execution, and lifecycle:

```typescript
import type { StoreClient, Store } from "@metreeca/keep";
import { createManagingStore } from "@metreeca/keep/managing";
import { createValidatingStore } from "@metreeca/keep/validating";

function createMyStore(): Store {

	const backend: StoreClient = {

		lookup({ entry, shape, model }, scope) { /* query the backend, return matching data or undefined */ },

		create({ entry, shape, model, state }) { /* create under the collection, return the new entry or undefined */ },
		update({ entry, shape, state }) { /* update if present, return entry or undefined */ },
		delete({ entry, shape }) { /* delete if present, return entry or undefined */ },

		insert({ entry, shape, state }) { /* upsert unconditionally, return entry */ },
		remove({ entry, shape }) { /* remove unconditionally, return entry */ }

	};

	return createManagingStore(createValidatingStore(backend, { trusted: true }), {

		execute: task => { /* run task within a backend transaction */ },
		close: () => { /* release connections */ }

	});

}
```

Pass `trusted: true` to `createValidatingStore` when the backend is trusted to deliver shape-conforming data, so
`lookup` responses skip the redundant outbound validation pass. Supply `execute` to `createManagingStore` to route
every standalone call and the entire `execute` task body through the backend's transaction primitive; omit it for
non-transactional backends and the wrapper degrades to per-call atomicity. `close` defaults to a no-op.

All errors reach the caller as promise rejections through the unified Store error channel — `RangeError` for malformed
entries, `TraceError` for shape validation failures, `Problem` for network, storage, or other processing failures.
Connectors MUST preserve this contract: convert backend-specific exceptions into `Problem` rejections and let validation
rejections propagate untouched.

Each connector MUST document its supported transaction isolation level and mutation event scope per the conventions
defined in the [Transaction Design](https://metreeca.github.io/keep/documents/_metreeca_keep.Transaction_Design.html)
companion document.

## Testing

Use [@metreeca/keep-suite](https://github.com/metreeca/keep/tree/main/packages/keep-suite) to run the full conformance
suite against your connector:

```typescript
import { testStore } from "@metreeca/keep-suite";
import { describe } from "vitest";

describe("my-store", () => testStore({

	build: () => createMyStore(), // create a store with schema but no data

	contains: id => { /* true if the resource has any stored data */ },
	includes: (resource, shape) => { /* true if every fact described by `resource` is present */ },
	excludes: (resource, shape) => { /* true if every fact described by `resource` is absent */ },

	populate: () => { /* clear and reload the sample dataset */ },
	generate: (sample, shape) => { /* insert an isolated copy of `sample` with a unique id */ },

	close: () => { /* optional: release store resources after all tests */ }

}));
```

Filter to a subset of sub-suites with the `match` option (for example, `["Retrieve", "PersistCreate"]`); see the
[API reference](https://metreeca.github.io/keep/modules/_metreeca_keep-suite.html) for the full list.

# Support

- open an [issue](https://github.com/metreeca/keep/issues) to report a problem or to suggest a new feature
- start a [discussion](https://github.com/metreeca/keep/discussions) to ask a how-to question or to share an idea

# License

This project is licensed under the Apache 2.0 License –
see [LICENSE](https://github.com/metreeca/keep?tab=Apache-2.0-1-ov-file) file for details.
