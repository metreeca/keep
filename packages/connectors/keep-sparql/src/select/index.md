---
title: Select Pass — Encoder/Decoder Contract
summary: How the SPARQL select pass encodes batched collection queries as one table and decodes it back
description: The row schema, the variable protocol and the clause structure the select encoder and decoder share.
---

# Select Pass

Contract between [`encode.ts`](./encode.ts), which folds a batch of collection queries into one SPARQL `select`, and
[`decode.ts`](./decode.ts), which settles each request from the returned tuples. Both read only the
[`Flake`](../../../../components/keep-flake/src/index.ts) each request's `createQueryFlake(shape, query)` produces,
never the raw `Query` or `Shape`, and share nothing but that tree and a `Scope`.

## Terminology

The result set is a table:

- **cell** — the value a row carries for one binding of a projection (§5.2), or the member itself for a plain
	collection. A cell is a flake node: a projected branch or transform stage, or the flake root
- **column** — a `select` variable carrying a cell. A cell retrieved as a union projects one column per requested
	variant; any other cell projects one column
- **row** — one member of a request's collection, or one combination of its bindings' values; a multi-valued path fans
  out into one row per resolved value (§5.2) and `distinct` folds the duplicates

## Variable protocol

Every variable comes from the `Scope` the driver shares between encoder and decoder, keyed on flake node identity, so
the decoder recovers a slot by resolving the same key:

| Key               | Variable                                                                                                                                                        |
|-------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `batch`           | the **stamp**: the index of the request a row belongs to, projected first in every arm                                                                          |
| `node`            | the **value** of a node: the member for the root, the stored object of a branch's edge, the computed value of a scalar stage, the aggregate of a reducing stage |
| `(node, variant)` | the **shard** of a cell retrieved as a union (§5.5): bound, from the value, only when the stored value belongs to `variant`                                     |

Keying on identity rather than on a path keeps the same property at distinct coordinates, and the same union retrieved
by several batched requests, on distinct variables.

### Cells and columns

A cell projects its shards when its drain takes the `union` form and it is not a transform stage; otherwise its value. A
transform stage computes a literal and never needs a variant to decode.

The value of a node is fixed by what the node is:

- a **marker** (`id`) is its owner, bound from the owner's variable; a projected `type` is the class the owner's shape
  declares, read from the stored lineage filtered to that class; a `type` under set matching (`?`, `!`, `+`)
	is the stored lineage, so a supertype option spans its subtypes (§5.7.3)
- a **localised** property (every variant a dictionary) is its **coalesced label** (§6.2) as a plain `xsd:string`,
	unless retrieved through a locale placeholder, when it is its **owner**, or constrained by tagged options, when it is
  the raw tagged literal
- a property **mixing** text with other variants (a path crossing a union whose variants declare it as text and as a
	plain value, §5.8.1) is its stored value **folded** (§3.2): a tagged value passes under the winning priority tag
	alone, as a plain string, any other value as it is; an `und` text, stored as a plain literal, is indistinguishable
	from a plain string value and passes whatever the priority
- any other **property** is the object of its stored edge
- a **scalar stage** is its pipe applied to the value of the branch the pipe hangs off; a **reducing stage** (a pipe
	carrying an aggregate, scalar wrappers included) exists only after grouping

Every column is a scalar term, never folded sub-structure: a resource or reference cell carries the reference, which the
decoder hands to the detail pass together with the cell's template; a localised cell retrieved structurally carries the
owner, which the decoder hands to the detail pass restricted to that property. The sub-structure of a retrieved resource
is therefore never read by the select pass.

## What the query reads

The encoder descends a branch or stage only where the query **reads** it: it constrains, orders or focuses it, or, under
a projection, projects it, or some stage or branch beneath it. The entries of a plain template name content the detail
pass re-fetches per member and are left out of the `where`.

## Arm structure

Each request contributes one arm, every clause a recursive descent over the nodes the query reads:

