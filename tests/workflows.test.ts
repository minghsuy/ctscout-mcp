import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_SHA = "51b8c2c617b08974982c90a73ecad1fa77de137d";

const bridge = readFileSync(resolve(REPO_ROOT, ".github/workflows/claude-code-review.yml"), "utf8");
const responder = readFileSync(resolve(REPO_ROOT, ".github/workflows/claude.yml"), "utf8");

describe("hosted Claude workflow callers", () => {
  it("keeps the public bridge metadata-only and frozen-head-only", () => {
    expect(bridge).toBe(`name: Claude Code Review

on:
  pull_request_target:
    types: [ready_for_review]

permissions:
  statuses: write

jobs:
  trigger-review:
    uses: minghsuy/dgx-infra/.github/workflows/claude-review-bridge.yml@${PROVIDER_SHA}
    with:
      runs-on: '"ubuntu-latest"'
    secrets:
      BRIDGE_PAT: \${{ secrets.BRIDGE_PAT }}
`);
    expect(bridge).not.toMatch(/(?:actions\/checkout|steps:|run:|self-hosted)/);
  });

  it("keeps the responder hosted and inherits automatic-only Sonnet selection", () => {
    expect(responder).toBe(`name: Claude Code

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  issues:
    types: [opened, assigned]
  pull_request_review:
    types: [submitted]

permissions:
  contents: read
  pull-requests: read
  issues: write
  statuses: write
  id-token: write
  actions: read

jobs:
  claude:
    uses: minghsuy/dgx-infra/.github/workflows/claude-responder.yml@${PROVIDER_SHA}
    with:
      runs-on: '"ubuntu-latest"'
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
`);
    expect(responder).not.toMatch(
      /(?:steps:|self-hosted|claude-path|bun-path|claude-model|secrets:\s+inherit)/,
    );
  });
});
