/**
 * Tests for ctscout-mcp-server v0.2.0.
 *
 * Covers:
 *   - Free-tier response rendering (existing v0.1.0 shape unchanged)
 *   - Deep-dive band table rendering (confidence_band / evidence as the API reports them)
 *   - Degraded deep-dive rows (enrichment absent, band rendered as missing)
 *   - Empty-domains case
 *   - Truncation when over CHARACTER_LIMIT
 *   - Error explanation for each documented HTTP status
 *
 * Importing `../src/index.ts` requires CTSCOUT_API_KEY to be present at
 * import time only if `main()` runs. The module-level guard ensures it
 * doesn't auto-boot when imported here; we set the env var anyway as
 * a defense-in-depth measure (some downstream code may consult it).
 */

// Note: env vars are set in tests/setup.ts (vitest.config setupFiles)
// before any module imports happen — the `main()` boot guard in the
// MCP source code prevents auto-boot during tests, but downstream
// code (e.g. `getApiKey()` called from `callScan()`) reads
// CTSCOUT_API_KEY at call time, so we want it available even though
// these unit tests never make HTTP calls.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BatchResultItem,
  DomainResult,
  JobResponse,
  ScanBatchResponse,
  ScanResponse,
} from "../src/index.ts";
import {
  ApiError,
  callGetJob,
  callScan,
  callScanBatch,
  callSubmitJob,
  clampText,
  explainError,
  fairShareBudgets,
  formatBatchAsMarkdown,
  formatJobAsMarkdown,
  formatJobSubmittedAsMarkdown,
  formatScanAsMarkdown,
  GetJobInputSchema,
  getApiKey,
  resolveSnapshot,
  SERVER_VERSION,
  SearchCompanyBatchInputSchema,
  SubmitDeepDiveInputSchema,
  TimeoutError,
  truncateBatchJsonIfNeeded,
  truncateIfNeeded,
  truncateJobJsonIfNeeded,
  truncateJsonIfNeeded,
  truncateReceiptJsonIfNeeded,
} from "../src/index.ts";

// ---------- Fixtures ----------

function freeResponse(domains: DomainResult[] = []): ScanResponse {
  return {
    domains,
    total: domains.length,
    truncated: false,
    source: "warehouse",
  };
}

function proResponse(domains: DomainResult[] = []): ScanResponse {
  return {
    domains,
    total: domains.length,
    truncated: false,
    source: "live-enriched",
  };
}

// ---------- Free-tier rendering: existing v0.1.0 shape unchanged ----------

describe("getApiKey", () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.CTSCOUT_API_KEY;
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.CTSCOUT_API_KEY;
    } else {
      process.env.CTSCOUT_API_KEY = originalApiKey;
    }
  });

  it("returns the key when present and valid", () => {
    process.env.CTSCOUT_API_KEY = "valid_key_123";
    expect(getApiKey()).toBe("valid_key_123");
  });

  it("throws an error when the key is missing", () => {
    delete process.env.CTSCOUT_API_KEY;
    expect(() => getApiKey()).toThrowError(/CTSCOUT_API_KEY environment variable is not set/);
  });

  it("throws an error when the key is empty string", () => {
    process.env.CTSCOUT_API_KEY = "";
    expect(() => getApiKey()).toThrowError(/CTSCOUT_API_KEY environment variable is not set/);
  });

  it("throws an error when the key is only whitespace", () => {
    process.env.CTSCOUT_API_KEY = "   \n\t  ";
    expect(() => getApiKey()).toThrowError(/CTSCOUT_API_KEY environment variable is not set/);
  });
});

describe("formatScanAsMarkdown — free tier", () => {
  it("renders the legacy free-tier table when no Pro fields present", () => {
    const md = formatScanAsMarkdown(
      "Coalition Inc",
      freeResponse([
        {
          org: "Coalition Inc",
          apex_domain: "coalition.com",
          cert_count: 42,
          subdomain_count: 15,
        },
      ]),
    );
    expect(md).toContain("# ctscout results for: Coalition Inc");
    expect(md).toContain("Source: `warehouse`");
    expect(md).toContain("| Domain | Attributed to | Certs | Subdomains |");
    expect(md).toContain("| `coalition.com` | Coalition Inc | 42 | 15 |");
    // Pro tier marker MUST NOT appear in free-tier output
    expect(md).not.toContain("Pro tier");
    expect(md).not.toContain("confidence_band");
  });

  it("emits the empty-result hint when domains is []", () => {
    const md = formatScanAsMarkdown("Nonexistent Co", freeResponse([]));
    expect(md).toContain("No domains found");
    expect(md).toContain("Try a partial company name");
  });

  it("renders semantic candidates instead of replacing them with a generic empty result", () => {
    const md = formatScanAsMarkdown(
      "Acme",
      {
        domains: [],
        total: 0,
        source: "warehouse",
        match_type: "semantic",
        org_match_strategy: "semantic",
        empty_reason: "semantic_offered",
        candidates: [
          {
            org: "Acme Holdings, Inc.",
            similarity: 0.9123,
            top_apex_domain: "acme.example",
          },
          {
            org: "Acme Regional LLC",
            similarity: 0.734,
            top_apex_domain: null,
          },
          {
            org: "Malformed Similarity Co",
            similarity: Number.NaN,
            top_apex_domain: "malformed.example",
          },
        ],
      },
      { kind: "company" },
    );

    expect(md).toContain("No attributed OV/EV warehouse domains");
    expect(md).toContain("weak signal; corroborate before use");
    expect(md).toContain("| Candidate organization | Similarity | Top apex domain |");
    expect(md).toContain("| Acme Holdings, Inc. | 0.91 | acme.example |");
    expect(md).toContain("| Acme Regional LLC | 0.73 | — |");
    expect(md).toContain("| Malformed Similarity Co | — | malformed.example |");
    expect(md).not.toContain("Try one of these variants");
  });

  it("does not claim a size drop for a bare truncated flag without upgrade_hint", () => {
    // truncateWithRender always sets `truncated` AND `upgrade_hint` together,
    // so `truncated:true` alone (e.g. a hypothetical upstream count-cap) is
    // NOT our size-drop signal — it must fall through to "No domains found",
    // not emit the false "size limit" message with no blockquote.
    const resp: ScanResponse = {
      domains: [],
      total: 0,
      truncated: true,
      source: "warehouse",
    };
    const md = formatScanAsMarkdown("Nonexistent Co", resp, { kind: "company" });
    expect(md).toContain("No domains found");
    expect(md).not.toContain("size limit");
  });

  it("escapes markdown characters in domain and org fields to prevent injection", () => {
    const md = formatScanAsMarkdown(
      "Evil Inc",
      freeResponse([
        {
          org: "Evil Inc | injected column",
          apex_domain: "evil.com\nmalicious",
          cert_count: 1,
          subdomain_count: 0,
        },
      ]),
    );
    expect(md).toContain("| `evil.com malicious` | Evil Inc │ injected column | 1 | 0 |");
    expect(md).not.toContain("Evil Inc | injected column");
    expect(md).not.toContain("evil.com\nmalicious");
  });

  it("surfaces upgrade_hint when truncated", () => {
    const resp: ScanResponse = {
      domains: [{ org: "X", apex_domain: "x.com", cert_count: 1, subdomain_count: 1 }],
      total: 100,
      truncated: true,
      upgrade_hint: "Upgrade to Pro to see all 100 results.",
      source: "warehouse",
    };
    const md = formatScanAsMarkdown("X Corp", resp);
    expect(md).toContain("> Upgrade to Pro to see all 100 results.");
  });

  it("handles missing fields (undefined-cells bug) gracefully", () => {
    const md = formatScanAsMarkdown(
      "Missing Co",
      freeResponse([
        {
          // Intentional missing apex_domain, org, cert_count, subdomain_count
        },
      ]),
    );
    expect(md).not.toContain("undefined");
    expect(md).toContain("| `—` | — | — | — |");
  });

  it("maps a `domain` / `cert_org_names` row onto the warehouse table fields", () => {
    const md = formatScanAsMarkdown(
      "Origin Data",
      freeResponse([
        {
          // `domain` instead of apex_domain
          domain: "origindomain.com",
          // cert_org_names instead of org
          cert_org_names: ["Origin Org"],
        },
      ]),
    );
    expect(md).not.toContain("undefined");
    expect(md).toContain("| `origindomain.com` | Origin Org | — | — |");
  });
});

// ---------- Pro-tier rendering ----------

describe("formatScanAsMarkdown — Pro tier", () => {
  const verifiedRow: DomainResult = {
    org: "Coalition Inc",
    apex_domain: "coalition.com",
    cert_count: 42,
    subdomain_count: 15,
    attributed_to: "Coalition Inc",
    enrichment: {
      confidence_band: "verified",
      weight_total: 5.0,
      matched_via: ["dns_txt_brand_token", "og_site_name_match", "vlm_verdict_verified"],
      evidence: {
        dns_txt_brand_token: "verified via google-site-verification, atlassian-domain-verification",
        og_site_name_match: 'og:site_name="Coalition"',
        vlm_verdict_verified: "Logo and copyright text confirm Coalition brand",
      },
      signal_health: {
        rdap_registrant_match: "redacted",
        ip_asn_custom_org: "miss",
        vlm_verdict: "verified",
      },
      vlm_status: "cached",
      vlm_override: false,
    },
  };

  it("renders the Pro table with band, signals, evidence", () => {
    const md = formatScanAsMarkdown("Coalition Inc", proResponse([verifiedRow]));
    expect(md).toContain("Source: `live-enriched` _(Pro tier — multi-signal attribution)_");
    expect(md).toContain("| Domain | Attributed to | Band | Signals | Evidence |");
    expect(md).toContain("✅ verified");
    expect(md).toContain("Coalition Inc");
    // Should prefer DNS brand token in the evidence column (highest priority)
    expect(md).toContain("verified via google-site-verification");
    // matched_via shows up to 3, comma-separated
    expect(md).toContain("dns_txt_brand_token, og_site_name_match, vlm_verdict_verified");
  });

  it("handles missing fields in the deep-dive table gracefully", () => {
    const md = formatScanAsMarkdown(
      "Missing Pro Co",
      proResponse([
        {
          // Intentional missing apex_domain, org, attributed_to
          enrichment: {
            confidence_band: "insufficient",
            weight_total: 0.0,
            matched_via: [],
            evidence: {},
            signal_health: {},
            vlm_status: "skipped",
            vlm_override: false,
          },
        },
      ]),
    );
    expect(md).not.toContain("undefined");
    // cellSafe of undefined should output "—" for Domain and Attributed to columns
    expect(md).toContain("| `—` | — | ⚪ insufficient | _none_ | _no evidence_ |");
  });

  it("falls back to cert_org_names / rdap_org in the deep-dive table", () => {
    const md = formatScanAsMarkdown(
      "Missing Pro Co",
      proResponse([
        {
          apex_domain: "origin-pro.com",
          domain: "origin-pro.com",
          rdap_org: "Origin RDAP Org",
          enrichment: {
            confidence_band: "insufficient",
            weight_total: 0.0,
            matched_via: [],
            evidence: {},
            signal_health: {},
            vlm_status: "skipped",
            vlm_override: false,
          },
        },
      ]),
    );
    expect(md).not.toContain("undefined");
    expect(md).toContain(
      "| `origin-pro.com` | Origin RDAP Org | ⚪ insufficient | _none_ | _no evidence_ |",
    );
  });

  it("handles missing fields in a degraded deep-dive table gracefully", () => {
    const md = formatScanAsMarkdown(
      "Missing Pro Co",
      proResponse([
        {
          // Intentional missing apex_domain, org, attributed_to, enrichment
        },
      ]),
    );
    expect(md).not.toContain("undefined");
    expect(md).toContain("| `—` | — | _missing_ | — | — |");
  });

  it("falls back to cert_org_names / rdap_org in a degraded deep-dive table", () => {
    const md = formatScanAsMarkdown(
      "Missing Pro Co",
      proResponse([
        {
          apex_domain: "origin-pro-degraded.com",
          domain: "origin-pro-degraded.com",
          cert_org_names: ["Origin Cert Org"],
        },
      ]),
    );
    expect(md).not.toContain("undefined");
    expect(md).toContain("| `origin-pro-degraded.com` | Origin Cert Org | _missing_ | — | — |");
  });

  it("escapes markdown characters in domain and attributed_to fields in Pro table", () => {
    const evilRow: DomainResult = {
      ...verifiedRow,
      apex_domain: "evil.com|x",
      attributed_to: "Evil Inc\ncorp",
    };

    const md = formatScanAsMarkdown("Evil Inc", proResponse([evilRow]));
    expect(md).toContain(
      "| `evil.com│x` | Evil Inc corp | ✅ verified | dns_txt_brand_token, og_site_name_match, vlm_verdict_verified | verified via google-site-verification, atlassian-domain-verification |",
    );
  });

  it("marks vlm_override=true with a 🚫VLM-veto tag", () => {
    const row: DomainResult = {
      ...verifiedRow,
      enrichment: {
        ...verifiedRow.enrichment!,
        confidence_band: "insufficient",
        matched_via: ["dns_txt_brand_token", "vlm_verdict_no"],
        evidence: {
          dns_txt_brand_token: "verified via google-site-verification",
          vlm_verdict_no: "Logo on screenshot is a different brand",
        },
        signal_health: { vlm_verdict: "no" },
        vlm_override: true,
      },
    };
    const md = formatScanAsMarkdown("Imposter Inc", proResponse([row]));
    expect(md).toContain("⚪ insufficient");
    expect(md).toContain("🚫VLM-veto");
  });

  it("shows '+N' when matched_via has more than 3 signals", () => {
    const row: DomainResult = {
      ...verifiedRow,
      enrichment: {
        ...verifiedRow.enrichment!,
        matched_via: ["a", "b", "c", "d", "e"],
      },
    };
    const md = formatScanAsMarkdown("Test", proResponse([row]));
    expect(md).toContain("a, b, c, +2");
  });

  it("falls back to '_none_' when no signals matched", () => {
    const row: DomainResult = {
      ...verifiedRow,
      enrichment: {
        ...verifiedRow.enrichment!,
        confidence_band: "insufficient",
        matched_via: [],
        evidence: {},
      },
    };
    const md = formatScanAsMarkdown("Test", proResponse([row]));
    expect(md).toContain("_none_");
    expect(md).toContain("_no evidence_");
  });

  it("handles mixed-tier responses (some rows enriched, some _degraded)", () => {
    // A degraded deep-dive row carries no enrichment field
    const degradedRow: DomainResult = {
      org: "Test Co",
      apex_domain: "broken.example",
      cert_count: 0,
      subdomain_count: 0,
      attributed_to: "Test Co",
      // No enrichment field — degraded path
    };
    const md = formatScanAsMarkdown("Test Co", proResponse([verifiedRow, degradedRow]));
    // Both rows present; the degraded one uses _missing_ band
    expect(md).toContain("`coalition.com`");
    expect(md).toContain("`broken.example`");
    expect(md).toContain("_missing_");
  });

  it("escapes pipes in evidence values so they don't break the table", () => {
    const row: DomainResult = {
      ...verifiedRow,
      enrichment: {
        ...verifiedRow.enrichment!,
        evidence: {
          dns_txt_brand_token: "verified | including spurious | pipe characters",
        },
      },
    };
    const md = formatScanAsMarkdown("Test", proResponse([row]));
    // Pipe inside the cell must be escaped
    expect(md).toContain("verified \\| including spurious \\| pipe characters");
  });

  it("replaces CR / LF / CRLF in evidence with a single space", () => {
    // Markdown tables break on any line terminator inside a cell.
    const row: DomainResult = {
      ...verifiedRow,
      enrichment: {
        ...verifiedRow.enrichment!,
        evidence: {
          dns_txt_brand_token: "line one\r\nline two\nline three\rline four",
        },
      },
    };
    const md = formatScanAsMarkdown("Test", proResponse([row]));
    // All terminators collapsed to single spaces; no CR or LF remains in the cell
    expect(md).toContain("line one line two line three line four");
    // Make sure no stray \r leaked through (which some MD renderers treat as <br>)
    const tableRowMatch = md.match(/\| `coalition.com` \|[^\n]*/);
    expect(tableRowMatch).toBeTruthy();
    expect(tableRowMatch?.[0] ?? "").not.toContain("\r");
  });

  it("falls back to first dict key when evidence has no EVIDENCE_PRIORITY match", () => {
    const row: DomainResult = {
      ...verifiedRow,
      enrichment: {
        ...verifiedRow.enrichment!,
        evidence: { unknown_signal: "some evidence value" },
      },
    };
    const md = formatScanAsMarkdown("Test", proResponse([row]));
    expect(md).toContain("some evidence value");
  });

  it("detects Pro response by source even when all rows are degraded", () => {
    // A degraded deep-dive row carries no `enrichment` field
    // when a per-apex enrichment fails. If every row is in that state,
    // `domains.some(d => d.enrichment != null)` is false — but the API
    // declared this a Pro response via `source: "live-enriched"`. We
    // must render the Pro layout regardless, so customers see the
    // attribution column + the degraded-row indicator.
    const allDegraded: ScanResponse = {
      domains: [
        {
          org: "Coalition Inc",
          apex_domain: "coalition.com",
          cert_count: 0,
          subdomain_count: 0,
          attributed_to: "Coalition Inc",
          // no enrichment — degraded
        },
        {
          org: "Coalition Inc",
          apex_domain: "coalition.io",
          cert_count: 0,
          subdomain_count: 0,
          attributed_to: "Coalition Inc",
          // no enrichment — degraded
        },
      ],
      total: 2,
      truncated: false,
      source: "live-enriched",
    };
    const md = formatScanAsMarkdown("Coalition Inc", allDegraded);
    // The Pro badge must appear despite zero rows with enrichment
    expect(md).toContain("_(Pro tier — multi-signal attribution)_");
    // The 5-column Pro header
    expect(md).toContain("| Domain | Attributed to | Band | Signals | Evidence |");
    // Both rows show the _missing_ band marker (degraded-row indicator)
    expect((md.match(/_missing_/g) ?? []).length).toBe(2);
  });

  it("also detects Pro by source='cache-only' with all rows degraded", () => {
    const cacheOnlyDegraded: ScanResponse = {
      domains: [
        {
          org: "Coalition Inc",
          apex_domain: "coalition.com",
          cert_count: 0,
          subdomain_count: 0,
        },
      ],
      total: 1,
      truncated: false,
      source: "cache-only",
    };
    const md = formatScanAsMarkdown("Coalition Inc", cacheOnlyDegraded);
    expect(md).toContain("_(Pro tier — multi-signal attribution)_");
  });

  it("renders all four confidence-band indicators correctly", () => {
    const bands = ["verified", "likely", "possible", "insufficient"] as const;
    const expected = ["✅", "🟢", "🟡", "⚪"];
    for (let i = 0; i < bands.length; i++) {
      const row: DomainResult = {
        ...verifiedRow,
        enrichment: { ...verifiedRow.enrichment!, confidence_band: bands[i] },
      };
      const md = formatScanAsMarkdown("Test", proResponse([row]));
      expect(md).toContain(`${expected[i]} ${bands[i]}`);
    }
  });
});

