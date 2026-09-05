import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServer,
  type DomainResult,
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

  it("advertises the stable three-tool surface, hosted schemas, and quota-safe annotations", async () => {
    const { client, close } = await connect();

    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "ctscout_search_company",
        "ctscout_search_company_batch",
        "ctscout_lookup_domain",
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
      for (const tool of tools) {
        expect(tool.annotations).toEqual({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        });
        // Warehouse size changes weekly; a typed count drifts from the live site
        // and agents reason from it when judging a miss (#101).
        expect(tool.description).not.toMatch(
          /~?\d[\d,.]*[KkMm]?\s*(entities|orgs?|organizations|pairs)\b/,
        );
      }
      expect(search?.description).toContain("https://ctscout.dev/stats");
    } finally {
      await close();
    }
  });

  it("declares an outputSchema on every tool that requires snapshot and snapshot_source", async () => {
    const { client, close } = await connect();

    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(3);
      for (const tool of tools) {
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
      for (const tool of tools) {
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
});
