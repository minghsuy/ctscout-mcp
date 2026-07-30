import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";

const [
  packageRoot,
  installedBin,
  contentsPath,
  expectedVersion,
  expectedMcpServerVersion,
  lockedMcpServerSpecifier,
] = process.argv.slice(2);
assert.ok(
  packageRoot &&
    installedBin &&
    contentsPath &&
    expectedVersion &&
    expectedMcpServerVersion &&
    lockedMcpServerSpecifier,
  "packed artifact paths and expected versions are required",
);
assert.match(
  expectedMcpServerVersion,
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
  "the MCP server dependency must be an exact SemVer pin",
);
assert.equal(
  lockedMcpServerSpecifier,
  expectedMcpServerVersion,
  "the package lock must preserve the exact MCP server manifest pin",
);

const API_KEY = "ds_free_packed_contract_test";
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

const packedPaths = readFileSync(contentsPath, "utf8").trim().split("\n");
assert.ok(packedPaths.includes("package/dist/index.js"));
assert.ok(packedPaths.includes("package/dist/index.d.ts"));
assert.ok(packedPaths.includes("package/package.json"));
assert.equal(
  packedPaths.some((path) => /^package\/(?:src|tests|coverage|\.github)\//.test(path)),
  false,
);

assert.ok(existsSync(join(packageRoot, "dist", "index.js")));
assert.ok(existsSync(join(packageRoot, "dist", "index.d.ts")));
assert.equal(existsSync(join(packageRoot, "src")), false);
assert.equal(existsSync(join(packageRoot, "tests")), false);
assert.ok(existsSync(installedBin), "npm did not create the installed .bin entry");
assert.equal(realpathSync(installedBin), realpathSync(join(packageRoot, "dist", "index.js")));

const packedPackage = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
assert.equal(packedPackage.name, "ctscout-mcp-server");
assert.equal(packedPackage.version, expectedVersion);
assert.equal(packedPackage.engines.node, ">=20");
assert.equal(packedPackage.bin["ctscout-mcp-server"], "dist/index.js");
assert.equal(
  packedPackage.dependencies["@modelcontextprotocol/server"],
  expectedMcpServerVersion,
  "the packed manifest must preserve the exact MCP server pin",
);
assert.match(packedPackage.dependencies.zod, /^\^4\./);
assert.equal(packedPackage.dependencies["@modelcontextprotocol/sdk"], undefined);
const installedMcpPackagePath = join(
  packageRoot,
  "..",
  "@modelcontextprotocol",
  "server",
  "package.json",
);
assert.ok(
  existsSync(installedMcpPackagePath),
  "clean install omitted the MCP server runtime dependency",
);
const installedMcpPackage = JSON.parse(
  readFileSync(installedMcpPackagePath, "utf8"),
);
assert.equal(
  installedMcpPackage.version,
  expectedMcpServerVersion,
  "the installed MCP server runtime must match the exact packed manifest pin",
);

const apiRequests = [];
const api = createHttpServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    apiRequests.push({
      method: request.method,
      url: request.url,
      apiKey: request.headers["x-api-key"],
      userAgent: request.headers["user-agent"],
      body,
    });

    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/scan/batch") {
      response.end(
        JSON.stringify({
          results: body.queries.map((query, index) => ({
            query,
            domains: [
              {
                org: `${query.company_name} Incorporated`,
                apex_domain: `batch-${index}.example`,
                cert_count: index + 1,
                subdomain_count: 0,
              },
            ],
            total: 1,
            source: "warehouse",
            match_type: "exact",
            org_match_strategy: "substring",
          })),
          remaining_quota: 7,
        }),
      );
      return;
    }

    if (Array.isArray(body.seed_domain)) {
      response.end(
        JSON.stringify({
          domains: body.seed_domain.map((domain) => ({
            org: "Packed Lookup Incorporated",
            apex_domain: domain,
            cert_count: 2,
            subdomain_count: 1,
          })),
          total: body.seed_domain.length,
          source: "warehouse",
        }),
      );
      return;
    }

    response.end(
      JSON.stringify({
        domains: [
          {
            org: `${body.company_name} Incorporated`,
            apex_domain: "packed-search.example",
            cert_count: 3,
            subdomain_count: 1,
          },
        ],
        total: 1,
        source: "warehouse",
      }),
    );
  });
});

