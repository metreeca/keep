/*
 * Copyright © 2025-2026 Metreeca srl
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Model-driven DDL schema generation.
 *
 * Translates `@metreeca/blue` resource shapes to SQL:2003 DDL using a two-phase pipeline: shapes are first mapped to
 * an intermediate {@link TableDescriptor} representation, then rendered to SQL text.
 *
 * > [!NOTE]
 * > The [Schema Design](./schema.md) companion document covers naming conventions, inheritance strategy, type mapping,
 * > field mapping rules, and SQL rendering rules.
 *
 * @document ./schema.md
 *
 * @module
 */

import type { ValueShape } from "@metreeca/blue";
import { boolean } from "@metreeca/blue/boolean";
import type { LocalShape, LocalsShape } from "@metreeca/blue/local";
import {
	byte,
	decimal,
	double,
	float,
	int,
	integer,
	long,
	number,
	short
} from "@metreeca/blue/number";
import {
	resource,
	type Property,
	type ResourceShape,
	type UnionShape
} from "@metreeca/blue/resource";
import { date, duration, email, instant, iri, time, timestamp, url, year } from "@metreeca/blue/string";
import { isFunction, type Lazy } from "@metreeca/core";

/**
 * Boolean shape model to SQL:2003 column type mapping.
 *
 * Maps {@link boolean} shape `model` values to their SQL column types.
 */
const BooleanTypes: ReadonlyMap<boolean, string> = new Map([
	[boolean().model, "BOOLEAN"]
]);

/**
 * Numeric shape model to SQL:2003 column type mapping.
 *
 * Maps {@link number}, {@link byte}, {@link short}, {@link int}, {@link long},
 * {@link float}, {@link double}, {@link integer}, and {@link decimal} shape `model`
 * values to their SQL column types. Each factory assigns a unique `model` value that
 * serves as a type discriminator.
 */
const NumberTypes: ReadonlyMap<number, string> = new Map([
	[number().model, "DOUBLE PRECISION"],   // base numeric
	[byte().model, "SMALLINT"],             // 8-bit signed
	[short().model, "SMALLINT"],            // 16-bit signed
	[int().model, "INTEGER"],               // 32-bit signed
	[long().model, "BIGINT"],               // 64-bit signed (JS ±2⁵³−1)
	[float().model, "REAL"],                // IEEE 754 32-bit
	[double().model, "DOUBLE PRECISION"],   // IEEE 754 64-bit
	[integer().model, "BIGINT"],            // arbitrary-precision integer (JS ±2⁵³−1)
	[decimal().model, "DOUBLE PRECISION"]   // arbitrary-precision decimal (JS double)
]);

/**
 * String shape model to SQL:2003 column type mapping.
 *
 * Maps {@link email}, {@link url}, {@link iri}, {@link year}, {@link date}, {@link time},
 * {@link instant}, {@link timestamp}, and {@link duration} shape `model` values to their
 * SQL column types. Plain strings without a known model value fall back to `VARCHAR(maxLength)`
 * or `CLOB` in {@link mapColumnType}.
 */
const StringTypes: ReadonlyMap<string, string> = new Map([
	[email().model, "VARCHAR(254)"],                            // RFC 5321
	[url().model, "VARCHAR(2000)"],                             // hierarchical URL
	[iri({ variant: "hierarchical" }).model, "VARCHAR(2000)"],  // hierarchical IRI
	[iri({ variant: "absolute" }).model, "VARCHAR(2000)"],      // absolute IRI
	[iri({ variant: "internal" }).model, "VARCHAR(2000)"],      // internal IRI
	[iri({ variant: "relative" }).model, "VARCHAR(2000)"],      // relative IRI
	[year().model, "SMALLINT"],                                 // ISO 8601 year
	[date().model, "TIMESTAMP WITH TIME ZONE"],                 // ISO 8601 date
	[time().model, "TIME WITH TIME ZONE"],                      // ISO 8601 time
	[instant().model, "TIMESTAMP WITH TIME ZONE"],              // ISO 8601 date+time
	[timestamp().model, "TIMESTAMP WITH TIME ZONE"],            // ISO 8601 timestamp (ms, UTC)
	[duration().model, "INTERVAL"]                              // ISO 8601 duration
]);




