---
title: SPARQL Connector — Pass Contract
summary: The layered contract every pass of the SPARQL connector is built on, and the table each reading pass shares between its encoder and decoder
description: The five layers of the connector, what each pass owns, the spine every pass runs through, the schema encoder and decoder share, and the clause structure of each pass.
---

# Layers

The connector is five layers, each a module or folder depending only on the layer below:

| Layer        | Where                                       | Owns                                                                                                   |
|--------------|---------------------------------------------|--------------------------------------------------------------------------------------------------------|
| **spine**    | [`spine.ts`](./spine.ts)                    | one query or update per batch, the owner index, per-request settlement, nested requests, failure isolation |
| **passes**   | `detect/`, `detail/`, `select/`, `modify/`  | a driver (`index.ts`), a schema where the pass reads a table, an encoder and, where there is something to decode, a decoder |
| **schema**   | `detail/schema.ts`, `select/schema.ts`      | the columns a pass binds for each cell or property it returns, and the variable each column takes      |
| **patterns** | [`patterns.ts`](./patterns.ts)              | the shape-aware SPARQL emitters: edges, variant gates, localised text, transform pipes                 |
| **terms**    | [`terms.ts`](./terms.ts)                    | the value and term codecs, with no SPARQL in them                                                       |

Plan grouping and batch sizing sit below the connector, in `@metreeca/keep/batching`: a handler call is one plan,
capped at the limit the connector declares. A connector for another query language keeps the spine, the terms and the
drivers, and rewrites the patterns and the clause assembly in the passes, the only layers that know the language.

## Spine

Every pass runs through [`spine.ts`](./spine.ts): a reading pass hands it the query reading the whole batch, the
column binding the entry a solution row belongs to, and a decoder of one request; a writing pass hands it the update
and a decoder. The spine runs the single round trip, indexes the rows by the owner column once, decodes each request
from its own rows and settles it on its own, rejecting the requests of a failing operation instead of throwing out of
the handler, so a failure never poisons the batching run and every other request of the round settles as usual.

Decoders are pure: they turn rows into a **decoded value**, the nested detail and select requests the value depends
on and the function completing it from their responses, composed bottom up with the combinators `spine.ts` exports
(`plain`, `resource`, `collection`, `all`, `map`). The spine runs the nested requests through the broker and
completes the value, so a decoder is tested from literal rows and literal responses, with no broker. A decoder owns
what it omits: a collection with no content never surfaces as an empty slot and a row expanding to nothing is left
out, because the completing function says so. The handler returns once every request is decoded, without waiting for
the nested requests, which run in a later batching round alongside everything else queued in the meantime.

## Schema

Each reading pass derives, once per batch, the table it returns: for every cell (select) or single-valued property
(detail) the plan returns, the columns binding it. A column names its plan node, the range variant it binds, the
placeholder requested for that variant and the **form** the decoder reads it in, and one resolver maps it to its
variable, keyed on the node, and on the variant for a union-typed node. The driver hands the schema to both sides, so
the encoder binds exactly the columns the decoder reads and neither classifies the plan on its own.

The schema is the pass's own IR: it carries plan nodes and variants as keys, never variables, which the shared `Scope`
still allocates. Alignment between the phases is by column list, which is stronger than walk-order alignment.

## Localised text

A localised label is coalesced where it is consumed (§6.2). The select pass filters, sorts and projects on the label,
so [`patterns.ts`](./patterns.ts) settles it in SPARQL under the request's language priority; the detail pass only
returns it, and under a locale placeholder returns every tag, so it reads the raw tagged values and coalesces them in
the decoder through the tag-priority reader of [`terms.ts`](./terms.ts). Both halves apply the same priority.

# Detect

One `select distinct` over a `values` block binding every entry of the batch: an entry is present if the query returns
it as the subject of some triple. The driver decodes each request from its own row count, with no decoder module.

# Detail

One `select` whose `where` is a `union` of arms, each opening with the `values` block binding the batch's entries to
the subject variable, keyed on the plan root. A `union` sums solutions rather than joining them, so each fan-out
source takes an arm of its own and the row count is a sum of per-property cardinalities:

- a **scalar** arm reads the whole plain single-valued subtree, every edge `optional`;
- a **localised** arm per `dictionary` leaf reads its tagged values, one per row;
- a **variant** arm per requested union variant reads the variant's subtree, gated by its membership.

The schema maps every single-valued property branch to its columns, one per requested variant for a union-typed
property, in the `tagged` or `value` form. Multi-valued properties bind no column: the decoder reads each off the collection
the select request for it materialises, and a collection resolving to no content leaves the property out (§4). A plan
binding no column runs no query, and its requests still decode: `id` and `type` come from the entry and the shape.

# Select

