#!/usr/bin/env node
/**
 * MCP Server for ctscout.dev — domain discovery via Certificate Transparency.
 *
 * Wraps the public ctscout.dev /scan, /jobs, /lei and /vendors APIs. Seven tools:
 *
 * - ctscout_search_company:       find domains attributed to an organization by name
 * - ctscout_search_company_batch: same, for up to 10 organization names in one call
 * - ctscout_lookup_domain:        reverse lookup — find the organization for one or more domains
 * - ctscout_submit_deep_dive:     Pro only — queue an async multi-signal deep dive (POST /jobs)
 * - ctscout_get_job:              poll a deep dive and read its result (GET /jobs/{id})
 * - ctscout_lookup_lei:           one LEI's record, or the LEIs under a legal name (GET /lei)
 * - ctscout_vendor_customers:     a vendor's customer counts and, with a key, the enumeration
 *
 * Auth: requires an API key via the CTSCOUT_API_KEY environment variable.
 * Get a free key (no email, no signup) at https://ctscout.dev.
 *
 * Distribution: stdio compatibility transport for local use (invoked via npx
 * by an MCP client such as Claude Code or Claude Desktop). The entry supports
 * both the stateless 2026-07-28 server/discover era and legacy initialize
 * clients. The authoritative hosted contract is served at
 * https://ctscout.dev/mcp (Streamable HTTP transport). Both transports expose
 * the same public tools while the longer-term shared-core/forwarding
 * migration continues in #72.
 *
 * Known, deliberate transport divergence (AGENTS.md "Cross-repository
 * parity"): ctscout_lookup_lei and ctscout_vendor_customers ship here first.
 * The hosted MCP in ctscout-worker does not advertise them yet; mirroring them
 * onto /mcp and /sse is a separate Worker change, so until it lands the two
 * transports differ by exactly these two tools and nothing else.
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

// ---------- Constants ----------

const API_BASE_URL = process.env.CTSCOUT_API_URL ?? "https://ctscout.dev";
const SCAN_URL = `${API_BASE_URL}/scan`;
const SCAN_BATCH_URL = `${API_BASE_URL}/scan/batch`;
const JOBS_URL = `${API_BASE_URL}/jobs`;
// Research-product routes (ctscout-worker#336). Every answer is a precomputed
// object published by the weekly ctscout-research refresh; the Worker reads one
// object and returns it, classifying nothing.
const LEI_URL = `${API_BASE_URL}/lei`;
const VENDORS_URL = `${API_BASE_URL}/vendors`;
// ISO 17442: 18 uppercase alphanumerics plus two check digits. Mirrors the
// Worker's LEI_RE (product-contract.ts) so a malformed id gets a clean local
// error instead of a 400 round-trip.
const LEI_PATTERN = /^[A-Z0-9]{18}[0-9]{2}$/;
// Mirrors the Worker's SLUG_RE for /vendors/{slug}: one lowercase segment.
const VENDOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
// The Worker's LEI_NAME_LIMIT and NAME_QUERY_MAX_CHARS. Stated in the tool
// description so a caller reads "20 of 37" rather than assuming leis is whole.
const LEI_NAME_LIMIT = 20;
const NAME_QUERY_MAX_CHARS = 200;
// Deep-dive spec limits and quota, per ctscout-worker#344 contract v1. The
// Worker validates the spec exactly like /scan and re-enforces both; the copy
// here gives a clean error before a network round-trip and lets the tool
// description state the quota.
const MAX_SEED_DOMAINS = 10;
const JOBS_PER_DAY = 20;
// Keep in lockstep with ctscout-worker's hosted MCP MAX_BATCH_QUERIES and REST
// MAX_BATCH_SIZE. Both public transports accept 1–10 names; validation here is
// belt-and-suspenders (a clean error before a network round-trip), while the
// Worker re-enforces the limit before quota debit.
const MAX_BATCH_QUERIES = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const CHARACTER_LIMIT = 25_000;
const ERROR_BODY_LIMIT = 500;
// Hard cap on every API-derived string a minimal envelope keeps (see
// boundedField): the last-resort JSON fallbacks are bounded by construction.
const ENVELOPE_STRING_LIMIT = 200;
// Cap how many bytes of an error-response body we pull off the wire and
// hold in memory before `truncateBody` (render time) gets to trim it for
// display. Set well above ERROR_BODY_LIMIT so ordinary error bodies (JSON
// validation payloads, small HTML error pages) are captured whole and
// truncateBody's "(truncated, N chars total)" marker keeps reporting an
// accurate count; only bodies larger than this cap have their marker's
// total clamped to what was actually read — ctscout-mcp#57.
const ERROR_BODY_CAPTURE_LIMIT = 4096;
const SERVER_NAME = "ctscout-mcp-server";
const QUOTA_DEBITING_READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  // Retrying the same call consumes quota again and can change the response
  // to HTTP 429, so these tools are read-only but not idempotent.
  idempotentHint: false,
  openWorldHint: true,
} as const;
// Submitting a deep dive creates a job row, debits the daily jobs quota and
// starts batch work on the origin: not read-only, and a retry queues a second
// job rather than returning the first.
const SUBMIT_JOB_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
// Polling a job reads state and debits nothing (GET /jobs/{id} is outside the
// scan and jobs quotas), so repeating the call is safe.
const POLL_JOB_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
// The research-product routes read a precomputed object and debit no quota —
// the Worker's own note on GET /vendors/{slug}/customers ("No quota debit: the
// object is precomputed"), and the free /lei and /vendors routes are unkeyed
// public reads. Repeating the call is therefore safe as well as read-only.
const PRODUCT_READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
// Single-source the version from package.json — a hardcoded copy here has
// drifted from package.json before (see scripts/release.sh history). Both
// src/index.ts (tsx dev path) and dist/index.js (built path) sit one level
// below the package root, so "../package.json" resolves to the same file in
// the repo checkout and the npm-installed layout. createRequire (not an ESM
// JSON import) avoids import attributes and tsconfig rootDir complaints.
// Exported so tests can pin SERVER_VERSION === package.json's version.
const require = createRequire(import.meta.url);
export const SERVER_VERSION = (require("../package.json") as { version: string }).version;
const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;

// ---------- Types ----------

enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

// Pro-tier enrichment fields. All optional — Free tier responses omit
// them entirely, so callers must guard on presence rather than expecting
// defaults. Shape mirrors `domain_scout_api.pro_models.ProDomainEvidence`.
// Exported so tests (and future downstream consumers) can drive these
// without re-declaring the shape locally — re-declaration is silent
// drift risk if the source struct changes.
export type ConfidenceBand = "verified" | "likely" | "possible" | "insufficient";
export type VlmStatus = "cached" | "pending" | "skipped";

// Every member is optional on the wire: a degraded signal run leaves the
// band and the maps out (DeepDiveEnrichmentSchema), and the renderer falls
// back per field. Reading a member without a guard is a type error.
export interface ProEnrichment {
  confidence_band?: ConfidenceBand;
  weight_total?: number;
  matched_via?: string[];
  evidence?: Record<string, string>;
  signal_health?: Record<string, string>;
  vlm_status?: VlmStatus;
  vlm_override?: boolean;
}

export interface DomainResult {
  // ---- Warehouse row: what /scan returns on both tiers (Pro gets more rows
  //      and a longer window, the same shape).
  org?: string;
  apex_domain?: string;
  cert_count?: number;
  subdomain_count?: number;
  first_seen?: string | null;
  last_seen?: string | null;

  // ---- Deep-dive row (ProDiscoveredDomain, read back with ctscout_get_job):
  //      `domain` instead of `apex_domain`, the batch worker's claim in
  //      `attributed_to` ("attributed", never "owns") and the band under
  //      `enrichment`, as the API reports it. The underlying discovery record
  //      sits under `base`; nothing here derives a band from a number.
  domain?: string;
  attributed_to?: string;
  enrichment?: ProEnrichment;
  is_seed?: boolean;
  // Org fallbacks for the deep-dive table when attributed_to is absent;
  // declared on DeepDiveDomainSchema so the over-budget strip keeps them.
  cert_org_names?: string[];
  rdap_org?: string | null;

  // Catch-all for any future API fields so the type doesn't go stale.
  [k: string]: unknown;
}

export interface ScanResponse {
  domains: DomainResult[];
  // Warehouse responses set these; deep-dive results don't.
  total?: number;
  truncated?: boolean;
  upgrade_hint?: string;
  // "warehouse" / "live" = /scan.
  // "cache-only" / "live-enriched" = a deep-dive result (ProScanResult).
  source?: "warehouse" | "live" | "cache-only" | "live-enriched";
  candidates?: SemanticCandidate[];
  match_type?: "exact" | "semantic" | "none";
  org_match_strategy?: "substring" | "word" | "normalized" | "semantic" | "none" | "not_applicable";
  empty_reason?: "semantic_offered" | "name_mismatch" | "dns_hidden" | "dv_or_absent";
  // Warehouse sync date the answer was read from (see resolveSnapshot). Both
  // keys are always set on a tool response; they are optional here only
  // because the raw /scan payload does not carry them.
  snapshot?: string | null;
  snapshot_source?: SnapshotSource;
  // A deep-dive result also carries `entity` and `run_metadata` at the top level.
  [k: string]: unknown;
}

// Where a response's `snapshot` date came from:
//   "scan"        — the API payload itself carried a `snapshot` string.
//   "unavailable" — it did not; `snapshot` is null, not missing, so a consumer
//                   can tell "the server could not say" from "an older server
//                   that never emitted the field".
// There is deliberately no other source: a date fetched separately (e.g. GET
// /stats last_sync) is not generation-coupled to the scan and can disagree with
// it across the daily sync, which would claim a provenance the answer lacks.
export type SnapshotSource = "scan" | "unavailable";

export interface SnapshotInfo {
  snapshot: string | null;
  snapshot_source: SnapshotSource;
}

export interface SemanticCandidate {
  org: string;
  similarity: number;
  top_apex_domain: string | null;
}

// The query object the batch endpoint echoes back per result. Loosely typed:
// the worker echoes the full ScanBody it ran (company_name plus any matching
// modifiers), and we only read company_name for display.
export interface BatchQuery {
  company_name?: string;
  seed_domain?: string[];
  [k: string]: unknown;
}

// One item in a /scan/batch response, in input order. Mirrors ctscout-worker's
// `ScanBatchResultItem`: a successful query spreads the ScanResponse fields
// (domains, total, match_type, candidates?) next to the echoed `query`; a
// failed query carries an `error` object and NO `domains` (207-style
// mixed-result envelope — partial failure is expected, not all-or-nothing).
export type BatchResultItem =
  | ({ query: BatchQuery } & ScanResponse)
  | { query: BatchQuery; error: { code: number; message: string } };

export interface ScanBatchResponse {
  results: BatchResultItem[];
  // Remaining daily quota for the calling key; null for unlimited (Pro tier).
  remaining_quota: number | null;
  // Envelope-level, not per item: one batch reads one warehouse snapshot.
  snapshot?: string | null;
  snapshot_source?: SnapshotSource;
}

function isBatchError(
  item: BatchResultItem,
): item is { query: BatchQuery; error: { code: number; message: string } } {
  return "error" in item && item.error != null;
}

// ---------- Async deep-dive jobs (ctscout-worker#344 contract v1) ----------

export type JobStatus = "queued" | "running" | "done" | "failed";

// What the deep-dive spec carries: the same two inputs /scan validates.
export interface DeepDiveSpec {
  company_name?: string;
  seed_domain?: string[];
}

// 202 body of POST /jobs.
export interface JobSubmitResponse {
  job_id: string;
  status: JobStatus;
  submitted_at: string;
  // Relative path to poll, e.g. "/jobs/<id>"; informational, the tool polls
  // through ctscout_get_job.
  poll?: string;
  [k: string]: unknown;
}

// The deep-dive result the batch worker writes: a Pro /scan result
// (ProScanResult: entity, domains with enrichment, run_metadata, source,
// signals_degraded) plus job_id, snapshot, worker_version and
// signals_attempted. Modelled as a ScanResponse so the scan renderers and
// truncation envelopes apply unchanged; `snapshot` here is the worker-set
// warehouse date, not this server's resolved copy.
export type DeepDiveEnrichment = ProEnrichment;

// One deep-dive row: a DomainResult plus the attribution the batch worker
// adds and the embedded free-tier discovery record.
export interface DeepDiveDomain extends DomainResult {
  attributed_to?: string;
  is_seed?: boolean;
  base?: Record<string, unknown>;
}

// The deep-dive result the batch worker writes: a Pro /scan result
// (ProScanResult: entity, domains with enrichment, run_metadata, source,
// signals_degraded) plus job_id, snapshot, worker_version and
// signals_attempted. A ScanResponse, so the scan renderers and truncation
// envelopes apply unchanged; `snapshot` here is the worker-set warehouse
// date, not this server's resolved copy.
export type DeepDiveResult = ScanResponse & {
  domains: DeepDiveDomain[];
  entity?: { company_name?: string; seed_domain?: string[] };
  run_metadata?: Record<string, unknown>;
  signals_degraded?: boolean;
  job_id?: string;
  worker_version?: string;
  signals_attempted?: string[];
};

// Body of GET /jobs/{id}. `result` is present only when status is "done";
// `error` only when "failed".
export interface JobResponse {
  job_id: string;
  kind?: string;
  status: JobStatus;
  submitted_at: string;
  started_at?: string | null;
  finished_at?: string | null;
  result?: DeepDiveResult;
  error?: string | null;
  // Set by this server (never by the API): resolved from result.snapshot.
  snapshot?: string | null;
  snapshot_source?: SnapshotSource;
  [k: string]: unknown;
}

// ---------- Research product (ctscout-worker#336) ----------
//
// Field names and types below are taken from ctscout-worker's
// `src/product-contract.ts`, which is the source of truth: the Worker refuses
// to serve an object that disagrees with it, so a field named here either
// arrives as described or the route answers 500.

// Where a research-product answer's date came from. Deliberately NOT the scan
// tools' vocabulary: `as_of` is the version of the weekly research export, not
// the daily warehouse sync, and labelling it "scan" would claim a provenance
// (and a cadence) the answer does not have.
export type ProductSnapshotSource = "product" | "unavailable";

export interface ProductSnapshotInfo {
  snapshot: string | null;
  snapshot_source: ProductSnapshotSource;
}

// `as_of` / `snapshot_dates` / `product_version` are attached by the Worker
// from the product manifest (its `withVersion`), so every product answer
// carries them and the object's own copy is never read.
interface ProductProvenance {
  as_of?: string;
  snapshot_dates?: Record<string, string>;
  product_version?: string;
}

// GET /lei/{lei}: LEI_ENTRY_SPEC.
export interface LeiRecord extends ProductProvenance, Partial<ProductSnapshotInfo> {
  lei: string;
  legal_name: string;
  country: string;
  isin_count: number;
  apex_count: number;
  first_seen: string;
  last_seen: string;
  sample_domains: string[];
  vendors_confirmed: string[];
  [k: string]: unknown;
}

// GET /lei?name=<q>. `leis` is capped at the Worker's LEI_NAME_LIMIT while
// `lei_count` is the pre-cap total, so the two disagree on a truncated answer
// by design.
export interface LeiNameMatches extends ProductProvenance, Partial<ProductSnapshotInfo> {
  query: string;
  name_match: "exact" | "normalized" | "none";
  leis: string[];
  lei_count: number;
  limit: number;
  truncated: boolean;
  [k: string]: unknown;
}

export type LeiLookupResponse = LeiRecord | LeiNameMatches;

// GET /vendors/{slug}: VENDOR_SPEC. `customers` is the candidate/confirmed
// split note 2 keeps apart.
// Proxied, so every field is optional here and in the output schema: the
// Worker's contract guarantees them, but this package renders a hole rather
// than failing a call, exactly as it does for a /scan row.
export interface VendorSummary extends ProductProvenance, Partial<ProductSnapshotInfo> {
  slug?: string;
  vendor_name?: string;
  vendor_apex?: string | null;
  customers?: SplitCounts;
  countries_top?: Array<{ country?: string; confirmed?: number }>;
  co_use?: Array<{ slug?: string; confirmed?: number }>;
  sample_customers?: string[];
  [k: string]: unknown;
}

// The candidate/confirmed split, under its two names: `customers` on the vendor
// summary, `counts` on the enumeration.
export interface SplitCounts {
  candidates?: number;
  confirmed?: number;
}

// One row of customers.json. `attributed_to` is GLEIF's legal name when the
// apex resolves to one LEI, the single non-vendor certificate organization
// otherwise, and null when neither holds.
export interface VendorCustomerRow {
  apex?: string;
  attributed_to?: string | null;
  lei?: string | null;
  [k: string]: unknown;
}

// GET /vendors/{slug}/customers (keyed): CUSTOMERS_SPEC. `counts` and `capped`
// are the completeness metadata — `counts.candidates` can exceed
// `candidates.length` when the research build capped the object.
export interface VendorCustomers extends ProductProvenance, Partial<ProductSnapshotInfo> {
  slug?: string;
  confirmed?: VendorCustomerRow[];
  candidates?: VendorCustomerRow[];
  counts?: SplitCounts;
  capped?: boolean;
  // Written by this server, never by the API, when rows were dropped to fit
  // CHARACTER_LIMIT — see trimCustomerRows.
  truncation_note?: string;
  [k: string]: unknown;
}

// ---------- Zod schemas ----------

const SearchCompanyInputSchema = z
  .object({
    company_name: z
      .string()
      .min(2, "company_name must be at least 2 characters")
      .max(200, "company_name must not exceed 200 characters")
      .describe(
        "Company / organization name to search for. Partial matches work " +
          "(e.g. 'Goldman' matches 'Goldman Sachs'). Case-insensitive.",
      ),
    strict_match_org_only: z
      .boolean()
      .optional()
      .describe(
        "Optional, default false. When true, suppress the semantic-name fallback " +
          "and return only authoritative warehouse organization matches.",
      ),
    org_match_field: z
      .enum(["verbatim", "normalized"])
      .optional()
      .describe(
        "Optional, default 'verbatim'. Leave unset to try the raw cert subject " +
          "first and automatically retry its locale-normalized form after an empty result. " +
          "Set 'normalized' only to skip the verbatim attempt.",
      ),
    org_match_mode: z
      .enum(["substring", "word"])
      .optional()
      .describe(
        "Optional, default 'substring'. Use 'word' for short or common-token names " +
          "to avoid unrelated substring matches. Applies only to verbatim matching.",
      ),
    purpose: z
      .enum(["underwriting", "corporate_family"])
      .optional()
      .describe(
        "Optional persona preset. 'underwriting' defaults to a tight operational " +
          "attack-surface set; 'corporate_family' defaults to a broad brand, regional, " +
          "and family set. Explicitly supplied matching controls always win.",
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        "Output format: 'markdown' for human-readable summary, 'json' for " +
          "the raw API response (useful for programmatic processing).",
      ),
  })
  .strict();

type SearchCompanyInput = z.infer<typeof SearchCompanyInputSchema>;

const LookupDomainInputSchema = z
  .object({
    domains: z
      .array(z.string().min(3).max(253))
      .min(1, "At least one domain required")
      .max(10, "At most 10 domains per request")
      .describe(
        "Apex domains to look up (e.g. ['gs.com', 'goldmansachs.com']). " +
          "Returns the organization(s) attributed to each domain, plus any " +
          "sibling domains in the warehouse attributed to the same orgs. Max 10.",
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        "Output format: 'markdown' for human-readable summary, 'json' for " +
          "the raw API response.",
      ),
  })
  .strict();

type LookupDomainInput = z.infer<typeof LookupDomainInputSchema>;

// Exported so tests can drive the client-side cap (MAX_BATCH_QUERIES) without
// going through the registered tool handler.
export const SearchCompanyBatchInputSchema = z
  .object({
    company_names: z
      .array(
        z
          .string()
          .min(2, "each company_name must be at least 2 characters")
          .max(200, "each company_name must not exceed 200 characters"),
      )
      .min(1, "At least one company_name required")
      .max(MAX_BATCH_QUERIES, `At most ${MAX_BATCH_QUERIES} company names per batch`)
      .describe(
        "Company / organization names to look up in one call (1–" +
          `${MAX_BATCH_QUERIES}). Each is matched exactly as in ` +
          "ctscout_search_company (partial, case-insensitive). Results come " +
          "back in input order; individual names can fail independently " +
          "(partial-failure envelope), so a failed name doesn't sink the batch.",
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        "Output format: 'markdown' for a per-company summary, 'json' for the " +
          "raw batch envelope (useful for programmatic processing).",
      ),
  })
  .strict();

type SearchCompanyBatchInput = z.infer<typeof SearchCompanyBatchInputSchema>;

// Exported so tests can drive the client-side spec validation (at least one of
// company_name / seed_domain, seed cap) without the registered handler.
export const SubmitDeepDiveInputSchema = z
  .object({
    company_name: z
      .string()
      .min(2, "company_name must be at least 2 characters")
      .max(200, "company_name must not exceed 200 characters")
      .optional()
      .describe(
        "Organization name to deep-dive, matched exactly as in ctscout_search_company. " +
          "Give company_name, seed_domain, or both.",
      ),
    seed_domain: z
      .array(z.string().min(3).max(253))
      .min(1, "seed_domain must not be empty when given")
      .max(MAX_SEED_DOMAINS, `At most ${MAX_SEED_DOMAINS} seed domains per deep dive`)
      .optional()
      .describe(
        "Known apex domains of the organization to pivot from (e.g. ['gs.com']). " +
          `Max ${MAX_SEED_DOMAINS}. Give company_name, seed_domain, or both.`,
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        "Output format: 'markdown' for a submission receipt with polling guidance, " +
          "'json' for the raw 202 body ({job_id, status, submitted_at, poll}).",
      ),
  })
  .strict()
  .refine((spec) => spec.company_name !== undefined || spec.seed_domain !== undefined, {
    message: "Provide company_name, seed_domain, or both",
  })
  // A refine is invisible to tools/list: without this, the advertised schema
  // shows both fields optional and a client planning from it can submit {}.
  // The anyOf is what discovery sees; the refine is what runs.
  .meta({ anyOf: [{ required: ["company_name"] }, { required: ["seed_domain"] }] });

type SubmitDeepDiveInput = z.infer<typeof SubmitDeepDiveInputSchema>;

// job_id is interpolated into the request path: the character class keeps a
// hostile id ("../keys", "?x=") from rewriting the URL before
// encodeURIComponent ever sees it.
export const GetJobInputSchema = z
  .object({
    job_id: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[A-Za-z0-9_-]+$/,
        "job_id must be the opaque id returned by ctscout_submit_deep_dive",
      )
      .describe("The job_id returned by ctscout_submit_deep_dive."),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        "Output format: 'markdown' for the job status and, once done, the deep-dive " +
          "attribution table (band, signals, evidence); 'json' for the raw job record.",
      ),
  })
  .strict();

type GetJobInput = z.infer<typeof GetJobInputSchema>;

// Exported so tests can drive the exactly-one-of rule without the registered
// handler. Unlike the deep-dive spec (which accepts either or both), these are
// two different lookups against two different routes: with both set there is no
// answer to return, so the refine rejects rather than silently preferring one.
export const LookupLeiInputSchema = z
  .object({
    lei: z
      .string()
      .regex(LEI_PATTERN, "lei must be 20 uppercase alphanumerics (ISO 17442)")
      .optional()
      .describe(
        "A single LEI (ISO 17442: 18 uppercase alphanumerics + 2 check digits), " +
          "e.g. '549300NDMY0KJK0ZLW17'. Give lei or name, not both.",
      ),
    name: z
      .string()
      .min(1, "name must not be empty")
      // The endpoint trims before deciding a name is empty, so a pattern says
      // so in the advertised schema too: a client validating against
      // tools/list rejects "   " itself instead of spending a round trip
      // earning a 400.
      .regex(/\S/, "name must not be only whitespace")
      .max(NAME_QUERY_MAX_CHARS, `name must be at most ${NAME_QUERY_MAX_CHARS} characters`)
      .optional()
      .describe(
        "A legal entity name to look up in the name index, e.g. 'Cloudflare, Inc.'. " +
          "Give lei or name, not both.",
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        "Output format: 'markdown' for the record or the name-match list, 'json' for " +
          "the raw API response.",
      ),
  })
  .strict()
  .refine((input) => (input.lei !== undefined) !== (input.name !== undefined), {
    message: "Provide exactly one of lei or name",
  })
  // A refine is invisible to tools/list: without this, the advertised schema
  // shows both fields optional and a client planning from it can submit {}.
  // `oneOf`, not `anyOf`: JSON Schema's anyOf is satisfied when one OR MORE
  // branches match, so `{lei, name}` would validate against the advertised
  // schema and only be refused at runtime. oneOf means exactly one, which is
  // this tool's actual rule — two different routes, no single answer to return.
  // (ctscout_submit_deep_dive keeps anyOf: both of its fields together are
  // legal there, so one-or-more is the correct keyword for that contract.)
  .meta({ oneOf: [{ required: ["lei"] }, { required: ["name"] }] });

type LookupLeiInput = z.infer<typeof LookupLeiInputSchema>;

export const VendorCustomersInputSchema = z
  .object({
    slug: z
      .string()
      .regex(
        VENDOR_SLUG_PATTERN,
        "slug must be a lowercase single-segment vendor slug (e.g. 'cloudflare')",
      )
      .describe(
        "The vendor's slug, e.g. 'cloudflare'. The slugs in a LEI record's " +
          "vendors_confirmed are exactly these values.",
      ),
    enumerate: z
      .boolean()
      .default(false)
      .describe(
        "Optional, default false. false returns the free vendor summary (counts, top " +
          "countries, co-use, a customer sample). true returns the per-customer " +
          "enumeration from GET /vendors/{slug}/customers, which requires an active " +
          "ctscout.dev API key (any tier).",
      ),
    response_format: z
      .nativeEnum(ResponseFormat)
      .default(ResponseFormat.MARKDOWN)
      .describe(
        "Output format: 'markdown' for the counts (or the two customer tables), " +
          "'json' for the raw API response.",
      ),
  })
  .strict();

type VendorCustomersInput = z.infer<typeof VendorCustomersInputSchema>;

// ---------- Output schemas ----------
//
// Advertised as `outputSchema` and enforced by the SDK against every
// structuredContent this server returns. The payload is proxied from the API
// (warehouse rows on /scan, deep-dive rows on a job), so every proxied field
// is typed loosely and documented via describe(): an upstream enum growing a
// value must widen what an agent sees, not turn the tool call into an error.
// Only the fields this server writes itself (`snapshot`, `snapshot_source`)
// are required and closed.

const SnapshotFields = {
  snapshot: z
    .string()
    .nullable()
    .describe(
      "Warehouse/D1 sync date (YYYY-MM-DD) the answer was read from; the warehouse " +
        "syncs daily. null when the API could not determine it.",
    ),
  snapshot_source: z
    .enum(["scan", "unavailable"])
    .describe(
      "'scan' = the API response carried the date; 'unavailable' = it did not, " +
        "snapshot is null and must be treated as unknown, never as current.",
    ),
};

const SemanticCandidateSchema = z.looseObject({
  org: z.string().describe("Candidate organization name — a semantic match, NOT an attribution."),
  similarity: z.number().optional().describe("Name-embedding similarity, 0..1."),
  top_apex_domain: z
    .string()
    .nullable()
    .optional()
    .describe("The apex domain most often attributed to this candidate, if any."),
});

const DomainResultSchema = z.looseObject({
  org: z
    .string()
    .optional()
    .describe(
      "Organization the domain is attributed to. Free tier: the OV/EV cert subject O field. " +
        "On /scan, both tiers: the OV/EV certificate subject. Multi-signal attribution lives " +
        "in a deep-dive job result (attributed_to + enrichment), not here.",
    ),
  apex_domain: z.string().optional(),
  cert_count: z.number().optional().describe("Distinct certificates observed for this pair."),
  subdomain_count: z.number().optional(),
  first_seen: z
    .string()
    .nullable()
    .optional()
    .describe(
      "When the warehouse first ingested this pair (observation time, NOT the CT log SCT / issuance time).",
    ),
  last_seen: z
    .string()
    .nullable()
    .optional()
    .describe("When the warehouse last ingested this pair (observation time, not SCT time)."),
  attributed_to: z.string().optional(),
  domain: z
    .string()
    .optional()
    .describe("Deep-dive row shape: the apex domain (no apex_domain field)."),
});

const ScanOutputSchema = z.looseObject({
  domains: z
    .array(DomainResultSchema)
    .describe("Attributed (domain, organization) pairs. Empty when nothing is attributed."),
  total: z.number().optional().describe("Matching pairs in the warehouse before any cap."),
  truncated: z.boolean().optional(),
  upgrade_hint: z.string().optional(),
  source: z
    .string()
    .optional()
    .describe(
      "'warehouse' on /scan (both tiers); 'live-enriched' / 'cache-only' on a deep-dive result.",
    ),
  match_type: z
    .string()
    .optional()
    .describe(
      "'exact' = domains are warehouse attributions; 'semantic' = domains is empty and " +
        "candidates holds name-similarity guesses; 'none' = nothing matched.",
    ),
  org_match_strategy: z.string().optional(),
  empty_reason: z.string().optional(),
  candidates: z
    .array(SemanticCandidateSchema)
    .optional()
    .describe("Present only when match_type is 'semantic'. Candidates are not attributions."),
  ...SnapshotFields,
});

const BatchQuerySchema = z.looseObject({ company_name: z.string().optional() });

const BatchResultItemSchema = z.union([
  z.looseObject({
    query: BatchQuerySchema,
    error: z.object({ code: z.number(), message: z.string() }),
  }),
  ScanOutputSchema.omit({ snapshot: true, snapshot_source: true }).extend({
    query: BatchQuerySchema,
  }),
]);

const BatchOutputSchema = z.object({
  results: z.array(BatchResultItemSchema).describe("One item per input name, in input order."),
  remaining_quota: z.number().nullable().describe("null = unlimited (Pro tier)."),
  ...SnapshotFields,
});

const JobSubmitOutputSchema = z.looseObject({
  job_id: z.string().describe("Opaque id; pass it to ctscout_get_job."),
  status: z.string().describe("'queued' on submission."),
  submitted_at: z.string().describe("Submission time as reported by the API."),
  poll: z.string().optional().describe("Relative API path to poll (informational)."),
});

// Per-domain enrichment evidence of a deep dive (ProDomainEvidence in
// domain-scout-api's pro_models). Proxied verbatim: loose and optional, with
// the vocabularies documented rather than closed, as for every proxied enum.
const DeepDiveEnrichmentSchema = z.looseObject({
  confidence_band: z
    .string()
    .optional()
    .describe(
      "Attribution band from the enrichment scorer: 'verified' | 'likely' | 'possible' | " +
        "'insufficient'. Rendered as reported, never recomputed here.",
    ),
  weight_total: z
    .number()
    .optional()
    .describe("Summed signal weights behind the band; can be positive under a VLM override."),
  matched_via: z
    .array(z.string())
    .optional()
    .describe("Signals that corroborated the attribution."),
  evidence: z
    .record(z.string(), z.string())
    .optional()
    .describe("Signal name -> human-readable evidence string for that signal."),
  signal_health: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Signal name -> disposition: 'hit' | 'miss' (checked, nothing found) | 'error' (collector " +
        "failed, NOT checked) | 'redacted' | 'verified' | 'no' | 'uncertain' | 'unscored' " +
        "(collected, no detector reads it yet; never moves the band).",
    ),
  vlm_status: z
    .string()
    .optional()
    .describe(
      "'cached' | 'pending' | 'skipped'. v1 deep dives never run the VLM: 'pending' or 'skipped'.",
    ),
  vlm_override: z
    .boolean()
    .optional()
    .describe(
      "true when a VLM 'no' verdict forced the band to 'insufficient' regardless of weight_total.",
    ),
});

// A deep-dive domain row (ProDiscoveredDomain): the Pro /scan row plus the
// embedded discovery evidence and the enrichment above.
const DeepDiveDomainSchema = DomainResultSchema.extend({
  is_seed: z
    .boolean()
    .optional()
    .describe("true when the domain was a seed_domain of the request."),
  base: z
    .looseObject({})
    .optional()
    .describe(
      "The underlying discovery record (DiscoveredDomain: confidence, sources, evidence, " +
        "cert_org_names, rdap_org, first_seen, last_seen, resolves) the enrichment was scored on.",
    ),
  enrichment: DeepDiveEnrichmentSchema.optional().describe(
    "Enrichment evidence behind attributed_to. Absent on a degraded row: the collectors " +
      "did not run or failed for this domain, so the attribution stands without evidence " +
      "(see signals_degraded on the result). Still a deep-dive row.",
  ),
  // Declared here, not on the /scan row: the renderer reads them as the
  // organization fallback when attributed_to is absent, and the over-budget
  // strip (KNOWN_DOMAIN_KEYS) keeps only what this shape declares.
  cert_org_names: z
    .array(z.string())
    .optional()
    .describe("Certificate subject organizations; the org fallback when attributed_to is absent."),
  rdap_org: z
    .string()
    .nullable()
    .optional()
    .describe("RDAP registrant organization; the org fallback after cert_org_names."),
});

// The deep-dive result: a Pro /scan result plus the fields the batch worker
// adds. Proxied, so loose; only `domains` is required, as on ScanOutputSchema.
const DeepDiveResultSchema = ScanOutputSchema.omit({
  snapshot: true,
  snapshot_source: true,
}).extend({
  domains: z
    .array(DeepDiveDomainSchema)
    .describe("Attributed apex domains with their evidence. Empty when nothing is attributed."),
  entity: z
    .looseObject({
      company_name: z.string().optional(),
      seed_domain: z.array(z.string()).optional(),
    })
    .optional()
    .describe("The spec the deep dive ran on, as the batch worker validated it."),
  run_metadata: z
    .looseObject({})
    .optional()
    .describe(
      "Audit record of the discovery run (tool_version, timestamp, elapsed_seconds, " +
        "domains_found, timed_out, errors, config).",
    ),
  signals_attempted: z
    .array(z.string())
    .optional()
    .describe(
      "Apex-keyed enrichment signals this deployment ran (or read from cache) for every " +
        "domain, set even with zero domains. A signal absent here was not configured; one " +
        "present with signal_health 'error' was attempted and failed.",
    ),
  snapshot_source: SnapshotFields.snapshot_source
    .optional()
    .describe(
      "Set by this server from result.snapshot: 'scan' when the batch worker reported the " +
        "date, 'unavailable' when it did not. Mirrors the top-level snapshot_source.",
    ),
  job_id: z.string().optional(),
  snapshot: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Warehouse date (YYYY-MM-DD) the deep dive read from; set by the batch worker on every result.",
    ),
  worker_version: z.string().optional().describe("Batch worker git sha that produced the result."),
  signals_degraded: z
    .boolean()
    .optional()
    .describe(
      "true when at least one enrichment signal errored: absence of evidence for those signals is not evidence of absence.",
    ),
});

const JobOutputSchema = z.looseObject({
  job_id: z.string(),
  kind: z.string().optional().describe("'deep_dive'."),
  status: z.string().describe("'queued' | 'running' | 'done' | 'failed'."),
  submitted_at: z.string(),
  started_at: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  result: DeepDiveResultSchema.optional().describe("Present only when status is 'done'."),
  error: z
    .string()
    .nullable()
    .optional()
    .describe("Short 'type: message' reason, present only when status is 'failed'."),
  ...SnapshotFields,
});

// The research-product answers' provenance. Same two field names as
// SnapshotFields and the same rule (this server writes them; null means
// unknown, never "current"), but a different vocabulary for the source: a
// product answer's date is the weekly export's version, not a warehouse sync,
// so "scan" would misname both the origin and the cadence.
const ProductSnapshotFields = {
  snapshot: z
    .string()
    .nullable()
    .describe(
      "The research product version (YYYY-MM-DD) this answer was read from — the " +
        "`as_of` of the export the ctscout-research refresh published. null when the " +
        "API response carried none.",
    ),
  snapshot_source: z
    .enum(["product", "unavailable"])
    .describe(
      "'product' = the API response carried the export's as_of; 'unavailable' = it did " +
        "not, snapshot is null and must be treated as unknown, never as current.",
    ),
};

const SnapshotDatesSchema = z
  .record(z.string(), z.string())
  .optional()
  .describe(
    "Per-source provenance from the product manifest: elf, gleif, isin, psl, wikidata. " +
      "Values are the dated snapshot each join read (psl is a bundle identifier, not a date).",
  );

const ProductProvenanceFields = {
  as_of: z.string().optional().describe("The product version this answer was read from."),
  snapshot_dates: SnapshotDatesSchema,
  product_version: z.string().optional().describe("Same value as as_of; the manifest's version."),
};

// One tool, two lookups: the by-LEI fields and the by-name fields are disjoint
// and never both present. `name_match` is the discriminator — required on the
// by-name answer, absent from the record — so everything proxied is optional
// here and only the two fields this server writes are required.
const LeiLookupOutputSchema = z.looseObject({
  lei: z.string().optional().describe("By-LEI answer: the LEI the record is filed under."),
  legal_name: z.string().optional().describe("By-LEI answer: GLEIF's legal name for the entity."),
  country: z.string().optional().describe("By-LEI answer: GLEIF's country for the entity."),
  isin_count: z
    .number()
    .optional()
    .describe("By-LEI answer: ISINs mapped to this LEI in GLEIF's ISIN-to-LEI file."),
  apex_count: z
    .number()
    .optional()
    .describe("By-LEI answer: apex domains attributed to this LEI in the research build."),
  first_seen: z
    .string()
    .optional()
    .describe("By-LEI answer: earliest warehouse observation across this LEI's apexes."),
  last_seen: z
    .string()
    .optional()
    .describe("By-LEI answer: latest warehouse observation across this LEI's apexes."),
  sample_domains: z
    .array(z.string())
    .optional()
    .describe(
      "By-LEI answer: a hash-chosen sample of the attributed apexes — whatever size the " +
        "research export published, not a ranking and not a complete list. apex_count is " +
        "the total; the markdown says so if it lists fewer than the sample carries.",
    ),
  vendors_confirmed: z
    .array(z.string())
    .optional()
    .describe(
      "By-LEI answer: vendor slugs confirmed on this LEI's domains. Pass one to " +
        "ctscout_vendor_customers.",
    ),
  query: z.string().optional().describe("By-name answer: the name as submitted."),
  name_match: z
    .string()
    .optional()
    .describe(
      "By-name answer, and the discriminator between the two shapes: 'exact' | " +
        "'normalized' | 'none'. 'none' means neither spelling tried hit the index, NOT " +
        "that the entity has no LEI.",
    ),
  leis: z
    .array(z.string())
    .optional()
    .describe("By-name answer: matching LEIs, capped at `limit`. lei_count is the total."),
  lei_count: z.number().optional().describe("By-name answer: matches before the cap."),
  limit: z.number().optional().describe("By-name answer: the cap applied to `leis`."),
  truncated: z.boolean().optional().describe("By-name answer: true when lei_count exceeds limit."),
  truncation_note: z
    .string()
    .optional()
    .describe(
      "Written by this MCP server, never by the API: present only when a list above was " +
        "shortened to stay under the response character limit, naming each shortened list " +
        "and the length the API actually sent. Absent means no list was cut here.",
    ),
  ...ProductProvenanceFields,
  ...ProductSnapshotFields,
});

// Proxied like every other API-sourced shape in this file: loose, and every
// field optional. Only what this server writes itself is required, so a
// publication the Worker's contract would have refused cannot turn a tool call
// into a schema error on top of whatever else is wrong with it.
const VendorCustomerRowSchema = z.looseObject({
  apex: z.string().optional().describe("The customer apex domain."),
  attributed_to: z
    .string()
    .nullable()
    .optional()
    .describe(
      "GLEIF's legal name when the apex resolves to one LEI, the single non-vendor " +
        "certificate organization otherwise, null when neither holds. Attributed, not owned.",
    ),
  lei: z
    .string()
    .nullable()
    .optional()
    .describe("The customer's LEI when one resolved, else null."),
});

const SPLIT_COUNTS_DESCRIPTIONS = {
  candidates: "Apex domains the vendor certified a hostname for.",
  confirmed: "Of those, the DNS-confirmed ones.",
};

const splitCounts = () =>
  z.looseObject({
    candidates: z.number().optional().describe(SPLIT_COUNTS_DESCRIPTIONS.candidates),
    confirmed: z.number().optional().describe(SPLIT_COUNTS_DESCRIPTIONS.confirmed),
  });

// One tool, two views: the free summary (enumerate: false) and the keyed
// enumeration (enumerate: true). `customers` vs `counts` names the split in
// each, exactly as the two product objects do.
const VendorCustomersOutputSchema = z.looseObject({
  slug: z.string().optional().describe("The vendor slug the answer is filed under."),
  vendor_name: z.string().optional().describe("Summary view: the vendor's certificate name."),
  vendor_apex: z
    .string()
    .nullable()
    .optional()
    .describe("Summary view: the vendor's own apex, null when its brand token matches none."),
  customers: splitCounts()
    .optional()
    .describe(
      "Summary view: the candidate/confirmed split. Two different claims about the same " +
        "vendor — confirmed is the DNS-confirmed subset of candidates, so adding them " +
        "double-counts.",
    ),
  countries_top: z
    .array(z.looseObject({ country: z.string().optional(), confirmed: z.number().optional() }))
    .optional()
    .describe("Summary view: top countries by CONFIRMED customers (candidates are not counted)."),
  co_use: z
    .array(z.looseObject({ slug: z.string().optional(), confirmed: z.number().optional() }))
    .optional()
    .describe(
      "Summary view: other vendors certifying this vendor's confirmed customers. The count " +
        "is this vendor's confirmed customers that the other vendor also certifies — a " +
        "candidate there, not a mutual confirmation.",
    ),
  sample_customers: z
    .array(z.string())
    .optional()
    .describe(
      "Summary view: a hash-chosen sample of the CONFIRMED customers — whatever size the " +
        "research export published, not a ranking and not a complete list.",
    ),
  confirmed: z
    .array(VendorCustomerRowSchema)
    .optional()
    .describe("Enumeration view: the DNS-confirmed customer rows."),
  candidates: z
    .array(VendorCustomerRowSchema)
    .optional()
    .describe(
      "Enumeration view: the candidate customer rows. counts.confirmed is a subset of " +
        "counts.candidates, but when `capped` is true the LISTED candidates are a " +
        "hash-chosen subset that may omit rows the confirmed list carries.",
    ),
  counts: splitCounts()
    .optional()
    .describe(
      "Enumeration view: the completeness metadata — the rows the research build holds. " +
        "counts.candidates can exceed candidates.length; see `capped`.",
    ),
  capped: z
    .boolean()
    .optional()
    .describe(
      "Enumeration view: true when the research build kept a subset of the candidates. " +
        "Says nothing about this server's own truncation — see truncation_note.",
    ),
  truncation_note: z
    .string()
    .optional()
    .describe(
      "Written by this MCP server, never by the API: present only when rows were dropped " +
        "from the lists above to stay under the response character limit. `counts` and " +
        "`capped` still describe the API's answer, not this list.",
    ),
  ...ProductProvenanceFields,
  ...ProductSnapshotFields,
});

// ---------- Shared utilities ----------

/** The configured key, or undefined when none is set. The free research-product
 *  routes (`/lei`, `/vendors/{slug}`) are unauthenticated, so those reads send
 *  no `X-API-Key` header at all rather than inventing one and letting the
 *  origin decide — everything else still requires a key. */
