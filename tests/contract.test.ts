import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ScanBatchResponse, type ScanResponse } from "../src/index.ts";

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
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({
      name: "ctscout-contract-test",
      version: "0.0.0",
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

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
      }
    } finally {
      await client.close();
      await server.close();
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
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({
      name: "ctscout-contract-test",
      version: "0.0.0",
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "ctscout_search_company_batch",
        arguments: {
          company_names: ["Alpha", "Beta", "Gamma"],
          response_format: "markdown",
        },
      });

      expect(result.isError).not.toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(String(url)).toMatch(/\/scan\/batch$/);
      expect(JSON.parse(String(init?.body))).toEqual({
        queries: [{ company_name: "Alpha" }, { company_name: "Beta" }, { company_name: "Gamma" }],
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.find((item) => item.type === "text")?.text ?? "";
      expect(text.indexOf("alpha.example")).toBeLessThan(text.indexOf("Beta Holdings"));
      expect(text.indexOf("Beta Holdings")).toBeLessThan(text.indexOf("HTTP 503"));
      expect(text).toContain("weak signal; corroborate before use");
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
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects an oversized batch before making a network call", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    globalThis.fetch = vi.fn();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({
      name: "ctscout-contract-test",
      version: "0.0.0",
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

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
      await client.close();
      await server.close();
    }
  });

  it("forwards explicitly supplied hosted search controls without changing defaults", async () => {
    process.env.CTSCOUT_API_KEY = "ds_free_contract_test";
    const response: ScanResponse = {
      domains: [],
      total: 0,
      source: "warehouse",
    };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    const client = new Client({
      name: "ctscout-contract-test",
      version: "0.0.0",
    });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

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
      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const [, init] = vi.mocked(globalThis.fetch).mock.calls[0];
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
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      const [, defaultInit] = vi.mocked(globalThis.fetch).mock.calls[1];
      expect(JSON.parse(String(defaultInit?.body))).toEqual({
        company_name: "Acme Corporation",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
