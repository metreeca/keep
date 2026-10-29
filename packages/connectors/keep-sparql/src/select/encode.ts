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
 * Select-pass query encoder.
 *
 * Folds the queued {@link Select} requests sharing one plan into one SPARQL `select` query. The owners are bound
 * together, so the collections of every owner in a batch cost one query rather than one query per owner. Encoder and
 * decoder share only the group record, its schema and the {@link Scope} allocating variables, so they agree on every
 * column the query projects, and the decoder reads every column off the rows exactly as the encoder bound it.
 *
 * The query is assembled clause by clause from the {@link Group | group}'s {@link Flake | query plan}, covering only
 * the nodes the query reads: the projection head, the graph patterns, the row filters, the group filters, the
 * ordering and the window. Three switches, each settled once per group, decide how the clauses compose:
 *
 *  - the **form** (QEST §5.8.2.1): `grouped` when a projection binding aggregates, the rows being groups; else
 *    `ungrouped`, the rows being members, rendered as `itemised` when a criterion aggregates, since SPARQL has no
 *    per-item reduction and the members are grouped in a subselect, then projected as distinct rows (§5.2);
 *  - the **arms**: one `values` block binding every owner, or, for a windowed plan over several owners, one
 *    subselect arm per owner, each windowing its own members, under an outer query restating the ordering, since a
 *    `limit` spans every owner bound in a query and would otherwise cut the pooled rows of every owner at once;
 *  - the **whole**-collection aggregation (§5.2): a keyless aggregation keeps an owner without members, so the
 *    member edge turns optional and the aggregates discount the row that survives.
 *
 * The contract shared with the decoder is stated in `src/index.md`.
 *
 * @module
 */

import { getShapeClass, type Property } from "@metreeca/blue/resource";
import { getBoundBranch, getShapeBranches } from "@metreeca/blue/union";
import { sh, type Shape } from "@metreeca/blue/value";
import { error, isNumber, opt } from "@metreeca/core";
import { unique } from "@metreeca/core/arrays";
import { xsd } from "@metreeca/core/datatype";
import type { Tag } from "@metreeca/core/language";
import type { Scope } from "@metreeca/core/scope";
import {
	type Branch,
	type Flake,
	getFlakeEntries,
	getFlakeFocusing,
	getFlakeGrouping,
	getFlakeOrdering,
	getFlakeProjections,
	getFlakeTransforms,
	hasDictionaryOptions,
	hasNullOptions,
	isComputedFlake,
	isConstrainedFlake,
	isGroupingFlake,
	isRequiredFlake
} from "@metreeca/keep-flake";
import type { Deferred, Select } from "@metreeca/keep/batching";
import { getOrderDirection, isAggregate, type Query, type Slot } from "@metreeca/qest/model";
import type { Literal } from "@metreeca/qest/state";
import { named, rdf, type Term } from "@metreeca/trio";
import type { SPARQL, Variable } from "@metreeca/wire-sparql";
import {
	all as wildcard,
	and,
	as,
	asc,
	bind,
	boolean,
	coalesce,
	contains,
	datatype,
	desc,
	distinct,
	eq,
	exists,
	filter,
	fragment,
	groupBy,
	gt,
	gte,
	having,
	iif,
	isBound,
	isIn,
	isLiteral,
	isNumeric,
	lang,
	lcase,
	limit,
	lt,
	lte,
	ne,
	nexists,
	nil,
	not,
	number,
	offset,
	optional,
	or,
	orderBy,
	pattern,
	reference,
	select,
	str,
	string,
	term,
	union,
	values,
	variable,
	where
} from "@metreeca/wire-sparql/builder";
import { anchor, coalesced, type Edge, expression, folded, link, membership, textual } from "../patterns.js";
import { optionsToTerms, valueToTerm } from "../terms.js";
import { type Column, column, columns as derive, type Schema } from "./schema.js";


/**
 * The queued requests sharing one query plan: the same field, a structurally equal query and the same locale.
 *
 * The group is the unit the select pass batches on: its requests share the plan's variables, and the owner column
 * tells them apart by entry. The shared {@link Scope} keys that column on the record's identity, so encoder and
 * decoder must receive the very same records, never copies or fresh equivalents.
 */
