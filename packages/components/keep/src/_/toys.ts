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

/**
 * Toy catalogue sample shapes.
 *
 * Provides the shapes the retrieval sketch is written against, cut down from the `@metreeca/keep-suite` dataset of the
 * same name to the members the sketch exercises: localised text, plain literals, a single link and a repeatable one.
 * Declared here rather than imported, so that the sketch stays inside the package it is sketching.
 *
 * @module
 */

import { dictionary } from "@metreeca/blue/dictionary";
import { decimal } from "@metreeca/blue/number";
import { reference } from "@metreeca/blue/reference";
import { id, nonempty, optional, required, resource, type } from "@metreeca/blue/resource";
import { date, string, url } from "@metreeca/blue/string";
import { union } from "@metreeca/blue/union";
import { createNamespace } from "@metreeca/core/resource";


/**
 * Base URL for the toy catalogue sample.
 */
export const base = "https://data.example.net/";

/**
 * Namespace for the toy catalogue terms.
 */
export const toys = createNamespace(`${base}toys#`, [

	// Classes

	"Category",
	"Vendor",
	"PostalAddress",
	"Place",
	"Product",

	// Shared

	"label",
	"code",
	"homepage",
	"address",

	// Category

	"broader",
	"narrower",

	// Product

	"sku",
	"name",
	"launched",
	"price",
	"vendor",
	"products",
	"categories"

]);

/**
 * Supported content languages.
 */
export const languages = [
	"en", "de", "fr", "it"
] as const;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Hierarchical product classification with localised labels.
 *
 * Self-referential `broader` link, so that a traversal reaching one category may carry on to the next.
 */
export function Category() {
	return resource({

		space: toys,
		class: toys.Category,

		pattern: "/categories/{code}"

	}, {

		id: id(),
		type: type(),

		label: required(dictionary({ uniqueLang: true, languageIn: languages })),
		code: required(string({ pattern: /^\d{4}$/ })),

		broader: optional(reference(Category), { forward: toys.broader, reverse: toys.narrower })

	});
}

/**
 * Product supplier.
 *
 * Target of the {@link Product} `vendor` link, so that a retrieval may expand a product's supplier or bind a path
 * reaching through it.
 */
export function Vendor() {
	return resource({

		space: toys,
		class: toys.Vendor,

		pattern: "/vendors/{code}"

	}, {

		id: id(),
		type: type(),

		label: required(dictionary({ uniqueLang: true, languageIn: languages })),
		code: required(string({ pattern: /^\d{4}$/ })),

		homepage: optional(url),
		address: optional(Address)

	});
}

/**
 * Location union for the {@link Vendor} `address`: a structured {@link PostalAddress} or a geolocated {@link Place}.
 *
 * Both branches declare `label`, so a path reaching through the union has a member every branch carries, which is what
 * the sketch's open point on unions turns on.
 */
export function Address() {
	return union(
		PostalAddress,
		Place
	);
}

/**
 * Structured postal address for vendor locations.
 */
export function PostalAddress() {
	return resource({

		space: toys,
		class: toys.PostalAddress

	}, {

		label: required(dictionary({ uniqueLang: true, languageIn: languages })),

		city: required(string({ maxLength: 100 })),
		country: required(string({ maxLength: 100 }))

	});
}

/**
 * Geolocated place for vendor locations.
 */
export function Place() {
	return resource({

		space: toys,
		class: toys.Place

	}, {

		label: required(dictionary({ uniqueLang: true, languageIn: languages })),

		latitude: required(decimal({ minInclusive: -90, maxInclusive: 90 })),
		longitude: required(decimal({ minInclusive: -180, maxInclusive: 180 }))

	});
}

/**
 * Purchasable item with localised naming, a supplier and repeatable classifications.
 *
 * Carries the members the sketch retrieves: `name` as localised text, `launched` and `price` as ordered literals,
 * `vendor` as a single link and `categories` as a repeatable one.
 */
export function Product() {
	return resource({

		space: toys,
		class: toys.Product,

		pattern: "/products/{sku}"

	}, {

		id: id(),
		type: type(),

		sku: required(string({ pattern: /^[A-Z0-9-]+$/ })),
		name: required(dictionary({ uniqueLang: true, languageIn: languages })),

		launched: required(date),
		price: required(decimal({ minExclusive: 0 })),

		vendor: required(reference(Vendor), { forward: toys.vendor, reverse: toys.products }),
		categories: nonempty(reference(Category))

	});
}