export function configuredApiKey(): string | undefined {
  const key = process.env.CTSCOUT_API_KEY;
  return key !== undefined && key.trim().length > 0 ? key : undefined;
}

export function getApiKey(): string {
  const key = configuredApiKey();
  if (key === undefined) {
    throw new Error(
      "CTSCOUT_API_KEY environment variable is not set. " +
        "Get a free key at https://ctscout.dev (no email, no signup) and " +
        "set it via your MCP client config (e.g. for Claude Code, " +
        "`claude mcp add ctscout -s user -e CTSCOUT_API_KEY=<key> -- npx -y ctscout-mcp-server` " +
        "writes it to ~/.claude.json under env.CTSCOUT_API_KEY).",
    );
  }
  return key;
}

interface ScanRequestBody {
  company_name?: string;
  seed_domain?: string[];
  strict_match_org_only?: boolean;
  org_match_field?: "verbatim" | "normalized";
  org_match_mode?: "substring" | "word";
  purpose?: "underwriting" | "corporate_family";
}

// Read at most `maxBytes` off a Response's body stream, then cancel the
// rest instead of buffering the whole thing via response.text() — a
// hostile or misbehaving origin streaming a multi-MB (or unbounded) error
// body would otherwise sit fully in memory before `truncateBody` ever
// gets a chance to trim it — ctscout-mcp#57. Falls back to response.text()
// when there's no readable stream to bound (a body-less response, or a
// Response-like object that doesn't expose `.body`, as some test doubles
// don't) since there's nothing to cap in that case.
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      chunks.push(value);
      bytesRead += value.byteLength;
    }
  } finally {
    // Stop pulling more data regardless of how the loop exited (cap hit,
    // natural end, or a read error) — don't let the rest of a huge body
    // keep streaming in just because we've read enough.
    await reader.cancel().catch(() => {});
  }

  // Chunk sizes aren't guaranteed to align with the budget, so the last
  // chunk read may push `bytesRead` past `maxBytes` — hard-clip when
  // concatenating. A decode boundary that lands mid-UTF-8-sequence just
  // becomes a replacement character (TextDecoder's default, non-fatal
  // behavior); acceptable for a truncated excerpt.
  const capped = new Uint8Array(Math.min(bytesRead, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= capped.length) break;
    const take = Math.min(chunk.byteLength, capped.length - offset);
    capped.set(chunk.subarray(0, take), offset);
    offset += take;
  }

  return new TextDecoder().decode(capped);
}

