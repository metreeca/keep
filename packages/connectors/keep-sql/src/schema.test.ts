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

import { boolean } from "@metreeca/blue/boolean";
import { local, locals } from "@metreeca/blue/local";
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
import { multiple, reference, required, resource, union } from "@metreeca/blue/resource";
import {
	date,
	duration,
	email,
	instant,
	string,
	time,
	timestamp,
	url,
	year
} from "@metreeca/blue/string";
import { describe, expect, it } from "vitest";
import { Category, Entity, PostalAddress, Product, Resource, Review, Vendor } from "../../../suites/toys.js";
import { type ColumnDescriptor, collectShapes, describeTables, mapColumnType, renderSQL, type TableDescriptor, tableName } from "./schema.js";


describe("columnType", () => {

	describe("boolean", () => {

		it("should map boolean to BOOLEAN", async () => {
			expect(mapColumnType(boolean())).toBe("BOOLEAN");
		});

	});

	describe("number", () => {

		it("should map number to DOUBLE PRECISION", async () => {
			expect(mapColumnType(number())).toBe("DOUBLE PRECISION");
		});

		it("should map byte to SMALLINT", async () => {
			expect(mapColumnType(byte())).toBe("SMALLINT");
		});

		it("should map short to SMALLINT", async () => {
			expect(mapColumnType(short())).toBe("SMALLINT");
		});

		it("should map int to INTEGER", async () => {
			expect(mapColumnType(int())).toBe("INTEGER");
		});

		it("should map long to BIGINT", async () => {
			expect(mapColumnType(long())).toBe("BIGINT");
		});

		it("should map float to REAL", async () => {
			expect(mapColumnType(float())).toBe("REAL");
		});

		it("should map double to DOUBLE PRECISION", async () => {
			expect(mapColumnType(double())).toBe("DOUBLE PRECISION");
		});

		it("should map integer to BIGINT", async () => {
			expect(mapColumnType(integer())).toBe("BIGINT");
		});

		it("should map decimal to DOUBLE PRECISION", async () => {
			expect(mapColumnType(decimal())).toBe("DOUBLE PRECISION");
		});

	});

	describe("string", () => {

		it("should map plain string with maxLength to VARCHAR(n)", async () => {
			expect(mapColumnType(string({ maxLength: 200 }))).toBe("VARCHAR(200)");
		});

		it("should map plain string without maxLength to CLOB", async () => {
			expect(mapColumnType(string())).toBe("CLOB");
		});

		it("should map email to VARCHAR(254)", async () => {
			expect(mapColumnType(email())).toBe("VARCHAR(254)");
		});

		it("should map url to VARCHAR(2000)", async () => {
			expect(mapColumnType(url())).toBe("VARCHAR(2000)");
		});

		it("should map year to SMALLINT", async () => {
			expect(mapColumnType(year())).toBe("SMALLINT");
		});

		it("should map date to TIMESTAMP WITH TIME ZONE", async () => {
			expect(mapColumnType(date())).toBe("TIMESTAMP WITH TIME ZONE");
		});

		it("should map time to TIME WITH TIME ZONE", async () => {
			expect(mapColumnType(time())).toBe("TIME WITH TIME ZONE");
		});

		it("should map instant to TIMESTAMP WITH TIME ZONE", async () => {
			expect(mapColumnType(instant())).toBe("TIMESTAMP WITH TIME ZONE");
		});

		it("should map timestamp to TIMESTAMP WITH TIME ZONE", async () => {
			expect(mapColumnType(timestamp())).toBe("TIMESTAMP WITH TIME ZONE");
		});

		it("should map duration to INTERVAL", async () => {
			expect(mapColumnType(duration())).toBe("INTERVAL");
		});

	});

});

