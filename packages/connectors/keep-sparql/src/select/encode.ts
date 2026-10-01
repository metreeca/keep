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
 * Folds every queued {@link Select} into one batched SPARQL SELECT, contributing each request as a
 * UNION arm off a shared outer query. Per-request variable allocation flows through the supplied
 * {@link Scope}, so the {@link decode | decoder} recovers the same solution slots when settling each
 * request against the returned round's tuples.
 *
 * Each arm is emitted clause by clause from the request's {@link Flake | query plan}, every clause a
 * recursive descent over the nodes the query reads: the projection head, the graph patterns, the row
 * filters, the group filters, the ordering and the window. The variable protocol the decoder relies on
 * is stated in `select/index.md`.
 *
 * @module
 */

import { getShapeClass, type Property } from "@metreeca/blue/resource";
import { getShapeBranches } from "@metreeca/blue/union";
import { sh } from "@metreeca/blue/value";
import { isNumber, isString, opt } from "@metreeca/core";
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
import { getOrderDirection, isAggregate } from "@metreeca/qest/model";
import type { Literal } from "@metreeca/qest/state";
import { named, type Named, rdf, type Term } from "@metreeca/trio";
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
	variable,
	where
} from "@metreeca/wire-sparql/builder";
import { boundToVariant, expression, link, membership, optionsToTerms, textual, valueToTerm } from "../_/_encode.js";


/**
 * The stored edge a node is reached through: the subject holding the property, the property itself, and the
 * variable the edge binds its stored object to, the node value itself unless the node folds the stored text.
 */
type Edge = {

	readonly owner: Variable | Named;
	readonly property: Property;
	readonly object: Variable;

};


/**
 * Folds every queued select request into one batched SPARQL SELECT.
 *
 * @param scope The variable scope shared with the decoder, allocating per-request solution slots
 * @param batch The queued select requests to encode, each paired with its {@link Flake | query plan} and deferred
 *
 * @returns The batched SELECT query covering every request in `batch`
 */