export type Group = {

	/**
	 * The multi-valued property the requests read.
	 */
	readonly field: Property;

	/**
	 * The collection query every request states.
	 */
	readonly query: Query<Slot>;

	/**
	 * The language priority every request states.
	 */
	readonly locale: readonly Tag[];

	/**
	 * The query plan shared by the requests.
	 */
	readonly flake: Flake;

	/**
	 * The table schema of the plan, the columns the query projects for each cell it returns.
	 */
	readonly schema: Schema;

	/**
	 * The requests, each bound to its own entry on the owner column.
	 */
	readonly items: readonly Deferred<Select>[];

}

/**
 * The settled context of a group's query: what every clause reads, decided once per group.
 */
type Context = {

	readonly scope: Scope<Variable>;
	readonly group: Group;

	/**
	 * The owner column and the member variable.
	 */
	readonly owner: Variable;
	readonly root: Variable;

	/**
	 * The test telling the nodes the query reads.
	 */
	readonly read: (node: Flake) => boolean;

	/**
	 * The query form (§5.8.2.1): grouped rows, ungrouped members, or members grouped in a subselect to reduce a
	 * criterion aggregate per item, which the enclosing query then projects as the distinct rows a selection yields.
	 */
	readonly form: "grouped" | "ungrouped" | "itemised";

	/**
	 * Whether a keyless aggregation keeps an owner without members (§5.2).
	 */
	readonly whole: boolean;

	/**
	 * The cells the query returns, the grouping keys of a reducing query, and the reducing stages it reads, each
	 * paired with the value its pipe reduces, so the head, the grouping and the having clauses read the same lists.
	 */
	readonly cells: readonly Flake[];
	readonly keys: readonly Flake[];
	readonly reduced: readonly (readonly [Flake, Variable])[];

};


/**
 * Encodes the batched `select` query covering every request of a group.
 *
 * @param scope The variable scope shared with the decoder, allocating the group's solution slots
 * @param group The group to encode, pairing the requests sharing a {@link Flake | query plan} with that plan
 *
 * @returns The batched `select` query covering every request in `group`
 */
export function encode(
	scope: Scope<Variable>,
	group: Group
): SPARQL {

	const context = settle(scope, group);

	const { flake, items } = group;

	// a `limit` spans every owner bound in a query, so a windowed plan over several owners runs one arm per
	// owner, each windowing its own members, under an outer query restating the ordering over their union: the
	// arms project the ordering keys the outer query reads, which an unprojected key would leave unbound

	const arms = (isNumber(flake.offset) || isNumber(flake.limit)) && items.length > 1 ? "per-owner" : "values";

	return arms === "per-owner"
		? select(wildcard(),
			where(union(items.map(item => query(context, [item], true)))),
			orderBy(asc(variable(context.owner)), ordering(context))
		)
		: query(context, items, false);

}


//// Context //////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Settles the context of a group's query once, so every clause reads the same variables, form, cells, keys and
 * reductions rather than deriving them again from the plan on its own, possibly differently from the others.
 */
function settle(scope: Scope<Variable>, group: Group): Context {

	const { flake, schema } = group;

	const read = reader(flake);
	const root = scope.resolve(flake);

	const keys = grouping(flake);
	const reduced = reductions(scope, flake, read);

	// a query whose projection aggregates is one grouped select; one reduced per item alone (§5.8.2.1)
	// groups by the member in a subselect, which the query then projects as distinct rows (§5.2)

	const form = reduced.length === 0 ? "ungrouped"
		: isGroupingFlake(flake) ? "grouped"
			: "itemised";

	// an aggregate over the whole collection has a value on an empty collection too (§5.2): a keyless
	// aggregation yields one group whatever its input, but grouped by owner it keeps an owner's group only
	// if a row of that owner survives an empty member set, so the members become optional under the owner
	// binding and `reduction` keeps the surviving row out of the aggregates it would otherwise distort

	return {

		scope, group,

		owner: scope.resolve(group),
		root,

		read,
		form,
		whole: form !== "ungrouped" && keys.length === 0,

		cells: [...schema.keys()],
		keys,
		reduced

	};

}

/**
 * The test telling the nodes a query reads: those it constrains, orders or focuses, and, under a projection,
 * those it projects, or some stage or branch beneath them. The entries of a plain template name the content
 * the detail pass re-fetches for each member and are not read here, so a template never widens the member query.
 */
