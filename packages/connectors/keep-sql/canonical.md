# Canonical-string mutation approach (SQL / GQL connectors)

## Principle

Mirror the SPARQL stack: split shape-driven query **generation** from backend-specific
**execution**, with a query **string** as the contract between them.

```
shape ──▶ keep-sql / keep-gql ──▶ canonical string ──▶ wire-sql-* / wire-gql-* ──▶ backend
        (generation, BE-blind)                        (execution + local rewriting)
```

## Layering

- **`keep-sql` / `keep-gql`** — derive mutations from the shape and emit a string in a single
  **fixed canonical dialect** per stack (canonical-SQL, canonical-GQL). Backend-blind.
- **`wire-sql-*` / `wire-gql-*`** — accept that string (as `wire-sparql`'s `Repository` accepts
  SPARQL Update), adapt it to the concrete backend, execute.

## Canonical dialect

- One fixed canonical per stack, chosen as a **deliberately restricted portable subset** (not a
  full real dialect), so most adapters are pass-through and only divergent backends rewrite.
- It is an **implicit, unsignalled constant** of the wire contract — like "the string is
  SPARQL 1.1". No dialect tag, no negotiation, no per-call signalling.
- Pinned as a **versioned spec** (build-time): if canonical-X evolves, adapters track the version.
  Nothing transmitted at runtime; something documented and versioned.

## Adapter rewriting

- Each adapter alone knows its backend's discrepancies and rewrites **unilaterally**.
- Pass-through by default (+ escaping / protocol). Transpilation only when a backend diverges.
- When required, rewriting MUST be **AST-level** (SQLGlot / Calcite style), never string surgery —
  quoting, literals, comments and precedence make regex rewriting unsafe.
- Semantic gaps (upsert `ON CONFLICT` ↔ `MERGE`, `RETURNING`, pagination) are clause
  *restructures*, not token swaps; the canonical subset should avoid constructs whose targets
  differ structurally. A backend needing heavy transpilation is a signal it deserves its own
  canonical target, not a contortion of the shared one.

## Independence

- **SQL and GQL stacks stay fully independent** — no shared syntax, data model, or canonical
  dialect; a common IR across paradigms would be a leaky cross-paradigm abstraction.
- Shared surface is only the **Keep model contract** (`StoreManager`, shape) at the top, never the
  wire contract at the bottom.
- They share the *pattern* (shape → canonical string → wire adapter), not code.

## Scope note

- Gremlin-only stores are **out of scope** (different paradigm, not a transpile). Canonical-GQL
  targets openCypher-family backends (Neo4j, Memgraph), where adapters are near pass-through.

## Handling divergence without a full AST

Divergence is almost always **localized** (a few clauses: upsert, `RETURNING`, pagination), so an
adapter rarely needs to parse the whole query — it only needs to isolate the divergent spans. A
full-AST transpile is therefore avoidable. Options, lightest contract first:

1. **Intersection subset — no rewriting.** Constrain canonical so it is valid verbatim on every
   target; never emit a divergent construct (e.g. drop atomic upsert, emit portable
   `UPDATE`-then-`INSERT`). Adapters are pure pass-through.
   - ➖ lowest common denominator: no atomic upsert, more round-trips, weaker semantics.

2. **Typed holes / placeholders.** Generation emits canonical text with typed placeholders for the
   divergent bits only (`{{UPSERT …}}`, `{{LIMIT n}}`, `{{RETURNING cols}}`), each backed by a small
   structured descriptor; the adapter fills holes from per-dialect templates, rest is literal.
   - ➕ no parsing; structure carried only where semantically needed. **Sweet spot.**
   - ➖ generation + adapter share a hole protocol (mini-contract).

3. **Marked-span rewriting.** Generation wraps divergent clauses in sentinel markers guaranteed not
   to appear in literals; adapter does targeted span replacement (safe regex within known bounds).
   - ➕ minimal machinery, still string-in.
   - ➖ marker discipline brittle if it leaks; weaker guarantees than typed holes.

4. **Hybrid two-tier contract.** Common mutations travel as plain canonical string (pass-through);
   only the few structurally-divergent ops (realistically just upsert) travel as a tiny semantic
   command object (`{op:'upsert', table, keys, cols}`) the adapter renders natively.
   - ➕ avoids both AST and LCD loss; the object is a small descriptor, not a syntax tree.
   - ➖ two shapes on the contract; mild asymmetry with SPARQL's single-string contract.

5. **Dialect profile at generation time.** Adapter supplies a small capability profile (quote char,
   upsert template, pagination form) *up* to generation, which renders correctly first time
   (Kysely / Knex / Calcite-dialect model). No post-hoc rewriting, no parse anywhere.
   - ➕ zero rewriting; divergence handled once, declaratively.
   - ➖ breaks strict downstream layering: generation consults the adapter's profile.

6. **Backend-native helpers.** Per-backend stored procedures/functions accept canonical-shaped
   params; adapter calls a fixed proc instead of rewriting SQL.
   - ➕ rewriting leaves the string path entirely.
   - ➖ requires backend migrations/setup; operational weight.

**Recommendation** (string contract, thin adapters, no full AST): **#2 typed holes** or **#4
hybrid** — both confine structural knowledge to the genuinely divergent ops and keep everything else
literal pass-through. **#1** if LCD semantics are acceptable; **#5** if strict downstream layering
can be relaxed; **#3** only for the absolute minimum with trusted marker discipline.
