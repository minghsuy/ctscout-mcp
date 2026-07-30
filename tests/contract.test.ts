import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type ScanResponse } from "../src/index.ts";

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

  it("advertises the stable three-tool surface and hosted search controls", async () => {
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
            enum: ["json", "markdown"],
            default: "markdown",
          },
        },
      });
      expect(search?.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
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
