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

import { describe, expect, it } from "vitest";

import {
  ApiError,
  TimeoutError,
  explainError,
  formatScanAsMarkdown,
  truncateIfNeeded,
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
    const result = truncateIfNeeded(md, resp);
    expect(result.text).toBe(md);
    expect(result.structured.truncated).toBe(false);
  });

  it("halves the list and re-renders when text exceeds the limit", () => {
    // Build a Pro response that fits the typical one-halve recovery
    // case (current truncateIfNeeded halves once and returns; if a
    // future change makes it iterative, this test stays valid).
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
    const result = truncateIfNeeded(md, resp);
    expect(result.text.length).toBeLessThanOrEqual(25_000);
    expect(result.structured.truncated).toBe(true);
    expect(result.structured.domains.length).toBeLessThan(domains.length);
    expect(result.structured.upgrade_hint).toContain("Response truncated");
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
    expect(msg).toContain("Invalid company_name");
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
