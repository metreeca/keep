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
 * Model-mode walk for {@link createFlake}.
 *
 * Joint walk over a shape and a retrieval template: every model key is matched against the resource
 * shape's declared properties, and only entries that survive the filters land in the {@link Flake}
 * tree. Selectors, vacuous placeholders, and unknown property names are filtered. The `id` and `type`
 * template entries are kept as terminal branches;
 * each remaining property entry carries the template fragment requested for it as its
 * {@link Flake.drain | drain}, the node retrieving it on a multi-valued property and the requested fragment on a
 * single-valued one.
 *
 * Well-formed input is assumed at the Keep boundary: no input checking is performed beyond the
 * structural filters above.
 *
 * @module
 */

import { type Shape } from "@metreeca/blue/value";
import { immutable } from "@metreeca/core/values";
import { type Template } from "@metreeca/qest/model";
import { getEntries, getRootRange } from "./index.core.js";
import { type Flake } from "./index.js";


/**
 * Builds the model-mode {@link Flake} from a root shape and a retrieval model.
 *
 * Internal entry point: public callers go through the dispatcher in {@link createFlake}, which routes
 * the `(Shape, Model)` call shape here.
 *
 * Property branches form only on a resource root; a non-resource root yields a degenerate leaf flake.
 *
 * @param shape The shape rooting the walk
 * @param model The retrieval model driving per-property reach
 *
 * @returns The immutable {@link Flake} rooted at `shape`, carrying the whole model on its
 * {@link Flake.drain | drain} and with model-driven branches in {@link Flake.entries | entries}
 */
export function createModelFlake(shape: Shape, model: Template): Flake {

	const range = getRootRange(shape);

	return immutable(shape.kind === "resource"
		? { path: [], pipe: [], range, drain: { mould: model }, entries: getEntries(range, [], model) ?? {} }
		: { path: [], pipe: [], range, drain: { mould: model } }
	);

}
