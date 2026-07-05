import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Node environment — the MCP server runs server-side, not in jsdom.
    environment: "node",
    // Match the existing src/tests layout; no special globbing needed.
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**/*.ts"],
      // Thresholds recalibrated for vitest 4's AST-aware V8 remapping
      // (branches 92.2→86.9, functions 95→82.75 on identical tests —
      // the metric definition changed, not the coverage). Kept 2-3pts
      // below measured, comparable snugness to the vitest 2 values.
      thresholds: {
        statements: 80,
        branches: 85,
        functions: 80,
        lines: 80,
      },
    },
  },
});