// ---------- Truncation ----------

describe("truncateIfNeeded", () => {
  it("returns the original text when under the limit", () => {
    const resp = freeResponse([
      { org: "X", apex_domain: "x.com", cert_count: 1, subdomain_count: 1 },
    ]);
    const md = formatScanAsMarkdown("X", resp);
    const result = truncateIfNeeded(md, resp, "X");
    expect(result.text).toBe(md);
    expect(result.structured.truncated).toBe(false);
  });

  it("halves the list and re-renders when text exceeds the limit", () => {
    // Build a Pro response that fits the typical multi-halve recovery
    // case (truncateIfNeeded is now iterative, halving until under the limit).
    // Each row is ~100 chars; 250 rows ≈ 25k chars in pre-trunc text,
    // halved to 125 ≈ 12.5k.
    const domains: DomainResult[] = Array.from({ length: 350 }, (_, i) => ({
      org: `Org ${i}`,
      apex_domain: `domain-${i}.example`,
      cert_count: i,
      subdomain_count: i,
      attributed_to: `Org ${i}`,
      enrichment: {
        confidence_band: "verified",
        weight_total: 5.0,
        matched_via: ["dns_txt_brand_token"],
        evidence: { dns_txt_brand_token: "evidence" },
        signal_health: {},
        vlm_status: "cached",
        vlm_override: false,
      },
    }));
    const resp = proResponse(domains);
    const md = formatScanAsMarkdown("X", resp);
    expect(md.length).toBeGreaterThan(25_000); // sanity: pre-trunc IS over
    const result = truncateIfNeeded(md, resp, "X");
    expect(result.text.length).toBeLessThanOrEqual(25_000);
    expect(result.structured.truncated).toBe(true);
    expect(result.structured.domains.length).toBeLessThan(domains.length);
    expect(result.structured.upgrade_hint).toContain("Response truncated");
  });

  it("caps an oversized evidence cell so a single domain can never exceed the limit", () => {
    // Every API-provided string the renderer prints is capped, so a 1-domain
    // response stays under budget whatever the evidence string holds.
    const bigEvidence = "x".repeat(30_000);
    const domain: DomainResult = {
      org: "Big Co",
      apex_domain: "big.example",
      cert_count: 1,
      subdomain_count: 0,
      attributed_to: "Big Co",
      enrichment: {
        confidence_band: "verified",
        weight_total: 5.0,
        matched_via: ["dns_txt_brand_token"],
        evidence: { dns_txt_brand_token: bigEvidence },
        signal_health: {},
        vlm_status: "cached",
        vlm_override: false,
      },
    };
    const resp = proResponse([domain]);
    const md = formatScanAsMarkdown("Big Co", resp);
    expect(md.length).toBeLessThanOrEqual(25_000);
    expect(md).toContain(`| ${"x".repeat(79)}… |`);
    const result = truncateIfNeeded(md, resp, "Big Co");
    expect(result.text).toBe(md);
    expect(result.structured.domains.length).toBe(1);
    expect(result.structured.truncated).toBe(false);
  });

  it("no longer recommends response_format='json' as the size escape hatch (#42)", () => {
    const resp = proResponse(
      Array.from({ length: 350 }, (_, i) => ({
        org: `Org ${i}`,
        apex_domain: `domain-${i}.example`,
        cert_count: i,
        subdomain_count: i,
        attributed_to: `Org ${i}`,
        enrichment: {
          confidence_band: "verified" as const,
          weight_total: 5.0,
          matched_via: ["dns_txt_brand_token"],
          evidence: { dns_txt_brand_token: "evidence" },
          signal_health: {},
          vlm_status: "cached" as const,
          vlm_override: false,
        },
      })),
    );
    const md = formatScanAsMarkdown("Big Co", resp);
    const result = truncateIfNeeded(md, resp, "Big Co");
    expect(result.structured.truncated).toBe(true);
    expect(result.structured.upgrade_hint).not.toContain("response_format='json'");
    expect(result.structured.upgrade_hint).toContain("Refine the query");
  });

  it("preserves the original query + a real hint in the truncated re-render (#41)", () => {
    // Multi-halve case: re-render must keep the header query and the
    // upgrade_hint, not fall back to the old `# ctscout results for: (truncated)`.
    const domains: DomainResult[] = Array.from({ length: 350 }, (_, i) => ({
      org: `Org ${i}`,
      apex_domain: `domain-${i}.example`,
      cert_count: i,
      subdomain_count: i,
      attributed_to: `Org ${i}`,
      enrichment: {
        confidence_band: "verified",
        weight_total: 5.0,
        matched_via: ["dns_txt_brand_token"],
        evidence: { dns_txt_brand_token: "evidence" },
        signal_health: {},
        vlm_status: "cached",
        vlm_override: false,
      },
    }));
    const resp = proResponse(domains);
    const md = formatScanAsMarkdown("Acme Corp", resp);
    expect(md.length).toBeGreaterThan(25_000); // sanity: pre-trunc IS over
    const result = truncateIfNeeded(md, resp, "Acme Corp");
    // Header keeps the query, not the dropped "(truncated)" placeholder.
    expect(result.text).toContain("# ctscout results for: Acme Corp");
    expect(result.text).not.toContain("(truncated)");
    // The hint that survives into the text is the upgrade_hint, not FormatHint.
    expect(result.text).toContain("Response truncated");
  });

  it("markdown text explains the size-based drop (not 'No domains found') when domains were zeroed (#41 fold-in)", () => {
    // The zeroed structure (domains: [], truncated, our hint) is what the
    // JSON halving loop can still produce for a single over-budget domain;
    // rendered, it must NOT say "No domains found" but explain the size drop
    // and surface the upgrade_hint.
    const zeroed: ScanResponse = {
      ...proResponse([]),
      truncated: true,
      upgrade_hint: "Response truncated to 0 of 1 domains to stay under 25000 chars.",
    };
    const text = formatScanAsMarkdown("Big Co", zeroed);
    expect(text).not.toContain("No domains found");
    expect(text).toContain("# ctscout results for: Big Co");
    expect(text).toContain("size limit");
    expect(text).toContain("dropped");
    expect(text).toContain("Response truncated");
  });
});

// ---------- JSON-format truncation (ctscout-mcp#42) ----------

