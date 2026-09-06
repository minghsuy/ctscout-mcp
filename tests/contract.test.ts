import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServer,
  type DomainResult,
  type JobResponse,
  type ScanBatchResponse,
  type ScanResponse,
} from "../src/index.ts";

const PAYLOAD_SNAPSHOT = "2026-09-03";

// Every request (POST /scan and /scan/batch) gets the same scan payload. A
// fresh Response per call — a Response body can be consumed only once.
function mockApi(scanPayload: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(scanPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function calledUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "ctscout-contract-test", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: { content: unknown }): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.find((item) => item.type === "text")?.text ?? "";
}

function warehouseDomains(prefix: string, n: number): DomainResult[] {
  return Array.from({ length: n }, (_, i) => ({
    org: `${prefix} Incorporated`,
    apex_domain: `${prefix}-${i}.example.com`,
    cert_count: i + 1,
    subdomain_count: 0,
  }));
}

// The five tools that read the /scan warehouse and the /jobs deep dives. Named
// explicitly rather than matched by substring so a tool added later cannot fall
// into the wrong family's assertions by an accident of naming.
const WAREHOUSE_TOOLS = [
  "ctscout_search_company",
  "ctscout_search_company_batch",
  "ctscout_lookup_domain",
  "ctscout_submit_deep_dive",
  "ctscout_get_job",
];

// Research-product fixtures (ctscout-worker#336). The Worker attaches as_of /
// snapshot_dates / product_version to every product response from the manifest,
// so every fixture carries them.
const LEI = "549300NDMY0KJK0ZLW17";
const PRODUCT_PROVENANCE = {
  as_of: "2026-09-01",
  product_version: "2026-09-01",
  snapshot_dates: {
    elf: "2026-08-01",
    gleif: "2026-08-28",
    isin: "2026-08-28",
    psl: "psl sha256:abc123 via tldextract==5.1.2",
    wikidata: "2026-08-20",
  },
};

const LEI_RECORD = {
  lei: LEI,
  legal_name: "Cloudflare, Inc.",
  country: "US",
  isin_count: 1,
  apex_count: 42,
  first_seen: "2019-04-02T00:00:00Z",
  last_seen: "2026-08-30T00:00:00Z",
  sample_domains: ["cloudflare.com", "cloudflare-dns.com"],
  vendors_confirmed: ["cloudflare"],
  ...PRODUCT_PROVENANCE,
};

const VENDOR_SUMMARY = {
  slug: "cloudflare",
  vendor_name: "Cloudflare, Inc.",
  vendor_apex: "cloudflare.com",
  customers: { candidates: 940, confirmed: 128 },
  countries_top: [
    { country: "US", confirmed: 90 },
    { country: "GB", confirmed: 12 },
  ],
  co_use: [{ slug: "akamai", confirmed: 9 }],
  sample_customers: ["one.example", "two.example"],
  ...PRODUCT_PROVENANCE,
};

const VENDOR_CUSTOMERS = {
  slug: "cloudflare",
  confirmed: [
    {
      apex: "confirmed-customer.example",
      attributed_to: "Confirmed Customer Inc",
      lei: "5493001KJTIIGC8Y1R12",
    },
  ],
  candidates: [
    {
      apex: "confirmed-customer.example",
      attributed_to: "Confirmed Customer Inc",
      lei: "5493001KJTIIGC8Y1R12",
    },
    { apex: "candidate-only.example", attributed_to: null, lei: null },
  ],
  counts: { candidates: 900, confirmed: 1 },
  capped: true,
  ...PRODUCT_PROVENANCE,
};

