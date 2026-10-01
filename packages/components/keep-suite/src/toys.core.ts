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

import { validate } from "@metreeca/blue";
import { getShapeId, type ResourceShape } from "@metreeca/blue/resource";
import { eager, type State } from "@metreeca/blue/value";
import { error, isString, type Lazy, map, type Optional } from "@metreeca/core";
import { getIRIParent } from "@metreeca/core/resource";
import { immutable } from "@metreeca/core/values";
import { TraceError } from "@metreeca/core/trace";
import type { StoreClient } from "@metreeca/keep";
import { isReference, type Reference, type Resource } from "@metreeca/qest/state";
import {
	base,
	Categories,
	Category,
	Image,
	Product,
	Products,
	Resources,
	toys,
	Vendor,
	Vendors,
	Video
} from "./toys.js";
import json from "./toys.json" with { type: "json" };


/**
 * Resource collections from the toys sample dataset, validated with `value` scope.
 *
 * Each getter resolves lazily on first access, so importing this object runs no validation at module load — eager
 * evaluation would re-enter `toys.ts` before its `toys` namespace constant is initialised, since the shape factories
 * read `toys.<class>` at materialisation time. The validated set is built once on first access and shared across
 * every getter.
 */
export const collections: {

	readonly categories: readonly State<typeof Category>[];
	readonly vendors: readonly State<typeof Vendor>[];
	readonly products: readonly State<typeof Product>[];
	readonly images: readonly State<typeof Image>[];
	readonly videos: readonly State<typeof Video>[];

} = (() => {

	let cache: undefined | typeof collections;

	return immutable({

		get categories() { return load().categories; },
		get vendors() { return load().vendors; },
		get products() { return load().products; },
		get images() { return load().images; },
		get videos() { return load().videos; }

	});


	function load() {
		return cache ??= immutable({

			categories: verify(json.categories, Category),
			vendors: verify(json.vendors, Vendor),
			products: verify(json.products, Product),
			images: verify(json.images, Image),
			videos: verify(json.videos, Video)

		});
	}

	function verify<T extends Lazy<ResourceShape>>(resources: readonly unknown[], shape: T): readonly State<T>[] {
		return resources.map(resource => validate(resource, { shape, depth: 0 })({
			// ;(cast) blue types the validated value by its own Instance, which the local mirror matches at every concrete
			// shape but which the compiler cannot relate to it over a generic one

			value: v => v as unknown as State<T>,
			trace: t => error(new TraceError("failed validation", t ?? []))
		}));
	}

})();


/**
 * Catalogue resources holding the sample collections as members.
 *
 * Each catalogue lists every resource of its type by identifier, and the resources catalogue every resource of any
 * type, so that a store seeded with the sample dataset and these catalogues answers a catalogue retrieval through
 * stored membership. Resolved lazily on first access, as {@link collections} are.
 */
export const catalogues: {

	readonly resources: State<typeof Resources>;
	readonly categories: State<typeof Categories>;
	readonly vendors: State<typeof Vendors>;
	readonly products: State<typeof Products>;

} = (() => {

	let cache: undefined | typeof catalogues;

	return immutable({

		get resources() { return load().resources; },
		get categories() { return load().categories; },
		get vendors() { return load().vendors; },
		get products() { return load().products; }

	});


	function load() {
		return cache ??= immutable({

			resources: catalogue(Resources, `${base}resources/`, "Resources", [
				...collections.categories,
				...collections.vendors,
				...collections.products,
				...collections.images,
				...collections.videos
			]),

			categories: catalogue(Categories, `${base}categories/`, "Categories", collections.categories),
			vendors: catalogue(Vendors, `${base}vendors/`, "Vendors", collections.vendors),
			products: catalogue(Products, `${base}products/`, "Products", collections.products)

		});
	}

	function catalogue<S extends Lazy<ResourceShape>>(
		shape: S,
		id: Reference,
		label: string,
		members: ReadonlyArray<{ readonly id: Reference }>
	): State<S> {
		return validate({

			id,
			type: toys.Collection,
			label: { en: label },
			created: "2026-01-01T00:00:00.000Z",

			members: members.map(member => member.id)

		}, { shape, depth: 0 })({
			// ;(cast) as for the sample collections: blue types the validated value by its own inference
			value: v => v as unknown as State<S>,
			trace: t => error(new TraceError("failed validation", t ?? []))
		});
	}

})();


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Reads the identifier of `entry` from the entry named by `shape`'s `kind: "id"` property.
 *
 * Lets the triple encoders derive a resource's identifier from its shape instead of receiving it threaded through as a
 * separate argument.
 *
 * @param entry - The resource state to read the identifier from
 * @param shape - The resource shape whose `kind: "id"` property names the identifier entry
 *
 * @returns The absolute IRI identifier carried by `entry`
 *
 * @throws Error When `shape` declares no id entry, or `entry` carries no identifier under that entry
 */