describe("collectShapes", () => {

	it("should return empty array for empty input", async () => {
		expect(collectShapes([])).toEqual([]);
	});

	it("should collect a single shape with no extends", async () => {

		const Simple = resource({ class: "http://example.net/Simple" }, {
			name: required(string({ maxLength: 100 }))
		});

		const shapes = collectShapes([Simple]);

		expect(shapes).toHaveLength(1);
		expect(shapes[0]).toBe(Simple);

	});

	it("should collect shapes in top-down inheritance order", async () => {

		function Base() {
			return resource({ class: "http://example.net/Base" }, {
				name: required(string({ maxLength: 100 }))
			});
		}

		function Child() {
			return resource({ extends: Base, class: "http://example.net/Child" }, {
				extra: required(string({ maxLength: 50 }))
			});
		}

		const shapes = collectShapes([Child]);
		const names = shapes.map(s => tableName(s));

		expect(names).toEqual(["base", "child"]);

	});

	it("should handle diamond inheritance without duplicates", async () => {

		function Root() {
			return resource({ class: "http://example.net/Root" }, {
				name: required(string({ maxLength: 100 }))
			});
		}

		function Left() {
			return resource({ extends: Root, class: "http://example.net/Left" }, {
				left: required(string({ maxLength: 50 }))
			});
		}

		function Right() {
			return resource({ extends: Root, class: "http://example.net/Right" }, {
				right: required(string({ maxLength: 50 }))
			});
		}

		function Diamond() {
			return resource({ extends: [Left, Right], class: "http://example.net/Diamond" }, {
				value: required(string({ maxLength: 50 }))
			});
		}

		const shapes = collectShapes([Diamond]);
		const names = shapes.map(s => tableName(s));

		expect(names).toEqual(["root", "left", "right", "diamond"]);

	});

	it("should deduplicate shapes supplied as multiple entry points", async () => {

		function Base() {
			return resource({ class: "http://example.net/Base" }, {
				name: required(string({ maxLength: 100 }))
			});
		}

		function A() {
			return resource({ extends: Base, class: "http://example.net/A" }, {
				a: required(string({ maxLength: 50 }))
			});
		}

		function B() {
			return resource({ extends: Base, class: "http://example.net/B" }, {
				b: required(string({ maxLength: 50 }))
			});
		}

		const shapes = collectShapes([A, B]);
		const names = shapes.map(s => tableName(s));

		expect(names).toEqual(["base", "a", "b"]);

	});

	it("should discover embedded resource shapes through properties", async () => {

		function Parent() {
			return resource({ class: "http://example.net/Parent" }, {
				name: required(string({ maxLength: 100 })),
				items: multiple(Child)
			});
		}

		function Child() {
			return resource({ class: "http://example.net/Child" }, {
				value: required(string({ maxLength: 50 }))
			});
		}

		const shapes = collectShapes([Parent]);
		const names = shapes.map(s => tableName(s));

		expect(names).toEqual(["parent", "child"]);

	});

	it("should discover referenced shapes through reference properties", async () => {

		function Owner() {
			return resource({ class: "http://example.net/Owner" }, {
				name: required(string({ maxLength: 100 })),
				target: required(reference(Target))
			});
		}

		function Target() {
			return resource({ class: "http://example.net/Target" }, {
				label: required(string({ maxLength: 50 }))
			});
		}

		const shapes = collectShapes([Owner]);
		const names = shapes.map(s => tableName(s));

		expect(names).toEqual(["owner", "target"]);

	});

	it("should discover shapes through union variants", async () => {

		function Container() {
			return resource({ class: "http://example.net/Container" }, {
				value: required(union({
					text: string({ maxLength: 500 }),
					structured: Nested
				}))
			});
		}

		function Nested() {
			return resource({ class: "http://example.net/Nested" }, {
				field: required(string({ maxLength: 100 }))
			});
		}

		const shapes = collectShapes([Container]);
		const names = shapes.map(s => tableName(s));

		expect(names).toEqual(["container", "nested"]);

	});

	it("should collect toys shapes from Category, Vendor, Product entry points", async () => {

		const shapes = collectShapes([Category, Vendor, Product]);

		// base shapes first, then concrete in discovery order, then nested/referenced

		expect(shapes).toEqual([
			resource(Entity),
			resource(Resource),
			resource(Category),
			resource(Vendor),
			resource(PostalAddress),
			resource(Product),
			resource(Review)
		]);

	});

});


