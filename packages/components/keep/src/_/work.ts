/*
 * Copyright © 2026 Metreeca srl
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

import type { ResourceShape } from "@metreeca/blue/resource";
import { error, type Lazy, type Optional } from "@metreeca/core";
import type { StoreScope } from "@metreeca/keep";
import type { Reference } from "@metreeca/qest/state";
import {
	as, by, compile, count, type Delivery, from, gte, limit, max, type Model, order, some, where
} from "./dsl.js";
import { base, Product, Vendor } from "./toys.js";


const store: Store = error("!!!");


interface Store {

	select<

		S extends Lazy<ResourceShape>,
		M extends Model<S>

	>(request: Select<S, M>, scope?: StoreScope): Promise<

		readonly Delivery<S, M>[]

	>

	lookup<

		S extends Lazy<ResourceShape>,
		M extends Model<S>

	>(request: Lookup<S, M>, scope?: StoreScope): Promise<

		Optional<Delivery<S, M>>

	>

}


// The shape and the model travel together, so the datum is resolved from the pair rather than carried alongside it.

export type Select<S extends Lazy<ResourceShape>, M extends Model<S>> = {

	readonly shape: S
	readonly model: M

}

export type Lookup<S extends Lazy<ResourceShape>, M extends Model<S>> = {

	readonly entry: Reference
	readonly shape: S
	readonly model: M

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

await store.lookup(from(Vendor, `${base}vendors/1234`, vendor => as({

	code: vendor.code

})));

await store.select(from(Vendor, vendor => as({

	id: vendor.id,
	code: vendor.code

}, where(
	some(vendor.homepage, "https://example.net/toys"),
	limit(100)
))));

await store.select(from(Product, product => as({

	id: product.id,

	name: product.name.at("en", "fi"),

	vendor: product.vendor.select(vendor => ({

		id: vendor.id,
		label: vendor.label

	})),

	categories: product.categories.select(category => as({

		id: category.id,
		label: category.label

	}, where(
		order(category.label),
		limit(10)
	)))

}, where(
	gte(product.launched, "2026-01-01"),
	order(product.launched, "desc")
))));


//// Grouping /////////////////////////////////////////////////////////////////////////////////////////////////////////

await store.select(from(Product, product => by({

	vendor: product.vendor.label,
	category: product.categories.label,

	products: count(product.id),
	latest: max(product.launched)

}, where(
	gte(product.launched, "2026-01-01"),
	order(product.launched, "desc")
))));


//// Decoding /////////////////////////////////////////////////////////////////////////////////////////////////////////

await store.select(from(Product, compile(Product, JSON.parse(`{

	"id": {},
	"?vendor": "${base}vendors/1234"

}`))));
