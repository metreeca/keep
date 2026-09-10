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

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { defineConfig } from "vitest/config";

const packages = join(__dirname, "packages");

const groups = readdirSync(packages, { withFileTypes: true })
	.filter(entry => entry.isDirectory())
	.map(entry => join(packages, entry.name));

/**
 * Locates a workspace package root across the grouped `packages/<group>/<package>` layout.
 *
 * @param pkg - The package directory name (for example, `keep` or `keep-sparql`)
 *
 * @returns The absolute package root path, or `null` if no group contains the package
 */
function root(pkg: string): string | null {
	return groups.map(group => join(group, pkg)).find(existsSync) ?? null;
}

export default defineConfig({

	test: {

		/**
		 * Allows workspace packages without test files to pass cleanly during `npm run check --workspaces`.
		 */
		passWithNoTests: true,

		typecheck: {
			include: ["**/src/**/*.test-d.ts"],
			tsconfig: "packages/components/keep/tsconfig.json"
		}

	},

	plugins: [{

		name: "keep-resolver",
		enforce: "pre",

		/**
		 * Resolves `@metreeca/keep*` workspace imports to TypeScript source for build-free testing.
		 *
		 * - `@metreeca/keep-pkg` → `packages/<group>/keep-pkg/src/index.ts`
		 * - `@metreeca/keep-pkg/module` → `packages/<group>/keep-pkg/src/module.ts` or
		 *   `packages/<group>/keep-pkg/src/module/index.ts`
		 *
		 * @param id - The module specifier to resolve
		 *
		 * @returns The resolved file path, or `null` if the specifier does not match
		 */
		resolveId(id: string) {

			const bare = id.match(/^@metreeca\/(keep[^/]*)$/);

			if ( bare ) { // bare package import

				const dir = root(bare[1]);

				return dir && join(dir, "src", "index.ts");

			} else { // subpath import

				const module = id.match(/^@metreeca\/(keep[^/]*)\/(.+)$/);

				if ( module ) {

					const dir = root(module[1]);

					const named = dir && join(dir, "src", `${module[2]}.ts`);
					const index = dir && join(dir, "src", module[2], "index.ts");

					return named && existsSync(named) ? named
						: index && existsSync(index) ? index
							: null;

				} else {

					return null;

				}

			}

		}

	}]

});
