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
 * Distribution: stdio transport for local use (invoked via npx by an MCP
 * client such as Claude Code or Claude Desktop). For zero-install access
 * the same tools are also served over HTTP at https://ctscout.dev/mcp
 * (Streamable HTTP transport) and https://ctscout.dev/sse (SSE legacy).
 * This binary is the local-execution path; the README documents both.
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------- Constants ----------

const API_BASE_URL = process.env.CTSCOUT_API_URL ?? "https://ctscout.dev";
const SCAN_URL = `${API_BASE_URL}/scan`;
const SCAN_BATCH_URL = `${API_BASE_URL}/scan/batch`;
// Max company names accepted per batch. The upstream ctscout-worker enforces
// this server-side (>N → 400 without a partial quota debit); it caps at 10
// because the Worker runs on the free plan (50 subrequests/request) and a
// worst-case all-semantic batch is ~11 subrequests/query — see
// ctscout-worker src/index.ts `MAX_BATCH_SIZE`. Issue ctscout-mcp#19 proposed
// 50, but that was the original #128 target before the free-plan cap landed;
// the live contract is 10. Enforcing it client-side is belt-and-suspenders
// (a clean validation error before a network round-trip), not load-bearing.
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
  JSON = "json",
  MARKDOWN = "markdown",
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
  // ScoutResult also carries `entity` and `run_metadata` at the top level.
  [k: string]: unknown;
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

  if (response.domains.length === 0) {
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
      lines.push("All matching domains were dropped to keep the response under the size limit.");
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
    `Returned **${response.domains.length}** domain(s) of ${totalDisplay} total. ` +
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

  if (kind === "free") {
    rows.push("| Domain | Organization | Certs | Subdomains |");
    rows.push("|---|---|---:|---:|");
  } else if (kind === "pro") {
    rows.push("| Domain | Attributed to | Band | Signals | Evidence |");
    rows.push("|---|---|---|---|---|");
  } else if (kind === "scout") {
    rows.push("| Domain | Org | Confidence | Sources | Evidence |");
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

// Both output formats are capped at CHARACTER_LIMIT, so the hint must not
// point at JSON as an escape hatch for size (it used to — ctscout-mcp#42).
function truncationHint(kept: number, total: number): string {
  return (
    `Response truncated to ${kept} of ${total} domains ` +
    `to stay under ${CHARACTER_LIMIT} chars. Refine the query to narrow ` +
    `the results (JSON output is truncated the same way).`
  );
}

// Shared halving loop: drop whole trailing domain entries and re-render
// until the rendered text fits, parameterized by the render function so
// the markdown and JSON paths bound output identically.
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
      upgrade_hint: truncationHint(0, structured.domains.length),
      source: structured.source,
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
  const header = `# ctscout batch results (${n} ${n === 1 ? "company" : "companies"})`;
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

  // Pass 1: measure each section's full demand. Pass 2: re-render each within
  // its fair share so no company can crowd out the rest.
  const fullLengths = results.map(
    (item, i) => renderCompanySection(nameFor(i), item, CHARACTER_LIMIT).length,
  );
  const budgets = fairShareBudgets(fullLengths, budget);
  const sections = results.map((item, i) => renderCompanySection(nameFor(i), item, budgets[i]));

  return assembleBatchMarkdown(header, sections, footer);
}

// Bound one batch result item's compact JSON to `limit`. Every item is
// guaranteed <= its slice on return, so no item can stay oversized and trip
// the drop-trailing backstop in truncateBatchJsonIfNeeded (which would silently
// evict good siblings — the batch-level analogue of the starvation fair-share
// exists to prevent).
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
  // Halving only trims `domains`. If non-domain bulk (a large `candidates[]`,
  // the echoed `query`, or arbitrary top-level ScoutResult fields) still
  // exceeds the slice with zero domains, emit a minimal bounded envelope of
  // known-small fields — mirrors the single-scan minimal-envelope guard in
  // truncateJsonIfNeeded so the item never stays oversized.
  if (JSON.stringify(structured).length > limit) {
    const originalDomainCount = Array.isArray(item.domains) ? item.domains.length : 0;
    return {
      query: item.query,
      domains: [],
      total: item.total,
      truncated: true,
      upgrade_hint: truncationHint(0, originalDomainCount),
    };
  }
  return structured as BatchResultItem;
}