////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * SQL table descriptor.
 *
 * Intermediate representation for a single SQL table, capturing its name, columns, and primary key structure.
 * Generated from resource shapes during the first phase of the schema pipeline and rendered to DDL text in the second.
 *
 * @see {@link ColumnDescriptor}
 * @see [Naming Conventions](./schema.md#naming-conventions) for table naming rules
 * @see [SQL Rendering Rules](./schema.md#sql-rendering-rules) for DDL output format
 */
export interface TableDescriptor {

	/**
	 * SQL table name.
	 */
	readonly name: string;

	/**
	 * Ordered column definitions for this table.
	 */
	readonly columns: readonly ColumnDescriptor[];

	/**
	 * Column names forming the primary key.
	 *
	 * A single-element `["@"]` array produces an inline `primary key` on the `"@"` column. Multi-element arrays produce
	 * a separate `primary key (...)` clause at the end of the table definition.
	 */
	readonly primaryKey: readonly string[];

}

/**
 * SQL column descriptor.
 *
 * Intermediate representation for a single SQL column within a {@link TableDescriptor}, capturing its type,
 * constraints, and optional foreign key reference.
 */
export interface ColumnDescriptor {

	/**
	 * SQL column name.
	 */
	readonly name: string;

	/**
	 * SQL:2003 column type.
	 */
	readonly type: string;

	/**
	 * Marks the column as an auto-generated identity column (`generated always as identity`).
	 */
	readonly identity?: boolean;

	/**
	 * Whether the column accepts null values.
	 *
	 * `false` produces a `not null` constraint; `true` omits it.
	 */
	readonly nullable: boolean;

	/**
	 * Adds a `unique` constraint to the column.
	 */
	readonly unique?: boolean;

	/**
	 * SQL `default` clause value as a literal string.
	 */
	readonly default?: string;

	/**
	 * Foreign key reference to another table's `"@"` column.
	 */
	readonly references?: {

		/**
		 * Target table name.
		 */
		readonly table: string;

		/**
		 * Whether to add `on delete cascade` to the foreign key.
		 */
		readonly cascade: boolean;

	};

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export function schema(shapes: readonly Lazy<ResourceShape>[]): string {

	return renderSQL(describeTables(collectShapes(shapes)));

}

/**
 * Renders an array of table descriptors to SQL:2003 DDL text.
 *
 * Produces `CREATE TABLE` statements with columns, constraints, and primary keys. The `"@"` column name is
 * rendered as a quoted identifier; all other names are unquoted lowercase. Keywords are rendered in lowercase.
 *
 * @param tables The table descriptors to render, in creation order
 *
 * @returns SQL DDL text with one `CREATE TABLE` statement per table, separated by blank lines
 */
export function renderSQL(tables: readonly TableDescriptor[]): string {

	return tables.map(renderTable).join("\n\n");

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Renders a single table descriptor to a `CREATE TABLE` statement.
 */
function renderTable(table: TableDescriptor): string {

	const inlinePK = table.primaryKey.length === 1 && table.primaryKey[0] === "@";
	const lines: string[] = [];

	lines.push(`create table ${table.name} (`);

	// separate identity/PK column from the rest

	const pkColumn = table.columns.find(c => c.name === "@");
	const otherColumns = table.columns.filter(c => c.name !== "@");

	if ( pkColumn !== undefined ) {

		if ( pkColumn.identity ) {

			// identity PK: no blank line separation needed for single-column tables

			const identityDef = `    ${renderColumnName(pkColumn.name)}`
				+` ${pkColumn.type.toLowerCase()} generated always as identity primary key`;

			if ( otherColumns.length === 0 ) {
				lines.push(identityDef);
			} else {
				lines.push("");
				lines.push(`${identityDef},`);
			}

		} else {

			const pkDef = `    ${renderColumnName(pkColumn.name)}`
				+` ${pkColumn.type.toLowerCase()}`
				+`${inlinePK ? " primary key" : ""}`
				+`${renderReferences(pkColumn)},`;

			lines.push("");
			lines.push(pkDef);

		}

	}

	// group remaining columns: FK columns first, then data columns

	if ( otherColumns.length > 0 ) {

		const hasCompositePK = !inlinePK;

		// find the first non-FK column to insert a blank line separator

		const fkColumns = otherColumns.filter(c => c.references !== undefined);
		const dataColumns = otherColumns.filter(c => c.references === undefined);

		if ( fkColumns.length > 0 ) {

			lines.push("");

			fkColumns.forEach((col, i) => {
				const trailing = (i < fkColumns.length - 1 || dataColumns.length > 0 || hasCompositePK) ? "," : "";
				lines.push(`    ${renderColumn(col)}${trailing}`);
			});

		}

		if ( dataColumns.length > 0 ) {

			lines.push("");

			dataColumns.forEach((col, i) => {
				const trailing = (i < dataColumns.length - 1 || hasCompositePK) ? "," : "";
				lines.push(`    ${renderColumn(col)}${trailing}`);
			});

		}

		if ( hasCompositePK ) {
			lines.push("");
			lines.push(`    primary key (${table.primaryKey.join(", ")})`);
		}

	}

	if ( otherColumns.length > 0 || (pkColumn !== undefined && !pkColumn.identity) ) {
		lines.push("");
	}

	lines.push(");");

	return lines.join("\n");

}

/**
 * Renders a column definition (name, type, constraints, references).
 */
function renderColumn(col: ColumnDescriptor): string {

	const parts = [
		renderColumnName(col.name),
		col.type.toLowerCase()
	];

	if ( !col.nullable ) { parts.push("not null"); }
	if ( col.unique ) { parts.push("unique"); }
	if ( col.default !== undefined ) { parts.push(`default ${col.default}`); }

	if ( col.references !== undefined ) {
		parts.push(`references ${col.references.table} ("@")`);
		if ( col.references.cascade ) { parts.push("on delete cascade"); }
	}

	return parts.join(" ");

}

/**
 * Renders a column name, quoting `"@"` and lowercasing everything else.
 */
function renderColumnName(name: string): string {
	return name === "@" ? "\"@\"" : name.toLowerCase();
}

/**
 * Renders the references clause for a PK column.
 */
function renderReferences(col: ColumnDescriptor): string {

	if ( col.references === undefined ) { return ""; }

	const cascade = col.references.cascade ? " on delete cascade" : "";

	return ` references ${col.references.table} ("@")${cascade}`;

}

/**
 * Converts collected shapes to an ordered array of table descriptors.
 *
 * Processes shapes from {@link collectShapes} and generates the intermediate representation for all required SQL
 * tables: main tables for each shape (with only own properties), child tables for multi-valued and localised fields,
 * and junction tables for multi-valued references. Embedded shapes derive their table names from the discovery
 * context (property name or union variant key); non-embedded shapes derive them from the `class` IRI.
 *
 * Tables are returned in topological order: each shape's main table and child tables appear together, with
 * dependencies (parent tables, referenced tables) guaranteed to precede dependents.
 *
 * @param shapes The collected shapes in top-down inheritance order, as returned by {@link collectShapes}
 *
 * @returns An ordered array of table descriptors suitable for DDL rendering
 *
 * @throws Error if a non-embedded shape is missing a `class` IRI
 */
export function describeTables(shapes: readonly ResourceShape[]): readonly TableDescriptor[] {

	// shape → table name mapping

	const nameOf = new Map<ResourceShape, string>();

	// first pass: name non-embedded shapes from class IRI

	shapes.forEach(shape => {
		if ( shape.class ) {
			nameOf.set(shape, tableName(shape));
		}
	});

	// second pass: name embedded shapes from discovery context

	shapes.forEach(shape => {

		Object.entries(shape.properties)
			.filter((entry): entry is [string, Property] => entry[1].kind === "property")
			.forEach(([key, property]) => {

				const rangeShape = property.range.shape;

				if ( rangeShape.kind === "resource" && !nameOf.has(rangeShape) ) {

					nameOf.set(rangeShape, singularise(key));

				} else if ( rangeShape.kind === "union" ) {

					Object.entries(rangeShape.variants).forEach(([variantKey, variant]) => {
						if ( variant.kind === "resource" && !nameOf.has(variant) ) {
							nameOf.set(variant, snakeCase(variantKey));
						}
					});

				}

			});

	});

	// shape → embedded ownership context (for shapes discovered through properties, not union variants)

	const ownerOf = new Map<ResourceShape, { table: string; shape: ResourceShape }>();

	shapes.forEach(shape => {

		const ownerTable = nameOf.get(shape);

		if ( ownerTable === undefined ) { return; }

		Object.entries(shape.properties)
			.filter((entry): entry is [string, Property] => entry[1].kind === "property")
			.forEach(([, property]) => {

				const rangeShape = property.range.shape;

				if ( rangeShape.kind === "resource" && !rangeShape.class ) {
					ownerOf.set(rangeShape, { table: ownerTable, shape });
				}

			});

	});

	// generate tables for each shape

	return shapes.flatMap(shape => {

		const name = nameOf.get(shape) ?? "";
		const ownKeys = ownPropertyKeys(shape);
		const ownEntries = ownKeys
			.map(key => [key, shape.properties[key]] as const)
			.filter((entry): entry is [string, Property] => entry[1].kind === "property");

		const mainTable = describeMainTable(shape, name, ownKeys, ownEntries, nameOf, ownerOf);
		const childTables = describeChildTables(name, ownEntries, nameOf);

		return [mainTable, ...childTables];

	});

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Computes property keys introduced by this shape, excluding inherited ones.
 */
function ownPropertyKeys(shape: ResourceShape): readonly string[] {

	const parentKeys = new Set<string>();

	if ( shape.extends !== undefined ) {
		[shape.extends].flat().forEach(parent => {
			Object.keys(resource(parent).properties).forEach(k => parentKeys.add(k));
		});
	}

	return Object.keys(shape.properties).filter(k => !parentKeys.has(k));

}

/**
 * Resolves the first parent's table name for the `"@"` foreign key column.
 */
function parentTable(
	shape: ResourceShape,
	nameOf: ReadonlyMap<ResourceShape, string>
): undefined | string {

	if ( shape.extends === undefined ) { return undefined; }

	const parents = [shape.extends].flat();

	return nameOf.get(resource(parents[0]));

}

/**
 * Generates the main table descriptor for a shape.
 */
function describeMainTable(
	shape: ResourceShape,
	name: string,
	ownKeys: readonly string[],
	ownEntries: readonly (readonly [string, Property])[],
	nameOf: ReadonlyMap<ResourceShape, string>,
	ownerOf: ReadonlyMap<ResourceShape, { table: string; shape: ResourceShape }>
): TableDescriptor {

	const columns: ColumnDescriptor[] = [];

	// "@" primary key column

	const parent = parentTable(shape, nameOf);

	if ( parent === undefined ) {

		columns.push({ name: "@", type: "INTEGER", identity: true, nullable: false });

	} else {

		columns.push({ name: "@", type: "INTEGER", nullable: false, references: { table: parent, cascade: true } });

	}

	// owner FK for embedded shapes discovered through properties

	const owner = ownerOf.get(shape);

	if ( owner !== undefined ) {
		columns.push({
			name: owner.table,
			type: "INTEGER",
			nullable: false,
			references: { table: owner.table, cascade: true }
		});
	}

	// id/type meta-property columns

	ownKeys
		.map(key => [key, shape.properties[key]] as const)
		.forEach(([key, entry]) => {

			if ( entry.kind === "id" ) {
				columns.push({ name: key, type: "VARCHAR(2000)", nullable: false, unique: true });
			} else if ( entry.kind === "type" ) {
				columns.push({ name: key, type: "CLOB", nullable: false });
			}

		});

	// own property columns

	ownEntries.forEach(([key, property]) => {
		columns.push(...describePropertyColumns(key, property, nameOf));
	});

	return { name, columns, primaryKey: ["@"] };

}

/**
 * Generates column descriptors for a single property on the main table.
 *
 * Returns columns for single-valued scalars, references, id/type meta-properties,
 * and union variant columns. Returns empty for properties that produce child tables
 * (local, locals, multi-valued scalars, multi-valued references, embedded resources, backlinks).
 */
function describePropertyColumns(
	key: string,
	property: Property,
	nameOf: ReadonlyMap<ResourceShape, string>
): readonly ColumnDescriptor[] {

	const { range } = property;
	const rangeShape = range.shape;
	const singleValued = range.maxCount === 1;
	const required = (range.minCount ?? 0) >= 1;

	// local/locals → always child table

	if ( rangeShape.kind === "local" || rangeShape.kind === "locals" ) {
		return [];
	}

	// backlinks → no DDL

	if ( rangeShape.kind === "reference" && rangeShape.backlink ) {
		return [];
	}

	// multi-valued non-local → child table (except embedded resources handled separately)

	if ( !singleValued ) {
		return [];
	}

	// single-valued scalar

	if ( rangeShape.kind === "boolean" || rangeShape.kind === "number" || rangeShape.kind === "string" ) {

		const type = mapColumnType(rangeShape) ?? "CLOB";
		const column: ColumnDescriptor = { name: key, type, nullable: !required };

		return [withDefault(column, rangeShape)];

	}

	// single-valued reference

	if ( rangeShape.kind === "reference" ) {

		const targetShape = resource(rangeShape.shape);
		const targetTable = nameOf.get(targetShape) ?? "";

		return [{
			name: key,
			type: "INTEGER",
			nullable: !required,
			references: { table: targetTable, cascade: false }
		}];

	}

	// single-valued union → variant columns

	if ( rangeShape.kind === "union" ) {
		return describeUnionColumns(key, rangeShape);
	}

	return [];

}

/**
 * Generates variant columns for a union-typed property.
 */
function describeUnionColumns(
	field: string,
	union: UnionShape
): readonly ColumnDescriptor[] {

	// union variants are always nullable (discriminated by non-null)

	return Object.entries(union.variants).map(([variantKey, variant]) => {

		const columnName = `${field}_${variantKey.toLowerCase()}`;

		if ( variant.kind === "resource" || variant.kind === "reference" ) {

			// entity/reference variant → FK to entity

			return {
				name: columnName,
				type: "INTEGER",
				nullable: true,
				references: { table: "entity", cascade: true }
			};

		} else {

			// scalar variant

			const type = mapColumnType(variant) ?? "CLOB";

			return { name: columnName, type, nullable: true };

		}

	});

}

/**
 * Generates child table descriptors for multi-valued and localised properties.
 */
function describeChildTables(
	ownerTable: string,
	ownEntries: readonly (readonly [string, Property])[],
	nameOf: ReadonlyMap<ResourceShape, string>
): readonly TableDescriptor[] {

	return ownEntries.flatMap(([key, property]) => {

		const { range } = property;
		const rangeShape = range.shape;

		// local → child table with (owner, lang, value) PK

		if ( rangeShape.kind === "local" ) {
			return [describeLocalTable(ownerTable, key, rangeShape)];
		}

		// locals → child table with (owner, lang, value) PK

		if ( rangeShape.kind === "locals" ) {
			return [describeLocalsTable(ownerTable, key, rangeShape)];
		}

		// skip single-valued, backlinks, embedded resources

		if ( range.maxCount === 1 ) { return []; }
		if ( rangeShape.kind === "reference" && rangeShape.backlink ) { return []; }
		if ( rangeShape.kind === "resource" ) { return []; }

		// multi-valued scalar → child table with (owner, value) PK

		if ( rangeShape.kind === "boolean" || rangeShape.kind === "number" || rangeShape.kind === "string" ) {
			return [describeScalarSetTable(ownerTable, key, rangeShape)];
		}

		// multi-valued reference → junction table with (owner, target) PK

		if ( rangeShape.kind === "reference" ) {

			const targetShape = resource(rangeShape.shape);
			const targetTable = nameOf.get(targetShape) ?? "";

			return [describeReferenceSetTable(ownerTable, key, targetTable)];

		}

		return [];

	});

}

/**
 * Generates a child table for a single-valued localised field.
 */
function describeLocalTable(ownerTable: string, field: string, shape: LocalShape): TableDescriptor {
	return {
		name: `${ownerTable}_${field}`,
		columns: [
			{ name: ownerTable, type: "INTEGER", nullable: false, references: { table: ownerTable, cascade: true } },
			{ name: "lang", type: "VARCHAR(10)", nullable: false },
			{ name: "value", type: localValueType(shape), nullable: false }
		],
		primaryKey: [ownerTable, "lang"]
	};
}

/**
 * Generates a child table for a multi-valued localised field.
 */
function describeLocalsTable(ownerTable: string, field: string, shape: LocalsShape): TableDescriptor {
	return {
		name: `${ownerTable}_${field}`,
		columns: [
			{ name: ownerTable, type: "INTEGER", nullable: false, references: { table: ownerTable, cascade: true } },
			{ name: "lang", type: "VARCHAR(10)", nullable: false },
			{ name: "value", type: localValueType(shape), nullable: false }
		],
		primaryKey: [ownerTable, "lang", "value"]
	};
}

/**
 * Generates a child table for a multi-valued scalar field.
 */
function describeScalarSetTable(ownerTable: string, field: string, shape: ValueShape): TableDescriptor {

	const type = mapColumnType(shape) ?? "CLOB";

	return {
		name: `${ownerTable}_${field}`,
		columns: [
			{ name: ownerTable, type: "INTEGER", nullable: false, references: { table: ownerTable, cascade: true } },
			{ name: "value", type, nullable: false }
		],
		primaryKey: [ownerTable, "value"]
	};

}

/**
 * Generates a junction table for a multi-valued reference field.
 */
function describeReferenceSetTable(ownerTable: string, field: string, targetTable: string): TableDescriptor {
	return {
		name: `${ownerTable}_${field}`,
		columns: [
			{ name: ownerTable, type: "INTEGER", nullable: false, references: { table: ownerTable, cascade: true } },
			{ name: targetTable, type: "INTEGER", nullable: false, references: { table: targetTable, cascade: false } }
		],
		primaryKey: [ownerTable, targetTable]
	};
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Resolves the SQL column type for a localised field's value column.
 */
function localValueType(shape: LocalShape | LocalsShape): string {
	return shape.maxLength !== undefined ? `VARCHAR(${shape.maxLength})` : "CLOB";
}

/**
 * Adds a SQL DEFAULT clause from a single-element `hasValue` constraint.
 */
function withDefault(column: ColumnDescriptor, shape: ValueShape): ColumnDescriptor {

	if ( "hasValue" in shape && Array.isArray(shape.hasValue) && shape.hasValue.length === 1 ) {

		const value = shape.hasValue[0];

		if ( typeof value === "string" ) {
			return { ...column, default: `'${value}'` };
		} else {
			return { ...column, default: String(value) };
		}

	}

	return column;

}

/**
 * Converts a PascalCase identifier to snake_case.
 */
function snakeCase(name: string): string {
	return name.replace(/[A-Z]/g, (c, i) => (i > 0 ? `_${c.toLowerCase()}` : c.toLowerCase()));
}

/**
 * Converts a plural English noun to its singular form.
 */
function singularise(name: string): string {

	if ( name.endsWith("ies") ) {
		return `${name.slice(0, -3)}y`;
	} else if ( name.endsWith("ses") ) {
		return name.slice(0, -2);
	} else if ( name.endsWith("s") && !name.endsWith("ss") ) {
		return name.slice(0, -1);
	} else {
		return name;
	}

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Resolves a shape's `class` IRI to the corresponding SQL table name.
 *
 * Extracts the last segment of the class IRI and lowercases it.
 */
export function tableName(shape: Lazy<ResourceShape>): string {

	const resolved = isFunction(shape) ? shape() : shape;
	const iri = resolved.class ?? "";
	const separator = Math.max(iri.lastIndexOf("#"), iri.lastIndexOf("/"));

	return (separator >= 0 ? iri.substring(separator+1) : iri).toLowerCase();

}

/**
 * Resolves the SQL:2003 column type for a value shape.
 *
 * Uses the shape's `model` field as a unique discriminator to look up the corresponding SQL type
 * from factory-specific mapping tables. For plain strings, uses `VARCHAR(n)` if `maxLength` is defined,
 * otherwise `CLOB`. Local/locals shapes are identified at the `kind` level and handled separately.
 */
export function mapColumnType(shape: ValueShape): undefined | string {

	switch ( shape.kind ) {

		case "boolean":

			return BooleanTypes.get(shape.model) ?? "BOOLEAN";

		case "number":

			return NumberTypes.get(shape.model) ?? "DOUBLE PRECISION";

		case "string":

			return StringTypes.get(shape.model) ?? (shape.maxLength ? `VARCHAR(${shape.maxLength})` : "CLOB");

		default:

			return undefined;

	}

}

/**
 * Collects all unique shapes reachable from the given entry points.
 *
 * Traverses the `extends` hierarchy, nested resource shapes, reference target shapes,
 * and union variant shapes. Handles diamond inheritance by checking strict equality
 * on dereferenced shapes. Returns shapes in top-down inheritance order (base shapes first).
 */
export function collectShapes(entries: readonly Lazy<ResourceShape>[]): readonly ResourceShape[] {

	const seen: ResourceShape[] = [];

	entries.forEach(entry => visit(resource(entry)));

	return seen;


	function visit(shape: ResourceShape): void {

		if ( !seen.includes(shape) ) {

			// visit parents first (top-down order)

			if ( shape.extends !== undefined ) {
				[shape.extends].flat().forEach(parent => visit(resource(parent)));
			}

			// register this shape after its parents

			seen.push(shape);

			// traverse properties for nested/referenced/union shapes

			Object.values(shape.properties)
				.filter(entry => entry.kind === "property")
				.forEach((property): void => {

					const shape = property.range.shape;

					switch ( shape.kind ) {

						case "resource":

							return  visit(shape);

						case "reference":

							return visit(resource(shape.shape));

						case "union":

							return Object.values(shape.variants).forEach(variant => {

								if ( variant.kind === "resource" ) {
									visit(variant);
								} else if ( variant.kind === "reference" ) {
									visit(resource(variant.shape));
								}

							});

						default:

							return;

					}

				});

		}

	}

}