describe("truncateJsonIfNeeded", () => {
  it("returns pretty-printed JSON unchanged when under the limit", () => {
    const resp = freeResponse([
      { org: "X", apex_domain: "x.com", cert_count: 1, subdomain_count: 1 },
    ]);
    const result = truncateJsonIfNeeded(resp);
    expect(result.text).toBe(JSON.stringify(resp, null, 2));
    expect(result.structured).toBe(resp);
    expect(result.structured.truncated).toBe(false);
  });

  it("falls back to compact stringify without dropping domains when that alone fits", () => {
    const domains: DomainResult[] = Array.from({ length: 220 }, (_, i) => ({
      org: `Org ${i}`,
      apex_domain: `domain-${i}.example`,
      cert_count: i,
      subdomain_count: i,
    }));
    const resp = freeResponse(domains);
    // Sanity: pretty form is over the limit, compact form is under.
    expect(JSON.stringify(resp, null, 2).length).toBeGreaterThan(25_000);
    expect(JSON.stringify(resp).length).toBeLessThanOrEqual(25_000);

    const result = truncateJsonIfNeeded(resp);
    expect(result.text).toBe(JSON.stringify(resp));
    expect(result.text.length).toBeLessThanOrEqual(25_000);
    expect(result.structured.domains.length).toBe(220);
    expect(result.structured.truncated).toBe(false);
  });

  it("halves domains when even compact JSON exceeds the limit, staying valid JSON", () => {
    const domains: DomainResult[] = Array.from({ length: 300 }, (_, i) => ({
      org: `Org ${i} ${"x".repeat(150)}`,
      apex_domain: `domain-${i}.example`,
      cert_count: i,
      subdomain_count: i,
    }));
    const resp = freeResponse(domains);
    // Sanity: even the compact form is over the limit.
    expect(JSON.stringify(resp).length).toBeGreaterThan(25_000);

    const result = truncateJsonIfNeeded(resp);
    expect(result.text.length).toBeLessThanOrEqual(25_000);
    expect(result.structured.truncated).toBe(true);
    expect(result.structured.domains.length).toBeLessThan(300);
    expect(result.structured.domains.length).toBeGreaterThan(0);

    // Emitted text is valid JSON and self-describes the truncation.
    const parsed = JSON.parse(result.text) as ScanResponse;
    expect(parsed.truncated).toBe(true);
    expect(parsed.upgrade_hint).toContain("Response truncated");
    expect(parsed.upgrade_hint).not.toContain("response_format='json'");
    expect(parsed.domains.length).toBe(result.structured.domains.length);
  });

  it("zeroes out domains when a single domain still exceeds the limit", () => {
    const resp = freeResponse([
      {
        org: "Big Co",
        apex_domain: "big.example",
        cert_count: 1,
        subdomain_count: 0,
        notes: "x".repeat(30_000),
      },
    ]);
    const result = truncateJsonIfNeeded(resp);
    expect(result.text.length).toBeLessThanOrEqual(25_000);
    expect(result.structured.domains.length).toBe(0);
    expect(result.structured.truncated).toBe(true);
    expect(result.structured.upgrade_hint).toContain("0 of 1 domains");
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  it("emits a minimal valid envelope when top-level fields alone exceed the limit", () => {
    const resp: ScanResponse = {
      domains: [],
      total: 0,
      source: "warehouse",
      match_type: "semantic",
      org_match_strategy: "semantic",
      empty_reason: "semantic_offered",
      candidates: [
        {
          org: "Candidate Co",
          similarity: 0.9,
          top_apex_domain: "candidate.example",
        },
      ],
      run_metadata: { blob: "x".repeat(30_000) },
    };
    const result = truncateJsonIfNeeded(resp);
    expect(result.text.length).toBeLessThanOrEqual(25_000);
    const parsed = JSON.parse(result.text) as ScanResponse;
    expect(parsed.domains).toEqual([]);
    expect(parsed.truncated).toBe(true);
    expect(parsed.upgrade_hint).toContain("Response truncated");
    expect(parsed.source).toBe("warehouse");
    expect(parsed.match_type).toBe("semantic");
    expect(parsed.org_match_strategy).toBe("semantic");
    expect(parsed.empty_reason).toBe("semantic_offered");
    expect(parsed.candidates).toEqual([]);
    expect(parsed.upgrade_hint).toContain("0 of 1 semantic candidates");
    expect(parsed.upgrade_hint).not.toContain("0 of 0 domains");
  });

  it("bounds the known strings the minimal envelope keeps", () => {
    const result = truncateJsonIfNeeded({
      domains: [],
      source: "s".repeat(30_000),
      match_type: "none",
      empty_reason: "r".repeat(30_000),
    } as ScanResponse);
    expect(result.text.length).toBeLessThanOrEqual(25_000);
    const parsed = JSON.parse(result.text) as ScanResponse;
    expect(parsed.truncated).toBe(true);
    expect(parsed.match_type).toBe("none");
    expect(parsed.source).toMatch(/^s{200}…\(truncated, 30000 chars total\)$/);
    expect(parsed.empty_reason).toMatch(/^r{200}…\(truncated, 30000 chars total\)$/);
  });
});

// ---------- Error explanation ----------

describe("explainError", () => {
  it("maps 401 to a clear API-key message", () => {
    const msg = explainError(new ApiError(401, "Unauthorized"));
    expect(msg).toContain("Invalid or missing CTSCOUT_API_KEY");
    expect(msg).toContain("https://ctscout.dev");
  });

  it("maps 429 to a quota-exceeded message", () => {
    const msg = explainError(new ApiError(429, "Quota"));
    expect(msg).toContain("Daily request quota exceeded");
    expect(msg).toContain("Upgrade to pro");
  });

  it("maps 400 to a bad-request message including the body", () => {
    const msg = explainError(new ApiError(400, "Invalid company_name"));
    expect(msg).toContain("Bad request");
    expect(msg).toContain("Invalid company\\_name");
  });

  it("escapes markdown characters in 400 response body to prevent injection", () => {
    const maliciousBody =
      "Error `code` with [link](https://evil.com) and ![img](foo) and _italic_ and *bold*";
    const msg = explainError(new ApiError(400, maliciousBody));
    expect(msg).toContain("Bad request");
    expect(msg).not.toContain("`code`");
    expect(msg).not.toContain("[link]");
    expect(msg).not.toContain("![img]");
    // Check that characters were escaped
    expect(msg).toContain("\\`code\\`");
    expect(msg).toContain("\\[link\\]\\(https://evil.com\\)");
    expect(msg).toContain("\\!\\[img\\]\\(foo\\)");
    expect(msg).toContain("\\_italic\\_");
    expect(msg).toContain("\\*bold\\*");
  });

  it("escapes markdown characters in default API error response body", () => {
    const maliciousBody = "Unknown error <script>alert(1)</script> [link](x)";
    const msg = explainError(new ApiError(418, maliciousBody));
    expect(msg).toContain("HTTP 418");
    expect(msg).not.toContain("<script>");
    expect(msg).not.toContain("[link]");
    expect(msg).toContain("\\<script\\>alert\\(1\\)\\</script\\>");
    expect(msg).toContain("\\[link\\]\\(x\\)");
  });

  it("maps 403 to a revoked-key message", () => {
    const msg = explainError(new ApiError(403, "Forbidden"));
    expect(msg).toContain("revoked");
    expect(msg).toContain("https://ctscout.dev");
  });

  it("maps 5xx to a server-error message with retry guidance", () => {
    const msg = explainError(new ApiError(503, "Service Unavailable"));
    expect(msg).toContain("ctscout server error");
    expect(msg).toContain("503");
  });

  it("maps timeout to a timeout message", () => {
    const msg = explainError(new TimeoutError());
    expect(msg).toContain("timed out");
  });

  it("preserves CTSCOUT_API_KEY missing message verbatim", () => {
    const err = new Error("CTSCOUT_API_KEY environment variable is not set. ...");
    const msg = explainError(err);
    expect(msg).toBe(err.message);
  });

  it("falls back to generic message for unexpected errors", () => {
    const msg = explainError(new Error("Boom"));
    expect(msg).toContain("Unexpected error: Boom");
  });

  it("handles non-Error throws", () => {
    const msg = explainError("string error");
    expect(msg).toContain("Unexpected error: string error");
  });

  it("truncates an oversized 400 response body with a marker", () => {
    const msg = explainError(new ApiError(400, "x".repeat(30_000)));
    expect(msg.length).toBeLessThan(1_000);
    expect(msg).toContain("Bad request");
    expect(msg).toContain("truncated, 30000 chars total");
  });

  it("truncates an oversized body on the default branch (unmapped status)", () => {
    const msg = explainError(new ApiError(418, "y".repeat(30_000)));
    expect(msg.length).toBeLessThan(1_000);
    expect(msg).toContain("HTTP 418");
    expect(msg).toContain("truncated, 30000 chars total");
  });

  it("truncates before escaping: marker reports raw length and escape expansion stays bounded", () => {
    // 30k backticks: escaping doubles each char. If escaping ran first,
    // the marker would report 60000 chars; truncate-first reports 30000
    // and the escaped excerpt is at most 2x the 500-char cap.
    const msg = explainError(new ApiError(400, "`".repeat(30_000)));
    expect(msg).toContain("truncated, 30000 chars total");
    expect(msg).toContain("\\`");
    expect(msg.length).toBeLessThan(1_200);
  });

  it("leaves a small response body untouched (no marker)", () => {
    const msg = explainError(new ApiError(400, "short and sweet"));
    expect(msg).toContain("short and sweet");
    expect(msg).not.toContain("truncated");
  });
});

// ---------- legal-entity did-you-mean suggestions ----------
//
// The cert subject O field uses legal entity names, not brand names. Searches
// for brand-shaped inputs like "Travelers Insurance" return 0 while the data
// is in the warehouse under "The Travelers Companies, Inc." The formatter
// appends a static "did you mean?" suggestion block on empty results when
// the caller flags the query as a company-name (search_company tool path).
// Skipped for already-legal-shaped inputs and for the domain-list path
// (lookup_domain, kind: "domain").

describe("formatScanAsMarkdown - legal-entity did-you-mean suggestions", () => {
  it("brand-name input on empty result emits suggestions", () => {
    const md = formatScanAsMarkdown("Travelers Insurance", freeResponse([]), {
      kind: "company",
    });
    expect(md).toContain("No domains found");
    // Base variants
    expect(md).toContain("• Travelers Insurance Companies");
    expect(md).toContain("• Travelers Insurance Company");
    expect(md).toContain("• Travelers Insurance Group");
    expect(md).toContain("• The Travelers Insurance");
    // Does not include fallback block since "Insurance" is already in input
    expect(md).not.toContain("Or, if this is a financial/insurance brand:");
  });

  it("non-financial brand-name input emits base suggestions and financial fallback", () => {
    const md = formatScanAsMarkdown("Spotify", freeResponse([]), {
      kind: "company",
    });
    expect(md).toContain("No domains found");
    expect(md).toContain("• Spotify Companies");
    expect(md).toContain("• Spotify Company");
    expect(md).toContain("• Spotify Group");
    expect(md).toContain("• The Spotify");
    expect(md).toContain("Or, if this is a financial/insurance brand:");
    expect(md).toContain("• Spotify Insurance Company");
  });

  it("short financial brand-name input emits both base and financial fallback", () => {
    const md = formatScanAsMarkdown("Travelers", freeResponse([]), {
      kind: "company",
    });
    expect(md).toContain("No domains found");
    // Base variants
    expect(md).toContain("• Travelers Companies");
    expect(md).toContain("• Travelers Company");
    expect(md).toContain("• Travelers Group");
    expect(md).toContain("• The Travelers");
    // Financial/insurance fallback block
    expect(md).toContain("Or, if this is a financial/insurance brand:");
    expect(md).toContain("• Travelers Insurance Company");
    expect(md).toContain("• Travelers Financial Services Group");
    expect(md).toContain("• The Travelers Financial Services Group, Inc.");
  });

  it("legal-entity-shaped input skips suggestions", () => {
    // Cover every suffix in the LEGAL_ENTITY_SUFFIXES regex including the
    // less-obvious ones (Co, SA, Holding singular) to guard against
    // someone tweaking the regex and silently breaking the skip.
    for (const suffix of [
      "Inc",
      "Corp",
      "Corporation",
      "Group",
      "Companies",
      "Company",
      "Co",
      "Ltd",
      "LLC",
      "L.L.C.",
      "AG",
      "SA",
      "S.A.",
      "N.V.",
      "plc",
      "GmbH",
      "Holding",
      "Holdings",
    ]) {
      const md = formatScanAsMarkdown(`Acme ${suffix}`, freeResponse([]), {
        kind: "company",
      });
      expect(md, `suffix=${suffix}`).toContain("No domains found");
      expect(md, `suffix=${suffix}`).not.toContain("Try one of these variants");
    }
  });

  it("lookup_domain (kind: 'domain') skips suggestions", () => {
    const md = formatScanAsMarkdown("travelers.com", freeResponse([]), {
      kind: "domain",
    });
    expect(md).toContain("No domains found");
    expect(md).not.toContain("Try one of these variants");
  });

  it("no hint skips suggestions (backwards compat)", () => {
    const md = formatScanAsMarkdown("Travelers Insurance", freeResponse([]));
    expect(md).toContain("No domains found");
    expect(md).not.toContain("Try one of these variants");
  });

  it("empty / whitespace query skips suggestions", () => {
    const a = formatScanAsMarkdown("", freeResponse([]), { kind: "company" });
    expect(a).not.toContain("Try one of these variants");
    const b = formatScanAsMarkdown("   ", freeResponse([]), {
      kind: "company",
    });
    expect(b).not.toContain("Try one of these variants");
  });

  it("non-empty result with brand-name query does NOT emit suggestions", () => {
    const md = formatScanAsMarkdown(
      "Acme Brand",
      freeResponse([
        {
          org: "Acme",
          apex_domain: "acme.com",
          cert_count: 1,
          subdomain_count: 0,
        },
      ]),
      { kind: "company" },
    );
    expect(md).toContain("acme.com");
    expect(md).not.toContain("Try one of these variants");
  });

  it("Hartford Financial case from the bug report", () => {
    const md = formatScanAsMarkdown("Hartford Financial", freeResponse([]), {
      kind: "company",
    });
    expect(md).toContain("• Hartford Financial Companies");
    expect(md).toContain("• The Hartford Financial");
    // "Financial" keyword suppresses the financial/insurance fallback block
    expect(md).not.toContain("Or, if this is a financial/insurance brand:");
  });

  it("suggestion block lists base variants and fallback", () => {
    const md = formatScanAsMarkdown("Foo", freeResponse([]), {
      kind: "company",
    });
    const bullets = md.split("\n").filter((l) => l.startsWith("  •"));
    expect(bullets).toHaveLength(9); // 6 base + 3 financial
  });

  it("case-insensitive suffix detection", () => {
    const a = formatScanAsMarkdown("Acme INC", freeResponse([]), {
      kind: "company",
    });
    expect(a).not.toContain("Try one of these variants");
    const b = formatScanAsMarkdown("Acme corporation", freeResponse([]), {
      kind: "company",
    });
    expect(b).not.toContain("Try one of these variants");
  });
});

describe("callScan", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.CTSCOUT_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.CTSCOUT_API_KEY;
    } else {
      process.env.CTSCOUT_API_KEY = originalApiKey;
    }
  });

  it("successfully fetches data and returns JSON", async () => {
    process.env.CTSCOUT_API_KEY = "test-key";
    const mockResponse: ScanResponse = { domains: [] };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    } as Response);

    const result = await callScan({ company_name: "Test" });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/scan"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "test-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ company_name: "Test" }),
      }),
    );
    expect(result).toEqual(mockResponse);
  });

  it("throws error if CTSCOUT_API_KEY is not set", async () => {
    delete process.env.CTSCOUT_API_KEY;
    await expect(callScan({ company_name: "Test" })).rejects.toThrow(
      "CTSCOUT_API_KEY environment variable is not set",
    );
  });

  it("throws error if CTSCOUT_API_KEY is empty", async () => {
    process.env.CTSCOUT_API_KEY = "   ";
    await expect(callScan({ company_name: "Test" })).rejects.toThrow(
      "CTSCOUT_API_KEY environment variable is not set",
    );
  });

  it("throws ApiError if fetch responds with non-200 status", async () => {
    process.env.CTSCOUT_API_KEY = "test-key";
    // A real Response gives `readBoundedText` an actual ReadableStream
    // body, exercising the bounded-reader path (not just the response.text()
    // fallback) for the common case of a small error body.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    let caughtError: unknown;
    try {
      await callScan({ company_name: "Test" });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ApiError);
    expect((caughtError as ApiError).status).toBe(401);
    expect((caughtError as ApiError).responseBody).toBe("Unauthorized");
  });

  it("bounds an oversized error body captured from the response stream (#57)", async () => {
    process.env.CTSCOUT_API_KEY = "test-key";
    // 200,000 bytes is far larger than any reasonable capture cap; if
    // callScan still buffered this via response.text() before bounding,
    // this would pass too (only stream inspection or memory profiling
    // would catch that) — the assertion below is on the *result*: the
    // captured responseBody must be bounded, not on how it was captured.
    const hugeBody = "e".repeat(200_000);
    // status 400 (not 5xx) so explainError's body-including branch runs
    // below and actually exercises the #56/#57 interplay, rather than
    // hitting a branch that ignores responseBody entirely.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(hugeBody, { status: 400 }));

    let caughtError: unknown;
    try {
      await callScan({ company_name: "Test" });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ApiError);
    expect((caughtError as ApiError).status).toBe(400);
    const captured = (caughtError as ApiError).responseBody;
    expect(captured.length).toBeLessThan(hugeBody.length);
    expect(captured.length).toBeLessThanOrEqual(4096);
    // Still renders through explainError with a truncation marker: the
    // render-time bound from #56 (truncateBody, 500 chars) applies on top
    // of the capture-time bound from #57 (4096 bytes) — the marker's
    // "chars total" reflects the captured (already-clamped) length, not
    // the original 200,000-byte body, since capture already discarded the
    // rest.
    const msg = explainError(caughtError);
    expect(msg).toContain("Bad request");
    expect(msg).toContain(`truncated, ${captured.length} chars total`);
  });

  it("handles a body-less error response without throwing", async () => {
    process.env.CTSCOUT_API_KEY = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      body: null,
      text: async () => "",
    } as unknown as Response);

    let caughtError: unknown;
    try {
      await callScan({ company_name: "Test" });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ApiError);
    expect((caughtError as ApiError).status).toBe(503);
    expect((caughtError as ApiError).responseBody).toBe("");
  });

  it("throws TimeoutError if fetch throws AbortError", async () => {
    process.env.CTSCOUT_API_KEY = "test-key";

    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    await expect(callScan({ company_name: "Test" })).rejects.toThrowError(TimeoutError);
  });
});

// ---------- Markdown-escaping chokepoint guard ----------
//
// Regression lock for the three recurrences of markdown injection seen in
// PRs #21 / #23 / #27. Every user/API-derived value that reaches a markdown
// table cell MUST be routed through an escape helper. This suite feeds pipe
// (|), backtick (`), hash (#), and newline (\n / \r) through every formatter
// path and asserts the dangerous chars are neutralised so they cannot:
//   - inject a new table column (bare |)
//   - break the row onto a new line (bare \n / \r)
//
// Backtick and # don't break table structure (they're inline markdown) but
// we assert they pass through cellSafe so the baseline is explicit — if a
// future formatter accidentally drops the cellSafe call the pipe / newline
// assertions will catch it first.
//
// How to maintain: when a new formatter path is added to formatTable() or
// a new helper wraps user data into a table cell, add a case here that feeds
// the dangerous chars through that path. CI will fail if the escape is omitted.