Contract between [`select/encode.ts`](./select/encode.ts), which folds a batch of collection queries into one SPARQL
`select`, and [`select/decode.ts`](./select/decode.ts), which decodes each request from its own rows. The batching
layer hands the driver the requests sharing a field, a structurally equal query and the same locale, and the driver
pairs them in a `Group` record carrying the one [`Flake`](../../../components/keep-flake/src/index.ts) its
`createQueryFlake(shape, query)` produces and the schema derived from it. Both sides read only that tree and that
schema, never the raw `Query` or `Shape`, and share nothing but the group record and a `Scope`.

## Terminology

The result set is a table:

- **cell** — the value a row carries for one binding of a projection (§5.2), or the member itself for a plain
	collection. A cell is a flake node: a projected branch or transform stage, or the flake root
- **column** — a `select` variable carrying a cell. A cell retrieved as a union projects one column per requested
	variant, so the decoder reads the variant off the column that bound; any other cell projects one column
- **row** — one member of a request's collection, or one combination of its bindings' values; a multi-valued path fans
  out into one row per resolved value (§5.2) and `distinct` folds the duplicates

## Variable protocol

Every variable comes from the `Scope` the driver shares between encoder and decoder, keyed on the identity of a group
record or a flake node, so the decoder recovers a slot by resolving the same key:

| Key               | Variable                                                                                                                                                        |
|-------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `group`           | the **owner**: the entry of the request a row belongs to, bound by the `values` block and projected first                                                       |
| `node`            | the **value** of a node: the member for the root, the stored object of a branch's edge, the computed value of a scalar stage, the aggregate of a reducing stage |
| `(node, variant)` | the **shard** of a cell retrieved as a union (§5.5): bound, from the value, only when the stored value belongs to `variant`                                     |

Keying on identity rather than on a path keeps the same property at distinct coordinates on distinct variables. The
requests of a group share every node variable and are told apart by the owner alone, so encoder and decoder must
receive the very same group record: a copy or a fresh equivalent would resolve the owner to another variable.

### Cells and columns

The columns of every cell are derived once per batch by [`select/schema.ts`](./select/schema.ts): each column names
its cell, the range variant it binds, the placeholder requested for that variant and the form the decoder reads it in
(`computed`, `owner`, `label` or `value`). A cell projects its shards when its drain takes the `union` form and it is
not a transform stage; otherwise its value. A transform stage computes a literal and never needs a variant to decode.

The value of a node is fixed by what the node is:

- a **marker** (`id`) is its owner, bound from the owner's variable; a projected `type` is the class the owner's shape
  declares, read from the stored lineage filtered to that class; a `type` under set matching (`?`, `!`, `+`) is the
  stored lineage, so a supertype option spans its subtypes (§5.7.3) and a filter on a class reaches every instance
- a **localised** property (every variant a dictionary) is its **coalesced label** (§6.2) as a plain `xsd:string`,
	unless retrieved through a locale placeholder, when it is its **owner**, or constrained by tagged options, when it is
  the raw tagged literal, so an option tagged with a language is matched against the text stored under that tag
- a property **mixing** text with other variants (a path crossing a union whose variants declare it as text and as a
	plain value, §5.8.1) is its stored value **folded** (§3.2): a tagged value passes under the winning priority tag
	alone, as a plain string, any other value as it is; an `und` text is language-tagged like any other, so it passes
	only where `und` wins the priority and is never mistaken for a plain string value
- any other **property** is the object of its stored edge
- a **scalar stage** is its pipe applied to the value of the branch the pipe hangs off; a **reducing stage** (a pipe
	carrying an aggregate, scalar wrappers included) exists only after grouping, so it is projected rather than bound

Every column is a scalar term, never folded sub-structure: a resource or reference cell carries the reference, which the
decoder reads off the resource the detail pass materialises under the template the request stated; a localised cell
retrieved structurally carries the owner, read off the detail pass restricted to that property. The sub-structure of a
retrieved resource is therefore never read by the select pass, whose rows stay flat whatever the template asks for.

## What the query reads

The encoder descends a branch or stage only where the query **reads** it: it constrains, orders or focuses it, or, under
a projection, projects it, or some stage or branch beneath it. The entries of a plain template name content the detail
pass re-fetches per member and are left out of the `where`, so a template never widens the query that lists members.

## Query structure

A group encodes as one query, assembled clause by clause under three switches settled once per group: the **form**
(`grouped` when a projection binding aggregates, QEST §5.8.2.1; `ungrouped` otherwise, rendered `itemised` when a
criterion aggregates, SPARQL having no per-item reduction), the **arms** (one `values` block over every owner, or one
subselect arm per owner for a windowed plan over several owners) and the **whole**-collection aggregation (§5.2).
Every clause is a recursive descent over the nodes the query reads, assembled in the order the sketch below states:

