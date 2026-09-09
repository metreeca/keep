---
title: Test Suite Guidelines
description: Design principles and conventions for the store conformance test suites.
---

# Suite Structure

The suite verifies a `Store` implementation against the contract in `src/index.ts`. Connector packages consume it
through factory injection: `testStore(options)` composes every sub-suite, each receiving a `TestFactory` that wraps test
bodies with a context of `{ store, contains, includes, excludes, generate, populate }`. Sub-suites and individual tests
are filtered through `StoreTestPatterns` tags (`RetrieveTemplate`, `ManageExecuteIsolation`, …).

## Data Population

Retrieve sub-suites read the whole sample set, so each calls `populate` in its own `beforeAll` to clear and reload the
store. Persist and manage sub-suites never read it: they mint isolated fixtures via `generate` or build literal states,
so they omit `populate` intentionally.

# Design Principles

- **No cross-dependencies between operation tests**: Persist tests (create, update, delete, insert, remove) MUST NOT
  call `store.lookup` or any other store operation beyond the one under test. Use the `includes` and `excludes`
  test helpers to verify outcomes independently.
- **No mutation of preloaded data**: Mutation tests MUST NEVER alter preloaded sample data. Use the `generate` helper
  from the test context to create isolated test targets with unique identifiers that do not conflict with the sample
  dataset or other tests.

# Conventions

Apply to every test file, regardless of operation family.

- **Nested `describe` structure mirrors the primary axis**: the outer `describe` names the operation under test; inner
  `describe` blocks mirror the [primary axis](#primary-axis) leaves (`scalar properties`, `array properties`,
  `localised properties`, `union properties`), with operational concerns that sit outside the axis (return-value
  contract, validation, isolation) grouped under a sibling `contract` `describe`. Multiple top-level `describe`
  blocks per file are acceptable when the axis coverage is broad enough to make the outer wrapper redundant
