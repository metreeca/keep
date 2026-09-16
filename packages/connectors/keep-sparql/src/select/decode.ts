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
 * Select-pass result decoder.
 *
 * Materialises each queued {@link Select}'s collection value from the batched SELECT's solution tuples,
 * one member per row: the element column (the outer `order by` fixes its order) read tuple by tuple, its
 * distinct members in returned order. A scalar or coalesced localised member carries its own value in the
 * row (a plain string, cartesian-fanned for an array-per-tag property); a structured member (resource,
 * reference, or union) is expanded through the supplied {@link Broker}, its own content re-fetched by the
 * lookup pass rather than reconstructed here. A union member is classified by the variant discriminator
 * column that bound (union.md §Model), with no term inspection.
 *
 * @module
 */

import { getShapeTarget } from "@metreeca/blue/reference";
import { type ResourceShape } from "@metreeca/blue/resource";
import { getShapeBranches } from "@metreeca/blue/union";
import { type Range, type Shape } from "@metreeca/blue/value";
import { type Identifier, isObject } from "@metreeca/core";
import type { Tag } from "@metreeca/core/language";
import type { Scope } from "@metreeca/core/scope";
import {
	type Branch,
	type Flake,
	getFlakeEntries,
	getFlakeProjection,
	getFlakeVariant,
	isBranch,
	isDrainedFlake,
	isPropertyBranch
} from "@metreeca/keep-flake";
import type { Broker, Deferred, Select } from "@metreeca/keep/batching";
import type { Reference, Resource, Value } from "@metreeca/qest/resource";
import { isProjection, isTemplate, type Model } from "@metreeca/qest/template";
import type { Term } from "@metreeca/trio";
import type { Tuple, Variable } from "@metreeca/wire-sparql";
import { termToValue } from "../_/_decode.js";
import { getUnionPlaceholders } from "../_/_union.js";


/**
 * Settles each batched select request against the SELECT solution.
 *
 * @param scope The variable scope shared with the encoder, recovering per-request tuple slots
 * @param batch The queued select requests to settle, each paired with its {@link Flake | query plan} and deferred
 * @param broker The cross-pass channel expanding localised properties through the resources pass
 * @param tuples The solution tuples returned by the batched SELECT round
 */
