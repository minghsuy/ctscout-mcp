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
      thresholds: {
        statements: 80,
        branches: 90,
        functions: 93,
        lines: 80,
      },
    },
  },
});
