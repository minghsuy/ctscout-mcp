import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_SHA = "04e8407c2d3b9fd94c95c68a9e4d1853be8cadff";

const bridge = readFileSync(resolve(REPO_ROOT, ".github/workflows/claude-code-review.yml"), "utf8");
const responderPath = resolve(REPO_ROOT, ".github/workflows/claude.yml");
const workflowsDir = resolve(REPO_ROOT, ".github/workflows");

describe("hosted Claude workflow callers", () => {
  it("keeps public review metadata-only, owner-triggered, and frozen-head-only", () => {
    expect(bridge).toBe(`name: Claude Code Review

# pull_request, never pull_request_target: GitHub blocks pull_request_target in
# public repositories by default from 2026-11-02. A same-repository PR receives
# the secret and the write scopes below; a fork PR receives neither, so the if:
# skips its job instead of letting it fail. pull_request does not fire while a
# PR has a merge conflict: resolve it, then mark the PR ready again. The
# 15-minute timeout is set on the reusable job; a job that calls a reusable
# workflow cannot set one.
on:
  pull_request:
    types: [ready_for_review]

permissions: {}

jobs:
  review:
    permissions:
      contents: read # PR metadata and the compare diff, read through the API
      pull-requests: write # publish one SHA-bound review
      statuses: write # set the claude-review status on the reviewed head
    if: \${{ github.event.pull_request.head.repo.full_name == github.repository }}
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

  it("uses no pull_request_target trigger, which GitHub blocks in public repositories", () => {
    const workflows = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));
    expect(workflows).toContain("claude-code-review.yml");
    for (const name of workflows) {
      const text = readFileSync(resolve(workflowsDir, name), "utf8");
      const code = text.split("\n").filter((line) => !/^\s*#/.test(line));
      expect(code.join("\n"), name).not.toMatch(/pull_request_target/);
    }
  });

  it("does not retain the private responder that public callers cannot resolve", () => {
    expect(existsSync(responderPath)).toBe(false);
  });
});
