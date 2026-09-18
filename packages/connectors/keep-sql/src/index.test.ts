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

import { PGlite } from "@electric-sql/pglite";
import { resource, type ResourceShape } from "@metreeca/blue/resource";
import type { Lazy } from "@metreeca/core";
import { immutable } from "@metreeca/core/nested";
import type { Resource } from "@metreeca/qest/state";
import { log } from "@metreeca/tape";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe } from "vitest";
import { testTxnStore } from "../../../suites/index.js";
import { base, toys } from "../../../suites/toys.js";
import { createPGliteStore } from "./index.js";


const schema = readFileSync(new URL("./index.test.ddl", import.meta.url), "utf-8");
const data = readFileSync(new URL("./index.test.sql", import.meta.url), "utf-8");


log({
	".": "debug",
});


describe("pglite", () => testTxnStore((() => {

	let db: PGlite;

	return immutable({

		match: "RetrieveModel",

		build,
		clone,
		reset,
		close

	});


	async function build() {
		db = new PGlite("memory://");
		await db.exec(schema);
		return createPGliteStore(db);
	}

	async function clone<T>(r: Resource, shape: Lazy<ResourceShape & { model: T }>): Promise<T> {

		const resolved = resource(shape);
		const clazz = resolved.class ?? "";

		if ( clazz !== toys.Product ) {
			throw new Error(`unsupported shape class <${clazz}>`);
		}

		const rec = r as Record<string, unknown>;
		const uid = randomUUID().slice(0, 8);

		const sku = `CLONE-${uid.toUpperCase()}`;
		const id = `${base}products/${sku}`;
		const type = clazz;
		const now = new Date().toISOString();

		const vendorRef = rec.vendor as Record<string, unknown> | string | undefined;
		const vendorId = typeof vendorRef === "string" ? vendorRef : vendorRef?.id as string | undefined;
		const categoryIds = ((rec.categories as (Record<string, unknown> | string)[]) ?? [])
			.map(c => typeof c === "string" ? c : c.id as string);

		await db.query(`

			WITH

			-- product entity + resource

			product_entity AS (
				INSERT INTO entity DEFAULT VALUES RETURNING "@" AS key
			),

			product_resource AS (
				INSERT INTO resource ("@", id, type, created, updated)
				SELECT key, $1, $2, $3::timestamptz, NULL
				FROM product_entity
			),

			entity_labels_ins AS (
				INSERT INTO entity_label (entity, lang, value)
				SELECT pe.key, kv.key, kv.value
				FROM product_entity pe, jsonb_each_text($19::jsonb) kv
			),

			entity_comments_ins AS (
				INSERT INTO entity_comment (entity, lang, value)
				SELECT pe.key, kv.key, kv.value
				FROM product_entity pe, jsonb_each_text($20::jsonb) kv
			),

			-- product

			product_insert AS (
				INSERT INTO product ("@", sku, homepage, launched, warranty,
					condition, price, change, discount, stock, vendor)
				SELECT key, $4, $5, $6::timestamptz, $7::interval, $8,
					$9::float8, $10::float8, $11::float8, $12::bigint,
					(SELECT "@" FROM resource WHERE id = $13)
				FROM product_entity
			),

			-- product i18n / multivalued

			product_names AS (
				INSERT INTO product_name (product, lang, value)
				SELECT pe.key, kv.key, kv.value
				FROM product_entity pe, jsonb_each_text($14::jsonb) kv
			),

			product_descriptions AS (
				INSERT INTO product_description (product, lang, value)
				SELECT pe.key, kv.key, kv.value
				FROM product_entity pe, jsonb_each_text($15::jsonb) kv
			),

			product_images_ins AS (
				INSERT INTO product_images (product, url)
				SELECT pe.key, el.value
				FROM product_entity pe, jsonb_array_elements_text($16::jsonb) el
			),

			product_keywords_ins AS (
				INSERT INTO product_keywords (product, lang, value)
				SELECT pe.key, kv.key, arr.value
				FROM product_entity pe,
					jsonb_each($17::jsonb) kv,
					jsonb_array_elements_text(kv.value) arr
			),

			product_categories_ins AS (
				INSERT INTO product_categories (product, category)
				SELECT pe.key, r."@"
				FROM product_entity pe,
					jsonb_array_elements_text($18::jsonb) el
				JOIN resource r ON r.id = el.value
			),

			-- reviews

			review_entities AS (
				INSERT INTO entity
				SELECT FROM jsonb_array_elements($21::jsonb)
				RETURNING "@" AS key
			),

			review_indexed AS (
				SELECT key, row_number() OVER (ORDER BY key) AS idx
				FROM review_entities
			),

			reviews_data AS (
				SELECT elem.value AS review, elem.ordinality AS idx
				FROM jsonb_array_elements($21::jsonb) WITH ORDINALITY AS elem
			),

			review_insert AS (
				INSERT INTO review ("@", product, author, posted, rating)
				SELECT ri.key, pe.key,
					rd.review->>'author',
					(rd.review->>'posted')::timestamptz,
					(rd.review->>'rating')::smallint
				FROM review_indexed ri
				JOIN reviews_data rd ON ri.idx = rd.idx
				CROSS JOIN product_entity pe
			),

			review_contents_ins AS (
				INSERT INTO review_content (review, lang, value)
				SELECT ri.key, kv.key, kv.value
				FROM review_indexed ri
				JOIN reviews_data rd ON ri.idx = rd.idx,
					jsonb_each_text(coalesce(rd.review->'content', '{}'::jsonb)) kv
			),

			review_labels_ins AS (
				INSERT INTO entity_label (entity, lang, value)
				SELECT ri.key, kv.key, kv.value
				FROM review_indexed ri
				JOIN reviews_data rd ON ri.idx = rd.idx,
					jsonb_each_text(coalesce(rd.review->'label', '{}'::jsonb)) kv
			),

			review_comments_ins AS (
				INSERT INTO entity_comment (entity, lang, value)
				SELECT ri.key, kv.key, kv.value
				FROM review_indexed ri
				JOIN reviews_data rd ON ri.idx = rd.idx,
					jsonb_each_text(coalesce(rd.review->'comment', '{}'::jsonb)) kv
			)

			SELECT key FROM product_entity

		`, [
			id, type, now,                                                   // $1-$3
			sku, rec.homepage ?? null,                                       // $4-$5
			rec.launched ? `${rec.launched}T00:00:00Z` : null,               // $6
			rec.warranty ?? null,                                            // $7
			rec.condition ?? "new",                                          // $8
			rec.price, rec.change ?? null, rec.discount ?? null, rec.stock,  // $9-$12
			vendorId ?? null,                                                // $13
			JSON.stringify(rec.name ?? {}),                                  // $14
			JSON.stringify(rec.description ?? {}),                           // $15
			JSON.stringify(rec.images ?? []),                                // $16
			JSON.stringify(rec.keywords ?? {}),                              // $17
			JSON.stringify(categoryIds),                                     // $18
			JSON.stringify(i18n(rec.label)),                                 // $19
			JSON.stringify(i18n(rec.comment)),                               // $20
			JSON.stringify(((rec.reviews as Record<string, unknown>[]) ?? []).map(review => ({   // $21
				author: review.author,
				posted: review.posted,
				rating: review.rating,
				content: review.content ?? {},
				label: i18n(review.label),
				comment: i18n(review.comment),
			}))),
		]);

		return {
			...r,
			id,
			type,
			sku,
			created: now,
			updated: undefined,
			vendor: vendorId ?? null,
			categories: categoryIds,
		} as Record<string, unknown> as T;

		function i18n(value: unknown): Record<string, string> {
			if ( typeof value === "string" ) {
				return { und: value };
			} else if ( value && typeof value === "object" ) {
				return value as Record<string, string>;
			} else {
				return {};
			}
		}

	}

	async function reset() {
		await db.exec("TRUNCATE entity CASCADE");
		await db.exec(data);
	}

	async function close() {
		await db.close();
	}

})()));