describe("describeTables", () => {

	const tables = describeTables(collectShapes([Category, Vendor, Product]));

	function table(name: string): TableDescriptor {
		const found = tables.find(t => t.name === name);
		if ( !found ) { throw new Error(`table <${name}> not found`); }
		return found;
	}

	function columns(name: string): readonly ColumnDescriptor[] {
		return table(name).columns;
	}

	function primaryKey(name: string): readonly string[] {
		return table(name).primaryKey;
	}


	it("should produce all expected tables", async () => {
		expect(tables.map(t => t.name)).toEqual([
			"entity",
			"entity_label",
			"entity_comment",
			"resource",
			"category",
			"category_title",
			"category_description",
			"vendor",
			"postal_address",
			"product",
			"product_name",
			"product_description",
			"product_images",
			"product_keywords",
			"product_categories",
			"review",
			"review_content"
		]);
	});


	describe("entity", () => {

		it("should have identity primary key", async () => {
			expect(columns("entity")).toEqual([
				{ name: "@", type: "INTEGER", identity: true, nullable: false }
			]);
		});

		it("should have single-column primary key", async () => {
			expect(primaryKey("entity")).toEqual(["@"]);
		});

	});

	describe("entity_label", () => {

		it("should have owner FK, lang, and value columns", async () => {
			expect(columns("entity_label")).toEqual([
				{ name: "entity", type: "INTEGER", nullable: false, references: { table: "entity", cascade: true } },
				{ name: "lang", type: "VARCHAR(10)", nullable: false },
				{ name: "value", type: "VARCHAR(80)", nullable: false }
			]);
		});

		it("should have composite primary key", async () => {
			expect(primaryKey("entity_label")).toEqual(["entity", "lang"]);
		});

	});

	describe("entity_comment", () => {

		it("should have owner FK, lang, and value columns", async () => {
			expect(columns("entity_comment")).toEqual([
				{ name: "entity", type: "INTEGER", nullable: false, references: { table: "entity", cascade: true } },
				{ name: "lang", type: "VARCHAR(10)", nullable: false },
				{ name: "value", type: "VARCHAR(500)", nullable: false }
			]);
		});

		it("should have composite primary key", async () => {
			expect(primaryKey("entity_comment")).toEqual(["entity", "lang"]);
		});

	});

	describe("resource", () => {

		it("should have PK referencing entity and own columns", async () => {
			expect(columns("resource")).toEqual([
				{ name: "@", type: "INTEGER", nullable: false, references: { table: "entity", cascade: true } },
				{ name: "id", type: "VARCHAR(2000)", nullable: false, unique: true },
				{ name: "type", type: "CLOB", nullable: false },
				{ name: "created", type: "TIMESTAMP WITH TIME ZONE", nullable: false },
				{ name: "updated", type: "TIMESTAMP WITH TIME ZONE", nullable: true }
			]);
		});

		it("should have single-column primary key", async () => {
			expect(primaryKey("resource")).toEqual(["@"]);
		});

	});

	describe("category", () => {

		it("should have PK referencing resource and own columns only", async () => {
			expect(columns("category")).toEqual([
				{ name: "@", type: "INTEGER", nullable: false, references: { table: "resource", cascade: true } },
				{ name: "featured", type: "BOOLEAN", nullable: false },
				{ name: "code", type: "CLOB", nullable: false },
				{ name: "parent", type: "INTEGER", nullable: true, references: { table: "category", cascade: false } }
			]);
		});

		it("should have single-column primary key", async () => {
			expect(primaryKey("category")).toEqual(["@"]);
		});

	});

	describe("category_title", () => {

		it("should have owner FK, lang, and value columns", async () => {
			expect(columns("category_title")).toEqual([
				{ name: "category", type: "INTEGER", nullable: false, references: { table: "category", cascade: true } },
				{ name: "lang", type: "VARCHAR(10)", nullable: false },
				{ name: "value", type: "CLOB", nullable: false }
			]);
		});

		it("should have composite primary key", async () => {
			expect(primaryKey("category_title")).toEqual(["category", "lang"]);
		});

	});

	describe("category_description", () => {

		it("should have owner FK, lang, and value columns", async () => {
			expect(columns("category_description")).toEqual([
				{ name: "category", type: "INTEGER", nullable: false, references: { table: "category", cascade: true } },
				{ name: "lang", type: "VARCHAR(10)", nullable: false },
				{ name: "value", type: "VARCHAR(500)", nullable: false }
			]);
		});

		it("should have composite primary key", async () => {
			expect(primaryKey("category_description")).toEqual(["category", "lang"]);
		});

	});

	describe("vendor", () => {

		it("should have PK referencing resource, own columns, and union variant columns", async () => {
			expect(columns("vendor")).toEqual([
				{ name: "@", type: "INTEGER", nullable: false, references: { table: "resource", cascade: true } },
				{ name: "code", type: "CLOB", nullable: false },
				{ name: "name", type: "VARCHAR(200)", nullable: false },
				{ name: "email", type: "VARCHAR(254)", nullable: false },
				{ name: "homepage", type: "VARCHAR(2000)", nullable: false },
				{ name: "founded", type: "SMALLINT", nullable: true },
				{ name: "address_string", type: "VARCHAR(500)", nullable: true },
				{ name: "address_postaladdress", type: "INTEGER", nullable: true, references: { table: "entity", cascade: true } }
			]);
		});

		it("should have single-column primary key", async () => {
			expect(primaryKey("vendor")).toEqual(["@"]);
		});

	});

	describe("postal_address", () => {

		it("should have PK referencing entity and own columns", async () => {
			expect(columns("postal_address")).toEqual([
				{ name: "@", type: "INTEGER", nullable: false, references: { table: "entity", cascade: true } },
				{ name: "street", type: "VARCHAR(200)", nullable: false },
				{ name: "city", type: "VARCHAR(100)", nullable: false },
				{ name: "zip", type: "VARCHAR(20)", nullable: false },
				{ name: "country", type: "VARCHAR(100)", nullable: false }
			]);
		});

		it("should have single-column primary key", async () => {
			expect(primaryKey("postal_address")).toEqual(["@"]);
		});

	});

	describe("product", () => {

		it("should have PK referencing resource and own scalar columns", async () => {
			expect(columns("product")).toEqual([
				{ name: "@", type: "INTEGER", nullable: false, references: { table: "resource", cascade: true } },
				{ name: "sku", type: "CLOB", nullable: false },
				{ name: "homepage", type: "VARCHAR(2000)", nullable: true },
				{ name: "launched", type: "TIMESTAMP WITH TIME ZONE", nullable: true },
				{ name: "warranty", type: "INTERVAL", nullable: true },
				{ name: "condition", type: "CLOB", nullable: false, default: "'new'" },
				{ name: "price", type: "DOUBLE PRECISION", nullable: false },
				{ name: "change", type: "DOUBLE PRECISION", nullable: true },
				{ name: "discount", type: "DOUBLE PRECISION", nullable: true },
				{ name: "stock", type: "BIGINT", nullable: false },
				{ name: "vendor", type: "INTEGER", nullable: false, references: { table: "vendor", cascade: false } }
			]);
		});

		it("should have single-column primary key", async () => {
			expect(primaryKey("product")).toEqual(["@"]);
		});

	});

	describe("product_name", () => {

		it("should have owner FK, lang, and value columns", async () => {
			expect(columns("product_name")).toEqual([
				{ name: "product", type: "INTEGER", nullable: false, references: { table: "product", cascade: true } },
				{ name: "lang", type: "VARCHAR(10)", nullable: false },
				{ name: "value", type: "VARCHAR(200)", nullable: false }
			]);
		});

		it("should have composite primary key", async () => {
			expect(primaryKey("product_name")).toEqual(["product", "lang"]);
		});

	});

	describe("product_description", () => {

		it("should have owner FK, lang, and value columns", async () => {
			expect(columns("product_description")).toEqual([
				{ name: "product", type: "INTEGER", nullable: false, references: { table: "product", cascade: true } },
				{ name: "lang", type: "VARCHAR(10)", nullable: false },
				{ name: "value", type: "VARCHAR(2000)", nullable: false }
			]);
		});

		it("should have composite primary key", async () => {
			expect(primaryKey("product_description")).toEqual(["product", "lang"]);
		});

	});

	describe("product_images", () => {

		it("should have owner FK and value columns", async () => {
			expect(columns("product_images")).toEqual([
				{ name: "product", type: "INTEGER", nullable: false, references: { table: "product", cascade: true } },
				{ name: "value", type: "VARCHAR(2000)", nullable: false }
			]);
		});

		it("should have composite primary key", async () => {
			expect(primaryKey("product_images")).toEqual(["product", "value"]);
		});

	});

	describe("product_keywords", () => {

		it("should have owner FK, lang, and value columns", async () => {
			expect(columns("product_keywords")).toEqual([
				{ name: "product", type: "INTEGER", nullable: false, references: { table: "product", cascade: true } },
				{ name: "lang", type: "VARCHAR(10)", nullable: false },
				{ name: "value", type: "CLOB", nullable: false }
			]);
		});

		it("should have three-column composite primary key", async () => {
			expect(primaryKey("product_keywords")).toEqual(["product", "lang", "value"]);
		});

	});

	describe("product_categories", () => {

		it("should have owner FK and target FK columns", async () => {
			expect(columns("product_categories")).toEqual([
				{ name: "product", type: "INTEGER", nullable: false, references: { table: "product", cascade: true } },
				{ name: "category", type: "INTEGER", nullable: false, references: { table: "category", cascade: false } }
			]);
		});

		it("should have composite primary key", async () => {
			expect(primaryKey("product_categories")).toEqual(["product", "category"]);
		});

	});

	describe("review", () => {

		it("should have PK referencing entity, owner FK, and own columns", async () => {
			expect(columns("review")).toEqual([
				{ name: "@", type: "INTEGER", nullable: false, references: { table: "entity", cascade: true } },
				{ name: "product", type: "INTEGER", nullable: false, references: { table: "product", cascade: true } },
				{ name: "author", type: "VARCHAR(100)", nullable: false },
				{ name: "posted", type: "TIMESTAMP WITH TIME ZONE", nullable: false },
				{ name: "rating", type: "SMALLINT", nullable: false }
			]);
		});

		it("should have single-column primary key", async () => {
			expect(primaryKey("review")).toEqual(["@"]);
		});

	});

	describe("review_content", () => {

		it("should have owner FK, lang, and value columns", async () => {
			expect(columns("review_content")).toEqual([
				{ name: "review", type: "INTEGER", nullable: false, references: { table: "review", cascade: true } },
				{ name: "lang", type: "VARCHAR(10)", nullable: false },
				{ name: "value", type: "VARCHAR(5000)", nullable: false }
			]);
		});

		it("should have composite primary key", async () => {
			expect(primaryKey("review_content")).toEqual(["review", "lang"]);
		});

	});

});


