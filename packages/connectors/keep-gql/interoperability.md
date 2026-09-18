For when a Cypher emitter / dialect flag is added. Spec now targets ISO GQL:2024; Neo4j Cypher is the live
implementation (GQL-converging, Cypher 25), openCypher-9 its frozen subset. GQL → Cypher equivalents for
the cells we converted:

- Grouping (A.4.6): GQL `FILTER` / `GROUP BY` / `FILTER` ↔ Cypher `WHERE` (pre-`WITH`) / aggregating `WITH`
  (implicit grouping) / `WHERE` (post-`WITH`).
- Type guard (A.4.1 / A.4.5): GQL `IS TYPED` ↔ Cypher `valueType()` / `IS ::`.
- Null ordering (A.2.3): GQL null sorts lowest natively ↔ Cypher null sorts LAST → needs
  `ORDER BY x IS NOT NULL` first to get `undefined`-first.
- Case fold (A.2.5): GQL `lower()` ↔ Cypher `toLower()`.
- Word-prefix search (A.2.5): GQL `starts_with` / `contains` ↔ Cypher `STARTS WITH` / `CONTAINS` (same
  shape, no regex). Cypher additionally has `=~` regex if richer matching is ever wanted.



---



⏺ Designing a storage backend that targets both GQL and Cypher across all CRUD
  operations is feasible, but the challenge varies by operation type:

  Reads (R) — High interoperability

  Pattern matching is nearly identical. A shared AST for MATCH/WHERE/RETURN can emit
  both dialects with minimal branching. This is the easy part.

  Creates (C) — Moderate divergence

  - Cypher: CREATE (n:Label {prop: value})
  - GQL: INSERT (:Label {prop: value})

  Different keywords, but structurally equivalent. A thin translation layer handles
  this.

  Updates (U) — Moderate divergence

  - Cypher: SET n.prop = value, REMOVE n.prop
  - GQL: SET n.prop = value (similar, but with stricter type checking against graph
  schema)

  GQL's type system means updates must validate against declared node/edge types. Your
  backend would need a schema registry that Cypher can ignore but GQL enforces.

  Deletes (D) — Low divergence

  DELETE/DETACH DELETE semantics are essentially shared.

  Practical architecture:

  Application Code
         │
     Shared Query IR  ← single internal representation
         │
    ┌────┴────┐
    │ Emitter │
    ├─────────┤
    │  Cypher │  GQL  │
    └────┬────┴───┬───┘
         │        │
      Neo4j    GQL-compliant store

  The real obstacles aren't CRUD syntax — they're semantic gaps:

  1. Schema vs schemaless — GQL mandates a graph type system; Cypher is schema-optional.
   Your IR must carry type metadata that Cypher ignores but GQL requires.
  2. Multi-graph — GQL natively addresses multiple named graphs (USE g). Cypher has no
  equivalent (Neo4j uses database switching). Cross-graph joins only work on GQL
    targets.
  3. Path semantics — GQL's TRAIL/ACYCLIC/SIMPLE path modes have no direct Cypher
  equivalent. You'd need to either restrict to common-denominator semantics or
    conditionally emit workarounds.
  4. Transaction model — Vendor-specific, not language-specific. This lives below the
  query layer.

  Verdict: A dual-target backend is realistic for property-graph CRUD on a single graph
  with a known schema. That covers the majority of application use cases. You hit
  friction at multi-graph queries, advanced path patterns, and schema enforcement
  divergence — but those are edge cases you can gate behind capability flags rather than
   blocking the whole design.

  The sweet spot is an IR that's GQL-native (typed, schema-aware) with a Cypher emitter
  that drops the type metadata. Going the other direction (Cypher-native IR + GQL
  emitter) is harder because you'd need to synthesize schema information that was never
  captured.

❯ what if the system were model driven with GQL sechemas derived from a share model

⏺ That changes the equation significantly — in your favor.

  With a shared model as the single source of truth:

  The schema divergence problem disappears. Your model generates the GQL graph type
  schema and simultaneously informs the Cypher emitter what constraints to expect. Both
  targets consume the same semantic information, just expressed differently.

  Shared Model (e.g. SHACL shapes, your own DSL)
         │
    ┌────┴─────────────┐
    │                   │
    GQL Graph Schema    Cypher constraints
    (CREATE GRAPH TYPE) (indexes + existence checks)
    │                   │
    GQL Emitter         Cypher Emitter
    │                   │
    GQL Store           Neo4j

  What this buys you:

  1. Schema is always available — The biggest GQL/Cypher gap (typed vs schemaless) is
  bridged at the model layer. The GQL emitter produces typed queries naturally; the
    Cypher emitter simply ignores the type annotations since the model already guarantees
    structural correctness.
  2. CRUD becomes mechanical — Each model entity maps to node/edge patterns. Create,
  read, update, delete are all derivable from the shape definitions:

    - C: Model shape → INSERT/CREATE with all required properties and types
    - R: Model shape + query constraints → MATCH pattern with filters
    - U: Model shape + delta → SET with type-valid assignments
    - D: Model shape + cascade rules → DELETE/DETACH DELETE
  3. Validation lives in the model, not the query — You don't need GQL's runtime type
  checking or Cypher constraint violations to catch bad data. The model layer rejects
    invalid operations before any query is emitted.
  4. Multi-graph mapping becomes declarative — The model can declare which subgraphs
  exist, and the GQL emitter produces USE clauses while the Cypher emitter routes to
    separate databases. Same model, different addressing.

  The model-driven approach also eliminates the "lowest common denominator" trap.
  Instead of intersecting GQL ∩ Cypher features, you define capabilities at the model
  level and each emitter uses the best available mechanism:

  ┌──────────────────┬───────────────────────┬─────────────────────────────────────┐
  │  Model concept   │     GQL emission      │           Cypher emission           │
  ├──────────────────┼───────────────────────┼─────────────────────────────────────┤
  │ Required         │ Graph type constraint │ Property existence constraint       │
  │ property         │                       │                                     │
  ├──────────────────┼───────────────────────┼─────────────────────────────────────┤
  │ Cardinality      │ Edge type             │ Application-level check             │
  │                  │ multiplicity          │                                     │
  ├──────────────────┼───────────────────────┼─────────────────────────────────────┤
  │ Path traversal   │ MATCH TRAIL           │ Variable-length pattern + ALL       │
  │                  │                       │ filter                              │
  ├──────────────────┼───────────────────────┼─────────────────────────────────────┤
  │ Named subgraph   │ USE graph_name        │ Database switch                     │
  └──────────────────┴───────────────────────┴─────────────────────────────────────┘

  Where SHACL fits particularly well: SHACL shapes already define property constraints,
  node shapes, cardinality, value types, and relationship paths — exactly the metadata
  both emitters need. A SHACL shape translates almost 1:1 to a GQL node type
  declaration, and provides enough information to generate constrained Cypher.

  Remaining friction points:

  - Query optimization — Each backend has different cost models. The model can inform
  what to query but not how the engine plans it. You'd still want backend-specific hints
     for complex traversals.
  - Transaction semantics — Still vendor-specific, still below the query layer.
  - Vendor extensions — Full-text search, spatial indexes, etc. live outside both
  standards. The model could declare these as capabilities, but emission is
    backend-specific.

  Bottom line: A model-driven design makes dual GQL/Cypher targeting not just feasible
  but clean. The model carries the semantic weight; the emitters become relatively thin
  translators. The shared model is the right abstraction boundary.
