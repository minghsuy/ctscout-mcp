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
  // `npm run build` should run before `npm test` in CI / via the release
  // script. Skip explicitly (so Vitest reports skipped, not 0-assertion pass)
  // if dist isn't there.
  it.skipIf(!existsSync(DIST_INDEX))(
    "boots when invoked via a symlink (npx / npm install -g case)",
    async () => {
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

        // Resolve as soon as the boot banner appears on stderr — the healthy
        // server never exits on its own, so waiting for `close` used to burn
        // the full 3s on every run (ctscout-mcp#50). The substring asserted
        // below ends at "running via stdio" (the banner itself continues with
        // "(api=...)"), and stderr accumulates in order — so once this marker
        // is present, everything the assertion needs is already captured.
        // The 3s timer and the `close` listener stay as backstops for the
        // regression case (broken guard → process exits 0 with empty stderr;
        // `close`, not `exit`, so piped stderr has flushed before we assert).
        await new Promise<void>((finish) => {
          const timer = setTimeout(() => {
            proc.kill();
            finish();
          }, 3000);
          const done = () => {
            clearTimeout(timer);
            finish();
          };
          proc.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
            if (stderr.includes("running via stdio")) {
              proc.kill();
              done();
            }
          });
          proc.on("close", done);
        });

        // The boot banner contains the version string and "running via stdio".
        // v0.2.0's bug produced empty stderr. SERVER_VERSION is read from
        // package.json at RUNTIME, so asserting the exact version here also
        // pins that dist/index.js resolves ../package.json from its built
        // location — on the same symlinked-argv[1] path npx uses.
        expect(stderr).toContain(`ctscout-mcp-server v${PKG_VERSION} running via stdio`);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );
});