export function identify(entry: Resource, shape: Lazy<ResourceShape>): Reference;

/**
 * Reads the identifier of `entry` and maps it through `mapper`.
 *
 * @typeParam V - The type the identifier is mapped to
 *
 * @param entry - The resource state to read the identifier from
 * @param shape - The resource shape whose `kind: "id"` property names the identifier entry
 * @param mapper - Maps the absolute IRI identifier to the result value
 *
 * @returns The result of applying `mapper` to the identifier carried by `entry`
 *
 * @throws Error When `shape` declares no id entry, or `entry` carries no identifier under that entry
 */
export function identify<V>(entry: Resource, shape: Lazy<ResourceShape>, mapper: (id: Reference) => V): V;

/**
 * Reads the identifier carried by `entry`, optionally mapping it to a result value.
 */
export function identify<V>(entry: Resource, shape: Lazy<ResourceShape>, mapper?: (id: Reference) => V): Reference | V {

	const id = map(eager(shape), shape => {

		const idField = getShapeId(shape);

		if ( idField === undefined ) {
			throw new Error(`undefined id entry in shape <${shape.class}>`);
		}

		const id = entry[idField];

		if ( !isReference(id) ) {
			throw new Error(`missing id in <${shape.class}> entry`);
		}

		return id;

	});

	return mapper ? mapper(id) : id;

}

/**
 * Mints a fresh, isolated clone of a sample resource.
 *
 * Derives the resource identity from `shape`: the `kind: "id"` property names the identifier entry and the trailing
 * `{code}` slot of the id {@link ResourceShape.pattern | pattern} names the code entry. The code is regenerated by
 * replacing each character with a random counterpart of the same class (digit, upper-case or lower-case letter), the
 * identifier's trailing segment is swapped to match, the audit timestamps are reset, and the result is validated
 * against `shape`.
 *
 * Lets conformance tests mint isolated fixtures whose identifiers collide neither with the sample dataset nor with
 * other generated fixtures sharing the same store.
 *
 * @typeParam R - The resource type of the sample, carried through to the clone
 *
 * @param sample - The resource to clone; an instance of `shape`
 * @param shape - The resource shape whose id entry and id pattern drive identity derivation
 *
 * @returns The validated clone, carrying a freshly generated code, a matching identifier, and reset audit timestamps
 *
 * @throws Error When `shape` declares no id entry or id pattern, the id pattern has no trailing slot, or `sample` is
 *     missing its identifier or code value
 */