function reader(flake: Flake): (node: Flake) => boolean {

	return flake.drain?.form === "projection" ? isRead : isConstrainedFlake;


	function isRead(node: Flake): boolean {
		return node.drain?.alias !== undefined
			|| isConstrainedFlake(node)
			|| getFlakeTransforms(node).some(isRead)
			|| getFlakeEntries(node).some(isRead);
	}

}

/**
 * The cells a reducing query groups by (§5.8.2.1): the non-aggregate bindings where the projection itself
 * aggregates; else the member, with the bindings and the non-aggregate sort and focus keys the query orders
 * the items by, so a selection aggregate reduces per item and the keys stay available to the ordering clause.
 */
function grouping(flake: Flake): readonly Flake[] {

	const keyed = [
		...(flake.drain?.form === "projection" ? getFlakeProjections(flake) : []),
		...getFlakeFocusing(flake).filter(node => !isReduction(node)),
		...getFlakeOrdering(flake).filter(node => !isReduction(node))
	];

	return isGroupingFlake(flake) ? getFlakeGrouping(flake)
		: [flake, ...unique(keyed).filter(node => node !== flake)];

}

/**
 * The reducing stages a query reads, each paired with the value its pipe reduces; `min`/`max`/`sum`/`avg`
 * over references are left out, their cells unbound (Appendix A.4.1), while `count` still reduces.
 */
function reductions(scope: Scope<Variable>, flake: Flake, read: (node: Flake) => boolean): readonly (readonly [Flake, Variable])[] {

	return reduced(flake, scope.resolve(flake));


	function reduced(node: Flake, origin: Variable): readonly (readonly [Flake, Variable])[] {

		return [

			...getFlakeTransforms(node).filter(read).flatMap(stage => {

				const reduction: readonly [Flake, Variable] = [stage, origin];

				return [
					...(isReduction(stage) && (stage.pipe.find(isAggregate) === "count" || !isReferential(node)) ? [reduction] : []),
					...reduced(stage, origin)
				];

			}),

			...getFlakeEntries(node).filter(read).flatMap(branch =>
				reduced(branch, scope.resolve(branch))
			)

		];

	}

}


//// Query ////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * The query over the owners of `items`: the owners bound in a `values` block, the member edge, the patterns the
 * query reads, and the clauses projecting, filtering, grouping, ordering and slicing the members; a `nested`
 * query also projects the ordering keys, so the enclosing query can order its rows.
 */
function query(context: Context, items: readonly Deferred<Select>[], nested: boolean): SPARQL {

	const { group: { flake }, owner, form, whole } = context;

	const binding = values([variable(owner)], items.map(({ request }) => [term(named(request.entry))]));

	const rows = select(
		head(context, nested),
		where(
			binding,
			whole ? optional(...body(context)) : fragment(...body(context))
		),
		groupings(context),
		havings(context),
		form === "itemised" ? nil() : orderBy(asc(variable(owner)), ordering(context)),
		form === "itemised" ? nil() : slicing(flake)
	);

	return form === "itemised"
		? select(
			distinct(...projection(context, nested)),
			where(rows),
			orderBy(asc(variable(owner)), ordering(context)),
			slicing(flake)
		)
		: rows;

}

/**
 * The projection head: the owner, the grouping keys and the reductions of a grouped or itemised query, else the
 * owner and the distinct cells, the owner always projected, as the column the spine hands each request its rows by.
 */
function head(context: Context, nested: boolean): SPARQL | readonly SPARQL[] {

	const { scope, owner, form, keys, reduced } = context;

	return form === "ungrouped"
		? distinct(...projection(context, nested))
		: [variable(owner), ...keys.flatMap(key => columns(context, key)), ...reduced.map(([stage, origin]) =>
			as(reduction(context, stage, origin), variable(scope.resolve(stage)))
		)];

}

/**
 * The columns a query returns: the owner and the cells, plus the ordering keys the enclosing query of a `nested`
 * arm reads, which an arm leaving them unprojected would hand to the outer ordering unbound, misordering the rows.
 */
function projection(context: Context, nested: boolean): readonly SPARQL[] {

	const { owner, cells } = context;

	const head = [variable(owner), ...cells.flatMap(cell => columns(context, cell))];

	return [...head, ...(nested ? ordered(context, head) : [])];

}

/**
 * The ordering keys {@link ordering} reads that `head` leaves unprojected: the focus and sort keys, and the
 * member itself as the tiebreak of an ungrouped query; a reducing key is projected by the grouped head, and
 * the member of a projection is left out, as projecting it would keep apart rows the projection collapses.
 */
