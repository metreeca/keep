# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.13.0](https://github.com/metreeca/keep/compare/v0.12.2...HEAD)

### Added

- `@metreeca/keep` — `createBatchingStore` hands each handler a batch of requests sharing one plan (the same shape,
  model and locale for a detail, the same field, query and locale for a selection), so connectors read the plan off
  any request and never compare them, and takes a `limit` option capping the requests per batch and type, so a
  connector declares what its backend accepts in one query and a larger accumulation runs as several batches
- `@metreeca/keep` — the `limit` option of `createBatchingStore` takes a `burst`, the most handler calls in flight at
  once, so a connector whose backend limits its connections, or charges per concurrent query, is never asked for
  more than it declares; without one every call of a round still runs at once, as before
- `@metreeca/keep-sparql` — `createSPARQLStore` takes a `batch` cap on the entries one query binds and a `burst` cap
  on the queries in flight at once, with defaults of `500` and `8` and `0` lifting a cap, so a backend behind a
  gateway with a short request limit or a tight connection pool is served within what it accepts
- `@metreeca/keep-flake` — `getFlakeTemplate` rebuilds the retrieval template a node's branches request, restricted
  to one union variant on demand, so a connector expanding a nested resource hands it to its retrieval pass under
  the template the original request stated instead of reconstructing it from the tree

### Changed

- `@metreeca/keep-suite` — template retrieval requires connectors to accept a locale alternative over the text variant
  of a union-typed property, returning the localised text as a dictionary, where it previously required rejection
  with a `RangeError`; alternatives reaching the same variant fold into one request, a locale or template prevailing
  over the atomic and templates merging their properties (§5.5), so connectors passing the 0.12 suite may need updating
- `@metreeca/keep-suite` — grouped retrieval requires connectors to accept a sort or focus key matching a grouping key
  over a multi-valued property, sorting or ranking the groups by their key value (§5.7.4, §5.7.5, §5.8.2.1), as
  faceted listings need to keep selected values on top; the same keys stay rejected on ungrouped queries

### Removed

- `@metreeca/keep-flake` — `isScalarFlake`, which no connector or component consumed: a computed node that does not
  aggregate is told by `isComputedFlake` and `isAggregateFlake` together, with no separate predicate needed

### Fixed

- `@metreeca/keep-sparql` — looking up a large collection with a template expanding its members no longer fails or
  slows down on query size: the generated queries grow with the template and linearly with the members, no longer
  with their product ([#22](https://github.com/metreeca/keep/issues/22)), and no query binds more than 500 entries,
  as a larger batch reaches the connector as several batches; a paged multi-valued property read under several
  members is windowed by the backend for each member, through one subselect per member, so no query fetches a row
  beyond the pages requested, however many members the template expands and however many values each one holds
- `@metreeca/keep-sparql` — a backend failure on one query rejects the requests that query served and no other:
  unrelated requests batched in the same round, such as the other members of an expanded collection, settle on
  their own instead of all rejecting with the one error, so a lookup fails only where its own query failed
- `@metreeca/keep-sparql` — updating a resource no longer slows down with the product of the values of its
  multi-valued properties: clearing its previous state now scales with the number of triples it holds, where a
  product with a few keywords, documents, categories and reviews previously took seconds to update on Oxigraph
- `@metreeca/keep-sparql` — a property declaring both a forward and a reverse predicate is cleared and cascaded in
  whichever direction its edge is stored: updating a resource now retracts an owned edge a graph loaded by other
  means carries in one direction only, and deleting a resource reaches the embedded and captive resources linked to
  it through such an edge, where both were previously left behind next to the new state
- `@metreeca/keep-sparql` — a collection query under an explicitly empty language priority matches no localised
  text, taking the supplied priority literally as the specification requires, instead of falling back to `und`;
  the `und` default still applies where a request states no priority at all, as it does on every other lookup

## [0.12.2](https://github.com/metreeca/keep/compare/v0.12.1...v0.12.2) - 2026-10-22

### Fixed

- `@metreeca/keep-flake` — a projection binding with an empty path (`"dataset=": { id: {}, title: {} }`) projects the
  item itself under its binding name, next to its grouping aggregates, instead of dropping the cell and flattening
  the nested template into the row; a nested template expanded from a projected cell retains the `id` / `type`
  markers it requests, which the expanded resource silently left out before this release

### Security

- Upgrade `vite` to `8.3.5`, fixing GHSA-587h-7wmj-h5pm, GHSA-r825-w8mm-5pxw and GHSA-698v-4r3x-3vcv (development
  dependency, no consumer impact)
- Upgrade `markdown-it` to `14.3.3`, fixing GHSA-gfr2-rv44-r23c (development dependency, no consumer impact)
- Upgrade `vitest` to `4.1.12`, fixing GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp (development dependency, no
  consumer impact)

## [0.12.1](https://github.com/metreeca/keep/compare/v0.12.0...v0.12.1) - 2026-10-20

### Fixed

- `@metreeca/keep-sparql` — `Store.lookup` fails with a `RangeError` on a blank node naming an embedded resource,
  instead of silently dropping that resource and the content requested under it from the result

## [0.12.0](https://github.com/metreeca/keep/compare/v0.11.1...v0.12.0) - 2026-10-19

### Changed

- Upgrade `@metreeca/blue` to `^0.13.0`
- Upgrade `@metreeca/core` to `^0.13.0`
- Upgrade `@metreeca/http` to `^0.5.0`
- Upgrade `@metreeca/qest` to `^0.13.0`
- Upgrade `@metreeca/tape` to `^0.12.0`
- Upgrade `@metreeca/trio` to `^0.2.0`
- Upgrade `@metreeca/wire-sparql` to `^0.12.0`

### Removed

- Remove the `rdfs` namespace from `@metreeca/keep-suite/toys`: take it from `@metreeca/trio`, which defines it
  (`import { rdfs } from "@metreeca/keep-suite/toys"` → `import { rdfs } from "@metreeca/trio"`)

## [0.11.1](https://github.com/metreeca/keep/compare/v0.11.0...v0.11.1) - 2026-10-14

### Changed

- Upgrade `@metreeca/core` to `^0.12.1`
- Upgrade `@metreeca/blue` to `^0.12.1`
- Upgrade `@metreeca/qest` to `^0.12.1`
- Upgrade `@metreeca/tape` to `^0.11.1`
- Upgrade `@metreeca/trio` to `^0.1.3`
- Upgrade `@metreeca/wire-sparql` to `^0.11.2`
- Upgrade `@metreeca/http` to `^0.4.1`

## [0.11.0](https://github.com/metreeca/keep/releases/tag/v0.11.0) - 2026-10-01

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
- **BREAKING** `@metreeca/keep` — `createManagingStore` takes the management options alone, with `execute` required:
	the connector hands its `StoreClient` to each task through `execute`, and a non-transactional backend supplies one
  applying the task directly
- `@metreeca/keep` — `Store.execute` atomicity is best-effort, like isolation: connectors target all-or-nothing commit
	and document whether a failing task rolls back; `@metreeca/keep-rest` applies task mutations eagerly, with no
  rollback
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
- `@metreeca/keep-sparql` — a stored literal is read back after the variant its property declares, so a literal whose
	datatype does not fit the variant is absent rather than coerced; comparison bounds and match options are routed
	to a union variant by `@metreeca/blue`, so a plain-string operand on a union pairing a string and a localised text
	variant is rejected as ambiguous
- Upgrade to `@metreeca/core` 0.12, `@metreeca/qest` 0.12, `@metreeca/blue` 0.12, `@metreeca/http` 0.4,
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