// Whether a route needs a key. "required" fails locally before any network
// round-trip when none is configured (every /scan and /jobs route, and the
// keyed customer enumeration). "optional" sends the header when a key exists
// and omits it otherwise: the free product routes are unauthenticated, so a
// keyless install must be able to read them.
type AuthMode = "required" | "optional";

// Shared request core for /scan, /scan/batch, /jobs and the product routes:
// identical headers, timeout, and bounded-error-body handling (readBoundedText,
// #57). The endpoints differ only in URL, method, auth mode and request/response
// shape, so every tool inherits the same error-capture bound rather than
// duplicating it. `body` undefined means a body-less request (GET).
async function callApi<T>(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
  auth: AuthMode = "required",
): Promise<T> {
  const apiKey = auth === "required" ? getApiKey() : configuredApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined && { "Content-Type": "application/json" }),
        Accept: "application/json",
        // Omitted entirely when unset: an empty header value would read as a
        // malformed key rather than as no key at all.
        ...(apiKey !== undefined && { "X-API-Key": apiKey }),
        "User-Agent": USER_AGENT,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: controller.signal,
      redirect: "error",
    });

    if (!response.ok) {
      throw new ApiError(
        response.status,
        await readBoundedText(response, ERROR_BODY_CAPTURE_LIMIT),
      );
    }

    return (await response.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new TimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function callScan(body: ScanRequestBody): Promise<ScanResponse> {
  return callApi<ScanResponse>(SCAN_URL, "POST", body);
}

// POST /scan/batch: one envelope, per-query results in input order. The
// caller (the batch tool) has already bounded `queries` to MAX_BATCH_QUERIES;
// the worker re-enforces server-side (>10 → 400) and debits quota by the
// batch length.
export async function callScanBatch(queries: ScanRequestBody[]): Promise<ScanBatchResponse> {
  return callApi<ScanBatchResponse>(SCAN_BATCH_URL, "POST", { queries });
}

// POST /jobs: queue a deep dive. 202 with the job receipt; 403 for a non-Pro
// key, 429 over JOBS_PER_DAY. Nothing on the request path touches the batch
// worker: the Worker records the job and returns.
export async function callSubmitJob(spec: DeepDiveSpec): Promise<JobSubmitResponse> {
  return callApi<JobSubmitResponse>(JOBS_URL, "POST", spec);
}

// GET /jobs/{id}: the job record; `result` only once done. 404 for an id the
// calling key did not submit (ids are scoped to the key, so "not yours" and
// "unknown" are the same answer).
export async function callGetJob(jobId: string): Promise<JobResponse> {
  return callApi<JobResponse>(`${JOBS_URL}/${encodeURIComponent(jobId)}`, "GET");
}

// The four research-product reads (ctscout-worker#336). All four answer 503
// until the weekly refresh has published a manifest, and 404 for a key absent
// from the published version. The LEI, the name and the slug are all
// caller-controlled and go into a URL, so each is escaped at the one place it
// is interpolated (the input schemas already reject the shapes that could
// matter; this is the belt-and-suspenders half).
export async function callLeiRecord(lei: string): Promise<LeiRecord> {
  return callApi<LeiRecord>(`${LEI_URL}/${encodeURIComponent(lei)}`, "GET", undefined, "optional");
}

export async function callLeiByName(name: string): Promise<LeiNameMatches> {
  const query = new URLSearchParams({ name });
  return callApi<LeiNameMatches>(`${LEI_URL}?${query.toString()}`, "GET", undefined, "optional");
}

export async function callVendorSummary(slug: string): Promise<VendorSummary> {
  return callApi<VendorSummary>(
    `${VENDORS_URL}/${encodeURIComponent(slug)}`,
    "GET",
    undefined,
    "optional",
  );
}

export async function callVendorCustomers(slug: string): Promise<VendorCustomers> {
  return callApi<VendorCustomers>(`${VENDORS_URL}/${encodeURIComponent(slug)}/customers`, "GET");
}

// Attach the snapshot date to a /scan or /scan/batch payload. Only a
// `snapshot` string on the payload itself counts (the worker does not emit one
// today; when it does, that is the authoritative per-answer date). No separate
// request supplies it: see SnapshotSource.
export function resolveSnapshot(payload: { snapshot?: unknown }): SnapshotInfo {
  if (typeof payload.snapshot === "string" && payload.snapshot.length > 0) {
    return { snapshot: payload.snapshot, snapshot_source: "scan" };
  }
  return { snapshot: null, snapshot_source: "unavailable" };
}

// The same rule for a research-product answer, reading the manifest's `as_of`
// (which the Worker attaches to every product response) rather than a
// warehouse sync date. No client-side fallback, for the same reason: a
// separately fetched version is not tied to the object that was read.
export function resolveProductSnapshot(payload: { as_of?: unknown }): ProductSnapshotInfo {
  if (typeof payload.as_of === "string" && payload.as_of.length > 0) {
    return { snapshot: payload.as_of, snapshot_source: "product" };
  }
  return { snapshot: null, snapshot_source: "unavailable" };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public responseBody: string,
  ) {
    super(`ctscout API returned ${status}`);
    this.name = "ApiError";
  }
}

export class TimeoutError extends Error {
  constructor() {
    super("ctscout API request timed out");
    this.name = "TimeoutError";
  }
}