function ordered(context: Context, head: readonly SPARQL[]): readonly SPARQL[] {

	const { scope, group: { flake }, form } = context;

	const keyed = [
		...getFlakeFocusing(flake),
		...getFlakeOrdering(flake).filter(node => !isReduction(node)),
		...(form !== "ungrouped" || flake.drain?.form === "projection" ? [] : [flake])
	];

	return unique(keyed.map(node => variable(scope.resolve(node)))).filter(key => !head.includes(key));

}

/**
 * The patterns binding everything the query reads: the member edge, the patterns and shards under the member,
 * the filter admitting its variants and the row filters, in the order the `where` clause of the query states them.
 */
function body(context: Context): readonly SPARQL[] {

	const { group: { flake, field }, owner, root } = context;

	const edge: Edge = { owner, property: field, object: root };

	return [
		link([edge.owner, edge.property, edge.object]),
		patterns(context, flake, root),
		shards(context, flake, edge),
		admitted(context),
		...filters(context, flake, root)
	];

}

/**
 * The `group by` clause of a grouped or itemised query: the owner and the grouping keys.
 */
function groupings(context: Context): SPARQL {

	const { owner, form, keys } = context;

	return form === "ungrouped" ? nil() : groupBy(variable(owner), keys.flatMap(key => columns(context, key)));

}

/**
 * The `having` clause of a grouped or itemised query: the conditions the reducing stages state over their
 * aggregates, and the `!` conditions over them (§5.7.3), which only hold once the groups have been reduced.
 */
function havings(context: Context): SPARQL {

	const { form, reduced } = context;

	return form === "ungrouped" ? nil() : having(reduced.flatMap(([stage, origin]) => [
		...conditions(stage, reduction(context, stage, origin)),
		...opt(stage.all, options => [conjunction(reduction(context, stage, origin), optionsToTerms(options, stage.range))], [])
	]));

}

/**
 * The ordering of one request's rows (§5.7.4, §5.7.5): the focus boosts first, then the sort keys by
 * precedence, each ranked by processing-type tier before its value, then the grouping keys or the member
 * itself as a tiebreak, so paging stays stable across queries whatever the backend's own solution order.
 */
function ordering(context: Context): SPARQL {

	const { scope, group: { flake }, root, form, keys } = context;

	const tiebreak = form === "ungrouped"
		? [variable(root)]
		: keys.flatMap(key => columns(context, key));

	return fragment(
		getFlakeFocusing(flake).map(node =>
			asc(iif(any(variable(scope.resolve(node)), optionsToTerms(node.focus, node.range)), number(0), number(1)))
		),
		getFlakeOrdering(flake).flatMap(node => [tier(variable(scope.resolve(node))), sortable(variable(scope.resolve(node)))].map(
			getOrderDirection(node.order) < 0 ? desc : asc
		)),
		tiebreak.map(asc)
	);


	function tier(value: SPARQL): SPARQL {
		return iif(eq(datatype(value), reference(xsd.boolean)), number(0),
			iif(isNumeric(value), number(1),
				iif(temporal(value), number(2),
					number(3)
				)
			)
		);
	}

	function sortable(value: SPARQL): SPARQL {
		return iif(or(isNumeric(value), temporal(value)), value, str(value));
	}

	function temporal(value: SPARQL): SPARQL {
		return isIn(datatype(value), [
			reference(xsd.dateTime),
			reference(xsd.date),
			reference(xsd.time)
		]);
	}

}

/**
 * The window of one request's rows (§5.7.6).
 */
function slicing(flake: Flake): SPARQL {
	return fragment(
		isNumber(flake.offset) ? offset(flake.offset) : nil(),
		isNumber(flake.limit) ? limit(flake.limit) : nil()
	);
}


//// Cells ////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * The projected columns of a cell, as the schema declares them: one per requested variant for a cell
 * retrieved as a union (§5.5), so the decoder reads the variant off the column that bound; otherwise the
 * cell's single column, carrying its stored value, its coalesced label or its owner as the schema states.
 */
function columns(context: Context, cell: Flake): readonly SPARQL[] {
	return shard(context, cell).map(shard => variable(column(context.scope, shard)));
}

/**
 * The schema columns of a cell; a node the schema does not return, a grouping or ordering key the query
 * reads without returning it, takes the columns the schema would derive for it.
 */
