# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes that warrant a release line should add a bullet under `[Unreleased]`
in the same PR — `scripts/release.sh` rotates that section into a dated
version heading on release.

## [Unreleased]

### Added

- Vitest coverage gate in CI (#38)
- Markdown-escaping guard test covering all table formatter paths (#39)
- Unit tests for `callScan` (#29) and `getApiKey` (#24)
- `types` field and a minimal `exports` map in package.json for library
  consumers of the exported formatter/API types (#50)

### Changed

- `SERVER_VERSION` is read from package.json at runtime instead of a
  hardcoded string; release.sh smoke-checks the built server's banner (#49)
- Removed stale benchmark scripts (`scripts/benchmark.ts`, `benchmarks/`)
  and the `mitata` dev dependency (#47)
- Simplified `truncateIfNeeded` recursion/retry logic (#30)
- Combined the markdown table formatters into one code path (#31)
- Perf: avoid array allocations in `topEvidenceLine` fallback (#35) and
  evidence rendering (#28); precompute the `User-Agent` string (#20)

### Fixed

- `isDirectlyExecuted` guard now handles symlinked and extension-less
  `argv[1]` (npx / `npm install -g` boot regression) (#37)
- Undefined table cells from missing fallback chains in Pro-tier rendering (#36)
- Legal-entity search safely includes financial/insurance name variants (#32)
- JSON-format tool output bounded to `CHARACTER_LIMIT` (#53)
- Truncated renders preserve the original query and format hint context (#54)
- Attribution wording in the `lookup_domain` schema and the config path
  shown in the `getApiKey` error (#55)
- The caller-controlled query is now escaped through the cellSafe
  chokepoint in both places it was interpolated raw — the results heading
  and the legal-entity did-you-mean suggestions — so a newline in
  `company_name` can no longer inject markdown lines into the output (#50)

### Security

- Fetch redirects rejected (`redirect: "error"`) so the API key can never
  be forwarded to another origin (#26)
- Markdown injection fixed in table formatters (#27) and `explainError` (#23)
- Raw API error bodies bounded before rendering in `explainError` (#56)

## [0.2.5] - 2026-05-15

### Added

- Legal-entity name caveat in tool descriptions plus did-you-mean
  suggestions for near-miss company names (#17)

## [0.2.4] - 2026-05-14

### Fixed

- Render the real Pro-tier `ScoutResult` shape returned by the API (#15)

## [0.2.3] - 2026-05-14

### Changed

- Personal email flushed from npm metadata and aliased to
  `pro@ctscout.dev` in public docs (#12, #13)

## [0.2.2] - 2026-05-13

### Added

- Hosted MCP endpoint: `https://ctscout.dev/mcp` (Streamable HTTP) and
  `https://ctscout.dev/sse` (legacy SSE) — same tools, zero local
  install; auth via `X-API-Key` header (#11)
- `LIMITATIONS.md` documenting the DV-cert coverage gap and corrections path

### Changed

- README rewritten to lead with named-entity attribution (dropping the
  adversary-infra overclaim) and the hosted endpoint (#10, #11)

## [0.2.1] - 2026-05-11

### Fixed

- `isDirectlyExecuted` compared raw paths, so the npx / `npm install -g`
  symlinked bin exited 0 with no output; compare realpaths instead (#5)

## [0.2.0] - 2026-05-11

### Added

- Pro-tier response surfacing: `confidence_band`, `evidence`,
  `matched_via`, `signal_health`, `vlm_status`, `vlm_override` rendered
  in the markdown table when present (#2)
- VLM-veto indicator (`🚫VLM-veto`) when a visual verdict overrode
  positive-signal accumulation (#2)
- Vitest test suite covering both response shapes, truncation, and error paths (#2)
- CI + Claude review workflows
- `scripts/release.sh` for npm releases (#4)

### Changed

- Tool descriptions say "attributed to" rather than "owns" (#2)

## [0.1.0] - 2026-05-09

### Added

- Initial release: MCP server over the public ctscout.dev `/scan` API
  (stdio transport) with two tools — `ctscout_search_company` and
  `ctscout_lookup_domain`
