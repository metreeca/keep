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
 * Toy catalogue sample dataset.
 *
 * Provides the resource shapes and sample data that the conformance suite runs store implementations against. The
 * dataset balances size with feature coverage, exercising cardinality variants, data types, structural patterns and
 * query operations.
 *
 * The dataset contains **62 products**, **11 categories** and **5 vendors**, plus a small **media**
 * pool (image and video resources) wired to one product's `media` gallery.
 *
 * **Categories**
 *
 * 11 categories organised in a three-level hierarchy with uneven depth. Four root categories branch into subcategories,
 * with some branches reaching depth 3 and others stopping at depth 1 or 2.
 *
 * @module toys
 */

import { boolean } from "@metreeca/blue/boolean";
import { dictionary } from "@metreeca/blue/dictionary";
import { byte, decimal, integer } from "@metreeca/blue/number";
import { reference } from "@metreeca/blue/reference";
import {
	id,
	multiple,
	nonempty,
	optional,
	property,
	required,
	resource,
	type ResourceShape,
	type
} from "@metreeca/blue/resource";
import { date, duration, email, instant, phone, string, time, timestamp, url, year } from "@metreeca/blue/string";
import { union } from "@metreeca/blue/union";
import type { Lazy } from "@metreeca/core";
import { createNamespace } from "@metreeca/core/resource";

export { catalogues, collections, identify, clone } from "./toys.core.js";


/**
 * Base URL for the toys sample dataset.
 */
export const base = "https://data.example.net/";

/**
 * Namespace for domain-specific terms in the toy catalogue.
 */
export const toys = createNamespace(`${base}toys#`, [

	// Classes

	"Entity",
	"Resource",
	"Collection",
	"Category",
	"Vendor",
	"PostalAddress",
	"Place",
	"Product",
	"Image",
	"Video",
	"Review",

	// Resource

	"created",
	"updated",

	// Shared

	"code",
	"name",
	"title",
	"description",
	"homepage",

	// Category

	"featured",
	"broader",
	"narrower",
	"upper",

	// Vendor

	"email",
	"founded",
	"opens",
	"address",
	"contacts",
	"products",
	"aliases",
	"score",
	"certified",
	"audited",
	"origin",

	// PostalAddress

	"street",
	"city",
	"zip",
	"country",

	// Place

	"latitude",
	"longitude",
	"opened",

	// Product

	"sku",
	"documents",
	"launched",
	"warranty",
	"condition",
	"price",
	"change",
	"discount",
	"stock",
	"keywords",
	"reviews",
	"vendor",
	"category",
	"categories",
	"product",

	// Review

	"author",
	"posted",
	"rating",
	"content",

	// Media

	"media",
	"url",
	"width",
	"height",
	"duration",
	"subject",
	"caption"

]);

/**
 * Namespace for RDF Schema terms used for labelling and membership.
 */
export const rdfs = createNamespace("http://www.w3.org/2000/01/rdf-schema#", [

	"label",
	"comment",

	"member"

]);


/**
 * Supported content languages.
 */
export const languages = [
	"en", "de", "fr", "it"
] as const;


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Shared localised labelling for all resources.
 *
 * Provides multilingual `label` and `comment` properties constrained to {@link languages}, with `label` also
 * admitting the language-neutral `und` tag.
 */
export function Entity() {
	return resource({

		space: toys,
		class: toys.Entity

	}, {

		label: required(dictionary({

			uniqueLang: true,
			languageIn: ["und", ...languages],

			minLength: 1,
			maxLength: 80

		}), {

			forward: rdfs.label

		}),

		comment: optional(dictionary({

			uniqueLang: true,
			languageIn: languages,

			minLength: 10,
			maxLength: 500

		}), {

			forward: rdfs.comment

		})

	});
}

/**
 * Collection holding the resources of a given entity type as its members.
 *
 * @param member - The resource shape factory for collection members
 */
