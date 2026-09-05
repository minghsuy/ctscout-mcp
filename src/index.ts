#!/usr/bin/env node
/**
 * MCP Server for ctscout.dev — domain discovery via Certificate Transparency.
 *
 * Wraps the public ctscout.dev /scan API. Three tools:
 *
 * - ctscout_search_company:       find domains attributed to an organization by name
 * - ctscout_search_company_batch: same, for up to 10 organization names in one call
 * - ctscout_lookup_domain:        reverse lookup — find the organization for one or more domains
 *
 * Auth: requires an API key via the CTSCOUT_API_KEY environment variable.
 * Get a free key (no email, no signup) at https://ctscout.dev.
 *
 * Distribution: stdio compatibility transport for local use (invoked via npx
 * by an MCP client such as Claude Code or Claude Desktop). The entry supports
 * both the stateless 2026-07-28 server/discover era and legacy initialize
 * clients. The authoritative hosted contract is served at
 * https://ctscout.dev/mcp (Streamable HTTP transport). Both transports expose
 * the same three public tools while the longer-term shared-core/forwarding
 * migration continues in #72.
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
// Keep in lockstep with ctscout-worker's hosted MCP MAX_BATCH_QUERIES and REST
// MAX_BATCH_SIZE. Both public transports accept 1–10 names; validation here is
// belt-and-suspenders (a clean error before a network round-trip), while the
// Worker re-enforces the limit before quota debit.
const MAX_BATCH_QUERIES = 10;
const REQUEST_TIMEOUT_MS = 30_000;
const CHARACTER_LIMIT = 25_000;
const ERROR_BODY_LIMIT = 500;
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

export interface ProEnrichment {
  confidence_band: ConfidenceBand;
  weight_total: number;
  matched_via: string[];
  evidence: Record<string, string>;
  signal_health: Record<string, string>;
  vlm_status: VlmStatus;
  vlm_override: boolean;
}

export interface DomainResult {
  // ---- Warehouse / "Phase 5 fictional Pro" shape (free tier from D1; or
  //      pre-Phase-6 Pro-with-enrichment which the origin never actually
  //      produced). Marked optional because the real Pro tier returns
  //      ScoutResult-shaped objects instead — see below.
  org?: string;
  apex_domain?: string;
  cert_count?: number;
  subdomain_count?: number;
  first_seen?: string | null;
  last_seen?: string | null;
  // Customer-facing claim; "attributed_to" not "owns"
  attributed_to?: string;
  enrichment?: ProEnrichment;

  // ---- ScoutResult shape (real Pro tier, proxied verbatim from the Spark
  //      origin's domain-scout library). The origin returns these fields,
  //      NOT the warehouse/enrichment shape above. The mismatch was the
  //      undefined-cells bug fixed in 2026-05-15 (ctscout-mcp#14).
  domain?: string;
  confidence?: number | null;
  sources?: string[];
  evidence?: Array<Record<string, unknown>>;
  cert_org_names?: string[];
  rdap_org?: string | null;
  resolves?: boolean;
  is_seed?: boolean;
  seed_sources?: string[];

  // Catch-all for any future origin fields so the type doesn't go stale.
  [k: string]: unknown;
}

export interface ScanResponse {
  domains: DomainResult[];
  // Warehouse responses set these; ScoutResult responses don't.
  total?: number;
  truncated?: boolean;
  upgrade_hint?: string;
  // "warehouse" / "live" = legacy free-tier sources.
  // "cache-only" / "live-enriched" = Phase 5 Pro tier (orchestrator with
  // enrichment objects — fictional, the origin doesn't produce this).
  // undefined = ScoutResult shape from the real Pro tier origin.
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
  // ScoutResult also carries `entity` and `run_metadata` at the top level.
  [k: string]: unknown;
}

// Where a response's `snapshot` date came from:
//   "scan"        — the API payload itself carried a `snapshot` string.
//   "unavailable" — it did not; `snapshot` is null, not missing, so a consumer
//                   can tell "the server could not say" from "an older server
//                   that never emitted the field".
// There is deliberately no other source: a date fetched separately (e.g. GET
// /stats last_sync) is not generation-coupled to the scan and can disagree with
// it across the weekly sync, which would claim a provenance the answer lacks.
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

// ---------- Output schemas ----------
//
// Advertised as `outputSchema` and enforced by the SDK against every
// structuredContent this server returns. The payload is proxied from the API
// (warehouse rows on free, ScoutResult objects on Pro), so every proxied field
// is typed loosely and documented via describe(): an upstream enum growing a
// value must widen what an agent sees, not turn the tool call into an error.
// Only the fields this server writes itself (`snapshot`, `snapshot_source`)
// are required and closed.

const SnapshotFields = {
  snapshot: z
    .string()
    .nullable()
    .describe(
      "Warehouse/D1 sync date (YYYY-MM-DD) the answer was read from; the free tier " +
        "serves a weekly snapshot. null when it could not be determined.",
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
        "Pro tier (ScoutResult): the strongest evidence available — cert subject when present, " +
        "else the RDAP registrant; see cert_org_names / rdap_org for which.",
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
  // ScoutResult (Pro) fields — proxied verbatim from the origin.
  domain: z.string().optional().describe("Pro tier: the apex domain (ScoutResult shape)."),
  confidence: z.number().nullable().optional().describe("Pro tier: 0..1 attribution confidence."),
  sources: z.array(z.string()).optional(),
  cert_org_names: z.array(z.string()).optional(),
  rdap_org: z.string().nullable().optional(),
});

const ScanOutputSchema = z.looseObject({
  domains: z
    .array(DomainResultSchema)
    .describe("Attributed (domain, organization) pairs. Empty when nothing is attributed."),
  total: z.number().optional().describe("Matching pairs in the warehouse before any cap."),
  truncated: z.boolean().optional(),
  upgrade_hint: z.string().optional(),
  source: z.string().optional().describe("'warehouse' on the free tier; 'live*' on Pro."),
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

// ---------- Shared utilities ----------

export function getApiKey(): string {
  const key = process.env.CTSCOUT_API_KEY;
  if (!key || key.trim().length === 0) {
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

// Shared POST core for /scan and /scan/batch: identical auth, headers,
// timeout, and bounded-error-body handling (readBoundedText, #57). The two
// endpoints differ only in URL and request/response shape, so both tools
// inherit the same error-capture bound rather than duplicating it.
async function postScan<T>(url: string, body: unknown): Promise<T> {
  const apiKey = getApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Key": apiKey,
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
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
  return postScan<ScanResponse>(SCAN_URL, body);
}

// POST /scan/batch: one envelope, per-query results in input order. The
// caller (the batch tool) has already bounded `queries` to MAX_BATCH_QUERIES;
// the worker re-enforces server-side (>10 → 400) and debits quota by the
// batch length.
export async function callScanBatch(queries: ScanRequestBody[]): Promise<ScanBatchResponse> {
  return postScan<ScanBatchResponse>(SCAN_BATCH_URL, { queries });
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

export function explainError(err: unknown): string {
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

// Exported for tests. Renders three response shapes from the ctscout /scan
// API:
//
//   1. Warehouse (free tier) — `source: "warehouse"`, each domain has
//      `{org, apex_domain, cert_count, subdomain_count, first_seen,
//      last_seen}`. Legacy v0.1.0 table format.
//   2. ScoutResult (real Pro tier) — proxied verbatim from the Spark
//      origin's domain-scout library. Top level has no `source` field;
//      each domain has `{domain, confidence, sources[], evidence[],
//      cert_org_names[], rdap_org, ...}`. Rendered as a confidence-band
//      / signals / evidence table.
//   3. Phase-5 fictional Pro (`source: "live-enriched" | "cache-only"` or
//      domains carrying an `enrichment` object) — the original assumed
//      Pro shape. Kept for backward compat with pre-Phase-6 fixtures.
//
// The undefined-cells bug fixed here (2026-05-15, ctscout-mcp#14) was
// that the real Pro tier returns shape #2, but the formatter only knew
// shapes #1 and #3 — so every cell rendered as `undefined`.
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
type TableKind = "free" | "pro" | "scout";

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
        lines.push(`> ${response.upgrade_hint}`);
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
      lines.push(`> ${response.upgrade_hint}`);
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

  // Shape detection. ScoutResult domain objects have `domain` (not
  // `apex_domain`); the two shapes don't overlap on this attribute.
  // Single-field check is sufficient. ASSUMPTION: arrays are homogeneous —
  // the API never mixes ScoutResult and warehouse rows in one response.
  // If it ever did, rows after the first would render through the wrong
  // column mapping (formatTable's per-row `??` fallbacks degrade to "—"
  // rather than throwing).
  const first = response.domains[0];
  const isScoutResult = typeof first.domain === "string" && typeof first.apex_domain !== "string";

  // Phase-5 fictional Pro detection (kept for backward compat). Only
  // considered when the response isn't already ScoutResult-shaped.
  const isPhase5Pro =
    !isScoutResult &&
    (response.source === "live-enriched" ||
      response.source === "cache-only" ||
      response.domains.some((d) => d.enrichment != null));

  const isPro = isScoutResult || isPhase5Pro;
  const totalDisplay = response.total ?? response.domains.length;
  const sourceDisplay = response.source ?? (isScoutResult ? "scout-result" : "unknown");

  lines.push(
    `Returned **${response.domains.length}** attributed domain(s) of ${totalDisplay} total. ` +
      `Source: \`${sourceDisplay}\`${isPro ? " _(Pro tier — multi-signal attribution)_" : ""}.`,
  );
  if (response.truncated && response.upgrade_hint) {
    lines.push("");
    lines.push(`> ${response.upgrade_hint}`);
  }
  lines.push("");

  const kind: TableKind = isScoutResult ? "scout" : isPhase5Pro ? "pro" : "free";
  lines.push(formatTable(response.domains, kind));

  return lines.join("\n");
}

// How many sources to show inline before collapsing the rest into a "+N
// more" overflow indicator. Mirrors the Phase-5 Pro renderer's behavior
// for cross-path consistency (matched_via is also capped + collapsed).
const SOURCES_INLINE_LIMIT = 4;

function formatTable(domains: DomainResult[], kind: TableKind): string {
  const rows: string[] = [];

  // Every table names the org column "Attributed to": the row is a cert-subject
  // attribution, never an ownership claim, and never a semantic candidate.
  if (kind === "free") {
    rows.push("| Domain | Attributed to | Certs | Subdomains |");
    rows.push("|---|---|---:|---:|");
  } else if (kind === "pro") {
    rows.push("| Domain | Attributed to | Band | Signals | Evidence |");
    rows.push("|---|---|---|---|---|");
  } else if (kind === "scout") {
    rows.push("| Domain | Attributed to | Confidence | Sources | Evidence |");
    rows.push("|---|---|---|---|---|");
  }

  for (const d of domains) {
    if (kind === "free") {
      const domain = d.apex_domain ?? d.domain;
      const org = d.org ?? d.cert_org_names?.[0] ?? d.rdap_org;
      rows.push(
        `| \`${cellSafe(domain, 60)}\` | ${cellSafe(org, 50)} | ${d.cert_count ?? "—"} | ${d.subdomain_count ?? "—"} |`,
      );
    } else if (kind === "pro") {
      const domain = d.apex_domain ?? d.domain;
      const org = d.attributed_to ?? d.org ?? d.cert_org_names?.[0] ?? d.rdap_org;
      const enriched = d.enrichment;
      if (enriched == null) {
        // Mixed-tier response (degraded apex from `_degraded()` in Pro /scan).
        rows.push(`| \`${cellSafe(domain, 60)}\` | ${cellSafe(org, 50)} | _missing_ | — | — |`);
      } else {
        const bandEmoji = bandIndicator(enriched.confidence_band);
        const overrideTag = enriched.vlm_override ? " 🚫VLM-veto" : "";
        const signalSummary = enriched.matched_via.length
          ? enriched.matched_via.slice(0, 3).join(", ") +
            (enriched.matched_via.length > 3 ? `, +${enriched.matched_via.length - 3}` : "")
          : "_none_";
        const topEvidence = topEvidenceLine(enriched.evidence);
        rows.push(
          `| \`${cellSafe(domain, 60)}\` | ${cellSafe(org, 50)} | ${bandEmoji} ${enriched.confidence_band}${overrideTag} | ${cellSafe(signalSummary)} | ${topEvidence} |`,
        );
      }
    } else if (kind === "scout") {
      const domain = d.domain;
      const certOrgs = d.cert_org_names ?? [];
      // Org fallback chain: cert_org_names[0] -> rdap_org -> org. cellSafe
      // turns undefined into "—" so we don't need a trailing `?? undefined`.
      const org = certOrgs[0] ?? d.rdap_org ?? d.org;
      const conf = d.confidence;
      const confCell = conf != null ? `${confidenceBand(conf)} (${conf.toFixed(2)})` : "—";
      const sources = d.sources ?? [];
      // Show first N sources and append a "+M" indicator for any overflow,
      // so callers can tell when they're looking at an incomplete list.
      const overflowSources = sources.length - SOURCES_INLINE_LIMIT;
      const sourcesCell =
        sources.slice(0, SOURCES_INLINE_LIMIT).join(", ") +
        (overflowSources > 0 ? `, +${overflowSources}` : "");
      // Type-guard rather than cast: the `evidence` element type is
      // Record<string, unknown>, so `description` is `unknown`. If the
      // origin ever sends a non-string description (number, object, null),
      // we fall back to em-dash instead of stringifying via cellSafe.
      const rawDescription = d.evidence?.[0]?.description;
      const firstDescription = typeof rawDescription === "string" ? rawDescription : undefined;
      rows.push(
        `| \`${cellSafe(domain, 60)}\` | ${cellSafe(org, 50)} | ${confCell} | ${cellSafe(sourcesCell, 40)} | ${cellSafe(firstDescription, 80)} |`,
      );
    }
  }

  return rows.join("\n");
}

// ---------- ScoutResult renderer (real Pro tier from Spark origin) ----------

// Map a 0..1 confidence float to a human-readable band. Matches the
// thresholds used in ctscout-worker#56's formatter for cross-transport
// consistency.
function confidenceBand(c: number | null | undefined): string {
  if (c == null || Number.isNaN(c)) return "—";
  if (c >= 0.9) return "verified";
  if (c >= 0.7) return "likely";
  if (c >= 0.5) return "possible";
  return "low";
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
  return stripped.length > maxLen ? `${stripped.slice(0, maxLen - 1)}…` : stripped;
}

// ---------- Phase-5 fictional Pro renderer helpers (kept for compat) ----------

function bandIndicator(band: ConfidenceBand): string {
  switch (band) {
    case "verified":
      return "✅";
    case "likely":
      return "🟢";
    case "possible":
      return "🟡";
    case "insufficient":
      return "⚪";
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

function topEvidenceLine(evidence: Record<string, string>): string {
  for (const key of EVIDENCE_PRIORITY) {
    if (key in evidence) {
      return escapeForTable(evidence[key]);
    }
  }
  // Fallback: first key in dict order
  for (const key in evidence) {
    return escapeForTable(evidence[key]);
  }
  return "_no evidence_";
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
): {
  text: string;
  structured: ScanResponse;
} {
  let currentText = text;
  let currentStructured = structured;
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
        upgrade_hint: truncationHint(0, structured.domains.length),
      };
      currentText = render(currentStructured);
      break;
    }

    const halved = Math.max(1, Math.floor(currentStructured.domains.length / 2));
    currentStructured = {
      ...currentStructured,
      domains: currentStructured.domains.slice(0, halved),
      truncated: true,
      upgrade_hint: truncationHint(halved, structured.domains.length),
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
      upgrade_hint: truncationHint(
        kept,
        originalCandidates?.length ?? currentStructured.candidates.length,
        "semantic candidates",
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
    const minimal: ScanResponse = {
      domains: [],
      total: structured.total,
      truncated: true,
      upgrade_hint: fullyTruncatedHint(structured),
      source: structured.source,
      match_type: structured.match_type,
      org_match_strategy: structured.org_match_strategy,
      ...(structured.empty_reason !== undefined && {
        empty_reason: structured.empty_reason,
      }),
      ...(Array.isArray(structured.candidates) && { candidates: [] }),
      ...(structured.snapshot_source !== undefined && {
        snapshot: structured.snapshot ?? null,
        snapshot_source: structured.snapshot_source,
      }),
    };
    return { text: JSON.stringify(minimal), structured: minimal };
  }

  return result;
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
  // top-level ScoutResult fields still exceed the slice, emit a minimal
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

Returns (structuredContent always follows the declared outputSchema):
  - "Attributed" means the organization is what the evidence names for that domain, not an ownership claim. On the free tier that evidence is always the OV/EV certificate subject. On the Pro tier (ScoutResult) it is the strongest available signal: the certificate subject when there is one, otherwise the RDAP registrant — check cert_org_names / rdap_org to see which. "Candidate" means a semantic name-similarity guess that is NOT an attribution.
  - In markdown: a snapshot line, then a table of (domain, attributed to, cert count, subdomain count). When nothing is attributed but match_type is 'semantic', a table of candidate organizations is rendered instead, labelled as candidates.
  - In JSON, structured as:
    {
      "domains": [                        // attributed pairs; empty when nothing is attributed
        {
          "org": string,                  // attributed organization: cert subject (free); cert subject else RDAP registrant (Pro)
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
      "source": "warehouse" | "live",     // free tier = warehouse, pro = live
      "match_type": "exact" | "semantic" | "none",   // 'semantic' = domains empty, candidates offered
      "org_match_strategy": string,       // which matching pass produced the answer
      "empty_reason": string,             // present on empty results: why nothing was attributed
      "candidates": [                     // only when match_type is 'semantic'; NOT attributions
        { "org": string, "similarity": number, "top_apex_domain": string | null }
      ],
      "snapshot": string | null,          // warehouse/D1 sync date (YYYY-MM-DD) ONLY when the API reported it; null otherwise — today the API does not, so expect null
      "snapshot_source": "scan" | "unavailable"   // 'scan' = API carried the date; 'unavailable' = it did not (snapshot is null). null means unknown freshness, never "current"
    }

Examples:
  - Use when: "Find all domains attributed to Cloudflare" -> { company_name: "Cloudflare" }
  - Use when: "Which domains are attributed to Goldman?" -> { company_name: "Goldman Sachs" }
  - Don't use when: You have a specific domain and want to find the organization it's attributed to — use ctscout_lookup_domain instead.

Auth & limits:
  - Requires CTSCOUT_API_KEY env var. Get a free key (no email) at https://ctscout.dev.
  - Free tier: 10 queries/day, top 5 results from a weekly snapshot. The response's "snapshot" field carries that snapshot's sync date only when the API reports it; today it does not, so expect snapshot: null / snapshot_source: "unavailable" and treat freshness as unknown.
  - Pro tier: unlimited queries, full result set, live enrichment.

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
  - Warehouse size (organizations, org-domain pairs, last sync) is not stated here because it changes weekly; read the live figures at https://ctscout.dev/stats before treating a miss as meaningful.`,
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

Returns (structuredContent always follows the declared outputSchema):
  - "Attributed" and "candidate" mean exactly what they mean in ctscout_search_company: what the evidence names (cert subject on the free tier; cert subject else RDAP registrant on Pro) vs a semantic name-similarity guess that is NOT an attribution.
  - In markdown: a snapshot line, then one section per company (heading + the same attributed-domains table as ctscout_search_company; a candidate-organizations table when that name's match_type is 'semantic'), followed by remaining quota. Names that failed render an error line instead of a table.
  - In JSON, the batch envelope:
    {
      "results": [
        { "query": {...}, "domains": [...], "total": number, "match_type": "exact"|"semantic"|"none", "candidates"?: [...] },   // same per-result fields as ctscout_search_company
        { "query": {...}, "error": { "code": number, "message": string } }
      ],
      "remaining_quota": number | null,  // null = unlimited (Pro)
      "snapshot": string | null,         // sync date shared by every result in the batch, ONLY when the API reported it; null (unknown freshness) otherwise — today the API does not
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

Returns (structuredContent always follows the declared outputSchema — the same one as ctscout_search_company):
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

  return server;
}

// ---------- Main ----------

async function main(): Promise<void> {
  // Validate API key early — fail with a clear error before connecting transport
  // so MCP clients surface the config issue cleanly rather than on first tool call.
  try {
    getApiKey();
  } catch (err) {
    console.error(err instanceof Error ? err.message : `Startup error: ${String(err)}`);
    process.exit(1);
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