await new Promise((resolve, reject) => {
  api.once("error", reject);
  api.listen(0, "127.0.0.1", resolve);
});
const address = api.address();
assert.ok(address && typeof address === "object");
const apiBaseUrl = `http://127.0.0.1:${address.port}`;

function launchPackedServer() {
  const child = spawn(installedBin, [], {
    env: {
      ...process.env,
      CTSCOUT_API_KEY: API_KEY,
      CTSCOUT_API_URL: apiBaseUrl,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderr = "";
  const stdoutLines = [];
  const pending = new Map();
  let protocolFailure;

  const rejectPending = (error) => {
    protocolFailure ??= error;
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    while (stdoutBuffer.includes("\n")) {
      const newline = stdoutBuffer.indexOf("\n");
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      stdoutLines.push(line);
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        rejectPending(new Error(`non-JSON stdout from installed binary: ${line}`, { cause: error }));
        continue;
      }
      const waiter = pending.get(String(message.id));
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(String(message.id));
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  child.once("error", rejectPending);
  child.once("close", (code, signal) => {
    if (pending.size > 0) {
      rejectPending(
        new Error(`installed binary closed before replying (code=${code}, signal=${signal})`),
      );
    }
  });

  const send = (message) => {
    assert.equal(protocolFailure, undefined);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  return {
    child,
    send,
    request(message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(String(message.id));
          reject(new Error(`timed out waiting for JSON-RPC id ${message.id}`));
        }, 5_000);
        pending.set(String(message.id), { resolve, reject, timer });
        send(message);
      });
    },
    async close() {
      child.stdin.end();
      await Promise.race([
        new Promise((resolve) => child.once("close", resolve)),
        new Promise((resolve) =>
          setTimeout(() => {
            child.kill();
            resolve();
          }, 3_000),
        ),
      ]);
      assert.equal(protocolFailure, undefined);
      assert.equal(stdoutBuffer.trim(), "", "installed binary left partial stdout");
      assert.ok(stdoutLines.length > 0, "installed binary emitted no protocol stdout");
      assert.equal(stdoutLines.some((line) => line.includes(API_KEY)), false);
      assert.equal(stderr.includes(API_KEY), false);
      const stderrLines = stderr
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      assert.deepEqual(stderrLines, [
        `ctscout-mcp-server v${expectedVersion} running via stdio (api=${apiBaseUrl})`,
      ]);
    },
  };
}

const modernMeta = {
  [PROTOCOL_VERSION_META_KEY]: MODERN_VERSION,
  [CLIENT_INFO_META_KEY]: { name: "packed-modern-client", version: "0.0.0" },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

try {
  const modern = launchPackedServer();
  const discover = await modern.request({
    jsonrpc: "2.0",
    id: "discover",
    method: "server/discover",
    params: { _meta: modernMeta },
  });
  assert.equal(discover.error, undefined);
  assert.ok(discover.result.supportedVersions.includes(MODERN_VERSION));
  assert.deepEqual(discover.result.capabilities.tools, { listChanged: true });
  assert.deepEqual(discover.result._meta[SERVER_INFO_META_KEY], {
    name: "ctscout-mcp-server",
    version: expectedVersion,
  });

  const modernList = await modern.request({
    jsonrpc: "2.0",
    id: "modern-list",
    method: "tools/list",
    params: { _meta: modernMeta },
  });
  assert.equal(modernList.error, undefined);
  assert.equal(modernList.result.resultType, "complete");
  assert.deepEqual(
    modernList.result.tools.map((tool) => tool.name),
    [
      "ctscout_search_company",
      "ctscout_search_company_batch",
      "ctscout_lookup_domain",
    ],
  );

  const modernBatch = await modern.request({
    jsonrpc: "2.0",
    id: "modern-batch",
    method: "tools/call",
    params: {
      name: "ctscout_search_company_batch",
      arguments: { company_names: ["Alpha", "Beta"], response_format: "json" },
      _meta: modernMeta,
    },
  });
  assert.equal(modernBatch.error, undefined);
  assert.equal(modernBatch.result.resultType, "complete");
  assert.deepEqual(
    modernBatch.result.structuredContent.results.map((item) => item.query.company_name),
    ["Alpha", "Beta"],
  );
  await modern.close();

  const legacy = launchPackedServer();
  const initialized = await legacy.request({
    jsonrpc: "2.0",
    id: "initialize",
    method: "initialize",
    params: {
      protocolVersion: LEGACY_VERSION,
      capabilities: {},
      clientInfo: { name: "packed-legacy-client", version: "0.0.0" },
    },
  });
  assert.equal(initialized.error, undefined);
  assert.equal(initialized.result.protocolVersion, LEGACY_VERSION);
  assert.deepEqual(initialized.result.serverInfo, {
    name: "ctscout-mcp-server",
    version: expectedVersion,
  });
  legacy.send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });

  const legacyList = await legacy.request({
    jsonrpc: "2.0",
    id: "legacy-list",
    method: "tools/list",
    params: {},
  });
  assert.equal(legacyList.error, undefined);
  assert.equal(legacyList.result.resultType, undefined);

  const search = legacyList.result.tools.find(
    (tool) => tool.name === "ctscout_search_company",
  );
  assert.ok(search, "packed server omitted ctscout_search_company");
  assert.deepEqual(search.inputSchema.required, ["company_name"]);
  assert.equal(search.inputSchema.additionalProperties, false);
  assert.equal(search.inputSchema.properties.strict_match_org_only.type, "boolean");
  assert.deepEqual(search.inputSchema.properties.org_match_field.enum, [
    "verbatim",
    "normalized",
  ]);
  assert.deepEqual(search.inputSchema.properties.org_match_mode.enum, ["substring", "word"]);
  assert.deepEqual(search.inputSchema.properties.purpose.enum, [
    "underwriting",
    "corporate_family",
  ]);
  assert.deepEqual(search.inputSchema.properties.response_format.enum, ["markdown", "json"]);

  const batch = legacyList.result.tools.find(
    (tool) => tool.name === "ctscout_search_company_batch",
  );
  assert.ok(batch, "packed server omitted ctscout_search_company_batch");
  assert.deepEqual(batch.inputSchema.required, ["company_names"]);
  assert.equal(batch.inputSchema.properties.company_names.minItems, 1);
  assert.equal(batch.inputSchema.properties.company_names.maxItems, 10);
  assert.equal(batch.inputSchema.properties.company_names.items.minLength, 2);
  assert.equal(batch.inputSchema.properties.company_names.items.maxLength, 200);
  assert.deepEqual(batch.inputSchema.properties.response_format.enum, ["markdown", "json"]);

  for (const tool of legacyList.result.tools) {
    assert.deepEqual(tool.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  }

  const legacySearch = await legacy.request({
    jsonrpc: "2.0",
    id: "legacy-search",
    method: "tools/call",
    params: {
      name: "ctscout_search_company",
      arguments: { company_name: "Packed Search", response_format: "json" },
    },
  });
  assert.equal(legacySearch.error, undefined);
  assert.equal(
    legacySearch.result.structuredContent.domains[0].apex_domain,
    "packed-search.example",
  );

  const legacyLookup = await legacy.request({
    jsonrpc: "2.0",
    id: "legacy-lookup",
    method: "tools/call",
    params: {
      name: "ctscout_lookup_domain",
      arguments: { domains: ["packed-lookup.example"], response_format: "json" },
    },
  });
  assert.equal(legacyLookup.error, undefined);
  assert.equal(
    legacyLookup.result.structuredContent.domains[0].apex_domain,
    "packed-lookup.example",
  );
  await legacy.close();
} finally {
  await new Promise((resolve) => api.close(resolve));
}

assert.deepEqual(
  apiRequests.map(({ method, url, apiKey, userAgent }) => ({
    method,
    url,
    apiKey,
    userAgent,
  })),
  [
    {
      method: "POST",
      url: "/scan/batch",
      apiKey: API_KEY,
      userAgent: `ctscout-mcp-server/${expectedVersion}`,
    },
    {
      method: "POST",
      url: "/scan",
      apiKey: API_KEY,
      userAgent: `ctscout-mcp-server/${expectedVersion}`,
    },
    {
      method: "POST",
      url: "/scan",
      apiKey: API_KEY,
      userAgent: `ctscout-mcp-server/${expectedVersion}`,
    },
  ],
);
assert.deepEqual(apiRequests[0].body, {
  queries: [{ company_name: "Alpha" }, { company_name: "Beta" }],
});
assert.deepEqual(apiRequests[1].body, { company_name: "Packed Search" });
assert.deepEqual(apiRequests[2].body, { seed_domain: ["packed-lookup.example"] });

process.stdout.write("packed artifact install + modern/legacy protocol contract passed\n");