describe("stdio MCP compatibility contract", () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.CTSCOUT_API_KEY;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.CTSCOUT_API_KEY;
    } else {
      process.env.CTSCOUT_API_KEY = originalApiKey;
    }
    vi.restoreAllMocks();
  });

  it("advertises the stable seven-tool surface, hosted schemas, and quota-safe annotations", async () => {
    const { client, close } = await connect();

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "ctscout_search_company",
        "ctscout_search_company_batch",
        "ctscout_lookup_domain",
        "ctscout_submit_deep_dive",
        "ctscout_get_job",
        "ctscout_lookup_lei",
        "ctscout_vendor_customers",
      ]);

      const search = tools.find((tool) => tool.name === "ctscout_search_company");
      expect(search?.inputSchema).toMatchObject({
        type: "object",
        required: ["company_name"],
        additionalProperties: false,
        properties: {
          company_name: { type: "string", minLength: 2, maxLength: 200 },
          strict_match_org_only: { type: "boolean" },
          org_match_field: { type: "string", enum: ["verbatim", "normalized"] },
          org_match_mode: { type: "string", enum: ["substring", "word"] },
          purpose: {
            type: "string",
            enum: ["underwriting", "corporate_family"],
          },
          response_format: {
            type: "string",
            enum: ["markdown", "json"],
            default: "markdown",
          },
        },
      });
      const batch = tools.find((tool) => tool.name === "ctscout_search_company_batch");
      expect(batch?.inputSchema).toMatchObject({
        type: "object",
        required: ["company_names"],
        additionalProperties: false,
        properties: {
          company_names: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "string",
              minLength: 2,
              maxLength: 200,
            },
          },
          response_format: {
            type: "string",
            enum: ["markdown", "json"],
            default: "markdown",
          },
        },
      });
      const submit = tools.find((tool) => tool.name === "ctscout_submit_deep_dive");
      expect(submit?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: {
          company_name: { type: "string", minLength: 2, maxLength: 200 },
          seed_domain: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: { type: "string", minLength: 3, maxLength: 253 },
          },
          response_format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
        },
      });
      // Neither input is required on its own; the either/or rule is advertised
      // as an anyOf so a client planning from tools/list cannot submit {}.
      expect(submit?.inputSchema.required).toBeUndefined();
      expect(submit?.inputSchema.anyOf).toEqual([
        { required: ["company_name"] },
        { required: ["seed_domain"] },
      ]);
      const getJob = tools.find((tool) => tool.name === "ctscout_get_job");
      expect(getJob?.inputSchema).toMatchObject({
        type: "object",
        required: ["job_id"],
        additionalProperties: false,
        properties: {
          job_id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" },
          response_format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
        },
      });
      const lookupLei = tools.find((tool) => tool.name === "ctscout_lookup_lei");
      expect(lookupLei?.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: {
          lei: { type: "string", pattern: "^[A-Z0-9]{18}[0-9]{2}$" },
          name: { type: "string", minLength: 1, maxLength: 200 },
          response_format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
        },
      });
      // Same shape as the deep-dive spec's either/or: neither field is required
      // on its own, and the anyOf is what a client planning from tools/list
      // sees. The exactly-one rule itself is a refine, tested in index.test.ts.
      expect(lookupLei?.inputSchema.required).toBeUndefined();
      expect(lookupLei?.inputSchema.anyOf).toEqual([{ required: ["lei"] }, { required: ["name"] }]);
      const vendorCustomers = tools.find((tool) => tool.name === "ctscout_vendor_customers");
      expect(vendorCustomers?.inputSchema).toMatchObject({
        type: "object",
        required: ["slug"],
        additionalProperties: false,
        properties: {
          slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,80}$" },
          // The default is advertised, not only described: a client planning
          // from tools/list must see that omitting it gives the free summary.
          enumerate: { type: "boolean", default: false },
          response_format: { type: "string", enum: ["markdown", "json"], default: "markdown" },
        },
      });

      // Scan tools debit quota on every call (read-only, not idempotent).
      // Submitting a job creates state and debits the jobs quota (neither).
      // Polling a job debits nothing (read-only and idempotent).
      const quotaDebitingReadOnly = {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      };
      const expectedAnnotations: Record<string, unknown> = {
        ctscout_search_company: quotaDebitingReadOnly,
        ctscout_search_company_batch: quotaDebitingReadOnly,
        ctscout_lookup_domain: quotaDebitingReadOnly,
        ctscout_submit_deep_dive: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        ctscout_get_job: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        // The research-product routes read a precomputed object and debit no
        // quota, so unlike the scan tools they are idempotent as well as
        // read-only.
        ctscout_lookup_lei: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        ctscout_vendor_customers: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      };
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toEqual(expectedAnnotations[tool.name]);
        // Warehouse size changes daily; a typed count drifts from the live site
        // and agents reason from it when judging a miss (#101).
        expect(tool.description).not.toMatch(
          /~?\d[\d,.]*[KkMm]?\s*(entities|orgs?|organizations|pairs)\b/,
        );
      }
      expect(search?.description).toContain("https://ctscout.dev/stats");

      // The job tools' descriptions carry the contract's facts an agent must
      // act on (worker#344 contract v1).
      for (const tool of [submit, getJob]) {
        const description = tool?.description ?? "";
        expect(description, tool?.name).toMatch(/[Aa]synchronous/);
        expect(description, tool?.name).toContain("30 s");
        expect(description, tool?.name).toContain("5 min");
        expect(description, tool?.name).toContain("Pro");
        expect(description, tool?.name).toContain("VLM");
        expect(description, tool?.name).toMatch(/NOT included in v1/);
        expect(description, tool?.name).toContain("batch worker sets it");
        // The API reports snapshot on /scan since 2026-09-05; no tool may
        // still tell an agent to expect null by default.
        expect(description, tool?.name).not.toMatch(/today the API does not/);
        // The deep-dive shape is its own contract; a /scan never carries it.
        expect(description, tool?.name).not.toMatch(/Pro \/?scan/);
        expect(description, tool?.name).toMatch(/deep-dive (result )?shape/);
        expect(description, tool?.name).toContain('"Attributed"');
        expect(description, tool?.name).toContain('"Candidate"');
      }
      expect(submit?.description).toContain("20 submissions per key per day");
    } finally {
      await close();
    }
  });

  it("every tool's advertised text says /scan carries a daily snapshot (API version 2026-09-05)", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const byName = (name: string) => tools.find((tool) => tool.name === name);
      const search = byName("ctscout_search_company");
      const batch = byName("ctscout_search_company_batch");
      const submit = byName("ctscout_submit_deep_dive");
      // Positive pins on each tool the change touched, so a rollback of any
      // one description fails here rather than reading as a clean tree.
      expect(search?.description).toMatch(/daily snapshot/);
      expect(search?.description).toMatch(/API version 2026-09-05\+/);
      expect(search?.description).toMatch(/reports it since X-API-Version 2026-09-05/);
      expect(batch?.description).toMatch(/API version 2026-09-05\+/);
      expect(submit?.description).toMatch(/a \/scan answer carries its own snapshot from the API/);
      // The shared output schema's snapshot description states the cadence.
      for (const name of [
        "ctscout_search_company",
        "ctscout_search_company_batch",
        "ctscout_lookup_domain",
      ]) {
        const properties = (byName(name)?.outputSchema?.properties ?? {}) as Record<
          string,
          { description?: string } | undefined
        >;
        const snapshot = properties.snapshot;
        expect(snapshot?.description, name).toMatch(/syncs daily/);
      }
      // Unchanged and still blanket over every tool, the research-product ones
      // included: no tool description needs the word, since a product tool
      // names its own source ("the ctscout-research refresh") and the warehouse
      // sync it is NOT ("syncs daily"). Loosening this to make room for a
      // description that never used the word would have traded the guard away
      // for nothing.
      for (const tool of tools) {
        expect(tool.description, tool.name).not.toMatch(
          /today the API does not|unlike \/scan today|weekly/,
        );
      }
      // Positive pin: the product tools state their own cadence and say it is
      // not the warehouse's, so a reader cannot carry the daily sync across.
      for (const name of ["ctscout_lookup_lei", "ctscout_vendor_customers"]) {
        expect(byName(name)?.description, name).toMatch(/ctscout-research refresh/);
        expect(byName(name)?.description, name).toMatch(/syncs daily|daily \/scan warehouse sync/);
      }
    } finally {
      await close();
    }
  });

  it("declares an outputSchema on every tool; every result-bearing tool requires snapshot and snapshot_source", async () => {
    const { client, close } = await connect();

    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(7);
      // A submission receipt carries no attribution data, so it carries no
      // snapshot either: a date there would be invented.
      const submit = tools.find((tool) => tool.name === "ctscout_submit_deep_dive");
      expect(submit?.outputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["job_id", "status", "submitted_at"]),
      });
      expect(submit?.outputSchema?.properties).not.toHaveProperty("snapshot");
      // Every result-bearing tool declares both fields; the vocabulary of
      // snapshot_source is per family and pinned positively, because a product
      // answer's date is the research export's version, not a warehouse sync,
      // and calling it "scan" would misname both the origin and the cadence.
      const expectedSource: Record<string, string[]> = {
        ctscout_search_company: ["scan", "unavailable"],
        ctscout_search_company_batch: ["scan", "unavailable"],
        ctscout_lookup_domain: ["scan", "unavailable"],
        ctscout_get_job: ["scan", "unavailable"],
        ctscout_lookup_lei: ["product", "unavailable"],
        ctscout_vendor_customers: ["product", "unavailable"],
      };
      const resultBearing = tools.filter((tool) => tool.name !== "ctscout_submit_deep_dive");
      expect(resultBearing).toHaveLength(6);
      expect(resultBearing.map((tool) => tool.name).sort()).toEqual(
        Object.keys(expectedSource).sort(),
      );
      for (const tool of resultBearing) {
        expect(tool.outputSchema, tool.name).toMatchObject({
          type: "object",
          properties: {
            snapshot: { anyOf: [{ type: "string" }, { type: "null" }] },
            snapshot_source: { type: "string", enum: expectedSource[tool.name] },
          },
        });
        expect(tool.outputSchema?.required, tool.name).toEqual(
          expect.arrayContaining(["snapshot", "snapshot_source"]),
        );
      }
      // The product tools require ONLY what this server writes itself: every
      // proxied field is optional, so a publication the Worker's contract would
      // have refused cannot also fail schema validation on the way out. Pinned
      // exactly, since shrinking `required` is an externally observable change.
      for (const name of ["ctscout_lookup_lei", "ctscout_vendor_customers"]) {
        expect(tools.find((tool) => tool.name === name)?.outputSchema?.required, name).toEqual([
          "snapshot",
          "snapshot_source",
        ]);
      }
      const rowSchema = (
        tools.find((tool) => tool.name === "ctscout_vendor_customers")?.outputSchema
          ?.properties as Record<string, { items?: { required?: string[] } }>
      ).candidates?.items;
      expect(rowSchema?.required).toBeUndefined();

      // The scan shape is proxied from the origin, so it stays open to fields
      // this server does not model; the enum-like fields are strings with
      // documented values, not closed enums, so upstream drift widens rather
      // than breaks the tool.
      const search = tools.find((tool) => tool.name === "ctscout_search_company");
      // zod's looseObject emits `additionalProperties: {}` (accept anything).
      expect(search?.outputSchema).toMatchObject({
        additionalProperties: {},
        required: expect.arrayContaining(["domains"]),
        properties: {
          domains: { type: "array", items: { type: "object", additionalProperties: {} } },
          match_type: { type: "string" },
          candidates: { type: "array" },
        },
      });
      expect(search?.outputSchema?.additionalProperties).toEqual({});
      const searchProps = search?.outputSchema?.properties as Record<string, unknown>;
      expect(searchProps.match_type).not.toHaveProperty("enum");
      // A /scan row advertises the warehouse shape only: the retired origin's
      // per-row confidence float and its companions are not part of the
      // contract, so no consumer is led to derive a band from them (#99).
      const rowProps = (searchProps.domains as { items: { properties: Record<string, unknown> } })
        .items.properties;
      for (const gone of ["confidence", "sources", "cert_org_names", "rdap_org"]) {
        expect(rowProps, gone).not.toHaveProperty(gone);
      }
      const lookup = tools.find((tool) => tool.name === "ctscout_lookup_domain");
      expect(lookup?.outputSchema).toEqual(search?.outputSchema);

      const batch = tools.find((tool) => tool.name === "ctscout_search_company_batch");
      expect(batch?.outputSchema).toMatchObject({
        required: expect.arrayContaining(["results", "remaining_quota"]),
        properties: {
          results: { type: "array", items: { anyOf: expect.any(Array) } },
          remaining_quota: { anyOf: [{ type: "number" }, { type: "null" }] },
        },
      });

      // The job record is proxied too: status stays a documented string, the
      // result is the (open) scan shape plus the worker-set fields.
      const getJob = tools.find((tool) => tool.name === "ctscout_get_job");
      expect(getJob?.outputSchema).toMatchObject({
        additionalProperties: {},
        required: expect.arrayContaining(["job_id", "status", "submitted_at"]),
        properties: {
          status: { type: "string" },
          result: {
            type: "object",
            additionalProperties: {},
            required: expect.arrayContaining(["domains"]),
            properties: {
              domains: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: {},
                  properties: {
                    domain: { type: "string" },
                    attributed_to: { type: "string" },
                    is_seed: { type: "boolean" },
                    base: { type: "object", additionalProperties: {} },
                    enrichment: {
                      type: "object",
                      additionalProperties: {},
                      properties: {
                        confidence_band: { type: "string" },
                        weight_total: { type: "number" },
                        matched_via: { type: "array", items: { type: "string" } },
                        evidence: { type: "object", additionalProperties: { type: "string" } },
                        signal_health: { type: "object", additionalProperties: { type: "string" } },
                        vlm_status: { type: "string" },
                        vlm_override: { type: "boolean" },
                      },
                    },
                  },
                },
              },
              entity: {
                type: "object",
                properties: {
                  company_name: { type: "string" },
                  seed_domain: { type: "array", items: { type: "string" } },
                },
              },
              run_metadata: { type: "object", additionalProperties: {} },
              signals_attempted: { type: "array", items: { type: "string" } },
              snapshot: expect.anything(),
              snapshot_source: { type: "string", enum: ["scan", "unavailable"] },
              worker_version: { type: "string" },
              signals_degraded: { type: "boolean" },
            },
          },
        },
      });
      const getJobProps = getJob?.outputSchema?.properties as Record<string, unknown>;
      expect(getJobProps.status).not.toHaveProperty("enum");
      expect(getJob?.outputSchema?.required).not.toContain("result");
      // Proxied vocabularies are documented, never closed: an upstream value
      // added later must widen what an agent sees, not fail the call.
      type Prop = {
        enum?: unknown;
        description?: string;
        properties?: Record<string, Prop>;
        items?: Prop;
      };
      const resultProp = getJobProps.result as Prop;
      const enrichment = resultProp.properties?.domains.items?.properties?.enrichment
        .properties as Record<string, Prop>;
      expect(enrichment.confidence_band.enum).toBeUndefined();
      expect(enrichment.confidence_band.description).toContain(
        "'verified' | 'likely' | 'possible' | 'insufficient'",
      );
      expect(enrichment.signal_health.enum).toBeUndefined();
      expect(enrichment.signal_health.description).toContain("'unscored'");
      expect(enrichment.vlm_status.description).toContain("'pending' or 'skipped'");
    } finally {
      await close();
    }
  });

  it("calls the batch endpoint once and preserves ordered successes, semantic candidates, and errors", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const response: ScanBatchResponse = {
      results: [
        {
          query: { company_name: "Alpha" },
          domains: [
            {
              org: "Alpha Corporation",
              apex_domain: "alpha.example",
              cert_count: 4,
              subdomain_count: 1,
            },
          ],
          total: 1,
          source: "warehouse",
          match_type: "exact",
          org_match_strategy: "substring",
        },
        {
          query: { company_name: "Beta" },
          domains: [],
          total: 0,
          source: "warehouse",
          match_type: "semantic",
          org_match_strategy: "semantic",
          empty_reason: "semantic_offered",
          candidates: [
            {
              org: "Beta Holdings",
              similarity: 0.91,
              top_apex_domain: "beta.example",
            },
          ],
        },
        {
          query: { company_name: "Gamma" },
          error: { code: 503, message: "Retry this name later." },
        },
      ],
      remaining_quota: 7,
      snapshot: PAYLOAD_SNAPSHOT,
    };
    const fetchMock = mockApi(response);

    const { client, close } = await connect();

    try {
      const result = await client.callTool({
        name: "ctscout_search_company_batch",
        arguments: {
          company_names: ["Alpha", "Beta", "Gamma"],
          response_format: "markdown",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(calledUrls(fetchMock)).toHaveLength(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toMatch(/\/scan\/batch$/);
      expect(JSON.parse(String(init?.body))).toEqual({
        queries: [{ company_name: "Alpha" }, { company_name: "Beta" }, { company_name: "Gamma" }],
      });
      const text = textOf(result);
      expect(text).toContain(
        `_Warehouse snapshot: ${PAYLOAD_SNAPSHOT} (reported by the API response)._`,
      );
      expect(text.indexOf("alpha.example")).toBeLessThan(text.indexOf("Beta Holdings"));
      expect(text.indexOf("Beta Holdings")).toBeLessThan(text.indexOf("HTTP 503"));
      expect(text).toContain("| Domain | Attributed to | Certs | Subdomains |");
      expect(text).toContain("No attributed OV/EV warehouse domains matched.");
      expect(text).toContain("| Candidate organization | Similarity | Top apex domain |");
      expect(text).toContain("weak signal; corroborate before use");
      // The snapshot line is envelope-level: once, not once per section.
      expect(text.match(/_Warehouse snapshot:/g)).toHaveLength(1);
      expect(result.structuredContent).toMatchObject({
        results: [
          { query: { company_name: "Alpha" }, domains: [{ apex_domain: "alpha.example" }] },
          {
            query: { company_name: "Beta" },
            candidates: [{ org: "Beta Holdings" }],
          },
          {
            query: { company_name: "Gamma" },
            error: { code: 503, message: "Retry this name later." },
          },
        ],
        remaining_quota: 7,
        snapshot: PAYLOAD_SNAPSHOT,
        snapshot_source: "scan",
      });
    } finally {
      await close();
    }
  });

  it("rejects an oversized batch before making a network call", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    globalThis.fetch = vi.fn();

    const { client, close } = await connect();

    try {
      const result = await client.callTool({
        name: "ctscout_search_company_batch",
        arguments: {
          company_names: Array.from({ length: 11 }, (_, index) => `Company ${index}`),
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("At most 10 company names per batch"),
        }),
      ]);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("forwards explicitly supplied hosted search controls without changing defaults", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const response: ScanResponse = {
      domains: [],
      total: 0,
      source: "warehouse",
    };
    const fetchMock = mockApi(response);

    const { client, close } = await connect();

    try {
      const result = await client.callTool({
        name: "ctscout_search_company",
        arguments: {
          company_name: "Acme Corporation",
          strict_match_org_only: true,
          org_match_field: "normalized",
          org_match_mode: "word",
          purpose: "underwriting",
          response_format: "json",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(calledUrls(fetchMock)).toHaveLength(1);
      const [, init] = fetchMock.mock.calls[0];
      expect(JSON.parse(String(init?.body))).toEqual({
        company_name: "Acme Corporation",
        strict_match_org_only: true,
        org_match_field: "normalized",
        org_match_mode: "word",
        purpose: "underwriting",
      });

      await client.callTool({
        name: "ctscout_search_company",
        arguments: {
          company_name: "Acme Corporation",
          response_format: "json",
        },
      });
      expect(calledUrls(fetchMock)).toHaveLength(2);
      const [, defaultInit] = fetchMock.mock.calls[1];
      expect(JSON.parse(String(defaultInit?.body))).toEqual({
        company_name: "Acme Corporation",
      });
    } finally {
      await close();
    }
  });

  it("stamps the payload snapshot on search results in both formats with one request per call", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const fetchMock = mockApi({
      domains: warehouseDomains("acme", 2),
      total: 2,
      source: "warehouse",
      match_type: "exact",
      snapshot: PAYLOAD_SNAPSHOT,
    });

    const { client, close } = await connect();

    try {
      const markdown = await client.callTool({
        name: "ctscout_search_company",
        arguments: { company_name: "Acme" },
      });
      expect(markdown.isError).not.toBe(true);
      const text = textOf(markdown);
      expect(text).toContain("# ctscout results for: Acme");
      expect(text).toContain(
        `_Warehouse snapshot: ${PAYLOAD_SNAPSHOT} (reported by the API response)._`,
      );
      expect(text).toContain("**2** attributed domain(s) of 2 total");
      expect(text).toContain("| Domain | Attributed to | Certs | Subdomains |");
      expect(markdown.structuredContent).toMatchObject({
        domains: [{ apex_domain: "acme-0.example.com" }, { apex_domain: "acme-1.example.com" }],
        snapshot: PAYLOAD_SNAPSHOT,
        snapshot_source: "scan",
      });

      const json = await client.callTool({
        name: "ctscout_search_company",
        arguments: { company_name: "Acme", response_format: "json" },
      });
      expect(json.isError).not.toBe(true);
      const parsed = JSON.parse(textOf(json)) as ScanResponse;
      expect(parsed.snapshot).toBe(PAYLOAD_SNAPSHOT);
      expect(parsed.snapshot_source).toBe("scan");
      expect(json.structuredContent).toEqual(parsed);

      // Exactly one /scan per tool call: the snapshot never costs a request.
      expect(calledUrls(fetchMock).map((url) => url.replace(/^.*\//, "/"))).toEqual([
        "/scan",
        "/scan",
      ]);
    } finally {
      await close();
    }
  });

  it("reads the snapshot carried by a lookup payload", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const fetchMock = mockApi({
      domains: warehouseDomains("gs", 1),
      total: 1,
      source: "warehouse",
      snapshot: "2026-08-30",
    });

    const { client, close } = await connect();

    try {
      const result = await client.callTool({
        name: "ctscout_lookup_domain",
        arguments: { domains: ["gs-0.example.com"] },
      });
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toContain(
        "_Warehouse snapshot: 2026-08-30 (reported by the API response)._",
      );
      expect(result.structuredContent).toMatchObject({
        snapshot: "2026-08-30",
        snapshot_source: "scan",
      });
      expect(calledUrls(fetchMock)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // Hosted-transport parity exception (README "hosted endpoint", AGENTS.md
  // "Cross-repository parity"): the hosted MCP in ctscout-worker does not emit
  // `snapshot` today, so a payload without one must surface as null /
  // "unavailable" — never as a date obtained from a separate request. The
  // closed enum is the parity check: it fails the moment a client-side source
  // is re-added.
  it("reports snapshot null / 'unavailable' when the payload carries no snapshot, with no extra request", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const fetchMock = mockApi({
      domains: warehouseDomains("gs", 1),
      total: 1,
      source: "warehouse",
    });

    const { client, close } = await connect();

    try {
      const { tools } = await client.listTools();
      // The submission receipt carries no snapshot (nothing attributed yet);
      // the research-product tools carry one with their own source vocabulary
      // (pinned in the outputSchema test above).
      const warehouseTools = tools.filter((t) => WAREHOUSE_TOOLS.includes(t.name));
      for (const tool of warehouseTools.filter((t) => t.name !== "ctscout_submit_deep_dive")) {
        expect(tool.outputSchema?.properties, tool.name).toMatchObject({
          snapshot_source: { enum: ["scan", "unavailable"] },
        });
      }
      expect(warehouseTools).toHaveLength(5);

      const result = await client.callTool({
        name: "ctscout_lookup_domain",
        arguments: { domains: ["gs-0.example.com"], response_format: "json" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        domains: [{ apex_domain: "gs-0.example.com" }],
        snapshot: null,
        snapshot_source: "unavailable",
      });
      // The JSON text is the same envelope the structured field carries.
      expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);

      const markdown = await client.callTool({
        name: "ctscout_lookup_domain",
        arguments: { domains: ["gs-0.example.com"] },
      });
      expect(textOf(markdown)).toContain(
        "_Warehouse snapshot: unknown — the API did not report a sync date._",
      );
      expect(calledUrls(fetchMock).map((url) => url.replace(/^.*\//, "/"))).toEqual([
        "/scan",
        "/scan",
      ]);
    } finally {
      await close();
    }
  });

  it("keeps the snapshot on a size-truncated single-scan envelope so the outputSchema still holds", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    // One domain whose own row exceeds the character limit forces the
    // minimal-envelope path in truncateJsonIfNeeded.
    mockApi({
      domains: [{ ...warehouseDomains("huge", 1)[0], padding: "x".repeat(30_000) }],
      total: 1,
      source: "warehouse",
      match_type: "exact",
      snapshot: PAYLOAD_SNAPSHOT,
    });

    const { client, close } = await connect();

    try {
      const result = await client.callTool({
        name: "ctscout_search_company",
        arguments: { company_name: "Huge", response_format: "json" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        domains: [],
        truncated: true,
        snapshot: PAYLOAD_SNAPSHOT,
        snapshot_source: "scan",
      });
      expect(textOf(result).length).toBeLessThanOrEqual(25_000);
    } finally {
      await close();
    }
  });

  it("keeps the snapshot on a size-truncated batch envelope", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    mockApi({
      results: [
        {
          query: { company_name: "Giant" },
          domains: warehouseDomains("giant", 5000),
          total: 5000,
          source: "warehouse",
          match_type: "exact",
        },
        {
          query: { company_name: "Tiny" },
          domains: warehouseDomains("tiny", 1),
          total: 1,
          source: "warehouse",
          match_type: "exact",
        },
      ],
      remaining_quota: null,
      snapshot: PAYLOAD_SNAPSHOT,
    });

    const { client, close } = await connect();

    try {
      for (const response_format of ["json", "markdown"]) {
        const result = await client.callTool({
          name: "ctscout_search_company_batch",
          arguments: { company_names: ["Giant", "Tiny"], response_format },
        });
        expect(result.isError).not.toBe(true);
        expect(textOf(result).length).toBeLessThanOrEqual(25_000);
        expect(result.structuredContent).toMatchObject({
          remaining_quota: null,
          snapshot: PAYLOAD_SNAPSHOT,
          snapshot_source: "scan",
        });
        const structured = result.structuredContent as ScanBatchResponse;
        expect(structured.results).toHaveLength(2);
      }
      expect(
        textOf(
          await client.callTool({
            name: "ctscout_search_company_batch",
            arguments: { company_names: ["Giant", "Tiny"] },
          }),
        ),
      ).toContain(`_Warehouse snapshot: ${PAYLOAD_SNAPSHOT}`);
    } finally {
      await close();
    }
  });

  it("returns an isError result with no structuredContent when the scan itself fails", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const fetchMock = vi.fn(
      async () => new Response("quota", { status: 429, headers: { "Content-Type": "text/plain" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      const result = await client.callTool({
        name: "ctscout_lookup_domain",
        arguments: { domains: ["gs.com"] },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Daily request quota exceeded");
      expect(result.structuredContent).toBeUndefined();
      expect(calledUrls(fetchMock)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // ---------- Async deep-dive jobs (ctscout-worker#344 contract v1) ----------

  const JOB_ID = "0123456789abcdef01234567";
  const RECEIPT = {
    job_id: JOB_ID,
    status: "queued",
    submitted_at: "2026-09-04T10:00:00Z",
    poll: `/jobs/${JOB_ID}`,
  };
  const DEEP_DIVE_ROW: DomainResult = {
    domain: "cna.com",
    attributed_to: "CNA Financial Corporation",
    is_seed: true,
    base: { domain: "cna.com", confidence: 0.95, sources: ["ct_org_match"] },
    enrichment: {
      confidence_band: "verified",
      weight_total: 4.2,
      matched_via: ["dns_txt_brand_token"],
      evidence: { dns_txt_brand_token: "verified via google-site-verification" },
      signal_health: { vlm_verdict: "pending" },
      vlm_status: "pending",
      vlm_override: false,
    },
  };
  const DONE_JOB: JobResponse = {
    job_id: JOB_ID,
    kind: "deep_dive",
    status: "done",
    submitted_at: "2026-09-04T10:00:00Z",
    started_at: "2026-09-04T10:05:00Z",
    finished_at: "2026-09-04T10:09:30Z",
    result: {
      job_id: JOB_ID,
      entity: { company_name: "CNA Financial", seed_domain: ["cna.com"] },
      domains: [DEEP_DIVE_ROW],
      run_metadata: {},
      source: "live-enriched",
      signals_degraded: false,
      snapshot: "2026-08-31",
      worker_version: "abc1234",
      signals_attempted: ["dns", "rdap"],
    },
  };

  it("submits a deep dive with one POST /jobs carrying only the spec, in both formats", async () => {
    process.env.CTSCOUT_API_KEY = "ds_pro_contract_test";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(RECEIPT), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      const markdown = await client.callTool({
        name: "ctscout_submit_deep_dive",
        arguments: { company_name: "CNA Financial", seed_domain: ["cna.com"] },
      });
      expect(markdown.isError).not.toBe(true);
      const text = textOf(markdown);
      expect(text).toContain("# ctscout deep dive submitted");
      expect(text).toContain(`- Job id: \`${JOB_ID}\``);
      expect(text).toContain("nothing is attributed yet");
      expect(text).toContain("ctscout_get_job");
      expect(markdown.structuredContent).toEqual(RECEIPT);

      const json = await client.callTool({
        name: "ctscout_submit_deep_dive",
        arguments: { seed_domain: ["cna.com"], response_format: "json" },
      });
      expect(json.isError).not.toBe(true);
      expect(JSON.parse(textOf(json))).toEqual(RECEIPT);
      expect(json.structuredContent).toEqual(RECEIPT);

      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
      expect(calls.map(([url]) => url.replace(/^.*\/\/[^/]+/, ""))).toEqual(["/jobs", "/jobs"]);
      for (const [, init] of calls) {
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        expect(init.headers).toMatchObject({ "X-API-Key": "ds_pro_contract_test" });
      }
      // response_format never reaches the API; the spec is exactly what /scan validates.
      expect(JSON.parse(String(calls[0][1].body))).toEqual({
        company_name: "CNA Financial",
        seed_domain: ["cna.com"],
      });
      expect(JSON.parse(String(calls[1][1].body))).toEqual({ seed_domain: ["cna.com"] });
    } finally {
      await close();
    }
  });

  it("bounds a receipt carrying an oversized forward-compatible field to the character limit in both formats", async () => {
    process.env.CTSCOUT_API_KEY = "ds_pro_contract_test";
    const oversized = { ...RECEIPT, future_field: "f".repeat(30_000) };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(oversized), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      const json = await client.callTool({
        name: "ctscout_submit_deep_dive",
        arguments: { company_name: "CNA Financial", response_format: "json" },
      });
      expect(json.isError).not.toBe(true);
      const text = textOf(json);
      expect(text.length).toBeLessThanOrEqual(25_000);
      expect(JSON.parse(text)).toEqual(RECEIPT);
      expect(json.structuredContent).toEqual(RECEIPT);

      const markdown = await client.callTool({
        name: "ctscout_submit_deep_dive",
        arguments: { company_name: "CNA Financial" },
      });
      expect(markdown.isError).not.toBe(true);
      expect(textOf(markdown).length).toBeLessThanOrEqual(25_000);
      expect(textOf(markdown)).toContain(`- Job id: \`${JOB_ID}\``);
      expect(markdown.structuredContent).toEqual(RECEIPT);
    } finally {
      await close();
    }
  });

  it("rejects a deep dive with neither company_name nor seed_domain, or too many seeds, before any network call", async () => {
    process.env.CTSCOUT_API_KEY = "ds_pro_contract_test";
    globalThis.fetch = vi.fn();

    const { client, close } = await connect();

    try {
      const empty = await client.callTool({ name: "ctscout_submit_deep_dive", arguments: {} });
      expect(empty.isError).toBe(true);
      expect(textOf(empty)).toContain("Provide company_name, seed_domain, or both");

      const over = await client.callTool({
        name: "ctscout_submit_deep_dive",
        arguments: { seed_domain: Array.from({ length: 11 }, (_, i) => `seed-${i}.example`) },
      });
      expect(over.isError).toBe(true);
      expect(textOf(over)).toContain("At most 10 seed domains per deep dive");

      const badId = await client.callTool({
        name: "ctscout_get_job",
        arguments: { job_id: "../keys" },
      });
      expect(badId.isError).toBe(true);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("explains a free key's 403 with the API's upgrade text and the jobs quota's 429, with no structuredContent", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const responses = [
      new Response(
        JSON.stringify({
          error: "pro_required",
          upgrade_hint: "Deep dives are a Pro feature; email pro@ctscout.dev for a key.",
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
      new Response(JSON.stringify({ error: "jobs quota" }), { status: 429 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      const forbidden = await client.callTool({
        name: "ctscout_submit_deep_dive",
        arguments: { company_name: "CNA Financial" },
      });
      expect(forbidden.isError).toBe(true);
      expect(textOf(forbidden)).toContain("Deep dives require a Pro key");
      expect(textOf(forbidden)).toContain(
        "Deep dives are a Pro feature; email pro@ctscout.dev for a key.",
      );
      expect(textOf(forbidden)).not.toContain("revoked");
      expect(forbidden.structuredContent).toBeUndefined();

      const quota = await client.callTool({
        name: "ctscout_submit_deep_dive",
        arguments: { company_name: "CNA Financial" },
      });
      expect(quota.isError).toBe(true);
      expect(textOf(quota)).toContain("Daily deep-dive quota exceeded (20 submissions");
      expect(quota.structuredContent).toBeUndefined();
      expect(calledUrls(fetchMock)).toHaveLength(2);
    } finally {
      await close();
    }
  });

  it("renders a done job whose enrichment carries only confidence_band in both formats without error", async () => {
    process.env.CTSCOUT_API_KEY = "ds_pro_contract_test";
    const sparse = {
      ...DONE_JOB,
      result: {
        ...DONE_JOB.result,
        domains: [
          {
            domain: "cna.com",
            attributed_to: "CNA Financial Corporation",
            enrichment: { confidence_band: "possible" },
          },
        ],
      },
    };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(sparse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      const markdown = await client.callTool({
        name: "ctscout_get_job",
        arguments: { job_id: JOB_ID },
      });
      expect(markdown.isError).not.toBe(true);
      expect(textOf(markdown)).toContain(
        "| `cna.com` | CNA Financial Corporation | 🟡 possible | _none_ | _no evidence_ |",
      );
      const json = await client.callTool({
        name: "ctscout_get_job",
        arguments: { job_id: JOB_ID, response_format: "json" },
      });
      expect(json.isError).not.toBe(true);
      expect(json.structuredContent).toMatchObject({
        status: "done",
        result: { domains: [{ domain: "cna.com", enrichment: { confidence_band: "possible" } }] },
      });
    } finally {
      await close();
    }
  });

  it("keeps a done job's shown domain in structuredContent when a non-rendered field is oversized, and bounds an oversized upgrade_hint", async () => {
    process.env.CTSCOUT_API_KEY = "ds_pro_contract_test";
    const records: unknown[] = [
      { ...DONE_JOB, result: { ...DONE_JOB.result, run_metadata: { blob: "m".repeat(30_000) } } },
      { ...DONE_JOB, result: { ...DONE_JOB.result, run_metadata: { blob: "m".repeat(30_000) } } },
      {
        ...DONE_JOB,
        result: {
          ...DONE_JOB.result,
          domains: [],
          truncated: true,
          upgrade_hint: "h".repeat(30_000),
        },
      },
    ];
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(records.shift()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      for (const format of ["markdown", "json"] as const) {
        const done = await client.callTool({
          name: "ctscout_get_job",
          arguments: { job_id: JOB_ID, response_format: format },
        });
        expect(done.isError).not.toBe(true);
        expect(textOf(done).length).toBeLessThanOrEqual(25_000);
        expect(JSON.stringify(done.structuredContent).length).toBeLessThanOrEqual(25_000);
        expect(done.structuredContent).toMatchObject({
          status: "done",
          snapshot: "2026-08-31",
          result: {
            domains: [{ domain: "cna.com", attributed_to: "CNA Financial Corporation" }],
            truncated: true,
            upgrade_hint: expect.stringContaining("run_metadata omitted"),
          },
        });
        expect((done.structuredContent as JobResponse).result).not.toHaveProperty("run_metadata");
        if (format === "markdown") {
          expect(textOf(done)).toContain("| `cna.com` |");
          expect(textOf(done)).toContain("> Response truncated: run_metadata omitted");
        }
      }

      const hinted = await client.callTool({
        name: "ctscout_get_job",
        arguments: { job_id: JOB_ID },
      });
      expect(hinted.isError).not.toBe(true);
      expect(textOf(hinted).length).toBeLessThanOrEqual(25_000);
      expect(textOf(hinted)).toMatch(/> h{199}…/);
      expect(JSON.stringify(hinted.structuredContent).length).toBeLessThanOrEqual(25_000);
    } finally {
      await close();
    }
  });

  it("bounds a not-done record carrying an oversized forward-compatible field in markdown format", async () => {
    process.env.CTSCOUT_API_KEY = "ds_pro_contract_test";
    const oversized = {
      job_id: JOB_ID,
      kind: "deep_dive",
      status: "running",
      submitted_at: "2026-09-04T10:00:00Z",
      started_at: "2026-09-04T10:05:00Z",
      future_field: "f".repeat(30_000),
    };
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(oversized), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      const running = await client.callTool({
        name: "ctscout_get_job",
        arguments: { job_id: JOB_ID },
      });
      expect(running.isError).not.toBe(true);
      expect(textOf(running).length).toBeLessThanOrEqual(25_000);
      expect(textOf(running)).toContain("- Status: `running`");
      expect(JSON.stringify(running.structuredContent).length).toBeLessThanOrEqual(25_000);
      expect(running.structuredContent).toEqual({
        job_id: JOB_ID,
        kind: "deep_dive",
        status: "running",
        submitted_at: "2026-09-04T10:00:00Z",
        started_at: "2026-09-04T10:05:00Z",
        snapshot: null,
        snapshot_source: "unavailable",
      });
    } finally {
      await close();
    }
  });

  it("polls a job with one GET /jobs/{id}: queued, then done with the worker-set snapshot, then failed", async () => {
    process.env.CTSCOUT_API_KEY = "ds_pro_contract_test";
    const records: unknown[] = [
      { job_id: JOB_ID, kind: "deep_dive", status: "queued", submitted_at: "2026-09-04T10:00:00Z" },
      DONE_JOB,
      DONE_JOB,
      {
        job_id: JOB_ID,
        kind: "deep_dive",
        status: "failed",
        submitted_at: "2026-09-04T10:00:00Z",
        started_at: "2026-09-04T10:05:00Z",
        finished_at: "2026-09-04T10:06:00Z",
        error: "origin_timeout: enrichment gave up",
      },
    ];
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(records.shift()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      const queued = await client.callTool({
        name: "ctscout_get_job",
        arguments: { job_id: JOB_ID },
      });
      expect(queued.isError).not.toBe(true);
      expect(textOf(queued)).toContain("- Status: `queued`");
      expect(textOf(queued)).toContain("Not finished yet");
      expect(queued.structuredContent).toEqual({
        job_id: JOB_ID,
        kind: "deep_dive",
        status: "queued",
        submitted_at: "2026-09-04T10:00:00Z",
        snapshot: null,
        snapshot_source: "unavailable",
      });

      const done = await client.callTool({
        name: "ctscout_get_job",
        arguments: { job_id: JOB_ID },
      });
      expect(done.isError).not.toBe(true);
      const doneText = textOf(done);
      expect(doneText).toContain("- Status: `done`");
      expect(doneText).toContain(
        "_Warehouse snapshot: 2026-08-31 (reported by the API response)._",
      );
      expect(doneText).toContain("| Domain | Attributed to | Band | Signals | Evidence |");
      expect(doneText).toContain("| `cna.com` | CNA Financial Corporation | ✅ verified |");
      expect(doneText).toContain("VLM");
      expect(done.structuredContent).toMatchObject({
        job_id: JOB_ID,
        status: "done",
        snapshot: "2026-08-31",
        snapshot_source: "scan",
        result: {
          domains: [{ domain: "cna.com", attributed_to: "CNA Financial Corporation" }],
          snapshot: "2026-08-31",
          snapshot_source: "scan",
          worker_version: "abc1234",
        },
      });

      const doneJson = await client.callTool({
        name: "ctscout_get_job",
        arguments: { job_id: JOB_ID, response_format: "json" },
      });
      expect(doneJson.isError).not.toBe(true);
      expect(JSON.parse(textOf(doneJson))).toEqual(doneJson.structuredContent);
      expect(doneJson.structuredContent).toMatchObject({ snapshot: "2026-08-31" });

      const failed = await client.callTool({
        name: "ctscout_get_job",
        arguments: { job_id: JOB_ID },
      });
      expect(failed.isError).not.toBe(true);
      expect(textOf(failed)).toContain("- Error: origin\\_timeout: enrichment gave up");
      expect(textOf(failed)).not.toContain("| Domain |");
      expect(failed.structuredContent).toMatchObject({
        status: "failed",
        error: "origin_timeout: enrichment gave up",
        snapshot: null,
        snapshot_source: "unavailable",
      });

      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
      expect(calls.map(([url]) => url.replace(/^.*\/\/[^/]+/, ""))).toEqual(
        Array(4).fill(`/jobs/${JOB_ID}`),
      );
      for (const [, init] of calls) {
        expect(init.method).toBe("GET");
        expect(init.body).toBeUndefined();
      }
    } finally {
      await close();
    }
  });

  it("explains a 404 on a job as not-your-job / unknown id", async () => {
    process.env.CTSCOUT_API_KEY = "ds_pro_contract_test";
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      const result = await client.callTool({
        name: "ctscout_get_job",
        arguments: { job_id: "ffffffffffffffffffffffff" },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("No job with that id for this API key");
      expect(result.structuredContent).toBeUndefined();
      expect(calledUrls(fetchMock)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("keeps a size-truncated done job under the limit with the snapshot intact in both formats", async () => {
    process.env.CTSCOUT_API_KEY = "ds_pro_contract_test";
    const big: JobResponse = {
      ...DONE_JOB,
      result: {
        ...DONE_JOB.result,
        domains: Array.from({ length: 3000 }, (_, i) => ({
          ...DEEP_DIVE_ROW,
          domain: `d-${i}.example`,
        })),
      } as JobResponse["result"],
    };
    mockApi(big);

    const { client, close } = await connect();

    try {
      for (const response_format of ["markdown", "json"]) {
        const result = await client.callTool({
          name: "ctscout_get_job",
          arguments: { job_id: JOB_ID, response_format },
        });
        expect(result.isError).not.toBe(true);
        expect(textOf(result).length).toBeLessThanOrEqual(25_000);
        expect(result.structuredContent).toMatchObject({
          status: "done",
          snapshot: "2026-08-31",
          snapshot_source: "scan",
          result: { truncated: true },
        });
      }
    } finally {
      await close();
    }
  });

  // ---------- Research product: ctscout_lookup_lei / ctscout_vendor_customers ----------

  it("reads one LEI record with a single GET /lei/{lei} in both formats", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const fetchMock = mockApi(LEI_RECORD);

    const { client, close } = await connect();

    try {
      const markdown = await client.callTool({
        name: "ctscout_lookup_lei",
        arguments: { lei: LEI },
      });
      expect(markdown.isError).not.toBe(true);
      expect(textOf(markdown)).toContain("Cloudflare, Inc.");
      expect(textOf(markdown)).toContain("Research product: 2026-09-01");
      expect(textOf(markdown)).toContain("gleif 2026-08-28");
      // The slugs are the other tool's input, and the definition travels with
      // them rather than being left to the reader.
      expect(textOf(markdown)).toContain("`cloudflare`");
      expect(textOf(markdown)).toContain(
        "a vendor is confirmed when a hostname it certified resolves onto a domain it certifies and the customer's own www does not",
      );
      expect(textOf(markdown)).toContain("not an ownership claim");
      expect(markdown.structuredContent).toMatchObject({
        lei: LEI,
        legal_name: "Cloudflare, Inc.",
        apex_count: 42,
        snapshot: "2026-09-01",
        snapshot_source: "product",
      });

      const json = await client.callTool({
        name: "ctscout_lookup_lei",
        arguments: { lei: LEI, response_format: "json" },
      });
      expect(json.isError).not.toBe(true);
      expect(JSON.parse(textOf(json))).toMatchObject({
        lei: LEI,
        snapshot: "2026-09-01",
        snapshot_source: "product",
      });
      expect(calledUrls(fetchMock)).toEqual([
        `https://ctscout.dev/lei/${LEI}`,
        `https://ctscout.dev/lei/${LEI}`,
      ]);
    } finally {
      await close();
    }
  });

  it("looks an LEI up by name, reporting the pre-cap total and the cap separately", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const fetchMock = mockApi({
      query: "Cloudflare, Inc.",
      name_match: "normalized",
      leis: Array.from({ length: 20 }, (_, i) => `54930${String(i).padStart(13, "0")}LW17`),
      lei_count: 37,
      limit: 20,
      truncated: true,
      ...PRODUCT_PROVENANCE,
    });

    const { client, close } = await connect();

    try {
      const markdown = await client.callTool({
        name: "ctscout_lookup_lei",
        arguments: { name: "Cloudflare, Inc." },
      });
      expect(markdown.isError).not.toBe(true);
      // leis.length is 20 and lei_count is 37: the line must not report the
      // capped list as the total.
      expect(textOf(markdown)).toContain(
        "37 LEIs carry this name; the endpoint returns the first 20.",
      );
      expect(markdown.structuredContent).toMatchObject({
        name_match: "normalized",
        lei_count: 37,
        limit: 20,
        truncated: true,
        snapshot_source: "product",
      });

      const json = await client.callTool({
        name: "ctscout_lookup_lei",
        arguments: { name: "Cloudflare, Inc.", response_format: "json" },
      });
      expect(json.isError).not.toBe(true);
      expect(JSON.parse(textOf(json))).toMatchObject({ lei_count: 37, truncated: true });
      // The name goes on the query string, encoded — never into the path.
      expect(calledUrls(fetchMock)).toEqual([
        "https://ctscout.dev/lei?name=Cloudflare%2C+Inc.",
        "https://ctscout.dev/lei?name=Cloudflare%2C+Inc.",
      ]);
    } finally {
      await close();
    }
  });

  it("explains name_match 'none' as a spelling miss, never as an absent LEI", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    mockApi({
      query: "Travelers Insurance",
      name_match: "none",
      leis: [],
      lei_count: 0,
      limit: 20,
      truncated: false,
      ...PRODUCT_PROVENANCE,
    });

    const { client, close } = await connect();

    try {
      const result = await client.callTool({
        name: "ctscout_lookup_lei",
        arguments: { name: "Travelers Insurance" },
      });
      expect(result.isError).not.toBe(true);
      const text = textOf(result);
      expect(text).toContain("does NOT mean this company has no LEI");
      expect(text).toContain("are not the index's normalizer");
      expect(text).not.toMatch(/has no LEI\.|no LEI exists/);
      expect(result.structuredContent).toMatchObject({ name_match: "none", lei_count: 0 });
    } finally {
      await close();
    }
  });

  it("returns the free vendor summary with candidates and confirmed kept apart", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const fetchMock = mockApi(VENDOR_SUMMARY);

    const { client, close } = await connect();

    try {
      const markdown = await client.callTool({
        name: "ctscout_vendor_customers",
        arguments: { slug: "cloudflare" },
      });
      expect(markdown.isError).not.toBe(true);
      const text = textOf(markdown);
      expect(text).toContain("| Candidates | 940 |");
      expect(text).toContain("| Confirmed | 128 |");
      // 940 + 128 must never appear as one number, and the text must say why.
      expect(text).not.toContain("1068");
      expect(text).toContain("never add them");
      expect(text).toContain(
        "a vendor is confirmed when a hostname it certified resolves onto a domain it certifies and the customer's own www does not",
      );
      // co_use is asymmetric and says so.
      expect(text).toContain("not a mutual confirmation");
      expect(markdown.structuredContent).toMatchObject({
        slug: "cloudflare",
        customers: { candidates: 940, confirmed: 128 },
        snapshot: "2026-09-01",
        snapshot_source: "product",
      });

      const json = await client.callTool({
        name: "ctscout_vendor_customers",
        arguments: { slug: "cloudflare", response_format: "json" },
      });
      expect(json.isError).not.toBe(true);
      expect(JSON.parse(textOf(json))).toMatchObject({
        customers: { candidates: 940, confirmed: 128 },
      });
      expect(calledUrls(fetchMock)).toEqual([
        "https://ctscout.dev/vendors/cloudflare",
        "https://ctscout.dev/vendors/cloudflare",
      ]);
    } finally {
      await close();
    }
  });

  it("enumerates a vendor's customers only when asked, from the keyed route", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const fetchMock = mockApi(VENDOR_CUSTOMERS);

    const { client, close } = await connect();

    try {
      const markdown = await client.callTool({
        name: "ctscout_vendor_customers",
        arguments: { slug: "cloudflare", enumerate: true },
      });
      expect(markdown.isError).not.toBe(true);
      const text = textOf(markdown);
      expect(text).toContain("## Confirmed — 1 listed of 1");
      expect(text).toContain("## Candidates — 2 listed of 900");
      expect(text).toContain("`confirmed-customer.example`");
      expect(text).toContain("Confirmed Customer Inc");
      // The research build's own cap is reported as the build's, not as ours.
      expect(text).toContain("The research build itself kept a subset");
      expect(markdown.structuredContent).toMatchObject({
        slug: "cloudflare",
        counts: { candidates: 900, confirmed: 1 },
        capped: true,
        snapshot_source: "product",
      });

      const json = await client.callTool({
        name: "ctscout_vendor_customers",
        arguments: { slug: "cloudflare", enumerate: true, response_format: "json" },
      });
      expect(json.isError).not.toBe(true);
      expect(JSON.parse(textOf(json))).toMatchObject({ capped: true });
      expect(calledUrls(fetchMock)).toEqual([
        "https://ctscout.dev/vendors/cloudflare/customers",
        "https://ctscout.dev/vendors/cloudflare/customers",
      ]);
    } finally {
      await close();
    }
  });

  it("keeps a huge customer enumeration under the character limit in both formats, and says what it dropped", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const row = (i: number) => ({
      apex: `customer-${i}.example.com`,
      attributed_to: `Customer ${i} Holdings Incorporated`,
      lei: `54930${String(i).padStart(13, "0")}LW17`,
    });
    mockApi({
      slug: "cloudflare",
      confirmed: Array.from({ length: 400 }, (_, i) => row(i)),
      candidates: Array.from({ length: 4000 }, (_, i) => row(i)),
      counts: { candidates: 4000, confirmed: 400 },
      capped: false,
      ...PRODUCT_PROVENANCE,
    });

    const { client, close } = await connect();

    try {
      const listedPerFormat: number[] = [];
      for (const response_format of ["markdown", "json"]) {
        const result = await client.callTool({
          name: "ctscout_vendor_customers",
          arguments: { slug: "cloudflare", enumerate: true, response_format },
        });
        expect(result.isError, response_format).not.toBe(true);
        const text = textOf(result);
        expect(text.length, response_format).toBeLessThanOrEqual(25_000);
        // counts and capped still describe the API's answer; the note is what
        // says this response is short of it.
        expect(result.structuredContent, response_format).toMatchObject({
          counts: { candidates: 4000, confirmed: 400 },
          capped: false,
        });
        const structured = result.structuredContent as {
          truncation_note?: string;
          candidates?: unknown[];
          confirmed?: unknown[];
        };
        expect(structured.truncation_note, response_format).toContain(
          "counts and capped describe the API's answer, not this list",
        );
        // The rows were dropped by the trim, not by the final clamp: a clamped
        // markdown would be a hard slice through a half-written table, and the
        // <= 25000 assertion above holds either way.
        expect(text, response_format).not.toContain("Response clamped to stay under");
        const listed = structured.candidates?.length ?? 0;
        const listedConfirmed = structured.confirmed?.length ?? 0;
        // Candidates are dropped first (the weaker claim), and 400 confirmed
        // rows alone are over budget, so this fixture keeps a short confirmed
        // list and no candidates — but never nothing at all.
        expect(listed, response_format).toBe(0);
        expect(listedConfirmed, response_format).toBeGreaterThan(0);
        expect(listedConfirmed, response_format).toBeLessThan(400);
        // The headings the reader sees name exactly the rows structuredContent
        // carries — the two halves of one response cannot disagree.
        if (response_format === "markdown") {
          expect(text).toContain(`## Candidates — ${listed} listed of 4000`);
          expect(text).toContain(`## Confirmed — ${listedConfirmed} listed of 400`);
        } else {
          expect(JSON.parse(text).candidates).toHaveLength(listed);
          expect(JSON.parse(text).confirmed).toHaveLength(listedConfirmed);
        }
        listedPerFormat.push(listedConfirmed);
      }
      // Both entries are read from structuredContent, so this only pins that the
      // two calls are deterministic. The markdown-vs-structured agreement is
      // asserted per format above, and at a row count inside the divergence
      // window by the test below.
      expect(listedPerFormat[0]).toBe(listedPerFormat[1]);
    } finally {
      await close();
    }
  });

  // The 400/4000 fixture above lands where trimming markdown and JSON
  // independently happens to keep the same rows, so it cannot see that defect.
  // A JSON row is wider than a table row, and at 46 confirmed / 187 candidates
  // the markdown fits whole while the JSON does not — the window where the two
  // views used to disagree: markdown listing all 187 with no notice beside a
  // structuredContent carrying 93 under a note describing rows nobody saw.
  it("never lets the markdown claim more rows than structuredContent carries", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const row = (i: number) => ({
      apex: `customer-${i}.example.com`,
      attributed_to: `Customer ${i} Holdings Incorporated`,
      lei: `54930${String(i).padStart(13, "0")}LW17`,
    });
    mockApi({
      slug: "cloudflare",
      confirmed: Array.from({ length: 46 }, (_, i) => row(i)),
      candidates: Array.from({ length: 187 }, (_, i) => row(i)),
      counts: { candidates: 187, confirmed: 46 },
      capped: false,
      ...PRODUCT_PROVENANCE,
    });

    const { client, close } = await connect();

    try {
      const markdown = await client.callTool({
        name: "ctscout_vendor_customers",
        arguments: { slug: "cloudflare", enumerate: true },
      });
      expect(markdown.isError).not.toBe(true);
      const text = textOf(markdown);
      const structured = markdown.structuredContent as {
        candidates?: unknown[];
        truncation_note?: string;
      };
      const listed = structured.candidates?.length ?? 0;
      // The trim fired, so this fixture really is inside the window.
      expect(listed).toBeGreaterThan(0);
      expect(listed).toBeLessThan(187);
      // The rendered heading, the rendered rows and the record must agree — and
      // the markdown must NOT read as the complete enumeration.
      expect(text).toContain(`## Candidates — ${listed} listed of 187`);
      expect(text).not.toContain("## Candidates — 187 listed of 187");
      expect(structured.truncation_note).toContain(`${listed} of 187 candidate rows`);
      expect(text).toContain(structured.truncation_note as string);
      // Count the rendered candidate rows directly: the heading could be right
      // while the table below it was not.
      const candidateSection = text.slice(text.indexOf("## Candidates"));
      expect((candidateSection.match(/^\| `customer-/gm) ?? []).length).toBe(listed);
    } finally {
      await close();
    }
  });

  it("surfaces 400, 404, 401 and the unpublished-product 503 as isError with no structuredContent", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const responses = [
      new Response(JSON.stringify({ detail: "Not found in the current research product" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(
        JSON.stringify({
          detail: "Research product not yet published (product/manifest.json is absent)",
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      ),
      new Response(JSON.stringify({ detail: "Missing X-API-Key header" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
      new Response(JSON.stringify({ detail: "name must not be empty" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    ];
    const fetchMock = vi.fn(async () => responses.shift() as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      const missing = await client.callTool({
        name: "ctscout_lookup_lei",
        arguments: { lei: LEI },
      });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("Not found in the current research product");
      expect(textOf(missing)).toContain("absence here is not evidence");
      expect(missing.structuredContent).toBeUndefined();

      const unpublished = await client.callTool({
        name: "ctscout_vendor_customers",
        arguments: { slug: "cloudflare" },
      });
      expect(unpublished.isError).toBe(true);
      expect(textOf(unpublished)).toContain("The research product is not published yet");
      expect(textOf(unpublished)).toContain("product/manifest.json is absent");
      expect(textOf(unpublished)).toContain("Nothing is wrong with the query");
      // Not the generic 5xx text: an unpublished product is not an outage.
      expect(textOf(unpublished)).not.toContain("ctscout server error");
      expect(unpublished.structuredContent).toBeUndefined();

      const unkeyed = await client.callTool({
        name: "ctscout_vendor_customers",
        arguments: { slug: "cloudflare", enumerate: true },
      });
      expect(unkeyed.isError).toBe(true);
      expect(textOf(unkeyed)).toContain("needs an active ctscout.dev API key");
      expect(textOf(unkeyed)).toContain("enumerate: false");
      expect(unkeyed.structuredContent).toBeUndefined();

      const bad = await client.callTool({
        name: "ctscout_lookup_lei",
        arguments: { name: "Cloudflare" },
      });
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain("Bad request: name must not be empty");
      expect(bad.structuredContent).toBeUndefined();
      expect(calledUrls(fetchMock)).toHaveLength(4);
    } finally {
      await close();
    }
  });

  it("rejects a malformed LEI, a malformed slug, and both-or-neither lookups before any network call", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { client, close } = await connect();

    try {
      for (const args of [
        { lei: "not-an-lei" },
        { lei: LEI, name: "Cloudflare, Inc." },
        {},
      ] as Record<string, unknown>[]) {
        const result = await client.callTool({ name: "ctscout_lookup_lei", arguments: args });
        expect(result.isError, JSON.stringify(args)).toBe(true);
        expect(result.structuredContent, JSON.stringify(args)).toBeUndefined();
      }
      const badSlug = await client.callTool({
        name: "ctscout_vendor_customers",
        arguments: { slug: "Cloudflare/../keys" },
      });
      expect(badSlug.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it("never says a vendor or an entity owns a domain", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        // "ownership claim" (which every tool disclaims) and "own www" (note
        // 2's definition) are the vocabulary; the bare verb is what is banned.
        expect(tool.description, tool.name).not.toMatch(/\bowns\b/);
      }
      for (const name of ["ctscout_lookup_lei", "ctscout_vendor_customers"]) {
        const description = tools.find((tool) => tool.name === name)?.description ?? "";
        expect(description, name).toContain(
          "a vendor is confirmed when a hostname it certified resolves onto a domain it certifies and the customer's own www does not",
        );
        expect(description, name).toMatch(/attributed|ATTRIBUTED/);
      }
      const vendor = tools.find((tool) => tool.name === "ctscout_vendor_customers")?.description;
      expect(vendor).toContain("NEVER summed");
      expect(vendor).toContain("SUBSET of candidates");
    } finally {
      await close();
    }
  });
});
