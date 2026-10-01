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
 * Joint walk over a shape and a retrieval template: every template key is matched against the resource shape's
 * declared properties, and only matching entries land in the {@link Flake} tree. Criteria keys and unknown property
 * names are dropped. The `id` and `type` template entries are kept as terminal branches. Each remaining property
 * entry carries the query requested for it as its {@link Flake.drain | drain}: a collection query, criteria
 * included, on a multi-valued property, a placeholder on a single-valued one.
 *
 * Well-formed input is assumed at the Keep boundary: no input checking is performed beyond the
 * structural filters above.
 *
 * @module
 */

import { type Shape } from "@metreeca/blue/value";
import { immutable } from "@metreeca/core/values";
import { type Template } from "@metreeca/qest/model";
import { getDrain, getEntries, getRootRange } from "./index.core.js";
import { type Flake } from "./index.js";


/**
 * Builds the model-mode {@link Flake} from a root shape and a retrieval template.
 *
 * Internal entry point: public callers go through {@link createFlake}, which routes the `(shape, model)` call
 * here.
 *
 * Property branches form only on a resource root; a non-resource root yields a degenerate leaf flake, which
 * admits no template and so carries no {@link Flake.drain | drain}.
 *
 * @param shape The shape rooting the walk
 * @param model The retrieval template driving per-property reach
 *
 * @returns The immutable {@link Flake} rooted at `shape`, carrying the whole template on its
 * {@link Flake.drain | drain} and with template-driven branches in {@link Flake.entries | entries}
 */
export function createModelFlake(shape: Shape, model: Template): Flake {

	const range = getRootRange(shape);

	// a non-resource root admits no template, so the model it is handed requests nothing of it

	return immutable(shape.kind === "resource"
		? {
			path: [],
			pipe: [],
			range,
			drain: getDrain(range, model),
			entries: getEntries(range, [], model) ?? {}
		}
		: { path: [], pipe: [], range }
	);

}