describe("markdown-escaping chokepoint guard — free-tier table (cellSafe)", () => {
  // Free-tier row format: | `domain` | org | cert_count | subdomain_count |
  // That is 4 cells separated by 5 `|` chars (1 leading delimiter + 4 cell separators).
  const FREE_TIER_PIPE_COUNT = 5; // 4 cells + 1 leading delimiter

  it("pipe in org is replaced with Unicode lookalike (│), not bare |", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          org: "Evil | injected column",
          apex_domain: "safe.com",
          cert_count: 1,
          subdomain_count: 0,
        },
      ],
      total: 1,
      truncated: false,
      source: "warehouse",
    });
    const rows = md.split("\n").filter((l) => l.startsWith("| `safe.com`"));
    expect(rows).toHaveLength(1);
    expect((rows[0].match(/\|/g) ?? []).length).toBe(FREE_TIER_PIPE_COUNT);
    expect(rows[0]).not.toContain("Evil | injected column");
    expect(rows[0]).toContain("Evil │ injected column");
  });

  it("newline in org is collapsed to space — no row split", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        { org: "line one\nline two", apex_domain: "safe.com", cert_count: 1, subdomain_count: 0 },
      ],
      total: 1,
      truncated: false,
      source: "warehouse",
    });
    const rows = md.split("\n").filter((l) => l.startsWith("| `safe.com`"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/[\r\n]/);
    expect(rows[0]).toContain("line one line two");
  });

  it("CRLF in org is collapsed to space — no row split", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        { org: "line one\r\nline two", apex_domain: "safe.com", cert_count: 1, subdomain_count: 0 },
      ],
      total: 1,
      truncated: false,
      source: "warehouse",
    });
    const rows = md.split("\n").filter((l) => l.startsWith("| `safe.com`"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/[\r\n]/);
  });

  it("pipe in domain is replaced with │ inside the code-span cell", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [{ org: "Safe Org", apex_domain: "evil.com|x", cert_count: 1, subdomain_count: 0 }],
      total: 1,
      truncated: false,
      source: "warehouse",
    });
    // The domain cell is wrapped in backticks: | `evil.com│x` |
    // Filter lines that contain the Safe Org (unique anchor).
    const rows = md.split("\n").filter((l) => l.includes("Safe Org"));
    expect(rows).toHaveLength(1);
    expect((rows[0].match(/\|/g) ?? []).length).toBe(FREE_TIER_PIPE_COUNT);
    expect(rows[0]).not.toContain("evil.com|x");
    expect(rows[0]).toContain("evil.com│x");
  });

  it("newline in domain is collapsed inside the code-span cell", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        { org: "Safe Org", apex_domain: "evil.com\nmalicious", cert_count: 1, subdomain_count: 0 },
      ],
      total: 1,
      truncated: false,
      source: "warehouse",
    });
    const rows = md.split("\n").filter((l) => l.includes("Safe Org"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/[\r\n]/);
    expect(rows[0]).toContain("evil.com malicious");
  });
});

describe("markdown-escaping chokepoint guard — heading (cellSafe)", () => {
  // The `# ctscout results for: <query>` heading is the one place a
  // CALLER-controlled value (the LLM's own tool input) reaches the markdown
  // output. Previously the sole unescaped interpolation in the formatter
  // (ctscout-mcp#50): a newline in company_name could inject arbitrary
  // markdown lines above the table. Same chokepoint as the table cells.
  const oneRow: ScanResponse = {
    domains: [{ org: "Safe Org", apex_domain: "safe.com", cert_count: 1, subdomain_count: 0 }],
    total: 1,
    truncated: false,
    source: "warehouse",
  };

  it("newline in query cannot inject a markdown line above the table", () => {
    const md = formatScanAsMarkdown("Evil\n# injected heading", oneRow);
    const lines = md.split("\n");
    expect(lines[0]).toBe("# ctscout results for: Evil # injected heading");
    expect(lines.filter((l) => l.startsWith("#"))).toHaveLength(1);
  });

  it("CRLF in query is collapsed — heading stays one line", () => {
    const md = formatScanAsMarkdown("line one\r\nline two", oneRow);
    expect(md.split("\n")[0]).toBe("# ctscout results for: line one line two");
  });

  it("pipe in query is replaced with the Unicode lookalike (│)", () => {
    const md = formatScanAsMarkdown("Evil | Corp", oneRow);
    expect(md.split("\n")[0]).toBe("# ctscout results for: Evil │ Corp");
  });

  it("long query is truncated at 200 chars with ellipsis", () => {
    const md = formatScanAsMarkdown("q".repeat(250), oneRow);
    expect(md.split("\n")[0]).toBe(`# ctscout results for: ${"q".repeat(199)}…`);
  });

  it("empty-result path routes through the same heading chokepoint", () => {
    const md = formatScanAsMarkdown("Evil\n# injected", {
      domains: [],
      total: 0,
      truncated: false,
      source: "warehouse",
    });
    const lines = md.split("\n");
    expect(lines[0]).toBe("# ctscout results for: Evil # injected");
    expect(lines.filter((l) => l.startsWith("# "))).toHaveLength(1);
  });

  it("hinted zero-result path escapes the query in legal-entity suggestions", () => {
    // The company hint triggers buildLegalEntitySuggestions, which
    // interpolates the query into every suggestion line — previously raw.
    const md = formatScanAsMarkdown(
      "Evil\n# injected",
      { domains: [], total: 0, truncated: false, source: "warehouse" },
      { kind: "company" },
    );
    const lines = md.split("\n");
    // No line of the output may be the injected heading on its own.
    expect(lines.filter((l) => l.startsWith("#"))).toHaveLength(1);
    expect(md).not.toContain("\n# injected");
    // The suggestions themselves carry the collapsed (escaped) query.
    expect(md).toContain("  • Evil # injected Companies");
  });
});

describe("markdown-escaping chokepoint guard — deep-dive table (escapeForTable + cellSafe)", () => {
  const baseEnrichment = {
    confidence_band: "verified" as const,
    weight_total: 5.0,
    matched_via: ["dns_txt_brand_token"],
    evidence: { dns_txt_brand_token: "safe evidence" },
    signal_health: {},
    vlm_status: "cached" as const,
    vlm_override: false,
  };

  it("pipe in evidence value is escaped (escapeForTable path)", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          apex_domain: "safe.com",
          attributed_to: "Safe Org",
          enrichment: { ...baseEnrichment, evidence: { dns_txt_brand_token: "a | b | c" } },
        },
      ],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    const row = dataRows[0];
    // Pro rows have 5 cells → 6 pipes; escaped \| inside cell should not add extra bare pipes.
    expect((row.match(/(?<!\\)\|/g) ?? []).length, `unescaped pipe count wrong: ${row}`).toBe(6);
    expect(row).toContain("a \\| b \\| c");
  });

  it("newline in evidence value is collapsed (escapeForTable path)", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          apex_domain: "safe.com",
          attributed_to: "Safe Org",
          enrichment: {
            ...baseEnrichment,
            evidence: { dns_txt_brand_token: "line1\r\nline2\nline3" },
          },
        },
      ],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]).not.toMatch(/[\r\n]/);
    expect(dataRows[0]).toContain("line1 line2 line3");
  });

  it("pipe in attributed_to is neutralised (cellSafe path)", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          apex_domain: "safe.com",
          attributed_to: "Org | Inc | Evil",
          enrichment: baseEnrichment,
        },
      ],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    // No bare pipe inside the cell (all replaced with │).
    expect(dataRows[0]).not.toContain("Org | Inc");
    expect(dataRows[0]).toContain("Org │ Inc │ Evil");
    expect((dataRows[0].match(/(?<!\\)\|/g) ?? []).length).toBe(6);
  });

  it("newline in attributed_to is collapsed (cellSafe path)", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          apex_domain: "safe.com",
          attributed_to: "Org\nnewline",
          enrichment: baseEnrichment,
        },
      ],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]).not.toMatch(/[\r\n]/);
    expect(dataRows[0]).toContain("Org newline");
  });

  it("pipe in signalSummary (matched_via) is neutralised (cellSafe path)", () => {
    // matched_via values come from the API response; a pipe in a signal name
    // would break the markdown table. This test would have FAILED before the
    // production fix that routed signalSummary through cellSafe().
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          apex_domain: "safe.com",
          attributed_to: "Safe Org",
          enrichment: { ...baseEnrichment, matched_via: ["signal|one", "signal|two"] },
        },
      ],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    const row = dataRows[0];
    // Pro rows have 5 cells → 6 unescaped pipes.
    expect((row.match(/(?<!\\)\|/g) ?? []).length, `unescaped pipe leaked: ${row}`).toBe(6);
    expect(row).not.toContain("signal|one");
    expect(row).toContain("signal│one");
    expect(row).toContain("signal│two");
  });

  it("newline in signalSummary (matched_via) is collapsed — no row split", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          apex_domain: "safe.com",
          attributed_to: "Safe Org",
          enrichment: { ...baseEnrichment, matched_via: ["signal\none", "sig\r\ntwo"] },
        },
      ],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]).not.toMatch(/[\r\n]/);
  });

  it("backtick and hash in signalSummary pass through cellSafe without breaking structure", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          apex_domain: "safe.com",
          attributed_to: "Safe Org",
          enrichment: { ...baseEnrichment, matched_via: ["`backtick`", "# hash"] },
        },
      ],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    // Still exactly 6 unescaped pipes — structure intact.
    expect((dataRows[0].match(/(?<!\\)\|/g) ?? []).length).toBe(6);
  });
});

// ---------- SERVER_VERSION single-sourcing ----------

describe("SERVER_VERSION", () => {
  it("matches package.json's version (single source — bump package.json only)", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8")) as {
      version: string;
    };
    // Guards against reintroducing a hardcoded version literal in
    // src/index.ts that drifts from package.json (the failure class
    // scripts/release.sh used to detect after the fact).
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});

// ---------- Batch tool (ctscout_search_company_batch, #19) ----------

const CHARACTER_LIMIT = 25_000; // mirror of the src-side constant

function warehouseDomains(prefix: string, count: number): DomainResult[] {
  return Array.from({ length: count }, (_, i) => ({
    org: `${prefix} Legal Entity Corporation Number ${i}`,
    apex_domain: `${prefix}-${i}.example.com`,
    cert_count: 10 + i,
    subdomain_count: 5 + i,
    first_seen: "2020-01-01T00:00:00Z",
    last_seen: "2026-01-01T00:00:00Z",
  }));
}

function oneWarehouseDomain(apex: string): DomainResult {
  return {
    org: `${apex} Corp`,
    apex_domain: `${apex}.example.com`,
    cert_count: 1,
    subdomain_count: 1,
  };
}

function batchOk(company: string, domains: DomainResult[]): BatchResultItem {
  return {
    query: { company_name: company },
    domains,
    total: domains.length,
    match_type: "exact",
  } as BatchResultItem;
}

function batchErr(company: string, code: number, message: string): BatchResultItem {
  return { query: { company_name: company }, error: { code, message } };
}

function batchEnvelope(
  results: BatchResultItem[],
  remaining: number | null = 4242,
): ScanBatchResponse {
  return { results, remaining_quota: remaining };
}

describe("callScanBatch", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.CTSCOUT_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.CTSCOUT_API_KEY;
    } else {
      process.env.CTSCOUT_API_KEY = originalApiKey;
    }
  });

  it("POSTs /scan/batch with a {queries} body and returns the envelope", async () => {
    process.env.CTSCOUT_API_KEY = "test-key";
    const envelope = batchEnvelope([batchOk("Cloudflare", warehouseDomains("cf", 1))], 99);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => envelope,
    } as Response);

    const result = await callScanBatch([{ company_name: "Cloudflare" }]);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/scan/batch"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "test-key",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ queries: [{ company_name: "Cloudflare" }] }),
      }),
    );
    expect(result).toEqual(envelope);
  });

  it("bounds an oversized batch error body captured from the stream (inherits #57)", async () => {
    process.env.CTSCOUT_API_KEY = "test-key";
    const hugeBody = "z".repeat(200_000);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(hugeBody, { status: 400 }));

    let caught: unknown;
    try {
      await callScanBatch([{ company_name: "Test" }]);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(400);
    const captured = (caught as ApiError).responseBody;
    expect(captured.length).toBeLessThan(hugeBody.length);
    expect(captured.length).toBeLessThanOrEqual(4096);
  });

  it("throws if CTSCOUT_API_KEY is not set", async () => {
    delete process.env.CTSCOUT_API_KEY;
    await expect(callScanBatch([{ company_name: "Test" }])).rejects.toThrow(
      "CTSCOUT_API_KEY environment variable is not set",
    );
  });
});

describe("SearchCompanyBatchInputSchema — client-side cap (belt-and-suspenders)", () => {
  it("rejects more than 10 company names without a network call", () => {
    const names = Array.from({ length: 11 }, (_, i) => `Company ${i}`);
    expect(SearchCompanyBatchInputSchema.safeParse({ company_names: names }).success).toBe(false);
  });

  it("accepts exactly 10 company names", () => {
    const names = Array.from({ length: 10 }, (_, i) => `Company ${i}`);
    expect(SearchCompanyBatchInputSchema.safeParse({ company_names: names }).success).toBe(true);
  });

  it("rejects an empty company_names array", () => {
    expect(SearchCompanyBatchInputSchema.safeParse({ company_names: [] }).success).toBe(false);
  });

  it("rejects a name shorter than 2 characters", () => {
    expect(SearchCompanyBatchInputSchema.safeParse({ company_names: ["X"] }).success).toBe(false);
  });
});

describe("fairShareBudgets — anti-starvation budget split", () => {
  it("caps a greedy section so small sections keep their full floor", () => {
    // One section wants 100k chars; three want ~10 each. Shared budget 20k.
    const budgets = fairShareBudgets([100_000, 10, 10, 10], 20_000);
    const floor = Math.floor(20_000 / 4); // 5000
    // Small sections keep exactly their floor — never starved below budget/N.
    expect(budgets[1]).toBe(floor);
    expect(budgets[2]).toBe(floor);
    expect(budgets[3]).toBe(floor);
    // The greedy section gets redistributed surplus but cannot swallow the
    // whole budget — its actual usage stays below the shared total.
    expect(budgets[0]).toBeGreaterThan(floor);
    expect(budgets[0]).toBeLessThan(20_000);
  });

  it("splits the surplus equally among multiple over-floor sections", () => {
    const budgets = fairShareBudgets([100_000, 100_000, 10, 10], 20_000);
    const floor = Math.floor(20_000 / 4); // 5000
    expect(budgets[2]).toBe(floor);
    expect(budgets[3]).toBe(floor);
    expect(budgets[0]).toBe(budgets[1]); // symmetric
    expect(budgets[0]).toBeGreaterThan(floor);
  });

  it("gives an equal floor when every section fits under it", () => {
    expect(fairShareBudgets([100, 100, 100], 30_000)).toEqual([10_000, 10_000, 10_000]);
  });

  it("returns [] for no sections", () => {
    expect(fairShareBudgets([], 25_000)).toEqual([]);
  });

  it("leaves every section at the floor when all overflow (no surplus)", () => {
    // Every section wants more than its floor → no donor slack to redistribute.
    const budgets = fairShareBudgets([9_000, 9_000, 9_000], 15_000);
    const floor = Math.floor(15_000 / 3); // 5000
    expect(budgets).toEqual([floor, floor, floor]);
  });
});

