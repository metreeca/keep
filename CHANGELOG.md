# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unpublished](https://github.com/metreeca/keep/compare/v0.10.0...HEAD)

### Added

- `@metreeca/keep-suite` — `Probe`, the fact probe type accepted by `StoreTestOptions.includes` and
	`StoreTestOptions.excludes`, holding each asserted slot to its declared type where the shape is concrete and admitting
  any resource where the shape is left abstract
- `@metreeca/keep` — `StoreScope`, the retrieval scope accepted by `StoreClient.lookup`, setting the locale priority and
  bounding the aggregates (`plain`), nesting depth (`depth`) and page size (`limit`) a `model` may state
- `@metreeca/keep` — `StoreLookup`, `StoreCreate`, `StoreUpdate` and `StoreDelete`, the named request types accepted by
  the `StoreClient` methods
- `@metreeca/keep-rest` — `Store.lookup` accepts root-relative references (`/…`) in responses, resolving them against
  the origin of the request `entry`
- `@metreeca/keep-suite` — conformance coverage for a union carrying a localised text variant, through the new
	`Vendor.origin` property of the toys dataset: template and projection retrieval of the text variant as a coalesced
  label or a tag-keyed map, `und` entries included, and rejection of a locale alternative outside a projection binding
- `@metreeca/keep-suite` — conformance coverage for a union pairing a string variant with a localised text variant
	admitting `und` entries, through the new `Vendor.tagline` property of the toys dataset: persistence of each variant
  and of variant switches, and retrieval keeping an `und` text apart from a plain string

### Changed

- **BREAKING** `@metreeca/keep-sparql` — localised text tagged `und` is stored and matched as a `"…"@und` literal like
	any other tag rather than as a plain literal, so a string variant sharing the property never claims it; plain
  literals already stored for `und` text are no longer read back as localised content

- Align every package to the reworked `@metreeca/blue` shape API: `Flake.range` carries a `Range`, `Branch.entry` a
	`Member`, and the `captive` and `foreign` flags are read from `PropertyConstraints` on the property rather than from a
  reference-specific constraint set
- `@metreeca/keep-suite` — `StoreTestOptions.includes` and `StoreTestOptions.excludes` take a `Probe` in place of a
	partial state, and `StoreTestOptions.generate` takes and returns a shape `State`
- `@metreeca/keep` — `Store.observe` takes its resource filter as any collection of references, arrays, sets and
	single-pass iterators alike, and `Store.execute` and `StoreObserver` accept any thenable in place of a native promise
- Port every package to the reworked `@metreeca/qest` retrieval model: a retrieval leaf is written as the atomic `{}`
	and a collection carries its criteria on the entry naming it, so the notation states neither type nor cardinality and
  every structural decision is read off the shape
- `@metreeca/keep` — `StoreClient.lookup` takes the resource shape as a type parameter, so results type through the
	`@metreeca/blue/value` `Match` inference; call sites are unchanged
- `@metreeca/keep` — store requests and results type through the `@metreeca/blue/value` inference (`Model`, `Slice`,
	`Draft`, `Match`)
- `@metreeca/keep-flake` — `createFlake`, `createModelFlake` and `createQueryFlake` accept a `@metreeca/qest/model`
	`Template` and `Query<Slot>` in place of the withdrawn `Model` and `Query` types, and `createFlake` no longer
	overloads on a query argument; the package no longer exports its own retrieval fragment type
- `@metreeca/keep-flake` — `Drain` carries the query requested at a node as `query` in place of `mould`
- `@metreeca/keep-flake` — `Entries` maps each property name to a single `Branch` in place of an array: a name declared
  by several variants of a union-typed node is one property (union coherence, enforced by `@metreeca/blue`), reached
  through one branch ranging over the disjunction of the per-variant declarations, with the requests reaching it folded
  into one drain
- `@metreeca/keep-flake` — `Drain` settles the `form` the query takes against the node's range (`atomic`, `template`,
	`locale`, `projection` or `union`, the latter with the drain of each variant it reaches), so consumers switch on the
	form rather than re-classifying the query; a query fitting no form the range admits is rejected with `RangeError`, and
  a non-resource model root carries no drain