function shard({ group: { schema } }: Context, cell: Flake): readonly Column[] {
	return schema.get(cell) ?? derive(cell);
}

/**
 * The expression reducing `origin` through `stage`'s pipe. Under a whole-collection aggregation, the row
 * an owner without members keeps feeds the aggregates an error, which they drop or turn unbound, except
 * under `sum`, which still has to come to `0` (§5.2); every member row feeds them its plain value, so the
 * aggregates of an owner with members come out exactly as a keyless aggregation would compute them.
 */
function reduction({ scope, root, whole }: Context, stage: Flake, origin: Variable): SPARQL {

	// a variable nothing binds is the portable error: `coalesce()` reads as an error too, but RDF4J
	// rejects its empty argument list at parse time as a malformed query, where oxigraph accepts it

	const unbound = scope.resolve();

	return expression(whole
		? iif(isBound(variable(root)), variable(origin), stage.pipe.find(isAggregate) === "sum" ? number(0) : variable(unbound))
		: variable(origin), stage.pipe);

}

/**
 * The filter admitting only members of the variants the query retrieves (§5.5): a member resolving
 * through an unrequested variant binds no shard and is not a member of the retrieved collection.
 */
function admitted(context: Context): SPARQL {

	const { group: { flake } } = context;

	const drain = flake.drain;

	return drain?.form === "union" && drain.variants.size < getShapeBranches(flake.range.shape).length
		? filter(or(...columns(context, flake).map(isBound)))
		: nil();

}


//// Patterns /////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * The graph patterns binding everything the query reads under a node whose value `value` holds: the
 * scalar transform stages and the branches the query reads, each nested inside its own edge and
 * followed by its shards, so a branch binds only where its owner does and never fans out on its own.
 */
function patterns(context: Context, node: Flake, value: Variable): SPARQL {

	const { scope, group: { locale }, read } = context;

	return fragment(
		stages(node, value),
		...getFlakeEntries(node).filter(read).map(branch => step(node, branch, value))
	);


	/**
	 * The binds of the scalar transform stages hanging off a node, each applying its whole pipe to the
	 * node value; a reducing stage binds nothing here, being projected and filtered post-aggregation.
	 */
	function stages(node: Flake, origin: Variable): SPARQL {

		return fragment(...getFlakeTransforms(node).filter(read).map(stage =>
			isReduction(stage) ? nil() : fragment(
				bind(expression(origin, stage.pipe), variable(scope.resolve(stage))),
				stages(stage, origin)
			)
		));

	}

	/**
	 * The patterns reaching one branch off its owner: a marker binds the owner itself (`id`) or its
	 * declared class (`type`); a localised property its coalesced label, its owner under a locale
	 * placeholder, or its raw tagged values under tagged options; a property mixing text with other
	 * variants its stored values folded (§3.2); any other property its stored edge. The branch's own
	 * patterns nest inside the edge, optional unless a constraint requires the path to exist.
	 */
	function step(parent: Flake, branch: Branch, owner: Variable): SPARQL {

		const value = scope.resolve(branch);
		const entry = branch.entry;

		const required = isRequiredFlake(branch) && !hasNullOptions(branch);

		if ( entry.kind === "id" ) {

			return fragment(bind(variable(owner), variable(value)), patterns(context, branch, value));

		} else if ( entry.kind === "type" && (branch.any !== undefined || branch.all !== undefined || branch.focus !== undefined) ) {

			// set matching reads the stored class lineage, so a supertype option spans its subtypes (§5.7.3)

			return reached(pattern([owner, named(rdf.type), value]));

		} else if ( entry.kind === "type" ) {

			// any other read yields the one class the owner's shape declares, never the lineage

			const classes = getShapeBranches(parent.range.shape).flatMap(variant =>
				opt(getShapeClass(variant), clazz => [reference(clazz)], [])
			);

			return fragment(
				optional(pattern([owner, named(rdf.type), value]), filter(isIn(variable(value), classes))),
				patterns(context, branch, value)
			);

		} else if ( isLocalised(branch) && branch.drain?.form === "locale" ) {

			return fragment(bind(variable(owner), variable(value)), patterns(context, branch, value));

		} else if ( isLocalised(branch) && !hasDictionaryOptions(branch) ) {

			const edge: Edge = { owner, property: entry, object: scope.resolve() };

			return reached(coalesced(scope, edge, variable(value), locale), edge);

		} else if ( isMixed(branch) ) {

			const edge: Edge = { owner, property: entry, object: scope.resolve() };

			return reached(folded(scope, edge, variable(value), locale), edge);

		} else {

			const edge: Edge = { owner, property: entry, object: value };

			return reached(link([owner, entry, value]), edge);

		}


		function reached(reach: SPARQL | readonly SPARQL[], edge?: Edge): SPARQL {
			return fragment(
				required ? fragment(reach, patterns(context, branch, value)) : optional(reach, patterns(context, branch, value)),
				edge === undefined ? nil() : shards(context, branch, edge)
			);
		}

	}

}