export function encode(
	scope: Scope<Variable>,
	batch: readonly (Deferred<Select> & { readonly flake: Flake; })[]
): SPARQL {

	const guard = scope.resolve(batch);

	// a single request runs as it is; several are wrapped in an outer query reordering their rows, the
	// request stamp first so each request's already-sliced window stays contiguous

	return batch.length > 1
		? select(wildcard(),
			where(union(batch.map(arm))),
			orderBy(asc(variable(guard)), batch.map(({ flake }) => ordering(flake)))
		)
		: union(batch.map(arm));


	/**
	 * One request's arm: the member edge, the patterns the query reads, and the clauses projecting,
	 * filtering, grouping, ordering and slicing the members.
	 */
	function arm({ request: { entry, field, locale }, flake }: Deferred<Select> & { readonly flake: Flake }, index: number): SPARQL {

		const root = scope.resolve(flake);
		const edge: Edge = { owner: named(entry), property: field, object: root };

		const read = reader(flake);

		const cells = flake.drain?.form === "projection" ? getFlakeProjections(flake) : [flake];
		const keys = grouping(flake);
		const reduced = reductions(flake);

		const stamp = as(number(index), variable(guard));

		// a query whose projection aggregates is one grouped select; one reduced per item alone (§5.8.2.1)
		// groups by the member in a subselect, which the arm then projects as distinct rows (§5.2)

		const grouped = reduced.length > 0;
		const itemised = grouped && !isGroupingFlake(flake);

		const rows = select(
			grouped
				? [stamp, ...keys.flatMap(columns), ...reduced.map(([stage, origin]) =>
					as(expression(origin, stage.pipe), variable(scope.resolve(stage)))
				)]
				: distinct(stamp, ...cells.flatMap(columns)),
			where(
				link([edge.owner, edge.property, edge.object]),
				patterns(flake, root),
				shards(flake, edge),
				admitted(),
				filters(flake, root)
			),
			grouped ? groupBy(keys.flatMap(columns)) : nil(),
			grouped ? having(reduced.flatMap(([stage, origin]) => [
				...conditions(stage, expression(origin, stage.pipe)),
				...opt(stage.all, options => [conjunction(expression(origin, stage.pipe), optionsToTerms(options, stage.range))], [])
			])) : nil(),
			itemised ? nil() : orderBy(ordering(flake)),
			itemised ? nil() : slicing(flake)
		);

		return itemised
			? select(distinct(variable(guard), ...cells.flatMap(columns)), where(rows), orderBy(ordering(flake)), slicing(flake))
			: rows;


		/**
		 * The filter admitting only members of the variants the query retrieves (§5.5): a member resolving
		 * through an unrequested variant binds no shard and is not a member of the retrieved collection.
		 */
		function admitted(): SPARQL {

			const drain = flake.drain;

			return drain?.form === "union" && drain.variants.size < getShapeBranches(flake.range.shape).length
				? filter(or(...[...drain.variants.keys()].map(variant => isBound(variable(scope.resolve(flake, variant))))))
				: nil();

		}

		/**
		 * The graph patterns binding everything the query reads under a node whose value `value` holds: the
		 * scalar transform stages and the branches the query reads, each nested inside its own edge and
		 * followed by its shards.
		 */
		function patterns(node: Flake, value: Variable): SPARQL {

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

					return fragment(bind(variable(owner), variable(value)), patterns(branch, value));

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
						patterns(branch, value)
					);

				} else if ( isLocalised(branch) && branch.drain?.form === "locale" ) {

					return fragment(bind(variable(owner), variable(value)), patterns(branch, value));

				} else if ( isLocalised(branch) && !hasDictionaryOptions(branch) ) {

					const edge: Edge = { owner, property: entry, object: scope.resolve() };

					return reached(coalesced(edge, variable(value)), edge);

				} else if ( isMixed(branch) ) {

					const edge: Edge = { owner, property: entry, object: scope.resolve() };

					return reached(folded(edge, variable(value)), edge);

				} else {

					const edge: Edge = { owner, property: entry, object: value };

					return reached(link([owner, entry, value]), edge);

				}


				function reached(reach: SPARQL | readonly SPARQL[], edge?: Edge): SPARQL {
					return fragment(
						required ? fragment(reach, patterns(branch, value)) : optional(reach, patterns(branch, value)),
						edge === undefined ? nil() : shards(branch, edge)
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
		 * priority leaves the variant columns to bind on their own.
		 */
		function shards(node: Flake, edge: Edge): SPARQL {

			const { owner, property, object } = edge;
			const drain = node.drain;

			return drain?.form !== "union" || isComputedFlake(node) ? nil() : fragment(...[...drain.variants].map(([variant, placeholder]) => {

				const column = variable(scope.resolve(node, variant));

				return variant.kind === "dictionary"
					? placeholder.form === "locale"
						? optional(link([owner, property, object]), filter(and(isLiteral(variable(object)), ne(lang(variable(object)), string("")))), bind(anchor(owner), column))
						: optional(coalesced(edge, column))
					: optional(link([owner, property, object]), membership(object, variant), bind(variable(object), column));

			}));

		}

		/**
		 * The patterns binding a localised property's coalesced label to `target` (§6.2, Appendix A.5): the
		 * first tag of the request's language priority the property carries wins, and the values under it
		 * come back as plain strings, so every construct downstream reads an ordinary `xsd:string`.
		 */
		function coalesced(edge: Edge, target: SPARQL): readonly SPARQL[] {

				const { owner, property, object } = edge;

				return [
					link([owner, property, object]),
					filter(eq(tagged(variable(object)), winner(edge))),
					bind(str(variable(object)), target)
				];

			}

			/**
			 * The patterns binding a property mixing text with other variants to `target` folded (§3.2): a tagged
			 * value passes under the winning tag of the request's language priority alone, as a plain string; any
			 * other stored value, a plain string or a node among them, passes as it is.
			 */
			function folded(edge: Edge, target: SPARQL): readonly SPARQL[] {

				const { owner, property, object } = edge;

				const raw = variable(object);
				const tag = coalesce(lang(raw), string("")); // a node carries no tag

				return [
					link([owner, property, object]),
					filter(or(eq(tag, string("")), eq(tag, winner(edge)))),
					bind(iif(eq(tag, string("")), raw, str(raw)), target)
				];

			}

			/**
			 * The tag the request's language priority settles a property's text on: the first priority tag the
			 * owner carries a value under, or none.
			 */
			function winner({ owner, property }: Edge): SPARQL {

				const tags = locale.length > 0 ? locale : ["und"];
				const probe = scope.resolve();

				return tags.reduceRight<SPARQL>((rest, tag) => iif(present(tag), string(tag), rest), string(""));


				function present(tag: Tag): SPARQL {
					return exists(link([owner, property, probe]), filter(eq(tagged(variable(probe)), string(tag))));
				}

			}

		function tagged(value: SPARQL): SPARQL { // und text is stored as a plain literal (§6)
			return iif(eq(lang(value), string("")), string("und"), lang(value));
		}

		/**
		 * The row filters under a node: its own constraints on `value`, then those of the scalar stages and
		 * branches the query reads; a reducing stage filters groups instead, through {@link conditions}.
		 */
		function filters(node: Flake, value: Variable): readonly SPARQL[] {

			return [

				...conditions(node, variable(value)).map(filter),
				...conjunctions(node),

				...getFlakeTransforms(node).filter(read).flatMap(stage =>
					isReduction(stage) ? [] : filters(stage, scope.resolve(stage))
				),

				...getFlakeEntries(node).filter(read).flatMap(branch =>
					filters(branch, scope.resolve(branch))
				)

			];


			/**
			 * The `!` filters of a node (§5.7.3): every option must be carried by some value the node's
			 * expression resolves to, each probed by an `exists` re-walking the node's path from the member
			 * with fresh variables, so a multi-valued path is tested across its whole value set; a `null`
			 * option requires the path to resolve to nothing.
			 */
			function conjunctions(node: Flake): readonly SPARQL[] {

				return opt(node.all, options => {

					const { anchor, path } = node.path.reduce<{ at: Flake; anchor: Variable; path: readonly SPARQL[] }>(({ at, anchor, path }, name) => {

						const branch = (at.entries ?? {})[name];
						const target = scope.resolve();

						return branch.entry.kind === "id" ? { at: branch, anchor, path }
							: branch.entry.kind === "type" ? { at: branch, anchor: target, path: [...path, pattern([anchor, named(rdf.type), target])] }
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

	}


	/**
	 * The projected columns of a cell: one per requested variant for a cell retrieved as a union (§5.5), so
	 * the decoder reads the variant off the column that bound; otherwise the cell's single value column. A
	 * transform stage computes a literal and always projects one column.
	 */
	function columns(cell: Flake): readonly SPARQL[] {

		const drain = cell.drain;

		return drain?.form === "union" && !isComputedFlake(cell)
			? [...drain.variants.keys()].map(variant => variable(scope.resolve(cell, variant)))
			: [variable(scope.resolve(cell))];

	}

	/**
	 * The cells a reducing query groups by (§5.8.2.1): the non-aggregate bindings where the projection itself
	 * aggregates; else the member, with the bindings and the non-aggregate sort and focus keys the arm orders
	 * the items by, so a selection aggregate reduces per item.
	 */
	function grouping(flake: Flake): readonly Flake[] {

		const keyed = [
			...(flake.drain?.form === "projection" ? getFlakeProjections(flake) : []),
			...getFlakeFocusing(flake).filter(node => !isReduction(node)),
			...getFlakeOrdering(flake).filter(node => !isReduction(node))
		];

		return isGroupingFlake(flake) ? getFlakeGrouping(flake)
			: [flake, ...keyed.filter((node, index) => node !== flake && keyed.indexOf(node) === index)];

	}

	/**
	 * The reducing stages a query reads, each paired with the value its pipe reduces; `min`/`max`/`sum`/`avg`
	 * over references are left out, their cells unbound (Appendix A.4.1), while `count` still reduces.
	 */
	function reductions(flake: Flake): readonly (readonly [Flake, Variable])[] {

		const read = reader(flake);

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

	/**
	 * The ordering of one request's rows (§5.7.4, §5.7.5): the focus boosts first, then the sort keys by
	 * precedence, each ranked by processing-type tier before its value, then the grouping keys or the member
	 * itself, so paging stays stable.
	 */
	function ordering(flake: Flake): SPARQL {

		const tiebreak = reductions(flake).length > 0
			? grouping(flake).flatMap(columns)
			: [variable(scope.resolve(flake))];

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

	function slicing(flake: Flake): SPARQL {
		return fragment(
			isNumber(flake.offset) ? offset(flake.offset) : nil(),
			isNumber(flake.limit) ? limit(flake.limit) : nil()
		);
	}

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * The test telling the nodes a query reads: those it constrains, orders or focuses, and, under a projection,
 * those it projects, or some stage or branch beneath them. The entries of a plain template name the content
 * the detail pass re-fetches for each member and are not read here.
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
 * Checks whether a transform stage reduces a group: it applies an aggregate, or wraps one in scalar
 * transforms, so its value exists only after grouping.
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


/**
 * Renders the subject an edge hangs off: a variable or the IRI of the request entry.
 */
function anchor(owner: Variable | Named): SPARQL {
	return isString(owner) ? variable(owner) : term(owner);
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

		const variant = boundToVariant(bound, node.range);

		return variant.kind === "boolean"
			? and(isLiteral(value), eq(datatype(value), reference(xsd.boolean)), relate(iif(value, number(1), number(0)), bound ? number(1) : number(0)))
			: (variant.kind === "string" && variant.datatype !== sh.IRI) || variant.kind === "dictionary"
				? and(textual(value), relate(str(value), string(String(bound))))
				: relate(value, term(valueToTerm(bound, variant)));

	}

}


function like(value: SPARQL, keywords: string): SPARQL {
	return and(...keywords
		.toLowerCase()
		.split(/\s+/)
		.filter(token => token.length > 0)
		.map(token => contains(lcase(value), string(token)))
	);
}

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