- **Positive and negative tests grouped together**: tests covering the positive and negative cases of the same feature
  MUST sit in the same `describe` block (for example, "returns id for a new resource" and "returns undefined for an
  existing resource" both live under `contract`) so that coverage gaps are visible at the block level
- **One primary assertion per test**: `includes(state, Shape)` on a full resource verifies whole-state equality;
  additional assertions MUST target specific invariants (for example, old embedded resources gone) rather than re-check
  the primary outcome. Use partial probes with `includes` or `excludes` to assert targeted presence or absence — for
  example, asserting a retracted reverse triple is gone via `excludes({ id, vendor: oldVendor }, Shape)`
- **Fixture selection via `lookup`**: tests depending on a structural feature (for example, "a vendor with a
  `PostalAddress` address") MUST use `lookup` with a predicate, never positional indexing. Positional access is
  acceptable only for isolation tests where any record will do
- **Skip when fixture missing**: when `lookup` returns `undefined`, early-return silently rather than fail — fixtures
  evolve and tests must not become brittle against dataset shape
- **Unique identifiers per test**: mutation targets MUST use test-local identifiers (for example, `NEW-001`, `INS-002`)
  that cannot collide with sample data or other tests

# Data Structure

Primary structural axis shared by persist and lookup suites. Applies to both `Resource` (state) and `Template`
(retrieval) hierarchies, which mirror each other one-to-one except at **union properties**, where state and template
encodings diverge (see below). Test files group tests under nested `describe` blocks along this axis, with
**orthogonal axes** (cardinality, absence semantics, link semantics, captive lifecycle) layered on top.

## Primary Axis

Undefined entry values and empty structures — `undefined`, `{}` (empty nested resource or empty union payload), `[]`
(empty array or empty shorthand), `{ und: [] }` (empty language map) — MUST be ignored at every leaf as if the owning
property were omitted; when an empty nested resource appears as an element of a multi-valued slot, the element itself
MUST be dropped.

- **root resources**
	- **special fields** — `id`, `type`
	- **scalar properties** — single-valued slots
		- literals (`boolean`, `number`, `string`)
		- references (IRI) — captive references additionally admit IRI plus nested state via cascading captive writes
		  (deferred)
		- embedded resources — recurse as per root resources, with `id` and `type` rejected; empty `{}` ignored
	- **array properties** — multi-valued slots, element content as per scalar (including captive references via cascading
	  captive writes, deferred), set semantics
	  (duplicate elision, order immaterial); empty `[]` ignored
	- **localised properties** — `Localised` value sets; empty map `{}` and empty shorthand `[]` ignored
		- plain string shorthand (`und` tag)
		- plain string-array shorthand (`und` tag)
		- single-valued language map
		- multi-valued language map
	- **union properties** — state and template hierarchies diverge at this leaf; per-branch content follows scalar /
	  embedded / localised recursively
		- **state side** (resource) — variant payload is carried **flat in the owning slot**, with no variant-name wrapper
		  and no indexed frame; the active branch is fixed by matching the value against the shape's declared variants
		  (literal by value-domain membership, node by structure) and MUST single out **exactly one** — a value matching
		  none is unsatisfiable, one matching several is ambiguous, and both are rejected. The shape is responsible for
		  keeping variants disjoint (a modelling requirement), so ambiguity is unreachable with the suite's shapes.
		  Single-valued slots hold the bare payload (primitive or embedded object); multi-valued slots hold mixed-variant
		  arrays of bare payloads; empty embedded payload `{}` ignored as per embedded resources
		- **template side** (retrieval) — a union-typed property is addressable only through the *keyed*
		  form, which holds `Placeholder` values (not nested `Union`s), so per-branch recursion goes through a nested
		  `Template`:
			- **keyed form** — an object whose keys are **opaque** non-negative integer strings carrying no positional or
			  nominal meaning; each value is an alternative `Placeholder`, and the branches it retrieves are fixed by matching
			  that placeholder against the property's variants **by kind**, its value immaterial (a literal by processing
			  kind, a reference by reference kind, a template by structure), NOT by the key. An alternative MAY match several
			  variants, retrieving each, but MUST match **at least one** — one matching no variant is unsatisfiable and
			  rejected. A literal or reference alternative does not tell same-kind variants apart and so requests them all; a
			  template's structure discriminates the resource variants it fits; a variant left unmatched contributes no value
			- **bare placeholder** — over a union-typed property it is mismatched and rejected (§5.4), whichever single branch
			  it may resemble; a bare `Placeholder` is valid only when the property is not union-typed

## Orthogonal Axes

- **cardinality** — required / optional / `cardinality(min, max)` bounds enforcement at the shape layer
- **absence semantics** — `undefined`, `{}`, `[]`, `{ und: [] }` MUST be treated as property absence at every applicable
  leaf of the primary axis; persist tests assert removal from storage, lookup tests assert omission from results
- **link semantics** — forward / reverse predicate pairs (both write real triples) vs foreign references (read-only
  derived view; no writes)
- **captive lifecycle** — captive references (orthogonal to link semantics; applies to scalar and array reference slots
  alike) carry independent identity and lifecycle but are cascade-deleted with their captor; managed standalone today,
  with cascading captive writes (creation/update/insertion through the captor slot as IRI plus nested state) deferred
  pending [metreeca/keep#4](https://github.com/metreeca/keep/issues/4)

# Persist

Applies to mutation suites: `create`, `insert`, `update`, `remove`, `delete`.

- **Union state encoding**: every mutation file MUST cover both the optional single union (`Vendor.address`) and the
  multi-valued union (`Vendor.contacts`), exercising each admitting slot against both a **primitive variant** (for
  example, plain-string `address`, `email` or phone-string `contacts` entry) and an **embedded variant**
  (`PostalAddress`), and including variant switches where the operation admits them. The persisted value's storage
  branch is fixed by matching it against the declared variants and MUST single out exactly one (§5.4); `create` MUST
  also cover the **literal-variant unions** `Vendor.score` (decimal / grade) and `Vendor.certified` (boolean / decimal /
  grade / year), where the branch is chosen purely by value-domain membership, plus rejection of an **unsatisfiable**
  state value matching no variant. An ambiguous state value (matching several variants) is unreachable with the suite's
  deliberately-disjoint shapes
- **Absence semantics**: `insert` and `update` MUST explicitly exercise `prop: undefined`, `prop: []`, `prop: {}`, and
  `prop: { und: [] }` for at least one slot of each admitting primary-axis leaf (scalar, array, localised, union),
  asserting the property is removed rather than stored as empty. `create`, `delete` and `remove` are exempt: `create`
  states the full intended shape so empty forms at creation are equivalent to omission with nothing to retract;
  `delete` and `remove` drop the whole resource, so property-level absence is moot and neither operation takes a state
  parameter
- **Reverse predicates**: tests covering properties with a `reverse` predicate MUST assert that the inverse triples are
  actually written on persist and removed on retract
- **Foreign references**: tests covering `foreign` references MUST assert that no triples are written or deleted through
  the foreign slot — the view is read-only and derived from its target property
- **Captive cascades**: deferred — captive lifecycle tests (independent create / update / delete by own IRI,
  cascade-delete on captor removal) and cascading captive writes (creation/update/insertion through the captor slot as
  IRI plus nested state) are tracked in [metreeca/keep#4](https://github.com/metreeca/keep/issues/4) and intentionally
  not exercised by the suite until the form is supported

# Retrieve

Applies to query suites driven by the template model (`Placeholder` / `Union` / `Projection` / `Selection`). Each lookup
file exercises one primary machinery layered on the shared data-structure axis:

- `lookup/template.ts` — recursive template retrieval starting from a top-level resource (§5.1–5.4)
- `lookup/query.ts` — multi-valued / collection-retrieval arms against a directly-retrieved resource (§5.5)
- `lookup/selection.ts` — filtering, ordering, slicing and focus operators (§5.7)
- `lookup/projection.ts` — projection of computed values and grouping (§5.6, §5.8.2.1)
- `lookup/expression.ts` — the `pipe:path` expression spectrum targeted by selection and projection keys (§5.8)
- `lookup/localised.ts` — coalesced and structural localised access under language negotiation (§5.3, §6)

## Template

Recursive `Template` retrieval from a top-level resource IRI, driving the full primary axis — scalar, array, localised,
union, embedded, foreign references — via nested `Template` expansion.

- **Union templates**: a union-typed property is addressable only through the *keyed* form (opaque `${number}` keys,
  §5.4), the branches fixed by matching each alternative placeholder against the variants **by kind** (its value
  immaterial), not by the key; tests MUST exercise it on both an optional single union (`Vendor.address`) and a
  multi-valued union (`Vendor.contacts`), covering per-branch recursion through nested `Template`s, branch matching and
  skipping, key opacity (an embedded branch singled out by structure under an arbitrary key), the **literal-variant
  unions** `Vendor.score` / `Vendor.certified` retrieved by kind (a single string alternative matching **both** the
  grade and year same-kind variants of `Vendor.certified`), acceptance of a kind-matching alternative whose value lies
  outside the variant domain, rejection of mixed key spaces and of an **unsatisfiable** alternative (whose kind matches
  no variant), and rejection of a bare `Placeholder` over a union-typed property
- **Nested reference retrieval**: every reference slot MUST be retrievable both as id-only (via `reference` shape)
  and as an expanded nested resource (via `resource` shape), covering scalar, multi-valued, and self-referential
  references, plus multi-level nesting
- **Absence semantics**: retrieval MUST omit the property from results when the underlying slot is absent, at every leaf
  alike (scalar, array, localised, union) — absent slots are never surfaced as empty `[]`/`{}` structures
- **Locales shorthands**: tests exercising localised text MUST cover canonical map form, plain string and string-array
  shorthands, verifying retrieval returns values in the requested shape
- **Reverse predicates**: retrieval through a `reverse` predicate MUST yield the inverse triples written by the forward
  slot
- **Foreign references**: retrieval through a `foreign` reference MUST yield the triples owned by the target property
  without triggering any write

## Selection

`Selection` constraints (filtering, ordering, slicing) and the `Expression` model that drives them. Template machinery (
primary axis, nested references, union forms) is covered by the `Template` suite and is not re-asserted here.

- **Selection constraints**: tests MUST cover each operator, both **in isolation** and **combined** (for example,
  filtering and ordering applied together to the same query):
	- filtering — `<`, `>`, `<=`, `>=` (comparison), `~` (substring search), `?` (disjunctive match), `!`
	  (conjunctive match)
	- ordering — `^` (sort ordering, signed number or `"asc"`/`"desc"` with 1-based precedence), `+` (focus ordering,
	  prioritises matching values over regular sort)
	- slicing — `@` (offset), `#` (limit)
- **Expressions**: every `Expression` occurrence in a selection key MUST be exercised across the full `pipe:path`
  spectrum — a wide range of mixes of pipe and path cardinalities, plus the content dimensions layered on each:
	- **path length** — empty (root / aggregate), singleton step, multi-step nested path
	- **path steps** — plain property steps and special steps (`id`, `type`)
	- **pipe length** — empty (identity), singleton transform, multi-transform chain
	- **pipe transforms** — scalar-only, aggregate-only, mixed scalar-aggregate composition
	- **component mixes** — empty / singleton / multiple pipe cross-producted with empty / singleton / multiple path, so
	  every combination is represented
- **Aggregates**: a pure selection is ungrouped (grouping is fixed by the projection alone, §5.8.2.1), so an aggregate
  constraint reduces over each item's own values; tests MUST cover each aggregate pipe (`count`, `sum`, `min`, `max`,
  `avg`) in both a filter and a sort key over a multi-valued path, asserting the per-item reduction filters or orders
  the items rather than producing a collection-wide scalar or grouping the collection

## Projection

Projection of computed values via `Projection` bindings, yielding a flat row schema. Template machinery and
`Selection` operators are covered by their own suites; this suite focuses on projection-specific forms and their
interaction with selection applied to projected rows.

- **Bindings**: a projection is told by its `=`-bearing binding keys, so every projection key MUST be an explicit
  `name=expression` binding (qest removed the plain-identifier `name=name` shorthand); binding-name uniqueness is
  enforced. A collection element whose keys are all bare identifiers is a template, not a projection: a bare identifier
  retrieves its entry by template descent, covered by the `Template` suite, and tests MUST assert it is not mistaken for
  a projection binding
- **Projected values**: tests MUST cover each projected-value form — literal-typed, reference-typed, embedded-template,
  and union-typed expressions; a union-typed binding MUST use the *keyed* form (opaque `${number}` keys, branches fixed
  by matching each alternative by kind or structure, its value immaterial), and a plain `Placeholder` over one MUST be
  rejected (§5.4)
- **Single-valued only**: a projected value is NEVER an array — a multi-valued singleton-tuple binding value MUST be
  rejected. A structural `Locales` map is admitted (§5.6): it occupies a single dictionary cell, counting as one value
  and never fanning out a row, so it is a valid projection value, not a rejected one
- **Selection interaction**: filtering, ordering and slicing MUST be exercised against projected rows, verifying the
  operators apply to the projected schema rather than to the underlying resources
- **Expressions**: the full `pipe:path` spectrum (see `Selection` § Expressions) applies to every `Expression`
  occurrence in a projection binding

# Manage

Applies to lifecycle and transaction suites: `execute`, `observe`, `close`.

- **Atomicity is universal** (`ManageExecuteAtomicity`): a store buffers writes and commits them only once the task
  resolves, dropping the buffer on failure, so all-or-nothing holds regardless of the backend's isolation level. The
  batched mutation event is part of the same atomic step (one event per committed transaction, none on rollback), so
  event delivery is asserted under atomicity rather than separately
- **Isolation is capability-gated** (`ManageExecuteIsolation`): governs read visibility within and across transactions
  (own-buffered-write invisibility, initial-state reads, concurrent-transaction isolation). `SNAPSHOT` is the suggested
  level but best-effort; a connector whose backend provides a weaker level excludes these tests through the
  `target`/`ignore` filter, engine by engine, while keeping the universal atomicity contract
- **Mutation-event scope** beyond the in-process observers exercised here (for example, cross-client signals on a shared
  backend) is declared per connector and governs the standalone `ManageObserve` suite

# Backend Testing

Connector suites that run this suite against a real backend gate integration tests on an environment variable, so they
skip gracefully when no backend is available (`describe.skipIf(!process.env.SPARQL_ENDPOINT)`). CI provisions backends
via GitHub Actions service containers; locally, a dedicated npm script drives the backend lifecycle with plain `docker`.
Container environment variables handle the bare minimum (create datasets, enable endpoints) while test code seeds and
cleans up via `beforeAll`/`afterAll`, so the same tests run unchanged against CI, local Docker, or a remote server.
