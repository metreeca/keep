# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unpublished](https://github.com/metreeca/keep/compare/v0.10.0...HEAD)

## [0.10.0](https://github.com/metreeca/keep/releases/tag/v0.10.0) - 2026-09-09

### Added

- `@metreeca/keep` — core model-driven storage API, defining the backend-agnostic `StoreClient` and `Store` interfaces
  and the batching, caching, managing and validating decorators
- `@metreeca/keep-flake` — shape-driven traversal trees, reorganising a resource shape and its retrieval model or
  collection query into a single structure connectors walk to generate queries and decode results
- `@metreeca/keep-suite` — connector conformance test suite, providing shared fixtures and a harness verifying that
  connector implementations honour the `Store` contract
- `@metreeca/keep-rest` — REST/JSON proxy connector, forwarding every store operation to a remote endpoint over HTTP
- `@metreeca/keep-sparql` — SPARQL 1.1 repository connector, translating store operations into queries and updates
  against a pluggable graph backend from the [@metreeca/wire](https://github.com/metreeca/wire) collection

### Changed

- Restructure the repository as an npm workspaces monorepo, publishing the framework as the five packages above rather
  than a single package
