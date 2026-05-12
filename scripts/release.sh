#!/usr/bin/env bash
# Single-repo npm release for ctscout-mcp.
#
# Mirrors HSA's scripts/release.sh pattern but npm-flavored:
#   pre-flight gates -> verify -> bump version -> bump CHANGELOG ->
#   commit -> tag -> push -> npm publish -> gh release create.
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
echo "==> npm ci"
run npm ci

echo "==> npm test"
run npm test

echo "==> npm run build"
run npm run build

# Confirm dist/ exists and looks right.
if (( !DRY_RUN )); then
  if [[ ! -f dist/index.js ]]; then
    echo "error: dist/index.js not present after build" >&2
    exit 1
  fi
  # Sanity: the version baked into the compiled JS should match package.json
  # (the source has `const SERVER_VERSION = "X.Y.Z"`).
  if ! grep -q "SERVER_VERSION *= *\"${NEW_VERSION}\"" dist/index.js 2>/dev/null; then
    CURRENT_PJSON=$(node -p "require('./package.json').version")
    if [[ "$CURRENT_PJSON" != "$NEW_VERSION" ]]; then
      echo "warn: SERVER_VERSION in dist/index.js doesn't match $NEW_VERSION" >&2
      echo "      package.json: $CURRENT_PJSON" >&2
      echo "      either bump SERVER_VERSION in src/index.ts to match the release,"
      echo "      or update package.json first."
      exit 1
    fi
  fi
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
    npm version --no-git-tag-version "$NEW_VERSION" >/dev/null
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

# Single commit when either bump happened.
if (( VERSION_BUMPED || CHANGELOG_BUMPED )) && (( !DRY_RUN )); then
  run git commit -m "Release v${NEW_VERSION}"
fi

# --- Tag and push ---
run git tag -a "v${NEW_VERSION}" -m "v${NEW_VERSION}"
run git push origin main
run git push origin "v${NEW_VERSION}"

# --- npm publish ---
echo "==> npm publish (public, default tag = latest)"
# `npm publish` reads .npmrc for auth. Skip in dry-run; the publish would
# fail authentication in --check mode anyway and the simulation isn't useful.
if (( DRY_RUN )); then
  echo "+ would run: npm publish --access public"
else
  run npm publish --access public
fi

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

run gh release create "v${NEW_VERSION}" \
  --repo minghsuy/ctscout-mcp \
  --title "v${NEW_VERSION}" \
  --notes-file "$NOTES_FILE"

echo
echo "==> released v${NEW_VERSION}"
echo "    npm:    https://www.npmjs.com/package/ctscout-mcp-server/v/${NEW_VERSION}"
echo "    github: https://github.com/minghsuy/ctscout-mcp/releases/tag/v${NEW_VERSION}"
