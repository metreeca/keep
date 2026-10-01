---
title: Shape-Bound Retrieval
summary: How a retrieval states what it wants and where the type of the data it returns comes from.
description: Records why retrieval is composed against the shape it targets rather than typed from a model literal.
---

# Open Points

- **Nothing holds a model to the shape**: `lookup` and `select` take `T extends Template`, so `Delivery` is handed any
  structurally valid template and keeps only the members the shape happens to carry. A member the shape does not
  declare is dropped from the result rather than refused, which is the missing `Model<S>` seen from the call site.
  Everything below is written against whichever `Model<S>` ends up meaning, so it is settled first, a generated model
  telling members from criteria and bindings by construction rather than by spelling.
- **A localised member is typed wrong, not merely widely**: an atomic leaf yields the coalesced label and a tag-keyed
  map the whole map (§6.2), and `Delivery` tells neither apart, a dictionary range reaching no resource and so falling
  through to the map both ways. The coalesced request therefore reads back as a map where the value is a string, which
  is what `keep-suite/src/retrieve/localised.ts`'s `coalesced` cast covers. The only entry where the type is false
  rather than wide, and the only one a caller cannot work around by narrowing.
- **Criteria keys drop two different ways**: `Wanted<M>` matches `` `${Operator}${string}` `` textually, while
  `Keys<M>` goes through `keyof Criteria`. They disagree on any criteria key not spelled as an operator prefix, and
  only one rule can be right. The rule belongs to `Model<S>`, so the two settle together.
- **Which inference blue publishes is unsettled**: the cursor resolves through member-level machinery blue keeps
  internal (`Carried`, `Arity`, `Skippable`), imported from `@metreeca/blue/resource` on the assumption that it is
  published there. How much of it goes public decides whether a consumer can state an intermediate type or only the
  endpoints.
- **A projection column is named but not typed**: `Delivery` carries each binding under its alias with an `unknown`
  value. Typing it by the transform's signature is reviewed with the column form itself.
- **A union-ranged member falls back to the shape**: `Delivery` hands back what every branch may carry rather than the
  branch the model asked for, and a path cannot reach through a union at all. Resolving a member table per branch
  exceeds the instantiation ceiling on shapes of this depth, so this is a declared gap rather than pending work.

# Where It Stands

Shape inference lives in `@metreeca/blue`. [`dsl.ts`](./dsl.ts) sketches the cursor on top of it, adding only the
traversal through links and union branches (`Target`) that blue has no use for.

# Composition Against the Shape

The cursor is materialised from the shape once and memoised. Every member is a field carrying the type the shape
resolves for it, and a member ranging on a resource is also a node, navigable through its own members and expandable
through a nested retrieval. `as` states a resource model, `by` a row model, branded on unique symbols so the brands stay
out of the alias space and a computed slot in a resource model resolves to `never` where it is written.

```ts
await store.select(from(Product, product => as({

	id: product.id,
	name: product.name.at("en", "fi"),

	vendor: product.vendor.select(vendor => ({

		id: vendor.id,
		label: vendor.label

	}))

}, where(
	gte(product.launched, "2026-01-01"),
	limit(100)
))));
```

What the cursor buys, against typing a model literal:

- an expression is typed by application rather than parsed, so `count(product.categories)` takes its type from
  `count`'s signature, and `sum` over text fails as an argument type error where it is written
- a member the shape does not declare is not on the cursor, so the error lands on the token the caller wrote rather than
  surfacing as `never` downstream
- `Field<V>` pairs the wire expression with the type it carries, so an option is constrained by the field it targets and
  a localised field can demand tagged values where a plain one refuses them
- `Carried<S>` is instantiated per cursor combination rather than per nesting level

What it costs: it authors the model without replacing it, so the wire document, the grammar and the runtime validator
stand, a client model still has to be checked, and the surface has to track the grammar or leave features unreachable. A
document decoded through `compile` is accepted in place of a callback and yields `Decoded<S>`, typed loosely by design:
a plain field carries what the shape resolves for it, a binding stays `unknown`.

# The Types a Shape Resolves

| Type             | Answers                               | Paired with                   |
|------------------|---------------------------------------|-------------------------------|
| `Instance<S>`    | what the shape yields                 | the state a writer submits    |
| `Model<S>`       | what the shape admits being asked for | the request a reader states   |
| `Delivery<S, M>` | what a given model hands back         | neither; it resolves the pair |

`Model<S>` does not yet meet that definition: the sketch states it as the two forms a model is **written** in, a cursor
traversal or a compiled document, rather than as the templates the shape **admits**. Stating it structurally holds a
compiled document to the shape at the call site, and recurses through member ranges exactly as inference over a literal
did, re-instantiating `Carried<S>` per nesting level: the cost the composed route was adopted to avoid. Only one of the
two can be had, and the choice is taken once, since `Delivery<S, M>` is written against whichever `Model<S>` means.

# What It Retires

- the conformance suite's local column readers and their casts (`rows`, `num` in `keep-suite/src/retrieve/index.ts`),
  since a column takes its type from the transform's signature
- the `coalesced` cast in `keep-suite/src/retrieve/localised.ts`, once a localised member is resolved from the model
  rather than the range alone: a coalesced request states an atomic leaf and a structural one a tag-keyed map, and
  `Delivery` reads neither today, a dictionary range reaching no resource and so falling through to the whole tag map
