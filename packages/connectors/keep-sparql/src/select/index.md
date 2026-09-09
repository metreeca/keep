---
title: Select Projection — Encoder/Decoder Specification
summary: How the SPARQL select pass encodes batched collection queries as one table and decodes it back
description: Model-driven spec of the select pass projection, the row schema, and the encode/decode contract.
---

# Select Projection

Specification of the SPARQL select pass: how [`encode.ts`](./encode.ts) folds a batch of collection queries into one
SPARQL `SELECT` and how [`decode.ts`](./decode.ts) settles each request from the returned tuples.

The whole pass is **model-driven**: it reads only the [`Flake`](../../../../components/keep-flake/src/index.ts)
IR produced by `createFlake(shape, query)`, never the raw `Query` or `Shape`, and hardcodes no property names or domain
knowledge.

## Terminology

The result set is a table, described consistently throughout:

- **column** — a logical output column: one per `Projection` binding (keyed by its alias), or the single anonymous
  column of a degenerate `Union | Placeholder` query
- **cell** — the value at one (row, column) intersection: a single, possibly-structured value
- **variable** — a physical SPARQL `SELECT` variable. A column is emitted as **one variable per range variant**; the
  decoder coalesces the row's single bound variant variable into the cell value

So a table has `N` rows, each row holds one cell per column, and each column is realised in the query as one variable
per variant.

## Role

Each queued [`Select`](../../../../components/keep/src/clients/batching.ts) request carries
`{ entry, shape, field, query, locale }`, where `query` is one `Query` arm
(`[Union | Placeholder | Projection, Selection?]`). The encoder contributes **one `UNION` arm per request** to a single
batched `SELECT`; a shared [`Scope`](../../../../../node_modules/@metreeca/core/src/common/scope.ts) lets the decoder
recover each request's variables. See [Batching](#batching-and-demultiplexing) for the arm-and-demux mechanics.

## Foundations

### Data model

From [`@metreeca/qest`](../../../../../node_modules/@metreeca/qest/src/template.ts):

- `Query = [Union | Placeholder | Projection, Selection?]` — collection element plus constraints
- `Projection = { [Binding]: Model }` — `Binding = name=Expression`; one `Model` per binding (column)
- `Model = Union | Placeholder | Locales` — the template for a single value; **no `Query` arm**, so a cell can never
  hold a collection (an array)
- `Union = { [Branch]: Placeholder | Locales }` — opaque keys; the variant a branch retrieves is fixed by type match,
  never by key
- `Locales = { [TagRange]: "" | [""] }` — one structured `Dictionary` value
- `Expression = Pipe Path`; `Probe = { target, pipe[], path[] }`

### Ranges and variants

From [`@metreeca/blue`](../../../../../node_modules/@metreeca/blue/src/value.ts), every value coordinate resolves to a
`RangeShape`:

```text
RangeShape = { kind: "range", minCount?, maxCount?, variants: readonly ValuesShape[] }   // variants never empty
ValuesShape = ValueShape | DictionaryShape
ValueShape  = Boolean | Number | String | Reference | Resource
```

> [!IMPORTANT]
> The range is the **single universal representation** of a coordinate. A one-variant range is the **degenerate
> count** of the same iteration, not a special kind — never branch on `variants.length`. A dictionary is an ordinary
> variant (`creator.name` may resolve to `[string, dictionary]`), never filtered out.

### The union model

A union is matched under two regimes ([union.md](../../../../../node_modules/@metreeca/blue/src/union.md)):

- **write / state — `sh:xone`**: a stored value singles out **exactly one** branch, by value, against all constraints
- **read / model — `sh:or`**: a retrieval placeholder matches **at least one** branch, by kind alone; it requests every
  branch it fits, discriminating nothing on its own

Because branches are **disjoint** and the stored value belongs to exactly one of them, a read that requests several
variants still binds **at most one** per row. `getUnionPlaceholders(variants, placeholder)` returns the
`Map<variant, alternative>` shared by encoder and decoder: the encoder emits one variable per requested variant, the
decoder reads whichever variable bound and projects it through the paired alternative.

## The result set is a table

The select result is conceptually a **table**:

- a `Projection` yields `N` named columns (one per binding alias); each row is a distinct binding tuple
- a degenerate `Union | Placeholder` query yields **one anonymous column**; each row is one collection member

