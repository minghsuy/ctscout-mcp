/**
 * Tests for ctscout-mcp-server v0.2.0.
 *
 * Covers:
 *   - Free-tier response rendering (existing v0.1.0 shape unchanged)
 *   - Pro-tier response rendering (new confidence_band / evidence / etc.)
 *   - Mixed-tier degraded apex (Phase 5's `_degraded()` insufficient row)
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

import {
  ApiError,
  SERVER_VERSION,
  TimeoutError,
  callScan,
  explainError,
  formatScanAsMarkdown,
  truncateIfNeeded,
  truncateJsonIfNeeded,
  getApiKey,
} from "../src/index.ts";
import type { DomainResult, ScanResponse } from "../src/index.ts";

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
    expect(md).toContain("| Domain | Organization | Certs | Subdomains |");
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
      domains: [
        { org: "X", apex_domain: "x.com", cert_count: 1, subdomain_count: 1 },
      ],
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

  it("handles origin-shaped data correctly mapped to warehouse table fields", () => {
    const md = formatScanAsMarkdown(
      "Origin Data",
      freeResponse([
        {
          // Instead of apex_domain, we have domain from origin
          domain: "origindomain.com",
          // Instead of org, we have cert_org_names from origin
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
      matched_via: [
        "dns_txt_brand_token",
        "og_site_name_match",
        "vlm_verdict_verified",
      ],
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

  it("handles missing fields in Phase 5 Pro table (undefined-cells bug) gracefully", () => {
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

  it("handles origin fields mapping in Phase 5 Pro table correctly", () => {
    const md = formatScanAsMarkdown(
      "Missing Pro Co",
      proResponse([
        {
          apex_domain: "origin-pro.com", // Add apex_domain to prevent it from being classified as ScoutResult
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
    expect(md).toContain("| `origin-pro.com` | Origin RDAP Org | ⚪ insufficient | _none_ | _no evidence_ |");
  });

  it("handles missing fields in degraded Phase 5 Pro table (undefined-cells bug) gracefully", () => {
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

  it("handles origin fields mapping in degraded Phase 5 Pro table correctly", () => {
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
    expect(md).toContain("| `evil.com│x` | Evil Inc corp | ✅ verified | dns_txt_brand_token, og_site_name_match, vlm_verdict_verified | verified via google-site-verification, atlassian-domain-verification |");
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
    // Phase 5's _degraded() helper produces rows with no enrichment field
    const degradedRow: DomainResult = {
      org: "Test Co",
      apex_domain: "broken.example",
      cert_count: 0,
      subdomain_count: 0,
      attributed_to: "Test Co",
      // No enrichment field — degraded path
    };
    const md = formatScanAsMarkdown(
      "Test Co",
      proResponse([verifiedRow, degradedRow]),
    );
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
          dns_txt_brand_token: 'verified | including spurious | pipe characters',
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
    // Phase 5 _degraded() helper produces rows with no `enrichment` field
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

  it("zeroes out domains when a single domain still exceeds the limit", () => {
    // Construct a 1-domain response whose markdown is over the limit by
    // giving it a very large evidence string that inflates the rendered text.
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
    expect(md.length).toBeGreaterThan(25_000);
    const result = truncateIfNeeded(md, resp, "Big Co");
    expect(result.text.length).toBeLessThanOrEqual(25_000);
    expect(result.structured.domains.length).toBe(0);
    expect(result.structured.truncated).toBe(true);
    expect(result.structured.upgrade_hint).toContain("0 of 1 domains");
  });

  it("no longer recommends response_format='json' as the size escape hatch (#42)", () => {
    const bigEvidence = "x".repeat(30_000);
    const resp = proResponse([
      {
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
      },
    ]);
    const md = formatScanAsMarkdown("Big Co", resp);
    const result = truncateIfNeeded(md, resp, "Big Co");
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

  it("markdown text explains the size-based drop (not 'No domains found') when a single domain is zeroed (#41 fold-in)", () => {
    // 1-domain response whose markdown alone exceeds the limit → truncation
    // zeroes domains to []. The visible text must NOT say "No domains found";
    // it must explain the domain was dropped for exceeding the size limit and
    // surface the upgrade_hint.
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
    const result = truncateIfNeeded(md, resp, "Big Co");
    expect(result.structured.domains.length).toBe(0);
    expect(result.text).not.toContain("No domains found");
    expect(result.text).toContain("# ctscout results for: Big Co");
    expect(result.text).toContain("size limit");
    expect(result.text).toContain("dropped");
    expect(result.text).toContain("Response truncated");
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
      ...freeResponse([
        { org: "X", apex_domain: "x.com", cert_count: 1, subdomain_count: 1 },
      ]),
      run_metadata: { blob: "x".repeat(30_000) },
    };
    const result = truncateJsonIfNeeded(resp);
    expect(result.text.length).toBeLessThanOrEqual(25_000);
    const parsed = JSON.parse(result.text) as ScanResponse;
    expect(parsed.domains).toEqual([]);
    expect(parsed.truncated).toBe(true);
    expect(parsed.upgrade_hint).toContain("Response truncated");
    expect(parsed.source).toBe("warehouse");
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
    const maliciousBody = "Error `code` with [link](https://evil.com) and ![img](foo) and _italic_ and *bold*";
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
    const err = new Error(
      "CTSCOUT_API_KEY environment variable is not set. ...",
    );
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

// ---------- ScoutResult-shape rendering (real Pro tier from origin) ----------
//
// The Spark origin (domain-scout-api on DGX) proxies the raw ScoutResult
// from the domain-scout library verbatim. That shape has no top-level
// `source` field, and each domain has `{domain, confidence, sources[],
// evidence[], cert_org_names[], ...}` — NOT the warehouse shape.
//
// SCOUT_RESULT_FIXTURE below is captured from
// `tools/call ctscout_search_company {"company_name":"CNA Financial"}`
// against ctscout.dev/mcp on 2026-05-15, trimmed to two representative
// domains (real response had 13). This is the same fixture used in
// ctscout-worker#56's test/format-as-markdown.spec.ts.

const SCOUT_RESULT_FIXTURE: ScanResponse = {
  domains: [
    {
      domain: "cnacentral.com",
      confidence: 0.95,
      sources: ["ct_org_match", "shared_infra"],
      evidence: [
        {
          source_type: "ct_org_match",
          description:
            "Cert org 'CNA Financial Corporation' matches target (score=1.00)",
          signal_type: "cert_org_match",
          signal_weight: 0.8,
        },
        {
          source_type: "shared_infra",
          description: "Shares infrastructure with cna.com",
          signal_type: "shared_infrastructure",
          signal_weight: 0.1,
        },
      ],
      cert_org_names: ["CNA Financial Corporation"],
      first_seen: "2023-05-09T00:00:00",
      last_seen: "2024-12-05T23:59:59",
      resolves: true,
      rdap_org: null,
      is_seed: false,
      seed_sources: [],
    },
    {
      domain: "cnasurety.com",
      confidence: 0.9,
      sources: ["ct_org_match"],
      evidence: [
        {
          source_type: "ct_org_match",
          description:
            "Cert org 'CNA Financial Corporation' matches target (score=1.00)",
          signal_type: "cert_org_match",
          signal_weight: 0.8,
        },
      ],
      cert_org_names: ["CNA Financial Corporation"],
      first_seen: "2023-05-09T00:00:00",
      last_seen: "2024-12-07T23:59:59",
      resolves: true,
      rdap_org: null,
      is_seed: false,
      seed_sources: [],
    },
  ],
};

describe("formatScanAsMarkdown — Pro tier (real ScoutResult shape)", () => {
  const md = formatScanAsMarkdown("CNA Financial", SCOUT_RESULT_FIXTURE);

  it("does not contain 'undefined' anywhere in the output", () => {
    // Pre-fix regression guard: every cell rendered as `undefined` because
    // the formatter expected warehouse/enrichment shape.
    expect(md).not.toContain("undefined");
  });

  it("uses the ScoutResult table header (Domain / Org / Confidence / Sources / Evidence)", () => {
    expect(md).toContain("| Domain | Org | Confidence | Sources | Evidence |");
  });

  it("renders the actual domain string from `domain` (not apex_domain)", () => {
    expect(md).toContain("`cnacentral.com`");
    expect(md).toContain("`cnasurety.com`");
  });

  it("renders the org from cert_org_names[0]", () => {
    expect(md).toContain("CNA Financial Corporation");
  });

  it("maps confidence float to a band + numeric (verified for >=0.9)", () => {
    expect(md).toContain("verified (0.95)");
    expect(md).toContain("verified (0.90)");
  });

  it("renders sources as a comma-joined list", () => {
    expect(md).toContain("ct_org_match, shared_infra");
  });

  it("renders the first evidence description", () => {
    expect(md).toContain(
      "Cert org 'CNA Financial Corporation' matches target",
    );
  });

  it("marks the response as Pro tier in the header", () => {
    expect(md).toContain("_(Pro tier — multi-signal attribution)_");
  });

  it("handles missing `total` (ScoutResult doesn't carry it) by falling back to domains.length", () => {
    // Pre-fix: would have rendered "of undefined total" because the type
    // required `total` and the fixture/origin doesn't provide it.
    expect(md).toContain("**2** domain(s) of 2 total");
    expect(md).not.toContain("undefined");
  });

  it("handles missing `source` field with a sensible label", () => {
    expect(md).toContain("Source: `scout-result`");
  });
});

describe("formatScanAsMarkdown — ScoutResult confidence band thresholds", () => {
  function scoutResultWithConfidence(c: number | null | undefined): ScanResponse {
    return {
      domains: [
        {
          domain: "x.com",
          confidence: c,
          sources: ["s"],
          evidence: [{ description: "e" }],
          cert_org_names: ["Org"],
        },
      ],
    };
  }

  it("0.95 -> verified", () => {
    expect(formatScanAsMarkdown("Test", scoutResultWithConfidence(0.95))).toContain(
      "verified (0.95)",
    );
  });
  it("0.80 -> likely", () => {
    expect(formatScanAsMarkdown("Test", scoutResultWithConfidence(0.8))).toContain(
      "likely (0.80)",
    );
  });
  it("0.60 -> possible", () => {
    expect(formatScanAsMarkdown("Test", scoutResultWithConfidence(0.6))).toContain(
      "possible (0.60)",
    );
  });
  it("0.30 -> low", () => {
    expect(formatScanAsMarkdown("Test", scoutResultWithConfidence(0.3))).toContain(
      "low (0.30)",
    );
  });
  it("null confidence does not crash (regression guard for .toFixed on null)", () => {
    // Pre-fix this would throw `TypeError: Cannot read properties of null
    // (reading 'toFixed')` if confidence came in as null. The fix uses
    // loose `!= null` instead of strict `!== undefined`.
    const md = formatScanAsMarkdown("Test", scoutResultWithConfidence(null));
    expect(md).toContain("`x.com`");
    expect(md).toContain("| — |");
    expect(md).not.toContain("undefined");
  });
  it("undefined confidence renders em-dash placeholder", () => {
    const md = formatScanAsMarkdown("Test", scoutResultWithConfidence(undefined));
    expect(md).toContain("`x.com`");
    expect(md).toContain("| — |");
  });
});

describe("formatScanAsMarkdown — ScoutResult edge cases", () => {
  it("pipe characters in field values don't break the table", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          domain: "x.com",
          confidence: 0.9,
          sources: ["s"],
          evidence: [{ description: "has a | pipe in it" }],
          cert_org_names: ["Org | Inc"],
        },
      ],
    });
    const row = md.split("\n").find((l) => l.includes("x.com")) as string;
    expect(row).toBeDefined();
    // Each ScoutResult row has exactly 6 pipes (5 cells + leading/trailing).
    expect((row.match(/\|/g) ?? []).length).toBe(6);
  });

  it("empty evidence description falls back to em-dash via cellSafe", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          domain: "x.com",
          confidence: 0.9,
          sources: ["s"],
          evidence: [{ description: "" }],
          cert_org_names: ["Org"],
        },
      ],
    });
    const row = md.split("\n").find((l) => l.includes("x.com")) as string;
    expect(row).toMatch(/\| — \|$/);
  });

  it("missing evidence array falls back to em-dash", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          domain: "x.com",
          confidence: 0.9,
          sources: ["s"],
          evidence: [],
          cert_org_names: ["Org"],
        },
      ],
    });
    const row = md.split("\n").find((l) => l.includes("x.com")) as string;
    expect(row).toMatch(/\| — \|$/);
  });

  it("missing cert_org_names falls back to rdap_org, then em-dash", () => {
    const md1 = formatScanAsMarkdown("Test", {
      domains: [
        {
          domain: "x.com",
          confidence: 0.9,
          sources: ["s"],
          evidence: [{ description: "e" }],
          rdap_org: "Org From RDAP",
        },
      ],
    });
    expect(md1).toContain("Org From RDAP");

    const md2 = formatScanAsMarkdown("Test", {
      domains: [
        {
          domain: "x.com",
          confidence: 0.9,
          sources: ["s"],
          evidence: [{ description: "e" }],
        },
      ],
    });
    const row = md2.split("\n").find((l) => l.includes("x.com")) as string;
    // Second cell (Org) should be em-dash when neither cert_org_names nor
    // rdap_org are present.
    const cells = row.split("|").map((c) => c.trim());
    expect(cells[2]).toBe("—");
  });
});

// ---------- Iter-1 fixes from bot review on PR #15 ----------

describe("formatScanAsMarkdown - ScoutResult sources overflow indicator", () => {
  it("shows '+N' for sources beyond the inline limit (4)", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          domain: "x.com",
          confidence: 0.9,
          sources: ["a", "b", "c", "d", "e", "f"],
          evidence: [{ description: "e" }],
          cert_org_names: ["Org"],
        },
      ],
    });
    // First 4 inline + "+2" overflow.
    expect(md).toContain("a, b, c, d, +2");
  });

  it("no overflow indicator when sources <= inline limit", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [
        {
          domain: "x.com",
          confidence: 0.9,
          sources: ["a", "b", "c"],
          evidence: [{ description: "e" }],
          cert_org_names: ["Org"],
        },
      ],
    });
    expect(md).toContain("a, b, c");
    expect(md).not.toContain("+0");
    expect(md).not.toMatch(/\+\d/);
  });
});

describe("formatScanAsMarkdown - ScoutResult description type guard", () => {
  // The `evidence` element type is Record<string, unknown>, so `description`
  // is `unknown`. The formatter type-guards instead of casting so non-string
  // values fall back to em-dash rather than being stringified to gibberish.

  function withEvidenceDescription(description: unknown): string {
    return formatScanAsMarkdown("Test", {
      domains: [
        {
          domain: "x.com",
          confidence: 0.9,
          sources: ["s"],
          evidence: [{ description }],
          cert_org_names: ["Org"],
        },
      ],
    });
  }

  it("string description renders as-is", () => {
    expect(withEvidenceDescription("real evidence text")).toContain(
      "real evidence text",
    );
  });

  it("number description does NOT leak as '42' or similar - em-dash instead", () => {
    const md = withEvidenceDescription(42);
    const row = md.split("\n").find((l) => l.includes("x.com")) as string;
    expect(row).toBeDefined();
    expect(row).toMatch(/\| — \|$/);
    expect(row).not.toContain("42");
  });

  it("object description does NOT render as '[object Object]' - em-dash instead", () => {
    const md = withEvidenceDescription({ nested: "object" });
    const row = md.split("\n").find((l) => l.includes("x.com")) as string;
    expect(row).toMatch(/\| — \|$/);
    expect(row).not.toContain("[object Object]");
  });

  it("null description renders em-dash, not 'null'", () => {
    const md = withEvidenceDescription(null);
    const row = md.split("\n").find((l) => l.includes("x.com")) as string;
    expect(row).toMatch(/\| — \|$/);
    expect(row).not.toContain("null");
  });

  it("undefined description renders em-dash", () => {
    const md = withEvidenceDescription(undefined);
    const row = md.split("\n").find((l) => l.includes("x.com")) as string;
    expect(row).toMatch(/\| — \|$/);
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
      })
    );
    expect(result).toEqual(mockResponse);
  });

  it("throws error if CTSCOUT_API_KEY is not set", async () => {
    delete process.env.CTSCOUT_API_KEY;
    await expect(callScan({ company_name: "Test" })).rejects.toThrow(
      "CTSCOUT_API_KEY environment variable is not set"
    );
  });

  it("throws error if CTSCOUT_API_KEY is empty", async () => {
    process.env.CTSCOUT_API_KEY = "   ";
    await expect(callScan({ company_name: "Test" })).rejects.toThrow(
      "CTSCOUT_API_KEY environment variable is not set"
    );
  });

  it("throws ApiError if fetch responds with non-200 status", async () => {
    process.env.CTSCOUT_API_KEY = "test-key";
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    } as Response);

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

  it("throws TimeoutError if fetch throws AbortError", async () => {
    process.env.CTSCOUT_API_KEY = "test-key";

    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    await expect(callScan({ company_name: "Test" })).rejects.toThrowError(
      TimeoutError
    );
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
      domains: [{ org: "Evil | injected column", apex_domain: "safe.com", cert_count: 1, subdomain_count: 0 }],
      total: 1, truncated: false, source: "warehouse",
    });
    const rows = md.split("\n").filter((l) => l.startsWith("| `safe.com`"));
    expect(rows).toHaveLength(1);
    expect((rows[0].match(/\|/g) ?? []).length).toBe(FREE_TIER_PIPE_COUNT);
    expect(rows[0]).not.toContain("Evil | injected column");
    expect(rows[0]).toContain("Evil │ injected column");
  });

  it("newline in org is collapsed to space — no row split", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [{ org: "line one\nline two", apex_domain: "safe.com", cert_count: 1, subdomain_count: 0 }],
      total: 1, truncated: false, source: "warehouse",
    });
    const rows = md.split("\n").filter((l) => l.startsWith("| `safe.com`"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/[\r\n]/);
    expect(rows[0]).toContain("line one line two");
  });

  it("CRLF in org is collapsed to space — no row split", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [{ org: "line one\r\nline two", apex_domain: "safe.com", cert_count: 1, subdomain_count: 0 }],
      total: 1, truncated: false, source: "warehouse",
    });
    const rows = md.split("\n").filter((l) => l.startsWith("| `safe.com`"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toMatch(/[\r\n]/);
  });

  it("pipe in domain is replaced with │ inside the code-span cell", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [{ org: "Safe Org", apex_domain: "evil.com|x", cert_count: 1, subdomain_count: 0 }],
      total: 1, truncated: false, source: "warehouse",
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
      domains: [{ org: "Safe Org", apex_domain: "evil.com\nmalicious", cert_count: 1, subdomain_count: 0 }],
      total: 1, truncated: false, source: "warehouse",
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
    total: 1, truncated: false, source: "warehouse",
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
      domains: [], total: 0, truncated: false, source: "warehouse",
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

describe("markdown-escaping chokepoint guard — scout-tier table (cellSafe)", () => {
  function scoutRow(overrides: Partial<DomainResult>): ScanResponse {
    return {
      domains: [{
        domain: "safe.com",
        confidence: 0.9,
        sources: ["ct_org_match"],
        evidence: [{ description: "safe evidence" }],
        cert_org_names: ["Safe Org"],
        ...overrides,
      }],
    };
  }

  const DANGEROUS_PAIRS: Array<[string, string, Partial<DomainResult>]> = [
    ["org with pipe", "org | injection", { cert_org_names: ["org | injection"] }],
    ["org with newline", "org\nnewline", { cert_org_names: ["org\nnewline"] }],
    ["domain with pipe", "safe.com|evil", { domain: "safe.com|evil" }],
    ["domain with newline", "safe.com\nevil", { domain: "safe.com\nevil" }],
    ["evidence description with pipe", "evidence | injected", { evidence: [{ description: "evidence | injected" }] }],
    ["evidence description with newline", "line1\nline2", { evidence: [{ description: "line1\nline2" }] }],
    ["sources with pipe", "src|evil", { sources: ["src|evil"] }],
    ["org with CRLF", "org\r\nnewline", { cert_org_names: ["org\r\nnewline"] }],
  ];

  for (const [label, , overrides] of DANGEROUS_PAIRS) {
    it(`scout-tier: ${label} does not break the table row`, () => {
      const md = formatScanAsMarkdown("Test", scoutRow(overrides));
      // Find any data rows (lines with table cells after the header).
      const dataRows = md.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
      expect(dataRows, `${label}: expected exactly 1 data row`).toHaveLength(1);
      const row = dataRows[0];
      // Scout rows have 5 cells → 6 pipes.
      expect((row.match(/\|/g) ?? []).length, `bare pipe leaked in: ${row}`).toBe(6);
      expect(row, "newline leaked into row").not.toMatch(/[\r\n]/);
    });
  }
});

describe("markdown-escaping chokepoint guard — pro (phase-5) table (escapeForTable + cellSafe)", () => {
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
      domains: [{
        apex_domain: "safe.com",
        attributed_to: "Safe Org",
        enrichment: { ...baseEnrichment, evidence: { dns_txt_brand_token: "a | b | c" } },
      }],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    const row = dataRows[0];
    // Pro rows have 5 cells → 6 pipes; escaped \| inside cell should not add extra bare pipes.
    expect((row.match(/(?<!\\)\|/g) ?? []).length, `unescaped pipe count wrong: ${row}`).toBe(6);
    expect(row).toContain("a \\| b \\| c");
  });

  it("newline in evidence value is collapsed (escapeForTable path)", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [{
        apex_domain: "safe.com",
        attributed_to: "Safe Org",
        enrichment: { ...baseEnrichment, evidence: { dns_txt_brand_token: "line1\r\nline2\nline3" } },
      }],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]).not.toMatch(/[\r\n]/);
    expect(dataRows[0]).toContain("line1 line2 line3");
  });

  it("pipe in attributed_to is neutralised (cellSafe path)", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [{
        apex_domain: "safe.com",
        attributed_to: "Org | Inc | Evil",
        enrichment: baseEnrichment,
      }],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    // No bare pipe inside the cell (all replaced with │).
    expect(dataRows[0]).not.toContain("Org | Inc");
    expect(dataRows[0]).toContain("Org │ Inc │ Evil");
    expect((dataRows[0].match(/(?<!\\)\|/g) ?? []).length).toBe(6);
  });

  it("newline in attributed_to is collapsed (cellSafe path)", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [{
        apex_domain: "safe.com",
        attributed_to: "Org\nnewline",
        enrichment: baseEnrichment,
      }],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]).not.toMatch(/[\r\n]/);
    expect(dataRows[0]).toContain("Org newline");
  });

  it("pipe in signalSummary (matched_via) is neutralised (cellSafe path)", () => {
    // matched_via values come from the API response; a pipe in a signal name
    // would break the markdown table. This test would have FAILED before the
    // production fix that routed signalSummary through cellSafe().
    const md = formatScanAsMarkdown("Test", {
      domains: [{
        apex_domain: "safe.com",
        attributed_to: "Safe Org",
        enrichment: { ...baseEnrichment, matched_via: ["signal|one", "signal|two"] },
      }],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
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
      domains: [{
        apex_domain: "safe.com",
        attributed_to: "Safe Org",
        enrichment: { ...baseEnrichment, matched_via: ["signal\none", "sig\r\ntwo"] },
      }],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    expect(dataRows[0]).not.toMatch(/[\r\n]/);
  });

  it("backtick and hash in signalSummary pass through cellSafe without breaking structure", () => {
    const md = formatScanAsMarkdown("Test", {
      domains: [{
        apex_domain: "safe.com",
        attributed_to: "Safe Org",
        enrichment: { ...baseEnrichment, matched_via: ["`backtick`", "# hash"] },
      }],
      total: 1,
      truncated: false,
      source: "live-enriched",
    });
    const dataRows = md.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| Domain") && !l.startsWith("|---|"));
    expect(dataRows).toHaveLength(1);
    // Still exactly 6 unescaped pipes — structure intact.
    expect((dataRows[0].match(/(?<!\\)\|/g) ?? []).length).toBe(6);
  });
});

// ---------- SERVER_VERSION single-sourcing ----------

describe("SERVER_VERSION", () => {
  it("matches package.json's version (single source — bump package.json only)", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
    ) as { version: string };
    // Guards against reintroducing a hardcoded version literal in
    // src/index.ts that drifts from package.json (the failure class
    // scripts/release.sh used to detect after the fact).
    expect(SERVER_VERSION).toBe(pkg.version);
  });
});