function escapeMarkdown(text: string): string {
  if (!text) return "";
  return text.replace(/([\\`*_[\]()<>!])/g, "\\$1");
}

// Bound the raw API error body before rendering. `ApiError.responseBody`
// captures the upstream body up to ERROR_BODY_CAPTURE_LIMIT (see
// readBoundedText, ctscout-mcp#57; render-side excerpt bound: #56/#43). Truncate
// BEFORE escapeMarkdown so escape expansion can't push the excerpt back
// over the cap; the marker reports the raw (pre-escape) length.
function truncateBody(text: string, max = ERROR_BODY_LIMIT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(truncated, ${text.length} chars total)`;
}

// Every string a minimal envelope retains is proxied from the API and so
// unbounded; capping each one is what makes the envelope's size a constant
// the last-resort fallback can rely on. Same marker as truncateBody.
function boundedField<T extends string | null | undefined>(value: T): T {
  return (typeof value === "string" ? truncateBody(value, ENVELOPE_STRING_LIMIT) : value) as T;
}

// The Worker's 403 for a non-Pro key on /jobs carries `upgrade_hint`; surface
// it verbatim (bounded and escaped like any error body) so the reader sees the
// API's own upgrade text rather than a copy typed here that can drift.
function upgradeHintFrom(body: string): string | undefined {
  return jsonStringField(body, "upgrade_hint");
}

// The research-product routes report every refusal as {"detail": "..."}.
// Surfacing the API's own sentence (bounded and escaped like any error body)
// keeps the explanation from drifting away from what the Worker actually said.
function detailFrom(body: string): string | undefined {
  return jsonStringField(body, "detail");
}

function jsonStringField(body: string, field: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && field in parsed) {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
  } catch {
    // not JSON — nothing to surface
  }
  return undefined;
}

// The API's own sentence, on one line, bounded and markdown-escaped, or a
// bounded excerpt of the raw body when it is not the documented JSON shape.
function safeDetail(err: ApiError): string {
  const detail = detailFrom(err.responseBody);
  return escapeMarkdown(truncateBody((detail ?? err.responseBody).replace(/[\r\n]+/g, " ")));
}

// Which endpoint family produced an ApiError. 403/404/429 mean different
// things on /jobs than on /scan (Pro gate, job ownership, jobs quota), so the
// job tools pass "jobs"; everything else shares the scan mapping.
// "product" covers the free /lei and /vendors reads; "vendor_enumeration" is
// the keyed GET /vendors/{slug}/customers. They differ only on 401/403: only
// the enumeration has a keyless alternative to point at, and only that tool has
// an `enumerate` parameter to name.
export type ErrorSurface = "scan" | "jobs" | "product" | "vendor_enumeration";

// One copy, reached two ways: the 401/403 the origin returns, and the
// pre-flight guard that answers without a round-trip when no key is configured
// at all. Both are the same fact for the caller.
// The Worker's own sentence for "no product has ever been published" — the one
//503 body on these routes that is a state rather than an outage. Matched as a
// prefix so the parenthetical it carries today can change without this drifting.
export const PRODUCT_UNPUBLISHED_DETAIL = "Research product not yet published";

export const ENUMERATION_KEY_GUIDANCE =
  "Enumerating a vendor's customers needs an active ctscout.dev API key (any tier), and the " +
  "key in CTSCOUT_API_KEY was missing, invalid or revoked. Get a free key at " +
  "https://ctscout.dev and set it via your MCP client config. The vendor summary (counts, top " +
  "countries, co-use, sample) does not need the enumeration: call this tool with " +
  "enumerate: false.";

export function explainError(err: unknown, surface: ErrorSurface = "scan"): string {
  const isProduct = surface === "product" || surface === "vendor_enumeration";
  if (err instanceof ApiError && isProduct) {
    switch (err.status) {
      case 400:
        return `Bad request: ${safeDetail(err)}. Check the lei, name or slug you passed.`;
      case 401:
      case 403:
        return surface === "vendor_enumeration"
          ? ENUMERATION_KEY_GUIDANCE
          : "Invalid or missing CTSCOUT_API_KEY. Get a free key at https://ctscout.dev and set " +
              "it via your MCP client config.";
      case 404:
        return (
          "Not found in the current research product: no entry is published under that key. " +
          "The product covers LEIs with at least one attributed apex, and vendors the " +
          "research build confirmed; absence here is not evidence that the entity or vendor " +
          "does not exist."
        );
      case 503: {
        // 503 on these routes has two very different causes, and only the body
        // tells them apart: the Worker returns it with this specific `detail`
        // when the product has never been published, and every transient
        // failure in front of or under the Worker returns it with something
        // else (or nothing). Reporting an outage as "wait for the weekly
        // refresh" would turn a retry-in-seconds into a retry-in-days.
        const detail = detailFrom(err.responseBody);
        if (detail !== undefined && detail.includes(PRODUCT_UNPUBLISHED_DETAIL)) {
          return (
            `The research product is not published yet: ${safeDetail(err)}. These LEI and ` +
            "vendor answers come from the weekly ctscout-research refresh; until its first " +
            "publish lands, /lei and /vendors answer 503. Nothing is wrong with the query — " +
            "retry after the next refresh."
          );
        }
        // Nothing is claimed about which layer failed or how long it will last:
        // the body did not say, so neither does this.
        const said =
          detail !== undefined
            ? ` The service said: ${escapeMarkdown(truncateBody(detail.replace(/[\r\n]+/g, " ")))}.`
            : "";
        return (
          `ctscout.dev answered 503 (service unavailable) for this research-product read.${said}` +
          " This response did NOT say the research product is unpublished, so treat it as a" +
          " temporary availability failure rather than a permanent state: retry shortly, and" +
          " check https://ctscout.dev/health if it persists."
        );
      }
      default:
        break;
    }
  }
  if (err instanceof ApiError && surface === "jobs") {
    switch (err.status) {
      case 403: {
        const hint = upgradeHintFrom(err.responseBody);
        const upgrade = hint
          ? escapeMarkdown(truncateBody(hint.replace(/[\r\n]+/g, " ")))
          : "Pro is concierge-only: email pro@ctscout.dev for early access.";
        return `Deep dives require a Pro key; the key in CTSCOUT_API_KEY is not Pro. ${upgrade}`;
      }
      case 404:
        return (
          "No job with that id for this API key. Job ids are scoped to the key that " +
          "submitted them, so this is either not your job or an unknown id; use the " +
          "job_id returned by ctscout_submit_deep_dive."
        );
      case 429:
        return (
          `Daily deep-dive quota exceeded (${JOBS_PER_DAY} submissions per key per day). ` +
          "Jobs already submitted keep running and can still be polled with ctscout_get_job."
        );
      default:
        break;
    }
  }
  if (err instanceof ApiError) {
    const safeBody = escapeMarkdown(truncateBody(err.responseBody));
    switch (err.status) {
      case 400:
        return `Bad request: ${safeBody}. Check the input parameters.`;
      case 401:
        return (
          "Invalid or missing CTSCOUT_API_KEY. " +
          "Get a free key at https://ctscout.dev and set it via your MCP " +
          "client config."
        );
      case 403:
        return "API key was revoked. Get a new one at https://ctscout.dev.";
      case 429:
        return (
          "Daily request quota exceeded. Free tier is 10 queries/day. " +
          "Upgrade to pro at https://ctscout.dev for unlimited requests."
        );
      case 500:
      case 502:
      case 503:
        return `ctscout server error (${err.status}). Try again in a moment, or check https://ctscout.dev/health.`;
      default:
        return `ctscout API error: HTTP ${err.status}: ${safeBody}`;
    }
  }
  if (err instanceof TimeoutError) {
    return "Request to ctscout.dev timed out after 30 seconds. The service may be slow; try again shortly.";
  }
  if (err instanceof Error) {
    if (err.message.includes("CTSCOUT_API_KEY")) {
      return err.message;
    }
    return `Unexpected error: ${err.message}`;
  }
  return `Unexpected error: ${String(err)}`;
}

// Exported for tests. Renders two response shapes:
//
//   1. Warehouse (/scan, both tiers) — `source: "warehouse"`, each domain has
//      `{org, apex_domain, cert_count, subdomain_count, first_seen,
//      last_seen}`.
//   2. Deep-dive result (ctscout_get_job) — `source: "live-enriched" |
//      "cache-only"`, or rows carrying `enrichment` / `attributed_to`.
//      Rendered as the band / signals / evidence table, with the band
//      exactly as the API reported it: this package never derives a band
//      from a score (ctscout-mcp#99).
/** Suffixes indicating the query is already a legal entity name shape.
 *  Used to skip the brand→legal "did you mean?" hint when the user has
 *  already supplied a legal-shaped name — zero results in that case is a
 *  genuine no-match, not a brand/legal mismatch. */
const LEGAL_ENTITY_SUFFIXES =
  /\b(Inc|Corp|Corporation|Group|Companies|Company|Co|Ltd|LLC|L\.L\.C\.|AG|SA|S\.A\.|N\.V\.|GmbH|plc|Holdings|Holding)\.?$/i;

function buildLegalEntitySuggestions(rawInput: string): string[] {
  // The input is the caller-controlled query (the LLM's tool input) and is
  // interpolated into every suggestion line below — route it through the
  // cellSafe chokepoint once so a newline in company_name cannot inject
  // markdown lines into the output (ctscout-mcp#50).
  const input = cellSafe(rawInput, 200);

  // Sector-neutral suffixes.
  const variants = [
    `${input} Companies`,
    `${input} Company`,
    `${input} Group`,
    `${input} Inc`,
    `${input} Corporation`,
    `The ${input}`,
  ];

  const suggestions = [
    `If "${input}" is a common/brand name, the cert subject (O field) likely uses a longer legal entity name. Try one of these variants:`,
    "",
    ...variants.map((v) => `  • ${v}`),
  ];

  // If the user already included "Insurance" or "Financial" we don't need to append it again,
  // just the legal suffix. If they didn't, we should provide the sector-specific variants.
  const hasFinancialOrInsuranceTerm = /\b(Insurance|Financial)\b/i.test(input);
  if (!hasFinancialOrInsuranceTerm) {
    suggestions.push(
      "",
      `Or, if this is a financial/insurance brand:`,
      "",
      `  • ${input} Insurance Company`,
      `  • ${input} Financial Services Group`,
      `  • The ${input} Financial Services Group, Inc.`,
    );
  }

  return suggestions;
}

/** Hint context for empty-result rendering. `kind === "company"` means the
 *  query was a company name (search_company tool); we use the `query`
 *  argument as the basis for did-you-mean suggestions. `kind === "domain"`
 *  means the query was a domain list (lookup_domain tool) and brand/legal
 *  suggestions don't apply — empty-result there is the DV-only certs
 *  caveat, not a name-form issue. */
export type FormatHint = { kind: "company" } | { kind: "domain" };
type TableKind = "free" | "pro";

export function formatScanAsMarkdown(
  query: string,
  response: ScanResponse,
  hint?: FormatHint,
): string {
  const lines: string[] = [];
  // The query is caller-controlled (the LLM's tool input): a newline in
  // company_name could inject arbitrary markdown lines above the table.
  // Route it through the same cellSafe chokepoint as every API-derived
  // value (ctscout-mcp#50). The other caller-controlled interpolation —
  // the legal-entity suggestions on the hinted zero-result path — escapes
  // the same way inside buildLegalEntitySuggestions.
  lines.push(`# ctscout results for: ${cellSafe(query, 200)}`);
  lines.push("");
  if (response.snapshot_source !== undefined) {
    lines.push(snapshotLine(response));
    lines.push("");
  }

  if (response.domains.length === 0) {
    if (
      response.match_type === "semantic" &&
      Array.isArray(response.candidates) &&
      response.candidates.length > 0
    ) {
      lines.push("No attributed OV/EV warehouse domains matched.");
      lines.push("");
      lines.push(
        "Candidate organizations — not attributed, semantic name similarity only (weak signal; corroborate before use):",
      );
      lines.push("");
      lines.push("| Candidate organization | Similarity | Top apex domain |");
      lines.push("|---|---:|---|");
      for (const candidate of response.candidates) {
        const similarity =
          typeof candidate.similarity === "number" && Number.isFinite(candidate.similarity)
            ? candidate.similarity.toFixed(2)
            : "—";
        lines.push(
          `| ${cellSafe(candidate.org, 80)} | ${similarity} | ${cellSafe(candidate.top_apex_domain, 60)} |`,
        );
      }
      if (response.truncated && response.upgrade_hint) {
        lines.push("");
        lines.push(`> ${cellSafe(response.upgrade_hint, ENVELOPE_STRING_LIMIT)}`);
      }
      return lines.join("\n");
    }

    // Empty domains from truncation (truncateWithRender's 1-domain break
    // zeroes the list when a single result itself exceeds CHARACTER_LIMIT)
    // is NOT a "no matches" result. Explain the size-based drop and surface
    // the upgrade_hint so the visible text matches the `truncated` flag —
    // otherwise the reader wrongly sees "No domains found". Guard on BOTH
    // `truncated` and `upgrade_hint` (mirroring the non-empty path below):
    // truncateWithRender always sets them together, so a bare upstream
    // `truncated` flag without a hint is not our size-drop signal and
    // correctly falls through to the "No domains found" message.
    if (response.truncated && response.upgrade_hint) {
      lines.push("All matching results were dropped to keep the response under the size limit.");
      lines.push("");
      lines.push(`> ${cellSafe(response.upgrade_hint, ENVELOPE_STRING_LIMIT)}`);
      return lines.join("\n");
    }
    lines.push(
      "No domains found. Try a partial company name (e.g. 'Goldman' instead of 'Goldman Sachs Group, Inc.') or a different domain.",
    );
    if (hint?.kind === "company") {
      const q = query.trim();
      if (q && !LEGAL_ENTITY_SUFFIXES.test(q)) {
        lines.push("");
        lines.push(...buildLegalEntitySuggestions(q));
      }
    }
    return lines.join("\n");
  }

  // Shape detection. A deep-dive result (ProScanResult) is read from its
  // source and from every row, not from the first row alone: a degraded
  // deep-dive row can lack `enrichment` while the rows after it carry one,
  // and `attributed_to` is the batch worker's claim on a row, so a deep dive
  // whose rows are all degraded and whose source is absent is still told
  // apart. An explicit free-tier source is authoritative: a warehouse row may
  // carry attributed_to (the schema permits it) without being a deep dive.
  // Anything else is the warehouse table; there is no third shape, and no
  // band is ever derived here from a numeric field (ctscout-mcp#99).
  const proSource = response.source === "live-enriched" || response.source === "cache-only";
  const anyPro = response.domains.some((d) => d.enrichment != null || d.attributed_to != null);
  const freeSource = response.source === "warehouse" || response.source === "live";
  const isDeepDive = !freeSource && (proSource || anyPro);

  const totalDisplay = response.total ?? response.domains.length;
  // Every API-provided string the renderer prints is capped (upgrade_hint and
  // source here, cells in formatTable): the halving loop can only remove rows,
  // so a scalar over budget would otherwise leave nothing for it to cut.
  const sourceDisplay = cellSafe(response.source ?? "unknown", 40);

  lines.push(
    `Returned **${response.domains.length}** attributed domain(s) of ${totalDisplay} total. ` +
      `Source: \`${sourceDisplay}\`${isDeepDive ? " _(Pro tier — multi-signal attribution)_" : ""}.`,
  );
  if (response.truncated && response.upgrade_hint) {
    lines.push("");
    lines.push(`> ${cellSafe(response.upgrade_hint, ENVELOPE_STRING_LIMIT)}`);
  }
  lines.push("");

  lines.push(formatTable(response.domains, isDeepDive ? "pro" : "free"));

  return lines.join("\n");
}

function formatTable(domains: DomainResult[], kind: TableKind): string {
  const rows: string[] = [];

  // Every table names the org column "Attributed to": the row is a cert-subject
  // attribution, never an ownership claim, and never a semantic candidate.
  if (kind === "free") {
    rows.push("| Domain | Attributed to | Certs | Subdomains |");
    rows.push("|---|---|---:|---:|");
  } else {
    rows.push("| Domain | Attributed to | Band | Signals | Evidence |");
    rows.push("|---|---|---|---|---|");
  }

  for (const d of domains) {
    if (kind === "free") {
      const domain = d.apex_domain ?? d.domain;
      const org = d.org ?? d.cert_org_names?.[0] ?? d.rdap_org;
      rows.push(
        `| \`${cellSafe(domain, 60)}\` | ${cellSafe(org, 50)} | ${d.cert_count ?? "—"} | ${d.subdomain_count ?? "—"} |`,
      );
    } else {
      const domain = d.apex_domain ?? d.domain;
      const org = d.attributed_to ?? d.org ?? d.cert_org_names?.[0] ?? d.rdap_org;
      const enriched = d.enrichment;
      if (enriched == null) {
        // Degraded row: the collectors did not run for this apex, so the
        // attribution stands without a band. Absent is rendered as absent.
        rows.push(`| \`${cellSafe(domain, 60)}\` | ${cellSafe(org, 50)} | _missing_ | — | — |`);
      } else {
        // The advertised schema keeps every enrichment field optional, so a
        // schema-valid row can lack any of them: render absent as empty.
        const bandEmoji = bandIndicator(enriched.confidence_band);
        const overrideTag = enriched.vlm_override ? " 🚫VLM-veto" : "";
        const matchedVia = Array.isArray(enriched.matched_via) ? enriched.matched_via : [];
        const signalSummary = matchedVia.length
          ? matchedVia.slice(0, 3).join(", ") +
            (matchedVia.length > 3 ? `, +${matchedVia.length - 3}` : "")
          : "_none_";
        const topEvidence = topEvidenceLine(enriched.evidence);
        rows.push(
          `| \`${cellSafe(domain, 60)}\` | ${cellSafe(org, 50)} | ${bandEmoji} ${cellSafe(enriched.confidence_band, 20)}${overrideTag} | ${cellSafe(signalSummary)} | ${topEvidence} |`,
        );
      }
    }
  }

  return rows.join("\n");
}

// Sanitize a cell value for markdown-table inclusion. Replace pipes with a
// Unicode lookalike (U+2502), collapse newlines, fall back to em-dash for
// null/undefined/empty inputs, and truncate with ellipsis past `maxLen`.
function cellSafe(s: string | null | undefined, maxLen = 80): string {
  if (s == null) return "—";
  const stripped = String(s)
    .replace(/\|/g, "│")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (stripped.length === 0) return "—";
  return capLength(stripped, maxLen);
}

// ---------- Deep-dive band table helpers ----------

function bandIndicator(band: ConfidenceBand | undefined): string {
  switch (band) {
    case "verified":
      return "✅";
    case "likely":
      return "🟢";
    case "possible":
      return "🟡";
    case "insufficient":
      return "⚪";
    default:
      return "❔";
  }
}

// Pick the single most informative evidence string for the table cell.
// Priority order matches the scorer's signal weights: DNS brand tokens >
// og:site_name > VLM > others. Keeps the row scannable.
const EVIDENCE_PRIORITY = [
  "dns_txt_brand_token",
  "og_site_name_match",
  "vlm_verdict_verified",
  "rdap_registrant_match",
  "homepage_title_brand_token",
  "ip_asn_custom_org",
  "san_cohort_overlap",
  "vlm_verdict_no",
];

function topEvidenceLine(evidence: Record<string, string> | null | undefined): string {
  if (evidence == null || typeof evidence !== "object") return "_no evidence_";
  for (const key of EVIDENCE_PRIORITY) {
    if (key in evidence && typeof evidence[key] === "string") {
      return escapeForTable(capLength(evidence[key], 80));
    }
  }
  // Fallback: first string value in dict order
  for (const key in evidence) {
    if (typeof evidence[key] === "string") return escapeForTable(capLength(evidence[key], 80));
  }
  return "_no evidence_";
}

// Ellipsis-cap a string past `maxLen`, the cellSafe rule without its cell
// sanitizing, for strings that go through escapeForTable instead.
function capLength(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

// Defensive: pipe AND any line terminator (CR, LF, CRLF) would break the
// markdown table. Replace pipes with backslash-pipe and any line terminator
// (or terminator pair) with a single space.
function escapeForTable(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

// One line naming the warehouse sync date the answer was read from, and where
// that date came from, so a reader of the markdown gets the same fact as a
// reader of structuredContent.
function snapshotLine(info: Partial<SnapshotInfo>): string {
  switch (info.snapshot_source) {
    case "scan":
      return `_Warehouse snapshot: ${cellSafe(info.snapshot, 40)} (reported by the API response)._`;
    default:
      return "_Warehouse snapshot: unknown — the API did not report a sync date._";
  }
}

// Both output formats are capped at CHARACTER_LIMIT, so the hint must not
// point at JSON as an escape hatch for size (it used to — ctscout-mcp#42).
function truncationHint(kept: number, total: number, kind = "domains"): string {
  return (
    `Response truncated to ${kept} of ${total} ${kind} ` +
    `to stay under ${CHARACTER_LIMIT} chars. Refine the query to narrow ` +
    `the results (JSON output is truncated the same way).`
  );
}

function fullyTruncatedHint(response: Pick<ScanResponse, "domains" | "candidates">): string {
  const candidateCount = Array.isArray(response.candidates) ? response.candidates.length : 0;
  if (candidateCount > 0) {
    return truncationHint(0, candidateCount, "semantic candidates");
  }
  const domainCount = Array.isArray(response.domains) ? response.domains.length : 0;
  return truncationHint(0, domainCount);
}

// Shared halving loop: drop whole trailing domain entries, then semantic
// candidates, and re-render until the text fits. Parameterizing the renderer
// keeps Markdown and JSON bounds identical.
function truncateWithRender(
  text: string,
  structured: ScanResponse,
  render: (s: ScanResponse) => string,
  // Defaults to the whole-response budget. The batch renderer passes a smaller
  // per-company slice so one company's huge result can't starve the others.
  limit: number = CHARACTER_LIMIT,
  // The hint the response carried before any halving (the API's own, or the
  // job path's strip notice): it says why the result was already incomplete,
  // so the halving notice is prefixed to it rather than replacing it. A
  // caller that halves the same record twice passes the original so the
  // second pass does not stack a second halving notice on the first.
  priorHint: string | undefined = structured.upgrade_hint,
  // The domain count the hint reports against; the same caller passes the
  // pre-halving count so the second pass does not report the first's output
  // as the total.
  originalTotal: number = structured.domains.length,
): {
  text: string;
  structured: ScanResponse;
} {
  let currentText = text;
  let currentStructured = structured;
  const prior = boundedField(priorHint);
  const withPrior = (hint: string) => (prior ? `${hint} ${prior}` : hint);
  const originalCandidates = Array.isArray(structured.candidates)
    ? structured.candidates
    : undefined;

  while (currentText.length > limit && currentStructured.domains.length > 0) {
    // If we're down to 1 domain and still over the limit, we must break to avoid infinite loop
    if (currentStructured.domains.length === 1) {
      currentStructured = {
        ...currentStructured,
        domains: [],
        truncated: true,
        upgrade_hint: withPrior(truncationHint(0, originalTotal)),
      };
      currentText = render(currentStructured);
      break;
    }

    const halved = Math.max(1, Math.floor(currentStructured.domains.length / 2));
    currentStructured = {
      ...currentStructured,
      domains: currentStructured.domains.slice(0, halved),
      truncated: true,
      upgrade_hint: withPrior(truncationHint(halved, originalTotal)),
    };
    currentText = render(currentStructured);
  }

  while (
    currentText.length > limit &&
    Array.isArray(currentStructured.candidates) &&
    currentStructured.candidates.length > 0
  ) {
    const kept =
      currentStructured.candidates.length === 1
        ? 0
        : Math.max(1, Math.floor(currentStructured.candidates.length / 2));
    currentStructured = {
      ...currentStructured,
      candidates: currentStructured.candidates.slice(0, kept),
      truncated: true,
      upgrade_hint: withPrior(
        truncationHint(
          kept,
          originalCandidates?.length ?? currentStructured.candidates.length,
          "semantic candidates",
        ),
      ),
    };
    currentText = render(currentStructured);
  }

  return { text: currentText, structured: currentStructured };
}

export function truncateIfNeeded(
  text: string,
  structured: ScanResponse,
  query: string,
  hint?: FormatHint,
): {
  text: string;
  structured: ScanResponse;
} {
  // Re-render with the ORIGINAL query + hint (not "(truncated)") so the
  // truncated header still reads `# ctscout results for: <query>` and the
  // call signature stops lying about the dropped context (ctscout-mcp#41).
  return truncateWithRender(text, structured, (s) => formatScanAsMarkdown(query, s, hint));
}

// JSON-format responses must respect CHARACTER_LIMIT too (ctscout-mcp#42).
// Strategy: pretty-print when it fits; otherwise fall back to compact
// stringify (often 30-50% smaller), then halve domains as in markdown.
// Truncated output stays valid JSON and self-describes via truncated /
// upgrade_hint fields.
export function truncateJsonIfNeeded(structured: ScanResponse): {
  text: string;
  structured: ScanResponse;
} {
  const pretty = JSON.stringify(structured, null, 2);
  if (pretty.length <= CHARACTER_LIMIT) {
    return { text: pretty, structured };
  }

  const result = truncateWithRender(JSON.stringify(structured), structured, (s) =>
    JSON.stringify(s),
  );

  // Pathological case: top-level fields alone (e.g. a huge run_metadata
  // from the real Pro tier) exceed the limit even with zero domains.
  // Markdown can't hit this — it only renders known fields — so match its
  // bound by emitting a minimal valid envelope of known, bounded fields.
  if (result.text.length > CHARACTER_LIMIT) {
    const minimal = minimalScanEnvelope(structured);
    return { text: JSON.stringify(minimal), structured: minimal };
  }

  return result;
}

// The smallest valid ScanResponse for a payload whose top-level fields alone
// exceed the budget: known fields only, every retained string capped at
// ENVELOPE_STRING_LIMIT, snapshot kept when present.
function minimalScanEnvelope(structured: ScanResponse): ScanResponse {
  return {
    domains: [],
    total: structured.total,
    truncated: true,
    upgrade_hint: fullyTruncatedHint(structured),
    source: boundedField(structured.source),
    match_type: boundedField(structured.match_type),
    org_match_strategy: boundedField(structured.org_match_strategy),
    ...(structured.empty_reason !== undefined && {
      empty_reason: boundedField(structured.empty_reason),
    }),
    ...(Array.isArray(structured.candidates) && { candidates: [] }),
    ...(structured.snapshot_source !== undefined && {
      snapshot: boundedField(structured.snapshot ?? null),
      snapshot_source: structured.snapshot_source,
    }),
  };
}

// ---------- Batch rendering + fair-share budgeting ----------

// Anti-starvation budget split for N batch sections sharing one character
// budget. Every section gets an equal floor (`totalBudget / N`); sections
// that fit under their floor donate the slack into a pool that is split once,
// equally, among the sections that would otherwise be truncated. Single pass
// (no iterative water-filling) and monotonic — redistribution only ever RAISES
// a section's budget above the floor, so the floor guarantee (no section
// starved below `budget / N`) always holds. This is what stops one company's
// huge result from crowding the others out of the shared response budget.
export function fairShareBudgets(fullLengths: number[], totalBudget: number): number[] {
  const n = fullLengths.length;
  if (n === 0) return [];
  const floor = Math.floor(Math.max(0, totalBudget) / n);
  const overflow: number[] = [];
  let surplus = 0;
  for (let i = 0; i < n; i++) {
    if (fullLengths[i] <= floor) {
      surplus += floor - fullLengths[i];
    } else {
      overflow.push(i);
    }
  }
  const budgets = new Array<number>(n).fill(floor);
  if (overflow.length > 0 && surplus > 0) {
    const bonus = Math.floor(surplus / overflow.length);
    for (const i of overflow) {
      budgets[i] = floor + bonus;
    }
  }
  return budgets;
}

// Demote the single-company renderer's H1 to an H2 so each section nests under
// the batch-level H1. Only the first line is an H1, so no multiline flag.
function demoteHeading(md: string): string {
  return md.startsWith("# ") ? `#${md}` : md;
}

// Render a per-query failure (the 207-style partial-failure envelope: a query
// can fail while the batch as a whole succeeds). Bound + escape the upstream
// message exactly as explainError does for a single-scan error body (#56):
// truncateBody first, then escapeMarkdown.
function renderBatchErrorSection(
  name: string,
  error: { code: number; message: string },
  limit: number,
): string {
  const heading = `## ctscout results for: ${cellSafe(name, 200)}`;
  const codeSafe = Number.isFinite(error?.code) ? error.code : "unknown";
  // Collapse line terminators FIRST: a newline in the upstream message would
  // otherwise break out of the `> ` blockquote and let a hostile/buggy origin
  // inject a heading or table row (the #50 untrusted-string threat model).
  // Then bound + escape exactly as explainError does for a single-scan body.
  const flat = String(error?.message ?? "").replace(/[\r\n]+/g, " ");
  const msg = escapeMarkdown(truncateBody(flat));
  const block = `${heading}\n\n> ⚠️ This query failed (HTTP ${codeSafe}): ${msg}`;
  return block.length > limit ? `${block.slice(0, Math.max(0, limit - 1))}…` : block;
}

// Render one company's section within its allotted slice. Success reuses the
// single-company markdown renderer (cellSafe / shape detection / empty-result
// handling / the #54 query-context idiom all come for free) bounded via the
// shared halving loop; failure renders an error block.
function renderCompanySection(name: string, item: BatchResultItem, limit: number): string {
  if (isBatchError(item)) {
    return renderBatchErrorSection(name, item.error, limit);
  }
  const resp: ScanResponse = {
    ...item,
    domains: Array.isArray(item.domains) ? item.domains : [],
  };
  const full = formatScanAsMarkdown(name, resp, { kind: "company" });
  const { text } = truncateWithRender(
    full,
    resp,
    (s) => formatScanAsMarkdown(name, s, { kind: "company" }),
    limit,
  );
  return demoteHeading(text);
}

function batchQuotaFooter(remaining: number | null): string {
  return remaining == null
    ? "_Remaining quota: unlimited (Pro tier)._"
    : `_Remaining quota today: ${remaining}._`;
}

// Assemble header + sections + footer. The fair-share split bounds each
// section to its slice, and the slices plus the reserved envelope overhead sum
// to <= CHARACTER_LIMIT, so `joined` is already within budget. The hard clamp
// is a last-resort byte guard in case that invariant is ever broken upstream —
// it keeps the character-limit contract absolute rather than trusting the
// arithmetic.
function assembleBatchMarkdown(header: string, sections: string[], footer: string): string {
  const joined = [header, ...sections, footer].join("\n\n");
  return joined.length <= CHARACTER_LIMIT ? joined : joined.slice(0, CHARACTER_LIMIT);
}

export function formatBatchAsMarkdown(companyNames: string[], batch: ScanBatchResponse): string {
  const results = batch.results;
  const n = results.length;
  const title = `# ctscout batch results (${n} ${n === 1 ? "company" : "companies"})`;
  // The snapshot line is part of the header so the budget arithmetic below
  // reserves space for it like any other envelope text.
  const header = batch.snapshot_source === undefined ? title : `${title}\n\n${snapshotLine(batch)}`;
  const footer = batchQuotaFooter(batch.remaining_quota);

  if (n === 0) {
    return `${header}\n\n_No results returned._\n\n${footer}`;
  }

  // Reserve the envelope overhead (header + footer + the "\n\n" joiners around
  // n + 2 pieces, plus 1 char/section for the H1→H2 demote) before dividing
  // the rest equally among companies.
  const joinerOverhead = (n + 1) * 2 + n;
  const budget = Math.max(0, CHARACTER_LIMIT - header.length - footer.length - joinerOverhead);

  // The company name is the caller's own input (already sanitized via cellSafe
  // downstream); fall back to the echoed query only if inputs and results
  // misalign in length.
  const nameFor = (i: number): string =>
    companyNames[i] ?? results[i].query?.company_name ?? "(unnamed)";

  // Preserve every complete section when the joined response already fits.
  // Only invoke fair-share truncation after proving the full batch is over the
  // transport limit; otherwise an uneven but under-limit batch can lose rows.
  const fullSections = results.map((item, i) =>
    renderCompanySection(nameFor(i), item, CHARACTER_LIMIT),
  );
  const full = [header, ...fullSections, footer].join("\n\n");
  if (full.length <= CHARACTER_LIMIT) return full;

  const fullLengths = fullSections.map((section) => section.length);
  const budgets = fairShareBudgets(fullLengths, budget);
  const sections = results.map((item, i) => renderCompanySection(nameFor(i), item, budgets[i]));

  return assembleBatchMarkdown(header, sections, footer);
}

// Bound one batch result item's compact JSON to `limit`. Every item is
// guaranteed <= its slice on return, so the batch formatter can preserve a
// result representation for every accepted input.
function truncateResultJson(item: BatchResultItem, limit: number): BatchResultItem {
  if (isBatchError(item)) {
    if (JSON.stringify(item).length <= limit) return item;
    // A huge upstream error.message would otherwise blow the slice. Cap it to
    // ERROR_BODY_LIMIT (as the markdown error section does) — always << slice.
    return {
      query: item.query,
      error: {
        code: item.error.code,
        message: truncateBody(String(item.error.message ?? "")),
      },
    };
  }
  const resp: ScanResponse = {
    ...item,
    domains: Array.isArray(item.domains) ? item.domains : [],
  };
  const { structured } = truncateWithRender(
    JSON.stringify(resp),
    resp,
    (s) => JSON.stringify(s),
    limit,
  );
  // If known bulk has been halved away but the echoed query or arbitrary
  // proxied top-level fields still exceed the slice, emit a minimal
  // bounded envelope — mirrors the single-scan guard in truncateJsonIfNeeded.
  if (JSON.stringify(structured).length > limit) {
    return {
      query: item.query,
      domains: [],
      total: item.total,
      truncated: true,
      upgrade_hint: fullyTruncatedHint(item),
      source: item.source,
      match_type: item.match_type,
      org_match_strategy: item.org_match_strategy,
      ...(item.empty_reason !== undefined && { empty_reason: item.empty_reason }),
      ...(Array.isArray(item.candidates) && { candidates: [] }),
    };
  }
  return structured as BatchResultItem;
}

// JSON-format batch output respects CHARACTER_LIMIT too (#53), via the same
// fair-share split as the markdown path: pretty-print when it fits, then try
// compact JSON, then bound each result's domains/candidates without evicting
// accepted input queries. Truncated output stays valid JSON.
export function truncateBatchJsonIfNeeded(batch: ScanBatchResponse): {
  text: string;
  structured: ScanBatchResponse;
} {
  const pretty = JSON.stringify(batch, null, 2);
  if (pretty.length <= CHARACTER_LIMIT) {
    return { text: pretty, structured: batch };
  }
  const compact = JSON.stringify(batch);
  if (compact.length <= CHARACTER_LIMIT) {
    return { text: compact, structured: batch };
  }

  const results = batch.results;
  const n = results.length;
  // Envelope fields kept verbatim on every truncated shape (quota + snapshot).
  const envelope = {
    remaining_quota: batch.remaining_quota,
    ...(batch.snapshot_source !== undefined && {
      snapshot: batch.snapshot ?? null,
      snapshot_source: batch.snapshot_source,
    }),
  };
  const skeleton = JSON.stringify({ results: [], ...envelope });
  const budget = Math.max(0, CHARACTER_LIMIT - skeleton.length - n); // ≈ per-item commas
  const fullLengths = results.map((item) => JSON.stringify(item).length);
  const budgets = fairShareBudgets(fullLengths, budget);
  const truncatedResults = results.map((item, i) => truncateResultJson(item, budgets[i]));

  let structured: ScanBatchResponse = { results: truncatedResults, ...envelope };
  let text = JSON.stringify(structured);

  // With at most ten validated 200-character names, the envelope reserve and
  // bounded per-item representations retain one result for every accepted
  // input. Keep a minimal all-results guard in case formatter accounting
  // changes later; never silently evict trailing queries.
  if (text.length > CHARACTER_LIMIT) {
    structured = {
      results: results.map((item) =>
        isBatchError(item)
          ? {
              query: item.query,
              error: {
                code: item.error.code,
                message: "Error detail omitted to fit the MCP response limit.",
              },
            }
          : {
              query: item.query,
              domains: [],
              total: item.total,
              truncated: true,
              upgrade_hint: fullyTruncatedHint(item),
              source: item.source,
              match_type: item.match_type,
              org_match_strategy: item.org_match_strategy,
              ...(item.empty_reason !== undefined && {
                empty_reason: item.empty_reason,
              }),
              ...(Array.isArray(item.candidates) && { candidates: [] }),
            },
      ),
      ...envelope,
    };
    text = JSON.stringify(structured);
  }

  return { text, structured };
}

// ---------- Deep-dive job rendering ----------

const POLL_GUIDANCE =
  "Poll with ctscout_get_job: wait about 30 s before the first poll, then back off " +
  "toward 5 min between polls. The batch worker picks up queued jobs every few minutes.";

export function formatJobSubmittedAsMarkdown(
  spec: DeepDiveSpec,
  receipt: JobSubmitResponse,
): string {
  const target = [
    ...(spec.company_name !== undefined ? [cellSafe(spec.company_name, 200)] : []),
    ...(spec.seed_domain !== undefined ? [cellSafe(spec.seed_domain.join(", "), 200)] : []),
  ].join(" / ");
  return [
    "# ctscout deep dive submitted",
    "",
    `- Target: ${target}`,
    `- Job id: \`${cellSafe(receipt.job_id, 64)}\``,
    `- Status: \`${cellSafe(receipt.status, 20)}\``,
    `- Submitted at: ${cellSafe(receipt.submitted_at, 40)}`,
    "",
    `Asynchronous — nothing is attributed yet. ${POLL_GUIDANCE}`,
  ].join("\n");
}

// A deep dive's label in the results heading: the entity name the worker
// echoes, else the seed domains, else the job id.
function jobResultLabel(job: JobResponse): string {
  const entity = job.result?.entity;
  if (entity && typeof entity === "object") {
    const { company_name, seed_domain } = entity as DeepDiveSpec;
    if (typeof company_name === "string" && company_name.length > 0) return company_name;
    if (Array.isArray(seed_domain) && seed_domain.length > 0) return seed_domain.join(", ");
  }
  return job.job_id;
}

// Everything about the job except the result: status lines, and for a job
// that is not done, what to do next. Bounded API-derived strings only.
function jobHeader(job: JobResponse): string {
  const lines = [
    `# ctscout deep dive \`${cellSafe(job.job_id, 64)}\``,
    "",
    `- Status: \`${cellSafe(job.status, 20)}\``,
    `- Submitted at: ${cellSafe(job.submitted_at, 40)}`,
  ];
  if (job.started_at) lines.push(`- Started at: ${cellSafe(job.started_at, 40)}`);
  if (job.finished_at) lines.push(`- Finished at: ${cellSafe(job.finished_at, 40)}`);
  switch (job.status) {
    case "queued":
    case "running":
      lines.push("", `Not finished yet; no attribution to report. ${POLL_GUIDANCE}`);
      break;
    case "failed":
      lines.push(
        `- Error: ${escapeMarkdown(truncateBody(String(job.error ?? "").replace(/[\r\n]+/g, " "))) || "—"}`,
        "",
        "The deep dive failed; there is no result. Submit a new one with ctscout_submit_deep_dive if the cause was transient.",
      );
      break;
    case "done":
      if (job.result?.signals_degraded === true) {
        lines.push(
          "- ⚠️ Signals degraded: one or more enrichment collectors failed on this run. " +
            "Absent evidence on a row is not a negative signal.",
        );
      }
      if (job.result?.worker_version) {
        lines.push(`- Worker version: ${cellSafe(job.result.worker_version, 40)}`);
      }
      lines.push(
        "",
        "_Visual brand verification (VLM) is not part of deep dives in v1: vlm_status stays pending or skipped and never vetoes a band._",
      );
      break;
    default:
      break;
  }
  return lines.join("\n");
}

// The result as a ScanResponse with this server's snapshot fields resolved
// from the worker-set date, so the scan renderers and envelopes apply as-is.
function jobResultData(job: JobResponse): DeepDiveResult | undefined {
  if (job.status !== "done" || job.result == null) return undefined;
  const result = job.result;
  return {
    ...result,
    domains: Array.isArray(result.domains) ? result.domains : [],
    ...resolveSnapshot(result),
  };
}

// The job record this server returns: the API's record, the (possibly
// truncated) result, and the top-level snapshot fields every tool carries.
function wrapJob(job: JobResponse, result: DeepDiveResult | undefined): JobResponse {
  // The status decides what the record carries, whatever the API attached:
  // a result only when done, an error only when failed. The markdown shows
  // nothing else, so structuredContent exposes nothing else.
  const { result: _result, error, ...rest } = job;
  const record: JobResponse = {
    ...rest,
    ...(job.status === "failed" && error != null && { error }),
  };
  if (result === undefined) {
    return { ...record, snapshot: null, snapshot_source: "unavailable" };
  }
  return {
    ...record,
    result,
    snapshot: result.snapshot ?? null,
    snapshot_source: result.snapshot_source ?? "unavailable",
  };
}

// Markdown: the job header, then (when done) the Pro attribution table under
// it, bounded by the same halving loop as a single scan within what the
// header leaves of the character budget.
export function formatJobAsMarkdown(job: JobResponse): {
  text: string;
  structured: JobResponse;
} {
  const header = jobHeader(job);
  const rawData = jobResultData(job);
  if (rawData === undefined) {
    return { text: clampText(header), structured: boundedJobRecord(job, undefined) };
  }
  // Shrink the record before rendering, so the markdown is rendered from
  // the same structure the client receives (and shows the strip hint).
  const stripped = stripNonRendered(job, rawData);
  // The structured record must fit the JSON budget on its own: stripping can
  // leave it just over once the hint is attached, and the markdown limit
  // below measures rendered text, not the record. Halve against the record
  // first, then against the rendering, so both carry the same domains.
  const wrap = (s: ScanResponse) => JSON.stringify(wrapJob(stripped.job, s));
  const prior = stripped.data.upgrade_hint;
  const total = stripped.data.domains.length;
  const fit = truncateWithRender(
    wrap(stripped.data),
    stripped.data,
    wrap,
    CHARACTER_LIMIT,
    prior,
    total,
  );
  const label = jobResultLabel(job);
  const render = (s: ScanResponse) => demoteHeading(formatScanAsMarkdown(label, s));
  const { text, structured } = truncateWithRender(
    render(fit.structured),
    fit.structured,
    render,
    Math.max(0, CHARACTER_LIMIT - header.length - 2),
    prior,
    total,
  );
  return {
    text: clampText(`${header}\n\n${text}`),
    structured: boundedJobRecord(stripped.job, structured),
  };
}

// Final, unconditional clamp on the job tools' markdown: every rendered
// string is capped upstream, so this is the guarantee rather than the
// mechanism. Cuts at a line boundary and says so, like the halving hint.
export function clampText(text: string, limit: number = CHARACTER_LIMIT): string {
  if (text.length <= limit) return text;
  const hint = `> ${clampHint(limit)}`;
  const room = Math.max(0, limit - hint.length - 2);
  const head = text.slice(0, room);
  const cut = head.lastIndexOf("\n");
  return `${cut > 0 ? head.slice(0, cut) : head}\n\n${hint}`;
}

function clampHint(limit: number): string {
  return (
    `Response clamped to stay under ${limit} chars; the rendered text was cut here. ` +
    "Refine the query to narrow the results (JSON output is truncated the same way)."
  );
}

// The result's own scalar strings, capped in place (the same cap the minimal
// envelope applies), so an oversized upgrade_hint or source is bounded
// without dropping anything else.
function boundResultStrings(data: DeepDiveResult): DeepDiveResult {
  return {
    ...data,
    ...(data.upgrade_hint !== undefined && { upgrade_hint: boundedField(data.upgrade_hint) }),
    ...(data.source !== undefined && { source: boundedField(data.source) }),
    ...(data.empty_reason !== undefined && { empty_reason: boundedField(data.empty_reason) }),
    ...(data.match_type !== undefined && { match_type: boundedField(data.match_type) }),
    ...(data.org_match_strategy !== undefined && {
      org_match_strategy: boundedField(data.org_match_strategy),
    }),
    ...(data.snapshot != null && { snapshot: boundedField(data.snapshot) }),
    ...(data.worker_version !== undefined && { worker_version: boundedField(data.worker_version) }),
    ...(data.job_id !== undefined && { job_id: boundedField(data.job_id) }),
  };
}

// The result-level keys this server knows (DeepDiveResultSchema's declared
// properties); anything else is a forward-compatible extra the markdown never
// renders, dropped before any known field is.
const KNOWN_RESULT_KEYS = new Set([
  "domains",
  "total",
  "truncated",
  "upgrade_hint",
  "source",
  "candidates",
  "match_type",
  "org_match_strategy",
  "empty_reason",
  "snapshot",
  "snapshot_source",
  "entity",
  "run_metadata",
  "job_id",
  "worker_version",
  "signals_degraded",
  "signals_attempted",
]);

// The row-level and enrichment-level keys the advertised schema declares;
// a forward-compatible extra on a row is dropped before any row is.
const KNOWN_DOMAIN_KEYS = new Set(Object.keys(DeepDiveDomainSchema.shape));
const KNOWN_ENRICHMENT_KEYS = new Set(Object.keys(DeepDiveEnrichmentSchema.shape));

function knownRowFields(row: DeepDiveDomain): DeepDiveDomain {
  const kept = Object.fromEntries(
    Object.entries(row).filter(([key]) => KNOWN_DOMAIN_KEYS.has(key)),
  ) as DeepDiveDomain;
  if (kept.enrichment != null) {
    kept.enrichment = Object.fromEntries(
      Object.entries(kept.enrichment).filter(([key]) => KNOWN_ENRICHMENT_KEYS.has(key)),
    ) as ProEnrichment;
  }
  return kept;
}

// Every string in a row capped and every list or map cut to its first
// entries, so no single field can cost the row its place: the renderer
// shows at most a few entries of any list and caps every cell, so a value
// past these limits was never going to be read. Applied only once the
// record is over budget, like the other steps.
const ROW_LIST_LIMIT = 20;

function boundValue(value: unknown): unknown {
  if (typeof value === "string") return boundedField(value);
  if (Array.isArray(value)) return value.slice(0, ROW_LIST_LIMIT).map(boundValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, ROW_LIST_LIMIT)
        .map(([key, inner]) => [key, boundValue(inner)]),
    );
  }
  return value;
}

// The evidence map keeps the keys the renderer reads first (EVIDENCE_PRIORITY,
// in that order) ahead of the rest, so cutting it to ROW_LIST_LIMIT entries
// never removes the value topEvidenceLine would have shown.
function boundEvidence(evidence: Record<string, string>): Record<string, string> {
  const priority = EVIDENCE_PRIORITY.filter((key) => key in evidence);
  const rest = Object.keys(evidence).filter((key) => !priority.includes(key));
  return Object.fromEntries(
    [...priority, ...rest]
      .slice(0, ROW_LIST_LIMIT)
      .map((key) => [key, boundedField(evidence[key])]),
  );
}

function boundRowValues(row: DeepDiveDomain): DeepDiveDomain {
  const bounded = boundValue(row) as DeepDiveDomain;
  const evidence = row.enrichment?.evidence;
  if (bounded.enrichment != null && evidence != null && typeof evidence === "object") {
    bounded.enrichment = { ...bounded.enrichment, evidence: boundEvidence(evidence) };
  }
  return bounded;
}

function knownResultFields(data: DeepDiveResult): DeepDiveResult {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => KNOWN_RESULT_KEYS.has(key)),
  ) as DeepDiveResult;
}

