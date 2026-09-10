/**
 * Regression test for v0.2.0's `isDirectlyExecuted` symlink bug.
 *
 * v0.2.0 introduced a guard that compared `import.meta.url` to
 * `process.argv[1]` to decide whether to call `main()`. When the
 * binary was invoked via `npx` or `npm install -g`, `process.argv[1]`
 * was a symlink (e.g. `node_modules/.bin/ctscout-mcp-server ->
 * ../ctscout-mcp-server/dist/index.js`), but `import.meta.url` was
 * the realpath of the target. The string-equality check failed,
 * `main()` was never called, and the binary exited 0 with no output
 * — exactly the customer-visible symptom that surfaced after publish.
 *
 * This test boots the built dist/index.js via a real symlink, sends
 * an MCP `initialize` request on stdin, and confirms the server
 * responds. If the symlink-aware guard regresses, the spawn exits 0
 * with no output (just like v0.2.0 did) and this test fails.
 *
 * Runs in `tests/` not `tests/unit/` so it picks up Vitest's existing
 * setupFiles for CTSCOUT_API_KEY.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { initializeRequest, observeBoot } from "./boot-observer.js";

// ESM-native replacement for the CommonJS `__dirname` global. Vitest injects
// `__dirname` into test files, but the package is native ESM (`"type":
// "module"`) and the rest of the codebase resolves paths this way — see
// src/index.ts's `fileURLToPath(import.meta.url)` (ctscout-mcp#6).
const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const DIST_INDEX = resolve(CURRENT_DIR, "..", "dist", "index.js");
const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(CURRENT_DIR, "..", "package.json"), "utf8")) as {
    version: string;
  }
).version;

describe("isDirectlyExecuted (symlink boot)", () => {
  // Fixed repetitions are independent assertions, never retries of failures.
  for (const launch of ["direct", "symlink"] as const) {
    for (const attempt of [1, 2, 3]) {
      it.skipIf(!existsSync(DIST_INDEX))(`${launch} initializes, attempt ${attempt}`, async () => {
        const tmpDir = mkdtempSync(join(tmpdir(), "ctscout-symlink-"));
        const link = join(tmpDir, "ctscout-mcp-server");
        try {
          symlinkSync(DIST_INDEX, link);
          const proc = spawn(process.execPath, [launch === "symlink" ? link : DIST_INDEX], {
            env: { ...process.env, CTSCOUT_API_KEY: "ds_free_test" },
            stdio: ["pipe", "pipe", "pipe"],
          });
          const result = await observeBoot(proc, initializeRequest());
          expect(result.outcome, JSON.stringify(result)).toBe("ready");
          expect(result.response?.result).toMatchObject({
            serverInfo: { name: "ctscout-mcp-server", version: PKG_VERSION },
            capabilities: { tools: expect.any(Object) },
          });
          expect(result.stderr).toContain(`ctscout-mcp-server v${PKG_VERSION} running via stdio`);
        } finally {
          // observeBoot settles only after close, so this cannot remove a live
          // child's argv symlink before its direct-execution guard has run.
          rmSync(tmpDir, { recursive: true, force: true });
        }
      });
    }
  }

  it.skipIf(!existsSync(DIST_INDEX))(
    "initializes without a key and names the free tools",
    async () => {
      const { CTSCOUT_API_KEY: _dropped, ...envWithoutKey } = process.env;
      const proc = spawn(process.execPath, [DIST_INDEX], {
        env: envWithoutKey,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const result = await observeBoot(proc, initializeRequest());
      expect(result.outcome, JSON.stringify(result)).toBe("ready");
      expect(result.response?.result).toMatchObject({ serverInfo: { version: PKG_VERSION } });
      expect(result.stderr).toContain("CTSCOUT_API_KEY is not set");
      expect(result.stderr).toContain("ctscout_lookup_lei");
    },
  );
});
