# ctscout-mcp — Agent Guidelines

## Pre-Session Checklist

Before starting any task:

1. Run `gh pr list --repo minghsuy/ctscout-mcp --state open`. For
   implementation work, stop if a different open PR already touches the
   target files. When reviewing or addressing the current PR, do not treat
   that PR itself as a collision.
2. Run `git status --short --branch` and preserve unrelated local files.
3. Read `README.md`, `LIMITATIONS.md`, and `CHANGELOG.md` for the public package
   contract relevant to the change.

## Verification

Run all of these before pushing:

```bash
npm run build
npm run typecheck
npm run lint
npm test
npm audit --audit-level=low
```

Tests must not depend on a real API key or live ctscout.dev traffic.

## Repository Boundaries

- This package is the local stdio compatibility client. Hosted Streamable HTTP
  and SSE transport implementation belongs in `ctscout-worker`.
- Keep stdout exclusively for MCP JSON-RPC. Send boot diagnostics and errors to
  stderr; never log API keys or authorization headers.
- Require Node.js 20 or newer and keep `CTSCOUT_API_KEY` in the environment.
- Never commit `.env`, local MCP client configuration, generated coverage, or
  editor/agent state.

## Code Review Rules

### MCP and API contracts

- Treat tool names, descriptions, schemas, normalized responses, errors, quota
  behavior, and exit behavior as public contracts. Preserve compatibility and
  add protocol-level tests for any externally observable change.

### Cross-repository parity

- When the tool surface changes, explicitly compare it with the hosted MCP
  surface in `ctscout-worker`. Update both implementations or document and test
  why a transport-specific difference is intentional; do not claim automatic
  parity without a check.

### Process and credential safety

- A healthy stdio server must survive symlinked and package-manager launch
  paths, emit no non-protocol stdout, and fail clearly on startup errors.
  Forward credentials only to the configured ctscout API origin and redact
  secrets from errors, logs, fixtures, and snapshots.
