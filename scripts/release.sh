#!/usr/bin/env bash
# Single-repo npm release for ctscout-mcp.
#
# Mirrors HSA's scripts/release.sh pattern but npm-flavored:
#   pre-flight gates -> verify -> bump version -> bump CHANGELOG ->
#   commit -> push main -> npm publish -> tag -> push tag -> gh release.
#
# Note: tag is pushed AFTER npm publish so a publish failure leaves the
# repo cleanly retryable (no orphan tag on origin to clean up).
#
# Usage:
#   scripts/release.sh <new-version>      e.g. scripts/release.sh 0.3.0
#   scripts/release.sh --check <version>  dry run, no writes
#
# The version in package.json may already match (e.g. you bumped it inside
# the merged feature PR, like v0.2.0 did). In that case this script skips
# the bump+commit step but still does tag + publish + release.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

DRY_RUN=0
if [[ "${1:-}" == "--check" ]]; then
  DRY_RUN=1
  shift || true
fi

NEW_VERSION="${1:-}"
if [[ -z "$NEW_VERSION" ]]; then
  echo "usage: scripts/release.sh [--check] <new-version>" >&2
  echo "current package.json version: $(node -p "require('./package.json').version")" >&2
  exit 2
fi

if [[ ! "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be MAJOR.MINOR.PATCH (got: $NEW_VERSION)" >&2
  exit 2
fi

run() {
  if (( DRY_RUN )); then
    echo "+ $*"
  else
    echo "+ $*"
    "$@"
  fi
}

# --- Pre-flight gates ---
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree dirty — commit or stash first" >&2
  git status --short
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "error: must release from main (current: $CURRENT_BRANCH)" >&2
  exit 1
fi

git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "error: local main not in sync with origin/main" >&2
  echo "       run: git pull --ff-only" >&2
  exit 1
fi

if git rev-parse "v${NEW_VERSION}" >/dev/null 2>&1; then
  echo "error: tag v${NEW_VERSION} already exists locally" >&2
  exit 1
fi

if git ls-remote --tags origin "v${NEW_VERSION}" | grep -q "v${NEW_VERSION}"; then
  echo "error: tag v${NEW_VERSION} already exists on origin" >&2
  exit 1
fi

# --- Quality gates ---
# Run unconditionally (also in --check) so a dry-run actually validates
# the release would succeed. Only the WRITE ops below go through run().
echo "==> python3 available"
command -v python3 >/dev/null 2>&1 || { echo "error: python3 required for CHANGELOG rewrite" >&2; exit 1; }

echo "==> npm ci"
npm ci

echo "==> npm test"
npm test

echo "==> npm run build"
npm run build

if [[ ! -f dist/index.js ]]; then
  echo "error: dist/index.js not present after build" >&2
  exit 1
fi
# Sanity: SERVER_VERSION baked into the compiled JS MUST match $NEW_VERSION.
# Always fatal on mismatch — the prior version of this check had a blind
# spot where a pre-bumped package.json + un-bumped src/index.ts would
# silently ship a binary with the wrong SERVER_VERSION string.
# Escape dots in the version so the grep pattern matches literally rather
# than as wildcards (no false positives like "0X3Y0").
ESCAPED_VER="${NEW_VERSION//./\\.}"
if ! grep -q "SERVER_VERSION *= *\"${ESCAPED_VER}\"" dist/index.js; then
  CURRENT_PJSON=$(node -p "require('./package.json').version")
  CURRENT_SERVER_VERSION=$(grep -oE "SERVER_VERSION *= *\"[0-9]+\.[0-9]+\.[0-9]+\"" dist/index.js | head -1 || echo "(not found)")
  echo "error: SERVER_VERSION in dist/index.js doesn't match $NEW_VERSION" >&2
  echo "       dist/index.js: $CURRENT_SERVER_VERSION" >&2
  echo "       package.json:  $CURRENT_PJSON" >&2
  echo "       fix: bump SERVER_VERSION in src/index.ts to \"$NEW_VERSION\" and rebuild." >&2
  exit 1
fi

# --- Bump version (idempotent: skip if already at target) ---
CURRENT_PJSON=$(node -p "require('./package.json').version")
if [[ "$CURRENT_PJSON" == "$NEW_VERSION" ]]; then
  echo "==> package.json already at $NEW_VERSION (presumably bumped in the merged PR), skipping bump+commit"
  VERSION_BUMPED=0
else
  echo "==> bumping package.json $CURRENT_PJSON -> $NEW_VERSION"
  if (( DRY_RUN )); then
    echo "+ would set package.json.version = \"$NEW_VERSION\""
  else
    # Use npm version --no-git-tag-version so we control the tag step below.
    # Don't suppress output — errors from npm version should surface.
    npm version --no-git-tag-version "$NEW_VERSION"
    run git add package.json package-lock.json
  fi
  VERSION_BUMPED=1
fi

# --- Bump CHANGELOG.md (best-effort; skip if no [Unreleased] section) ---
TODAY=$(date -u +%Y-%m-%d)
CHANGELOG_BUMPED=0
if [[ -f CHANGELOG.md ]] && grep -q '^## \[Unreleased\]' CHANGELOG.md; then
  if (( DRY_RUN )); then
    echo "+ would bump CHANGELOG.md: [Unreleased] -> [$NEW_VERSION] - $TODAY"
  else
    python3 -c "
import re, pathlib
p = pathlib.Path('CHANGELOG.md')
text = p.read_text(encoding='utf-8')
new = re.sub(
    r'^## \[Unreleased\]\$',
    '## [Unreleased]\n\n## [$NEW_VERSION] - $TODAY',
    text, count=1, flags=re.M)
p.write_text(new, encoding='utf-8')
"
    run git add CHANGELOG.md
  fi
  CHANGELOG_BUMPED=1
elif [[ -f CHANGELOG.md ]]; then
  echo "warn: CHANGELOG.md has no [Unreleased] section — skipping CHANGELOG bump"
else
  echo "warn: no CHANGELOG.md — skipping CHANGELOG bump"
fi

# Single commit when either bump happened. Use run() (which handles
# DRY_RUN itself) instead of guarding the whole block — keeps --check
# output coherent: the `would-commit` line appears between `would-add`
# and `git push`, matching the actual execution order.
if (( VERSION_BUMPED || CHANGELOG_BUMPED )); then
  run git commit -m "Release v${NEW_VERSION}"
fi

# Push the Release commit before publishing so any merge-back conflict
# surfaces BEFORE we mutate npm. Tagging waits until after publish.
if (( VERSION_BUMPED || CHANGELOG_BUMPED )); then
  run git push origin main
fi

# --- npm publish (BEFORE tagging) ---
# Rationale: pushing the tag is an irreversible publication of intent.
# If `npm publish` fails (auth, network, registry hiccup) AFTER the tag
# was pushed, the next attempt is rejected by the tag-exists pre-flight
# and the user has to manually delete the tag from origin to retry.
# Publishing FIRST means a failure leaves the state cleanly retryable:
# Release commit + bumped package.json on main, no tag, no npm release.
echo "==> npm publish (public, default tag = latest)"
# `npm publish` reads .npmrc for auth. Skip the actual call in dry-run;
# auth would fail in --check anyway and the simulation isn't useful.
if (( DRY_RUN )); then
  echo "+ would run: npm publish --access public"
else
  run npm publish --access public
fi

# --- Tag and push (AFTER successful publish) ---
# Notes: `prepublishOnly` in package.json runs `npm run clean && npm run
# build` before packaging, so the artifact actually shipped to npm is a
# fresh rebuild — not the dist/ produced by our earlier `npm run build`.
# That second build is normally byte-identical to ours; the sanity check
# above asserts the source has the right SERVER_VERSION, which is what
# prepublishOnly will compile.
run git tag -a "v${NEW_VERSION}" -m "v${NEW_VERSION}"
run git push origin "v${NEW_VERSION}"

# --- GitHub release ---
if (( DRY_RUN )); then
  echo "+ would generate release notes from git log and create GitHub release"
  echo
  echo "==> dry run complete"
  exit 0
fi

NOTES_FILE=$(mktemp)
trap 'rm -f "$NOTES_FILE"' EXIT
{
  echo "## What's changed in v${NEW_VERSION}"
  echo
  echo "**npm**: \`npm install ctscout-mcp-server@${NEW_VERSION}\` or \`npx ctscout-mcp-server@${NEW_VERSION}\`"
  echo
  PREV_TAG=$(git describe --tags --abbrev=0 "v${NEW_VERSION}^" 2>/dev/null || echo "")
  if [[ -n "$PREV_TAG" ]]; then
    echo "### Commits since ${PREV_TAG}"
    echo
    git log "$PREV_TAG..v${NEW_VERSION}" --pretty="format:- %s" --no-merges
  else
    echo "Initial release."
  fi
} > "$NOTES_FILE"

# gh defaults to the current repo when run from the working tree. No
# --repo flag means forks/mirrors release against themselves, not upstream.
run gh release create "v${NEW_VERSION}" \
  --title "v${NEW_VERSION}" \
  --notes-file "$NOTES_FILE"

echo
echo "==> released v${NEW_VERSION}"
echo "    npm:    https://www.npmjs.com/package/ctscout-mcp-server/v/${NEW_VERSION}"
# `.git` suffix is optional: SSH remotes (`git@host:org/repo.git`)
# always include it, HTTPS remotes copied from the GitHub UI often don't.
ORIGIN_SLUG=$(git remote get-url origin | sed -E 's|.*github\.com[:/](.+)|\1|; s|\.git$||')
echo "    github: https://github.com/${ORIGIN_SLUG}/releases/tag/v${NEW_VERSION}"