export function decode(
	scope: Scope<Variable>,
	batch: readonly (Deferred<Select> & { readonly flake: Flake; })[],
	broker: Broker,
	tuples: readonly Tuple[]
): void {

	const guard = scope.resolve(batch);

	batch.forEach(({ request, flake, resolve, reject }, index) => {

		const placeholder = request.query[0];
		const locale = request.locale;

		collection(flake, placeholder, locale, index)
			.then(resolve)
			.catch(reject);

	});


	/**
	 * Reads one request's collection: the flake root's bound members in the returned order,
	 * each decoded from its own tuple, omitting any that resolve to no value.
	 */
	function collection(
		flake: Flake,
		placeholder: unknown,
		locale: readonly Tag[],
		index: number
	): Promise<readonly Value[]> {

		const projected = isProjection(placeholder);

		function stamped(tuple: Tuple): boolean {
			const block = tuple[guard];
			return block?.kind === "typed" && block.text === String(index);
		}

		return Promise.all(tuples.filter(stamped).map(tuple => projected
			? row(flake, tuple, locale)
			: element(flake, placeholder, tuple[scope.resolve(flake)], tuple, locale)
		)).then(values =>
			// members always decode to a value (only requested variants are retrieved); the filter only narrows
			// `decodeElement`'s type, which admits `undefined` for its nested / projection-cell callers
			values.filter(value => value !== undefined)
		);

	}

	/**
	 * Decodes one projection row: every binding the query projects (`getFlakeProjection`), keyed by its
	 * alias, read from its computed cell, omitting a binding that resolves to no value (§5.6). The row is
	 * always surfaced — a filtered-out item contributes no row-group, so a present group is a present row.
	 */
	function row(
		flake: Flake,
		tuple: Tuple,
		locale: readonly Tag[]
	): Promise<Resource> {

		return Promise.all(Object.entries(getFlakeProjection(flake))
				.map(([alias, node]) => cell(flake.range, node)
					.then(value => [alias, value] as const)
				)
			)
			.then(slots => slots.reduce<Resource>(
				(row, [alias, value]) => value === undefined ? row : { ...row, [alias]: value },
				{}
			));

		/**
		 * Decodes one projection cell: a structurally-addressed localised binding (a tag-range map placeholder)
		 * carries the owning resource's reference, whose localised property the broker then expands into a
		 * tag-preserving cell (§6); any other binding coerces its single computed term (embedded-resource cells
		 * to follow).
		 */
		function cell(
			host: Range,
			flake: Flake
		): Promise<undefined | Value> {

			const placeholder = flake.drain?.mould;
			const branch = isBranch(flake) && isPropertyBranch(flake) ? flake : undefined;

			// the cell's effective resolved range (never empty), the same source the encoder projects and binds by

			const variants = getShapeBranches(flake.range.shape);
			const single = variants.length === 1 ? variants[0] : undefined;

			const hosts = getShapeBranches(host.shape);
			const [enclosing] = hosts;

			if ( branch !== undefined && single?.kind === "dictionary"
				&& isObject(placeholder)
				&& hosts.length === 1
				&& (enclosing.kind === "resource" || enclosing.kind === "reference") ) {

				const owner = tuple[scope.resolve(branch)];
				const owning = getShapeTarget(enclosing);

				return owner === undefined || owning === undefined
					? Promise.resolve(undefined)
					: text(owning, branch, branch.path[branch.path.length-1], owner);

			} else if ( branch !== undefined && variants.length > 1 ) {

				// a union binding classifies on its populated variant column, which carries the term itself, so it
				// delegates straight to the element decoder without a separate value column to read

				return element(branch, placeholder, undefined, tuple, locale);

			} else if ( branch !== undefined && (
				single?.kind === "resource"
				|| (single?.kind === "reference" && (
					isTemplate(placeholder) || getFlakeEntries(branch).some(isDrainedFlake)
				))
			) ) {

				const nested = tuple[scope.resolve(branch)];

				if ( nested === undefined ) {

					return Promise.resolve(undefined);

				} else if ( isTemplate(placeholder) || getFlakeEntries(branch).some(isDrainedFlake) ) {

					// a structured reference/resource binding delegates its folded sub-structure (§5.6) straight to
					// the lookup pass, keyed on the bound member reference

					const target = getShapeTarget(variants[0]);

					return nested.kind === "named" && target !== undefined
						? expand(nested.iri, target, getFlakeEntries(branch), locale)
						: Promise.resolve(undefined);

				} else {

					// an unstructured resource binding has no sub-structure to expand, so its term decodes as an id

					return Promise.resolve(termToValue(nested));

				}

			} else {

				const bound = tuple[scope.resolve(flake)];

				return Promise.resolve(bound !== undefined ? termToValue(bound) : undefined);

			}

		}

		/**
		 * Expands a localised property by delegating to the resources pass: looks up the owning `subject`
		 * restricted to this property under its requested placeholder, then plucks the decoded value back.
		 */
		function text(
			shape: ResourceShape,
			branch: Branch,
			field: Identifier,
			subject: Term
		): Promise<undefined | Value> {

			// a localised entry resolves as one structured value, so its drain is a Model, never a multi-valued Query

			const model = branch.drain?.mould;
			const placeholder: Model = isObject(model) ? model : "";

			return subject.kind === "named"
				? broker.lookup({ entry: subject.iri, shape, model: { [field]: placeholder }, locale })
					.then(resource => resource[field])
				: Promise.resolve(undefined);

		}

	}

	/**
	 * Decodes one member from its solution tuple: a union by the variant guard that bound, a
	 * resource or expanded reference by delegating its expansion to the lookup pass, any other shape by
	 * coercing the element term. Resolves to `undefined` when a union member matches no requested variant.
	 */
	function element(
		flake: Flake,
		placeholder: unknown,
		element: undefined | Term,
		tuple: Tuple,
		locale: readonly Tag[]
	): Promise<undefined | Value> {

		const variants = getShapeBranches(flake.range.shape);
		const single = variants[0];

		if ( variants.length > 1 ) {

			// a union projects one column per variant — text included (§5.8.1) — each carrying the value behind
			// its membership gate (union.md §Model): the populated column is both the term and its variant
			// classifier, so the term rides the bound column rather than a separate value column

			const present = [...getUnionPlaceholders(variants, placeholder)].flatMap(([variant, mould]) => {
				const term = tuple[scope.resolve(flake, variant)];
				return term !== undefined ? [{ variant, mould, term }] : [];
			})[0];

			return present === undefined
				? Promise.resolve(undefined)
				: variant(present.variant, flake, present.mould, present.term);

		} else if ( element === undefined ) {

			return Promise.resolve(undefined);

		} else if ( (single.kind === "resource" || single.kind === "reference")
			&& (isTemplate(placeholder) || getFlakeEntries(flake).some(isDrainedFlake)) ) {

			// range dereferences a reference to its target resource, so resource and reference coincide here; the
			// expansion is gated on the drain (a nested template or folded branches, §5.6), so a leaf reference —
			// no structure to expand — falls through and is decoded as an id by `termToValue`

			const target = single.kind === "reference" ? getShapeTarget(single) : single;

			return element.kind === "named" && target !== undefined
				? expand(element.iri, target, getFlakeEntries(flake), locale)
				: Promise.resolve(undefined);

		} else {

			return Promise.resolve(termToValue(element));

		}


		/**
		 * Decodes a member under its fixed variant: a literal variant coerces the element term, a node variant
		 * delegates its expansion to the lookup pass, and a bare (non-template) reference variant keeps the
		 * element reference.
		 */
		function variant(
			variant: Shape,
			flake: Flake,
			placeholder: unknown,
			element: Term
		): Promise<undefined | Value> {

			if ( variant.kind === "dictionary" ) {

				// a dictionary variant's cell is its language-tagged literal (§6): a structural request (a tag-map
				// mould) surfaces it as a single-tag map, a coalesced one (a plain-string mould) as the plain string

				return Promise.resolve(element.kind === "tagged"
					? isObject(placeholder) ? { [element.language]: element.text } : element.text
					: undefined);

			} else if ( variant.kind === "reference" && !isTemplate(placeholder) && !getFlakeVariant(flake, variant).some(isDrainedFlake) ) {

				return Promise.resolve(element.kind === "named" ? element.iri : undefined);

			} else if ( variant.kind === "reference" || variant.kind === "resource" ) {

				const target = getShapeTarget(variant);

				return element.kind === "named" && target !== undefined
					? expand(element.iri, target, getFlakeVariant(flake, variant), locale)
					: Promise.resolve(undefined);

			} else {

				return Promise.resolve(termToValue(element));

			}

		}

	}


	/**
	 * Expands a structured member through the lookup pass: reassembles its retrieval template from the
	 * requested branches and hands it to the broker, keyed on the member entry. The read-side dual of
	 * the resources pass's set-valued delegation, so the member's own content — its scalars, localised text,
	 * and nested collections alike — is the lookup handler's responsibility and the select decoder never
	 * reconstructs it from the returned tuples.
	 */
	function expand(
		entry: Reference,
		shape: ResourceShape,
		branches: readonly Branch[],
		locale: readonly Tag[]
	): Promise<Resource> {

		return broker.lookup({

			entry,
			shape,

			model: branches
				.filter(branch => branch.drain !== undefined)
				.reduce((model, branch) => ({
					...model,
					[branch.path[branch.path.length-1]]: branch.drain?.mould ?? ""
				}), {}),

			locale

		});

	}

}
