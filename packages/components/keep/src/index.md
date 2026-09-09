---
title: Transaction Design
summary: Cross-backend transaction isolation semantics for Store
description: >-
  Design rationale and cross-backend comparison for transaction isolation levels, concurrency models, and commit
  semantics across SQL:2011, GQL:2024, and SPARQL 1.1 (RDF4J) backends.
---

# Design Rationale

The `Store` interface extends `StoreClient` with the ability to group multiple operations into an atomic unit of work.
Transaction semantics follow the same cross-backend principle adopted by
[@metreeca/qest](https://metreeca.github.io/qest/documents/model.Model_Design.html): each connector targets the
strongest guarantees its backend supports — drawn from the well-defined counterparts across
[SQL:2011](https://www.iso.org/standard/53681.html),
[GQL:2024](https://www.iso.org/standard/76120.html), and [SPARQL 1.1](https://www.w3.org/TR/sparql11-update/) (
via [RDF4J](https://rdf4j.org/)) — and documents the result.

# Adopted Semantics

## Atomicity

All operations within a transaction either succeed together or are rolled back as a whole. If the task function throws
or its returned promise rejects, the transaction is rolled back and the error is propagated to the caller.

## Non-Reentrancy

Calls to `execute` are not reentrant. The task receives a `StoreClient` that does not expose `execute`, so transaction
boundaries are flat and any composition must share a single outer call site. Nested transactions and savepoints are out
of scope.

## Isolation

Implementations provide **best-effort** isolation: each connector targets the strongest level its backend supports —
ideally **snapshot isolation**, where the transaction observes a consistent snapshot of the store as of its start time
with no phantom or non-repeatable reads — and degrades gracefully to the maximum level achievable by the underlying
storage, down to no isolation at all when the backend offers no transactional guarantees.

The exact isolation level is implementation-defined and **must** be documented by each backend connector.

# Isolation Level Reference

Standard isolation levels are defined by the anomalies they prevent. Each level subsumes all guarantees of the levels
below it.

| Level                  | Dirty Reads | Non-repeatable Reads | Phantoms  | Write Skew |
|------------------------|-------------|----------------------|-----------|------------|
| **Read Uncommitted**   | Possible    | Possible             | Possible  | Possible   |
| **Read Committed**     | Prevented   | Possible             | Possible  | Possible   |
| **Repeatable Read**    | Prevented   | Prevented            | Possible  | Possible   |
| **Snapshot Isolation** | Prevented   | Prevented            | Prevented | Possible   |
| **Serialisable**       | Prevented   | Prevented            | Prevented | Prevented  |

- **Dirty read**: reading data written by a concurrent uncommitted transaction
- **Non-repeatable read**: reading the same row twice within a transaction yields different values because a concurrent
  transaction committed an update between the two reads
- **Phantom read**: re-executing a query within a transaction yields additional rows because a concurrent transaction
  committed an insert matching the query predicate
- **Write skew**: two concurrent transactions read overlapping data, make disjoint writes based on stale reads, and both
  commit — leaving the store in a state neither transaction would have allowed alone

> [!NOTE]
> Snapshot isolation is not part of the SQL standard, which was defined before SI existed. Several engines label their
> SI implementation as "Repeatable Read" (PostgreSQL, MySQL/InnoDB), blurring the distinction. The table above reflects
> the theoretical guarantees; see [Backend Comparison](#backend-comparison) for actual engine behaviour.

# Backend Comparison

The tables below document how each target backend natively handles transaction isolation, and where connector-level
normalisation is required.

## Isolation Level Availability

The table below documents which isolation levels each target backend supports (★ default, ☆ supported, · not supported).
Levels map to the [reference table](#isolation-level-reference) above.

| Engine                 | [RU] | [RC] | [RR] | [SI] | [SER] |
|------------------------|------|------|------|------|-------|
| **SQL:2011**           |      |      |      |      |       |
| PostgreSQL             | ☆ ¹  | ★    | ☆ ²  | ·    | ☆     |
| MySQL/InnoDB           | ☆    | ☆    | ★ ³  | ·    | ☆     |
| SQL Server             | ☆    | ★    | ☆    | ☆ ⁴  | ☆     |
| SQLite                 | ·    | ·    | ·    | ·    | ★     |
| **GQL:2024**           |      |      |      |      |       |
| Neo4j                  | ·    | ★    | ·    | ·    | ·     |
| Memgraph               | ☆    | ☆    | ·    | ★    | ·     |
| **SPARQL 1.1 (RDF4J)** |      |      |      |      |       |
| RDF4J MemoryStore      | ☆    | ☆    | ★ ⁵  | ☆ ⁵  | ☆     |
| RDF4J NativeStore      | ☆    | ☆    | ★ ⁵  | ☆ ⁵  | ☆ ⁶   |
| RDF4J LmdbStore        | ☆    | ☆    | ★ ⁵  | ☆ ⁵  | ☆     |
| GraphDB                | ☆    | ★    | ·    | ·    | ·     |
| Amazon Neptune         | ·    | ☆ ⁷  | ·    | ★ ⁷  | ·     |

[RU]: #isolation-level-reference

[RC]: #isolation-level-reference

[RR]: #isolation-level-reference

[SI]: #isolation-level-reference

[SER]: #isolation-level-reference

### Caveats

¹ PostgreSQL accepts `READ UNCOMMITTED` syntactically but treats it as Read Committed.

² PostgreSQL's "Repeatable Read" uses Multi-Version Concurrency Control (MVCC) snapshots at transaction start,
effectively providing snapshot isolation (no phantom reads). Stronger than the SQL standard definition of RR.

³ MySQL/InnoDB's "Repeatable Read" uses MVCC snapshots for consistent reads (SI-like), but locking reads (`SELECT ...
FOR UPDATE`), `UPDATE`, and `DELETE` acquire gap locks and next-key locks, behaving as Read Committed for those
operations.

⁴ SQL Server's snapshot isolation requires explicit database-level configuration
(`ALTER DATABASE ... SET ALLOW_SNAPSHOT_ISOLATION ON`). Additionally, `READ_COMMITTED_SNAPSHOT ON` makes the default
Read Committed use row versioning (statement-level snapshot).

⁵ RDF4J defines `SNAPSHOT_READ` (consistent snapshot per query, closest to RR) and `SNAPSHOT` (consistent snapshot for
entire transaction, closest to SI) as separate levels. Stores declare supported levels via
`getSupportedIsolationLevels()`. Native stores default to `SNAPSHOT_READ`.

⁶ RDF4J NativeStore `SERIALIZABLE` had memory leak issues tracked in
[eclipse-rdf4j#1031](https://github.com/eclipse-rdf4j/rdf4j/issues/1031).

⁷ Amazon Neptune's isolation level is not configurable — it is determined automatically by query type. Read-only queries
(SELECT, ASK, CONSTRUCT, DESCRIBE) run at snapshot isolation via MVCC. Mutation queries (INSERT, DELETE) run at an
enhanced Read Committed with range locks that prevent phantoms and non-repeatable reads, effectively approaching
Serialisable. Neptune does not implement the RDF4J transaction API; isolation semantics are baked into the engine.

### Notable Limitations

- **SQLite**: only Serialisable; no configurable isolation levels. Single-writer constraint; Write-Ahead Logging (WAL)
  mode gives SI-like behaviour for readers
- **Neo4j**: only Read Committed; serialisable-like behaviour requires explicit write locks on shared nodes
- **GraphDB**: only supports up to Read Committed natively. Does not guarantee a consistent snapshot within a single
  transaction. Stricter levels can be layered via RDF4J's stackable Storage And Inference Layer (SAIL) interface but are
  not natively supported
- **Amazon Neptune**: isolation levels are not configurable — determined automatically by query type. Does not implement
  the RDF4J transaction API. Applications must handle `ConcurrentModificationException` with retry logic

## Concurrency Models

| Backend Family              | Concurrency Model                   | Conflict Handling                       |
|-----------------------------|-------------------------------------|-----------------------------------------|
| **SQL** (PostgreSQL, MySQL) | MVCC, multiple writers              | Serialisation failure → retry           |
| **SQL** (SQLite)            | WAL, single writer                  | Writer queue; readers never blocked     |
| **GQL** (Neo4j)             | Optimistic locking                  | Write-write conflict → abort            |
| **GQL** (Memgraph)          | MVCC                                | Serialisation failure → abort           |
| **RDF4J** (native stores)   | Versioning, single writer           | Writer queue; readers never blocked     |
| **RDF4J** (GraphDB)         | Sequential writes, parallel reads   | No conflict — writes are serialised     |
| **RDF4J** (Neptune)         | MVCC reads, pessimistic write locks | ConcurrentModificationException → retry |

# Adopted Targets

Given the backend landscape, the framework does not impose a uniform isolation floor — each connector targets the
strongest level its backend supports and documents the resulting guarantee. Most backends natively provide snapshot
isolation or better; outliers like GraphDB cap at read-committed and connectors built on them inherit that ceiling.

## Read Semantics

Read visibility within a transaction depends on the connector's implementation strategy:

- Connectors layered on a backend with **native** atomic transactions delegate read visibility to the backend, observing
  whatever the configured isolation level provides — including read-your-own-writes when the underlying engine offers
  it.
- Connectors that **emulate** atomicity by buffering mutations until commit (see [Write Semantics](#write-semantics))
  deliberately bypass their buffer on read, so a transaction observes only the snapshot and not its own pending writes.
  This is stricter than standard snapshot isolation but is a direct consequence of the buffer-and-flush pattern;
  connectors adopting this pattern **must** document the restriction.

## Write Semantics

When the backend supports atomic transactions natively, connectors route mutations directly through the backend's
transaction primitive and commit atomically.

When it does not, the `Store` interface requires connectors to **emulate** atomicity by buffering all mutation requests
in memory during the transaction and flushing them in order at commit time. This pattern:

- Preserves strict snapshot read semantics by deferring writes until after all reads complete
- Reduces commit overhead by grouping multiple mutations into a single round-trip
- Relies on the backend's native conflict detection at flush time

Buffering shifts memory pressure to the client: callers are responsible for sizing transactions according to available
memory. For bulk data loading, this means splitting large batches of `insert` or `remove` calls across multiple
transactions.

> [!IMPORTANT]
> Under the buffer-and-flush pattern, backend constraint checks (uniqueness, referential integrity) only fire at flush
> time. Errors from conflicting writes surface at commit, not at the point of the buffered call.

## Connector Guidelines

Backend connectors should:

1. Request the strongest isolation level the backend supports, up to snapshot isolation
2. Use the backend's native transaction primitive when available; otherwise emulate atomicity via the buffer-and-flush
   pattern
3. Document the actual isolation level provided and any read-visibility restrictions imposed by the chosen strategy

## References

- [PostgreSQL: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [MySQL: InnoDB Transaction Isolation Levels](https://dev.mysql.com/doc/refman/8.4/en/innodb-transaction-isolation-levels.html)
- [SQL Server: SET TRANSACTION ISOLATION LEVEL](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-transaction-isolation-level-transact-sql)
- [SQLite: Isolation](https://sqlite.org/isolation.html)
- [Memgraph: Transactions](https://memgraph.com/docs/fundamentals/transactions)
- [RDF4J: IsolationLevels Javadoc](https://rdf4j.org/javadoc/5.0.3/org/eclipse/rdf4j/common/transaction/IsolationLevels.html)
