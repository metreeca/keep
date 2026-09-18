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
 * UNION branch off a shared outer query. Per-request variable allocation flows through the supplied
 * {@link Scope}, so the {@link decode | decoder} recovers the same solution slots when settling each
 * request against the returned round's tuples.
 *
 * Each request's arm evaluates as a fixed pipeline of stages (structural match, text coalescing, scalar
 * transforms, scalar filters, grouping, projection, aggregate filtering, ordering, and slicing); the
 * helpers below follow that order, each grouping its single-use sub-helpers as nested functions. See the
 * `select/index.md` cheat-sheet for the query-plan structure the stages mirror.
 *
 * @module
 */

import { getShapeClass, type Property } from "@metreeca/blue/resource";
import { getShapeBranches } from "@metreeca/blue/union";
import { eager } from "@metreeca/blue/value";
import { isNumber, isObject, map } from "@metreeca/core";
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
	getFlakeVariant,
	hasDictionaryOptions,
	hasNullOptions,
	isAggregateFlake,
	isComputedFlake,
	isConstrainedFlake,
	isDrainedFlake,
	isGroupingFlake,
	isPropertyBranch,
	isRequiredFlake,
	isScalarFlake
} from "@metreeca/keep-flake";
import type { Deferred, Select } from "@metreeca/keep/batching";
import type { Literal } from "@metreeca/qest/state";
import { getOrderDirection, isAggregate, isProjection } from "@metreeca/qest/model";
import { named, type Named, rdf, type Term } from "@metreeca/trio";
import { type SPARQL, type Variable } from "@metreeca/wire-sparql";
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
	isNumeric,
	lang,
	lcase,
	limit,
	lt,
	lte,
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
import { boundToTerm, expression, link, membership, optionsToTerms } from "../_/_encode.js";
import { crossing, isXComputed, isXScalar, references } from "../_/_flake.js";
import { isProjected } from "../_/_model.js";
import { getUnionPlaceholders } from "../_/_union.js";


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

	if ( batch.length > 1 ) {

		return select(wildcard(),
			where(collections()),
			reorder()
		);

	} else {

		return collections();

	}


	function root(flake: Flake): Variable {
		return scope.resolve(flake);
	}


	function collections(): SPARQL {
		return union(batch.map(({ request, flake }, index) => arm(request, flake, index)));
	}

	function reorder(): SPARQL {

		return orderBy(asc(variable(guard)), batch.map(({ flake }) =>
			sorting(flake)
		));

	}


	function columns(cell: Flake): readonly SPARQL[] {
		const variants = getShapeBranches(cell.range.shape);

		return variants.length > 1 // !!! why?
			? variants.map(variant => variable(scope.resolve(cell, variant)))
			: [variable(scope.resolve(cell))];
	}

	function aggregateColumns(flake: Flake, anchor: Variable, reference: boolean): readonly SPARQL[] {

		// `min`/`max`/`sum`/`avg` over a reference short-circuit to an unbound column (Appendix A.4.1),
		// `count` still reduces; an aggregate's scalar wrappers (`round:avg:price`) compose inline and project
		// as their own columns, since a select alias cannot reference a sibling column

		const own = getFlakeTransforms(flake).flatMap(stage =>
			stage === undefined || !isComputedFlake(stage) ? []
				: isAggregateFlake(stage) ? column(stage)
					: aggregateColumns(stage, anchor, reference)
		);

		const nested = getFlakeEntries(flake).flatMap(branch => {
			return isPropertyBranch(branch) ? aggregateColumns(branch, scope.resolve(branch), references(branch))
				: branch.entry.kind === "id" || branch.entry.kind === "type" ? aggregateColumns(branch, anchor, true)
					: [];
		});

		return [...own, ...nested];


		function column(flake: Flake): readonly SPARQL[] {
			return !reference || flake.pipe[0] === "count" ? projected(flake) : [];
		}

		function derived(flake: Flake): readonly SPARQL[] {
			return getFlakeTransforms(flake).flatMap(flake => isScalarFlake(flake) ? projected(flake) : []);
		}

		function projected(flake: Flake): readonly SPARQL[] {
			return [as(expression(anchor, flake.pipe), variable(scope.resolve(flake))), ...derived(flake)];
		}

	}


	function arm(request: Select, flake: Flake, index: number): SPARQL {

		const item = request.query;
		const { locale } = request;

		const projections = getFlakeProjections(flake);
		const projection = isProjected(item);

		const scalars = projection
			? getFlakeGrouping(flake).map(key => variable(scope.resolve(key)))
			: columns(flake);

		const aggregates = aggregateColumns(flake, root(flake), false); // !!! reference flag
		const grouped = aggregates.length > 0;

		const block = as(number(index), variable(guard));

		return select(
			grouped ? [block, ...scalars, ...aggregates]
				: projection ? distinct(block, ...(projections.flatMap(columns)))
					: distinct(block, ...scalars),
			where(
				anchor(request, flake, item),
				localised(flake, root(flake)),
				computed(flake, root(flake)),
				filters(flake, root(flake)),
				matchAllComputed(flake)
			),
			grouped ? groupBy(scalars) : nil(),
			grouped ? having(filtering(flake, root(flake))) : nil(),
			orderBy(sorting(flake)),
			slicing(flake)
		);


		function anchor(
			request: Select,
			flake: Flake,
			placeholder: unknown
		): SPARQL {

			const entry = named(request.entry);
			const shape = request.shape;
			const field = request.field;
			const forward = field.forward;


			const variants = getShapeBranches(flake.range.shape);

			// a single-variant member carries its own class / kind; a union member (multiple variants) has no
			// item class and is not a localised leaf

			const clazz = variants.length === 1 ? getShapeClass(variants[0]) : undefined; // !!! variant.length

			const source = variants.length === 1 && variants[0].kind === "dictionary" // !!! variant.length
				? fragment(coalesceGather(entry, forward, root(flake))) // !!! why here
				: eager(shape).virtual
					? clazz !== undefined ? pattern([root(flake), named(rdf.type), named(clazz)]) : nil()
					: link([entry, field, root(flake)]);

			return fragment(source, element(entry, field, root(flake), flake, placeholder));

		}

		function element(
			parent: Variable | Named,
			field: Property,
			anchor: Variable,
			flake: Flake,
			placeholder: unknown
		): SPARQL {

			// `anchor` is already bound by the caller — {@link anchor}'s root membership, or {@link entries}'
			// edge for a nested branch — so this only descends `anchor`'s children, hanging their patterns off it.
			// A union restates the edge binding `anchor` inside each arm's `optional` (re-derived from the IR, never
			// threaded) so `anchor` stays in scope for the gate's filter: bare filter-only optionals leave outer
			// variables unbound on some backends

			const variants = getShapeBranches(flake.range.shape);

			if ( variants.length > 1 && crossing(flake) ) {

				// a crossing intermediate union (a path step under a shared predicate, never itself surfaced) holds
				// only branches every variant declares; traverse it like a resource, descending the shared branches
				// off the anchor, since the shared edge resolves regardless of which variant the member is (§5.8.1)

				return entries(getFlakeEntries(flake), anchor, undefined);

			} else if ( variants.length > 1 ) {

				// a requested variant contributes a gated arm: membership filter, shard bind, subtree. A
				// non-requested variant carrying a surfacing (constrained/ordered) path still binds it ungated —
				// the path's existence is the variant shard (state rule), so a value-implying constraint
				// through a variant selects exactly the resources resolving through it

				const requested = getUnionPlaceholders(variants, placeholder);

				const retrievedVariants = variants.filter(variant => requested.has(variant) || getFlakeVariant(flake, variant).some(isDrainedFlake));

				// re-derive the edge binding `anchor` from the IR — `link(parent, entry, anchor)`, the nested
				// branch's edge or the root's membership triple — so each arm keeps `anchor` in scope

				const source = link([parent, field, anchor]);

				const arms = variants.map(variant => {

					const branches = getFlakeVariant(flake, variant);

					return requested.has(variant) || branches.some(isDrainedFlake)
						? optional(
							source,
							membership(anchor, variant),
							bind(variable(anchor), variable(scope.resolve(flake, variant))),
							entries(branches, anchor, getShapeClass(variant))
						)
						: branches.some(branch => grouped ? isXComputed(branch) : isXScalar(branch))
							? entries(branches, anchor, getShapeClass(variant))
							: nil();

				});

				// retrieve only the requested variants (§5.4): when a proper subset is requested, a member
				// resolving through an unrequested variant binds no requested shard, so it is excluded by
				// requiring at least one to be bound — the encoder never returns a member the query did not ask for

				const gate = retrievedVariants.length > 0 && retrievedVariants.length < variants.length
					? filter(retrievedVariants
						.map(variant => isBound(variable(scope.resolve(flake, variant))))
						.reduce((left, right) => or(left, right)))
					: nil();

				return fragment(...arms, gate);

			} else if ( variants[0].kind === "resource" || variants[0].kind === "reference" ) {

				return entries(getFlakeEntries(flake), anchor, getShapeClass(variants[0]));

			} else {

				return nil();

			}

		}

		function entries(
			branches: readonly Branch[],
			anchor: Variable,
			clazz: string | undefined
		): SPARQL {

			return fragment(...branches.map(branch => {

				if ( isPropertyBranch(branch) && eager(branch.entry.range.shape).kind === "dictionary" ) {

					// a structurally-addressed localised property binds its raw edge here (tagged-literal match,
					// §5.7.3); a coalesced one is bound by the coalesce pass instead (§6.2)

					return hasDictionaryOptions(branch)
						? fragment(
							optional(link([anchor, branch.entry, scope.resolve(branch)])),
							matchAllStored(branch, anchor)
						)
						: nil();

				} else if ( isPropertyBranch(branch) && (grouped ? isXComputed(branch) : isXScalar(branch)) ) {

					const target = scope.resolve(branch);

					// bind this branch's edge (anchoring `target`), then descend `target`'s children through
					// `element` hung off it. The nested placeholder rides `drain.mould` — the template entry's
					// fragment or the projection binding's model — driving a union's variant descent (§5.4)

					const placeholder = branch.drain?.mould;
					const descent = fragment(
						link([anchor, branch.entry, target]),
						element(anchor, branch.entry, target, branch, placeholder)
					);

					// a path a value-implying constraint expects to exist is required (a missing value drops the
					// resource, not surfaces it unbound); a plain retrieval path — or one whose set constraint
					// admits a `null` option (matching absence) — stays optional

					const required = isRequiredFlake(branch) && !hasNullOptions(branch);

					return fragment(
						required ? descent : optional(descent),
						matchAllStored(branch, anchor)
					);

				} else if ( branch.entry.kind === "id" ) {

					// a projected `id` binds to the anchor, so an expression / grouping key / cell ending in `id`
					// reads the resource reference; a `!id` constraint conjoins per-option equalities on the anchor

					return fragment(
						branch.drain?.alias !== undefined ? bind(variable(anchor), variable(scope.resolve(branch))) : nil(),
						matchAllStored(branch, anchor)
					);

				} else if ( branch.entry.kind === "type" && branch.drain?.alias !== undefined && clazz !== undefined ) {

					// a projected `type` resolves to the shape's own class, never the store (the store holds the
					// whole class lineage)

					return fragment(
						bind(reference(clazz), variable(scope.resolve(branch))),
						matchAllStored(branch, anchor)
					);

				} else if ( branch.entry.kind === "type" && isConstrainedFlake(branch) ) {

					// a `?type` constraint matches the stored `rdf:type` triples (denormalised over the class
					// lineage, so a supertype filter spans its subtypes); a `!type` conjoins them via matchAllStored

					return fragment(
						optional(pattern([anchor, named(rdf.type), scope.resolve(branch)])),
						matchAllStored(branch, anchor)
					);

				} else {

					return nil();

				}

			}));

		}


		function localised(node: Flake, anchor: Variable): SPARQL {

			return fragment(...getFlakeEntries(node)
				.map(branch => localiser(branch, anchor)));

			/**
			 * The coalesce binding of one branch under `anchor`: a `dictionary` branch coalesces (or, structurally,
			 * binds the owning reference for broker delegation); a resource/reference recurses; a union descends each
			 * variant, so a localised property nested in a variant is reached too.
			 */
			function localiser(branch: Branch, anchor: Variable): SPARQL {

				if ( !isPropertyBranch(branch) || !(grouped ? isXComputed(branch) : isXScalar(branch)) ) { return nil(); }

				const range = eager(branch.entry.range.shape);

				// a structural localised property (a tag-range map) is expanded by the broker in the decoder, so the
				// cell carries the owning reference (the anchor): bind it, no edge, so the tags never fan the row. A
				// tagged-option constraint binds its raw edge in `entries`; anything else coalesces

				return range.kind === "dictionary"
					? isObject(branch.drain?.mould) ? bind(variable(anchor), variable(scope.resolve(branch)))
						: hasDictionaryOptions(branch) ? nil()
							: coalesced(anchor, branch)
					: range.kind === "resource" || range.kind === "reference"
						? localised(branch, scope.resolve(branch))
						: range.kind === "union"
							// the union's branches are folded (§5.8.1): a crossing property shared across variants is
							// one branch, walked once off the union node, never once per declaring variant
							? fragment(...getFlakeEntries(branch)
								.map(nested => localiser(nested, scope.resolve(branch))))
							: nil();


				/**
				 * The coalesce binding of one localised branch (Appendix A.5): {@link coalesceGather} wrapped in the
				 * enclosing `optional`.
				 */
				function coalesced(anchor: Variable, branch: Branch): SPARQL {

					const gather = isPropertyBranch(branch)
						? coalesceGather(anchor, branch.entry.forward, scope.resolve(branch))
						: [];

					return gather.length > 0 ? optional(...gather) : nil();

				}

			}

		}

		function coalesceGather(
			subject: Variable | Named,
			forward: string | undefined, // !!! review
			target: Variable
		): readonly SPARQL[] {

			if ( forward === undefined ) {

				return [];

			} else {

				const tags = locale.length > 0 ? locale : ["und"];
				const gathered = scope.resolve();
				const probe = scope.resolve();

				const fold = (value: SPARQL): SPARQL => iif(eq(lang(value), string("")), string("und"), lang(value));
				const present = (tag: Tag): SPARQL =>
					exists(pattern([subject, named(forward), probe]), filter(eq(fold(variable(probe)), string(tag))));
				const winner = tags.reduceRight<SPARQL>((rest, tag) => iif(present(tag), string(tag), rest), string(""));

				// bind the coalesced value(s) as a plain xsd:string (§6): dropping the language tag makes the value
				// itself, an aggregate, or a comparison over the coalesced path reduce ordinary strings

				return [
					pattern([subject, named(forward), gathered]),
					filter(eq(fold(variable(gathered)), winner)),
					bind(str(variable(gathered)), variable(target))
				];
			}
		}


		function computed(flake: Flake, anchor: Variable): SPARQL {
			return fragment(
				...getFlakeTransforms(flake).map(transform =>
					transform === undefined || !isComputedFlake(transform) ? nil() // !!! undefined?
						: isAggregateFlake(transform)
							? grouped ? nil() : computed(transform, scope.resolve(transform))
							: fragment(
								bind(expression(anchor, [transform.pipe[0]]), variable(scope.resolve(transform))),
								computed(transform, scope.resolve(transform))
							)
				),
				...getFlakeEntries(flake).filter(isPropertyBranch).map(property => // !!! id/type?
					computed(property, scope.resolve(property))
				)
			);
		}

		function filters(flake: Flake, anchor: Variable): SPARQL {

			const value = isComputedFlake(flake) ? variable(scope.resolve(flake)) : variable(anchor);

			// a single-variant string target (plain string, or a lexically-ordered / opaque temporal) compares
			// lexically via `str(...)` (correct for ISO temporal formats); a single boolean by its 0/1 rank
			// (backends do not order xsd:boolean); any other single type, and every multi-variant union, by the
			// bound's typed term, so a union bound resolves in its own variant and excludes the rest by type
			// mismatch (§5.7.1)

			const variants = getShapeBranches(flake.range.shape);
			const single = variants.length === 1 ? variants[0] : undefined; // !!! why?

			function compare(relate: (x: SPARQL, y: SPARQL) => SPARQL, limit: Literal): SPARQL { // !!! vs having?

				return single?.kind === "boolean" ? filter(relate(iif(value, number(1), number(0)), limit ? number(1) : number(0)))
					: single?.kind === "string" || single?.kind === "dictionary" ? filter(relate(str(value), string(String(limit))))
						: filter(relate(value, term(boundToTerm(limit, flake.range))));

			}

			return fragment(
				flake.lt !== undefined ? compare(lt, flake.lt) : nil(),
				flake.gt !== undefined ? compare(gt, flake.gt) : nil(),
				flake.lte !== undefined ? compare(lte, flake.lte) : nil(),
				flake.gte !== undefined ? compare(gte, flake.gte) : nil(),
				flake.like !== undefined ? filter(like(value, flake.like)) : nil(),
				flake.any !== undefined ? filter(any(value, optionsToTerms(flake.any, flake.range))) : nil(),

				// stored `!` → `matchAllStored`, scalar-computed `!` → `matchAllComputed`; an aggregate `!` filters its
				// single bound value inline here when ungrouped (grouped aggregates move to HAVING via `filtering`)
				flake.all !== undefined && isComputedFlake(flake) && flake.pipe.some(isAggregate)
					? filter(all(value, optionsToTerms(flake.all, flake.range)))
					: nil(),

				// under grouping an aggregate stage's constraint restricts groups post-aggregation (HAVING, emitted
				// separately by havings), never rows, so skip it here to keep it out of the WHERE

				getFlakeTransforms(flake).map(transform =>
					grouped && isAggregateFlake(transform) ? nil() : filters(transform, anchor)
				),

				getFlakeEntries(flake).map(property => filters(
					property,
					property.entry.kind === "id" ? anchor : scope.resolve(property)
				))
			);

		}

	}


	function filtering(flake: Flake, anchor: Variable): readonly SPARQL[] {

		return [

			...getFlakeTransforms(flake).flatMap(transform =>
				isAggregateFlake(transform)
					? postAggregate(transform)
					: filtering(transform, anchor)
			),

			...getFlakeEntries(flake).flatMap(property =>
				property.entry.kind === "id" || property.entry.kind === "type"
					? filtering(property, anchor)
					: filtering(property, scope.resolve(property))
			)

		];

		// an aggregate and every scalar transform wrapping it are post-aggregation, so their constraints move
		// to HAVING; each wrapper carries the full pipe, so `constraints` renders e.g. `round(avg(…))` whole

		function postAggregate(flake: Flake): readonly SPARQL[] {

			const range = flake.range;
			const value = expression(anchor, flake.pipe);

			return [

				flake.lt !== undefined ? lt(value, term(boundToTerm(flake.lt, range))) : nil(),
				flake.gt !== undefined ? gt(value, term(boundToTerm(flake.gt, range))) : nil(),
				flake.lte !== undefined ? lte(value, term(boundToTerm(flake.lte, range))) : nil(),
				flake.gte !== undefined ? gte(value, term(boundToTerm(flake.gte, range))) : nil(),
				flake.like !== undefined ? like(value, flake.like) : nil(),
				flake.any !== undefined ? any(value, optionsToTerms(flake.any, range)) : nil(),
				flake.all !== undefined ? all(value, optionsToTerms(flake.all, range)) : nil(),

				...getFlakeTransforms(flake).flatMap(postAggregate)

			];

		}

	}

	function sorting(flake: Flake): SPARQL {

		return fragment(
			getFlakeFocusing(flake).map(flake => {

				const value = variable(scope.resolve(flake));

				return asc(iif(
					any(value, optionsToTerms(flake.focus, flake.range)), number(0), number(1)
				));

			}),

			getFlakeOrdering(flake).flatMap(flake => {

				const value = variable(scope.resolve(flake));

				// a tier prefix orders each type-band before comparing within it; for a single-variant cell the
				// datatype is homogeneous, so the tier collapses to a constant and the sort reduces to `sortable`
				return [tier(value), sortable(value)].map(
					getOrderDirection(flake.order) < 0 ? desc : asc
				);

			}),

			(isGroupingFlake(flake) ? getFlakeGrouping(flake) : [flake]).map(flake => // tiebreak
				asc(variable(scope.resolve(flake)))
			)
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


	function like(value: SPARQL, keywords: string): SPARQL {
		return and(...String(keywords)
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
				boolean(false) // guard against type mismatches
			);

		}
	}

	function all(value: SPARQL, options: readonly (null | Term)[]): SPARQL {
		if ( options.length === 0 ) { return boolean(true); } else { // an empty option set is elided (§5)

			const positive = options.filter(option => option !== null);
			const negative = options.some(option => option === null);

			return and(
				negative ? not(isBound(value)) : nil(),
				...positive.map(option => any(value, [option]))
			);

		}
	}


	function matchAllStored(branch: Branch, anchor: Variable): SPARQL {
		if ( branch.all === undefined ) { return nil(); } else {

			const options = optionsToTerms(branch.all, branch.range);

			if ( branch.entry.kind === "id" ) { // `id` is the anchor itself, single-valued

				return filter(all(variable(anchor), options));

			} else if ( branch.entry.kind === "type" ) {

				return map(scope.resolve(), value =>
					matchAll(variable(value), pattern([anchor, named(rdf.type), value]), options)
				);

			} else if ( isPropertyBranch(branch) ) {

				return map(scope.resolve(), value =>
					matchAll(variable(value), link([anchor, branch.entry, value]), options)
				);

			} else {

				return nil();

			}
		}
	}

	function matchAllComputed(flake: Flake): SPARQL {

		return walk(flake, root(flake), nil());

		function walk(flake: Flake, anchor: Variable, path: SPARQL): SPARQL {
			return fragment(
				...getFlakeEntries(flake).map(property => descend(property, anchor, path)),
				...getFlakeTransforms(flake).map(transform => matchStage(transform, anchor, path))
			);
		}

		function descend(branch: Branch, anchor: Variable, path: SPARQL): SPARQL {
			return isPropertyBranch(branch)
				? map(scope.resolve(), target => walk(branch, target, fragment(path, link([anchor, branch.entry, target]))))
				: walk(branch, anchor, path);
		}

		function matchStage(stage: Flake, anchor: Variable, path: SPARQL): SPARQL {
			return stage.all !== undefined && !stage.pipe.some(isAggregate)
				? matchAll(expression(anchor, stage.pipe), path, optionsToTerms(stage.all, stage.range))
				: nil();
		}

	}

	function matchAll(value: SPARQL, patterns: SPARQL, options: readonly (null | Term)[]): SPARQL {
		return fragment(...options.map(option => option === null
			? filter(nexists(patterns))
			: filter(exists(patterns, filter(any(value, [option]))))
		));
	}

}
