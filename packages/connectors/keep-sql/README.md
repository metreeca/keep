---
title: SQL Store
summary: PGlite-backed TxnStore operating against a predefined schema mapping
description: |
  A TxnStore implementation that executes shape-driven SQL against a PGlite
  database whose schema follows the model-to-DDL mapping defined in mapping.md.
---

# Inbox

- All non-embedded shapes must define a `class` IRI (table naming + `resource.type` discriminator); error if missing

# Overview

This module provides a `TxnStore` implementation backed by a PGlite embedded PostgreSQL instance.

> [!IMPORTANT]
> This is **not a generic ORM**. The store expects the target database to already contain tables structured according
> to the [model-to-DDL mapping](src/schema.md) rules. It does not generate DDL, migrate schemas, or infer table
> layouts at runtime.

The store reads shape metadata from validated values (via `audit()`) and translates Store operations into SQL statements
targeting the expected table/column structure. See [mapping.md](src/schema.md) for the complete mapping
rules and [toys.ddl](src/index.test.ddl) for a concrete example.

# Entry Point

```typescript
import { createSQLStore } from "@metreeca/keep/stores/sql";

const store = createSQLStore(db); // db: PGlite instance with schema already applied
```
