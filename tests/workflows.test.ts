import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_SHA = "04e8407c2d3b9fd94c95c68a9e4d1853be8cadff";

const bridge = readFileSync(resolve(REPO_ROOT, ".github/workflows/claude-code-review.yml"), "utf8");
const responderPath = resolve(REPO_ROOT, ".github/workflows/claude.yml");

describe("hosted Claude workflow callers", () => {
  it("keeps public review metadata-only, owner-triggered, and frozen-head-only", () => {
    expect(bridge).toBe(`name: Claude Code Review

on:
  pull_request_target:
    types: [ready_for_review]

permissions:
  contents: read
  pull-requests: write
  statuses: write

jobs:
  review:
    uses: minghsuy/claude-review-workflows/.github/workflows/review.yml@${PROVIDER_SHA}
    with:
      pr: \${{ github.event.pull_request.number }}
      sha: \${{ github.event.pull_request.head.sha }}
      request_id: \${{ github.run_id }}
      allowed_actor: minghsuy
    secrets:
      CLAUDE_CODE_OAUTH_TOKEN: \${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
`);
    expect(bridge).not.toMatch(
      /(?:actions\/checkout|steps:|run:|self-hosted|BRIDGE_PAT|dgx-infra)/,
    );
  });

  it("does not retain the private responder that public callers cannot resolve", () => {
    expect(existsSync(responderPath)).toBe(false);
  });
});
