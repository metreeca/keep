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


import { reference } from "@metreeca/blue/reference";
import {
	getShapeClass,
	getShapeClasses,
	getShapeType,
	id,
	multiple,
	required,
	resource as shaped,
	type ResourceShape
} from "@metreeca/blue/resource";
import { string, type StringShape } from "@metreeca/blue/string";
import { eager, type Shape, type State } from "@metreeca/blue/value";
import { error, isBoolean, isNumber, isString, type Lazy, map, type Scalar } from "@metreeca/core";
import { some, type Some } from "@metreeca/core/arrays";
import { xsd } from "@metreeca/core/datatype";
import type { Tag } from "@metreeca/core/language";
import { createNamespace } from "@metreeca/core/resource";
import { immutable } from "@metreeca/core/values";
import { createSPARQLStore } from "@metreeca/keep-sparql";
import type { StoreTestScope } from "@metreeca/keep-suite";
import { testStore } from "@metreeca/keep-suite";
import {
	base,
	catalogues,
	Category,
	clone,
	collections,
	identify,
	Image,
	Place,
	PostalAddress,
	Product,
	rdfs,
	Resources,
	Review,
	toys,
	Vendor,
	Vendors,
	Video
} from "@metreeca/keep-suite/toys";
import { type Reference, type Resource } from "@metreeca/qest/state";
import { log } from "@metreeca/tape";
import { blank, skolemize, tagged, type Tagged, type Triple, typed } from "@metreeca/trio";
import { data, description as resource, link, property, resource as about, term } from "@metreeca/trio/builder";
import type { Repository } from "@metreeca/wire-sparql";
import { createHTTPRepository } from "@metreeca/wire-sparql-http";
import { createOxiRepository } from "@metreeca/wire-sparql-oxigraph";
import { createRDF4JRepository } from "@metreeca/wire-sparql-rdf4j";
import { pattern, patterns, triples } from "@metreeca/wire-sparql/builder";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";


/**
 * Maximum time (in milliseconds) allotted to each backend's `beforeAll` hook for spinning up its
 * docker container. Generous enough to absorb image-pull latency on first run.
 */
const timeout = 120_000;

const logger = log(import.meta.url);