The degenerate form is the single-column projection: its one column holds a `Model`-shaped value per row, exactly like a
projection column. The encoder therefore emits **columns** uniformly; the degenerate case is the one-column count of the
same rule (see [Columns and cells](#columns-and-cells)).

Set-valued (multi-valued) property values **fan out** into rows — one row per resolved value — and `DISTINCT` folds the
duplicate tuples ([Distinctness](#distinctness)). Arrays never appear in a cell; they are reassembled elsewhere:
the top-level collection by the decoder over rows, multi-tag `Dictionary` and nested multi-valued properties by the
broker/lookup pass.

## Columns and cells

### A column projects one variable per variant

A column resolves to a `RangeShape` and is emitted as **one variable per range variant**. A plain `Shape`
(including a `UnionShape`) is a degenerate `RangeShape`; a single-variant range contributes one variable.

```text
variables(column) = column.range.variants.map(variant → one scalar variable)
```

Exactly **one variable binds per row**, because the underlying union is disjoint: the stored branch fixes which variable
is bound. The bound variable is therefore both the value and its variant classifier: there is **no separate value
variable**. The decoder classifies on whichever variable bound, with no term inspection.

This is the linchpin. It eliminates every `variants.length > 1 / === 1` branch: the encoder iterates
`range.variants` uniformly for union, single, dictionary, scalar, reference, and resource columns alike. Heterogeneous
variants are expected (a path crossing a union may reach `[string, dictionary]`); each variable follows its own kind's
rule.

### Each variable is a scalar term

Every variant variable carries a **scalar term** — a literal or a reference — never folded sub-structure:

- **literal** variable → the value term
- **reference / resource** variable → the **target** reference; the decoder delegates expansion to the lookup pass
  (`decode.expand` → `broker.lookup`, which re-fetches the sub-structure; the select pass never reconstructs it)
- **structural dictionary** variable → the **owner** reference (the resource holding the localised value); the decoder
  recovers the property (`branch.path` last step) and owning shape, and delegates
  `broker.lookup({ entry: owner, model: { [prop]: placeholder } })`

Reference and dictionary columns are thus the **same shape**: bind a reference term, let the decoder plus lookup expand
it. Only the reference (target vs owner) and the looked-up model (sub-template vs single localised property)
differ.

> [!NOTE]
> "No structural descent" applies to a **column's own sub-structure**: a resource/reference column binds only its
> target reference and never folds the referent's properties into extra variables. It does **not** mean the WHERE
> avoids traversal: a column whose expression is a **path** (`vendorName=vendor.name`) still descends the path to
> bind its leaf value. Descent to a projected leaf populates the cell value; sub-structure folding is what the
> lookup pass owns instead.

### Localised dictionaries: two modes

A localised (`dictionary`) column projects in one of two modes, disambiguated by the **client-provided model** for the
column (`branch.drain.mould`, tested with `isObject`):

- **structural** — the model is a `Locales` object (`{ "*": "" }`): bind the owner reference; the decoder delegates
  `broker.lookup` to assemble the full `Dictionary` tag map
- **coalesced** — the model is a plain string (`""`): the encoder language-negotiates and binds a single
  **plain-string** variable; the decoder reads the term directly

Both modes keep the variable scalar, so the per-variable rule holds without exception:

```text
variable ∈ { literal (incl. coalesced dictionary),
             reference (resource/reference target, or structural-dictionary owner) }
```

### Computed and aggregate columns

A column may be **computed** (`isComputedFlake`, `pipe.length > 0`, e.g. `year=year:releaseDate`) or **aggregate**
(`isAggregateFlake`, e.g. `avgPrice=avg:price`) and still bears `drain.alias`. Variable emission stays uniform because
every flake node carries `range` = the **effective, pipe-resolved** range of its target value (the transform's output on
a computed node).

The split lives at two levels:

1. **variable identity and count** = `range.variants` — fully uniform across raw, computed, and aggregate columns
2. **the expression that fills a variable** — mode-specific and genuinely distinct:
	- raw / scalar-computed → a projected variable bound in the WHERE (`bind(fn(input) as ?s)`)
	- aggregate → an inline `(agg as ?a)` alias in a grouped `SELECT`, or a correlated subselect when the query is
	  aggregate-without-grouping

> [!NOTE]
> The correlated-subselect path for an ungrouped aggregate (`aggregates()`) is a known rough edge worth revisiting
> during the rewrite.

### Variable allocation

A variable must be unique per **(Flake node, range variant)** pair.

`scope.resolve(key?)` caches by **single reference identity**, so neither key alone suffices:

- the **variant shape** collides across columns — `eager()` caches shapes, so a union declaration reused on two
  properties shares its variant shape objects; two columns over that union would resolve the same variable
- the **flake node** alone cannot separate its own variants

> [!IMPORTANT]
> **Decision** — extend the core [`scope.resolve`](../../../../../node_modules/@metreeca/core/src/common/scope.ts)
> to accept **composite keys** (`resolve(flake, variant)`), folding through a nested cache. Every variable is then
> allocated as `scope.resolve(column, variant)`; the degenerate column resolves `scope.resolve(column)`. This
> removes both the shape-collision and the need for a per-variant node, and unblocks the uniform rewrite.

A scalar arm of a union has no folded `Branch` (a zero-property variant is dropped from `entries` by
`queryDescentOf`); with composite keys this no longer matters, since variables key on `(column, variant)` rather than on
any per-variant node. Where a connector-side handle is still convenient, add getters under
[`_/_flake.ts`](../_/_flake.ts).

## Row schema

Every row has the following shape:

```text
row =
  [ block ]                   1 integer variable — the source request index
  [ scalar columns    ]       0+ columns; each = one variable per range variant (degenerate → 1)
  [ aggregate columns ]       0+ columns; each = one variable per range variant (degenerate → 1)
```

- **`block`** is a plain single variable (not per-variant), projected first in every arm. Its position is a convention:
  correctness is by variable identity, and the outer `ORDER BY` keys on the variable, not the column index.
- a **scalar column** is a non-aggregate projected node (plain or scalar-computed); under grouping these are the
  `GROUP BY` keys (`getFlakeGrouping`), ungrouped they are the plain projections
- an **aggregate column** is an aggregate projected node, reduced via a `SELECT` alias (grouped) or a subselect

Mode counts: a plain projection has `N` scalar columns and no aggregate columns; a grouped query has the key columns
plus `M` aggregate columns; a pure-aggregate query has no scalar columns and `M` aggregate columns; a degenerate
`Union | Placeholder` query has one anonymous scalar column (the flake root).

### Row identity

`block` plus the scalar columns' variables form the **row-identity key**, realised by different operators:

- **aggregates present** → `GROUP BY` over the scalar (key) variables. `block` is part of the grouping *identity*
  but stays implicit: each request is its own grouped subquery arm where `block` is constant, so it is not a literal
  `GROUP BY` term.
- **no aggregates** → `SELECT DISTINCT` over `block` and the column variables.

## Decoding

A projected column is the flake node whose `drain.alias` is set. `getFlakeProjection(flake)` indexes
`{ alias → node }`; a union-typed binding folds its variants into that one node's `entries`, so no alias is ever shared.
When the projection index is **empty** (a degenerate `Union | Placeholder` query), the decoder reads the single
anonymous column described by the flake root instead.

For each column the decoder **coalesces** its variant variables into one cell value under `alias`. The guiding
invariant: each stored value matches **zero or at most one** variant.

- **at most one** — union disjointness fixes a single stored branch, so only its variable binds
- **zero** — the value is absent, or the member resolved through an unrequested variant; the column is then dropped from
  the row

Coalescing is therefore an unambiguous "pick the single bound variable"; the decoder needs no term inspection and no
disambiguation. `DISTINCT` over the variant variables stays safe, since at most one is non-null per row.

Row assembly is two-mode and must stay so:

- a **projection** row is a keyed `Resource` (`{ alias: cell, … }`)
- a **degenerate** row is the bare member value (the naked collection item), not wrapped under any alias

## WHERE-side variable binding

Populating a column's variables is the job of the `element()` / `entries()` / `localised()` machinery. Per column, per
range variant `v`, the encoder emits one **membership-gated arm** that binds `v`'s variable when the stored value
resolves through `v`:

```text
optional { <descent to v> ; membership(anchor, v) ; bind(value, v-variable) }
```

At most one arm fires per row (disjointness), so the bound variable is both value and classifier. The encoder binds
exactly the variables the decoder reads, through the shared `getUnionPlaceholders`. Allocation uses the composite
`scope.resolve(column, variant)` key; the rule iterates `range.variants` including dictionaries, with no
`variants.length` branch.

> [!NOTE]
> This section covers **populating** a column's variables. **Filter constraints** (`filters` / `matchAllStored` /
> `having`), which restrict *which rows* survive, are a separate axis and out of scope for this projection
> specification.

## Ordering

`sorting(flake)` emits each request's `ORDER BY` terms from focus (`+`, `getFlakeFocusing`), ordering (`^`,
`getFlakeOrdering`), and a tiebreak (the grouping keys, or the member root). The outer query re-establishes order after
the union with `ORDER BY asc(guard), …batch.flatMap(sorting)`.

A sort/focus key is a `RangeShape` like any coordinate, and the model constrains it in two ways, both **specified by
qest and enforced by blue**:

- **projection scope** — in a **non-grouped** query a `^`/`+` key may target a path not projected (it binds a WHERE-only
  variable, consumed by `ORDER BY`, never surfacing as a cell). In a **grouped** query a non-aggregate key **must**
  reference an existing grouping key; an aggregate key ranks by its post-aggregation value. (qest §5.8.2.1; blue
  `resource.core.ts` grouped-ordering cross-check.)
- **cardinality** — the key must **resolve single-valued** (`range.maxCount === 1`, guarded by blue
  `validateOrder`). This is the composed path-plus-pipe cardinality, not the declared leaf: a scalar leaf under a
  multi-valued ancestor (`items.price`) resolves multi-valued and is rejected. An aggregate over a set property is
  valid (its output is single-valued); references and nested resources are not orderable; a coalesced localised value
  qualifies. (qest §5.7.4–5.7.5.)

The encoder therefore trusts a sort key to bind exactly one value per row. A key over a multi-variant range still holds
a single value in one of its variant variables, so it is a **non-projected instance of the same model**:
coalesce the variant variables to the one bound value, then apply `tier()` / `sortable()`, which impose the total
order (`undefined` < boolean < numeric < temporal < string, sign-reversible; qest §5.7.5).

## Slicing

`slicing(flake)` emits `OFFSET` / `LIMIT` **inside each request's arm**, after that arm's `ORDER BY`, so each request
gets its own paginated window before the union merge. `LIMIT` applies after the arm order-by, giving the correct top-`N`
by the request's sort. The outer `ORDER BY asc(guard), …` re-establishes order after the union; because `guard` is
primary, each request's already-sliced rows stay contiguous, and another request's (unbound)
sort variables cannot disturb them. Slicing bounds **rows**, never columns.

## Markers: id and type

`id` and `type` are `Branch` nodes whose `range` resolves to the IRI range (`variants = [reference]`), so they fit the
reference-column rule as one-variant columns. Only their WHERE binding is special:

- projected `id` → `bind(anchor, var)`, the resource reference itself
- projected `type` → `bind(reference(clazz), var)`, the value **hardwired from the shape's class**, never read from the
  store (which holds the whole denormalised `rdf:type` ancestry, not the one specific class)

Both are **filterable** (`id` by reference equality; `?type` matches the stored `rdf:type` lineage, so a supertype
filter spans its subtypes). References carry no defined order (§5.7.5), so a marker is not a meaningful sort key. Note
that blue rejects only *comparison bounds* (`<`/`>`/`<=`/`>=`) over a reference, **not** a `^`/`+` sort or focus, which
is accepted and yields an unspecified order. The decoder reads markers as plain reference terms.

## Distinctness

`SELECT DISTINCT` over `block` and the column variables scopes `DISTINCT` to the **projection only**. By SPARQL algebra
this excludes every intermediate WHERE variable — path steps, membership shards, the member root, and non-projected sort
keys are never projected — so `DISTINCT` folds fan-out duplicates and equal tuples from different items.

Non-projected sort keys compose soundly because the algebra order is
`Slice(Distinct(Project(OrderBy(…))))` — **`OrderBy` runs before `Project` before `Distinct`**:

- `ORDER BY` sees the full solution (including the non-projected sort key and member root); `Project` drops them;
  `Distinct` keeps the **first** occurrence of each distinct projected tuple in the ordered sequence
- a collapsed duplicate therefore ranks at its best-sorted occurrence, which is well-defined, not an error
- the `asc(root)` tiebreak (member identity, non-projected) makes the collapse **deterministic** (stable paging);
  projecting `id` keeps otherwise-equal items separate, since `DISTINCT` then sees `id`

## Batching and demultiplexing

`encode` folds `N` requests into one `SELECT`. Each request contributes a `UNION` arm carrying a **`block`
variable** = its batch index (`guard = scope.resolve(batch)`; `block = as(number(index), variable(guard))`). A
single-request batch emits the bare arm; a multi-request batch wraps the union in
`SELECT * WHERE { …union… } ORDER BY asc(guard), …sorts`.

The decoder demultiplexes on the same `guard` variable: it settles each request from the rows whose `guard` term equals
its index, in the order the outer `ORDER BY` fixed. The block variable, the arm-local `ORDER BY` / `LIMIT`, and the
outer re-order together keep every request's window contiguous and correctly ordered.
