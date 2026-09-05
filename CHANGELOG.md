# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Changes that warrant a release line should add a bullet under `[Unreleased]`
in the same PR. A release-preparation PR rotates that section into a dated
version heading so the exact package metadata and notes are reviewed together;
`scripts/release.sh` refuses to publish when the heading is missing.

## [Unreleased]

### Changed

- README and LIMITATIONS describe what a Pro key gets today: more `/scan`
  rows and a longer window on the same weekly snapshot, and evidence-backed
  `confidence_band`s only through deep-dive jobs; no live enrichment on
  `/scan`, no VLM (ctscout-worker#338)

## [0.4.0] - 2026-09-05

### Added

- `ctscout_submit_deep_dive` (`POST /jobs`) and `ctscout_get_job`
  (`GET /jobs/{id}`): asynchronous Pro deep dives per ctscout-worker#344
  contract v1. Submit returns a receipt; poll with backoff (30 s → 5 min) for
  a result identical to a Pro `/scan` plus the worker-set `snapshot`,
  `worker_version` and `signals_attempted`. VLM is not part of v1. Job
  errors map 403 → Pro required (with the API's upgrade text), 404 → not
  your job / unknown id, 429 → daily jobs quota (#107)
- `outputSchema` on all three tools, enforced by the SDK against every
  `structuredContent`; proxied fields stay open so upstream additions widen
  rather than break the tool (#100)
- `snapshot` (warehouse/D1 sync date) and `snapshot_source` (`scan` |
  `unavailable`) on every response, read from the API payload when it carries
  one; no independent fallback request, so a missing date is reported as
  unknown rather than guessed. Markdown output carries the same line (#100)

### Changed

- `ctscout_search_company` description, README and LIMITATIONS no longer carry a
  hand-typed warehouse size (the three disagreed with each other and with the
  live site); all point at https://ctscout.dev/stats instead (#101)
- Result wording is consistently "attributed" (cert-subject attribution) vs
  "candidate" (semantic name similarity, not an attribution); every table's
  organization column is "Attributed to" and the candidate table is labelled
  as candidates. Tool descriptions document `match_type`, `candidates`,
  `org_match_strategy`, `empty_reason`, and that `first_seen`/`last_seen` are
  warehouse observation times, not CT SCT times (#100)

## [0.3.0] - 2026-07-30

### Added

- MCP 2026-07-28 stdio discovery via `server/discover`, while preserving the
  legacy 2025 `initialize` handshake for existing clients (#73)
- Reproducible release verification that installs the exact npm tarball in a
  clean offline consumer project, boots through its installed `.bin`, and
  protocol-tests modern discovery plus legacy/modern tool calls (#73)
- A non-publishing `npm run release:check` gate that requires pre-reviewed
  package/changelog metadata and detects npm/tag/GitHub partial release state;
  the release path can safely resume after npm succeeds for the same exact
  `gitHead` (#73)
- Hosted-compatible `strict_match_org_only`, `org_match_field`,
  `org_match_mode`, and `purpose` inputs on `ctscout_search_company`, plus
  protocol-level and packed-artifact contract tests (#75)
- `ctscout_search_company_batch` tool — look up apex domains for up to 10
  organization names in one `/scan/batch` call. Per-company sections are
  fair-shared under the response character budget so one company's large
  result can't starve the others; partial failures render per-company (the
  207-style envelope), and JSON output is bounded the same way (#19)
- Biome lint/format gate (`npm run lint`) and test-file type-checking
  (`npm run typecheck` via `tsconfig.test.json`), both enforced in CI (#46)
- Vitest coverage gate in CI (#38)
- Markdown-escaping guard test covering all table formatter paths (#39)
- Unit tests for `callScan` (#29) and `getApiKey` (#24)
- `types` field and a minimal `exports` map in package.json for library
  consumers of the exported formatter/API types (#50)

### Changed

- Migrated the stdio adapter from the monolithic MCP TypeScript SDK v1 to the
  v2 server package and Zod 4 so one factory can serve modern stateless
  discovery and legacy sessionful clients (#73)
- Pinned the MCP v2 server transport to the exact reviewed `2.0.0` runtime and
  made the packed-artifact contract reject dependency-range or installed-runtime
  drift (#79)
- Aligned the existing stdio `ctscout_search_company_batch` contract with
  hosted MCP: quota-debiting tools are read-only but non-idempotent, semantic
  candidates survive default Markdown, full/compact responses are preserved
  before truncation, and protocol tests pin ordered partial failures plus the
  1–10-name schema (#76)
- Documented hosted MCP as the authoritative contract and qualified the
  then-current stdio-only batch compatibility exception (#75)
- **Compatibility boundary: Node floor raised from `>=18` to `>=20`** in
  `engines` (18 is EOL since April 2025; CI has only ever tested 20) (#46)
- `SERVER_VERSION` is read from package.json at runtime instead of a
  hardcoded string; packed-artifact verification smoke-checks the installed
  server's exact banner (#49, #73)
- Removed stale benchmark scripts (`scripts/benchmark.ts`, `benchmarks/`)
  and the `mitata` dev dependency (#47)
- Simplified `truncateIfNeeded` recursion/retry logic (#30)
- Combined the markdown table formatters into one code path (#31)
- Perf: avoid array allocations in `topEvidenceLine` fallback (#35) and
  evidence rendering (#28); precompute the `User-Agent` string (#20)
- `tests/symlink-boot.test.ts` uses the ESM-native `import.meta.url` idiom
  instead of the Vitest-injected `__dirname` global (#6)

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
