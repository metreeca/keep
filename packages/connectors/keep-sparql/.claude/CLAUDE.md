---
title: SPARQL Store Guidelines
description: Development guidelines and conventions for the SPARQL store engine.
---

# References

- [SPARQL 1.1 Query](https://www.w3.org/TR/sparql11-query/) - W3C query language for RDF

# Design Principles

- **SPARQL 1.1 standard**: Target SPARQL 1.1 Query and Update for all graph operations. Per-engine connectors handle
	dialect differences where needed.

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

	The projection emits **one variable per variant**; merging those per-variant columns back into the single value
	surfaced under a binding's alias is the **decoder's** responsibility, not the encoder's.

# Encoder Conventions

Conventions for `src/**/encode.ts` modules. Existing encoders (`detect/encode.ts`, `detail/encode.ts`,
`modify/encode.ts`, `select/encode.ts`) follow these patterns: match them when adding new ones.

> [!NOTE]
> The language-agnostic emitter conventions (no second IR in the emit body, leaf-only target-text conversion,
> identity-keyed variable allocation, phase isolation, IR minimality) live in the `connector-designer` skill and apply
> to every connector. Only the SPARQL-specific instantiation below stays here.

- **Defer anchor → SPARQL conversion** (the SPARQL instance of the skill's "convert to target-language text only at the
  leaf" rule): thread edge endpoints (the request entry, focus and target nodes) as raw `Variable | Term` values,
	typically `named(entry)` or a variable name, through every helper that just forwards them. Convert to SPARQL only at
	the leaf: [`link([source, property, target])`](../src/_/_encode.ts) renders the triple pattern and picks the stored
	direction, and the `select` encoder's local `anchor(...)` renders a bare edge owner. Don't call `variable(...)` /
	`term(...)` at the top of `encode(...)` if the result is then handed straight to a helper; pass the value through and
  let the leaf render it. Predicates and classes stay `named(property.forward)`, `named(rdf.type)` and the like:
	those are already at the leaf.
- **Key `scope.resolve` on the Flake node** (the SPARQL instance of the skill's identity-keyed variable allocation
	rule): allocate a coordinate's variable with `scope.resolve(node)`, using the `Scope` from `@metreeca/core/scope`,
	keyed on its immutable `Flake` / `Branch` node (plus the variant, where a union splits it), never on a path string. A
  flake is frozen once through `immutable(...)`, so every node holds a stable identity: the same coordinate always
	yields the same variable, and the same property name at distinct coordinates (`name` vs `vendor.name`) stays on
	distinct variables without a path-string discriminator. A name declared by several variants of a union (`Person.name`
  and `Organization.name` under `creator`) is one property by union coherence (qest §3.2), reached through a single
  `Branch` and bound to a single variable.

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

- **Quick interim oracle**: the in-process `oxigraph` block ([`src/index.test.ts`](../src/index.test.ts), the
	`describe("oxigraph", …)` WebAssembly build) is the fast oracle for iterating on a change. Run just it with
	`npx vitest run src/index.test.ts -t oxigraph` (whole conformance suite, ~13 s, no container). Use it to check every
	edit before moving on; the container and remote backend blocks are for final cross-backend verification, not the edit
	loop.

# Verified Backends

The **Verified Backends** table in [README.md](../README.md) MUST be kept in sync with the per-backend `describe(...)`
blocks in [src/index.test.ts](../src/index.test.ts): when adding, removing, or renaming a backend block, update both in
the same change, keeping each row's version pinned to the source it exercises and its Connectors cell to the factories
under test.