/**
 * The shards of a cell retrieved as a union (§5.5): one optional arm per requested variant, restating
 * the edge on its stored object so the arm binds within its own group, gated by the variant's
 * {@link membership} and binding the variant column. A localised variant binds its coalesced label
 * (§6.2) or, under a locale placeholder, the owning resource the decoder expands. The arms stand beside
 * the edge rather than inside it, so a folded or coalesced edge admitting no value under the request
 * priority leaves the variant columns to bind on their own, and a member of another variant still surfaces.
 */
function shards(context: Context, node: Flake, edge: Edge): SPARQL {

	const { scope, group: { locale } } = context;
	const { owner, property, object } = edge;

	return node.drain?.form !== "union" || isComputedFlake(node) ? nil() : fragment(...shard(context, node).map(shard => {

		const target = variable(column(scope, shard));

		return shard.form === "owner"
			? optional(link([owner, property, object]), filter(and(isLiteral(variable(object)), ne(lang(variable(object)), string("")))), bind(anchor(owner), target))
			: shard.form === "label"
				? optional(coalesced(scope, edge, target, locale))
				: optional(link([owner, property, object]), membership(object, shard.variant), bind(variable(object), target));

	}));

}


//// Filters //////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * The row filters under a node: its own constraints on `value`, then those of the scalar stages and
 * branches the query reads; a reducing stage filters groups instead, through {@link conditions}.
 */
function filters(context: Context, node: Flake, value: Variable): readonly SPARQL[] {

	const { scope, group: { flake }, root, read } = context;

	return [

		...conditions(node, variable(value)).map(filter),
		...conjunctions(node),

		...getFlakeTransforms(node).filter(read).flatMap(stage =>
			isReduction(stage) ? [] : filters(context, stage, scope.resolve(stage))
		),

		...getFlakeEntries(node).filter(read).flatMap(branch =>
			filters(context, branch, scope.resolve(branch))
		)

	];


	/**
	 * The `!` filters of a node (§5.7.3): every option must be carried by some value the node's
	 * expression resolves to, each probed by an `exists` re-walking the node's path from the member
	 * with fresh variables, so a multi-valued path is tested across its whole value set; a `null`
	 * option requires the path to resolve to nothing, probed by a `not exists` over the same path.
	 */
	function conjunctions(node: Flake): readonly SPARQL[] {

		return opt(node.all, options => {

			const { anchor, path } = node.path.reduce<{
				readonly at: Flake;
				readonly anchor: Variable;
				readonly path: readonly SPARQL[]
			}>(({ at, anchor, path }, name) => {

				const branch = (at.entries ?? {})[name];
				const target = scope.resolve();

				return branch.entry.kind === "id" ? { at: branch, anchor, path }
					: branch.entry.kind === "type" ? {
							at: branch,
							anchor: target,
							path: [...path, pattern([anchor, named(rdf.type), target])]
						}
						: { at: branch, anchor: target, path: [...path, link([anchor, branch.entry, target])] };

			}, { at: flake, anchor: root, path: [] });

			const value = expression(anchor, node.pipe);

			return optionsToTerms(options, node.range).map(option => option === null ? filter(nexists(path))
				: path.length === 0 ? filter(any(value, [option]))
					: filter(exists(path, filter(any(value, [option]))))
			);

		}, []);

	}

}

/**
 * The conditions a node's comparison, text-search and `?` constraints state over `value`, each resolving
 * the operand against the node's range (§5.7).
 */