// JSON-format batch output respects CHARACTER_LIMIT too (#53), via the same
// fair-share split as the markdown path: pretty-print when it fits, else bound
// each result's domains to an equal slice, then drop whole trailing results as
// a final backstop. Truncated output stays valid JSON.
export function truncateBatchJsonIfNeeded(batch: ScanBatchResponse): {
  text: string;
  structured: ScanBatchResponse;
} {
  const pretty = JSON.stringify(batch, null, 2);
  if (pretty.length <= CHARACTER_LIMIT) {
    return { text: pretty, structured: batch };
  }

  const results = batch.results;
  const n = results.length;
  const skeleton = JSON.stringify({ results: [], remaining_quota: batch.remaining_quota });
  const budget = Math.max(0, CHARACTER_LIMIT - skeleton.length - n); // ≈ per-item commas
  const fullLengths = results.map((item) => JSON.stringify(item).length);
  const budgets = fairShareBudgets(fullLengths, budget);
  const truncatedResults = results.map((item, i) => truncateResultJson(item, budgets[i]));

  let structured: ScanBatchResponse = {
    results: truncatedResults,
    remaining_quota: batch.remaining_quota,
  };
  let text = JSON.stringify(structured);

  // Backstop: if envelope framing still pushes us over, drop whole trailing
  // results until it fits (always leaves valid JSON).
  while (text.length > CHARACTER_LIMIT && structured.results.length > 0) {
    structured = {
      ...structured,
      results: structured.results.slice(0, -1),
    };
    text = JSON.stringify(structured);
  }

  return { text, structured };
}

// ---------- Server + tools ----------

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
  - response_format ('markdown' | 'json', default 'markdown'): output format.

Returns:
  - In markdown: a table of (domain, org, cert count, subdomain count).
  - In JSON, structured as:
    {
      "domains": [
        {
          "org": string,                  // legal entity name as recorded in cert
          "apex_domain": string,          // e.g. "gs.com"
          "cert_count": number,           // # of certs observed for this domain
          "subdomain_count": number,      // # of distinct subdomains
          "first_seen": string,           // ISO 8601 timestamp
          "last_seen": string             // ISO 8601 timestamp
        }
      ],
      "total": number,                    // total matching rows in warehouse
      "truncated": boolean,               // true if response is capped
      "upgrade_hint": string,             // present when truncated
      "source": "warehouse" | "live"     // free tier = warehouse, pro = live
    }

Examples:
  - Use when: "Find all domains owned by Cloudflare" -> { company_name: "Cloudflare" }
  - Use when: "What domains does Goldman own?" -> { company_name: "Goldman Sachs" }
  - Don't use when: You have a specific domain and want to find the organization it's attributed to — use ctscout_lookup_domain instead.

Auth & limits:
  - Requires CTSCOUT_API_KEY env var. Get a free key (no email) at https://ctscout.dev.
  - Free tier: 10 queries/day, top 5 results from weekly snapshot.
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
  - Best for established US/EU tech companies with OV/EV certs (~5,976 entities indexed).
  - Limited coverage on small private companies, cyber MGAs, and entities using only DV (Let's Encrypt) certs.
  - See https://ctscout.dev for current coverage map.`,
    inputSchema: SearchCompanyInputSchema.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: SearchCompanyInput) => {
    try {
      const data = await callScan({ company_name: params.company_name });

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

Returns:
  - In markdown: one section per company (heading + the same table as ctscout_search_company), followed by remaining quota. Names that failed render an error line instead of a table.
  - In JSON, the raw batch envelope:
    {
      "results": [
        { "query": {...}, "domains": [...], "total": number, "match_type": "exact"|"semantic"|"none", "candidates"?: [...] },
        { "query": {...}, "error": { "code": number, "message": string } }
      ],
      "remaining_quota": number | null   // null = unlimited (Pro)
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
  - Bulk caveat: a batch where many names fall back to semantic matching can exceed the endpoint's per-request subrequest budget, in which case the trailing names come back as per-query HTTP 503 errors (with retry guidance in the message). If you see those, split into smaller batches. High-volume bulk callers should prefer the REST /scan/batch endpoint directly (it accepts a strict_match_org_only flag that suppresses the semantic fallback).

Legal-vs-brand and coverage caveats are identical to ctscout_search_company — brand names may need legal-entity variants ("X Companies", "X Group", "The X"), and coverage is best for established US/EU entities with OV/EV certs.`,
    inputSchema: SearchCompanyBatchInputSchema.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: SearchCompanyBatchInput) => {
    try {
      const queries: ScanRequestBody[] = params.company_names.map((company_name) => ({
        company_name,
      }));
      const data = await callScanBatch(queries);

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

Returns:
  - In markdown: a table of (domain, org, cert count, subdomain count). Only domains found in the warehouse appear; missing domains indicate no attribution.
  - In JSON: the same structure as ctscout_search_company. The 'domains' array contains one entry per (domain, org) pair found.

Examples:
  - Use when: "Who owns gs.com?" -> { domains: ["gs.com"] }
  - Use when: "Are coalition.com and at-bay.com owned by the same parent?" -> { domains: ["coalition.com", "at-bay.com"] }
  - Don't use when: You have a company name and want to enumerate its domains — use ctscout_search_company instead.

Coverage caveat:
  - Returns 0 results if domain isn't in the warehouse. Either the domain is not in our index, or no OV/EV certs have been issued for it. DV-only domains (Let's Encrypt etc.) are typically not indexed.
  - When a domain IS in the warehouse but the attributed org is a subsidiary (e.g. an Allianz brand domain), the 'org' field shows the cert-subject organization which may differ from the brand on the homepage.

Auth & limits: same as ctscout_search_company.`,
    inputSchema: LookupDomainInputSchema.shape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async (params: LookupDomainInput) => {
    try {
      const data = await callScan({ seed_domain: params.domains });

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
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
