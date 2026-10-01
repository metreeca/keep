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

import { defineConfig } from "vitest/config";

export default defineConfig({

	/**
	 * Resolves workspace package imports to the TypeScript source their exports declare, as `tsconfig.json` does
	 * through `customConditions`, so tests run build-free against the working tree rather than against `dist`.
	 */
	ssr: {
		resolve: {
			conditions: ["@metreeca/source"]
		}
	},

	/**
	 * Resolves shared dependencies to a single copy, so sibling repositories linked by `npm run setup` share the
	 * classes this workspace checks against (`instanceof TraceError` and the like) rather than loading their own.
	 */
	resolve: {
		dedupe: ["@metreeca/core", "@metreeca/qest"]
	},

	test: {

		/**
		 * Allows workspace packages without test files to pass cleanly during `npm run check --workspaces`.
		 */
		passWithNoTests: true,

		/**
		 * Type-tests each package against its own compiler options: `npm run check` runs vitest from every workspace
		 * package in turn, so the path resolves against the package being checked, never against this file.
		 */
		typecheck: {
			include: ["**/src/**/*.test-d.ts"],
			tsconfig: "tsconfig.json"
		}

	}

});
