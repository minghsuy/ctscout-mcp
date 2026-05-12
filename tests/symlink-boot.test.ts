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
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const DIST_INDEX = resolve(__dirname, "..", "dist", "index.js");

describe("isDirectlyExecuted (symlink boot)", () => {
  it("boots when invoked via a symlink (npx / npm install -g case)", async () => {
    if (!existsSync(DIST_INDEX)) {
      // `npm run build` should run before `npm test` in CI / via the
      // release script. Skip rather than false-fail if dist isn't there.
      console.warn(`SKIP: dist/index.js not built at ${DIST_INDEX}`);
      return;
    }

    const tmpDir = mkdtempSync(join(tmpdir(), "ctscout-symlink-"));
    const symlinkPath = join(tmpDir, "ctscout-mcp-server");
    try {
      symlinkSync(DIST_INDEX, symlinkPath);

      // Spawn the binary VIA THE SYMLINK — this is the exact code path
      // that v0.2.0 broke. With realpath-aware comparison, main() runs
      // and the server prints its boot banner to stderr.
      const proc = spawn("node", [symlinkPath], {
        env: {
          ...process.env,
          CTSCOUT_API_KEY: "ds_free_test",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Send an MCP `initialize` request — keeps the server alive long
      // enough to confirm it boots. If the guard is broken, the process
      // exits 0 before we even see stderr.
      proc.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "vitest-symlink-regression", version: "0.0.1" },
          },
          id: 1,
        }) + "\n",
      );

      // Give the server up to 3s to print its boot banner OR exit.
      await new Promise<void>((finish) => {
        const timer = setTimeout(() => {
          proc.kill();
          finish();
        }, 3000);
        proc.on("exit", () => {
          clearTimeout(timer);
          finish();
        });
      });

      // The boot banner contains the version string and "running via stdio".
      // v0.2.0's bug produced empty stderr.
      expect(stderr).toContain("running via stdio");
      expect(stderr).toContain("ctscout-mcp-server");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
