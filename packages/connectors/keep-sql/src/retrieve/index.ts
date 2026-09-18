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

import type { Transaction } from "@electric-sql/pglite";
import type { Property, ResourceShape } from "@metreeca/blue/resource";
import { isArray } from "@metreeca/core";
import { decodeProbe, type Model } from "@metreeca/qest/model";
import type { Reference } from "@metreeca/qest/state";
import { log } from "@metreeca/tape";

import { tableName } from "../schema.js";


const logger = log(import.meta.url);


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Classification of a model property for SQL generation.
 */
type PropertyClass =

	| { readonly kind: "scalar"; readonly property: string; readonly column: string }
	| { readonly kind: "id"; readonly property: string }
	| { readonly kind: "type"; readonly property: string }
	| { readonly kind: "local"; readonly property: string; readonly field: string }
	| { readonly kind: "multi-scalar"; readonly property: string; readonly field: string }
	| { readonly kind: "reference"; readonly property: string; readonly field: string }
	| { readonly kind: "multi-reference"; readonly property: string; readonly field: string }
	| { readonly kind: "backlink"; readonly property: string; readonly field: string }
	| { readonly kind: "embedded"; readonly property: string; readonly field: string }
	| { readonly kind: "union"; readonly property: string; readonly field: string }
	| { readonly kind: "collection"; readonly property: string }


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export async function retrieve<T extends Model>(
	db: Transaction,
	id: Reference,
	model: T,
	shape: ResourceShape
): Promise<undefined | T> {

	logger.debug`retrieving <${id}> from <${tableName(shape)}>`;

	// classify model properties against shape

	const classifications = classifyProperties(model, shape);

	// generate and execute single-pass scalar query

	const query = selectResource(classifications, shape);

	if ( query ) {

		const { rows } = await db.query<Record<string, unknown>>(query.sql, [id]);

		if ( rows.length > 0 ) {

			const [row] = rows;

			// assemble result from classifications and row data

			return Object.fromEntries(
				classifications.map(c => [c.property, resolveProperty(c, row)])
			) as T;

		} else {
			return undefined;
		}

	} else {
		return undefined;
	}

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Generates a SELECT query that resolves a resource by IRI, joining the resource
 * table with the owner table and collecting all scalar/FK columns in a single pass.
 *
 * Returns `undefined` if no scalar columns need fetching.
 */
function selectResource(
	classifications: readonly PropertyClass[],
	shape: ResourceShape
): undefined | { readonly sql: string; readonly columns: readonly string[] } {

	const table = tableName(shape);

	const uniqueColumns = [...new Set(classifications.flatMap(columnFor))];

	if ( uniqueColumns.length === 0 ) {
		return undefined;
	}

	// join resource + owner table, select all columns unqualified

	const selectList = uniqueColumns.map(c => `"${c}"`).join(", ");
	const sql = `SELECT ${selectList}
                 FROM resource r
                          JOIN "${table}" t ON t."@" = r."@"
                 WHERE r.id = $1`;

	return { sql, columns: uniqueColumns };

}

function resolveProperty(c: PropertyClass, row: Record<string, unknown>): unknown {

	switch ( c.kind ) {
		case "scalar":
			return row[c.column] ?? undefined;
		case "id":
		case "type":
			return row[c.kind] ?? undefined;
		case "reference":
			return row[c.field] ?? undefined; // !!! resolve FK to nested model
		case "collection":
			return []; // !!! stub collection retrieval
		case "local":
			return undefined; // !!! retrieve from child table
		case "multi-scalar":
			return undefined; // !!! retrieve from child table
		case "multi-reference":
			return undefined; // !!! retrieve from junction table
		case "backlink":
			return undefined; // !!! retrieve via reverse FK
		case "embedded":
			return undefined; // !!! retrieve from embedded entity table
		case "union":
			return undefined; // !!! resolve union variant columns
	}

}


/**
 * Classifies model properties against the shape for SQL query generation.
 */
function classifyProperties(model: Model, shape: ResourceShape): readonly PropertyClass[] {
	return Object.entries(model)
		.map(([property, template]) => classifyEntry(property, template, shape))
		.filter((c): c is PropertyClass => c !== undefined);
}

function classifyEntry(property: string, template: unknown, shape: ResourceShape): undefined | PropertyClass {

	if ( isArray(template) ) {
		return { kind: "collection", property };
	}

	const { target, path } = decodeProbe(property);

	if ( typeof target !== "string" ) {
		return undefined; // !!! operators — skip for now
	}

	const field = path.length > 0 ? path[0] : target;
	const entry = shape.properties[field];

	if ( entry?.kind === "id" ) {
		return { kind: "id", property };
	} else if ( entry?.kind === "type" ) {
		return { kind: "type", property };
	} else if ( entry?.kind === "property" ) {
		return classifyProperty(property, field, entry);
	} else {
		return undefined;
	}

}

function classifyProperty(property: string, field: string, entry: Property): PropertyClass {

	const { shape: valueShape } = entry.range;
	const isMulti = entry.range.maxCount !== 1;

	if ( valueShape.kind === "local" || valueShape.kind === "locals" ) {
		return { kind: "local", property, field };
	} else if ( valueShape.kind === "union" ) {
		return { kind: "union", property, field };
	} else if ( valueShape.kind === "reference" ) {

		if ( "backlink" in valueShape && valueShape.backlink ) {
			return { kind: "backlink", property, field };
		} else if ( isMulti ) {
			return { kind: "multi-reference", property, field };
		} else {
			return { kind: "reference", property, field };
		}

	} else if ( valueShape.kind === "resource" ) {
		return { kind: "embedded", property, field };
	} else if ( isMulti ) {
		return { kind: "multi-scalar", property, field };
	} else {
		return { kind: "scalar", property, column: field };
	}

}

function columnFor(c: PropertyClass): readonly string[] {

	if ( c.kind === "scalar" ) {
		return [c.column];
	} else if ( c.kind === "id" ) {
		return [c.kind];
	} else if ( c.kind === "type" ) {
		return [c.kind];
	} else if ( c.kind === "reference" ) {
		return [c.field];
	} else {
		return [];
	}

}
