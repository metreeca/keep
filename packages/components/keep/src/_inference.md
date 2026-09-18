---
title: Retrieval Inference — Assessment
summary: What the composed-model route buys Blue's type inference, and the points that need settling before it lands
description: Assessment of the Model/Delivery inference sketched for Keep and proposed for integration into the Blue value inference.
---

# Scope

Assesses the retrieval inference sketched in the EC2U Pipe workspace (`src/_/keep/dsl.ts`, argued in the `work.md`
beside it), proposed for integration into Blue's value inference alongside `Instance`. The context the proposal
answers to is the retrieval model rework the package carries here: a model whose leaves no longer carry types, leaving
[`_inference.ts`](_inference.ts) to read a result off the model's key structure alone.

The verdict is that the route is right and the mechanism sound. What follows records why, the two limits that survive
the overhaul whatever is landed, and the points that want settling before the types land in `value/index.ts`.

# Blockers

Two constraints outlive both the qest alignment and this overhaul. Neither is work waiting to be scheduled: one is a
limit of the type system, the other a choice between two costs that cannot both be avoided.

## A Path Cannot Reach Through a Union

The cursor offers no member to carry on with where a property ranges on a union, so `event.location.name` is refused
even where every branch declares `name`. Offering the members the branches share means resolving a member table per
branch, which exceeds the instantiation ceiling on shapes of production depth; even within it, a member only one
branch declares stays unreachable and a branch that is itself a union is not unfolded again.

The consequence is an expressiveness gap, not a defect: a union-ranged path is a model a client may legitimately write
and the typed surface cannot state. It binds wherever the domain puts unions on traversed paths, as the EC2U shapes
do, and the fallback is a compiled document, typed loosely, for the retrievals that need one.

## Holding a Compiled Document to the Shape Costs What the Cursor Saved

`Model<S>` can be stated as the two forms a model is *written* in, a cursor traversal or a compiled document, or
structurally, as a template narrowed to the members the shape carries. The first leaves a compiled document unchecked
at the call site and makes `Delivery<S, M>` tell the arms apart. The second closes both, and recurses through member
ranges exactly as inference over a literal did, re-instantiating `Carried<S>` at every nesting level: the cost the
composed route was adopted to avoid.

Only one of the two can be had. The choice is a standing trade rather than an open task, and it is taken once, since
`Delivery<S, M>` is written against whichever `Model<S>` means.

# What the Route Buys

The duality is the right factoring, and it belongs in Blue: `Instance<S>` states what a shape yields, `Model<S>` what
it admits being asked for, `Delivery<S, M>` resolves the pair, so a result is never wider than what was asked for nor
than what the shape declares. All three are answers a shape gives, which is where the shapes are.

**Expressions are typed by application, not by parsing.** The decisive move is that a transform is a function and an
alias an object key, so `count(event.id)` takes its type from `count`'s signature. There is no template-literal parse
of `total=sum:items.price`, no type-level twin of the transform table, and no empty path left with nothing to anchor
on. A domain violation lands on the argument the caller wrote, where inference over a literal could only ever produce
`never` in an output position.

**`Field<V>` restores a tie the notation had severed.** Pairing the wire expression with the type it carries lets an
option be constrained by the field it targets, so a localised field can demand tagged values and a plain one refuse
them, which a bare string key cannot express.

**The resource and row regimes are held apart cheaply.** `as` and `by` brand their models on unique symbols, so the
brands stay out of the alias space, and a computed slot in a resource model resolves to `never` where it is written
rather than downstream.

# What Keep Waits On

Keep's port to the reworked model leaves a residue this route absorbs almost entirely.

- **Two provisional stand-ins go.** [`_inference.ts`](_inference.ts) carries `Mould`, `Items` and a local `Instance`;
  `keep-suite/src/_model.ts` carries the shape-to-template derivation blue's `model()` used to provide. Both wait on
  `Model<S>` and `Delivery<S, M>`, and on whichever shape-level helpers land as public surface (see
  [The Shape-Level Inference Wants Exporting](#the-shape-level-inference-wants-exporting)); the derivation is the
  cursor's job under this route.
- **A collection's members stop typing weaker than a looked-up resource.** Keep's `Response` resolves a `Lookup`
  through `Delivery<S, T>` but a `Select` through the local `Items<T>`, which reads the result off the template's key
  structure alone; with every leaf `{}` that yields `{}` per cell. Giving `Select` the shape and model pair closes it.
- **A projection column stops needing type-level expression resolution.** Typing by application is what closes it: a
  column takes its type from the transform's signature, so the conformance suite's local readers (`rows`, `num` in
  `keep-suite/src/retrieve/index.ts`) and their casts retire with the gap.
- **The two localised access forms become distinguishable again.** A coalesced request and a structural one differ in
  the model (an atomic leaf against a tag-keyed map) though the previous notation stated neither, so `Delivery` can
  tell the delivered arity apart and `keep-suite/src/retrieve/localised.ts`'s `coalesced` cast goes — subject to
  [A Locale Map Has No Whole-Map Notation](#a-locale-map-has-no-whole-map-notation) on the authoring side.
- **A polymorphic member does not close.** A branch map is not resolved alternative by alternative, which is
  [A Path Cannot Reach Through a Union](#a-path-cannot-reach-through-a-union) seen from the result side: what a
  union-ranged member delivers falls back to what the shape describes. Keep carries this as a declared gap, not as
  pending work.

# Points to Settle

## A Locale Map Has No Whole-Map Notation

`field.at("en", "fi")` narrows a localised field to tag ranges, and retrieving the map whole has no counterpart on the
cursor, though the model admits it. The authoring surface has to track the grammar here or declare the gap, as it does
for [union-ranged paths](#a-path-cannot-reach-through-a-union).

## `Compiled<S>` Carries Its Shape as a Phantom Slot

`Compiled<S>` is stated as `Slots & { readonly shape?: S }`, a marker backed by no data, and `Delivery` discriminates
on a structural difference nothing guarantees. `compile` holds the shape at run time, so the parameter can be backed by
an actual property instead.

## The Shape-Level Inference Wants Exporting

The sketch imports `Instance` alone and re-declares `Carried`, `Settled`, `Merged`, `Outline`, `Arity`, `Skippable`,
`Loose` and the range helpers locally against `@metreeca/blue/*`. Whatever the composed route ends up needing is
Blue's to state once: settle which of the resource inference types are public surface, rather than leaving a copy to
drift downstream.

## The Cost Claim Is Optimistic

`Cursor<S, L, U, D>` varies with the arity already walked and with the binding flag, so it is instantiated once per
combination rather than once per shape. The count stays bounded and the claim survives in substance, but the cost
argument should rest on the real figure.

# Minor

`Decoded<S>` intersects `Partial<Instance<S>>` with an open index signature, so a misspelled alias still type-checks
and reads back as a bare value. That is defensible for a document typed only at run time, provided it is stated as
what it is rather than as a narrowing.