function conditions(node: Flake, value: SPARQL): readonly SPARQL[] {

	return [
		...opt(node.lt, bound => [comparison(lt, bound)], []),
		...opt(node.gt, bound => [comparison(gt, bound)], []),
		...opt(node.lte, bound => [comparison(lte, bound)], []),
		...opt(node.gte, bound => [comparison(gte, bound)], []),
		...opt(node.like, keywords => [like(value, keywords)], []),
		...opt(node.any, options => [any(value, optionsToTerms(options, node.range))], [])
	];


	/**
	 * A comparison in the variant the bound singles out (§5.7.1), the other variants failing the guard
	 * (Appendix A.4.5): a boolean compares by its false < true rank; a string-kind variant, a coalesced
	 * localised label included, lexically, which also orders the ISO temporal forms a backend leaves opaque;
	 * any other by the bound's typed term, which a mismatched type never satisfies.
	 */
	function comparison(relate: (x: SPARQL, y: SPARQL) => SPARQL, bound: Literal): SPARQL {

		const variant: Shape = getBoundBranch(bound, getShapeBranches(node.range.shape))
			?? error(new RangeError(`unresolved range variant for value <${String(bound)}>`));

		return variant.kind === "boolean"
			? and(isLiteral(value), eq(datatype(value), reference(xsd.boolean)), relate(iif(value, number(1), number(0)), bound ? number(1) : number(0)))
			: (variant.kind === "string" && variant.datatype !== sh.IRI) || variant.kind === "dictionary"
				? and(textual(value), relate(str(value), string(String(bound))))
				: relate(value, term(valueToTerm(bound, variant)));

	}

}

/**
 * The text-search condition (§5.7.2): every whitespace-separated token of `keywords` is a case-insensitive
 * substring of `value`, in any order, so a search matches a label however its words are arranged in it.
 */
function like(value: SPARQL, keywords: string): SPARQL {
	return and(...keywords
		.toLowerCase()
		.split(/\s+/)
		.filter(token => token.length > 0)
		.map(token => contains(lcase(value), string(token)))
	);
}

/**
 * The `?` condition (§5.7.3): `value` is one of `options`, a `null` option admitting an unbound value.
 */
function any(value: SPARQL, options: readonly (null | Term)[]): SPARQL {
	if ( options.length === 0 ) { return boolean(true); } else { // an empty option set is elided (§5)

		const positive = options.filter(option => option !== null);
		const negative = options.some(option => option === null);

		const present = positive.length === 1
			? eq(value, term(positive[0]))
			: isIn(value, positive.map(term));

		return coalesce(
			negative ? or(not(isBound(value)), present) : present,
			boolean(false) // a type mismatch is a non-match, not an error
		);

	}
}

/**
 * The `!` condition over a single reduced value (§5.7.3): every option must equal it, so only a singleton
 * set is satisfiable; a `null` option requires it unbound.
 */
function conjunction(value: SPARQL, options: readonly (null | Term)[]): SPARQL {
	if ( options.length === 0 ) { return boolean(true); } else { // an empty option set is elided (§5)

		return and(
			options.some(option => option === null) ? not(isBound(value)) : nil(),
			...options.flatMap(option => option === null ? [] : [any(value, [option])])
		);

	}
}


//// Nodes ////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Checks whether a transform stage reduces a group: it applies an aggregate, or wraps one in scalar
 * transforms, so its value exists only after grouping and is projected and filtered rather than bound.
 */
function isReduction(stage: Flake): boolean {
	return stage.pipe.some(isAggregate);
}

/**
 * Checks whether a branch resolves to localised text alone.
 */
function isLocalised(branch: Branch): boolean {
	return getShapeBranches(branch.range.shape).every(variant => variant.kind === "dictionary");
}

/**
 * Checks whether a branch resolves to localised text among other variants, as a path crossing a union whose
 * variants declare the same property as text and as a plain value does (§5.8.1).
 */
function isMixed(branch: Branch): boolean {

	const variants = getShapeBranches(branch.range.shape);

	return variants.some(variant => variant.kind === "dictionary") && !variants.every(variant => variant.kind === "dictionary");

}

/**
 * Checks whether a node resolves to references alone: a marker (an IRI-typed string) or a reference or
 * resource property, outside the domain of every aggregate but `count` (§5.8.2.1).
 */
function isReferential(node: Flake): boolean {
	return getShapeBranches(node.range.shape).every(variant =>
		variant.kind === "reference" || variant.kind === "resource" || (variant.kind === "string" && variant.datatype === sh.IRI)
	);
}