// Shrink steps for a done job over budget, in order, so structuredContent
// keeps the domains the text shows for as long as possible: the result's
// scalar strings are capped (lossless for anything sane, so not reported),
// then the fields the markdown never renders are dropped — unknown outer
// fields, unknown result fields, run_metadata, entity, signals_attempted,
// each domain's embedded discovery record, then the per-signal evidence maps. Only when
// the record is still over budget do domains get halved, and only after
// that does the result collapse to the minimal envelope.
const STRIP_STEPS: Array<{
  name?: string;
  apply: (job: JobResponse, data: DeepDiveResult) => [JobResponse, DeepDiveResult];
}> = [
  { apply: (job, data) => [job, boundResultStrings(data)] },
  { name: "unknown job fields", apply: (job, data) => [minimalJobEnvelope(job), data] },
  { name: "unknown result fields", apply: (job, data) => [job, knownResultFields(data)] },
  {
    // Never rendered while domains are present, so they go before any row.
    name: "candidates",
    apply: (job, { candidates: _dropped, ...data }) => [job, data],
  },
  {
    name: "unknown domain fields",
    apply: (job, data) => [job, { ...data, domains: data.domains.map(knownRowFields) }],
  },
  {
    name: "run_metadata",
    apply: (job, { run_metadata: _dropped, ...data }) => [job, data],
  },
  { name: "entity", apply: (job, { entity: _dropped, ...data }) => [job, data] },
  {
    name: "signals_attempted",
    apply: (job, { signals_attempted: _dropped, ...data }) => [job, data],
  },
  {
    name: "domains[].base",
    apply: (job, data) => [
      job,
      { ...data, domains: data.domains.map(({ base: _dropped, ...row }) => row) },
    ],
  },
  // Lossy for a row only past the caps, but lossy: it runs after every
  // non-rendered field is gone, when the rows themselves are what is left.
  {
    name: "domains[] oversized values",
    apply: (job, data) => [job, { ...data, domains: data.domains.map(boundRowValues) }],
  },
  {
    name: "domains[].enrichment.evidence / signal_health",
    apply: (job, data) => [
      job,
      {
        ...data,
        domains: data.domains.map((row) =>
          row.enrichment == null
            ? row
            : {
                ...row,
                enrichment: {
                  ...row.enrichment,
                  ...(row.enrichment.evidence == null ? {} : { evidence: {} }),
                  ...(row.enrichment.signal_health == null ? {} : { signal_health: {} }),
                },
              },
        ),
      },
    ],
  },
];

function stripNonRendered(
  job: JobResponse,
  data: DeepDiveResult,
): { job: JobResponse; data: DeepDiveResult } {
  // The hint is part of what is measured: a record just under the limit
  // before the hint is attached would otherwise go over with it.
  // The worker's own hint (already bounded by the first step) is kept in
  // front of the local notice: it says why the result was incomplete
  // before it reached this server.
  const withHint = (d: DeepDiveResult, dropped: string[]): DeepDiveResult => {
    if (dropped.length === 0) return d;
    // No claim about the domain count here: a later halving pass prefixes
    // its own "K of N domains" notice to this one.
    const local = `Response truncated: ${dropped.join(", ")} omitted to stay under ${CHARACTER_LIMIT} chars.`;
    return {
      ...d,
      truncated: true,
      upgrade_hint: d.upgrade_hint ? `${d.upgrade_hint} ${local}` : local,
    };
  };
  const size = (j: JobResponse, d: DeepDiveResult) => JSON.stringify(wrapJob(j, d)).length;
  let current = { job, data };
  const dropped: string[] = [];
  let currentSize = size(job, data);
  for (const step of STRIP_STEPS) {
    if (currentSize <= CHARACTER_LIMIT) break;
    const [nextJob, nextData] = step.apply(current.job, current.data);
    const bareSize = size(nextJob, nextData);
    if (step.name !== undefined && bareSize < size(current.job, current.data)) {
      dropped.push(step.name);
    }
    current = { job: nextJob, data: nextData };
    currentSize = size(nextJob, withHint(nextData, dropped));
  }
  return { job: current.job, data: withHint(current.data, dropped) };
}

// The structuredContent of a markdown job response: the record as-is when
// it fits the budget, else the outer envelope collapses around the (already
// bounded) result, else both collapse. Same serializer as the JSON path, so
// a raw API record never reaches the client unbounded in either format.
function boundedJobRecord(job: JobResponse, result: DeepDiveResult | undefined): JobResponse {
  const collapsed = (s: DeepDiveResult | undefined) => wrapJob(minimalJobEnvelope(job), s);
  return serializeBoundedJson(
    wrapJob(job, result),
    () => collapsed(result && minimalScanEnvelope(result)),
    () => {
      const outerOnly = collapsed(result);
      return { text: JSON.stringify(outerOnly), structured: outerOnly };
    },
  ).structured;
}

// The one JSON serializer for the job tools' records. Pretty when it fits,
// else compact, else the caller's shrink step (the halving loop, when there
// is a result to halve), else the caller's minimal envelope: known fields
// only, every retained string capped at ENVELOPE_STRING_LIMIT, so the last
// resort is bounded by construction whatever the API put in the record.
function serializeBoundedJson<T>(
  value: T,
  minimal: () => T,
  shrink?: () => { text: string; structured: T },
): { text: string; structured: T } {
  const pretty = JSON.stringify(value, null, 2);
  if (pretty.length <= CHARACTER_LIMIT) return { text: pretty, structured: value };
  const compact = JSON.stringify(value);
  if (compact.length <= CHARACTER_LIMIT) return { text: compact, structured: value };
  const shrunk = shrink?.();
  if (shrunk !== undefined && shrunk.text.length <= CHARACTER_LIMIT) return shrunk;
  const envelope = minimal();
  return { text: JSON.stringify(envelope), structured: envelope };
}

