---
title: SPARQL Store Guidelines
description: Development guidelines and conventions for the SPARQL store engine.
---

# References

- [SPARQL 1.1 Query](https://www.w3.org/TR/sparql11-query/) - W3C query language for RDF
- [Pass contract](../src/index.md) - the layers, the spine, the schema rule and the clause structure of every pass

# Design Principles

- **SPARQL 1.1 standard**: Target SPARQL 1.1 Query and Update for all graph operations. Per-engine connectors handle
	dialect differences where needed.

- **Five layers**: `terms.ts` (value and term codecs, no SPARQL), `patterns.ts` (shape-aware emitters), a `schema.ts`
	per reading pass (the columns encoder and decoder share), the pass folders (driver, encoder, decoder) and `spine.ts`
	(the one round trip, the owner index, nested requests, per-request settlement). Each layer depends only on the one
	below; the `connector-designer` skill holds the conventions and MUST be activated on pass work.

- **Everything is a range**: Every value coordinate a flake exposes resolves to a
	[`flake.range`](../../../components/keep-flake/src/index.ts): a `@metreeca/blue/value` `Range` whose `shape`
	expands, through `getShapeBranches(range.shape)` from `@metreeca/blue/union`, into a **never-empty** list of variants.
  The range is the **single, universal representation** of what a coordinate can hold; all encode/decode logic MUST be
  driven by iterating those variants uniformly.

	> [!CAUTION]
	> There is **no "single" and no "union" case**. A range is a set of one or more variants; a one-variant range is not
	> a special kind, it is the degenerate count of the same iteration. **NEVER** branch on the variant count
	> (`> 1` / `=== 1`) to switch behaviour: that reintroduces a "sole variant" concept that does not exist.

	> [!CAUTION]
	> **Ranges INCLUDE dictionary shapes, NO EXCEPTIONS.** A dictionary shape is an ordinary variant of a range, reached
	> like any other (for example a path crossing a union: `creator.name` → `[string, dictionary]`).
	> **NEVER** filter dictionaries out of a range's variants (`variant.kind !== "dictionary"`) or treat them as a side
	> channel.

	The schema of a pass emits **one column per variant**; reading the single value surfaced under a slot off the
	column that bound is the **decoder's** responsibility, not the encoder's.

# Encoder Conventions

Conventions for `src/**/encode.ts` modules. Existing encoders (`detect/encode.ts`, `detail/encode.ts`,
`modify/encode.ts`, `select/encode.ts`) follow these patterns: match them when adding new ones.

> [!NOTE]
> The language-agnostic conventions (layer boundaries, the schema contract, pure decoders, leaf-only target-text
> conversion, identity-keyed variable allocation, IR minimality) live in the `connector-designer` skill and apply to
> every connector. Only the SPARQL-specific instantiation below stays here.

- **Compose `patterns.ts`, add no emitter of your own**: an encoder assembles clauses from the shared emitters
	(`link`, `forward`, `reverse`, `membership`, `textual`, `expression`, `coalesced`, `folded`); a helper rendering an
	edge, a gate or a label that one pass needs belongs in `patterns.ts`, so the next pass composes it.
- **Defer anchor → SPARQL conversion** (the SPARQL instance of the skill's "convert to target-language text only at the
  leaf" rule): thread edge endpoints (the request entry, focus and target nodes) as raw `Variable | Term` values,
	typically `named(entry)` or a variable name, through every helper that just forwards them. Convert to SPARQL only at
	the leaf: [`link([source, property, target])`](../src/patterns.ts) renders the triple pattern and picks the stored
	direction, and `anchor(...)` renders a bare edge owner. Don't call `variable(...)` / `term(...)` at the top of
	`encode(...)` if the result is then handed straight to a helper; pass the value through and let the leaf render it.
	Predicates and classes stay `named(property.forward)`, `named(rdf.type)` and the like: those are already at the leaf.
- **Resolve columns through the schema**: a column's variable comes from `column(scope, column)` of the pass's
	`schema.ts`, keyed on the plan node and, for a union-typed node, on the variant; the owner column is keyed on the
	batch record (`scope.resolve(group)`, `scope.resolve(flake)`), and only probes nobody reads are anonymous
	(`scope.resolve()`). A flake is frozen once through `immutable(...)`, so every node holds a stable identity: the
	same coordinate always yields the same variable, and the same property name at distinct coordinates (`name` vs
	`vendor.name`) stays on distinct variables without a path-string discriminator.

# Transaction Isolation and Mutation Event Declarations

The graph-layer `Repository` interface, consumed from `@metreeca/wire-sparql`, carries its own isolation contract
documented in that package; this package does not redeclare it.

Within `@metreeca/keep-sparql`, the `createSPARQLStore` factory is a delegating `Store` factory: it declares both
**Transaction Isolation** (determined by the supplied `Repository`) and **Mutation Events** on its factory function
TSDoc, following the format defined in the root `CLAUDE.md`.

# Testing

- Features in this package are tested by `src/index.test.ts`, which defines the SPARQL conformance suite inline (wiring
	the shared `@metreeca/keep-suite` harness) and runs it against the connector packages: themselves pure
	`@metreeca/wire-sparql` `Repository` connectors carrying no tests of their own. The connectors are dev-only
	dependencies pulled in solely for these conformance runs

- Unit tests per layer pin what the oracle cannot see: `spine.test.ts` (owner indexing, settlement, nested requests,
	failure isolation), `*/schema.test.ts` (the column list per discriminator), `*/decode.test.ts` (decoding from
	literal tuples, holes included), `*/encode.test.ts` (query-size invariants: arm count, column count, bound entries),
	`*/index.test.ts` (driver wiring, with an oxigraph-backed window check in the select driver)

- **Quick interim oracle**: the in-process `oxigraph` block ([`src/index.test.ts`](../src/index.test.ts), the
	`describe("oxigraph", …)` WebAssembly build) is the fast oracle for iterating on a change. Run just it with
	`npx vitest run src/index.test.ts -t oxigraph` (whole conformance suite, ~3 s, no container). Use it to check every
	edit before moving on; the container and remote backend blocks are for final cross-backend verification, not the edit
	loop.

# Verified Backends

The **Verified Backends** table in [README.md](../README.md) MUST be kept in sync with the per-backend `describe(...)`
blocks in [src/index.test.ts](../src/index.test.ts): when adding, removing, or renaming a backend block, update both in
the same change, keeping each row's version pinned to the source it exercises and its Connectors cell to the factories
under test.
