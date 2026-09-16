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
 * Producer-internal helpers for the flake IR.
 *
 * Utilities shared by the shape-, model-, and query-mode walks to assemble a node's property-major
 * {@link Entries}. Kept off the flake index's exported surface: only the flake producers
 * need them.
 *
 * @module
 */

import { getShapeTarget } from "@metreeca/blue/reference";
import { getModelBranches, getShapeBranches } from "@metreeca/blue/union";
import { effective, type Range, type Shape } from "@metreeca/blue/value";
import { type Identifier, isObject, isString, opt } from "@metreeca/core";
import { TraceError } from "@metreeca/core/trace";
import { encodeProbe, isVacuous, type Model, type Transform } from "@metreeca/qest/template";
import type { Branch, Entries } from "./index.js";


/**
 * The root node's effective {@link Range}: the driving `shape` enveloped as a range. The only
 * shape-to-range conversion in a flake — every other node's range is stepped from its parent's range.
 */
export function getRootRange(shape: Shape): Range {
	return getRange(shape, [], []);
}

/**
 * The child {@link Range} one property step from a node's `range` (§5.8.1): the value the `property`
 * edge resolves to, composing cardinality across the step (an `id` / `type` marker yielding the IRI range).
 */
export function getPropertyRange(range: Range, property: Identifier): Range {
	return getRange(range, [property], []);
}

/**
 * The {@link Range} a single `transform` produces from a stage's input `range` (§5.8.2): one stage
 * step, the pipe composed by nesting these rather than resolving the whole pipe at once.
 */
export function getTransformRange(range: Range, transform: Transform): Range {
	return getRange(range, [], [transform]);
}


/**
 * Resolves a probe against a shape or range through blue's {@link @metreeca/blue/value!effective | effective},
 * surfacing a {@link @metreeca/core!Trace | Trace} string (a contract violation, since models are validated at the Keep
 * boundary) as a {@link @metreeca/core!TraceError}. The shared engine behind {@link getRootRange} /
 * {@link getPropertyRange} / {@link getTransformRange}; every range in a flake is built incrementally through those,
 * never over a multi-step path.
 */
function getRange(source: Shape | Range, path: readonly Identifier[], pipe: readonly Transform[]): Range {

	// effective reads only path/pipe; target is required by the Probe guard but ignored, so a placeholder
	// identifier stands in (the empty string would be rejected as malformed)

	const probe = { target: "$", path, pipe };
	const range = effective(source, probe);

	if ( isString(range) ) {
		throw new TraceError(encodeProbe(probe), [range]);
	}

	return range;

}


/**
 * Assembles a node's property-major {@link Entries} from its effective range and the requested model.
 *
 * Folds the `model` fragment against `range`, emitting one {@link Branch} per requested property a variant
 * declares. A multi-variant range reads the §5.4 keyed form: each object-valued alternative is matched against the
 * variants and the per-variant records are merged through {@link mergeEntries}. A single-variant range folds the
 * whole model against that variant. Either way each reachable variant resolves its target and folds every model
 * entry against the target's declared properties: vacuous placeholders and names the target does not declare are
 * dropped, `id` and `type` entries become terminal branches, and property entries carry their requested fragment as
 * their {@link Flake.drain | drain}. Only a single-valued range expanded inline as a nested object is descended for
 * nested properties; a leaf placeholder or a multi-valued range (which carries a
 * {@link @metreeca/qest/template!Query | Query}) holds none (§6.2). `path` accumulates the branch path to this node
 * and is prefixed onto every emitted child branch.
 *
 * @param range The effective {@link Range} of the node whose properties are assembled
 * @param path  The branch path accumulated to this node, prefixed onto every emitted child branch
 * @param model The requested model fragment driving per-property reach
 *
 * @returns The property-major {@link Entries} record for the node, or `undefined` when no record applies: a
 * non-object `model`, or a range no variant of which contributes a record (no variant resolves an owned target, or
 * a multi-variant range's alternatives match no variant)
 */
export function getEntries(range: Range, path: readonly Identifier[], model: Model): Entries | undefined {

	// each reachable variant folds its model fragment against its target's declared properties, merged across
	// variants: a multi-variant range reads the §5.4 keyed union form (each object-valued alternative matched to
	// the variants it fits by kind), a single-variant range takes the whole model

	const variants = getShapeBranches(range.shape);

	if ( !isObject(model) ) {

		return undefined;

	} else if ( variants.length > 1 ) {

		return mergeEntries(Object.values(model).filter(v => isObject(v)).flatMap(alternative =>
			getModelBranches(alternative, variants)?.flatMap(variant => descend(variant, alternative)) ?? []
		));

	} else {

		return mergeEntries(variants.flatMap(variant =>
			descend(variant, model)
		));

	}


	function descend(shape: Shape, model: Model) {
		return opt(getShapeTarget(shape), target => {

			if ( isObject(model) ) {

				return [Object.fromEntries(Object.entries(model).flatMap<[Identifier, Branch[]]>(([k, v]) => {

					const field = target.members[k];
					const lower: readonly Identifier[] = [...path, k];

					if ( isVacuous(v) || field === undefined ) {

						return [];

					} else if ( field.kind === "id" || field.kind === "type" ) {

						return [[k, [{

							entry: field,

							path: lower,
							pipe: [],

							range: getPropertyRange(range, k)

						}]]];

					} else if ( field.kind === "property" ) {

						const child = getPropertyRange(range, k);

						const entries = child.maxCount === 1 && isObject(v)
							? getEntries(child, lower, v)
							: undefined;

						return [[k, [{

							...(entries ? { entries } : {}),

							entry: field,

							path: lower,
							pipe: [],

							range: child,
							drain: { mould: v }

						}]]];

					} else {

						return [];

					}

				}))];

			} else {

				return [];

			}

		}, []);
	}

}

/**
 * Merges per-variant property-major {@link Entries} records into one.
 *
 * Concatenates the branches under each shared property name, so a name declared by several variants
 * keeps every declaring branch, never a lossy merge. With no records there are no properties, so the
 * result is `undefined` and the caller omits the slot.
 *
 * @param entries The per-variant property-major records, in variant order
 *
 * @returns The merged property-major {@link Entries} record (property names in first-seen order,
 * branches in variant order), or `undefined` when `entries` is empty
 */
export function mergeEntries(entries: readonly Entries[]): undefined | Entries {

	return entries.length === 0 ? undefined
		: entries.flatMap(record => Object.entries(record)).reduce<Entries>(
			(merged, [name, branches]) => ({ ...merged, [name]: [...(merged[name] ?? []), ...branches] }),
			{}
		);

}
