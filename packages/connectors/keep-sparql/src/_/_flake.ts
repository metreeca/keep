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

import { getShapeProperties } from "@metreeca/blue/resource";
import { getShapeBranches } from "@metreeca/blue/union";
import { eager } from "@metreeca/blue/value";
import {
	type Branch,
	type Flake,
	getFlakeEntries,
	getFlakeTransforms,
	isConstrainedFlake,
	isDrainedFlake,
	isPropertyBranch,
	isScalarFlake
} from "@metreeca/keep-flake";


export function isXComputed(branch: Flake): boolean {
	return isDrainedFlake(branch)
		|| isConstrainedFlake(branch)
		|| bindsComputed(branch);
}

export function isXScalar(branch: Flake): boolean {
	return isDrainedFlake(branch)
		|| isConstrainedFlake(branch)
		|| bindsScalar(branch);
}

function bindsComputed(flake: Flake): boolean {
	return getFlakeTransforms(flake).length > 0 // every transform stage is computed (Flake.pipe non-empty)
		|| getFlakeEntries(flake).some(bindsComputed);
}

function bindsScalar(flake: Flake): boolean {
	return getFlakeTransforms(flake).some(isScalarFlake)
		|| getFlakeEntries(flake).some(bindsScalar);
}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Whether a union node is a crossing intermediate: a path step under a shared predicate (§5.8.1) whose own
 * value is never surfaced (no projection alias, no direct constraint / ordering / focus) and all of whose
 * branches every variant declares. Such a node is traversed like a resource — its shared branches descended
 * once off the anchor — rather than fanned into a membership-gated arm per variant. A surfaced union (a
 * projected or constrained column) or one carrying a variant-specific branch keeps the arm machinery.
 *
 * `isDrainedFlake` / `isConstrainedFlake` are recursive (they reach descendant columns), so this checks the
 * node's own slots directly: a deeper aliased or constrained column is what the crossing navigates toward.
 */
export function crossing(flake: Flake): boolean {

	return flake.drain?.alias === undefined && !surfaced(flake) && shared(flake);

	function surfaced(flake: Flake): boolean {
		return [flake.lt, flake.gt, flake.lte, flake.gte, flake.like, flake.any, flake.all, flake.order, flake.focus]
			.some(slot => slot !== undefined);
	}

	function shared(flake: Flake): boolean {

		// a childless union is a leaf column whose own references are retrieved (a bare `media` placeholder),
		// not an intermediate step; it keeps the arm machinery to bind its variant shards

		const branches = getFlakeEntries(flake);

		return branches.length > 0 && branches.every(branch => getShapeBranches(flake.range.shape).every(variant =>
			getShapeProperties(variant)[branch.path[branch.path.length-1]] !== undefined
		));
	}

}

export function references(branch: Branch): boolean {
	return branch.entry.kind === "id" || branch.entry.kind === "type" ? true
		: isPropertyBranch(branch) ? eager(branch.entry.range.shape).kind === "reference"
			: false;
}
