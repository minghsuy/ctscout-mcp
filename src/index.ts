#!/usr/bin/env node
/**
 * MCP Server for ctscout.dev — domain discovery via Certificate Transparency.
 *
 * Wraps the public ctscout.dev /scan API. Two tools:
 *
 * - ctscout_search_company: find domains attributed to an organization by name
 * - ctscout_lookup_domain:  reverse lookup — find the organization for one or more domains
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
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------- Constants ----------

const API_BASE_URL = process.env.CTSCOUT_API_URL ?? "https://ctscout.dev";
const SCAN_URL = `${API_BASE_URL}/scan`;
const REQUEST_TIMEOUT_MS = 30_000;
const CHARACTER_LIMIT = 25_000;
const SERVER_NAME = "ctscout-mcp-server";
const SERVER_VERSION = "0.2.3";

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
  org: string;
  apex_domain: string;
  cert_count: number;
  subdomain_count: number;
  first_seen?: string;
  last_seen?: string;
  // ---- Pro-tier only (Phase 5+) ----
  attributed_to?: string; // Customer-facing claim; "attributed_to" not "owns"
  enrichment?: ProEnrichment;
}

export interface ScanResponse {
  domains: DomainResult[];
  total: number;
  truncated: boolean;
  upgrade_hint?: string;
  // "warehouse" / "live" = legacy free-tier sources.
  // "cache-only" / "live-enriched" = Pro tier (Phase 5 orchestrator).
  source: "warehouse" | "live" | "cache-only" | "live-enriched";
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
          "Returns the organization(s) that own each domain, plus any " +
          "sibling domains in the warehouse owned by the same orgs. Max 10.",
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

// ---------- Shared utilities ----------

function getApiKey(): string {
  const key = process.env.CTSCOUT_API_KEY;
  if (!key || key.trim().length === 0) {
    throw new Error(
      "CTSCOUT_API_KEY environment variable is not set. " +
        "Get a free key at https://ctscout.dev (no email, no signup) and " +
        "set it via your MCP client config (e.g. for Claude Code, in " +
        "~/.claude/mcp.json under env.CTSCOUT_API_KEY).",
    );
  }
  return key;
}

interface ScanRequestBody {
  company_name?: string;
  seed_domain?: string[];
}

async function callScan(body: ScanRequestBody): Promise<ScanResponse> {
  const apiKey = getApiKey();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(SCAN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-API-Key": apiKey,
        "User-Agent": `${SERVER_NAME}/${SERVER_VERSION}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ApiError(response.status, await response.text());
    }

    return (await response.json()) as ScanResponse;
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

export function explainError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 400:
        return `Bad request: ${err.responseBody}. Check the input parameters.`;
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
        return `ctscout API error: HTTP ${err.status}: ${err.responseBody}`;
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

// Exported for tests. Renders both Free-tier and Pro-tier responses.
// Pro fields (confidence_band, evidence, matched_via) only render when
// present; Free responses use the original (domain, org, certs, subdomains) table.
export function formatScanAsMarkdown(query: string, response: ScanResponse): string {
  const lines: string[] = [];
  lines.push(`# ctscout results for: ${query}`);
  lines.push("");

  if (response.domains.length === 0) {
    lines.push(
      "No domains found. Try a partial company name (e.g. 'Goldman' instead of 'Goldman Sachs Group, Inc.') or a different domain.",
    );
    return lines.join("\n");
  }

  // Pro detection: prefer the explicit source signal, then fall back to
  // inspecting the rows. If the API returns `cache-only` / `live-enriched`
  // but every row is in the `_degraded()` path (no `enrichment` field),
  // we still want the Pro layout — losing it would make a Pro response
  // silently look like a Free response.
  const isPro =
    response.source === "live-enriched" ||
    response.source === "cache-only" ||
    response.domains.some((d) => d.enrichment != null);

  lines.push(
    `Returned **${response.domains.length}** domain(s) of ${response.total} total. ` +
      `Source: \`${response.source}\`${isPro ? " _(Pro tier — multi-signal attribution)_" : ""}.`,
  );
  if (response.truncated && response.upgrade_hint) {
    lines.push("");
    lines.push(`> ${response.upgrade_hint}`);
  }
  lines.push("");

  if (isPro) {
    lines.push(formatProTable(response.domains));
  } else {
    lines.push(formatFreeTable(response.domains));
  }

  return lines.join("\n");
}

function formatFreeTable(domains: DomainResult[]): string {
  const rows: string[] = [];
  rows.push("| Domain | Organization | Certs | Subdomains |");
  rows.push("|---|---|---:|---:|");
  for (const d of domains) {
    rows.push(
      `| \`${d.apex_domain}\` | ${d.org} | ${d.cert_count} | ${d.subdomain_count} |`,
    );
  }
  return rows.join("\n");
}

function formatProTable(domains: DomainResult[]): string {
  const rows: string[] = [];
  rows.push("| Domain | Attributed to | Band | Signals | Evidence |");
  rows.push("|---|---|---|---|---|");
  for (const d of domains) {
    const enriched = d.enrichment;
    if (enriched == null) {
      // Mixed-tier response (degraded apex from `_degraded()` in Pro /scan).
      rows.push(
        `| \`${d.apex_domain}\` | ${d.attributed_to ?? d.org} | _missing_ | — | — |`,
      );
      continue;
    }
    const bandEmoji = bandIndicator(enriched.confidence_band);
    const overrideTag = enriched.vlm_override ? " 🚫VLM-veto" : "";
    const signalSummary = enriched.matched_via.length
      ? enriched.matched_via.slice(0, 3).join(", ") +
        (enriched.matched_via.length > 3 ? `, +${enriched.matched_via.length - 3}` : "")
      : "_none_";
    const topEvidence = topEvidenceLine(enriched.evidence);
    rows.push(
      `| \`${d.apex_domain}\` | ${d.attributed_to ?? d.org} | ${bandEmoji} ${enriched.confidence_band}${overrideTag} | ${signalSummary} | ${topEvidence} |`,
    );
  }
  return rows.join("\n");
}

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
  const keys = Object.keys(evidence);
  if (keys.length === 0) return "_no evidence_";
  return escapeForTable(evidence[keys[0]]);
}

// Defensive: pipe AND any line terminator (CR, LF, CRLF) would break the
// markdown table. Replace pipes with backslash-pipe and any line terminator
// (or terminator pair) with a single space.
function escapeForTable(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

export function truncateIfNeeded(
  text: string,
  structured: ScanResponse,
): {
  text: string;
  structured: ScanResponse;
} {
  if (text.length <= CHARACTER_LIMIT) {
    return { text, structured };
  }
  // Halve domain list and re-render
  const halved = Math.max(1, Math.floor(structured.domains.length / 2));
  const truncated: ScanResponse = {
    ...structured,
    domains: structured.domains.slice(0, halved),
    truncated: true,
    upgrade_hint:
      `Response truncated to ${halved} of ${structured.domains.length} domains ` +
      `to stay under ${CHARACTER_LIMIT} chars. Re-run with response_format='json' ` +
      `or refine the query.`,
  };
  const newText = formatScanAsMarkdown("(truncated)", truncated);
  return { text: newText, structured: truncated };
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
  - Don't use when: You have a specific domain and want to find its owner — use ctscout_lookup_domain instead.

Auth & limits:
  - Requires CTSCOUT_API_KEY env var. Get a free key (no email) at https://ctscout.dev.
  - Free tier: 10 queries/day, top 5 results from weekly snapshot.
  - Pro tier: unlimited queries, full result set, live enrichment.

Error handling:
  - HTTP 401: API key missing or invalid.
  - HTTP 429: daily quota exceeded — wait or upgrade.
  - "No domains found": try a shorter or different company name.

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
        const text = JSON.stringify(data, null, 2);
        return {
          content: [{ type: "text", text }],
          structuredContent: data as unknown as Record<string, unknown>,
        };
      }

      const md = formatScanAsMarkdown(params.company_name, data);
      const { text, structured } = truncateIfNeeded(md, data);
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
  - When a domain IS in the warehouse but ownership is via subsidiary (e.g. an Allianz brand domain), the 'org' field shows the cert-subject organization which may differ from the brand on the homepage.

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
        const text = JSON.stringify(data, null, 2);
        return {
          content: [{ type: "text", text }],
          structuredContent: data as unknown as Record<string, unknown>,
        };
      }

      const md = formatScanAsMarkdown(params.domains.join(", "), data);
      const { text, structured } = truncateIfNeeded(md, data);
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
    console.error(
      err instanceof Error ? err.message : `Startup error: ${String(err)}`,
    );
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `${SERVER_NAME} v${SERVER_VERSION} running via stdio (api=${API_BASE_URL})`,
  );
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
    const argv1Real = realpathSync(process.argv[1]);
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
