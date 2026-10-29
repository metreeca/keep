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
 * Select-pass table schema.
 *
 * The contract the select encoder and decoder share: the columns the query projects for each cell it returns, and
 * the variable each column is bound to. The encoder projects and binds exactly these columns, the decoder reads
 * exactly them, so a cell can neither go unbound nor be read off a column the query never projected. Derived once
 * per batch from the {@link Flake | query plan} and handed to both sides, it is the pass's own IR: it carries plan
 * nodes and range variants as keys, never variables, which the shared {@link Scope} still allocates.
 *
 * @module
 */

import { getShapeBranches } from "@metreeca/blue/union";
import type { Shape } from "@metreeca/blue/value";
import type { Scope } from "@metreeca/core/scope";
import { type Drain, type Flake, getFlakeProjections, isComputedFlake } from "@metreeca/keep-flake";
import type { Variable } from "@metreeca/wire-sparql";


/**
 * One projected column of a cell: the term it binds and how the decoder reads it.
 */
export type Column = {

	/**
	 * The cell the column belongs to: a projected node, or the query root for a plain collection.
	 */
	readonly node: Flake;

	/**
	 * The range variant the column binds: the shard variant of a cell retrieved as a union (§5.5), else the single
	 * variant of the cell's range, under which the decoder reads the term the column binds.
	 */
	readonly variant: Shape;

	/**
	 * The retrieval requested for the column's variant: the variant's own placeholder under a union, else the
	 * cell's drain, which tells an expanded resource from a bare reference and a structural localised read.
	 */
	readonly drain?: Drain;

	/**
	 * How the column is read:
	 *
	 *  - **computed** — the literal a transform stage computes, decoded by its datatype alone;
	 *  - **owner** — the resource owning a localised property retrieved structurally (§5.4), which the detail pass
	 *    expands tag by tag into the dictionary the cell carries, restricted to the tag ranges the locale states;
	 *  - **label** — the coalesced label of a localised property (§6.2), a plain string;
	 *  - **value** — the stored value of the column's variant: a literal, or the reference naming a resource.
	 */
	readonly form: "computed" | "owner" | "label" | "value";

};

/**
 * The columns of every cell a query returns, keyed by cell.
 */
export type Schema = ReadonlyMap<Flake, readonly Column[]>;


/**
 * Derives the table schema of a query plan.
 *
 * The cells are the projected nodes of a projection, or the root member of a plain collection, each mapped to the
 * columns {@link columns} derives for it, in the order the query projects them and the decoder reads them.
 *
 * @param flake The query plan
 *
 * @returns The columns of each cell, keyed by cell
 */
export function schema(flake: Flake): Schema {

	const cells = flake.drain?.form === "projection" ? getFlakeProjections(flake) : [flake];

	return new Map(cells.map(cell => [cell, columns(cell)]));

}

/**
 * Derives the columns of one cell.
 *
 * A transform stage projects one computed column. A cell retrieved as a union projects one column per requested
 * variant (§5.5), so the decoder reads the variant off the column that bound, with no term inspection. Any other
 * cell projects one column under the single variant of its range. A localised variant is read as the owning
 * resource under a locale placeholder and as the coalesced label otherwise, a plain string under the priority.
 *
 * @param cell The cell to derive the columns of
 *
 * @returns The columns of `cell`, in the order the query projects them
 */
export function columns(cell: Flake): readonly Column[] {

	const { drain } = cell;

	const [variant] = getShapeBranches(cell.range.shape);

	return isComputedFlake(cell) ? [{ node: cell, variant, drain, form: "computed" }]
		: drain?.form === "union" ? [...drain.variants].map(([variant, placeholder]) =>
				({ node: cell, variant, drain: placeholder, form: form(variant, placeholder) })
			)
			: [{ node: cell, variant, drain, form: form(variant, drain) }];


	function form(variant: Shape, drain: undefined | Drain): Column["form"] {
		return variant.kind !== "dictionary" ? "value"
			: drain?.form === "locale" ? "owner"
				: "label";
	}

}

/**
 * Resolves the variable a column is bound to.
 *
 * A shard of a cell retrieved as a union is keyed on the cell and its variant, so the shards of one cell take
 * distinct variables; any other column is keyed on its cell alone, the one variable the cell's value is read from.
 *
 * @param scope The variable scope shared by encoder and decoder
 * @param column The column to resolve
 *
 * @returns The variable bound to `column`
 */
export function column(scope: Scope<Variable>, { node, variant }: Column): Variable {
	return node.drain?.form === "union" && !isComputedFlake(node)
		? scope.resolve(node, variant)
		: scope.resolve(node);
}
