import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parser = resolve(root, "scripts/npm-json.mjs");
const fixture = (name: string) =>
  readFileSync(resolve(root, "tests/fixtures/npm-json", name), "utf8");
const pack = JSON.parse(fixture("pack10.json"))[0];
function parse(mode: string, input: string) {
  return spawnSync(
    process.execPath,
    [parser, mode, ...(mode === "pack" ? [pack.name, pack.version] : [])],
    {
      input,
      encoding: "utf8",
    },
  );
}

describe("strict npm JSON compatibility", () => {
  it.each(["pack10.json", "pack12.json"])("reads captured %s", (name) => {
    const result = parse("pack", fixture(name));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ctscout-mcp-server-0.6.1.tgz");
  });
  it.each(["view10.json", "view12.json"])("reads captured %s", (name) => {
    const result = parse("view", fixture(name));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("d542dd4c255d2f05d8e8c223abd7916c804a8d04");
  });
  it.each([
    null,
    {},
    [],
    [pack, pack],
    { [pack.name]: pack, other: pack },
    { other: pack },
    [{ ...pack, name: "wrong" }],
    [{ ...pack, version: "0.6.2" }],
    [{ ...pack, id: "wrong@0.6.1" }],
    [{ ...pack, filename: "../escaped.tgz" }],
    [{ ...pack, filename: "/tmp/archive.tgz" }],
    [{ ...pack, filename: "other.tgz" }],
    [{ ...pack, filename: "archive\n.tgz" }],
    { [pack.name]: [pack] },
  ])("refuses malformed or ambiguous pack output %#", (value) => {
    const result = parse("pack", JSON.stringify(value));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid npm JSON");
  });
  it.each([
    null,
    {},
    42,
    true,
    [],
    ["a", "b"],
    [["a"]],
    [null],
    "",
    "a\nb",
    " a",
  ])("refuses absent, ambiguous or non-scalar registry metadata %#", (value) => {
    const result = parse("view", JSON.stringify(value));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
  it.each(["", "{", "{}{}"])("refuses invalid JSON %j", (input) => {
    expect(parse("view", input).status).toBe(1);
    expect(parse("pack", input).status).toBe(1);
  });
});