export function clone<R extends Resource>(sample: R, shape: Lazy<ResourceShape>): R {

	const resolved = eager(shape);

	const idField = getShapeId(shape);

	if ( idField === undefined ) {
		throw new Error(`undefined id entry in shape <${resolved.class}>`);
	}

	if ( resolved.pattern === undefined ) {
		throw new Error(`undefined id pattern in shape <${resolved.class}>`);
	}

	const slot = /\/\{([^}]+)}$/.exec(resolved.pattern);

	if ( slot === null ) {
		throw new Error(`expected trailing {code} slot in id pattern <${resolved.pattern}>`);
	}

	const codeField = slot[1];

	const id = sample[idField];
	const code = sample[codeField];

	if ( !isString(id) ) {
		throw new Error(`missing id in sample`);
	}

	if ( !isString(code) ) {
		throw new Error(`missing <${codeField}> in sample`);
	}

	const random = [...(code)].map((char: string): string => {

		const set =
			/[0-9]/.test(char) ? "0123456789"
				: /[A-Z]/.test(char) ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
					: /[a-z]/.test(char) ? "abcdefghijklmnopqrstuvwxyz"
						: "";

		return set.length === 0 ? char : set[Math.floor(Math.random()*set.length)];

	}).join("");

	const clone = {

		...sample,

		[idField]: id.replace(/[^/]+$/, random),
		[codeField]: random,

		created: new Date().toISOString(),
		updated: undefined

	};

	return validate(clone, { shape })({

		value: () => clone,
		trace: t => error<R>(new TraceError("failed validation", t ?? []))

	});

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Builds a validated synthetic {@link Product} state with sensible defaults.
 *
 * Mutation and lifecycle sub-suites use this to mint isolated products whose identifiers cannot collide with the
 * sample dataset. The `sku` seeds the `id` and `documents`; all other slots carry fixed defaults unless overridden.
 *
 * @param sku - The product SKU, also used to derive `id` and `documents`
 * @param name - The english product name, used for `label` and `name`
 * @param overrides - Optional property overrides merged into the resource
 */
export function testProduct(
	sku: string,
	name: string,
	overrides?: Partial<State<typeof Product>>
): State<typeof Product> {
	return {

		id: `${base}products/${sku}`,
		type: toys.Product,
		label: { en: name },

		sku,
		name: { en: name },
		documents: [`${base}documents/${sku}-1.pdf`],

		condition: "new",
		price: 10.00,

		stock: 1,

		vendor: `${base}vendors/0001`,
		categories: [`${base}categories/1000`],

		created: "2026-01-01T00:00:00.000Z",

		...overrides

	};
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Widens a state to what the store admits at runtime.
 *
 * The typed draft a write takes leaves out the absence forms (`undefined`, `[]`, `{}`, `{ und: [] }`) a test states to
 * assert their removal, and the malformed states a test expects rejected; both are handed to the store as they stand.
 *
 * @param state - The state a test states
 *
 * @returns The same state, admitted by every write
 */
export function loose(state: Resource): never {
	return state as never; // ;(cast) the suite exercises the runtime contract beyond what the draft type admits
}

/**
 * Resolves the catalogue collecting the resources a toy shape describes.
 *
 * @param shape - The shape of the collected resources
 *
 * @returns The catalogue holding every resource of `shape` under its `members` property
 *
 * @throws Error When no catalogue collects the resources of `shape`
 */
export function catalogueOf(shape: Lazy<ResourceShape>): Lazy<ResourceShape> {
	return shape === Product ? Products
		: shape === Vendor ? Vendors
			: shape === Category ? Categories
				: error(new Error(`no catalogue collects shape <${getShapeId(shape)}>`));
}

/**
 * Creates a resource through the catalogue collecting it.
 *
 * Anchors the creation to the parent of `entry`, as the store contract requires of a creation, stating `entry` as the
 * identifier of the new resource unless the state names one itself, so that a test keeps naming the resource it
 * creates and asserting on it.
 *
 * @param store - The store to create the resource in
 * @param request - The identifier of the new resource, the shape describing it and its initial state
 *
 * @returns The promise the store's creation resolves to
 */
export function created(store: StoreClient, { entry, shape, state }: {

	readonly entry: Reference;
	readonly shape: Lazy<ResourceShape>;
	readonly state: Resource;

}): Promise<Optional<Reference>> {
	return store.create({
		entry: getIRIParent(entry) ?? error(new Error(`unexpected root entry <${entry}>`)),
		shape: catalogueOf(shape),
		model: { members: {} } as never, // ;(cast) the catalogue is resolved at runtime, so its slice can't be held to it
		state: loose({ id: entry, ...state })
	});
}
