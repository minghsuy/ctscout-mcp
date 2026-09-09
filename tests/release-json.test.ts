import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const head = "1234567890123456789012345678901234567890";
const trees: string[] = [];
afterEach(() => {
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
});
function release(gitHead: unknown, singleton: boolean, fresh = false, version: unknown = "0.6.1") {
  const tree = mkdtempSync(join(tmpdir(), "ctscout-release-json-"));
  trees.push(tree);
  mkdirSync(join(tree, "scripts"));
  mkdirSync(join(tree, "bin"));
  for (const file of ["release.sh", "npm-json.mjs"])
    copyFileSync(join(root, "scripts", file), join(tree, "scripts", file));
  writeFileSync(
    join(tree, "package.json"),
    JSON.stringify({ name: "ctscout-mcp-server", version: "0.6.1" }),
  );
  writeFileSync(join(tree, "CHANGELOG.md"), "## [0.6.1] - 2026-09-08\n");
  const stubs: Record<string, string> = {
    git: `case "$*" in
      'rev-parse HEAD'|'rev-parse origin/main') echo "$TEST_HEAD";;
      'rev-parse --abbrev-ref HEAD') echo main;;
      'rev-parse --verify --quiet '*) exit 1;;
      'status --porcelain'|'fetch origin main --tags'|'ls-remote --tags '*) ;;
      'tag '*|'push '*) echo "git $*" >> "$TEST_LOG";;
      *) echo "unexpected git $*" >&2; exit 9;;
    esac`,
    npm: `case "$*" in
      'view ctscout-mcp-server@0.6.1 version --json')
        if [ "$TEST_FRESH" = 1 ]; then echo E404 >&2; exit 1; fi
        echo "$TEST_VERSION";;
      'view ctscout-mcp-server@0.6.1 gitHead --json') echo "$TEST_GIT_HEAD";;
      ci|'run '*|test|'audit '*|publish*) echo "npm $*" >> "$TEST_LOG";;
      *) echo "unexpected npm $*" >&2; exit 9;;
    esac`,
    gh: `case "$*" in
      'release view '*) echo 'release not found' >&2; exit 1;;
      'release create '*) echo "gh $*" >> "$TEST_LOG";;
      *) echo "unexpected gh $*" >&2; exit 9;;
    esac`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    const path = join(tree, "bin", name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -eu\n${body}\n`);
    chmodSync(path, 0o755);
  }
  const log = join(tree, "actions.log");
  writeFileSync(log, "");
  const result = spawnSync("bash", [join(tree, "scripts/release.sh"), "0.6.1"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(tree, "bin")}:${process.env.PATH}`,
      TEST_HEAD: head,
      TEST_LOG: log,
      TEST_FRESH: fresh ? "1" : "0",
      TEST_VERSION: JSON.stringify(singleton ? [version] : version),
      TEST_GIT_HEAD: JSON.stringify(singleton ? [gitHead] : gitHead),
    },
  });
  return { ...result, actions: readFileSync(log, "utf8") };
}

describe("release registry provenance with npm10/12 JSON (all external commands stubbed)", () => {
  it.each([
    false,
    true,
  ])("resumes only the identical published commit; singleton=%s", (singleton) => {
    const result = release(head, singleton);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("already exists at this exact commit; resuming");
    expect(result.actions).not.toContain("npm publish");
    expect(result.actions).toContain("git tag");
    expect(result.actions).toContain("gh release create");
  });
  it.each([false, true])("refuses an existing different commit; singleton=%s", (singleton) => {
    const result = release("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", singleton);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already exists from another commit");
    expect(result.actions).toBe("");
  });
  it.each([
    false,
    true,
  ])("never tags after a post-publish provenance mismatch; singleton=%s", (singleton) => {
    const result = release("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", singleton, true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("registry gitHead verification failed");
    expect(result.actions).toContain("npm publish");
    expect(result.actions).not.toContain("git tag");
    expect(result.actions).not.toContain("gh release create");
  });
  it.each([
    null,
    {},
    [head, head],
  ])("refuses ambiguous/missing gitHead before mutation %#", (value) => {
    const result = release(value, false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid npm JSON");
    expect(result.actions).toBe("");
  });
  it.each([
    "0.6.2",
    ["0.6.1", "0.6.2"],
  ])("refuses wrong or multiple registry versions %#", (version) => {
    const result = release(head, false, false, version);
    expect(result.status).toBe(1);
    expect(result.actions).toBe("");
  });
});