log({
	"/": "debug"
});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * @see {@link https://oxigraph.org/ Oxigraph}
 * @see {@link https://github.com/oxigraph/oxigraph/blob/main/js/README.md Oxigraph JavaScript/WASM API}
 */
describe("oxigraph", () => {

	// in-process WebAssembly build, run by default; the same-named container block below exercises the HTTP server

	testSPARQLStore(createOxiRepository, {

		ignore: ["ManageClose"] // close() is a no-op

	});

});

/**
 * @see {@link https://rdf4j.org/ Eclipse RDF4J}
 * @see {@link https://github.com/eclipse-rdf4j/rdf4j Eclipse RDF4J on GitHub}
 * @see {@link https://rdf4j.org/documentation/programming/repository/ RDF4J repository / sail config}
 * @see {@link https://hub.docker.com/r/eclipse/rdf4j-workbench eclipse/rdf4j-workbench image}
 */
describe("rdf4j-memory", () => {

	const image = "eclipse/rdf4j-workbench:5.3.1-tomcat";

	const port = 8080;
	const repo = "test";

	const config = `
		@prefix config: <tag:rdf4j.org,2023:config/> .
		@prefix mem: <http://rdf4j.org/config/sail/memory#> .

		[] a config:Repository ;
		   config:rep.id "${repo}" ;
		   config:rep.impl [
			   config:rep.type "openrdf:SailRepository" ;
			   config:sail.impl [
				   config:sail.type "openrdf:MemoryStore" ;
				   mem:persist false
			   ]
		   ] .
	`;


	let base: string;
	let container: StartedTestContainer;


	beforeAll(async () => {

		logger.info`starting ${image}`;

		container = await new GenericContainer(image)
			.withExposedPorts(port)
			.withWaitStrategy(Wait.forHttp("/rdf4j-server/protocol", port))
			.start();

		base = `http://${container.getHost()}:${container.getMappedPort(port)}/rdf4j-server`;

		logger.info`container started at ${base}`;

		const response = await fetch(`${base}/repositories/${repo}`, {
			method: "PUT",
			headers: { "Content-Type": "text/turtle" },
			body: config
		});

		if ( !response.ok ) {
			throw new Error(`failed to create rdf4j repository: ${response.status} ${await response.text()}`);
		}

		logger.info`repository ${repo} ready`;

	}, timeout);

	afterAll(() => container?.stop());


	describe("createHTTPRepository", () => {

		testSPARQLStore(() => createHTTPRepository({

			query: `${base}/repositories/${repo}`,
			update: `${base}/repositories/${repo}/statements`

		}), {

			ignore: ["ManageClose"]

		});

	});

	describe("createRDF4JRepository", () => {

		testSPARQLStore(() => createRDF4JRepository({

			server: base,
			repository: repo

		}), {

			ignore: ["ManageClose"]

		});

	});

});

/**
 * @see {@link https://rdf4j.org/ Eclipse RDF4J}
 * @see {@link https://github.com/eclipse-rdf4j/rdf4j Eclipse RDF4J on GitHub}
 * @see {@link https://rdf4j.org/documentation/programming/repository/ RDF4J repository / sail config}
 * @see {@link https://hub.docker.com/r/eclipse/rdf4j-workbench eclipse/rdf4j-workbench image}
 */
describe.skipIf(!process.env.RDF4J_NATIVE)("rdf4j-native", () => {

	const image = "eclipse/rdf4j-workbench:5.3.1-tomcat";

	const port = 8080;
	const repo = "test";

	const config = `
		@prefix config: <tag:rdf4j.org,2023:config/> .
		@prefix native: <http://rdf4j.org/config/sail/native#> .

		[] a config:Repository ;
		   config:rep.id "${repo}" ;
		   config:rep.impl [
			   config:rep.type "openrdf:SailRepository" ;
			   config:sail.impl [
				   config:sail.type "openrdf:NativeStore" ;
				   native:tripleIndexes "spoc,posc"
			   ]
		   ] .
	`;


	let base: string;
	let container: StartedTestContainer;


	beforeAll(async () => {

		logger.info`starting ${image}`;

		container = await new GenericContainer(image)
			.withExposedPorts(port)
			.withWaitStrategy(Wait.forHttp("/rdf4j-server/protocol", port))
			.start();

		base = `http://${container.getHost()}:${container.getMappedPort(port)}/rdf4j-server`;

		logger.info`container started at ${base}`;

		const response = await fetch(`${base}/repositories/${repo}`, {
			method: "PUT",
			headers: { "Content-Type": "text/turtle" },
			body: config
		});

		if ( !response.ok ) {
			throw new Error(`failed to create rdf4j repository: ${response.status} ${await response.text()}`);
		}

		logger.info`repository ${repo} ready`;

	}, timeout);

	afterAll(() => container?.stop());


	describe("createHTTPRepository", () => {

		testSPARQLStore(() => createHTTPRepository({

			query: `${base}/repositories/${repo}`,
			update: `${base}/repositories/${repo}/statements`

		}), {

			ignore: ["ManageClose"]

		});

	});

	describe("createRDF4JRepository", () => {

		testSPARQLStore(() => createRDF4JRepository({

			server: base,
			repository: repo

		}), {

			ignore: ["ManageClose"]

		});

	});

});

/**
 * @see {@link https://rdf4j.org/ Eclipse RDF4J}
 * @see {@link https://github.com/eclipse-rdf4j/rdf4j Eclipse RDF4J on GitHub}
 * @see {@link https://rdf4j.org/documentation/programming/lmdb-store/ LmdbStore configuration}
 * @see {@link https://hub.docker.com/r/eclipse/rdf4j-workbench eclipse/rdf4j-workbench image}
 */
describe.skipIf(!process.env.RDF4J_LMDB)("rdf4j-lmdb", () => {

	const image = "eclipse/rdf4j-workbench:5.3.1-tomcat";

	const port = 8080;
	const repo = "test";

	const config = `
		@prefix config: <tag:rdf4j.org,2023:config/> .
		@prefix lmdb: <http://rdf4j.org/config/sail/lmdb#> .

		[] a config:Repository ;
		   config:rep.id "${repo}" ;
		   config:rep.impl [
			   config:rep.type "openrdf:SailRepository" ;
			   config:sail.impl [
				   config:sail.type "rdf4j:LmdbStore" ;
				   lmdb:tripleIndexes "spoc,posc"
			   ]
		   ] .
	`;


	let base: string;
	let container: StartedTestContainer;


	beforeAll(async () => {

		logger.info`starting ${image}`;

		container = await new GenericContainer(image)
			.withExposedPorts(port)
			.withWaitStrategy(Wait.forHttp("/rdf4j-server/protocol", port))
			.start();

		base = `http://${container.getHost()}:${container.getMappedPort(port)}/rdf4j-server`;

		logger.info`container started at ${base}`;

		const response = await fetch(`${base}/repositories/${repo}`, {
			method: "PUT",
			headers: { "Content-Type": "text/turtle" },
			body: config
		});

		if ( !response.ok ) {
			throw new Error(`failed to create rdf4j repository: ${response.status} ${await response.text()}`);
		}

		logger.info`repository ${repo} ready`;

	}, timeout);

	afterAll(() => container?.stop());


	describe("createHTTPRepository", () => {

		testSPARQLStore(() => createHTTPRepository({

			query: `${base}/repositories/${repo}`,
			update: `${base}/repositories/${repo}/statements`

		}), {

			ignore: ["ManageClose"]

		});

	});

	describe("createRDF4JRepository", () => {

		testSPARQLStore(() => createRDF4JRepository({

			server: base,
			repository: repo

		}), {

			ignore: ["ManageClose"]

		});

	});

});

/**
 * @see {@link https://jena.apache.org/ Apache Jena}
 * @see {@link https://github.com/apache/jena Apache Jena on GitHub}
 * @see {@link https://jena.apache.org/documentation/fuseki2/ Apache Jena Fuseki}
 * @see {@link https://jena.apache.org/documentation/assembler/ Jena assembler configuration}
 * @see {@link https://hub.docker.com/r/secoresearch/fuseki secoresearch/fuseki image}
 */
describe.skipIf(!process.env.FUSEKI_MEMORY)("fuseki-memory", () => {

	const image = "ghcr.io/kurrawong/fuseki:6.1.0-0";

	const port = 3030;
	const dataset = "ds";

	// the image ships no dataset, so supply a clean in-memory dataset assembler; the
	// entrypoint copies any ttl under /opt/fuseki/configuration into the writable runtime
	// base (/fuseki/configuration), which jena auto-loads as a service at startup

	const assembler = `
			@prefix fuseki: <http://jena.apache.org/fuseki#> .
			@prefix rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
			@prefix ja:     <http://jena.hpl.hp.com/2005/11/Assembler#> .
			@prefix :       <#> .

			<#service> rdf:type fuseki:Service ;
				fuseki:name                       "${dataset}" ;
				fuseki:serviceQuery               "sparql" ;
				fuseki:serviceUpdate              "update" ;
				fuseki:serviceReadWriteGraphStore "data" ;
				fuseki:dataset                    <#mem> .

			<#mem> rdf:type ja:MemoryDataset .
		`;


	let base: string;
	let container: StartedTestContainer;


	beforeAll(async () => {

		logger.info`starting ${image}`;

		container = await new GenericContainer(image)
			.withCopyContentToContainer([{
				content: assembler,
				target: "/opt/fuseki/configuration/assembler.ttl"
			}])
			.withExposedPorts(port)
			.withWaitStrategy(Wait.forHttp("/$/ping", port))
			.start();

		base = `http://${container.getHost()}:${container.getMappedPort(port)}`;

		logger.info`container started at ${base}`;

	}, timeout);

	afterAll(() => container?.stop());


	describe("createHTTPRepository", () => {

		testSPARQLStore(() => createHTTPRepository({

			query: `${base}/${dataset}/sparql`,
			update: `${base}/${dataset}/update`

		}), {

			ignore: ["ManageClose"]

		});

	});

});

/**
 * @see {@link https://jena.apache.org/ Apache Jena}
 * @see {@link https://github.com/apache/jena Apache Jena on GitHub}
 * @see {@link https://jena.apache.org/documentation/tdb/ Apache Jena TDB1 disk-backed store}
 * @see {@link https://jena.apache.org/documentation/assembler/ Jena assembler configuration}
 * @see {@link https://hub.docker.com/r/secoresearch/fuseki secoresearch/fuseki image}
 */
describe.skipIf(!process.env.FUSEKI_TDB1)("fuseki-tdb1", () => {

	const image = "ghcr.io/kurrawong/fuseki:6.1.0-0";

	const port = 3030;
	const dataset = "ds";

	// the image ships no dataset, so supply a clean TDB1 disk-backed dataset assembler; the
	// entrypoint copies any ttl under /opt/fuseki/configuration into the writable runtime
	// base (/fuseki/configuration), which jena auto-loads as a service at startup

	const assembler = `
			@prefix fuseki: <http://jena.apache.org/fuseki#> .
			@prefix rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
			@prefix tdb:    <http://jena.hpl.hp.com/2008/tdb#> .
			@prefix :       <#> .

			<#service> rdf:type fuseki:Service ;
				fuseki:name                       "${dataset}" ;
				fuseki:serviceQuery               "sparql" ;
				fuseki:serviceUpdate              "update" ;
				fuseki:serviceReadWriteGraphStore "data" ;
				fuseki:dataset                    <#tdb> .

			<#tdb> rdf:type tdb:DatasetTDB ;
				tdb:location "/fuseki/databases/tdb" .
		`;


	let base: string;
	let container: StartedTestContainer;


	beforeAll(async () => {

		logger.info`starting ${image}`;

		container = await new GenericContainer(image)
			.withCopyContentToContainer([{
				content: assembler,
				target: "/opt/fuseki/configuration/assembler.ttl"
			}])
			.withExposedPorts(port)
			.withWaitStrategy(Wait.forHttp("/$/ping", port))
			.start();

		base = `http://${container.getHost()}:${container.getMappedPort(port)}`;

		logger.info`container started at ${base}`;

	}, timeout);

	afterAll(() => container?.stop());


	describe("createHTTPRepository", () => {

		testSPARQLStore(() => createHTTPRepository({

			query: `${base}/${dataset}/sparql`,
			update: `${base}/${dataset}/update`

		}), {

			ignore: ["ManageClose"]

		});

	});

});

/**
 * @see {@link https://jena.apache.org/ Apache Jena}
 * @see {@link https://github.com/apache/jena Apache Jena on GitHub}
 * @see {@link https://jena.apache.org/documentation/tdb2/ Apache Jena TDB2 disk-backed store}
 * @see {@link https://jena.apache.org/documentation/assembler/ Jena assembler configuration}
 * @see {@link https://hub.docker.com/r/secoresearch/fuseki secoresearch/fuseki image}
 */
describe.skipIf(!process.env.FUSEKI_TDB2)("fuseki-tdb2", () => {

	const image = "ghcr.io/kurrawong/fuseki:6.1.0-0";

	const port = 3030;
	const dataset = "ds";

	// the image ships no dataset, so supply a clean TDB2 disk-backed dataset assembler; the
	// entrypoint copies any ttl under /opt/fuseki/configuration into the writable runtime
	// base (/fuseki/configuration), which jena auto-loads as a service at startup

	const assembler = `
			@prefix fuseki: <http://jena.apache.org/fuseki#> .
			@prefix rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
			@prefix tdb2:   <http://jena.apache.org/2016/tdb#> .
			@prefix :       <#> .

			<#service> rdf:type fuseki:Service ;
				fuseki:name                       "${dataset}" ;
				fuseki:serviceQuery               "sparql" ;
				fuseki:serviceUpdate              "update" ;
				fuseki:serviceReadWriteGraphStore "data" ;
				fuseki:dataset                    <#tdb2> .

			<#tdb2> rdf:type tdb2:DatasetTDB2 ;
				tdb2:location "/fuseki/databases/tdb2" .
		`;


	let base: string;
	let container: StartedTestContainer;


	beforeAll(async () => {

		logger.info`starting ${image}`;

		container = await new GenericContainer(image)
			.withCopyContentToContainer([{
				content: assembler,
				target: "/opt/fuseki/configuration/assembler.ttl"
			}])
			.withExposedPorts(port)
			.withWaitStrategy(Wait.forHttp("/$/ping", port))
			.start();

		base = `http://${container.getHost()}:${container.getMappedPort(port)}`;

		logger.info`container started at ${base}`;

	}, timeout);

	afterAll(() => container?.stop());


	describe("createHTTPRepository", () => {

		testSPARQLStore(() => createHTTPRepository({

			query: `${base}/${dataset}/sparql`,
			update: `${base}/${dataset}/update`

		}), {

			ignore: ["ManageClose"]

		});

	});

});

/**
 * @see {@link https://oxigraph.org/ Oxigraph}
 * @see {@link https://github.com/oxigraph/oxigraph Oxigraph on GitHub}
 * @see {@link https://hub.docker.com/r/oxigraph/oxigraph oxigraph/oxigraph image}
 */
describe.skipIf(!process.env.OXIGRAPH)("oxigraph", () => {

	const image = "oxigraph/oxigraph:0.5.8";

	const port = 7878;


	let base: string;
	let container: StartedTestContainer;


	beforeAll(async () => {

		logger.info`starting ${image}`;

		container = await new GenericContainer(image)
			.withCommand(["serve", "--bind", "0.0.0.0:7878", "--location", "/data"])
			.withExposedPorts(port)
			.withWaitStrategy(Wait.forHttp("/", port))
			.start();

		base = `http://${container.getHost()}:${container.getMappedPort(port)}`;

		logger.info`container started at ${base}`;

	}, timeout);

	afterAll(() => container?.stop());


	describe("createHTTPRepository", () => {

		testSPARQLStore(() => createHTTPRepository({

			query: `${base}/query`,
			update: `${base}/update`

		}), {

			ignore: ["ManageClose"]

		});

	});

});

/**
 * @see {@link https://qlever.dev/ QLever}
 * @see {@link https://github.com/ad-freiburg/qlever QLever on GitHub}
 * @see {@link https://docs.qlever.dev/ QLever documentation}
 * @see {@link https://hub.docker.com/r/adfreiburg/qlever adfreiburg/qlever image}
 */
describe.skipIf(!process.env.QLEVER)("qlever", () => {

	const image = "adfreiburg/qlever:commit-15bbdad"; // tracks GitHub release v0.5.48

	const port = 7001;


	let base: string;
	let container: StartedTestContainer;


	beforeAll(async () => {

		logger.info`starting ${image}`;

		// bypass the docker-entrypoint.sh UID/GID wrapper, build an index from an empty
		// n-triples file, then start the SPARQL server with in-place updates enabled and
		// access-token checks disabled (createHTTPRepository has no auth-header support)

		const bootstrap = [
			"set -e",
			": > /tmp/empty.nt",
			"/qlever/qlever-index -i /tmp/test -F nt -f /tmp/empty.nt",
			`/qlever/qlever-server -i /tmp/test -p ${port} -n --persist-updates`
		].join(" && ");

		container = await new GenericContainer(image)
			.withEntrypoint(["/bin/bash", "-c"])
			.withCommand([bootstrap])
			.withExposedPorts(port)
			.withWaitStrategy(Wait.forLogMessage(/listening for requests on port/))
			.start();

		base = `http://${container.getHost()}:${container.getMappedPort(port)}`;

		logger.info`container started at ${base}`;

	}, timeout);

	afterAll(() => container?.stop());


	describe("createHTTPRepository", () => {

		testSPARQLStore(() => createHTTPRepository({

			query: base,
			update: base

		}), {

			ignore: ["ManageClose"]

		});

	});

});

/**
 * @see {@link https://virtuoso.openlinksw.com/ Virtuoso}
 * @see {@link https://github.com/openlink/virtuoso-opensource Virtuoso Open Source on GitHub}
 * @see {@link https://docs.openlinksw.com/virtuoso/ Virtuoso documentation}
 * @see {@link https://docs.openlinksw.com/virtuoso/ch-rdfandsparql/ RDF and SPARQL in Virtuoso}
 * @see {@link https://hub.docker.com/r/openlink/virtuoso-opensource-7 openlink/virtuoso-opensource-7 image}
 */
describe.skipIf(!process.env.VIRTUOSO)("virtuoso", () => {

	const image = "openlink/virtuoso-opensource-7:7.2.17";

	const port = 8890;
	const isql = 1111;
	const graph = "urn:keep:default";


	let base: string;
	let container: StartedTestContainer;


	beforeAll(async () => {

		logger.info`starting ${image}`;

		container = await new GenericContainer(image)
			.withEnvironment({ DBA_PASSWORD: "dba" })
			.withExposedPorts(port, isql)
			.withWaitStrategy(Wait.forHttp("/sparql", port))
			.start();

		// virtuoso requires explicit graphs in INSERT DATA / DELETE DATA, refuses anonymous
		// SPARQL UPDATE by default, and starts with the SPARQL_ADMIN role narrowly scoped:
		// raise SPARQL_ADMIN, broaden the anonymous user to match, and grant SPARQL_UPDATE
		// to the SPARQL role so unauthenticated POSTs can mutate data

		const grants = [
			"DB.DBA.RDF_DEFAULT_USER_PERMS_SET ('SPARQL_ADMIN', 255);",
			"DB.DBA.RDF_DEFAULT_USER_PERMS_SET ('nobody', 255);",
			`GRANT SPARQL_UPDATE TO "SPARQL";`
		].join(" ");

		const { exitCode, output } = await container.exec(["isql", "1111", "dba", "dba", `exec=${grants}`]);

		if ( exitCode !== 0 ) {
			throw new Error(`failed to grant virtuoso SPARQL update permissions: ${output}`);
		}

		// route both query and update through default-graph-uri so INSERT DATA / DELETE DATA
		// without an explicit GRAPH clause land in a single test-scoped graph
		base = `http://${container.getHost()}:${container.getMappedPort(port)}/sparql`
			+`?default-graph-uri=${encodeURIComponent(graph)}`;

		logger.info`container started at ${base}`;

	}, timeout);

	afterAll(() => container?.stop());


	describe("createHTTPRepository", () => {

		testSPARQLStore(() => createHTTPRepository({

			query: base,
			update: base

		}), {

			ignore: ["ManageClose"]

		});

	});

});


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Namespace for the RDF `type` term used to assert resource classes.
 */
const rdf = createNamespace("http://www.w3.org/1999/02/22-rdf-syntax-ns#", ["type"]);


/**
 * A deeply-partial {@link State} of a toys resource shape, the input form accepted by the `encode*` encoders.
 */
type Fragment<T extends Lazy<Shape>> = Partial<State<T>>;


/**
 * The toys sample dataset encoded as RDF triples, seeding the conformance suite's populate step.
 */
const dataset: readonly Triple[] = immutable([

	...collections.categories.flatMap(encodeCategory),
	...collections.vendors.flatMap(encodeVendor),
	...collections.products.flatMap(encodeProduct),
	...collections.images.flatMap(encodeImage),
	...collections.videos.flatMap(encodeVideo),

	...encodeCatalogue(catalogues.resources),
	...encodeCatalogue(catalogues.categories),
	...encodeCatalogue(catalogues.vendors),
	...encodeCatalogue(catalogues.products)

]);

/**
 * Triple encoders keyed by resolved shape class, dispatched by the store assertions to encode a resource's expected
 * triples.
 */
const encoders = (() => {

	return immutable(Object.fromEntries([

		encoder(Resources, encodeCatalogue),
		encoder(Category, encodeCategory),
		encoder(Vendor, encodeVendor),
		encoder(PostalAddress, encodePostalAddress),
		encoder(Place, encodePlace),
		encoder(Product, encodeProduct),
		encoder(Image, encodeImage),
		encoder(Video, encodeVideo),
		encoder(Review, encodeReview)

	]));


	function encoder<S extends Lazy<ResourceShape>>(
		shape: S,
		encode: (resource: Fragment<S>) => readonly Triple[]
	): readonly [Reference, (resource: Resource) => readonly Triple[]] {

		const clazz = getShapeClass(shape);

		if ( clazz === undefined ) {
			throw new Error(`undefined class in shape`);
		}

		return [clazz, resource => {

			if ( !isInstance(shape, resource) ) {
				throw new Error(`mismatched resource for shape <${clazz}>`);
			}

			return encode(resource);

		}];

	}

})();

/**
 * Tests whether a resource is consistent with a shape's class.
 *
 * Accepts a resource that omits the type discriminator (a partial probe) and rejects only an explicit class mismatch.
 */
function isInstance<S extends Lazy<ResourceShape>>(
	shape: S,
	resource: Resource
): resource is State<S> & Resource {

	return map(eager(shape), shape =>
		(resource[getShapeType(shape) ?? ""] ?? shape.class) === shape.class
	);

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Runs the store conformance suite against a SPARQL connector.
 *
 * Creates a managed repository via `factory`, wires it into the {@link testStore} harness, and adds SPARQL storage
 * assertions.
 *
 * @param factory - Creates a managed repository for the connector under test
 * @param options - Optional sub-suite or test filtering via {@link StoreTestScope.target | target} and
 *     {@link StoreTestScope.ignore | ignore}
 */
function testSPARQLStore(factory: () => Repository, {

	target,
	ignore

}: StoreTestScope = {}): void {

	let repository: Repository;

	// skolemise blank-node anchors to concrete IRIs before insertion: critical to stay aligned with the store's insert
	// encoder, which mints embedded sub-resources as IRIs, so seeded and store-written data stay indistinguishable

	async function insert(state: readonly Triple[]): Promise<void> {
		await repository.update(`insert data { ${triples(skolemize(state))} }`);
	}

	testStore(immutable({

		target,
		ignore,


		open() {

			return createSPARQLStore(repository = factory());

		},


		contains(entry: Reference) {

			return repository.ask(`ask { <${entry}> ?p ?o }`);

		},

		async includes(entry: Resource, shape: Lazy<ResourceShape>) {

			const clazz = getShapeClass(shape);
			const probes = encoders[clazz ?? ""]?.(entry) ?? error(`unsupported shape class <${clazz}>`);

			// a single conjunctive ask is the fast path: it succeeds only when every fact is jointly present. on
			// failure, each fact is re-probed on its own solely to report which triples are missing; the result
			// stays false regardless

			if ( await repository.ask(`ask { ${patterns(probes)} }`) ) {

				return true;

			} else {

				const present = await Promise.all(probes.map(probe => repository.ask(`ask { ${pattern(probe)} }`)));
				const missing = probes.filter((_, index) => !present[index]);

				logger.warn`missing triples: ${missing.map(pattern).join("\n")}`;

				return false;

			}
		},

		async excludes(entry: Resource, shape: Lazy<ResourceShape>) {

			const clazz = getShapeClass(shape);
			const probes = encoders[clazz ?? ""]?.(entry) ?? error(`unsupported shape class <${clazz}>`);

			// each fact is probed on its own: absence is per-fact, so a conjunctive ask would only prove "not all
			// present", never the "none present" this helper must assert

			const present = await Promise.all(probes.map(probe => repository.ask(`ask { ${pattern(probe)} }`)));
			const unexpected = probes.filter((_, index) => present[index]);

			if ( unexpected.length === 0 ) {

				return true;

			} else {

				logger.warn`unexpected triples: ${unexpected.map(pattern).join("\n")}`;

				return false;

			}

		},


		async populate() {

			await repository.update("clear all");

			await insert(dataset);

		},

		async generate<S extends Lazy<ResourceShape>>(sample: State<S> & Resource, shape: S) {

			const clazz = map(eager(shape), shape => shape.class);
			const encoder = encoders[clazz ?? ""];

			if ( encoder === undefined ) {
				throw new Error(`unsupported shape class <${clazz}>`);
			}

			const entry = clone(sample, shape);

			// a generated resource is linked into the catalogues collecting its type, as a store creating it
			// through them would, so that a catalogue retrieval reaches it as it reaches the sample resources

			await insert([...encoder(entry), ...membership(entry, shape)]);

			return entry;

		}

	}));


	describe("sparql storage", () => {

		it("should store und-tagged text as an und-tagged literal", async () => {

			// synthetic mutation on a fresh, un-populated repository: a localised value tagged `und` is stored as
			// a language-tagged `"…"@und` literal like any other tag, never as a plain literal, which a string
			// variant sharing the property would claim on read (§3.1)

			const probe = factory();
			const store = createSPARQLStore(probe);

			const id: Reference = `${base}vendors/9001`;

			await store.create({

				entry: `${base}vendors/`,
				shape: Vendors,
				model: { members: {} },

				state: {
					id,
					type: toys.Vendor,
					created: "2026-01-01T00:00:00.000Z",
					label: { und: "Plain Label" },
					code: "9001",
					name: "Synthetic Vendor",
					email: "synthetic@example.net",
					homepage: "https://synthetic.example.net/"
				}

			});

			expect(await probe.ask(`ask { <${id}> <${rdfs.label}> "Plain Label"@und }`)).toBe(true);
			expect(await probe.ask(`ask { <${id}> <${rdfs.label}> "Plain Label" }`)).toBe(false);

		});

		it("should link a created resource into the plain collection holding it", async () => {

			// synthetic mutation on a fresh repository: a resource created through a collection a plain forward
			// property holds is asserted as a member of it, so that the holder reaches it as any other value

			const Note = shaped({ id: id(), text: required(string()) });
			const Bin = shaped({ notes: multiple(reference(Note), { forward: `${base}toys#note` }) });

			const probe = factory();
			const store = createSPARQLStore(probe);

			const holder: Reference = `${base}bins/1`;

			const created = await store.create({
				entry: holder,
				shape: Bin,
				model: { notes: {} },
				state: { text: "linked" }
			});

			expect(created?.startsWith(`${holder}/`)).toBe(true);
			expect(await probe.ask(`ask { <${holder}> <${base}toys#note> <${created}> }`)).toBe(true);

		});

	});

}


////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Encodes a language map as language-tagged literals, the `und` tag included, as the store writes them.
 */
function text(text: undefined | Some<{ readonly [tag: Tag]: Some<string> }>): readonly Tagged[] {
	return some(text).flatMap(text => Object.entries(text).flatMap(([tag, content]) =>
		some(content).map(value => tagged(value, tag))
	));
}

/**
 * Encodes the membership edges linking a resource into the catalogues collecting its type.
 */
function membership(entry: Resource, shape: Lazy<ResourceShape>): readonly Triple[] {

	const lineage = [getShapeClass(shape), ...(getShapeClasses(shape) ?? [])];

	const holders = [
		...(lineage.includes(toys.Resource) ? [catalogues.resources] : []),
		...(lineage.includes(toys.Category) ? [catalogues.categories] : []),
		...(lineage.includes(toys.Vendor) ? [catalogues.vendors] : []),
		...(lineage.includes(toys.Product) ? [catalogues.products] : [])
	];

	return holders.flatMap(catalogue =>
		identify(entry, shape, id => property(link(catalogue.id), rdfs.member, link(id)))
	);

}

function encodeCatalogue(catalogue: Fragment<typeof Resources>) {
	return identify(catalogue, Resources, entry => about(entry, id => resource(
		property(id, rdf.type, catalogue.type && getShapeClass(Resources)),
		property(id, rdf.type, catalogue.type && getShapeClasses(Resources)),
		property(id, rdfs.label, text(catalogue.label)),
		property(id, toys.created, data(catalogue.created, xsd.dateTime)),
		property(id, rdfs.member, link(catalogue.members))
	)));
}

function encodeCategory(category: Fragment<typeof Category>) {
	return identify(category, Category, entry => about(entry, id => resource(
		property(id, rdf.type, category.type && getShapeClass(Category)),
		property(id, rdf.type, category.type && getShapeClasses(Category)),
		property(id, rdfs.label, text(category.label)),
		property(id, rdfs.comment, text(category.comment)),
		property(id, toys.created, data(category.created, xsd.dateTime)),
		property(id, toys.updated, data(category.updated, xsd.dateTime)),
		property(id, toys.featured, data(category.featured, xsd.boolean)),
		property(id, toys.code, data(category.code)),
		property(id, toys.title, text(category.title)),
		property(id, toys.description, text(category.description)),
		property(id, toys.broader, link(category.broader)),
		property(link(category.broader), toys.narrower, id),
		property(id, toys.upper, link(category.broader))
	)));
}


function encodeVendor(vendor: Fragment<typeof Vendor>) {

	return identify(vendor, Vendor, entry => about(entry, id => resource(
		property(id, rdf.type, vendor.type && getShapeClass(Vendor)),
		property(id, rdf.type, vendor.type && getShapeClasses(Vendor)),
		property(id, rdfs.label, text(vendor.label)),
		property(id, rdfs.comment, text(vendor.comment)),
		property(id, toys.created, data(vendor.created, xsd.dateTime)),
		property(id, toys.updated, data(vendor.updated, xsd.dateTime)),
		property(id, toys.code, data(vendor.code)),
		property(id, toys.name, data(vendor.name)),
		property(id, toys.aliases, data(vendor.aliases)),
		property(id, toys.email, data(vendor.email)),
		property(id, toys.homepage, data(vendor.homepage)),
		property(id, toys.founded, data(vendor.founded, xsd.gYear)),
		property(id, toys.opens, data(vendor.opens, xsd.time)),
		property(id, toys.score, term(vendor.score, score)),
		property(id, toys.certified, term(vendor.certified, certified)),
		property(id, toys.audited, term(vendor.audited, audited)),
		property(id, toys.origin, isPlace(vendor.origin) ? vendor.origin : [], encodePlace),
		property(id, toys.origin, isPlace(vendor.origin) ? [] : text(vendor.origin)),
		property(id, toys.tagline, isString(vendor.tagline) ? data(vendor.tagline) : text(vendor.tagline)),
		property(id, toys.address, vendor.address, encodeLocation),
		property(id, toys.contacts, vendor.contacts, encodeLocation)
	)));


	function score(score: string | number) {
		return typed(score,
			isString(score) ? undefined : xsd.decimal
		);
	}

	function certified(certified: Scalar) {
		return typed(certified,
			isBoolean(certified) ? xsd.boolean
				: isNumber(certified) ? xsd.decimal
					: /^[A-F]$/.test(certified) ? undefined
						: xsd.gYear
		);
	}

	function audited(audited: boolean | string) {
		return typed(audited,
			isBoolean(audited) ? xsd.boolean : xsd.date
		);
	}

	function isPlace(origin: Fragment<typeof Vendor>["origin"]): origin is State<typeof Place> {
		return origin !== undefined && "latitude" in origin;
	}

}

function encodeLocation(location: Fragment<StringShape | typeof PostalAddress | typeof Place>) {
	return isString(location) ? typed(location)
		: "latitude" in location && location.latitude !== undefined ? encodePlace(location)
			: "street" in location && location.street !== undefined ? encodePostalAddress(location)
				: [];
}

function encodePostalAddress(address: Fragment<typeof PostalAddress>) {
	return about(blank(), root => resource(
		property(root, rdf.type, getShapeClass(PostalAddress)),
		property(root, rdf.type, getShapeClasses(PostalAddress)),
		property(root, rdfs.label, text(address.label)),
		property(root, toys.street, data(address.street)),
		property(root, toys.city, data(address.city)),
		property(root, toys.zip, data(address.zip)),
		property(root, toys.country, data(address.country))
	));
}

function encodePlace(place: Fragment<typeof Place>) {
	return about(blank(), root => resource(
		property(root, rdf.type, getShapeClass(Place)),
		property(root, rdf.type, getShapeClasses(Place)),
		property(root, rdfs.label, text(place.label)),
		property(root, toys.latitude, data(place.latitude, xsd.decimal)),
		property(root, toys.longitude, data(place.longitude, xsd.decimal)),
		property(root, toys.opened, data(place.opened, xsd.date))
	));
}


function encodeProduct(product: Fragment<typeof Product>) {
	return identify(product, Product, entry => about(entry, id => resource(
		property(id, rdf.type, product.type && getShapeClass(Product)),
		property(id, rdf.type, product.type && getShapeClasses(Product)),
		property(id, rdfs.label, text(product.label)),
		property(id, rdfs.comment, text(product.comment)),
		property(id, toys.created, data(product.created, xsd.dateTime)),
		property(id, toys.updated, data(product.updated, xsd.dateTime)),
		property(id, toys.sku, data(product.sku)),
		property(id, toys.name, text(product.name)),
		property(id, toys.description, text(product.description)),
		property(id, toys.keywords, text(product.keywords)),
		property(id, toys.homepage, data(product.homepage)),
		property(id, toys.launched, data(product.launched, xsd.date)),
		property(id, toys.warranty, data(product.warranty, xsd.duration)),
		property(id, toys.documents, data(product.documents)),
		property(id, toys.condition, data(product.condition)),
		property(id, toys.price, data(product.price, xsd.decimal)),
		property(id, toys.change, data(product.change, xsd.decimal)),
		property(id, toys.discount, data(product.discount, xsd.decimal)),
		property(id, toys.stock, data(product.stock, xsd.integer)),
		property(id, toys.vendor, link(product.vendor)),
		property(link(product.vendor), toys.products, id),
		property(id, toys.categories, link(product.categories)),
		property(id, toys.media, link(product.media)),
		property(id, toys.reviews, product.reviews, encodeReview)
	)));
}

function encodeImage(image: Fragment<typeof Image>) {
	return identify(image, Image, entry => about(entry, id => resource(
		property(id, rdf.type, image.type && getShapeClass(Image)),
		property(id, rdf.type, image.type && getShapeClasses(Image)),
		property(id, rdfs.label, text(image.label)),
		property(id, toys.created, data(image.created, xsd.dateTime)),
		property(id, toys.updated, data(image.updated, xsd.dateTime)),
		property(id, toys.url, data(image.url)),
		property(id, toys.width, data(image.width, xsd.integer)),
		property(id, toys.height, data(image.height, xsd.integer)),
		property(id, toys.caption, data(image.caption)),
		property(id, toys.subject, link(image.subject))
	)));
}

function encodeVideo(video: Fragment<typeof Video>) {
	return identify(video, Video, entry => about(entry, id => resource(
		property(id, rdf.type, video.type && getShapeClass(Video)),
		property(id, rdf.type, video.type && getShapeClasses(Video)),
		property(id, rdfs.label, text(video.label)),
		property(id, toys.created, data(video.created, xsd.dateTime)),
		property(id, toys.updated, data(video.updated, xsd.dateTime)),
		property(id, toys.url, data(video.url)),
		property(id, toys.duration, data(video.duration, xsd.duration)),
		property(id, toys.caption, text(video.caption)),
		property(id, toys.subject, link(video.subject))
	)));
}

function encodeReview(review: Fragment<typeof Review>) {
	return about(blank(), root => resource(
		property(root, rdf.type, getShapeClass(Review)),
		property(root, rdf.type, getShapeClasses(Review)),
		property(root, rdfs.label, text(review.label)),
		property(root, rdfs.comment, text(review.comment)),
		property(root, toys.author, data(review.author)),
		property(root, toys.posted, data(review.posted, xsd.dateTime)),
		property(root, toys.rating, data(review.rating, xsd.byte)),
		property(root, toys.content, text(review.content))
	));
}