// JSON: the whole job record stays under CHARACTER_LIMIT — pretty when it
// fits, else compact, else the result's domains/candidates are halved inside
// the envelope, else both the outer record and the result collapse to their
// minimal envelopes (an unknown top-level field, permitted by the loose
// schema, is not something the halving loop can shrink).
export function truncateJobJsonIfNeeded(job: JobResponse): {
  text: string;
  structured: JobResponse;
} {
  const data = jobResultData(job);
  return serializeBoundedJson(
    wrapJob(job, data),
    () => wrapJob(minimalJobEnvelope(job), data && minimalScanEnvelope(data)),
    data &&
      (() => {
        // Non-rendered fields go first, so the domains survive as long as
        // the record can hold them; only then are they halved.
        const stripped = stripNonRendered(job, data);
        const wrap = (s: ScanResponse | undefined) => wrapJob(stripped.job, s);
        const shrunk = truncateWithRender(JSON.stringify(wrap(stripped.data)), stripped.data, (s) =>
          JSON.stringify(wrap(s)),
        );
        return { text: shrunk.text, structured: wrap(shrunk.structured) };
      }),
  );
}

// The job record reduced to the fields this server knows, each string
// bounded; the result and the snapshot fields are attached by wrapJob.
function minimalJobEnvelope(job: JobResponse): JobResponse {
  return {
    job_id: boundedField(job.job_id),
    kind: boundedField(job.kind),
    status: boundedField(job.status),
    submitted_at: boundedField(job.submitted_at),
    started_at: boundedField(job.started_at),
    finished_at: boundedField(job.finished_at),
    ...(job.error != null && { error: boundedField(job.error) }),
  };
}

// JSON receipt of ctscout_submit_deep_dive, bounded the same way: a large
// forward-compatible field (permitted by the loose schema) collapses the
// receipt to its known fields, each string capped.
export function truncateReceiptJsonIfNeeded(receipt: JobSubmitResponse): {
  text: string;
  structured: JobSubmitResponse;
} {
  return serializeBoundedJson(receipt, () => ({
    job_id: boundedField(receipt.job_id),
    status: boundedField(receipt.status),
    submitted_at: boundedField(receipt.submitted_at),
    ...(receipt.poll !== undefined && { poll: boundedField(receipt.poll) }),
  }));
}

// ---------- Research-product rendering (ctscout-worker#336) ----------

// Note 2's definition of a confirmed vendor, quoted verbatim in both tool
// descriptions and in the rendered output (ctscout-mcp#103): an agent quoting
// the tool then quotes the method rather than a paraphrase of it.
const VENDOR_CONFIRMED_DEFINITION =
  "a vendor is confirmed when a hostname it certified resolves onto a domain it " +
  "certifies and the customer's own www does not";
// The manifest publishes five source snapshots; the cap bounds the line if the
// research build ever adds more (or an origin sends something unexpected).
const PRODUCT_SOURCE_LIMIT = 10;

// The provenance line every product answer opens with: the export version the
// answer was read from, then the dated snapshot each underlying join used. The
// per-source map is rendered rather than only carried in structuredContent —
// `as_of` alone does not say which GLEIF file a legal name came from, and a
// reader of the markdown must get the same facts as a reader of the JSON.
function productSnapshotLine(
  info: Partial<ProductSnapshotInfo>,
  dates: Record<string, string> | undefined,
): string {
  const head =
    info.snapshot_source === "product"
      ? `_Research product: ${cellSafe(info.snapshot, 40)} (the published export's as_of)._`
      : "_Research product: version unknown — the API did not report one._";
  // An array would enumerate as index keys ("0 2026-08-01"), which reads as a
  // source named "0"; the manifest's map is the only shape this line can state.
  if (dates == null || typeof dates !== "object" || Array.isArray(dates)) return head;
  const entries = Object.entries(dates);
  const sources = entries
    .slice(0, PRODUCT_SOURCE_LIMIT)
    .map(([name, value]) => `${cellSafe(name, 40)} ${cellSafe(value, 80)}`);
  if (sources.length === 0) return head;
  // A provenance line short of its sources reads as complete provenance, which
  // is worse than a long line: say what was left out.
  const rest =
    entries.length > sources.length ? `, +${entries.length - sources.length} more not shown` : "";
  return `${head}\n_Source snapshots: ${sources.join(", ")}${rest}._`;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Proxied numbers are rendered only when they are numbers: a missing count
// shows as an em dash rather than "undefined" or a silent zero.
function numberCell(value: unknown): string {
  return isCount(value) ? String(value) : "—";
}

// Returns the rendered list AND how many entries it actually rendered. A caller
// that counted the array instead would print "25 shown" over 20 items: the cut
// happens here, so the count has to come from here too.
function backtickList(
  values: unknown,
  empty: string,
  max = ROW_LIST_LIMIT,
): { text: string; shown: number } {
  if (!Array.isArray(values) || values.length === 0) return { text: empty, shown: 0 };
  const shown = values.slice(0, max).map((value) => `\`${cellSafe(String(value), 120)}\``);
  const rest =
    values.length > shown.length
      ? `, +${values.length - shown.length} more (${values.length} in all)`
      : "";
  return { text: `${shown.join(", ")}${rest}`, shown: shown.length };
}

// Every rendered list is cut at ROW_LIST_LIMIT, and a cut one must say so. The
// product contract deliberately refuses to pin the exporter's sample sizes and
// top-N lengths ("The contract refuses wrong answers, not resized ones"), so a
// list that grows past the cap has to show as a short list plus this marker
// rather than as a complete-looking one.
function moreLine(total: number, shown: number): string[] {
  return total > shown ? ["", `_+${total - shown} more not shown (${total} in all)._`] : [];
}

export function formatLeiRecordAsMarkdown(record: LeiRecord): string {
  const sample = backtickList(record.sample_domains, "_none_");
  const vendors = backtickList(record.vendors_confirmed, "_none confirmed_");
  return clampText(
    [
      `# ${cellSafe(record.legal_name, 200)}`,
      "",
      productSnapshotLine(record, record.snapshot_dates),
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| LEI | \`${cellSafe(record.lei, 40)}\` |`,
      `| Legal name (GLEIF) | ${cellSafe(record.legal_name, 120)} |`,
      `| Country (GLEIF) | ${cellSafe(record.country, 40)} |`,
      `| ISINs mapped to this LEI | ${numberCell(record.isin_count)} |`,
      `| Apex domains attributed | ${numberCell(record.apex_count)} |`,
      `| First seen | ${cellSafe(record.first_seen, 40)} |`,
      `| Last seen | ${cellSafe(record.last_seen, 40)} |`,
      "",
      `**Confirmed vendors on this entity's domains:** ${vendors.text}`,
      `_These are vendor slugs — pass one to ctscout_vendor_customers. ${VENDOR_CONFIRMED_DEFINITION}._`,
      "",
      `**Sample of the attributed apexes** — ${sample.shown} listed, ${numberCell(
        record.apex_count,
      )} attributed in total: ${sample.text}`,
      "_The sample is hash-chosen, not the top N and not a complete list; apex_count is the total._",
      "",
      '_"Attributed" means the certificate and DNS evidence names this entity for the domain.' +
        " It is not an ownership claim._",
    ].join("\n"),
  );
}

// `name_match: "none"` is the one answer an agent will misread. The Worker's
// own comment on handleLeiByName says what it means: the index is keyed by the
// research normalizer's form of the GLEIF legal name, and the two spellings the
// route tries are not that normalizer. Rendering it as "no LEI" would turn a
// lookup miss into a claim about the entity.
function nameMatchExplanation(match: unknown): string {
  switch (match) {
    case "exact":
      return "the lowercased, trimmed query is a key in the name index verbatim.";
    case "normalized":
      return "the query matched after the API's locale-suffix normalization.";
    case "none":
      return (
        "neither spelling tried hit the index. This does NOT mean this company has no LEI: " +
        "the index is keyed by the research normalizer's form of the GLEIF legal name, and " +
        "the two spellings tried here (the lowercased query and its locale-suffix " +
        "normalization) are not the index's normalizer. Try the exact GLEIF legal name, or " +
        "look the entity up by LEI."
      );
    default:
      return "the API reported a match type this server does not model.";
  }
}

export function formatLeiNameMatchesAsMarkdown(data: LeiNameMatches): string {
  const leis = Array.isArray(data.leis) ? data.leis : [];
  const total = typeof data.lei_count === "number" ? data.lei_count : leis.length;
  const header = [
    `# LEI lookup by name: "${cellSafe(data.query, 200)}"`,
    "",
    productSnapshotLine(data, data.snapshot_dates),
    "",
    `**Name match: ${cellSafe(data.name_match, 40)}** — ${nameMatchExplanation(data.name_match)}`,
    "",
  ];
  if (leis.length === 0) {
    return clampText([...header, "No LEIs returned for this query."].join("\n"));
  }
  const countLine =
    data.truncated === true
      ? `${total} LEIs carry this name; the endpoint returns the first ${numberCell(data.limit)}.`
      : `${leis.length} LEI${leis.length === 1 ? "" : "s"} carry this name.`;
  // The endpoint's own cap (`truncated` / `limit`) and this renderer's cap are
  // two different cuts: `truncated` says nothing about the second, so a list
  // longer than ROW_LIST_LIMIT needs its own marker.
  const shown = leis.slice(0, ROW_LIST_LIMIT);
  return clampText(
    [
      ...header,
      countLine,
      "",
      ...shown.map((lei) => `- \`${cellSafe(lei, 40)}\``),
      ...moreLine(leis.length, shown.length),
      "",
      "_Look one up with ctscout_lookup_lei { lei } for the legal name, country and " +
        "attributed apexes._",
    ].join("\n"),
  );
}

// The candidate/confirmed split, rendered as two labelled rows rather than one
// number. They are different claims about the same vendor and confirmed is the
// DNS-confirmed subset of candidates, so a sum would double-count.
function customerSplitTable(candidates: unknown, confirmed: unknown): string[] {
  return [
    "## Customer domains — two claims, kept apart",
    "",
    "| Claim | Count | What it means |",
    "| --- | --- | --- |",
    `| Candidates | ${numberCell(candidates)} | apex domains this vendor certified a hostname for. ` +
      "Fan-out alone is not a vendor relationship — an organization certifying hundreds of its " +
      "own product sites looks the same. |",
    `| Confirmed | ${numberCell(confirmed)} | of those candidates, the ones DNS confirmed: ` +
      `${VENDOR_CONFIRMED_DEFINITION} (or another organization certifies the apex). |`,
    "",
    "_Confirmed is the DNS-confirmed subset of candidates. Read them as two claims; never add them._",
  ];
}

export function formatVendorSummaryAsMarkdown(data: VendorSummary): string {
  const countries = Array.isArray(data.countries_top) ? data.countries_top : [];
  const coUse = Array.isArray(data.co_use) ? data.co_use : [];
  const sample = backtickList(data.sample_customers, "_none_");
  const lines = [
    `# Vendor: ${cellSafe(data.vendor_name, 200)} (\`${cellSafe(data.slug, 80)}\`)`,
    "",
    productSnapshotLine(data, data.snapshot_dates),
    "",
    `**Vendor apex:** ${
      typeof data.vendor_apex === "string"
        ? `\`${cellSafe(data.vendor_apex, 120)}\``
        : "_none — the vendor's brand token matches no registrable label it certifies._"
    }`,
    "",
    ...customerSplitTable(data.customers?.candidates, data.customers?.confirmed),
    "",
  ];
  if (countries.length > 0) {
    lines.push(
      "## Top countries, by confirmed customers",
      "",
      "| Country | Confirmed |",
      "| --- | --- |",
      ...countries
        .slice(0, ROW_LIST_LIMIT)
        .map((row) => `| ${cellSafe(row?.country, 40)} | ${numberCell(row?.confirmed)} |`),
      ...moreLine(countries.length, Math.min(countries.length, ROW_LIST_LIMIT)),
      "",
      "_Candidates are not counted here, and only customers that resolved to an LEI carry a country._",
      "",
    );
  }
  if (coUse.length > 0) {
    lines.push(
      "## Vendors also certifying these customers",
      "",
      "| Vendor | Customers |",
      "| --- | --- |",
      ...coUse
        .slice(0, ROW_LIST_LIMIT)
        .map((row) => `| \`${cellSafe(row?.slug, 80)}\` | ${numberCell(row?.confirmed)} |`),
      ...moreLine(coUse.length, Math.min(coUse.length, ROW_LIST_LIMIT)),
      "",
      "_The count is this vendor's CONFIRMED customers that the other vendor also certifies — " +
        "a candidate there, not a mutual confirmation._",
      "",
    );
  }
  // Two independent facts, not "N of M": the sample size and the confirmed
  // total come from different exporter constants, so phrasing them as a
  // fraction would read as nonsense ("30 of 5") the moment the sample grows.
  lines.push(
    `**Sample of confirmed customers** — ${sample.shown} listed, ${numberCell(
      data.customers?.confirmed,
    )} confirmed in total: ${sample.text}`,
    "_Hash-chosen from the confirmed customers, not the top N. Call this tool with " +
      "enumerate: true for the full enumeration (needs an API key)._",
  );
  return clampText(lines.join("\n"));
}

function customerRowsTable(rows: VendorCustomerRow[]): string[] {
  return [
    "| Apex | Attributed to | LEI |",
    "| --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| \`${cellSafe(row?.apex, 120)}\` | ${cellSafe(row?.attributed_to, 120)} | ${
          typeof row?.lei === "string" ? `\`${cellSafe(row.lei, 40)}\`` : "—"
        } |`,
    ),
  ];
}

function renderVendorCustomers(data: VendorCustomers): string {
  const confirmed = rowsOf(data.confirmed);
  const candidates = rowsOf(data.candidates);
  const lines = [
    `# Vendor customers: \`${cellSafe(data.slug, 80)}\``,
    "",
    productSnapshotLine(data, data.snapshot_dates),
    "",
    "_Confirmed and candidates are two different claims and are listed separately below. " +
      `Confirmed is the DNS-confirmed subset of candidates (${VENDOR_CONFIRMED_DEFINITION}); ` +
      "adding the two lists double-counts. Every name is what the evidence attributes the " +
      "domain to, not an ownership claim._",
    "",
    `## Confirmed — ${confirmed.length} listed of ${numberCell(data.counts?.confirmed)}`,
    "",
  ];
  lines.push(...(confirmed.length > 0 ? customerRowsTable(confirmed) : ["_No rows listed._"]));
  lines.push(
    "",
    `## Candidates — ${candidates.length} listed of ${numberCell(data.counts?.candidates)}`,
    "",
  );
  lines.push(...(candidates.length > 0 ? customerRowsTable(candidates) : ["_No rows listed._"]));
  if (data.capped === true) {
    lines.push(
      "",
      "_The research build itself kept a subset of this vendor's candidates (`capped`): " +
        "counts.candidates is the complete total, the list is not._",
    );
  }
  if (typeof data.truncation_note === "string") {
    lines.push("", `> ${cellSafe(data.truncation_note, 400)}`);
  }
  return lines.join("\n");
}

function rowsOf(rows: unknown): VendorCustomerRow[] {
  return Array.isArray(rows) ? (rows as VendorCustomerRow[]) : [];
}

// What this server dropped, kept separate from what the API said. `counts` and
// `capped` describe the object the research build published; overwriting them
// to match a trimmed list would put a complete-looking enumeration in front of
// a caller (the "well-formed and lying" case the product contract calls out).
function customersWithNote(current: VendorCustomers, original: VendorCustomers): VendorCustomers {
  // The note is a claim about rows, so it is written only when rows actually
  // went missing. The minimal envelope also reaches here for a record whose
  // lists were already empty and whose bulk was an unrecognized field: saying
  // "rows were dropped" there names the wrong thing, and since the collapse now
  // renders to the markdown too, the reader would see it.
  if (
    rowsOf(current.confirmed).length >= rowsOf(original.confirmed).length &&
    rowsOf(current.candidates).length >= rowsOf(original.candidates).length
  ) {
    return current;
  }
  return {
    ...current,
    truncation_note:
      `This MCP response lists ${rowsOf(current.confirmed).length} of ${
        rowsOf(original.confirmed).length
      } confirmed and ${rowsOf(current.candidates).length} of ${
        rowsOf(original.candidates).length
      } candidate rows the API returned: rows were dropped to stay under ${CHARACTER_LIMIT} ` +
      "chars. counts and capped describe the API's answer, not this list.",
  };
}

// Halve the listed rows until the rendered text fits, candidates first: they
// are the weaker claim and the longer list. Parameterizing the renderer keeps
// the Markdown and JSON bounds identical, as truncateWithRender does for /scan.
function trimCustomerRows(
  original: VendorCustomers,
  render: (data: VendorCustomers) => string,
  limit: number = CHARACTER_LIMIT,
): { text: string; structured: VendorCustomers } {
  let structured = original;
  let text = render(structured);
  while (
    text.length > limit &&
    (rowsOf(structured.candidates).length > 0 || rowsOf(structured.confirmed).length > 0)
  ) {
    const candidates = rowsOf(structured.candidates);
    const confirmed = rowsOf(structured.confirmed);
    const halved =
      candidates.length > 0
        ? { ...structured, candidates: candidates.slice(0, Math.floor(candidates.length / 2)) }
        : { ...structured, confirmed: confirmed.slice(0, Math.floor(confirmed.length / 2)) };
    structured = customersWithNote(halved, original);
    text = render(structured);
  }
  return { text, structured };
}

// The ONE bounder for a customer enumeration, used by both response formats.
//
// Trimming the markdown and the JSON independently produces two answers to the
// same call: a JSON row costs more characters than a rendered table row, so
// there is a window (measured: ~170-210 candidate rows) where the markdown fits
// whole while the JSON does not. The reader then holds a `content` listing every
// row with no truncation note beside a `structuredContent` carrying half of them
// under a note reading "This MCP response lists 93 of 187" — false about the
// response it is attached to, and the README's own invariant broken in both
// directions at once.
//
// So one record is trimmed against the LONGER of the two renderings and both
// views render it. They agree by construction: the same rows, the same
// "N listed of M" headings, and one truncation_note that is true of whichever
// half the reader looks at.
export function boundVendorCustomers(data: VendorCustomers): {
  text: string;
  json: string;
  structured: VendorCustomers;
} {
  const { structured: trimmed } = trimCustomerRows(data, (value) => {
    const json = JSON.stringify(value);
    const markdown = renderVendorCustomers(value);
    return json.length >= markdown.length ? json : markdown;
  });
  // Pretty-print when the trimmed record still fits it, else compact, else the
  // minimal envelope — and render the markdown from whatever survived that, so
  // a collapse to the envelope collapses both views together.
  // The envelope's note counts against what the API returned, not against the
  // already-trimmed record, so it is built from `data`.
  const serialized = serializeBoundedJson(trimmed, () =>
    minimalProductEnvelope<VendorCustomers>("vendor_customers", data),
  );
  return {
    text: clampText(renderVendorCustomers(serialized.structured)),
    json: serialized.text,
    structured: serialized.structured,
  };
}

// A minimal product envelope's size has to be a constant whatever the API put
// in the record — the rule minimalJobEnvelope follows — and serializeBoundedJson
// does not re-measure what `minimal()` returns. `boundedField` alone is not
// enough: it caps a string and passes anything else through untouched. So every
// position below is kept only when it already has the type the envelope can
// bound, and dropped otherwise. Dropped, never coerced: `String(undefined)`
// would put the literal "undefined" in a table cell, which is worse than the
// em dash a hole renders as.
function keptStrings(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, string> {
  const keep: Record<string, string> = {};
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string") keep[field] = boundedField(value);
  }
  return keep;
}

function boundedStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value): value is string => typeof value === "string")
    .slice(0, ROW_LIST_LIMIT)
    .map((value) => boundedField(value));
}

function boundedSplitCounts(split: unknown): SplitCounts {
  const source = (split ?? {}) as Record<string, unknown>;
  return {
    ...(isCount(source.candidates) && { candidates: source.candidates }),
    ...(isCount(source.confirmed) && { confirmed: source.confirmed }),
  };
}

// The two fields this server writes itself. They move together or not at all:
// a date beside `snapshot_source: "unavailable"` would be a value next to the
// claim that no value was available, which is the class of contradiction these
// tools exist to avoid. resolveProductSnapshot already sets them as a pair, but
// the envelope enforces it rather than resting on its caller.
function keptProductSnapshot(data: Partial<ProductSnapshotInfo>): ProductSnapshotInfo {
  return typeof data.snapshot === "string" && data.snapshot_source === "product"
    ? { snapshot: boundedField(data.snapshot), snapshot_source: "product" }
    : { snapshot: null, snapshot_source: "unavailable" };
}

// ---------- One envelope for every product object ----------
//
// Every research-product response that cannot fit under CHARACTER_LIMIT any
// other way collapses through THIS path. It is spec-driven rather than
// hand-written per shape because both defects it closes were the same shape of
// mistake: "the envelope for object X forgot rule Y". The LEI envelope silently
// shortened a list the product publishes complete; then the vendor summary was
// found doing the same to three more; and both dropped the per-source
// provenance the tool contract says every product answer carries. A field added
// to a shape is a line in the spec below and there is no second place to
// remember it, so the next object kind cannot miss either rule by construction.

/** A capped scalar string. */
const ENV_STRING = { kind: "string" } as const;
/** A count, kept only when it really is a number. */
const ENV_COUNT = { kind: "count" } as const;
const ENV_BOOLEAN = { kind: "boolean" } as const;
/** The candidate/confirmed split, under either of its two names. */
const ENV_SPLIT = { kind: "split" } as const;

