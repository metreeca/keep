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
 * Detail-pass table schema.
 *
 * The contract the detail encoder and decoder share: the columns the query binds for each single-valued property
 * the plan reads, and the variable each column is bound to. The encoder binds exactly these columns, the decoder
 * reads exactly them, so a property can neither go unbound nor be read off a column the query never bound. Derived
 * once per batch from the {@link Flake | detail plan} and handed to both sides, it is the pass's own IR: it carries
 * plan nodes and range variants as keys, never variables, which the shared {@link Scope} still allocates.
 *
 * @module
 */

import type { Property } from "@metreeca/blue/resource";
import { eager, type Shape } from "@metreeca/blue/value";
import type { Scope } from "@metreeca/core/scope";
import {
	type Branch,
	type Drain,
	type Flake,
	getFlakeEntries,
	getFlakeVariant,
	isModelBranch
} from "@metreeca/keep-flake";
import type { Variable } from "@metreeca/wire-sparql";


/**
 * One bound column of a single-valued property: the terms it binds and how the decoder reads them.
 */
export type Column = {

	/**
	 * The property branch the column belongs to.
	 */
	readonly node: Branch & { readonly entry: Property };

	/**
	 * The range variant the column binds: a requested variant of a union-typed property (§5.5), else the single
	 * variant of the property's range, under which the decoder reads the terms the column binds.
	 */
	readonly variant: Shape;

	/**
	 * The retrieval requested for the column's variant: the variant's own placeholder under a union, else the
	 * branch drain, which tells a structural retrieval of a localised variant from its coalesced label (§5.4).
	 */
	readonly drain?: Drain;

	/**
	 * How the column is read:
	 *
	 *  - **tagged** — the language-tagged terms of a localised variant, one per solution row, collected into the
	 *    tag-keyed dictionary or the coalesced label the request asks for (§5.4, §6.2);
	 *  - **value** — the stored value of the column's variant: a literal, or the reference naming a resource.
	 */
	readonly form: "tagged" | "value";

};

/**
 * The columns of every single-valued property a plan reads, keyed by property branch.
 */
export type Schema = ReadonlyMap<Branch, readonly Column[]>;


/**
 * Derives the table schema of a detail plan.
 *
 * Every single-valued property branch reachable from the root through nested resources and requested union
 * variants is mapped to its columns: one per requested variant for a union-typed property, so the decoder reads
 * the variant off the column that bound, else one under the single variant of the property's range. Markers and
 * multi-valued properties bind no column and are absent from the schema, as the query never reads them.
 *
 * @param flake The detail plan
 *
 * @returns The columns of each single-valued property, keyed by branch
 */
export function schema(flake: Flake): Schema {

	return new Map(rows(getFlakeEntries(flake)));


	/**
	 * The schema rows of the single-valued property branches among `branches` and under their columns.
	 */
	function rows(branches: readonly Branch[]): readonly (readonly [Branch, readonly Column[]])[] {

		return branches.filter(isModelBranch).flatMap(branch => {

			const bound = columns(branch);

			return [
				[branch, bound],
				...bound.flatMap(column => rows(entries(column)))
			];

		});

	}

	/**
	 * The columns of one property branch: one per requested variant of a union-typed property, else one under the
	 * single variant of its range, read as tagged text under a localised variant and as a value otherwise.
	 */
	function columns(branch: Branch & { readonly entry: Property }): readonly Column[] {

		const shape = eager(branch.range.shape);

		return shape.kind === "union"
			? (branch.drain?.form === "union" ? [...branch.drain.variants] : []).map(([variant, placeholder]) =>
				({ node: branch, variant, drain: placeholder, form: form(variant) })
			)
			: [{ node: branch, variant: shape, drain: branch.drain, form: form(shape) }];

	}

	function form(variant: Shape): Column["form"] {
		return variant.kind === "dictionary" ? "tagged" : "value";
	}

}

/**
 * Resolves the variable a column is bound to.
 *
 * A column of a union-typed property is keyed on the branch and its variant, so the columns of one property take
 * distinct variables; any other column is keyed on its branch alone, the one variable its property is read from.
 *
 * @param scope The variable scope shared by encoder and decoder
 * @param column The column to resolve
 *
 * @returns The variable bound to `column`
 */
export function column(scope: Scope<Variable>, { node, variant }: Column): Variable {
	return eager(node.range.shape).kind === "union"
		? scope.resolve(node, variant)
		: scope.resolve(node);
}

/**
 * Lists the property branches nested under a column.
 *
 * The branches of the resource the column's variant reaches: those its own variant declares for a union-typed
 * property, every branch of the property otherwise; none under a localised variant.
 *
 * @param column The column to descend from
 *
 * @returns The nested branches, in plan order
 */
export function entries({ node, variant }: Column): readonly Branch[] {
	return variant.kind === "dictionary" ? []
		: eager(node.range.shape).kind === "union" ? getFlakeVariant(node, variant)
			: getFlakeEntries(node);
}