describe("renderSQL", () => {

	describe("identity table", () => {

		it("should render identity PK with quoted @ column", async () => {

			const sql = renderSQL([{
				name: "entity",
				columns: [{ name: "@", type: "INTEGER", identity: true, nullable: false }],
				primaryKey: ["@"]
			}]);

			expect(sql).toBe([
				"create table entity (",
				"    \"@\" integer generated always as identity primary key",
				");"
			].join("\n"));

		});

	});

	describe("foreign key PK", () => {

		it("should render PK referencing parent with cascade", async () => {

			const sql = renderSQL([{
				name: "resource",
				columns: [
					{ name: "@", type: "INTEGER", nullable: false, references: { table: "entity", cascade: true } },
					{ name: "id", type: "VARCHAR(2000)", nullable: false, unique: true }
				],
				primaryKey: ["@"]
			}]);

			expect(sql).toBe([
				"create table resource (",
				"",
				"    \"@\" integer primary key references entity (\"@\") on delete cascade,",
				"",
				"    id varchar(2000) not null unique",
				"",
				");"
			].join("\n"));

		});

	});

	describe("column constraints", () => {

		it("should render not null for non-nullable columns", async () => {

			const sql = renderSQL([{
				name: "test",
				columns: [
					{ name: "@", type: "INTEGER", identity: true, nullable: false },
					{ name: "name", type: "VARCHAR(100)", nullable: false }
				],
				primaryKey: ["@"]
			}]);

			expect(sql).toContain("name varchar(100) not null");

		});

		it("should omit not null for nullable columns", async () => {

			const sql = renderSQL([{
				name: "test",
				columns: [
					{ name: "@", type: "INTEGER", identity: true, nullable: false },
					{ name: "value", type: "VARCHAR(100)", nullable: true }
				],
				primaryKey: ["@"]
			}]);

			expect(sql).toMatch(/value varchar\(100\)\s*$/m);

		});

		it("should render unique constraint", async () => {

			const sql = renderSQL([{
				name: "test",
				columns: [
					{ name: "@", type: "INTEGER", identity: true, nullable: false },
					{ name: "code", type: "VARCHAR(10)", nullable: false, unique: true }
				],
				primaryKey: ["@"]
			}]);

			expect(sql).toContain("code varchar(10) not null unique");

		});

		it("should render default clause", async () => {

			const sql = renderSQL([{
				name: "test",
				columns: [
					{ name: "@", type: "INTEGER", identity: true, nullable: false },
					{ name: "status", type: "CLOB", nullable: false, default: "'active'" }
				],
				primaryKey: ["@"]
			}]);

			expect(sql).toContain("status clob not null default 'active'");

		});

		it("should render foreign key reference without cascade", async () => {

			const sql = renderSQL([{
				name: "test",
				columns: [
					{ name: "@", type: "INTEGER", identity: true, nullable: false },
					{ name: "parent", type: "INTEGER", nullable: true, references: { table: "test", cascade: false } }
				],
				primaryKey: ["@"]
			}]);

			expect(sql).toContain("parent integer references test (\"@\")");
			expect(sql).not.toContain("on delete cascade");

		});

		it("should render foreign key reference with cascade", async () => {

			const sql = renderSQL([{
				name: "test",
				columns: [
					{ name: "@", type: "INTEGER", identity: true, nullable: false },
					{ name: "owner", type: "INTEGER", nullable: false, references: { table: "parent", cascade: true } }
				],
				primaryKey: ["@"]
			}]);

			expect(sql).toContain("owner integer not null references parent (\"@\") on delete cascade");

		});

	});

	describe("composite primary key", () => {

		it("should render separate primary key clause for multi-column PK", async () => {

			const sql = renderSQL([{
				name: "test_label",
				columns: [
					{ name: "test", type: "INTEGER", nullable: false, references: { table: "test", cascade: true } },
					{ name: "lang", type: "VARCHAR(10)", nullable: false },
					{ name: "value", type: "VARCHAR(100)", nullable: false }
				],
				primaryKey: ["test", "lang"]
			}]);

			expect(sql).toBe([
				"create table test_label (",
				"",
				"    test integer not null references test (\"@\") on delete cascade,",
				"",
				"    lang varchar(10) not null,",
				"    value varchar(100) not null,",
				"",
				"    primary key (test, lang)",
				"",
				");"
			].join("\n"));

		});

	});

	describe("multiple tables", () => {

		it("should separate tables with blank lines", async () => {

			const sql = renderSQL([
				{
					name: "a",
					columns: [{ name: "@", type: "INTEGER", identity: true, nullable: false }],
					primaryKey: ["@"]
				},
				{
					name: "b",
					columns: [{ name: "@", type: "INTEGER", identity: true, nullable: false }],
					primaryKey: ["@"]
				}
			]);

			expect(sql).toBe([
				"create table a (",
				"    \"@\" integer generated always as identity primary key",
				");",
				"",
				"create table b (",
				"    \"@\" integer generated always as identity primary key",
				");"
			].join("\n"));

		});

	});

});
