/**
 * Vitest setup file. Runs ONCE before any test module is imported.
 *
 * Sets CTSCOUT_API_KEY so the source module's `getApiKey()` call (if
 * exercised) doesn't throw. The MCP server's `main()` boot is gated
 * by an `isDirectlyExecuted` check so it won't auto-start when the
 * module is imported for tests — but `getApiKey()` is also called
 * from `callScan()`, which a future integration test may exercise.
 */
process.env.CTSCOUT_API_KEY = process.env.CTSCOUT_API_KEY ?? "ds_free_test";