- Deliver a localised property as a single tag-keyed map whatever its declared bounds, and classify a branch from the
	cardinality the property itself declares
- Track `@metreeca/qest` and `@metreeca/blue` dropping the absent marker from retrieval models: a template, projection,
  locale or union stating an `undefined` entry is rejected, and a key left out is the only way not to ask for a slot;
  `undefined` still marks an absent value in resource state
- Track the `@metreeca/qest` module renames to `model` and `state`
- Track the `@metreeca/core` module rename from `structures` to `values`
- `@metreeca/keep-rest` — `createRESTStore` takes its `fetch` transport as an option alongside `trusted`, in place of a
  leading positional argument
- `@metreeca/keep-rest` — `Store.create` rejects with a `Problem` a `Location` header resolving outside the container
	of the request `entry`, cross-origin IRIs included, in place of returning it verbatim
- Upgrade to `@metreeca/core` 0.12, `@metreeca/qest` 0.11, `@metreeca/blue` 0.11, `@metreeca/http` 0.4,
	`@metreeca/tape` 0.11, `@metreeca/trio` 0.1.2 and the `@metreeca/wire-sparql` 0.11.1 connectors

### Removed

- The two retrieval elision filters, following the withdrawal of `isVacuous` from `@metreeca/qest`
- `@metreeca/keep-suite` — the conformance cases the retrieval rework leaves without a subject: typed-leaf and
	tuple-arity rejections, per-leaf elision, kind-based branch discrimination and per-tag arity mismatches
- `@metreeca/keep` — the `depth` option of `StoreClient.insert`: like `create` and `update`, `insert` accepts captive
	references only as bare IRIs and rejects inline captive batches, pending cascading captive writes
	([#4](https://github.com/metreeca/keep/issues/4))

### Fixed

- `@metreeca/keep-sparql` — retain stored `rdf:type` triples where the resource shape declares no class of its own, so a
  class-less shape factored under a common supershape no longer retracts types it never wrote
- `@metreeca/keep-sparql` — drop a nested resource carrying no content on write, rather than minting a subject identity
  with nothing under it
- `@metreeca/keep` — `createCachingStore` no longer caches a lookup finding no resource, so a later lookup picks up the
  resource once it exists
- Retrieve a union variant reached by several alternatives once, to the depth its most demanding alternative asks for,
  rather than through whichever alternative happens to come last
- `@metreeca/keep-sparql` — retrieve a union value held by a localised text variant, which a template lookup returned
  empty
- `@metreeca/keep-flake` — `Flake.order` holds the numeric sort order its type declares, with the `"asc"` and `"desc"`
	shorthands normalised to `1` and `-1`
- `@metreeca/keep-flake` — a union drain is keyed by the variants the frozen flake exposes on its range, so looking up a
	variant's drain by `getShapeBranches(flake.range.shape)` finds it
- Read a union alternative that could be either a template or a tag-range map as a template only, as
	`@metreeca/qest` requires: a template alternative such as `{ latitude: {} }` no longer turns a sibling atomic over a
	localised variant into a dictionary
- Hand each variant a template alternative spans only the members that variant admits, as `@metreeca/qest` allows a
  union template to span several nested-resource variants

## [0.10.0](https://github.com/metreeca/keep/releases/tag/v0.10.0) - 2026-09-09

### Added

- `@metreeca/keep` — core model-driven storage API, defining the backend-agnostic `StoreClient` and `Store` interfaces
	and the batching, caching, managing and validating decorators
- `@metreeca/keep-flake` — shape-driven traversal trees, reorganising a resource shape and its retrieval model or
	collection query into a single structure connectors walk to generate queries and decode results
- `@metreeca/keep-suite` — connector conformance test suite, providing shared fixtures and a harness verifying that
	connector implementations honour the `Store` contract
- `@metreeca/keep-rest` — REST/JSON proxy connector, forwarding every store operation to a remote endpoint over HTTP
- `@metreeca/keep-sparql` — SPARQL 1.1 repository connector, translating store operations into queries and updates
	against a pluggable graph backend from the [@metreeca/wire](https://github.com/metreeca/wire) collection

### Changed

- Restructure the repository as an npm workspaces monorepo, publishing the framework as the five packages above rather
	than a single package