```text
select [distinct] ?owner <columns…> [(aggregate as ?stage)…]
where {
  values (?owner) { (<entry>) … }   the entries of the group's requests
  ?owner <field> ?root .            the member edge, optional for whole-collection aggregates
  <patterns>                        stages, shards and branches under the root
  <admitted>                        filter(bound(shard) || …) for a union root retrieving a proper subset of variants
  <filters>                         the row constraints, at group level
}
[group by ?owner <key columns>]
[having (<group conditions>)]
order by asc(?owner) <focus…> <sort keys…> <tiebreak…>
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
  optional, and a member lacking the constrained value is excluded instead of surviving with the value left unbound
- **comparison regime** (§5.7.1) — a bound runs in the variant it singles out: a boolean by its false < true rank, a
	string-kind variant lexically (`str`), which also orders the ISO temporal forms a backend leaves opaque, anything else
  by its typed term; a guard on the variant's kind excludes the other variants of a union
- **grouping** — an aggregate anywhere in the query groups it (§5.8.2.1): by the owner and the non-aggregate
  bindings where the projection itself aggregates; else by the owner and the member, with the bindings and the
  non-aggregate sort and focus keys, so a selection aggregate reduces per item, and the query then wraps that grouped
  subselect in a `select distinct` over the owner and the cells, so the rows collapse as any projection's
  do (§5.2) once the items are filtered. Every read reducing stage is projected as `(pipe(origin) as ?stage)`, its
  conditions move to `having`, and `min`/`max`/`sum`/`avg` over references project nothing (Appendix A.4.1)
- **whole-collection aggregates** — a projection aggregating without non-aggregate bindings has a value on an empty
  collection too (§5.2). Grouping by owner would drop an owner whose members are all filtered out, so the member edge
  and everything under it become `optional` under the `values` block. Each aggregate argument then reads
  `if(bound(?root), <value>, <neutral>)`: the neutral is `0` under `sum`, and an error (a variable nothing binds) under
  any other aggregate, which drops it or comes out unbound. An owner with members thus aggregates exactly as a keyless
  aggregation over its own members would, and an owner without members still gets one row of empty aggregates
- **ordering** — the owner first, then focus boosts, then sort keys by precedence, each ranked by processing-type
  tier (boolean < numeric < temporal < string) before its value (§5.7.5), then the group keys or the member as a
  stable tiebreak, so the rows of every owner come back in the same order whatever else shares the query
- **slicing** — after the ordering. A `limit` spans every owner bound in a query, so a sliced query over several
  owners runs one arm per owner, each a subselect binding that owner alone and windowing its own members, under
  `select * where { arm union arm … } order by asc(?owner) <ordering>`; the arms also project the keys the outer
  ordering reads (focus and sort keys, and the member as the ungrouped tiebreak), which an unprojected key would
  leave unbound, except the member of a projection, whose rows it would keep apart

## Decoding

A request's rows are the tuples carrying its own entry on the owner column, indexed once per query, in the order and
within the window the query states, both applied by the server. A projection yields one record per row, each binding
read from its cell and omitted when it resolves to no value; a plain collection yields one member per row from the
root cell, rows resolving to no value dropped, so an owner matching nothing settles with an empty collection rather
than a missing one, and the detail pass reading it decides whether that empty collection surfaces on the resource.

A cell is read off the first of its schema columns that bound, by the column's form:

- a **computed** column coerces its literal by datatype alone
- an **owner** column reads the owner's property off the detail pass, expanded tag by tag under the first resource of
	the parent range declaring the property as localised, so every tag the owner carries comes back (§5.4)
- a **label** column reads the coalesced label as a string (§6.2)
- a **value** column coerces its literal under the column's variant, or, for a resource or reference, reads the resource
	off the detail pass where the request asks for its content (a template, or drained branches) and keeps the bare
	reference naming it where the request asks for the reference alone, with no content under it

A row binding none of a cell's columns is a member of an unrequested variant and yields nothing. A blank node bound
where a resource is expected fails the request with a `RangeError`: the store reads embedded resources only when the
repository names them by skolem IRIs, never when it names them by blank nodes, so a graph loaded by other means must
be skolemised before the store reads it, or every embedded resource and the content under it would go silently missing.

# Modify

One SPARQL 1.1 update per batch, one operation per request in submission order: a `link` inserts the membership edge
alone; a `state` clears the entry's owned triples and inserts the state; no `state` deletes the entry together with
its embedded and captive descendants, whose own triples go with it, while every other resource it links stays.

Clearing and deleting walk the plan once each into the **steps** reaching the edges they act on: the stored type of
each resource variant declaring one, and the forward and reverse edges of each admitted property, each step carrying
the edges leading to its subject, keyed on branch identity. A clearing update reads its `delete` template and its
`where` arms off the same steps, one arm per owned edge, so they cannot drift apart and matched rows add up across
edges instead of multiplying. A deletion reads its cascade arms off the steps of the cascading properties, each binding
the cascaded resource to the wildcard subject whose incident triples the update retracts. Both kinds of arm match an
edge in whichever direction it is stored, so a two-way property carrying one direction only is cleared and cascaded
all the same, while the delete template retracts both directions of what matched.