type EnvelopeField =
  | typeof ENV_STRING
  | typeof ENV_COUNT
  | typeof ENV_BOOLEAN
  | typeof ENV_SPLIT
  /** An array. `partial` marks a list the product DECLARES partial against a
   *  total the record itself carries (a sample): shortening it further is a
   *  smaller sample of the same claim. Without it the list is published
   *  complete — or partial only against someone else's cut, as `leis` is — and
   *  shortening it changes the claim. Either way the cut is reported; the flag
   *  is what the note says about it, so a reader can tell the two apart. */
  | {
      readonly kind: "array";
      readonly max: number;
      readonly partial?: string;
      /** Present for an array of objects: each row is rebuilt from these. */
      readonly fields?: Readonly<Record<string, EnvelopeField>>;
    };

const CUSTOMER_ROW_FIELDS = {
  apex: ENV_STRING,
  attributed_to: ENV_STRING,
  lei: ENV_STRING,
} as const;

/** Every product object kind this package hands back. The walk test in
 *  tests/index.test.ts iterates this registry, so a kind added without a
 *  fixture and its assertions fails the build. */
export const PRODUCT_ENVELOPES = {
  lei_record: {
    lei: ENV_STRING,
    legal_name: ENV_STRING,
    country: ENV_STRING,
    first_seen: ENV_STRING,
    last_seen: ENV_STRING,
    isin_count: ENV_COUNT,
    apex_count: ENV_COUNT,
    sample_domains: { kind: "array", max: ROW_LIST_LIMIT, partial: "apex_count is the total" },
    vendors_confirmed: { kind: "array", max: ROW_LIST_LIMIT },
  },
  lei_name_matches: {
    query: ENV_STRING,
    name_match: ENV_STRING,
    lei_count: ENV_COUNT,
    limit: ENV_COUNT,
    truncated: ENV_BOOLEAN,
    // NOT partial: lei_count/limit describe the ENDPOINT's cut, which says
    // nothing about this one.
    leis: { kind: "array", max: ROW_LIST_LIMIT },
  },
  vendor_summary: {
    slug: ENV_STRING,
    vendor_name: ENV_STRING,
    vendor_apex: ENV_STRING,
    customers: ENV_SPLIT,
    countries_top: {
      kind: "array",
      max: ROW_LIST_LIMIT,
      fields: { country: ENV_STRING, confirmed: ENV_COUNT },
    },
    co_use: {
      kind: "array",
      max: ROW_LIST_LIMIT,
      fields: { slug: ENV_STRING, confirmed: ENV_COUNT },
    },
    sample_customers: {
      kind: "array",
      max: ROW_LIST_LIMIT,
      partial: "customers.confirmed is the total",
    },
  },
  vendor_customers: {
    slug: ENV_STRING,
    counts: ENV_SPLIT,
    capped: ENV_BOOLEAN,
    // max 0: this envelope is the last resort AFTER trimCustomerRows has
    // already halved the rows away, so by the time it runs there is no budget
    // for a row. Twenty of each would be ~24 KB on their own.
    confirmed: { kind: "array", max: 0, fields: CUSTOMER_ROW_FIELDS },
    candidates: { kind: "array", max: 0, fields: CUSTOMER_ROW_FIELDS },
  },
} as const satisfies Record<string, Readonly<Record<string, EnvelopeField>>>;

export type ProductEnvelopeKind = keyof typeof PRODUCT_ENVELOPES;

// The provenance every product answer carries. Capped at what
// productSnapshotLine renders, so nothing a reader could have seen is lost.
const PROVENANCE_KEY_LIMIT = 40;
const PROVENANCE_VALUE_LIMIT = 80;

/** `as_of`, `product_version` and `snapshot_dates`. The tool contract promises
 *  all three on every product answer, so a fallback that drops them leaves the
 *  caller holding an export version with no way to tell which source snapshots
 *  produced it. They are bounded here, never omitted. */
function keptProvenance(data: Record<string, unknown>): {
  fields: Record<string, unknown>;
  cut?: string;
} {
  const fields: Record<string, unknown> = keptStrings(data, ["as_of", "product_version"]);
  const dates = data.snapshot_dates;
  if (dates === null || typeof dates !== "object" || Array.isArray(dates)) return { fields };
  const entries = Object.entries(dates as Record<string, unknown>).filter(
    ([, value]) => typeof value === "string",
  );
  const kept = entries.slice(0, PRODUCT_SOURCE_LIMIT);
  fields.snapshot_dates = Object.fromEntries(
    kept.map(([name, value]) => [
      truncateBody(name, PROVENANCE_KEY_LIMIT),
      truncateBody(value as string, PROVENANCE_VALUE_LIMIT),
    ]),
  );
  return kept.length < entries.length
    ? { fields, cut: `snapshot_dates lists ${kept.length} of ${entries.length}` }
    : { fields };
}

function envelopeRow(
  row: unknown,
  fields: Readonly<Record<string, EnvelopeField>>,
): Record<string, unknown> {
  const source = (row ?? {}) as Record<string, unknown>;
  const keep: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    if (field.kind === "string" && typeof source[name] === "string") {
      keep[name] = boundedField(source[name] as string);
    } else if (field.kind === "count" && isCount(source[name])) {
      keep[name] = source[name];
    }
  }
  return keep;
}

/** The one minimal envelope. Bounded by construction — every string capped,
 *  every array cut to its spec's max, every count kept only when numeric — and
 *  serializeBoundedJson never re-measures what this returns, so that has to be
 *  literally true rather than nearly true. */
export function minimalProductEnvelope<T>(kind: ProductEnvelopeKind, data: T): T {
  const source = data as unknown as Record<string, unknown>;
  const spec: Readonly<Record<string, EnvelopeField>> = PRODUCT_ENVELOPES[kind];
  const keep: Record<string, unknown> = {};
  const cuts: string[] = [];

  for (const [name, field] of Object.entries(spec)) {
    const value = source[name];
    switch (field.kind) {
      case "string":
        if (typeof value === "string") keep[name] = boundedField(value);
        break;
      case "count":
        if (isCount(value)) keep[name] = value;
        break;
      case "boolean":
        if (typeof value === "boolean") keep[name] = value;
        break;
      case "split":
        keep[name] = boundedSplitCounts(value);
        break;
      case "array": {
        if (!Array.isArray(value)) break;
        const kept =
          field.fields === undefined
            ? boundedStrings(value).slice(0, field.max)
            : value.slice(0, field.max).map((row) => envelopeRow(row, field.fields ?? {}));
        keep[name] = kept;
        if (kept.length < value.length) {
          cuts.push(
            `${name} lists ${kept.length} of ${value.length}` +
              (field.partial === undefined
                ? " (published complete)"
                : ` (a sample; ${field.partial})`),
          );
        }
        break;
      }
    }
  }

  const provenance = keptProvenance(source);
  Object.assign(
    keep,
    provenance.fields,
    keptProductSnapshot(source as Partial<ProductSnapshotInfo>),
  );
  if (provenance.cut !== undefined) cuts.push(provenance.cut);

  if (cuts.length > 0) {
    keep.truncation_note =
      `This MCP response shortened lists the API sent whole, to stay under ${CHARACTER_LIMIT} ` +
      `chars: ${cuts.join(", ")}. Any count beside them describes the API's answer, not these ` +
      "lists.";
  }
  return keep as unknown as T;
}

/** The one JSON bounder for a product answer: pretty when it fits, else
 *  compact, else the spec-driven envelope above. */
export function truncateProductJson<T>(
  kind: ProductEnvelopeKind,
  data: T,
): { text: string; structured: T } {
  return serializeBoundedJson(data, () => minimalProductEnvelope<T>(kind, data));
}

// ---------- Server + tools ----------

