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

  it("advertises the stable five-tool surface, hosted schemas, and quota-safe annotations", async () => {
    const { client, close } = await connect();

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "ctscout_search_company",
        "ctscout_search_company_batch",
        "ctscout_lookup_domain",
        "ctscout_submit_deep_dive",
        "ctscout_get_job",
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
      };
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toEqual(expectedAnnotations[tool.name]);
        // Warehouse size changes weekly; a typed count drifts from the live site
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
        expect(description, tool?.name).toContain("Pro /scan");
        expect(description, tool?.name).toContain('"Attributed"');
        expect(description, tool?.name).toContain('"Candidate"');
      }
      expect(submit?.description).toContain("20 submissions per key per day");
    } finally {
      await close();
    }
  });

  it("declares an outputSchema on every tool; every result-bearing tool requires snapshot and snapshot_source", async () => {
    const { client, close } = await connect();

    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(5);
      // A submission receipt carries no attribution data, so it carries no
      // snapshot either: a date there would be invented.
      const submit = tools.find((tool) => tool.name === "ctscout_submit_deep_dive");
      expect(submit?.outputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["job_id", "status", "submitted_at"]),
      });
      expect(submit?.outputSchema?.properties).not.toHaveProperty("snapshot");
      const resultBearing = tools.filter((tool) => tool.name !== "ctscout_submit_deep_dive");
      expect(resultBearing).toHaveLength(4);
      for (const tool of resultBearing) {
        expect(tool.outputSchema, tool.name).toMatchObject({
          type: "object",
          properties: {
            snapshot: { anyOf: [{ type: "string" }, { type: "null" }] },
            snapshot_source: { type: "string", enum: ["scan", "unavailable"] },
          },
        });
        expect(tool.outputSchema?.required, tool.name).toEqual(
          expect.arrayContaining(["snapshot", "snapshot_source"]),
        );
      }

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
      // The submission receipt carries no snapshot (nothing attributed yet).
      for (const tool of tools.filter((t) => t.name !== "ctscout_submit_deep_dive")) {
        expect(tool.outputSchema?.properties, tool.name).toMatchObject({
          snapshot_source: { enum: ["scan", "unavailable"] },
        });
      }

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
});