export function Catalogue<M extends Lazy<ResourceShape>>(member: M) {
	return resource(Resource, {

		class: toys.Collection

	}, {

		members: multiple(reference(member), { forward: rdfs.member })

	});
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Collection endpoint for all {@link Resource} instances.
 *
 * Members anchor on the supertype class {@link Resource}, so the collection spans every `Resource` subtype
 * ({@link Category}, {@link Vendor}, {@link Product}, {@link Image}, {@link Video}) and exercises subtype matching.
 */
export function Resources() {
	return resource(Catalogue(Resource), {

		class: toys.Collection

	}, {

		label: required(dictionary({ uniqueLang: true, languageIn: languages }))

	});
}

/**
 * Base shape for all domain resources.
 *
 * Provides identity, type classification, and audit timestamps.
 */
export function Resource() {
	return resource(Entity, {

		class: toys.Resource

	}, {

		id: id(),
		type: type(),

		created: required(timestamp, { hidden: true }),
		updated: optional(timestamp, { hidden: true })

	});
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Collection endpoint for {@link Category} resources.
 */
export function Categories() {
	return resource(Catalogue(Category), {

		class: toys.Collection

	}, {

		label: required(dictionary({ uniqueLang: true, languageIn: languages }))

	});
}

/**
 * Hierarchical product classification with localised labels.
 *
 * The `broader` link to the parent category also writes the inverse `narrower` link, which the foreign `narrower`
 * property exposes as a read-only view. The `upper` link writes no inverse, and the foreign `lower` property reads it
 * in the reverse direction.
 */
export function Category() {
	return resource(Resource, {

		class: toys.Category,

		pattern: "/categories/{code}"

	}, {

		label: required(dictionary({ uniqueLang: true })),
		comment: optional(dictionary({ uniqueLang: true })),

		featured: required(boolean),

		code: required(string({ pattern: /^\d{4}$/ })),
		title: required(dictionary({ uniqueLang: true, languageIn: languages })),
		description: optional(dictionary({ uniqueLang: true, languageIn: languages, minLength: 10, maxLength: 500 })),

		// bidirectional linking

		broader: optional(reference(Category), { forward: toys.broader, reverse: toys.narrower }),
		narrower: multiple(reference(Category), { foreign: true }),

		// monodirectional linking

		upper: optional(reference(Category)),
		lower: multiple(reference(Category), { foreign: true, reverse: toys.upper })

	});
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Collection endpoint for {@link Vendor} resources.
 */
export function Vendors() {
	return resource(Catalogue(Vendor), {

		class: toys.Collection

	}, {

		label: required(dictionary({ uniqueLang: true, languageIn: languages }))

	});
}

/**
 * Product suppliers with contact information and certification records.
 *
 * The foreign `products` property provides read-only access to the products referencing the vendor, and its
 * captive flag cascade-deletes them with the vendor.
 */
export function Vendor() {
	return resource(Resource, {

		class: toys.Vendor,

		pattern: "/vendors/{code}"

	}, {

		label: required(dictionary({
			uniqueLang: true,
			languageIn: ["und", ...languages],
			minLength: 1,
			maxLength: 80
		})),

		code: required(string({ pattern: /^\d{4}$/ })),
		name: required(string({ minLength: 1, maxLength: 200 })),
		aliases: multiple(string),

		email: required(email),
		homepage: required(url),

		founded: optional(year),
		opens: optional(time),

		score: optional(Score),
		certified: optional(Certified),
		audited: optional(union(boolean, date)),
		origin: optional(Origin),

		address: optional(Address),
		contacts: multiple(Contacts),

		products: multiple(reference(Product), { foreign: true, captive: true })

	});
}

/**
 * Rating union for `Vendor.score`: a bounded decimal rating or a letter-grade string.
 *
 * The decimal and string variants are storage-class disjoint, so a stored value singles out its branch by
 * datatype alone (§3.3).
 */
export function Score() {
	return union(
		decimal({ minInclusive: 0, maxInclusive: 5 }),
		string({ pattern: /^[A-F]$/ })
	);
}

/**
 * Certification union for `Vendor.certified`: a boolean flag, a bounded decimal rating, a letter-grade string,
 * or a gYear.
 *
 * Spans the `xsd:boolean`, `numeric` and `xsd:string` tiers of the §5.7.5 sort order: a gYear is not a processing
 * type, so it ranks as an opaque `xsd:string` (§3). The grade pattern keeps the string variant lexically disjoint
 * from the gYear variant, so every value singles out exactly one branch (§3.3).
 */
export function Certified() {
	return union(
		boolean,
		decimal({ minInclusive: 0, maxInclusive: 5 }),
		string({ pattern: /^[A-F]$/ }),
		year
	);
}

/**
 * Provenance union for `Vendor.origin`: a localised region name or a geolocated {@link Place}.
 *
 * The text variant is told apart from the node variant by wire form, a dictionary matching it and no other variant
 * (§3.1). Folding leaves a string and a node branch, so the property stays union-typed for retrieval (§5.5): a template
 * reaches the region name through an atomic alternative as its coalesced label, and only a projection binding reaches it
 * structurally, through a locale alternative.
 */
export function Origin() {
	return union(
		dictionary({ uniqueLang: true, languageIn: languages }),
		Place
	);
}

/**
 * Location union for `Vendor.address`: a plain string, a structured {@link PostalAddress}, or a geolocated
 * {@link Place}.
 *
 * The literal variant is storage-class disjoint from the two node variants, which are in turn structurally
 * disjoint from each other, so a stored value singles out its branch by datatype or structure (§3.3).
 */
export function Address() {
	return union(
		string({ maxLength: 500 }),
		PostalAddress,
		Place
	);
}

/**
 * Structured postal address for vendor locations.
 *
 * Embedded resource used as a union variant for `Vendor.address` and `Vendor.contacts`,
 * structurally disjoint from its sibling {@link Place} variant.
 */
export function PostalAddress() {
	return resource(Entity, {

		class: toys.PostalAddress

	}, {

		label: required(dictionary({
			uniqueLang: true,
			languageIn: ["und", ...languages],
			minLength: 1,
			maxLength: 80
		})),

		street: required(string({ maxLength: 200 })),
		city: required(string({ maxLength: 100 })),
		zip: required(string({ maxLength: 20 })),
		country: required(string({ maxLength: 100 }))

	});
}

/**
 * Geolocated place for vendor locations, after the schema.org `Place` modelling.
 *
 * Embedded resource used as a union variant for `Vendor.address`, `Vendor.contacts` and `Vendor.origin`,
 * structurally disjoint from its sibling {@link PostalAddress} variant.
 */
export function Place() {
	return resource(Entity, {

		class: toys.Place

	}, {

		label: required(dictionary({
			uniqueLang: true,
			languageIn: ["und", ...languages],
			minLength: 1,
			maxLength: 80
		})),

		latitude: required(decimal({ minInclusive: -90, maxInclusive: 90 })),
		longitude: required(decimal({ minInclusive: -180, maxInclusive: 180 })),

		opened: optional(date)

	});
}

/**
 * Contact union for `Vendor.contacts`: an `email` or `phone` string, a structured {@link PostalAddress}, or a
 * geolocated {@link Place}.
 *
 * The email and phone variants share the string storage class but carry disjoint patterns; the two node
 * variants are structurally disjoint, so each value singles out exactly one branch (§3.3).
 */
export function Contacts() {
	return union(
		email,
		phone,
		PostalAddress,
		Place
	);
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Collection endpoint for {@link Product} resources.
 */
export function Products() {
	return resource(Catalogue(Product), {

		class: toys.Collection

	}, {

		label: required(dictionary({ uniqueLang: true, languageIn: languages }))

	});
}

/**
 * Purchasable item with pricing, inventory, and media.
 *
 * Includes structured `reviews`, a required {@link Vendor} reference, and repeatable {@link Category} classifications.
 */
export function Product() {
	return resource(Resource, {

		class: toys.Product,

		pattern: "/products/{sku}"

	}, {

		label: required(dictionary({ uniqueLang: true })),
		comment: optional(dictionary({ uniqueLang: true })),

		sku: required(string({ pattern: /^[A-Z0-9-]+$/ })),
		name: required(dictionary({ uniqueLang: true, languageIn: languages, minLength: 1, maxLength: 200 })),
		description: optional(dictionary({ uniqueLang: true, languageIn: languages, minLength: 10, maxLength: 2000 })),
		keywords: multiple(dictionary({ languageIn: languages })),

		homepage: optional(url),
		launched: optional(date),
		warranty: optional(duration),
		documents: property(url, { minCount: 1, maxCount: 5 }),

		condition: required(string({ in: ["new", "used", "refurbished"] })),
		price: required(decimal({ minExclusive: 0 })),
		change: optional(decimal),
		discount: optional(decimal({ maxExclusive: 0 })),
		stock: required(integer), // 0: not available; < 0: more coming

		vendor: required(reference(Vendor), { forward: toys.vendor, reverse: toys.products }),
		categories: nonempty(reference(Category)),

		media: multiple(Media, { captive: true }),
		reviews: multiple(Review)

	});
}

/**
 * Media union for `Product.media`: a captive {@link Image} or {@link Video} reference.
 *
 * Both variants share the reference storage class but carry disjoint IRI patterns, so a stored reference
 * singles out its branch by target-identifier pattern (§3.3). The declaring {@link Product} `media` property
 * marks them captive, so they are cascade-deleted with the owning product.
 */
export function Media() {
	return union(
		reference(Image),
		reference(Video)
	);
}

/**
 * Image media resource.
 *
 * A reference variant of the {@link Product} `media` gallery union, discriminated from its sibling
 * {@link Video} variant by a disjoint IRI `pattern` (`/media/images/{code}` versus `/media/videos/{code}`).
 * Its `subject` reaches a {@link Product}, diverging from `Video.subject` (a {@link Category}) under the
 * shared `subject` predicate.
 */
export function Image() {
	return resource(Resource, {

		class: toys.Image,

		pattern: "/media/images/{code}"

	}, {

		label: required(dictionary({
			uniqueLang: true,
			languageIn: ["und", ...languages],
			minLength: 1,
			maxLength: 80
		})),

		url: required(url),
		width: required(integer),
		height: required(integer),

		// `caption` is a plain string here but a localised text on the sibling Video variant, so a path
		// crossing the Media union (`media.caption`) resolves to a heterogeneous `[string, dictionary]` range —
		// the range-level string/dictionary mix a declared property cannot express (blue `Range` note)

		caption: optional(string({ maxLength: 200 })),
		subject: optional(reference(Product))

	});
}

/**
 * Video media resource.
 *
 * A reference variant of the {@link Product} `media` gallery union, discriminated from its sibling
 * {@link Image} variant by a disjoint IRI `pattern` (`/media/videos/{code}` versus `/media/images/{code}`).
 * Its `subject` reaches a {@link Category}, diverging from `Image.subject` (a {@link Product}) under the
 * shared `subject` predicate.
 */
export function Video() {
	return resource(Resource, {

		class: toys.Video,

		pattern: "/media/videos/{code}"

	}, {

		label: required(dictionary({
			uniqueLang: true,
			languageIn: ["und", ...languages],
			minLength: 1,
			maxLength: 80
		})),

		url: required(url),
		duration: required(duration),

		// localised counterpart of the plain-string `Image.caption`, diverging string vs dictionary under the
		// shared `caption` predicate so `media.caption` reaches both kinds across the Media union

		caption: optional(dictionary({ uniqueLang: true, languageIn: languages })),
		subject: optional(reference(Category))

	});
}

/**
 * Individual product review with timestamped content.
 *
 * Embedded resource within {@link Product} capturing author, rating, and localised review text.
 */
export function Review() {
	return resource(Entity, {

		class: toys.Review

	}, {

		label: required(dictionary({
			uniqueLang: true,
			languageIn: ["und", ...languages],
			minLength: 1,
			maxLength: 80
		})),

		comment: optional(dictionary({ uniqueLang: true })),

		author: required(string({ minLength: 1, maxLength: 100 })),
		posted: required(instant),

		rating: required(byte({ minInclusive: 1, maxInclusive: 5 })),
		content: required(dictionary({ uniqueLang: true, languageIn: languages, minLength: 10, maxLength: 5000 }))

	});
}