describe("formatBatchAsMarkdown", () => {
  it("renders one section per company with a batch header and quota footer", () => {
    const batch = batchEnvelope(
      [
        batchOk("Cloudflare", warehouseDomains("cf", 2)),
        batchOk("Fastly", warehouseDomains("fastly", 1)),
      ],
      4242,
    );
    const md = formatBatchAsMarkdown(["Cloudflare", "Fastly"], batch);

    expect(md).toContain("# ctscout batch results (2 companies)");
    expect(md).toContain("## ctscout results for: Cloudflare");
    expect(md).toContain("## ctscout results for: Fastly");
    expect(md).toContain("cf-0.example.com");
    expect(md).toContain("fastly-0.example.com");
    expect(md).toContain("_Remaining quota today: 4242._");

    // Exactly one H1 (the batch header) — the single-company renderer's H1 is
    // demoted to H2 so it nests instead of leaking a second top-level heading.
    const h1Lines = md.split("\n").filter((l) => /^# /.test(l));
    expect(h1Lines).toHaveLength(1);
    expect(h1Lines[0]).toContain("batch results");
  });

  it("renders a failed query as an error section, siblings intact (partial failure)", () => {
    const batch = batchEnvelope([
      batchOk("Cloudflare", warehouseDomains("cf", 1)),
      batchErr(
        "Doomed Co",
        503,
        "Batch subrequest budget exceeded. Retry with strict_match_org_only:true or send a smaller batch",
      ),
    ]);
    const md = formatBatchAsMarkdown(["Cloudflare", "Doomed Co"], batch);

    expect(md).toContain("## ctscout results for: Cloudflare");
    expect(md).toContain("cf-0.example.com"); // successful sibling still rendered
    expect(md).toContain("## ctscout results for: Doomed Co");
    expect(md).toContain("This query failed (HTTP 503)");
    // The upstream retry guidance survives; underscores are markdown-escaped
    // (injection guard, same as explainError), so assert on a plain substring.
    expect(md).toContain("send a smaller batch");
    expect(md).toContain("strict\\_match\\_org\\_only");
  });

  it("preserves semantic candidates in their original batch position", () => {
    const semantic = {
      query: { company_name: "Semantic Co" },
      domains: [],
      total: 0,
      source: "warehouse",
      match_type: "semantic",
      org_match_strategy: "semantic",
      empty_reason: "semantic_offered",
      candidates: [
        {
          org: "Semantic Company Holdings",
          similarity: 0.88,
          top_apex_domain: "semantic.example",
        },
      ],
    } as BatchResultItem;
    const batch = batchEnvelope([
      batchOk("First", [oneWarehouseDomain("first")]),
      semantic,
      batchErr("Last", 503, "Retry later"),
    ]);
    const md = formatBatchAsMarkdown(["First", "Semantic Co", "Last"], batch);

    expect(md.indexOf("first.example.com")).toBeLessThan(md.indexOf("Semantic Company Holdings"));
    expect(md.indexOf("Semantic Company Holdings")).toBeLessThan(md.indexOf("HTTP 503"));
    expect(md).toContain("| Semantic Company Holdings | 0.88 | semantic.example |");
  });

  it("bounds a semantic-only Markdown batch while retaining its highest-ranked candidates", () => {
    const semantic = {
      query: { company_name: "Semantic Flood" },
      domains: [],
      total: 0,
      source: "warehouse",
      match_type: "semantic",
      org_match_strategy: "semantic",
      empty_reason: "semantic_offered",
      candidates: Array.from({ length: 4000 }, (_, index) => ({
        org: `Candidate Organization ${index} ${"x".repeat(40)}`,
        similarity: 0.9 - index / 10_000,
        top_apex_domain: `candidate-${index}.example`,
      })),
    } as BatchResultItem;

    const md = formatBatchAsMarkdown(["Semantic Flood"], batchEnvelope([semantic]));

    expect(md.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(md).toContain("Candidate Organization 0");
    expect(md).not.toContain("Candidate Organization 3999");
    expect(md).toContain("semantic candidates");
  });

  it("neutralizes newline injection in a hostile error message", () => {
    const batch = batchEnvelope([
      batchErr("Evil Co", 500, "boom\n\n## Injected Heading\n\n| pwned | row |"),
    ]);
    const md = formatBatchAsMarkdown(["Evil Co"], batch);
    // Exactly one H1 (batch header); the injected heading must not become a
    // real heading line, and the newline must not break out of the blockquote.
    const headingLines = md.split("\n").filter((l) => /^#{1,6} /.test(l));
    expect(headingLines).toHaveLength(2); // batch H1 + the "Evil Co" H2 only
    expect(md).not.toMatch(/^## Injected Heading/m);
  });

  it("bounds malformed and oversized per-query error details", () => {
    const malformed = {
      query: { company_name: "Malformed" },
      error: { code: Number.NaN, message: undefined },
    } as unknown as BatchResultItem;
    const verbose = {
      query: { company_name: "Verbose" },
      error: { code: 500, message: "e".repeat(50_000) },
    } as BatchResultItem;

    const md = formatBatchAsMarkdown(["Malformed", "Verbose"], batchEnvelope([malformed, verbose]));

    expect(md.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(md).toContain("HTTP unknown");
    expect(md).toContain("## ctscout results for: Verbose");
    expect(md).toContain("…");
  });

  it("uses singular wording for a one-company batch", () => {
    const md = formatBatchAsMarkdown(
      ["Solo"],
      batchEnvelope([batchOk("Solo", warehouseDomains("solo", 1))], 7),
    );
    expect(md).toContain("# ctscout batch results (1 company)");
    expect(md).toContain("## ctscout results for: Solo");
  });

  it("falls back to the echoed query name when inputs and results misalign", () => {
    // companyNames shorter than results (defensive): label from the echoed
    // query, then "(unnamed)" when even that is absent.
    const batch = batchEnvelope([
      batchOk("Echoed Co", warehouseDomains("echoed", 1)),
      { query: {}, domains: [oneWarehouseDomain("nameless")], total: 1 } as BatchResultItem,
    ]);
    const md = formatBatchAsMarkdown([], batch);
    expect(md).toContain("## ctscout results for: Echoed Co");
    expect(md).toContain("## ctscout results for: (unnamed)");
  });

  it("handles an empty results envelope", () => {
    const md = formatBatchAsMarkdown([], batchEnvelope([], null));
    expect(md).toContain("# ctscout batch results (0 companies)");
    expect(md).toContain("_No results returned._");
    expect(md).toContain("unlimited (Pro tier)");
  });

  it("truncates a single huge company's section under the shared limit", () => {
    const batch = batchEnvelope([batchOk("Giant", warehouseDomains("giant", 5000))]);
    const md = formatBatchAsMarkdown(["Giant"], batch);
    expect(md.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(md).toContain("Response truncated");
  });

  it("keeps small companies fully visible when one company floods the batch", () => {
    // The adversarial case: one company returns thousands of domains; two
    // others return one each. Fair-share must stop the flood from starving
    // the small companies out of the shared budget.
    const batch = batchEnvelope([
      batchOk("Flood", warehouseDomains("flood", 5000)),
      batchOk("Small B", [oneWarehouseDomain("beacon-b")]),
      batchOk("Small C", [oneWarehouseDomain("beacon-c")]),
    ]);
    const md = formatBatchAsMarkdown(["Flood", "Small B", "Small C"], batch);

    expect(md.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    // Both small companies survive — their single domains still render.
    expect(md).toContain("beacon-b.example.com");
    expect(md).toContain("beacon-c.example.com");
    expect(md).toContain("## ctscout results for: Small B");
    expect(md).toContain("## ctscout results for: Small C");
    // The flooding company was truncated to fit its share.
    expect(md).toContain("## ctscout results for: Flood");
    expect(md).toContain("Response truncated");
  });

  it("does not truncate an uneven batch when the complete joined Markdown fits", () => {
    const batch = batchEnvelope([
      batchOk("Large A", warehouseDomains("large-a", 115)),
      batchOk("Medium B", warehouseDomains("medium-b", 65)),
      batchOk("Small C", warehouseDomains("small-c", 1)),
    ]);
    const md = formatBatchAsMarkdown(["Large A", "Medium B", "Small C"], batch);

    expect(md.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(md).toContain("large-a-114.example.com");
    expect(md).toContain("medium-b-64.example.com");
    expect(md).not.toContain("Response truncated");
  });
});

describe("truncateBatchJsonIfNeeded", () => {
  it("pretty-prints a small batch unchanged", () => {
    const batch = batchEnvelope([batchOk("Cloudflare", warehouseDomains("cf", 1))], 50);
    const { text, structured } = truncateBatchJsonIfNeeded(batch);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(structured).toEqual(batch);
    expect(text).toContain("\n  "); // indented pretty-print
  });

  it("uses compact JSON before dropping data that only exceeds the pretty-print budget", () => {
    const batch = batchEnvelope([batchOk("Borderline", warehouseDomains("borderline", 85))]);
    expect(JSON.stringify(batch).length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(JSON.stringify(batch, null, 2).length).toBeGreaterThan(CHARACTER_LIMIT);

    const { text, structured } = truncateBatchJsonIfNeeded(batch);
    expect(text).toBe(JSON.stringify(batch));
    expect(structured).toBe(batch);
    expect((structured.results[0] as { domains: DomainResult[] }).domains).toHaveLength(85);
  });

  it("bounds an oversized batch to the limit, stays valid JSON, no starvation (#53)", () => {
    const batch = batchEnvelope([
      batchOk("Giant", warehouseDomains("giant", 5000)),
      batchOk("Tiny", [oneWarehouseDomain("tiny")]),
    ]);
    const { text, structured } = truncateBatchJsonIfNeeded(batch);

    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    const parsed = JSON.parse(text) as ScanBatchResponse;
    // Both results survive — the tiny company is not dropped to make room.
    expect(parsed.results).toHaveLength(2);
    expect(text).toContain("tiny.example.com");
    expect(structured.remaining_quota).toBe(batch.remaining_quota);
  });

  it("passes a failed query through untouched when bounding an oversized batch", () => {
    const batch = batchEnvelope([
      batchOk("Giant", warehouseDomains("giant", 5000)),
      batchErr("Failed Co", 503, "Batch subrequest budget exceeded"),
    ]);
    const { text, structured } = truncateBatchJsonIfNeeded(batch);

    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    const parsed = JSON.parse(text) as ScanBatchResponse;
    expect(parsed.results).toHaveLength(2);
    // The error item survives verbatim (no domains to halve).
    const failed = structured.results[1] as { error: { code: number; message: string } };
    expect(failed.error.code).toBe(503);
    expect(failed.error.message).toBe("Batch subrequest budget exceeded");
  });

  it("bounds a result whose non-domain bulk (candidates[]) exceeds its slice, no eviction", () => {
    // A large semantic `candidates[]` (legitimate Pro data) with zero domains
    // can't be trimmed by halving — it must fall back to a minimal envelope,
    // not stay oversized and evict the sibling via the drop-trailing backstop.
    const bigCandidates = Array.from({ length: 4000 }, (_, i) => ({
      org: `Candidate Organization Number ${i} ${"x".repeat(20)}`,
      similarity: 0.5,
      top_apex_domain: `candidate-${i}.example`,
    }));
    const heavy = {
      query: { company_name: "Heavy" },
      domains: [],
      total: 0,
      match_type: "semantic",
      org_match_strategy: "semantic",
      empty_reason: "semantic_offered",
      candidates: bigCandidates,
    } as unknown as BatchResultItem;
    const batch = batchEnvelope([heavy, batchOk("Sibling", [oneWarehouseDomain("sibling")])]);

    const { text, structured } = truncateBatchJsonIfNeeded(batch);
    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(() => JSON.parse(text)).not.toThrow();
    // The sibling is NOT dropped to make room for the oversized item.
    expect(structured.results).toHaveLength(2);
    expect(text).toContain("sibling.example.com");
    const bounded = structured.results[0] as {
      candidates?: unknown[];
      empty_reason?: string;
    };
    expect(bounded.candidates?.length).toBeGreaterThan(0);
    expect(bounded.candidates?.length).toBeLessThan(bigCandidates.length);
    expect(bounded.empty_reason).toBe("semantic_offered");
  });

  it("uses a minimal semantic envelope when unknown top-level fields exceed a result slice", () => {
    const heavy = {
      query: { company_name: "Opaque" },
      domains: [],
      total: 0,
      source: "warehouse",
      match_type: "semantic",
      org_match_strategy: "semantic",
      empty_reason: "semantic_offered",
      candidates: [
        {
          org: "Opaque Candidate",
          similarity: 0.9,
          top_apex_domain: "opaque.example",
        },
      ],
      opaque_metadata: "x".repeat(100_000),
    } as BatchResultItem;
    const batch = batchEnvelope([heavy, batchOk("Sibling", [oneWarehouseDomain("sibling")])]);

    const { text, structured } = truncateBatchJsonIfNeeded(batch);

    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(structured.results).toHaveLength(2);
    expect(structured.results[0]).toMatchObject({
      query: { company_name: "Opaque" },
      domains: [],
      match_type: "semantic",
      org_match_strategy: "semantic",
      empty_reason: "semantic_offered",
      candidates: [],
      truncated: true,
      upgrade_hint: expect.stringContaining("0 of 1 semantic candidates"),
    });
    expect(text).not.toContain("opaque_metadata");
    expect(text).toContain("sibling.example.com");
  });

  it("bounds a huge error message rather than dropping siblings", () => {
    const batch = batchEnvelope([
      batchErr("Verbose", 500, "e".repeat(200_000)),
      batchOk("Sibling", [oneWarehouseDomain("sibling")]),
    ]);
    const { text, structured } = truncateBatchJsonIfNeeded(batch);
    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(structured.results).toHaveLength(2);
    expect(text).toContain("sibling.example.com");
  });

  it("retains one bounded error result for every maximum-size accepted input", () => {
    const names = Array.from({ length: 10 }, (_, index) => `Company ${index} ${"n".repeat(188)}`);
    const batch = batchEnvelope(
      names.map((name, index) => batchErr(name, 500 + (index % 4), "e".repeat(200_000))),
    );

    const { text, structured } = truncateBatchJsonIfNeeded(batch);

    expect(text.length).toBeLessThanOrEqual(CHARACTER_LIMIT);
    expect(JSON.parse(text)).toEqual(structured);
    expect(structured.results).toHaveLength(10);
    expect(structured.results.map((item) => item.query.company_name)).toEqual(names);
  });
});

describe("resolveSnapshot", () => {
  it("resolves 'scan' from a non-empty payload string, else 'unavailable' with null", () => {
    expect(resolveSnapshot({ snapshot: "2026-08-30" })).toEqual({
      snapshot: "2026-08-30",
      snapshot_source: "scan",
    });

    // A non-string or empty payload snapshot is not trusted as a date, and no
    // other source is consulted: null is the only honest answer.
    const unavailable = { snapshot: null, snapshot_source: "unavailable" };
    expect(resolveSnapshot({ snapshot: 20260830 })).toEqual(unavailable);
    expect(resolveSnapshot({ snapshot: "" })).toEqual(unavailable);
    expect(resolveSnapshot({ snapshot: null })).toEqual(unavailable);
    expect(resolveSnapshot({})).toEqual(unavailable);
  });
});

describe("snapshot line in markdown", () => {
  it("is omitted when the response carries no snapshot fields", () => {
    const md = formatScanAsMarkdown("Acme", freeResponse([]), { kind: "company" });
    expect(md).not.toContain("Warehouse snapshot");
  });

  it("names the date and its source on every rendering path", () => {
    const stamped: ScanResponse = {
      ...freeResponse([]),
      snapshot: "2026-09-03",
      snapshot_source: "scan",
    };
    expect(formatScanAsMarkdown("Acme", stamped, { kind: "company" })).toContain(
      "_Warehouse snapshot: 2026-09-03 (reported by the API response)._",
    );
    const semantic: ScanResponse = {
      ...stamped,
      match_type: "semantic",
      candidates: [{ org: "Acme Holdings", similarity: 0.9, top_apex_domain: null }],
    };
    const semanticMd = formatScanAsMarkdown("Acme", semantic, { kind: "company" });
    expect(semanticMd).toContain("_Warehouse snapshot: 2026-09-03");
    expect(semanticMd).toContain("| Candidate organization | Similarity | Top apex domain |");
    const unavailable: ScanResponse = {
      ...stamped,
      snapshot: null,
      snapshot_source: "unavailable",
    };
    expect(formatScanAsMarkdown("Acme", unavailable)).toContain(
      "_Warehouse snapshot: unknown — the API did not report a sync date._",
    );
  });

  it("survives markdown and JSON truncation of a single scan", () => {
    const big: ScanResponse = {
      ...freeResponse(
        Array.from({ length: 2000 }, (_, i) => ({
          org: "Big Corp",
          apex_domain: `big-${i}.example.com`,
          cert_count: 1,
          subdomain_count: 0,
        })),
      ),
      snapshot: "2026-09-03",
      snapshot_source: "scan",
    };
    const md = truncateIfNeeded(formatScanAsMarkdown("Big", big), big, "Big");
    expect(md.text).toContain("_Warehouse snapshot: 2026-09-03");
    expect(md.structured.snapshot).toBe("2026-09-03");

    const json = truncateJsonIfNeeded(big);
    expect(JSON.parse(json.text).snapshot_source).toBe("scan");

    // The minimal-envelope path (one row alone over the limit) keeps it too.
    const pathological: ScanResponse = {
      ...big,
      domains: [{ ...big.domains[0], padding: "x".repeat(30_000) }],
    };
    const minimal = truncateJsonIfNeeded(pathological);
    expect(minimal.structured).toMatchObject({
      domains: [],
      snapshot: "2026-09-03",
      snapshot_source: "scan",
    });
  });
});

// ---------- Async deep-dive jobs (ctscout-worker#344 contract v1) ----------

// One ProDiscoveredDomain as the batch worker writes it: `domain` (no
// apex_domain) + `attributed_to` + `enrichment` + the embedded free-tier
// `base`. This is the deep-dive result row shape, distinct from the
// warehouse row.
function proDiscoveredDomain(
  domain: string,
  band: "verified" | "likely" = "verified",
): DomainResult {
  return {
    domain,
    attributed_to: "CNA Financial Corporation",
    is_seed: false,
    base: { domain, confidence: 0.95, sources: ["ct_org_match"] },
    enrichment: {
      confidence_band: band,
      weight_total: 4.2,
      matched_via: ["dns_txt_brand_token", "rdap_registrant_match"],
      evidence: { dns_txt_brand_token: "verified via google-site-verification" },
      signal_health: { dns_txt_brand_token: "hit", vlm_verdict: "pending" },
      vlm_status: "pending",
      vlm_override: false,
    },
  };
}

function doneJob(domains: DomainResult[], extra: Partial<JobResponse> = {}): JobResponse {
  return {
    job_id: "0123456789abcdef01234567",
    kind: "deep_dive",
    status: "done",
    submitted_at: "2026-09-04T10:00:00Z",
    started_at: "2026-09-04T10:05:00Z",
    finished_at: "2026-09-04T10:09:30Z",
    result: {
      job_id: "0123456789abcdef01234567",
      entity: { company_name: "CNA Financial", seed_domain: [] },
      domains,
      run_metadata: { duration_ms: 270_000 },
      source: "live-enriched",
      signals_degraded: false,
      snapshot: "2026-08-31",
      worker_version: "abc1234",
      signals_attempted: ["dns", "rdap", "homepage", "ip_asn"],
    },
    ...extra,
  };
}

describe("callSubmitJob / callGetJob", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    process.env.CTSCOUT_API_KEY = "test-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("POSTs the spec to /jobs with the API key and the shared request settings", async () => {
    const receipt = {
      job_id: "abc",
      status: "queued",
      submitted_at: "2026-09-04T10:00:00Z",
      poll: "/jobs/abc",
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => receipt } as Response);

    const result = await callSubmitJob({ company_name: "CNA Financial", seed_domain: ["cna.com"] });

    expect(result).toEqual(receipt);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toMatch(/\/jobs$/);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({
        "X-API-Key": "test-key",
        "Content-Type": "application/json",
        "User-Agent": `ctscout-mcp-server/${SERVER_VERSION}`,
      }),
      body: JSON.stringify({ company_name: "CNA Financial", seed_domain: ["cna.com"] }),
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("GETs /jobs/{id} with no body, URL-encoding the id", async () => {
    const job = { job_id: "abc", status: "queued", submitted_at: "2026-09-04T10:00:00Z" };
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => job } as Response);

    const result = await callGetJob("abc def");

    expect(result).toEqual(job);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toMatch(/\/jobs\/abc%20def$/);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("Content-Type");
    expect(init.headers).toMatchObject({ "X-API-Key": "test-key", Accept: "application/json" });
    expect(init.redirect).toBe("error");
  });

  it("surfaces a non-2xx job response as ApiError with the bounded body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));

    let caught: unknown;
    try {
      await callGetJob("missing");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(404);
  });

  it("maps an aborted job request to TimeoutError", async () => {
    const abortError = new Error("aborted");
    abortError.name = "AbortError";
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);
    await expect(callSubmitJob({ company_name: "Acme" })).rejects.toThrowError(TimeoutError);
  });
});

describe("explainError — jobs surface", () => {
  it("maps 403 to Pro-required with the API's upgrade_hint, bounded and escaped", () => {
    const body = JSON.stringify({
      error: "pro_required",
      upgrade_hint: "Deep dives need a Pro key: email pro@ctscout.dev [link](x)\nsecond line",
    });
    const msg = explainError(new ApiError(403, body), "jobs");
    expect(msg).toContain("Deep dives require a Pro key");
    expect(msg).toContain("email pro@ctscout.dev");
    expect(msg).toContain("\\[link\\]\\(x\\)");
    expect(msg).not.toContain("\n");
    expect(msg).not.toContain("revoked");
  });

  it("falls back to the concierge text when the 403 body carries no upgrade_hint", () => {
    expect(explainError(new ApiError(403, "Forbidden"), "jobs")).toContain(
      "Pro is concierge-only: email pro@ctscout.dev",
    );
    expect(
      explainError(new ApiError(403, JSON.stringify({ upgrade_hint: "  " })), "jobs"),
    ).toContain("Pro is concierge-only");
  });

  it("bounds an oversized upgrade_hint", () => {
    const body = JSON.stringify({ upgrade_hint: "u".repeat(30_000) });
    const msg = explainError(new ApiError(403, body), "jobs");
    expect(msg.length).toBeLessThan(1_000);
    expect(msg).toContain("truncated, 30000 chars total");
  });

  it("maps 404 to not-your-job / unknown id", () => {
    const msg = explainError(new ApiError(404, "{}"), "jobs");
    expect(msg).toContain("No job with that id for this API key");
    expect(msg).toContain("not your job or an unknown id");
  });

  it("maps 429 to the daily jobs quota, not the scan quota", () => {
    const msg = explainError(new ApiError(429, "{}"), "jobs");
    expect(msg).toContain("Daily deep-dive quota exceeded (20 submissions per key per day)");
    expect(msg).toContain("can still be polled");
    expect(msg).not.toContain("Free tier is 10 queries/day");
  });

  it("delegates every other status and error kind to the shared mapping", () => {
    expect(explainError(new ApiError(401, "x"), "jobs")).toContain(
      "Invalid or missing CTSCOUT_API_KEY",
    );
    expect(explainError(new ApiError(400, "bad spec"), "jobs")).toContain("Bad request: bad spec");
    expect(explainError(new ApiError(503, ""), "jobs")).toContain("ctscout server error (503)");
    expect(explainError(new TimeoutError(), "jobs")).toContain("timed out");
  });

  it("leaves the scan surface's 403/404/429 mapping unchanged", () => {
    expect(explainError(new ApiError(403, "Forbidden"))).toContain("revoked");
    expect(explainError(new ApiError(429, "Quota"))).toContain("Free tier is 10 queries/day");
    expect(explainError(new ApiError(404, "nope"))).toContain("HTTP 404");
  });
});

describe("SubmitDeepDiveInputSchema / GetJobInputSchema — client-side validation", () => {
  it("requires company_name or seed_domain and accepts either or both", () => {
    expect(SubmitDeepDiveInputSchema.safeParse({}).success).toBe(false);
    expect(SubmitDeepDiveInputSchema.safeParse({ company_name: "Acme" }).success).toBe(true);
    expect(SubmitDeepDiveInputSchema.safeParse({ seed_domain: ["acme.com"] }).success).toBe(true);
    expect(
      SubmitDeepDiveInputSchema.safeParse({ company_name: "Acme", seed_domain: ["acme.com"] })
        .success,
    ).toBe(true);
  });

  it("caps seed_domain at 10 and rejects unknown keys", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `seed-${i}.example`);
    const over = SubmitDeepDiveInputSchema.safeParse({ seed_domain: eleven });
    expect(over.success).toBe(false);
    expect(JSON.stringify(over.error?.issues)).toContain("At most 10 seed domains");
    expect(SubmitDeepDiveInputSchema.safeParse({ seed_domain: [] }).success).toBe(false);
    expect(
      SubmitDeepDiveInputSchema.safeParse({ company_name: "Acme", purpose: "underwriting" })
        .success,
    ).toBe(false);
  });

  it("accepts only an opaque path-safe job_id", () => {
    expect(GetJobInputSchema.safeParse({ job_id: "0123456789abcdef01234567" }).success).toBe(true);
    expect(GetJobInputSchema.safeParse({ job_id: "../keys" }).success).toBe(false);
    expect(GetJobInputSchema.safeParse({ job_id: "abc?x=1" }).success).toBe(false);
    expect(GetJobInputSchema.safeParse({ job_id: "" }).success).toBe(false);
  });
});

describe("clampText", () => {
  it("returns text under the limit unchanged", () => {
    expect(clampText("short", 100)).toBe("short");
  });

  it("cuts at a line boundary and appends the clamp hint", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
    const clamped = clampText(lines.join("\n"), 1_000);
    expect(clamped.length).toBeLessThanOrEqual(1_000);
    const marker = "\n\n> Response clamped to stay under 1000 chars";
    expect(clamped).toContain(marker);
    const body = clamped.slice(0, clamped.indexOf(marker));
    expect(body.split("\n").every((line) => /^line \d+ x{40}$/.test(line))).toBe(true);
  });
});

describe("truncateReceiptJsonIfNeeded", () => {
  const receipt = {
    job_id: "abc",
    status: "queued" as const,
    submitted_at: "2026-09-04T10:00:00Z",
    poll: "/jobs/abc",
  };

  it("pretty-prints a receipt that fits, unchanged", () => {
    const { text, structured } = truncateReceiptJsonIfNeeded(receipt);
    // A receipt is a job handle, not a warehouse read (README's documented
    // exception to the snapshot fields).
    expect(structured).not.toHaveProperty("snapshot");
    expect(structured).not.toHaveProperty("snapshot_source");
    expect(structured).toBe(receipt);
    expect(JSON.parse(text)).toEqual(receipt);
    expect(text).toContain("\n  ");
  });

  it("collapses to the known fields, each bounded, when an unknown field is over budget", () => {
    const { text, structured } = truncateReceiptJsonIfNeeded({
      ...receipt,
      poll: `/jobs/${"p".repeat(30_000)}`,
      noise: "n".repeat(30_000),
    });
    expect(text.length).toBeLessThanOrEqual(25_000);
    expect(JSON.parse(text)).toEqual(structured);
    expect(structured).not.toHaveProperty("noise");
    expect(structured).toMatchObject({
      job_id: "abc",
      status: "queued",
      submitted_at: "2026-09-04T10:00:00Z",
    });
    expect(structured.poll).toMatch(/^\/jobs\/p{194}…\(truncated, 30006 chars total\)$/);
  });
});

describe("formatJobSubmittedAsMarkdown", () => {
  it("renders a receipt that says nothing is attributed yet and how to poll", () => {
    const md = formatJobSubmittedAsMarkdown(
      { company_name: "CNA\nFinancial", seed_domain: ["cna.com"] },
      {
        job_id: "abc|def",
        status: "queued",
        submitted_at: "2026-09-04T10:00:00Z",
        poll: "/jobs/abc",
      },
    );
    expect(md).toContain("# ctscout deep dive submitted");
    expect(md).toContain("- Target: CNA Financial / cna.com");
    expect(md).toContain("- Job id: `abc│def`");
    expect(md).toContain("- Status: `queued`");
    expect(md).toContain("nothing is attributed yet");
    expect(md).toContain("wait about 30 s before the first poll, then back off toward 5 min");
    expect(md).toContain("ctscout_get_job");
  });
});

describe("formatJobAsMarkdown", () => {
  it("renders a queued job with polling guidance and null snapshot fields", () => {
    const { text, structured } = formatJobAsMarkdown({
      job_id: "abc",
      kind: "deep_dive",
      status: "queued",
      submitted_at: "2026-09-04T10:00:00Z",
      started_at: null,
      finished_at: null,
    });
    expect(text).toContain("# ctscout deep dive `abc`");
    expect(text).toContain("- Status: `queued`");
    expect(text).toContain("Not finished yet; no attribution to report.");
    expect(text).toContain("back off toward 5 min");
    expect(text).not.toContain("Started at");
    expect(text).not.toContain("| Domain |");
    expect(structured).toMatchObject({
      job_id: "abc",
      status: "queued",
      snapshot: null,
      snapshot_source: "unavailable",
    });
    expect(structured.result).toBeUndefined();
  });

  it("renders a failed job's error bounded and escaped, with no table", () => {
    const { text, structured } = formatJobAsMarkdown({
      job_id: "abc",
      status: "failed",
      submitted_at: "2026-09-04T10:00:00Z",
      started_at: "2026-09-04T10:05:00Z",
      finished_at: "2026-09-04T10:06:00Z",
      error: "timeout: [origin](x) gave up\n# not a heading",
    });
    expect(text).toContain("- Started at: 2026-09-04T10:05:00Z");
    expect(text).toContain("- Error: timeout: \\[origin\\]\\(x\\) gave up # not a heading");
    expect(text).toContain("The deep dive failed; there is no result.");
    expect(text).not.toContain("\n# not a heading");
    expect(structured.snapshot_source).toBe("unavailable");
  });

  it("renders a done job as the Pro band table under the worker-set snapshot line", () => {
    const { text, structured } = formatJobAsMarkdown(
      doneJob([proDiscoveredDomain("cna.com"), proDiscoveredDomain("cnasurety.com", "likely")]),
    );
    expect(text).toContain("- Status: `done`");
    expect(text).toContain("- Worker version: abc1234");
    expect(text).toContain("Visual brand verification (VLM) is not part of deep dives in v1");
    // The scan section nests under the job heading.
    expect(text).toContain("## ctscout results for: CNA Financial");
    expect(text).toContain("_Warehouse snapshot: 2026-08-31 (reported by the API response)._");
    expect(text).toContain("| Domain | Attributed to | Band | Signals | Evidence |");
    expect(text).toContain("| `cna.com` | CNA Financial Corporation | ✅ verified |");
    expect(text).toContain("| `cnasurety.com` | CNA Financial Corporation | 🟢 likely |");
    expect(text).toContain("Source: `live-enriched` _(Pro tier — multi-signal attribution)_");
    expect(text).not.toContain("undefined");
    expect(structured).toMatchObject({
      status: "done",
      snapshot: "2026-08-31",
      snapshot_source: "scan",
      result: { snapshot: "2026-08-31", snapshot_source: "scan", worker_version: "abc1234" },
    });
  });

  it("labels the results by seed domains when the entity has no name, else by job id", () => {
    const seeded = doneJob([proDiscoveredDomain("cna.com")]);
    seeded.result = {
      ...seeded.result,
      entity: { company_name: "", seed_domain: ["cna.com"] },
    } as JobResponse["result"];
    expect(formatJobAsMarkdown(seeded).text).toContain("## ctscout results for: cna.com");

    const bare = doneJob([proDiscoveredDomain("cna.com")]);
    bare.result = { ...bare.result, entity: undefined } as JobResponse["result"];
    expect(formatJobAsMarkdown(bare).text).toContain(
      "## ctscout results for: 0123456789abcdef01234567",
    );
  });

  it("treats a done job whose result lacks snapshot as unknown freshness", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")]);
    job.result = { ...job.result, snapshot: undefined } as JobResponse["result"];
    const { text, structured } = formatJobAsMarkdown(job);
    expect(text).toContain("_Warehouse snapshot: unknown — the API did not report a sync date._");
    expect(structured).toMatchObject({ snapshot: null, snapshot_source: "unavailable" });
  });

  it("bounds a huge done result to the character limit and keeps the snapshot", () => {
    const many = Array.from({ length: 3000 }, (_, i) => proDiscoveredDomain(`d-${i}.example`));
    const { text, structured } = formatJobAsMarkdown(doneJob(many));
    expect(text.length).toBeLessThanOrEqual(25_000);
    expect(text).toContain("# ctscout deep dive `0123456789abcdef01234567`");
    expect(text).toContain("Response truncated to");
    expect(structured.result?.truncated).toBe(true);
    expect(structured.result?.domains.length).toBeLessThan(3000);
    expect(structured.snapshot).toBe("2026-08-31");
  });

  it("collapses the outer envelope of a done job's structuredContent around the rendered result", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")], { noise: "n".repeat(30_000) });
    const { text, structured } = formatJobAsMarkdown(job);
    expect(text).toContain("| `cna.com` |");
    expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
    expect(structured).not.toHaveProperty("noise");
    // The outer extras were the problem, so the rendered result survives.
    expect(structured).toMatchObject({
      job_id: "0123456789abcdef01234567",
      status: "done",
      result: { domains: [{ domain: "cna.com" }], snapshot: "2026-08-31" },
      snapshot: "2026-08-31",
      snapshot_source: "scan",
    });
  });

  it("bounds a zero-domain done job whose API-provided upgrade_hint is oversized", () => {
    const job = doneJob([]);
    job.result = {
      ...job.result,
      domains: [],
      truncated: true,
      upgrade_hint: "h".repeat(30_000),
    } as JobResponse["result"];
    const { text, structured } = formatJobAsMarkdown(job);
    expect(text.length).toBeLessThanOrEqual(25_000);
    expect(text).toMatch(/> h{199}…/);
    expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
  });

  it("drops non-rendered fields before domains: a 30k run_metadata keeps the shown domain", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")]);
    job.result = {
      ...job.result,
      run_metadata: { blob: "m".repeat(30_000) },
    } as JobResponse["result"];
    const { text, structured } = formatJobAsMarkdown(job);
    expect(text).toContain("| `cna.com` |");
    expect(text).toContain("> Response truncated: run_metadata omitted");
    expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
    expect(structured.result).not.toHaveProperty("run_metadata");
    expect(structured.result).toMatchObject({
      domains: [{ domain: "cna.com", attributed_to: "CNA Financial Corporation" }],
      entity: { company_name: "CNA Financial" },
      truncated: true,
      upgrade_hint: expect.stringContaining("omitted to stay under 25000 chars."),
    });
  });

  it("renders a schema-valid enrichment that carries only confidence_band", () => {
    const job = doneJob([
      {
        domain: "cna.com",
        attributed_to: "CNA Financial Corporation",
        enrichment: { confidence_band: "likely" } as DomainResult["enrichment"],
      },
    ]);
    const { text, structured } = formatJobAsMarkdown(job);
    expect(text).toContain(
      "| `cna.com` | CNA Financial Corporation | 🟢 likely | _none_ | _no evidence_ |",
    );
    expect(structured.result?.domains[0].enrichment).toEqual({ confidence_band: "likely" });
    expect(JSON.parse(truncateJobJsonIfNeeded(job).text)).toMatchObject({ status: "done" });
  });

  it("drops an oversized unknown result-level field before any known one", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")]);
    job.result = { ...job.result, future_field: "f".repeat(30_000) } as JobResponse["result"];
    const { text, structured } = formatJobAsMarkdown(job);
    expect(text).toContain("| `cna.com` |");
    expect(text).toContain("> Response truncated: unknown result fields omitted");
    expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
    expect(structured.result).not.toHaveProperty("future_field");
    expect(structured.result).toMatchObject({
      domains: [{ domain: "cna.com" }],
      run_metadata: { duration_ms: 270_000 },
      entity: { company_name: "CNA Financial" },
    });
  });

  it("re-measures with the hint attached: a record a strip step leaves just under the limit keeps its domains", () => {
    const build = (pad: number): JobResponse => {
      const job = doneJob([proDiscoveredDomain("cna.com")]);
      job.result = {
        ...job.result,
        signals_attempted: ["dns", "p".repeat(pad)],
      } as JobResponse["result"];
      return job;
    };
    const lengthAt = (pad: number) =>
      JSON.stringify(truncateJobJsonIfNeeded(build(pad)).structured).length;
    // Without run_metadata the record sits 5 chars under the limit: the strip
    // hint alone (about a hundred chars) would push it back over.
    const pad = 25_000 - 5 - lengthAt(0);
    expect(lengthAt(pad)).toBe(24_995);
    const job = build(pad);
    job.result = {
      ...job.result,
      run_metadata: { blob: "m".repeat(30_000) },
    } as JobResponse["result"];

    const markdown = formatJobAsMarkdown(job);
    expect(markdown.text.length).toBeLessThanOrEqual(25_000);
    expect(JSON.stringify(markdown.structured).length).toBeLessThanOrEqual(25_000);
    expect(markdown.structured.result?.domains).toEqual([
      expect.objectContaining({ domain: "cna.com" }),
    ]);
    expect(markdown.structured.result?.upgrade_hint).toContain(
      "omitted to stay under 25000 chars.",
    );

    const json = truncateJobJsonIfNeeded(job);
    expect(json.text.length).toBeLessThanOrEqual(25_000);
    expect(JSON.parse(json.text)).toEqual(json.structured);
    expect(json.structured.result?.domains).toHaveLength(1);
    expect(json.structured.result?.upgrade_hint).toContain("omitted to stay under 25000 chars.");
  });

  it("drops a domain's embedded base before any value in the row is cut", () => {
    const row = proDiscoveredDomain("cna.com");
    const job = doneJob([{ ...row, base: { ...(row.base as object), blob: "b".repeat(30_000) } }]);
    const { text, structured } = formatJobAsMarkdown(job);
    expect(text).toContain("| `cna.com` |");
    // Steps are cumulative: the non-rendered fields go first, whole.
    expect(text).toContain(
      "> Response truncated: run_metadata, entity, signals_attempted, domains[].base omitted",
    );
    expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
    expect(structured.result?.domains).toHaveLength(1);
    expect(structured.result?.domains[0]).not.toHaveProperty("base");
    expect(structured.result?.domains[0].enrichment?.confidence_band).toBe("verified");
    // The evidence map was not needed and survives into the rendered cell.
    expect(text).toContain("verified via google-site-verification");
  });

  it("keeps the worker's own upgrade_hint in front of the strip notice", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")]);
    job.result = {
      ...job.result,
      truncated: true,
      upgrade_hint: "Deep dive stopped at 50 domains (worker cap).",
      run_metadata: { blob: "m".repeat(30_000) },
    } as JobResponse["result"];
    const { text, structured } = formatJobAsMarkdown(job);
    expect(structured.result?.upgrade_hint).toMatch(
      /^Deep dive stopped at 50 domains \(worker cap\)\. Response truncated: run_metadata omitted/,
    );
    expect(text).toContain("Deep dive stopped at 50 domains (worker cap).");
    const json = truncateJobJsonIfNeeded(job);
    expect(json.structured.result?.upgrade_hint).toMatch(/^Deep dive stopped at 50 domains/);
  });

  it("builds the strip notice from the bounded worker hint, not the raw one", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")]);
    job.result = {
      ...job.result,
      truncated: true,
      upgrade_hint: `worker: ${"h".repeat(30_000)}`,
      run_metadata: { blob: "m".repeat(30_000) },
    } as JobResponse["result"];
    for (const { structured } of [formatJobAsMarkdown(job), truncateJobJsonIfNeeded(job)]) {
      expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
      expect(structured.result?.domains).toHaveLength(1);
      expect(structured.result?.upgrade_hint).toMatch(
        /^worker: h+.*Response truncated: run_metadata omitted/,
      );
    }
  });

  it("reports the original total when both the record and the rendering pass halve", () => {
    // Tiny rows: the compact record holds far more of them than the
    // rendered table does, so the markdown pass halves what the record
    // pass already halved.
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      domain: `d${i}.cna.com`,
      attributed_to: "CNA Financial Corporation",
      is_seed: false,
    }));
    const { text, structured } = formatJobAsMarkdown(doneJob(rows));
    expect(text.length).toBeLessThanOrEqual(25_000);
    const kept = structured.result?.domains.length ?? 0;
    expect(kept).toBeGreaterThan(0);
    expect(structured.result?.upgrade_hint).toContain(
      `Response truncated to ${kept} of 2000 domains`,
    );
    expect(text).toContain(`of 2000 domains`);
  });

  it("bounds oversized worker_version and result job_id before halving domains", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")]);
    job.result = {
      ...job.result,
      worker_version: "v".repeat(30_000),
      job_id: "j".repeat(30_000),
    } as JobResponse["result"];
    for (const { structured } of [formatJobAsMarkdown(job), truncateJobJsonIfNeeded(job)]) {
      expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
      expect(structured.result?.domains).toHaveLength(1);
      expect(structured.result?.worker_version).toContain("…(truncated, 30000 chars total)");
    }
  });

  it("drops unknown row and enrichment fields before halving domains", () => {
    const row = proDiscoveredDomain("cna.com");
    const job = doneJob([
      {
        ...row,
        future_row_field: "r".repeat(20_000),
        enrichment: { ...row.enrichment, future_signal: "e".repeat(20_000) },
      } as DomainResult,
    ]);
    for (const { structured } of [formatJobAsMarkdown(job), truncateJobJsonIfNeeded(job)]) {
      expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
      expect(structured.result?.domains).toHaveLength(1);
      expect(structured.result?.domains[0]).not.toHaveProperty("future_row_field");
      expect(structured.result?.domains[0].enrichment).not.toHaveProperty("future_signal");
      expect(structured.result?.domains[0].enrichment?.confidence_band).toBe("verified");
      expect(structured.result?.upgrade_hint).toContain("unknown domain fields omitted");
    }
  });

  it("keeps cert_org_names / rdap_org through the unknown-field strip so the org still renders", () => {
    // The strip keeps only the keys DeepDiveDomainSchema declares. A row whose
    // organization is available only through the fallback fields must still
    // name it after truncation, in the text and in the record.
    const { enrichment } = proDiscoveredDomain("cna.com");
    const oversized = "r".repeat(30_000);
    const cases: Array<[DomainResult, string]> = [
      [
        { domain: "cna.com", cert_org_names: ["CNA Financial Corporation"], enrichment },
        "CNA Financial Corporation",
      ],
      [{ domain: "cna.com", rdap_org: "CNA RDAP Org", enrichment }, "CNA RDAP Org"],
    ];
    for (const [row, org] of cases) {
      const job = doneJob([{ ...row, future_row_field: oversized } as DomainResult]);
      const { text, structured } = formatJobAsMarkdown(job);
      expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
      expect(structured.result?.domains).toHaveLength(1);
      expect(structured.result?.domains[0]).not.toHaveProperty("future_row_field");
      expect(structured.result?.upgrade_hint).toContain("unknown domain fields omitted");
      expect(text).toContain(`| \`cna.com\` | ${org} | ✅ verified |`);
      expect(text).not.toContain("| `cna.com` | — |");
    }
  });

  it("drops an oversized signals_attempted before halving domains", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")]);
    job.result = {
      ...job.result,
      signals_attempted: ["dns", "s".repeat(30_000)],
    } as JobResponse["result"];
    for (const { structured } of [formatJobAsMarkdown(job), truncateJobJsonIfNeeded(job)]) {
      expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
      expect(structured.result?.domains).toHaveLength(1);
      expect(structured.result).not.toHaveProperty("signals_attempted");
      expect(structured.result?.upgrade_hint).toContain("signals_attempted omitted");
    }
  });

  it("appends the halving notice to the hint already on the record", () => {
    const rows = Array.from({ length: 400 }, (_, i) => proDiscoveredDomain(`d${i}.cna.com`));
    const job = doneJob(rows);
    job.result = {
      ...job.result,
      truncated: true,
      upgrade_hint: "Deep dive stopped at 400 domains (worker cap).",
    } as JobResponse["result"];
    for (const { structured } of [formatJobAsMarkdown(job), truncateJobJsonIfNeeded(job)]) {
      expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
      const kept = structured.result?.domains.length ?? 0;
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(400);
      const hint = structured.result?.upgrade_hint ?? "";
      expect(hint).toMatch(/^Response truncated to \d+ of 400 domains/);
      expect(hint).toContain("Deep dive stopped at 400 domains (worker cap).");
      // Halved twice (record, then rendering) but one halving notice.
      expect(hint.match(/Response truncated to/g)).toHaveLength(1);
    }
  });

  it("halves the structured record when the strip hint alone pushes it over budget", () => {
    // Many small rows: after the strip steps the compact record sits just
    // under the limit, and the attached hint tips it over. The markdown
    // still fits, so the structured record must be halved, not emptied.
    const rows = Array.from({ length: 170 }, (_, i) => ({
      ...proDiscoveredDomain(`d${i}.cna.com`),
      base: { domain: `d${i}.cna.com`, confidence: 0.9, sources: ["ct_org_match"] },
    }));
    const job = doneJob(rows);
    for (let n = 170; n >= 100; n -= 1) {
      const trial = doneJob(rows.slice(0, n));
      const { structured } = formatJobAsMarkdown(trial);
      expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
      // Never the empty minimal envelope while the rows can fit by halving.
      expect(structured.result?.domains.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(formatJobAsMarkdown(job).structured).length).toBeLessThanOrEqual(25_000);
  });

  it("leaves absent evidence / signal_health maps absent when stripping over-budget rows", () => {
    const sparse = (i: number): DomainResult => ({
      domain: `d${i}.cna.com`,
      attributed_to: "CNA Financial Corporation",
      is_seed: false,
      // The wire shape may omit the maps the type marks required; the strip
      // step must not synthesize them.
      enrichment: {
        confidence_band: "likely",
        weight_total: 1.5,
        matched_via: ["rdap_registrant_match"],
      } as unknown as DomainResult["enrichment"],
    });
    const rows = Array.from({ length: 400 }, (_, i) => sparse(i));
    const { structured } = formatJobAsMarkdown(doneJob(rows));
    expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
    for (const row of structured.result?.domains ?? []) {
      expect(row.enrichment).not.toHaveProperty("evidence");
      expect(row.enrichment).not.toHaveProperty("signal_health");
    }
    expect(structured.result?.upgrade_hint).not.toContain("evidence / signal_health");
  });

  it("collapses a not-done record's structuredContent to the bounded envelope", () => {
    const { text, structured } = formatJobAsMarkdown({
      job_id: "abc",
      kind: "deep_dive",
      status: "running",
      submitted_at: "2026-09-04T10:00:00Z",
      started_at: "2026-09-04T10:05:00Z",
      noise: "n".repeat(30_000),
    });
    expect(text.length).toBeLessThanOrEqual(25_000);
    expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
    expect(structured).toEqual({
      job_id: "abc",
      kind: "deep_dive",
      status: "running",
      submitted_at: "2026-09-04T10:00:00Z",
      started_at: "2026-09-04T10:05:00Z",
      finished_at: undefined,
      snapshot: null,
      snapshot_source: "unavailable",
    });
  });
});

