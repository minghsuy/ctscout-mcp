/**
 * Pins the public claims in README.md and LIMITATIONS.md to the code that
 * has to honour them (ctscout-mcp#116). The tool descriptions, the markdown
 * the tools render and the README are read by users and by models, and they
 * drift from the code silently: every assertion here is a claim a reader can
 * act on, read back from the prose and checked against the registry, the
 * renderers or the package manifest.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import {
  ApiError,
  type ConfidenceBand,
  createServer,
  type DomainResult,
  explainError,
  formatScanAsMarkdown,
  SERVER_NAME,
} from "../src/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const README = readFileSync(resolve(ROOT, "README.md"), "utf8");
const LIMITATIONS = readFileSync(resolve(ROOT, "LIMITATIONS.md"), "utf8");
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  engines: { node: string };
};
const DIST_INDEX = resolve(ROOT, "dist", "index.js");

// The tool names the hosted MCP at https://ctscout.dev/mcp advertises: the
// list ctscout-worker's scripts/verify-production-deploy.sh asserts against
// production on every deploy. When the Worker mirrors a tool, this list grows
// and the README's parity exception must shrink by the same name.
const HOSTED_TOOLS = [
  "ctscout_get_job",
  "ctscout_lookup_domain",
  "ctscout_search_company",
  "ctscout_search_company_batch",
  "ctscout_submit_deep_dive",
].sort();

// The tiers table at https://ctscout.dev/#tiers, mirrored row for row as of
// 2026-09-07. The README says it mirrors the product page; this is the copy
// the test can read offline, so a change on the site is a change here first.
const SITE_TIERS = [
  ["Lookups", "10 / day", "3,000 / month included"],
  ["Results", "Top 5", "Top 25"],
  ["History window", "Last 90 days", "Up to 12 months"],
  ["Deep-dive jobs (async)", "—", "20 / day"],
  ["Data", "Daily snapshot", "Daily snapshot"],
  ["Customer lists", "Included", "Included"],
  ["Price", "$0", "$49 / month — subscribe, the key comes by email within a day"],
];
const STRIPE_LINK = "https://buy.stripe.com/cNifZg9lddom9rF8iLasg00";
const TERMS_LINK = "https://ctscout.dev/terms/";

// Note 2's definition of a confirmed vendor has two paths; round five of #115
// found prose giving only the first.
const CONFIRMED_PATHS = [
  "the customer's own www does not",
  "another organization certifies the apex",
];

// Wording from the concierge era: Pro is now priced and subscribed through
// Stripe, and the free tier's daily counter is the only quota a caller hits.
const RETIRED_TIER_WORDING = /unlimited|concierge|no checkout|early access/i;

const NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];

// The README hard-wraps prose, so every textual claim is read from the
// whitespace-flattened text.
function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

function cells(line: string): string[] {
  return line
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
}

function tableRows(markdown: string, header: string): string[][] {
  const lines = markdown.split("\n");
  const wanted = cells(header).join("|");
  const start = lines.findIndex((line) => line.startsWith("|") && cells(line).join("|") === wanted);
  expect(start, `table header ${JSON.stringify(header)} not found`).toBeGreaterThan(-1);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(cells(line));
  }
  return rows;
}

function stripLinks(cell: string): string {
  return cell.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function paragraphContaining(markdown: string, needle: string): string {
  const paragraph = markdown
    .split(/\n\s*\n/)
    .map(flat)
    .find((block) => block.includes(needle));
  expect(paragraph, `no paragraph contains ${JSON.stringify(needle)}`).toBeDefined();
  return paragraph as string;
}

function sentenceContaining(markdown: string, needle: string): string {
  const sentence = flat(markdown)
    .split(/\.\s+/)
    .find((candidate) => candidate.includes(needle));
  expect(sentence, `no sentence contains ${JSON.stringify(needle)}`).toBeDefined();
  return sentence as string;
}

function backtickedTools(text: string): string[] {
  return [...text.matchAll(/`(ctscout_[a-z_]+)`/g)].map((match) => match[1]).sort();
}

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  const client = new Client({ name: "ctscout-docs-claims-test", version: "0.0.0" });
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

type ToolInfo = { name: string; description?: string; inputSchema: Record<string, unknown> };

async function listTools(): Promise<ToolInfo[]> {
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    return tools as ToolInfo[];
  } finally {
    await close();
  }
}

const PRODUCT_PROVENANCE = {
  as_of: "2026-09-01",
  product_version: "2026-09-01",
  snapshot_dates: { gleif: "2026-08-28" },
};

describe("README and LIMITATIONS claims are pinned to the code", () => {
  it("lists exactly the registered tools, in registry order, and counts them", async () => {
    const tools = await listTools();
    const listed = [...README.matchAll(/^- \*\*`(ctscout_[a-z_]+)`\*\*/gm)].map((m) => m[1]);
    expect(listed).toEqual(tools.map((tool) => tool.name));
    expect(README).toContain(`${NUMBER_WORDS[tools.length]} tools:`);
  });

  it("names as the transport-parity exception exactly the tools the hosted MCP does not advertise", async () => {
    const registry = (await listTools()).map((tool) => tool.name).sort();
    for (const hosted of HOSTED_TOOLS) expect(registry).toContain(hosted);
    const stdioOnly = registry.filter((name) => !HOSTED_TOOLS.includes(name));
    // The README states the exception twice — once where the hosted endpoint
    // is introduced, once in the transport-differences paragraph — and both
    // must name the same set.
    for (const needle of [
      "not advertised by the hosted endpoint yet",
      "does not advertise them yet",
    ]) {
      expect(backtickedTools(sentenceContaining(README, needle)), needle).toEqual(stdioOnly);
    }
  });

  it("gives both paths of the confirmed-vendor definition wherever confirmation is defined", async () => {
    const definition = paragraphContaining(README, "a vendor is confirmed when");
    for (const path of CONFIRMED_PATHS) expect(definition).toContain(path);

    const tools = await listTools();
    for (const name of ["ctscout_lookup_lei", "ctscout_vendor_customers"]) {
      const description = tools.find((tool) => tool.name === name)?.description ?? "";
      for (const path of CONFIRMED_PATHS) expect(description, name).toContain(path);
    }

    // The rendered markdown carries the definition too: the LEI record beside
    // its vendor slugs, the vendor summary and the enumeration beside their
    // confirmed counts.
    process.env.CTSCOUT_API_KEY = "ds_free_docs_test";
    const payloads = [
      {
        lei: "549300NDMY0KJK0ZLW17",
        legal_name: "Example Corp",
        country: "US",
        isin_count: 0,
        apex_count: 1,
        first_seen: "2025-01-01T00:00:00Z",
        last_seen: "2026-01-01T00:00:00Z",
        sample_domains: ["example.com"],
        vendors_confirmed: ["vendor"],
        ...PRODUCT_PROVENANCE,
      },
      {
        slug: "vendor",
        vendor_name: "Vendor Inc",
        vendor_apex: "vendor.example",
        customers: { candidates: 2, confirmed: 1 },
        countries_top: [],
        co_use: [],
        sample_customers: ["example.com"],
        ...PRODUCT_PROVENANCE,
      },
      {
        slug: "vendor",
        confirmed: [{ apex: "example.com", attributed_to: "Example Corp", lei: null }],
        candidates: [{ apex: "example.com", attributed_to: "Example Corp", lei: null }],
        counts: { candidates: 1, confirmed: 1 },
        capped: false,
        ...PRODUCT_PROVENANCE,
      },
    ];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(payloads.shift()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const { client, close } = await connect();
    try {
      const calls = [
        { name: "ctscout_lookup_lei", arguments: { lei: "549300NDMY0KJK0ZLW17" } },
        { name: "ctscout_vendor_customers", arguments: { slug: "vendor" } },
        { name: "ctscout_vendor_customers", arguments: { slug: "vendor", enumerate: true } },
      ];
      for (const call of calls) {
        const result = await client.callTool(call);
        expect(result.isError, JSON.stringify(call)).not.toBe(true);
        for (const path of CONFIRMED_PATHS)
          expect(textOf(result), JSON.stringify(call)).toContain(path);
      }
    } finally {
      await close();
      globalThis.fetch = originalFetch;
    }
  });

  it("mirrors the tiers table from https://ctscout.dev/#tiers row for row", () => {
    const rows = tableRows(README, "| | Free | Pro |").map((row) => row.map(stripLinks));
    expect(rows).toEqual(SITE_TIERS);
    const priceRow = tableRows(README, "| | Free | Pro |").at(-1) as string[];
    expect(priceRow[2]).toContain(`[subscribe](${STRIPE_LINK})`);
    expect(README).toContain(`<${TERMS_LINK}>`);
    expect(README).toContain("https://ctscout.dev/#tiers");

    // LIMITATIONS restates the same numbers in prose.
    expect(LIMITATIONS).toContain("10 queries per day");
    expect(LIMITATIONS).toContain("3,000 `/scan` lookups a month");
    expect(LIMITATIONS).toContain("20 deep-dive jobs a day");
    expect(LIMITATIONS).toContain("$49 a month");
    expect(LIMITATIONS).toContain("https://ctscout.dev/#tiers");
  });

  it("carries no retired tier wording anywhere a user or a model reads", async () => {
    expect(README).not.toMatch(RETIRED_TIER_WORDING);
    expect(LIMITATIONS).not.toMatch(RETIRED_TIER_WORDING);
    for (const tool of await listTools()) {
      expect(tool.description, tool.name).not.toMatch(RETIRED_TIER_WORDING);
    }
    expect(explainError(new ApiError(429, "Quota"), "scan")).not.toMatch(RETIRED_TIER_WORDING);
    expect(explainError(new ApiError(403, "Forbidden"), "jobs")).not.toMatch(RETIRED_TIER_WORDING);
    expect(explainError(new ApiError(403, "Forbidden"), "jobs")).toContain(
      "https://ctscout.dev/#tiers",
    );
  });

  it("states the caps and quotas the registry advertises", async () => {
    const tools = await listTools();
    const byName = (name: string) => tools.find((tool) => tool.name === name) as ToolInfo;
    const maxItems = (tool: ToolInfo, field: string): number =>
      ((tool.inputSchema.properties as Record<string, { maxItems: number }>)[field] ?? {}).maxItems;

    const batchMax = maxItems(byName("ctscout_search_company_batch"), "company_names");
    expect(README).toContain(`for up to ${batchMax} organization names in one call`);
    expect(README).toContain(`(1–${batchMax} organization names,`);

    const seedMax = maxItems(byName("ctscout_submit_deep_dive"), "seed_domain");
    expect(README).toContain(`\`seed_domain\` (max ${seedMax}, validated exactly like \`/scan\`)`);

    const submit = byName("ctscout_submit_deep_dive").description ?? "";
    const jobsPerDay = submit.match(/(\d+) submissions per key per day/)?.[1];
    expect(jobsPerDay).toBeDefined();
    expect(README).toContain(`quota is ${jobsPerDay} submissions per key per day`);
    expect(README).toContain(`| Deep-dive jobs (async) | — | ${jobsPerDay} / day |`);
    expect(LIMITATIONS).toContain(`limited to ${jobsPerDay} submissions per key per day`);

    const lei = byName("ctscout_lookup_lei").description ?? "";
    const leiLimit = lei.match(/capped at "limit" \((\d+)\)/)?.[1];
    expect(leiLimit).toBeDefined();
    expect(README).toContain(`\`leis\` is capped at \`limit\` (${leiLimit})`);

    const lookup = byName("ctscout_lookup_domain").description ?? "";
    const domainsMax = maxItems(byName("ctscout_lookup_domain"), "domains");
    expect(lookup).toContain(`Max ${domainsMax} per call`);
  });

  it("shows a Pro example table that the deep-dive renderer produces verbatim", () => {
    const header = "| Domain | Attributed to | Band | Signals | Evidence |";
    const example = README.slice(README.indexOf("A deep-dive job result replaces it"));
    const shown = tableRows(example, header);
    expect(shown.length).toBeGreaterThan(0);

    const rows: DomainResult[] = shown.map(([domain, org, band, signals, evidence]) => {
      const named = signals.split(", ").filter((signal) => !signal.startsWith("+"));
      const extra = Number(signals.match(/\+(\d+)$/)?.[1] ?? 0);
      const matchedVia = [
        ...named,
        ...Array.from({ length: extra }, (_, i) => `further_signal_${i + 1}`),
      ];
      return {
        apex_domain: domain.replace(/`/g, ""),
        attributed_to: org,
        enrichment: {
          confidence_band: band.split(" ")[1] as ConfidenceBand,
          weight_total: 0,
          matched_via: matchedVia,
          evidence: { [named[0]]: evidence },
          signal_health: {},
          vlm_status: "skipped",
          vlm_override: false,
        },
      };
    });
    const rendered = formatScanAsMarkdown("Coalition Inc", {
      domains: rows,
      total: rows.length,
      truncated: false,
      source: "live-enriched",
    });
    expect(tableRows(rendered, header)).toEqual(shown);
    // The band tag the README reserves for a VLM veto is the renderer's.
    expect(README).toContain("`🚫VLM-veto`");
    expect(
      formatScanAsMarkdown("x", {
        domains: [{ ...rows[0], enrichment: { ...rows[0].enrichment, vlm_override: true } }],
        total: 1,
        truncated: false,
        source: "live-enriched",
      }),
    ).toContain(" 🚫VLM-veto");
  });

  it("documents npm scripts that exist and the Node floor package.json enforces", () => {
    const local = README.slice(README.indexOf("## Local development"));
    const scripts = [...local.matchAll(/npm run (\S+)/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) expect(PACKAGE.scripts, script).toHaveProperty(script);
    const floor = PACKAGE.engines.node.match(/^>=(\d+)$/)?.[1];
    expect(floor).toBeDefined();
    expect(flat(README)).toContain(`Node.js ${floor} or newer`);
  });

  it.skipIf(!existsSync(DIST_INDEX))(
    "answers the README handshake example with capabilities and tool registration",
    async () => {
      const example = README.slice(README.indexOf("### Test the protocol handshake"));
      const request = example.match(
        /echo '(\{.*\})' \| \\\n\s*CTSCOUT_API_KEY=fake node dist\/index\.js/,
      )?.[1];
      expect(request).toBeDefined();
      const parsed = JSON.parse(request as string) as { id: number; method: string };
      expect(parsed.method).toBe("initialize");

      const proc = spawn("node", [DIST_INDEX], {
        env: { ...process.env, CTSCOUT_API_KEY: "fake" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      const reply = await new Promise<Record<string, unknown> | undefined>((finish) => {
        const timer = setTimeout(() => {
          proc.kill();
          finish(undefined);
        }, 5000);
        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            try {
              const message = JSON.parse(line) as { id?: number };
              if (message.id === parsed.id) {
                clearTimeout(timer);
                proc.kill();
                finish(message as Record<string, unknown>);
              }
            } catch {
              // partial line; wait for more
            }
          }
        });
        proc.stdin.write(`${request}\n`);
      });
      expect(reply).toBeDefined();
      const result = (reply as { result: Record<string, unknown> }).result;
      expect(result.capabilities).toHaveProperty("tools");
      expect(result.serverInfo).toMatchObject({ name: SERVER_NAME });
    },
  );
});