/**
 * Build one stdio compatibility server.
 *
 * A factory keeps protocol tests isolated and makes the registered contract
 * inspectable without booting process-global stdio. Production still creates
 * exactly one instance below.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "ctscout_search_company",
    {
      title: "Search ctscout by company name",
      description: `Search ctscout.dev's domain-attribution warehouse by organization name. Returns apex domains attributed to that organization based on Certificate Transparency log analysis (OV/EV cert subjects matched to entity names).

Args:
  - company_name (string, required): organization name. Partial matches work — 'Goldman' matches 'Goldman Sachs'. Min 2 chars, max 200.
  - strict_match_org_only (boolean, optional): suppress semantic candidates and return only authoritative warehouse org matches.
  - org_match_field ('verbatim' | 'normalized', optional): choose raw cert-subject matching or normalized legal-form matching. Leave unset for automatic verbatim-then-normalized fallback.
  - org_match_mode ('substring' | 'word', optional): use word-boundary matching to reduce noise from short/common names.
  - purpose ('underwriting' | 'corporate_family', optional): choose tight operational-attribution defaults or broader corporate-family defaults. Explicit matching controls override the preset.
  - response_format ('markdown' | 'json', default 'markdown'): output format.

Returns (on success, structuredContent follows the declared outputSchema; an error result — 401, 429, timeout — is isError with no structuredContent, so never dereference snapshot on a failed call):
  - "Attributed" means the organization is what the evidence names for that domain, not an ownership claim. On /scan that evidence is the OV/EV certificate subject on both tiers; multi-signal attribution (DNS, RDAP, IP/ASN, homepage, favicon) exists only in a deep-dive job result (ctscout_submit_deep_dive, Pro). "Candidate" means a semantic name-similarity guess that is NOT an attribution.
  - In markdown: a snapshot line, then a table of (domain, attributed to, cert count, subdomain count). When nothing is attributed but match_type is 'semantic', a table of candidate organizations is rendered instead, labelled as candidates.
  - In JSON, structured as:
    {
      "domains": [                        // attributed pairs; empty when nothing is attributed
        {
          "org": string,                  // attributed organization: the OV/EV certificate subject (both tiers)
          "apex_domain": string,          // e.g. "gs.com"
          "cert_count": number,           // # of distinct certs observed for this pair
          "subdomain_count": number,      // # of distinct subdomains
          "first_seen": string | null,    // warehouse observation time — NOT the CT log SCT / issuance time
          "last_seen": string | null      // warehouse observation time — NOT the CT log SCT / issuance time
        }
      ],
      "total": number,                    // total matching rows in warehouse
      "truncated": boolean,               // true if response is capped
      "upgrade_hint": string,             // present when truncated
      "source": "warehouse",              // both tiers read the daily warehouse snapshot
      "match_type": "exact" | "semantic" | "none",   // 'semantic' = domains empty, candidates offered
      "org_match_strategy": string,       // which matching pass produced the answer
      "empty_reason": string,             // present on empty results: why nothing was attributed
      "candidates": [                     // only when match_type is 'semantic'; NOT attributions
        { "org": string, "similarity": number, "top_apex_domain": string | null }
      ],
      "snapshot": string | null,          // warehouse/D1 sync date (YYYY-MM-DD) the answer was read from (API version 2026-09-05+); null only when the API could not determine it
      "snapshot_source": "scan" | "unavailable"   // 'scan' = API carried the date; 'unavailable' = it did not (snapshot is null). null means unknown freshness, never "current"
    }

Examples:
  - Use when: "Find all domains attributed to Cloudflare" -> { company_name: "Cloudflare" }
  - Use when: "Which domains are attributed to Goldman?" -> { company_name: "Goldman Sachs" }
  - Don't use when: You have a specific domain and want to find the organization it's attributed to — use ctscout_lookup_domain instead.

Auth & limits:
  - Requires CTSCOUT_API_KEY env var. Get a free key (no email) at https://ctscout.dev.
  - Free tier: 10 queries/day, top 5 results from a daily snapshot. The response's "snapshot" field carries that snapshot's sync date (the API reports it since X-API-Version 2026-09-05); when it is null the API could not determine it — treat freshness as unknown, never as current.
  - Pro tier: unlimited queries, up to 25 rows, a 12-month window; deep-dive jobs (20/day) for multi-signal attribution.

Error handling:
  - HTTP 401: API key missing or invalid.
  - HTTP 429: daily quota exceeded — wait or upgrade.
  - "No domains found": try a shorter or different company name (see legal-vs-brand caveat below).

Legal-vs-brand caveat (important):
  - The cert subject (O field) uses LEGAL entity names, not brand names.
  - "Travelers Insurance" → 0 results because the legal name is "The Travelers Companies, Inc."
  - "Hartford Financial" → 0 results; legal names are "Hartford Fire Insurance Company" or "The Hartford Financial Services Group".
  - If a brand-name search returns nothing, retry with variants like "X Companies", "X Group", "X Inc", "X Corporation", or "The X". The empty-result markdown output includes these suggestions automatically when the input looks brand-shaped.

Coverage caveat:
  - Best for established US/EU tech companies with OV/EV certs.
  - Limited coverage on small private companies, cyber MGAs, and entities using only DV (Let's Encrypt) certs.
  - Warehouse size (organizations, org-domain pairs, last sync) is not stated here because it changes daily; read the live figures at https://ctscout.dev/stats before treating a miss as meaningful.`,
      inputSchema: SearchCompanyInputSchema,
      outputSchema: ScanOutputSchema,
      annotations: QUOTA_DEBITING_READ_ONLY_ANNOTATIONS,
    },
    async (params: SearchCompanyInput) => {
      try {
        const raw = await callScan({
          company_name: params.company_name,
          ...(params.strict_match_org_only !== undefined && {
            strict_match_org_only: params.strict_match_org_only,
          }),
          ...(params.org_match_field !== undefined && {
            org_match_field: params.org_match_field,
          }),
          ...(params.org_match_mode !== undefined && {
            org_match_mode: params.org_match_mode,
          }),
          ...(params.purpose !== undefined && {
            purpose: params.purpose,
          }),
        });
        const data: ScanResponse = { ...raw, ...resolveSnapshot(raw) };

        if (params.response_format === ResponseFormat.JSON) {
          const { text, structured } = truncateJsonIfNeeded(data);
          return {
            content: [{ type: "text", text }],
            structuredContent: structured as unknown as Record<string, unknown>,
          };
        }

        const md = formatScanAsMarkdown(params.company_name, data, {
          kind: "company",
        });
        const { text, structured } = truncateIfNeeded(md, data, params.company_name, {
          kind: "company",
        });
        return {
          content: [{ type: "text", text }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: explainError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "ctscout_search_company_batch",
    {
      title: "Search ctscout by multiple company names in one call",
      description: `Look up apex domains for up to ${MAX_BATCH_QUERIES} organization names in a single call, via ctscout.dev's /scan/batch endpoint. Each name is matched exactly like ctscout_search_company; results come back in input order.

Args:
  - company_names (string[], required): 1–${MAX_BATCH_QUERIES} organization names. Partial matches work — 'Goldman' matches 'Goldman Sachs'. Each 2–200 chars.
  - response_format ('markdown' | 'json', default 'markdown'): output format.

Returns (on success, structuredContent follows the declared outputSchema; an error result — 401, 429, timeout — is isError with no structuredContent, so never dereference snapshot on a failed call):
  - "Attributed" and "candidate" mean exactly what they mean in ctscout_search_company: what the evidence names (the OV/EV certificate subject on /scan, both tiers) vs a semantic name-similarity guess that is NOT an attribution.
  - In markdown: a snapshot line, then one section per company (heading + the same attributed-domains table as ctscout_search_company; a candidate-organizations table when that name's match_type is 'semantic'), followed by remaining quota. Names that failed render an error line instead of a table.
  - In JSON, the batch envelope:
    {
      "results": [
        { "query": {...}, "domains": [...], "total": number, "match_type": "exact"|"semantic"|"none", "candidates"?: [...] },   // same per-result fields as ctscout_search_company
        { "query": {...}, "error": { "code": number, "message": string } }
      ],
      "remaining_quota": number | null,  // null = unlimited (Pro)
      "snapshot": string | null,         // sync date shared by every result in the batch (API version 2026-09-05+); null (unknown freshness) only when the API could not determine it
      "snapshot_source": "scan" | "unavailable"
    }

Partial-failure semantics (important):
  - This is a 207-style mixed-result envelope, NOT all-or-nothing: one name can fail (its result carries an "error" object with no "domains") while the rest succeed.
  - Quota debits by the number of names in the batch — every name counts once, even zero-result ones. No free riders.

Examples:
  - Use when: "Look up Cloudflare, Fastly, and Akamai" -> { company_names: ["Cloudflare", "Fastly", "Akamai"] }
  - Don't use when: you have a single name (use ctscout_search_company) or a specific domain (use ctscout_lookup_domain).

Auth & limits:
  - Requires CTSCOUT_API_KEY, same as ctscout_search_company.
  - Oversized batches (>${MAX_BATCH_QUERIES} names) are rejected with a validation error before any network call and without a partial quota debit.
  - This MCP batch tool intentionally accepts names only. For matching modifiers such as strict_match_org_only, purpose, or org_match_mode, use individual ctscout_search_company calls or the REST /scan/batch endpoint.

Legal-vs-brand and coverage caveats are identical to ctscout_search_company — brand names may need legal-entity variants ("X Companies", "X Group", "The X"), and coverage is best for established US/EU entities with OV/EV certs.`,
      inputSchema: SearchCompanyBatchInputSchema,
      outputSchema: BatchOutputSchema,
      annotations: QUOTA_DEBITING_READ_ONLY_ANNOTATIONS,
    },
    async (params: SearchCompanyBatchInput) => {
      try {
        const queries: ScanRequestBody[] = params.company_names.map((company_name) => ({
          company_name,
        }));
        const raw = await callScanBatch(queries);
        const data: ScanBatchResponse = { ...raw, ...resolveSnapshot(raw) };

        if (params.response_format === ResponseFormat.JSON) {
          const { text, structured } = truncateBatchJsonIfNeeded(data);
          return {
            content: [{ type: "text", text }],
            structuredContent: structured as unknown as Record<string, unknown>,
          };
        }

        const text = formatBatchAsMarkdown(params.company_names, data);
        // structuredContent mirrors the single tool: a bounded machine-readable
        // envelope alongside the human-readable markdown.
        const { structured } = truncateBatchJsonIfNeeded(data);
        return {
          content: [{ type: "text", text }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: explainError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "ctscout_lookup_domain",
    {
      title: "Reverse-lookup organization for one or more domains",
      description: `Reverse-lookup ctscout.dev's domain-attribution warehouse: given one or more apex domains, return the organization(s) attributed to each.

Args:
  - domains (string[], required): apex domains to look up. Each between 3 and 253 chars. Max 10 per call. Examples: ["gs.com"], ["coalition.com", "at-bay.com"].
  - response_format ('markdown' | 'json', default 'markdown'): output format.

Returns (on success, structuredContent follows the declared outputSchema — the same one as ctscout_search_company; a failed call is isError with no structuredContent):
  - In markdown: a snapshot line, then a table of (domain, attributed to, cert count, subdomain count). Only domains found in the warehouse appear; a missing domain means no attribution in this snapshot, not a negative finding.
  - In JSON: the same structure as ctscout_search_company, including "snapshot" / "snapshot_source". The 'domains' array contains one entry per attributed (domain, org) pair found. Reverse lookups never return semantic candidates.

Examples:
  - Use when: "Who is gs.com attributed to?" -> { domains: ["gs.com"] }
  - Use when: "Are coalition.com and at-bay.com attributed to the same parent?" -> { domains: ["coalition.com", "at-bay.com"] }
  - Don't use when: You have a company name and want to enumerate its domains — use ctscout_search_company instead.

Coverage caveat:
  - Returns 0 results if domain isn't in the warehouse. Either the domain is not in our index, or no OV/EV certs have been issued for it. DV-only domains (Let's Encrypt etc.) are typically not indexed.
  - When a domain IS in the warehouse but the attributed org is a subsidiary (e.g. an Allianz brand domain), the 'org' field shows the cert-subject organization which may differ from the brand on the homepage.

Auth & limits: same as ctscout_search_company.`,
      inputSchema: LookupDomainInputSchema,
      outputSchema: ScanOutputSchema,
      annotations: QUOTA_DEBITING_READ_ONLY_ANNOTATIONS,
    },
    async (params: LookupDomainInput) => {
      try {
        const raw = await callScan({ seed_domain: params.domains });
        const data: ScanResponse = { ...raw, ...resolveSnapshot(raw) };

        if (params.response_format === ResponseFormat.JSON) {
          const { text, structured } = truncateJsonIfNeeded(data);
          return {
            content: [{ type: "text", text }],
            structuredContent: structured as unknown as Record<string, unknown>,
          };
        }

        const md = formatScanAsMarkdown(params.domains.join(", "), data, {
          kind: "domain",
        });
        const { text, structured } = truncateIfNeeded(md, data, params.domains.join(", "), {
          kind: "domain",
        });
        return {
          content: [{ type: "text", text }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: explainError(err) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "ctscout_submit_deep_dive",
    {
      title: "Submit an async Pro deep dive (multi-signal attribution job)",
      description: `Queue an asynchronous Pro deep dive on ctscout.dev: the full multi-signal attribution run (CT warehouse + DNS, RDAP, homepage, IP/ASN corroboration) executed by a batch worker, via POST /jobs. Returns a job receipt immediately, NOT results.

Asynchronous, Pro only:
  - The call returns as soon as the job is queued ({job_id, status: "queued", submitted_at}). Nothing is attributed yet.
  - Poll with ctscout_get_job using the returned job_id. Wait about 30 s before the first poll, then back off toward 5 min between polls; the batch worker picks up queued jobs every few minutes and a deep dive can take several minutes to run.
  - Requires a Pro API key. A free key gets HTTP 403 with the API's upgrade text (Pro is concierge-only: pro@ctscout.dev). Quota: ${JOBS_PER_DAY} submissions per key per day (HTTP 429 over). Submitting is not idempotent — a retry queues a second job.

Args:
  - company_name (string, optional): organization name, matched exactly as in ctscout_search_company (partial, case-insensitive; 2–200 chars).
  - seed_domain (string[], optional): known apex domains to pivot from, max ${MAX_SEED_DOMAINS}. At least one of company_name / seed_domain is required; both may be given. Validated exactly like /scan.
  - response_format ('markdown' | 'json', default 'markdown'): a receipt with polling guidance, or the raw 202 body.

Returns (on success, structuredContent follows the declared outputSchema; a failed call — 401, 403, 429, timeout — is isError with no structuredContent):
    {
      "job_id": string,        // opaque; pass to ctscout_get_job
      "status": "queued",
      "submitted_at": string,
      "poll": "/jobs/<id>"     // informational
    }

What the finished result contains (read it with ctscout_get_job):
  - The deep-dive result shape (a /scan never carries it): "domains" of attributed apex domains, each with "attributed_to", an "enrichment" object (confidence_band, weight_total, matched_via, evidence, signal_health, vlm_status, vlm_override) and the underlying discovery evidence under "base"; plus "entity", "run_metadata", "source" and "signals_degraded".
  - Plus "snapshot": the warehouse date (YYYY-MM-DD) the deep dive read from. It is present on every deep-dive result because the batch worker sets it, together with "worker_version" and "signals_attempted"; a /scan answer carries its own snapshot from the API.
  - "Attributed" means the organization is what the evidence names for that domain (certificate subject, corroborated by the enrichment signals), not an ownership claim. "Candidate" means a semantic name-similarity guess that is NOT an attribution; a deep dive reports attributions with a confidence band, never bare candidates.
  - Visual brand verification (VLM) is NOT included in v1: vlm_status stays "pending" or "skipped" and never vetoes a band.

Examples:
  - Use when: "Run a full attribution deep dive on CNA Financial" -> { company_name: "CNA Financial" }
  - Use when: "Deep-dive from these seed domains" -> { seed_domain: ["cna.com", "cnasurety.com"] }
  - Don't use when: you want an answer now — ctscout_search_company / ctscout_lookup_domain are synchronous. Don't resubmit while a job is queued or running; poll it.`,
      inputSchema: SubmitDeepDiveInputSchema,
      outputSchema: JobSubmitOutputSchema,
      annotations: SUBMIT_JOB_ANNOTATIONS,
    },
    async (params: SubmitDeepDiveInput) => {
      const spec: DeepDiveSpec = {
        ...(params.company_name !== undefined && { company_name: params.company_name }),
        ...(params.seed_domain !== undefined && { seed_domain: params.seed_domain }),
      };
      try {
        const receipt = await callSubmitJob(spec);
        // structuredContent mirrors the bounded record in both formats, as
        // the scan tools' does.
        const { text: json, structured } = truncateReceiptJsonIfNeeded(receipt);
        const text =
          params.response_format === ResponseFormat.JSON
            ? json
            : clampText(formatJobSubmittedAsMarkdown(spec, structured));
        return {
          content: [{ type: "text", text }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: explainError(err, "jobs") }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "ctscout_get_job",
    {
      title: "Poll a deep-dive job and read its result",
      description: `Read the state of an asynchronous Pro deep dive submitted with ctscout_submit_deep_dive, via GET /jobs/{id}. Read-only and free to repeat: polling debits no quota.

Polling:
  - status is "queued" | "running" | "done" | "failed". Only "done" carries "result"; "failed" carries a short "error".
  - Back off: about 30 s before the first poll, then longer waits up to 5 min. A deep dive runs on a batch worker that picks up queued jobs every few minutes.
  - Pro only, and job ids are scoped to the submitting key: HTTP 404 means not your job or an unknown id.

Args:
  - job_id (string, required): the id returned by ctscout_submit_deep_dive.
  - response_format ('markdown' | 'json', default 'markdown'): output format.

Returns (on success, structuredContent follows the declared outputSchema; a failed call — 401, 403, 404, timeout — is isError with no structuredContent, so never dereference snapshot on a failed call):
  - In markdown: the job status lines; once done, the deep-dive attribution table (domain, attributed to, confidence band, signals, evidence) under a snapshot line. No /scan output carries this table.
  - In JSON, structured as:
    {
      "job_id": string,
      "kind": "deep_dive",
      "status": "queued" | "running" | "done" | "failed",
      "submitted_at": string, "started_at": string | null, "finished_at": string | null,
      "result": {                       // only when status is "done"; the deep-dive shape (see below), never returned by /scan
        "entity": {...}, "domains": [ { "domain": string, "attributed_to": string, "enrichment": {...}, "base": {...} } ],
        "run_metadata": {...}, "source": "live-enriched" | "cache-only", "signals_degraded": boolean,
        "snapshot": string,             // warehouse date (YYYY-MM-DD) the deep dive read from — present, the batch worker sets it
        "worker_version": string, "signals_attempted": ...
      },
      "error": string,                  // only when status is "failed"
      "snapshot": string | null,        // copy of result.snapshot once done; null (unknown) before that
      "snapshot_source": "scan" | "unavailable"   // 'scan' = the API response carried the date
    }
  - "Attributed" means the organization is what the evidence names for that domain, not an ownership claim. "Candidate" means a semantic name-similarity guess that is NOT an attribution. Deep dives return attributions with a confidence band (verified / likely / possible / insufficient), never bare candidates. When "signals_degraded" is true some signals errored: absence of their evidence is not evidence of absence.
  - Visual brand verification (VLM) is NOT included in v1: vlm_status stays "pending" or "skipped" and never vetoes a band.

Examples:
  - Use when: "Is my deep dive abc123 finished?" -> { job_id: "abc123" }
  - Don't use when: you have no job_id — submit first with ctscout_submit_deep_dive, or use the synchronous tools.`,
      inputSchema: GetJobInputSchema,
      outputSchema: JobOutputSchema,
      annotations: POLL_JOB_ANNOTATIONS,
    },
    async (params: GetJobInput) => {
      try {
        const job = await callGetJob(params.job_id);
        const { text, structured } =
          params.response_format === ResponseFormat.JSON
            ? truncateJobJsonIfNeeded(job)
            : formatJobAsMarkdown(job);
        return {
          content: [{ type: "text", text }],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: explainError(err, "jobs") }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "ctscout_lookup_lei",
    {
      title: "Look up one LEI's record, or the LEIs published under a legal name",
      description: `Read the ctscout research product's entity index: one LEI's record (GET /lei/{lei}), or the LEIs filed under a legal name (GET /lei?name=). Free, and it debits no quota — every answer is a precomputed object published by the ctscout-research refresh, not a live query.

Args (exactly one of lei / name; passing both is rejected before any network call):
  - lei (string, optional): an ISO 17442 LEI — 18 uppercase alphanumerics plus 2 check digits, e.g. '549300NDMY0KJK0ZLW17'.
  - name (string, optional): a legal entity name, 1–${NAME_QUERY_MAX_CHARS} chars, e.g. 'Cloudflare, Inc.'.
  - response_format ('markdown' | 'json', default 'markdown'): output format.

Returns (on success, structuredContent follows the declared outputSchema; a failed call — 400, 404, 503, timeout — is isError with no structuredContent, so never dereference snapshot on it). One tool, two answer shapes; \`name_match\` is the discriminator, present only on the by-name answer:
  - By LEI:
    {
      "lei": string, "legal_name": string,   // GLEIF's legal name
      "country": string,                     // GLEIF's country
      "isin_count": number,                  // ISINs mapped to this LEI in GLEIF's ISIN-to-LEI file
      "apex_count": number,                  // apex domains attributed to this LEI
      "first_seen": string, "last_seen": string,   // warehouse observation window over those apexes
      "sample_domains": [string],            // hash-chosen sample, whatever size the export published — NOT a ranking, not a complete list
      "vendors_confirmed": [string]          // vendor SLUGS: pass one to ctscout_vendor_customers
    }
  - By name:
    {
      "query": string,
      "name_match": "exact" | "normalized" | "none",
      "leis": [string],                      // capped at "limit" (${LEI_NAME_LIMIT})
      "lei_count": number,                   // matches BEFORE the cap — can exceed leis.length
      "limit": number, "truncated": boolean
    }
  - Both also carry "as_of" / "product_version" (the export version), "snapshot_dates" (the dated GLEIF / ISIN / ELF / Wikidata snapshot and the PSL bundle each join read), and this server's "snapshot" / "snapshot_source" ("product" when the API reported the version, "unavailable" when it did not — then snapshot is null and freshness is unknown, never "current").

What name_match: "none" means (important):
  - It does NOT mean this company has no LEI. The name index is keyed by the research normalizer's form of the GLEIF legal name; the two spellings the route tries (the lowercased, trimmed query and its locale-suffix normalization) are not the index's normalizer, so a real entity can miss on a spelling.
  - Retry with the exact GLEIF legal name, or look the entity up by LEI. Do not report a "none" as an absent LEI.

Vocabulary: a domain is ATTRIBUTED to an entity — that is what the certificate and DNS evidence names, not an ownership claim. A vendor in vendors_confirmed is CONFIRMED, which has a specific meaning: ${VENDOR_CONFIRMED_DEFINITION}.

Examples:
  - Use when: "What does ctscout know about LEI 549300NDMY0KJK0ZLW17?" -> { lei: "549300NDMY0KJK0ZLW17" }
  - Use when: "Which LEIs are filed under 'Cloudflare, Inc.'?" -> { name: "Cloudflare, Inc." }
  - Don't use when: you want the domains attributed to a company by cert subject — that is ctscout_search_company against the warehouse, a different index with different coverage.

Coverage & freshness:
  - The product covers LEIs with at least one attributed apex in the research build, so a 404 means "not in this published version", not "no such LEI". An entity has an LEI at all only where a regulator or a counterparty required one, so an absent LEI is not an absent entity either.
  - The export is republished by the ctscout-research refresh, so these answers move on that cadence — slower than the /scan warehouse, which syncs daily. Read "snapshot" for the version actually answered from.
  - Before the first publish the route answers HTTP 503 and this tool returns a plain "not published yet" error. That is expected, not a fault in the query.`,
      inputSchema: LookupLeiInputSchema,
      outputSchema: LeiLookupOutputSchema,
      annotations: PRODUCT_READ_ONLY_ANNOTATIONS,
    },
    async (params: LookupLeiInput) => {
      try {
        // Branch on the query form, never on the payload: the caller asked one
        // of two questions and the answer shapes must not be sniffed apart.
        // The markdown renders the record the API sent, not the (possibly
        // collapsed) envelope structuredContent carries. Safe here in a way it
        // is NOT for the customer enumeration: an LEI record and a vendor
        // summary are bounded by construction (every cell capped, every list
        // cut at ROW_LIST_LIMIT with a marker, clampText last), and the minimal
        // envelope cuts those same lists to the same 20 while dropping only
        // forward-compatible fields the markdown never renders — so the two
        // views cannot disagree about anything either of them shows. Rendering
        // the envelope instead would make an already-capped list report
        // "+N more" as none. The enumeration is the opposite case: its payload
        // IS the rows, so there both views render one reconciled record
        // (boundVendorCustomers).
        if (params.lei !== undefined) {
          const raw = await callLeiRecord(params.lei);
          const data: LeiRecord = { ...raw, ...resolveProductSnapshot(raw) };
          const { text: json, structured } = truncateProductJson("lei_record", data);
          return {
            content: [
              {
                type: "text",
                text:
                  params.response_format === ResponseFormat.JSON
                    ? json
                    : formatLeiRecordAsMarkdown(data),
              },
            ],
            structuredContent: structured as unknown as Record<string, unknown>,
          };
        }
        const raw = await callLeiByName(params.name as string);
        const data: LeiNameMatches = { ...raw, ...resolveProductSnapshot(raw) };
        const { text: json, structured } = truncateProductJson("lei_name_matches", data);
        return {
          content: [
            {
              type: "text",
              text:
                params.response_format === ResponseFormat.JSON
                  ? json
                  : formatLeiNameMatchesAsMarkdown(data),
            },
          ],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: explainError(err, "product") }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "ctscout_vendor_customers",
    {
      title: "A vendor's customer counts, and — with a key — the customer enumeration",
      description: `Read the ctscout research product's vendor objects: the free summary for a vendor slug (GET /vendors/{slug}), or the per-customer enumeration (GET /vendors/{slug}/customers, which needs an API key). Debits no quota either way — both are precomputed objects published by the ctscout-research refresh.

Args:
  - slug (string, required): the vendor slug, one lowercase segment, e.g. 'cloudflare'. The values in a LEI record's vendors_confirmed are exactly these slugs.
  - enumerate (boolean, optional, default false): false = the free summary; true = the per-customer enumeration, which requires an active ctscout.dev API key (any tier) in CTSCOUT_API_KEY. A missing, invalid or revoked key gets HTTP 401 and this tool explains that the summary is still available with enumerate: false.
  - response_format ('markdown' | 'json', default 'markdown'): output format.

Candidates and confirmed are two different claims and are NEVER summed:
  - Candidate = an apex domain this vendor certified a hostname for. Fan-out alone is not a vendor relationship: an organization certifying hundreds of its own product sites looks identical.
  - Confirmed = the DNS-confirmed subset of the candidates. The definition: ${VENDOR_CONFIRMED_DEFINITION} (or another organization certifies the apex).
  - Confirmed is a SUBSET of candidates, so adding the two double-counts. The markdown keeps them in separate tables and the JSON in separate fields; report them apart.

Returns (on success, structuredContent follows the declared outputSchema; a failed call — 400, 401, 404, 503, timeout — is isError with no structuredContent):
  - enumerate: false (the summary):
    {
      "slug": string, "vendor_name": string,
      "vendor_apex": string | null,          // null when the vendor's brand token matches no label it certifies
      "customers": { "candidates": number, "confirmed": number },
      "countries_top": [ { "country": string, "confirmed": number } ],   // CONFIRMED customers only
      "co_use": [ { "slug": string, "confirmed": number } ],             // see below
      "sample_customers": [string]           // hash-chosen sample of the CONFIRMED customers, whatever size the export published
    }
  - enumerate: true (the enumeration):
    {
      "slug": string,
      "confirmed": [ { "apex": string, "attributed_to": string | null, "lei": string | null } ],
      "candidates": [ same row shape ],
      "counts": { "candidates": number, "confirmed": number },   // what the research build holds
      "capped": boolean,                     // true = the build itself kept a subset of the candidates
      "truncation_note": string              // written by THIS server, only when it dropped rows to fit the character limit; counts and capped still describe the API's answer
    }
  - Both also carry "as_of" / "product_version", "snapshot_dates", and this server's "snapshot" / "snapshot_source" ("product" | "unavailable"; null snapshot means unknown freshness, never "current").

Reading the fields honestly:
  - co_use counts THIS vendor's confirmed customers that the other vendor also certifies — a candidate there, not a mutual confirmation.
  - countries_top counts confirmed customers that resolved to an LEI; candidates and LEI-less customers are not in it.
  - attributed_to is GLEIF's legal name when the apex resolves to one LEI, the single non-vendor certificate organization otherwise, and null when neither holds. It is an attribution, not an ownership claim.

Examples:
  - Use when: "How many customers does Cloudflare have in the index?" -> { slug: "cloudflare" }  (report candidates and confirmed separately)
  - Use when: "List Cloudflare's confirmed customers" -> { slug: "cloudflare", enumerate: true }
  - Don't use when: you have a company and want its vendors — read vendors_confirmed from ctscout_lookup_lei instead.

Coverage & freshness:
  - A 404 means the slug is not in the published version, not that the vendor does not exist. The export is republished by the ctscout-research refresh, so these answers move on that cadence rather than the daily /scan warehouse sync.
  - Before the first publish the routes answer HTTP 503 and this tool returns a plain "not published yet" error. That is expected, not a fault in the query.`,
      inputSchema: VendorCustomersInputSchema,
      outputSchema: VendorCustomersOutputSchema,
      annotations: PRODUCT_READ_ONLY_ANNOTATIONS,
    },
    async (params: VendorCustomersInput) => {
      try {
        if (params.enumerate) {
          // The enumeration is the one keyed route here. Answering before the
          // round-trip keeps a keyless install's error identical to the origin's
          // 401 rather than surfacing the generic getApiKey message.
          if (configuredApiKey() === undefined) {
            return {
              content: [{ type: "text", text: ENUMERATION_KEY_GUIDANCE }],
              isError: true,
            };
          }
          const raw = await callVendorCustomers(params.slug);
          const data: VendorCustomers = { ...raw, ...resolveProductSnapshot(raw) };
          // One bounded record, two renderings of it — never two independent
          // trims, which would let the markdown show a complete list beside a
          // structuredContent whose own note described a shorter one.
          const bounded = boundVendorCustomers(data);
          return {
            content: [
              {
                type: "text",
                text: params.response_format === ResponseFormat.JSON ? bounded.json : bounded.text,
              },
            ],
            structuredContent: bounded.structured as unknown as Record<string, unknown>,
          };
        }
        const raw = await callVendorSummary(params.slug);
        const data: VendorSummary = { ...raw, ...resolveProductSnapshot(raw) };
        const { text: json, structured } = truncateProductJson("vendor_summary", data);
        return {
          content: [
            {
              type: "text",
              text:
                params.response_format === ResponseFormat.JSON
                  ? json
                  : formatVendorSummaryAsMarkdown(data),
            },
          ],
          structuredContent: structured as unknown as Record<string, unknown>,
        };
      } catch (err) {
        // Only the enumeration has a key requirement and a keyless alternative
        // to name, so the 401/403 text follows the call that was actually made.
        return {
          content: [
            {
              type: "text",
              text: explainError(err, params.enumerate ? "vendor_enumeration" : "product"),
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ---------- Main ----------

async function main(): Promise<void> {
  // Report a missing key early, on stderr, so an MCP client surfaces the config
  // issue at boot rather than on the first tool call — but do NOT exit. The free
  // research-product routes (ctscout_lookup_lei, ctscout_vendor_customers
  // without `enumerate`) are unauthenticated, so a keyless install is a valid
  // configuration for those two tools; the five that need a key fail per call
  // with the same message.
  if (configuredApiKey() === undefined) {
    console.error(
      `${SERVER_NAME}: CTSCOUT_API_KEY is not set. The free /lei and /vendors tools ` +
        "(ctscout_lookup_lei, and ctscout_vendor_customers without enumerate) still work; " +
        "every other tool will return an error until a key is configured. Get a free key at " +
        "https://ctscout.dev (no email, no signup).",
    );
  }

  // serveStdio selects the MCP era from the opening exchange. Modern clients
  // use the stateless 2026-07-28 server/discover flow; legacy stdio clients
  // keep their initialize handshake. The factory is deliberately fresh per
  // connection (and for the disposable discovery probe) so no request/session
  // state can leak across SDK instances.
  serveStdio(() => createServer(), {
    legacy: "serve",
    onerror: (error) => console.error(`MCP transport error: ${error.message}`),
  });
  console.error(`${SERVER_NAME} v${SERVER_VERSION} running via stdio (api=${API_BASE_URL})`);
}

// Only auto-boot when invoked directly (e.g. via `node dist/index.js`
// or the `bin` entry). Importing this module for tests must NOT start
// the stdio transport — Vitest would hang on the server's event loop.
//
// `import.meta.url` resolves to the REAL file path of the executed
// module. `process.argv[1]` may be a SYMLINK created by npm / npx
// (e.g. `node_modules/.bin/ctscout-mcp-server -> ../ctscout-mcp-server/
// dist/index.js`). On v0.2.0 we compared the raw paths, which made
// the guard silently fail for every `npx` install — `main()` never
// ran and the binary exited 0 with no output. Resolve both sides to
// their real path before comparing so the symlink case works.
const isDirectlyExecuted = (() => {
  try {
    const moduleReal = realpathSync(fileURLToPath(import.meta.url));
    let argv1Real: string;
    try {
      argv1Real = realpathSync(process.argv[1]);
    } catch (e) {
      if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
        let resolved: string | undefined;
        for (const ext of [".js", ".ts", ".mjs", ".cjs"]) {
          try {
            resolved = realpathSync(process.argv[1] + ext);
            break;
          } catch {
            // try next extension
          }
        }
        if (resolved !== undefined) {
          argv1Real = resolved;
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
    return moduleReal === argv1Real;
  } catch {
    return false;
  }
})();

if (isDirectlyExecuted) {
  main().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