describe("truncateJobJsonIfNeeded", () => {
  it("pretty-prints a small record with the resolved snapshot fields", () => {
    const { text, structured } = truncateJobJsonIfNeeded(doneJob([proDiscoveredDomain("cna.com")]));
    expect(JSON.parse(text)).toEqual(structured);
    expect(text).toContain("\n  ");
    expect(structured).toMatchObject({
      status: "done",
      snapshot: "2026-08-31",
      snapshot_source: "scan",
      result: { domains: [{ domain: "cna.com" }], snapshot: "2026-08-31" },
    });
  });

  it("returns a queued record with null / unavailable snapshot fields", () => {
    const { structured } = truncateJobJsonIfNeeded({
      job_id: "abc",
      status: "queued",
      submitted_at: "2026-09-04T10:00:00Z",
    });
    expect(structured).toEqual({
      job_id: "abc",
      status: "queued",
      submitted_at: "2026-09-04T10:00:00Z",
      snapshot: null,
      snapshot_source: "unavailable",
    });
  });

  it("halves the result's domains inside the envelope until the whole record fits", () => {
    const many = Array.from({ length: 3000 }, (_, i) => proDiscoveredDomain(`d-${i}.example`));
    const { text, structured } = truncateJobJsonIfNeeded(doneJob(many));
    expect(text.length).toBeLessThanOrEqual(25_000);
    const parsed = JSON.parse(text) as JobResponse;
    expect(parsed).toEqual(structured);
    expect(parsed.job_id).toBe("0123456789abcdef01234567");
    expect(parsed.result?.truncated).toBe(true);
    expect(parsed.result?.domains.length).toBeGreaterThan(0);
    expect(parsed.snapshot).toBe("2026-08-31");
  });

  it("keeps a 21-entry matched_via when dropping run_metadata alone makes the record fit", () => {
    const row = proDiscoveredDomain("cna.com");
    const job = doneJob([
      {
        ...row,
        enrichment: {
          ...row.enrichment,
          matched_via: Array.from({ length: 21 }, (_, i) => `s${i}`),
        },
      },
    ]);
    job.result = {
      ...job.result,
      run_metadata: { blob: "m".repeat(30_000) },
    } as JobResponse["result"];
    const { structured } = truncateJobJsonIfNeeded(job);
    expect(structured.result?.domains[0].enrichment?.matched_via).toHaveLength(21);
    expect(structured.result?.upgrade_hint).not.toContain("oversized values");
  });

  it("keeps the priority evidence key when an oversized evidence map is cut", () => {
    const row = proDiscoveredDomain("cna.com");
    const filler = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`zz_${i}`, "v".repeat(500)]),
    );
    const job = doneJob([
      {
        ...row,
        attributed_to: "x".repeat(30_000),
        enrichment: {
          ...row.enrichment,
          evidence: { ...filler, dns_txt_brand_token: "verified via google-site-verification" },
        },
      },
    ]);
    const { text, structured } = formatJobAsMarkdown(job);
    expect(structured.result?.domains).toHaveLength(1);
    const evidence = structured.result?.domains[0].enrichment?.evidence ?? {};
    expect(Object.keys(evidence)).toHaveLength(20);
    expect(evidence.dns_txt_brand_token).toBe("verified via google-site-verification");
    expect(text).toContain("verified via google-site-verification");
  });

  it("warns in the markdown when the run's signals were degraded", () => {
    const degraded = doneJob([proDiscoveredDomain("cna.com")]);
    degraded.result = { ...degraded.result, signals_degraded: true } as JobResponse["result"];
    expect(formatJobAsMarkdown(degraded).text).toContain("Signals degraded");
    expect(formatJobAsMarkdown(doneJob([proDiscoveredDomain("cna.com")])).text).not.toContain(
      "Signals degraded",
    );
  });

  it("drops a large candidates list before any attributed domain", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")]);
    job.result = {
      ...job.result,
      candidates: Array.from({ length: 1500 }, (_, i) => ({
        org: `c${i}`,
        similarity: 0.5,
        domains: [],
      })),
    } as unknown as JobResponse["result"];
    for (const { structured } of [formatJobAsMarkdown(job), truncateJobJsonIfNeeded(job)]) {
      expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
      expect(structured.result?.domains).toHaveLength(1);
      expect(structured.result).not.toHaveProperty("candidates");
      expect(structured.result?.upgrade_hint).toContain("candidates omitted");
    }
  });

  it("drops every domain's embedded base before any domain itself", () => {
    // Many rows whose bases are within the per-value caps but add up: the
    // base step goes before halving.
    const base = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${i}`, "b".repeat(150)]),
    );
    const rows = Array.from({ length: 40 }, (_, i) => ({
      ...proDiscoveredDomain(`d${i}.cna.com`),
      base,
    }));
    const { text, structured } = formatJobAsMarkdown(doneJob(rows));
    expect(text).toContain("domains[].base omitted");
    expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
    const kept = structured.result?.domains ?? [];
    expect(kept.length).toBeGreaterThan(0);
    for (const row of kept) expect(row).not.toHaveProperty("base");
  });

  it("omits a result or error the API attached to a record that is not done or failed", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")], {
      status: "running",
      finished_at: null,
      error: "stale: from an earlier attempt",
    });
    for (const { structured } of [formatJobAsMarkdown(job), truncateJobJsonIfNeeded(job)]) {
      expect(structured.status).toBe("running");
      expect(structured).not.toHaveProperty("result");
      expect(structured).not.toHaveProperty("error");
      expect(structured.snapshot).toBeNull();
      expect(structured.snapshot_source).toBe("unavailable");
    }
    const done = doneJob([proDiscoveredDomain("cna.com")], {
      error: "stale: from an earlier attempt",
    });
    for (const { structured } of [formatJobAsMarkdown(done), truncateJobJsonIfNeeded(done)]) {
      expect(structured.result?.domains).toHaveLength(1);
      expect(structured).not.toHaveProperty("error");
    }
    const failed = doneJob([], { status: "failed", error: "timeout: crt.sh" });
    expect(formatJobAsMarkdown(failed).structured.error).toBe("timeout: crt.sh");
    expect(formatJobAsMarkdown(failed).structured).not.toHaveProperty("result");
  });

  it("keeps a row whose own values are oversized by bounding them, not by dropping it", () => {
    const row = proDiscoveredDomain("cna.com");
    const huge = {
      ...row,
      attributed_to: "x".repeat(30_000),
      enrichment: {
        ...row.enrichment,
        matched_via: Array.from({ length: 5000 }, (_, i) => `signal_${i}`).concat(
          "s".repeat(30_000),
        ),
      },
    };
    for (const { structured } of [
      formatJobAsMarkdown(doneJob([huge])),
      truncateJobJsonIfNeeded(doneJob([huge])),
    ]) {
      expect(JSON.stringify(structured).length).toBeLessThanOrEqual(25_000);
      const kept = structured.result?.domains;
      expect(kept).toHaveLength(1);
      expect(kept?.[0].attributed_to).toContain("…(truncated, 30000 chars total)");
      expect(kept?.[0].enrichment?.matched_via).toHaveLength(20);
      expect(kept?.[0].enrichment?.confidence_band).toBe("verified");
      expect(structured.result?.upgrade_hint).toContain("domains[] oversized values omitted");
    }
  });

  it("drops an oversized unknown top-level field first and keeps the result intact", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")], { noise: "n".repeat(30_000) });
    const { text, structured } = truncateJobJsonIfNeeded(job);
    expect(text.length).toBeLessThanOrEqual(25_000);
    const parsed = JSON.parse(text) as JobResponse;
    expect(parsed).toEqual(structured);
    expect(parsed).not.toHaveProperty("noise");
    expect(parsed).toMatchObject({
      job_id: "0123456789abcdef01234567",
      kind: "deep_dive",
      status: "done",
      submitted_at: "2026-09-04T10:00:00Z",
      started_at: "2026-09-04T10:05:00Z",
      finished_at: "2026-09-04T10:09:30Z",
      result: {
        domains: [{ domain: "cna.com" }],
        run_metadata: { duration_ms: 270_000 },
        truncated: true,
        upgrade_hint: expect.stringContaining("unknown job fields omitted"),
        snapshot: "2026-08-31",
        snapshot_source: "scan",
      },
      snapshot: "2026-08-31",
      snapshot_source: "scan",
    });
  });

  it("drops non-rendered fields before halving domains in JSON too", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")]);
    job.result = {
      ...job.result,
      run_metadata: { blob: "m".repeat(30_000) },
    } as JobResponse["result"];
    const { text, structured } = truncateJobJsonIfNeeded(job);
    expect(text.length).toBeLessThanOrEqual(25_000);
    expect(JSON.parse(text)).toEqual(structured);
    expect(structured.result).not.toHaveProperty("run_metadata");
    expect(structured.result?.domains).toEqual([expect.objectContaining({ domain: "cna.com" })]);
    expect(structured.result?.upgrade_hint).toContain("run_metadata omitted");
  });

  it("bounds every string the final envelopes keep: an oversized source / empty_reason / error still fits", () => {
    const job = doneJob([proDiscoveredDomain("cna.com")], {
      error: "e".repeat(30_000),
    });
    job.result = {
      ...job.result,
      domains: [],
      source: "s".repeat(30_000),
      empty_reason: "r".repeat(30_000),
    } as JobResponse["result"];
    const { text, structured } = truncateJobJsonIfNeeded(job);
    expect(text.length).toBeLessThanOrEqual(25_000);
    const parsed = JSON.parse(text) as JobResponse;
    expect(parsed).toEqual(structured);
    // Capping a scalar is lossless for anything sane, so it is not reported.
    expect(parsed.result?.truncated).toBeUndefined();
    for (const value of [parsed.result?.source, parsed.result?.empty_reason]) {
      expect(value).toMatch(/^.{200}…\(truncated, 30000 chars total\)$/);
    }
    // A done record carries no error, whatever the API attached.
    expect(parsed).not.toHaveProperty("error");
    expect(parsed.snapshot).toBe("2026-08-31");

    const failed = truncateJobJsonIfNeeded(
      doneJob([], { status: "failed", error: "e".repeat(30_000) }),
    );
    expect(failed.text.length).toBeLessThanOrEqual(25_000);
    expect(failed.structured.error).toMatch(/^.{200}…\(truncated, 30000 chars total\)$/);
  });

  it("bounds a result-less record that is over budget by dropping unknown fields", () => {
    const { text, structured } = truncateJobJsonIfNeeded({
      job_id: "abc",
      status: "failed",
      submitted_at: "2026-09-04T10:00:00Z",
      error: "e".repeat(30_000),
      noise: "n".repeat(30_000),
    });
    expect(text.length).toBeLessThanOrEqual(25_000);
    expect(structured).not.toHaveProperty("noise");
    expect(structured.error).toContain("truncated, 30000 chars total");
    expect(structured.snapshot_source).toBe("unavailable");
  });
});

describe("formatScanAsMarkdown — ProDiscoveredDomain rows (deep-dive result shape)", () => {
  it("renders `domain` + `enrichment` rows through the band table", () => {
    const md = formatScanAsMarkdown("CNA Financial", {
      domains: [proDiscoveredDomain("cna.com")],
      source: "live-enriched",
    });
    expect(md).toContain("| Domain | Attributed to | Band | Signals | Evidence |");
    expect(md).not.toContain("| Domain | Attributed to | Confidence | Sources | Evidence |");
    expect(md).toContain("| `cna.com` | CNA Financial Corporation | ✅ verified |");
  });

  it("reads the Pro shape from the source and later rows when the first row is degraded", () => {
    const md = formatScanAsMarkdown("CNA Financial", {
      domains: [
        { domain: "degraded.cna.com", attributed_to: "CNA Financial Corporation", is_seed: false },
        proDiscoveredDomain("cna.com"),
      ],
      source: "live-enriched",
      signals_degraded: true,
    });
    expect(md).toContain("| Domain | Attributed to | Band | Signals | Evidence |");
    expect(md).toContain("| `cna.com` | CNA Financial Corporation | ✅ verified |");
    expect(md).toContain("| `degraded.cna.com` | CNA Financial Corporation |");
  });

  it("keeps a warehouse response with attributed_to on a row in the free-tier table", () => {
    const md = formatScanAsMarkdown(
      "Coalition",
      freeResponse([
        {
          org: "Coalition Inc",
          apex_domain: "coalitioninc.com",
          cert_count: 12,
          attributed_to: "Coalition Inc",
        },
      ]),
    );
    expect(md).toContain("coalitioninc.com");
    expect(md).not.toContain("| Domain | Attributed to | Band | Signals | Evidence |");
    expect(md).not.toContain("_missing_");
  });

  it("renders an all-degraded deep dive without source through the band table", () => {
    const md = formatScanAsMarkdown("CNA Financial", {
      domains: [
        { domain: "a.cna.com", attributed_to: "CNA Financial Corporation", is_seed: false },
        { domain: "b.cna.com", attributed_to: "CNA Financial Corporation", is_seed: true },
      ],
      signals_degraded: true,
    });
    expect(md).toContain("| Domain | Attributed to | Band | Signals | Evidence |");
    expect(md).toContain("| `a.cna.com` | CNA Financial Corporation |");
    expect(md).not.toContain("| Domain | Attributed to | Confidence | Sources | Evidence |");
  });

  it("never derives a band from a numeric confidence on a row without enrichment", () => {
    // The retired origin returned `{domain, confidence, ...}` rows and this
    // package used to bucket the float into a band (ctscout-mcp#99). Such a
    // row now renders through the warehouse table with no band at all.
    const md = formatScanAsMarkdown("CNA Financial", {
      domains: [{ domain: "cna.com", confidence: 0.95, sources: ["ct_org_match"] }],
    });
    expect(md).toContain("| Domain | Attributed to | Certs | Subdomains |");
    expect(md).toContain("| `cna.com` |");
    expect(md).not.toContain("| Domain | Attributed to | Confidence | Sources | Evidence |");
    expect(md).not.toMatch(/verified|likely|possible|insufficient|low/);
    expect(md).not.toContain("0.95");
    expect(md).not.toContain("Pro tier");
  });
});
