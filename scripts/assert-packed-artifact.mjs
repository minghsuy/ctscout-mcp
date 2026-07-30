import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [packageRoot, stdoutPath, stderrPath, contentsPath] = process.argv.slice(2);
assert.ok(
  packageRoot && stdoutPath && stderrPath && contentsPath,
  "packed artifact paths are required",
);

const packedPaths = readFileSync(contentsPath, "utf8").trim().split("\n");
assert.ok(packedPaths.includes("package/dist/index.js"));
assert.ok(packedPaths.includes("package/dist/index.d.ts"));
assert.equal(
  packedPaths.some((path) => /^package\/(?:src|tests)\//.test(path)),
  false,
);

assert.ok(existsSync(join(packageRoot, "dist", "index.js")));
assert.ok(existsSync(join(packageRoot, "dist", "index.d.ts")));
assert.equal(existsSync(join(packageRoot, "src")), false);
assert.equal(existsSync(join(packageRoot, "tests")), false);

const stdout = readFileSync(stdoutPath, "utf8").trim();
const messages = stdout.split("\n").map((line) => JSON.parse(line));
const list = messages.find((message) => message.id === 2);
assert.ok(list, "packed server did not respond to tools/list");
assert.deepEqual(
  list.result.tools.map((tool) => tool.name),
  [
    "ctscout_search_company",
    "ctscout_search_company_batch",
    "ctscout_lookup_domain",
  ],
);

const search = list.result.tools.find(
  (tool) => tool.name === "ctscout_search_company",
);
assert.ok(search, "packed server omitted ctscout_search_company");
assert.deepEqual(search.inputSchema.required, ["company_name"]);
assert.equal(
  search.inputSchema.properties.strict_match_org_only.type,
  "boolean",
);
assert.deepEqual(search.inputSchema.properties.org_match_field.enum, [
  "verbatim",
  "normalized",
]);
assert.deepEqual(search.inputSchema.properties.org_match_mode.enum, [
  "substring",
  "word",
]);
assert.deepEqual(search.inputSchema.properties.purpose.enum, [
  "underwriting",
  "corporate_family",
]);

const stderr = readFileSync(stderrPath, "utf8");
assert.match(stderr, /running via stdio/);

const packedPackage = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
);
assert.equal(packedPackage.engines.node, ">=20");

process.stdout.write("packed artifact contract passed\n");
