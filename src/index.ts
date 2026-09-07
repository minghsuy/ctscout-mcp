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

export * from "./contract.js";

import {
  ApiError,
  type CtscoutApi,
  configuredApiKey,
  type DeepDiveSpec,
  ERROR_BODY_CAPTURE_LIMIT,
  getApiKey,
  type JobResponse,
  type JobSubmitResponse,
  type LeiNameMatches,
  type LeiRecord,
  REQUEST_TIMEOUT_MS,
  readBoundedText,
  registerCtscoutTools,
  type ScanBatchResponse,
  type ScanRequestBody,
  type ScanResponse,
  SERVER_NAME,
  TimeoutError,
  type VendorCustomers,
  type VendorSummary,
} from "./contract.js";

const API_BASE_URL = process.env.CTSCOUT_API_URL ?? "https://ctscout.dev";
const SCAN_URL = `${API_BASE_URL}/scan`;
const SCAN_BATCH_URL = `${API_BASE_URL}/scan/batch`;
const JOBS_URL = `${API_BASE_URL}/jobs`;
const LEI_URL = `${API_BASE_URL}/lei`;
const VENDORS_URL = `${API_BASE_URL}/vendors`;
// Exported so tests can pin SERVER_VERSION === package.json's version.
const require = createRequire(import.meta.url);
export const SERVER_VERSION = (require("../package.json") as { version: string }).version;
const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION}`;

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

/** The stdio host's binding of the contract to ctscout.dev. */
export const api: CtscoutApi = {
  scan: callScan,
  scanBatch: callScanBatch,
  submitJob: callSubmitJob,
  getJob: callGetJob,
  leiRecord: callLeiRecord,
  leiByName: callLeiByName,
  vendorSummary: callVendorSummary,
  vendorCustomers: callVendorCustomers,
};

/**
 * Build one stdio compatibility server.
 *
 * A factory keeps protocol tests isolated and makes the registered contract
 * inspectable without booting process-global stdio. Production still creates
 * exactly one instance below.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerCtscoutTools(server, api);
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
