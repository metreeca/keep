---
title: Schema Module Design
summary: Design document for the schema.ts DDL generation module
description: |
  Defines the architecture, mapping rules, and intermediate representation for translating
  @metreeca/blue resource shapes to SQL:2003 DDL in schema.ts.
---

# Architecture

Schema generation follows a two-phase pipeline: **shapes → table descriptors → SQL text**. The intermediate
representation decouples structural logic (which properties become columns vs child tables, how inheritance maps) from
SQL text rendering.

**Target standard**: SQL:2003 (ISO/IEC 9075:2003). Per-engine adapters handle dialect differences for PostgreSQL,
MySQL 8+, and SQL Server. PGlite (PostgreSQL 17.4 in WASM) is the test engine.

# Intermediate Representation

Defined by `TableDescriptor` and `ColumnDescriptor` in `schema.ts`.

# Naming Conventions

- **Tables (non-embedded)**: Singular lowercase from `class` IRI last segment — `entity`, `resource`, `category`,
  `vendor`, `product`. All non-embedded shapes **must** have a `class` IRI; schema generation reports an error if
  missing.
- **Tables (embedded)**: Derived from discovery context — variant key → snake_case (`PostalAddress` → `postal_address`),
  property name → singularised (`reviews` → `review`). Embedded shapes are not shared across owners, so the context is
  always unambiguous.
- **Columns**: Lowercase, bare table name for foreign keys (FKs) — `vendor`, `product`, `category`, `parent`
- **Child tables**: `{owner}_{field}` — `product_image`, `product_keyword`, `category_title`
- **Surrogate key**: `"@"` — quoted identifier, not a valid JS identifier, guaranteed to never clash with model property
  names
- **Keywords**: All lowercase — `create table`, `not null`, `primary key`, `on delete cascade`
- **Constraints**: Enforced at application level, not in DDL (no CHECK constraints)

# Inheritance

**Strategy: Joined table inheritance**

Two base tables form the inheritance chain:

| Table      | Holds                                      | Extended by          |
|------------|--------------------------------------------|----------------------|
| `entity`   | Surrogate key (`"@"`)                      | Everything           |
| `resource` | `"@"` + `id`, `type`, `created`, `updated` | Standalone resources |

Concrete resource types (Category, Vendor, Product) reference `resource."@"`. Embedded entity types (Review,
PostalAddress) reference `entity."@"` directly — they have identity and label/comment but no `id`, `type`, or
timestamps.

Each shape's table contains columns only for properties it **introduces** — not inherited ones. Inherited properties
are stored in the ancestor's table. Own properties are computed by excluding property keys present in any parent shape.

# Type Mapping

| Base    | Type      | SQL:2003                   | Notes                                                 |
|---------|-----------|----------------------------|-------------------------------------------------------|
| boolean | boolean   | `BOOLEAN`                  | Adapter maps to `SMALLINT` for SQL Server             |
| number  | number    | `DOUBLE PRECISION`         | Base numeric type                                     |
|         | byte      | `SMALLINT`                 |                                                       |
|         | short     | `SMALLINT`                 |                                                       |
|         | int       | `INTEGER`                  |                                                       |
|         | long      | `BIGINT`                   | Limited to ±2⁵³-1 in JS                               |
|         | float     | `REAL`                     |                                                       |
|         | double    | `DOUBLE PRECISION`         |                                                       |
|         | integer   | `BIGINT`                   | Limited to ±2⁵³-1 in JS                               |
|         | decimal   | `DOUBLE PRECISION`         | Limited to IEEE 754 double in JS                      |
| string  | string    | `VARCHAR(n)`/`CLOB`        | `VARCHAR(n)` if `maxLength` defined; `CLOB` otherwise |
|         | email     | `VARCHAR(254)`             |                                                       |
|         | url       | `VARCHAR(2000)`            |                                                       |
|         | uri       | `VARCHAR(2000)`            |                                                       |
|         | year      | `SMALLINT`                 |                                                       |
|         | date      | `TIMESTAMP WITH TIME ZONE` |                                                       |
|         | time      | `TIME WITH TIME ZONE`      |                                                       |
|         | instant   | `TIMESTAMP WITH TIME ZONE` |                                                       |
|         | timestamp | `TIMESTAMP WITH TIME ZONE` |                                                       |
|         | duration  | `INTERVAL`                 | Adapter maps to `VARCHAR(20)` for MySQL/SQL Server    |
| tagged  | local     | `VARCHAR(n)`/`CLOB`        | Stored in child tables                                |
|         | locals    | `VARCHAR(n)`/`CLOB`        | Stored in child tables                                |

# Field Mapping

## Single-Valued Fields

Single-valued fields (`required` or `optional`) are stored as columns directly on the owning table. `required` maps to
`NOT NULL`; `optional` maps to nullable. Model `default` values translate to SQL `DEFAULT` clauses. Model `unique`
constraints translate to SQL `UNIQUE` constraints.

## Multi-Valued Fields

Each multi-valued field gets its own child table `{owner}_{field}(owner, ...)`:

| Field type    | PK                      | Example                                 |
|---------------|-------------------------|-----------------------------------------|
| Scalar set    | `(owner, value)`        | `product_image(product, url)`           |
| Localised     | `(owner, lang)`         | `product_name(product, lang, value)`    |
| Localised set | `(owner, lang, value)`  | `product_keyword(product, lang, value)` |
| Reference set | `(owner, target)`       | `product_category(product, category)`   |
| Embedded list | Own `"@"` PK + owner FK | `review("@", product, ...)`             |

## Localised Fields

Localised fields follow the pattern `{owner}_{field}(owner, lang, value)`. The `lang` column is always
`varchar(10) not null` (BCP 47 language tag). The `value` column length matches the field's constraint. The owner FK
column is named after the owning table.

Label and comment are defined at the `entity` level and shared by all entity types via `entity_label` and
`entity_comment`.

## References

- **Single-valued** (`required` or `optional`): FK column on the owning table using the bare target table name
- **Multi-valued** (`multiple` or `repeatable`): Separate junction table `{owner}_{field}(owner, target)`
- **Backlinks** (`multiple(backlink(...))`): No storage — resolved by querying the inverse FK
- **Cascade**: `on delete cascade` on ownership FKs (child tables, embedded entities); reference FKs omit cascade

## Union Types

Union variants are inlined as nullable columns. No discriminator column is needed — exactly one variant column is
non-null per row (enforced at application level).

- **Single-valued unions**: Variant columns on the owner table, named `{field}_{variant}`
- **Multi-valued unions**: Variant columns on the child table, following the same pattern
- **Scalar variants**: Inline column with the variant's SQL type
- **Entity variants**: FK column referencing `entity."@"` with `on delete cascade`

## Embedded Entities

Embedded entities extend `entity` (not `resource`). The owner FK column and table name are derived from the traversal
context. Since embedded shapes are not shared across owners, the context is always unambiguous.

# SQL Rendering Rules

- PK is `["@"]` → inline `primary key` on the `"@"` column
- PK is multi-column → separate `primary key (...)` clause at end of table
- `"@"` column name → quoted identifier in SQL
- All other names → unquoted lowercase