```text
select [distinct] (index as ?stamp) <columns…> [(aggregate as ?stage)…]
where {
  <entry> <field> ?root .           the member edge
  <patterns>                        stages, shards and branches under the root
  <admitted>                        filter(bound(shard) || …) for a union root retrieving a proper subset of variants
  <filters>                         the row constraints, at group level
}
[group by <key columns>]
[having (<group conditions>)]
order by <focus…> <sort keys…> <tiebreak…>
[offset n] [limit n]
```

- **patterns** — under a node: `bind` one scalar stage per read transform; then one **step** per read branch, its own
  patterns nested inside its edge, `optional` unless an existence-implying constraint requires the path
	(`isRequiredFlake`, relaxed by a `null` option), followed by one optional **shard arm** per requested variant of a
	union-retrieved cell. Each arm restates the edge on its stored object so the shard binds inside its own group, gated
  by the variant's `membership` (a class triple or a literal-kind filter; a localised variant coalesces into the shard,
  or binds the owner under a locale placeholder). The arms stand beside the edge, not inside it, so a folded or
  coalesced edge admitting no value under the request priority leaves the shards to bind on their own
- **filters** — a node's comparison, text-search and `?` conditions on its value, and its `!` conditions, each an
	`exists` re-walking the node's path from the member with fresh variables so a multi-valued path is tested across its
  whole value set (a `null` option becomes `not exists`); then those of the read stages and branches. Filters sit at the
  group level, never inside the optional binding the value, so an unbound value fails the condition rather than the
  optional
- **comparison regime** (§5.7.1) — a bound runs in the variant it singles out: a boolean by its false < true rank, a
	string-kind variant lexically (`str`), which also orders the ISO temporal forms a backend leaves opaque, anything else
  by its typed term; a guard on the variant's kind excludes the other variants of a union
- **grouping** — an aggregate anywhere in the query groups it (§5.8.2.1): by the non-aggregate bindings where the
	projection itself aggregates; else by the member, with the bindings and the non-aggregate sort and focus keys, so a
  selection aggregate reduces per item, and the arm then wraps that grouped subselect in a `select distinct` over the
  stamp and the cells, so the rows collapse as any projection's do (§5.2) once the items are filtered. Every read
  reducing stage is projected as `(pipe(origin) as ?stage)` and its conditions move to `having`;
	`min`/`max`/`sum`/`avg` over references project nothing, leaving their cells unbound (Appendix A.4.1)
- **ordering** — focus boosts, then sort keys by precedence, each ranked by processing-type tier (boolean < numeric
	< temporal < string) before its value (§5.7.5), then the group keys or the member as a stable tiebreak
- **slicing** — inside the arm, after its ordering, so each request pages its own window

## Decoding

A request's rows are the tuples carrying its stamp. A projection yields one record per row, each binding read from its
cell and omitted when it resolves to no value; a plain collection yields one member per row from the root cell, rows
resolving to no value dropped.

A cell is read by its columns:

- a **transform stage** coerces its computed literal
- a cell retrieved as a **union** reads the first requested variant whose shard bound, shaping the term under that
	variant and its own placeholder; a row binding no shard is a member of an unrequested variant and yields nothing
- any other cell reads its value under its range's single variant

Under its variant, a term decodes as: the coalesced label or raw text of a **localised** variant, or, under a locale
placeholder, the owner's property expanded tag by tag by the detail pass under the first resource of the parent range
declaring the property as localised; a **resource** or **reference** expanded by the detail pass where the request asks
for its content (a template, or drained branches), else the reference naming it; a **literal** coerced through
`termToValue`.

## Batching

`encode` folds `N` requests into one `select`: a single request runs as its bare arm; several are wrapped as
`select * where { arm union arm … } order by asc(?stamp), <each arm's ordering>`, the stamp first so each request's
already-sliced rows stay contiguous and in order. The decoder demultiplexes on the same stamp.
