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

import { Application, Comment, ReflectionKind } from "typedoc";

/**
 * Groups multi-entry packages in the project index by the `@group` tag of their `index` module.
 *
 * A single-entry package takes its module comment as its own, so the `@group` tag on it places the package in the
 * project index; a package exporting several entry points gets no comment of its own and would fall back to the
 * default *Modules* group. This plugin lends such a package the summary of its `index` module and moves its `@group`
 * tags onto the package, so every package is listed under the group its main module declares, while its own modules
 * stay listed together rather than split between that group and *Modules*.
 *
 * @param {import("typedoc").Application} app
 */
export function load(app) {

	// runs before GroupPlugin (priority -100) builds the project groups from the merged packages

	app.on(Application.EVENT_PROJECT_REVIVE, project => (project.children ?? [])
		.filter(pkg => pkg.kindOf(ReflectionKind.Module) && !pkg.comment)
		.map(pkg => ({ pkg, index: pkg.getChildByName("index")?.comment }))
		.filter(({ index }) => index?.blockTags.some(tag => tag.tag === "@group"))
		.forEach(({ pkg, index }) => { // TypeDoc models are mutated in place by design
			pkg.comment = new Comment(
				Comment.cloneDisplayParts(index.summary),
				index.blockTags.filter(tag => tag.tag === "@group").map(tag => tag.clone())
			);
			index.removeTags("@group"); // moved, so the package's own modules aren't split across groups
			delete pkg.groups; // computed per package before the merge, rebuilt by GroupPlugin without the moved tag
			delete pkg.categories;
		})
	);

}
