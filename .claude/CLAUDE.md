---
title: Project Guidelines
description: Development guidelines and conventions for the @metreeca/keep package.
---

> [!CAUTION]
> Activating and following skill guidance is **MANDATORY** for every task. Before starting any work, identify and
> activate all relevant skills. Skill instructions are binding and override default behaviours. When in doubt about
> whether skill guidance is current, relevant skills MUST be reloaded.

# References

- [@metreeca/core](https://github.com/metreeca/core) - Core utilities and shared types
- [@metreeca/qest](https://github.com/metreeca/qest) - Linked data models and query languages
- [@metreeca/blue](https://github.com/metreeca/blue) - Model-driven linked data modeling
- [@metreeca/tape](https://github.com/metreeca/tape) - Simplified logging facade over LogTape

> [!CAUTION]
> Any work depending on QEST semantics MUST be checked against the specs index at `@metreeca/qest/src/index.md`. The
> specs are authoritative: in doubt, they win over code and tests; suspected spec errors must be raised, never worked
> around.

# NPM Scripts

- **`npm run clean`** - Remove dependencies and build artefacts
- **`npm run prime`** - Install dependencies from the lockfile
- **`npm run setup`** - Install dependencies and link sibling `@metreeca/*` repositories
- **`npm run build`** - Compile sources and generate docs
- **`npm run check`** - Run the test suite
- **`npm run proof`** - Build and serve docs
	- TypeDoc `--watch` doesn't support `entryPointStrategy: "packages"`,
	  see [#1772](https://github.com/TypeStrong/typedoc/issues/1772)
	- five-server file watching disabled with `--watch=false` to avoid EMFILE errors on the large generated `docs/`
	  folder

> [!CAUTION]
> **`prime` and `setup` are not interchangeable.** Run `prime` when finalising a public release: `@metreeca/*` imports
> resolve to the published releases recorded in the lockfile. Run `setup` for local development against unpublished
> sibling branches: imports resolve to the working copies in the neighbouring repositories.

# Testing

The root `vitest.config.ts` aliases all workspace `@metreeca/keep*` packages to their TypeScript source via regex, so
vitest transpiles directly from `src/` without requiring a prior build step. The aliases are convention-based and
require no manual updates when adding packages or subpath exports.

# Git

This is a single monorepo: every package lives under `packages/` within one repository. Contrary to the general "avoid
`git -C`" guidance in the global tool rules and the `version-manager` skill's Git Command Rules, `git -C <package-path>`
is **perfectly acceptable** here and preferred for scoping a command to a package subtree, since it lets commands be
pre-authorised in bulk. This override applies to `git -C` only; the other Git Command Rules (no command chaining, stage
files by name) still hold.

# Version Management

All workspace packages share the same version, defined in the root `package.json` `version` entry. When bumping the
version, cascade the change to all `packages/*/package.json` — both the package `version` entry and any internal
`@metreeca/keep*` dependency ranges.

When adding, removing, or renaming packages, update the package table in the root `README.md` Usage section to match.

# Package README Structure

Each `packages/*/README.md` follows this structure (read standalone on npm):

1. **Title** — `# @metreeca/<package>`
2. **npm badge** — links to npmjs.com
3. **Description with framework link** — one sentence combining `package.json` `description` with a link to the
   framework, for example `SPARQL storage connector for the [@metreeca/keep](...) model-driven linked data storage
	 framework.` The framework link is mandatory on every package, including the framework-namesake core package — the
   self-reference still anchors the package within the wider framework.

When changing a package description, update all three locations — `package.json` `description`, README first paragraph,
and module doc definition line — plus the package table in the root `README.md`.

4. **Role paragraph** — 1-2 sentences explaining what this package does in user terms, without referencing internal API
   types
5. **Transaction isolation and mutation events note** — `[!IMPORTANT]` or `[!WARNING]` alert documenting transaction
   isolation level and, where applicable, mutation event scope; mirror the claim made on the factory TSDoc (see
   `Transaction Isolation and Mutation Event Declarations`)
6. **Installation** — `npm install` command; peer dependencies on separate lines with an `[!IMPORTANT]` alert noting the
   version constraint
7. **Usage** — code example showing connector wiring with `createSPARQLStore`
8. **Support** — issue and discussion links
9. **License** — Apache 2.0 with link

**Standalone readability** — package READMEs are consumed on npm without the surrounding monorepo. Before publishing or
revising, verify:

- Every cross-reference to sibling packages, "connector packages", or other framework concepts resolves to an absolute
  URL — typically `https://github.com/metreeca/keep#installation` for the connector table, the sibling repository, or
  the matching TypeDoc page. No bare prose references that leave a cold reader stranded
- Code examples conform to the documented API contract — for example, `entry` literals in `Store` examples are absolute
  IRIs (`http://example.com/...`), since the contract rejects relative paths with `RangeError`
- Snippets parse as legal TypeScript — arrow-function placeholders use `() => { /* ... */ }` rather than bare
  `() => /* ... */` (which is a syntax error)

# Dependency Guidelines

- **Internal `@metreeca/keep*` packages**: Use regular dependencies, not peer dependencies. Consumers should not have to
  manually install the full transitive chain
- **External adapted libraries** (for example, `oxigraph` in `@metreeca/wire-sparql-oxigraph`): Use peer dependencies.
  The consumer provides the library being adapted

# Issues

When filing issues against this monorepo, apply a `pkg:*` label to identify the affected package. Labels mirror
`packages/keep-<name>/` directory names (`pkg:core`, `pkg:suite`, ...) and share the convention colour `#0e8a16`, with
one exception: the SPARQL stack folds into the single `pkg:sparql` label rather than minting a label per package. The
stack is now just `keep-sparql`, since the backend connectors were extracted to the separate
[`@metreeca/wire`](https://github.com/metreeca/wire) collection. When a new non-SPARQL package is added, clone the
`pkg:core` label — same colour, description `<package> package` — to keep the set consistent.

> [!IMPORTANT]
> If filing an issue requires a `pkg:<name>` label that does not yet exist, create it autonomously following the
> convention above (`#0e8a16` colour, `<package> package` description), then apply it to the issue. This overrides
> the `issue-manager-create` skill's default "never attempt to create missing labels" rule for `pkg:*` labels only.

# Design Principles

- **Model-driven / shape-agnostic**: All store implementations MUST be entirely driven by the supplied shape. NEVER
  hardcode property names, dataset-specific assumptions, or any other domain knowledge. All structural decisions MUST be
  derived from the shape metadata at runtime.
- **Lowercase generated queries**: All generated query code (SQL, SPARQL, Cypher, etc.) MUST use lowercase for keywords,
  identifiers, and other generated tokens. Test expectations MUST match this convention.
- **Forward/reverse predicates**: `forward` and `reverse` on a `Property` are IRI predicates that control triple storage
  direction. Both write actual triples. For example, `broader` with `forward: toys.broader, reverse:
  toys.narrower` writes BOTH `<child> toys:broader <parent>` AND `<parent> toys:narrower <child>`.
- **Foreign properties**: `foreign` in a property's `PropertyConstraints` marks the property as read-only/derived. It
  reads triples already written by the target property's forward/reverse predicates. It does NOT write or delete any
  triples.
- **NEVER conflate reverse predicates with foreign properties**: They are independent concepts. A `reverse` predicate on
  a property writes a real triple in the inverse direction. A `foreign` property is a virtual view over triples owned
  by another property.
- **Embedded resources**: Embedded resources have no independent lifecycle or identity — they are created, updated, and
  deleted only in the context of their embedding resource. The `id` and `type` fields are not allowed on them.
- **Captive resources**: Identified by the `captive` flag in a property's `PropertyConstraints`. Captive resources have
  independent lifecycle and identity (unlike embedded resources), but on captor deletion they are always
  cascade-deleted. They can be created, updated, and deleted independently of the referencing resource. They may also
  optionally be created or updated in a single batch embedded within their captor resource.
- **NEVER conflate embedded and captive resources**: They are related but distinct concepts. Embedded resources lack
  independent identity and lifecycle. Captive resources have both, but are cascade-deleted with their captor.

# Transaction Isolation and Mutation Event Declarations

The `Store` interface contract requires every implementation to document its supported transaction isolation level and
mutation event scope. The graph-layer `Repository` interface (in `@metreeca/wire-sparql`) carries the same isolation
requirement.

**Placement** — on the factory function TSDoc (the exported `create*` symbol), immediately after the brief description.
Anchor on the factory rather than the module so that each `create*` overload can declare its own level.

**Format** — two adjacent `[!IMPORTANT]` admonitions, mirroring the alert level used on the interface contract, each
leading with a bold label:

```typescript
/**
 * <one-line description>
 *
 * <extended description>
 *
 * > [!IMPORTANT]
 * > **Transaction Isolation** — provides <level> isolation: <how callers experience it>.
 *
 * > [!IMPORTANT]
 * > **Mutation Events** — emits <scope> events: <how callers experience it>.
 */
```

**Wording conventions**:

- **Native backend** — name the level (`Read-committed`, `Snapshot`, `Serializable`, `None`) and follow with a
  one-sentence justification of how the backend achieves it.
- **Wrapper factory** — state explicitly that semantics are inherited, for example
  `Inherited from the wrapped {@link Store}`.
- **Delegating factory** — state which inner component determines the level, for example
  `Determined by the supplied {@link @metreeca/wire-sparql!Repository | Repository}`.
- **No native support** — use `None` and describe the resulting caller-visible behaviour (eager apply, no rollback, no
  cross-client signal).

**README mirror** — every package README MUST also carry the same isolation (and, where applicable, events) claim as an
`[!IMPORTANT]` or `[!WARNING]` alert in the slot defined by the `Package README Structure` section, so the contract is
visible to npm readers without drilling into the API reference. See
[`keep-sparql/README.md`](../packages/connectors/keep-sparql/README.md) for a delegating-factory claim, and the
[`@metreeca/wire-sparql-oxigraph`](https://github.com/metreeca/wire/blob/main/packages/wire-sparql-oxigraph/README.md)
README for a native-backend claim.
