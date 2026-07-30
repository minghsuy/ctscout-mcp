#!/usr/bin/env bash
# Publish one already-reviewed ctscout-mcp commit to npm, git, and GitHub.
#
# Release metadata must be prepared and reviewed in a PR. This script never
# edits package.json, package-lock.json, or CHANGELOG.md and never creates a
# release commit. That invariant makes npm's gitHead, the git tag, and the
# GitHub release point at the same reviewed commit.
#
# Usage:
#   scripts/release.sh --check <version>  verify only; no external writes
#   scripts/release.sh <version>          publish/resume from clean synced main
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

CHECK_ONLY=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=1
  shift
fi

NEW_VERSION="${1:-}"
if [[ -z "$NEW_VERSION" ]]; then
  if (( CHECK_ONLY )); then
    NEW_VERSION="$(node -p "require('./package.json').version")"
  else
    echo "usage: scripts/release.sh [--check] <new-version>" >&2
    exit 2
  fi
fi
if [[ ! "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be MAJOR.MINOR.PATCH (got: $NEW_VERSION)" >&2
  exit 2
fi

PACKAGE_NAME="$(node -p "require('./package.json').name")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
TAG="v${NEW_VERSION}"
HEAD_SHA="$(git rev-parse HEAD)"

if [[ "$PACKAGE_NAME" != "ctscout-mcp-server" ]]; then
  echo "error: unexpected package name: $PACKAGE_NAME" >&2
  exit 1
fi
if [[ "$PACKAGE_VERSION" != "$NEW_VERSION" ]]; then
  echo "error: package.json is $PACKAGE_VERSION, expected $NEW_VERSION" >&2
  echo "       prepare and review the version bump before releasing" >&2
  exit 1
fi
if ! grep -q "^## \\[$NEW_VERSION\\] - [0-9]\\{4\\}-[0-9]\\{2\\}-[0-9]\\{2\\}$" CHANGELOG.md; then
  echo "error: CHANGELOG.md has no dated [$NEW_VERSION] release heading" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree dirty — release only a reviewed commit" >&2
  git status --short >&2
  exit 1
fi

echo "==> fetching release refs"
git fetch origin main --tags

if (( ! CHECK_ONLY )); then
  CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  REMOTE_MAIN="$(git rev-parse origin/main)"
  if [[ "$CURRENT_BRANCH" != "main" ]]; then
    echo "error: must release from main (current: $CURRENT_BRANCH)" >&2
    exit 1
  fi
  if [[ "$HEAD_SHA" != "$REMOTE_MAIN" ]]; then
    echo "error: local main is not the exact origin/main commit" >&2
    echo "       local:  $HEAD_SHA" >&2
    echo "       remote: $REMOTE_MAIN" >&2
    exit 1
  fi
else
  echo "==> check-only candidate commit: $HEAD_SHA"
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ctscout-release.XXXXXX")"
trap 'rm -rf -- "$TMP_DIR"' EXIT

# npm is the first external mutation in the release sequence. A prior npm
# version is acceptable only when it names this exact git commit: that is the
# recoverable "npm succeeded, tag/release did not" state.
NPM_EXISTS=0
NPM_GIT_HEAD=""
if npm view "${PACKAGE_NAME}@${NEW_VERSION}" version --json \
  >"$TMP_DIR/npm-version.json" 2>"$TMP_DIR/npm-version.err"; then
  NPM_EXISTS=1
  NPM_GIT_HEAD="$(
    npm view "${PACKAGE_NAME}@${NEW_VERSION}" gitHead --json \
      | node -e 'const c=[];process.stdin.on("data",x=>c.push(x));process.stdin.on("end",()=>{const v=JSON.parse(Buffer.concat(c));process.stdout.write(typeof v==="string"?v:"")})'
  )"
  if [[ "$NPM_GIT_HEAD" != "$HEAD_SHA" ]]; then
    echo "error: npm ${PACKAGE_NAME}@${NEW_VERSION} already exists from another commit" >&2
    echo "       npm gitHead: ${NPM_GIT_HEAD:-(missing)}" >&2
    echo "       local HEAD:  $HEAD_SHA" >&2
    exit 1
  fi
elif ! grep -q "E404" "$TMP_DIR/npm-version.err"; then
  echo "error: could not determine npm release state" >&2
  sed -n '1,20p' "$TMP_DIR/npm-version.err" >&2
  exit 1
fi

LOCAL_TAG_EXISTS=0
LOCAL_TAG_SHA=""
if git rev-parse --verify --quiet "${TAG}^{commit}" >"$TMP_DIR/tag-sha"; then
  LOCAL_TAG_EXISTS=1
  LOCAL_TAG_SHA="$(cat "$TMP_DIR/tag-sha")"
  if [[ "$LOCAL_TAG_SHA" != "$HEAD_SHA" ]]; then
    echo "error: local $TAG exists on a different commit" >&2
    echo "       tag:  $LOCAL_TAG_SHA" >&2
    echo "       HEAD: $HEAD_SHA" >&2
    exit 1
  fi
fi

REMOTE_TAG_EXISTS=0
REMOTE_TAG_SHA=""
git ls-remote --tags origin "refs/tags/$TAG" "refs/tags/${TAG}^{}" \
  >"$TMP_DIR/remote-tags"
if [[ -s "$TMP_DIR/remote-tags" ]]; then
  REMOTE_TAG_EXISTS=1
  REMOTE_TAG_SHA="$(
    awk '
      /\^\{\}$/ { peeled=$1 }
      !/\^\{\}$/ { direct=$1 }
      END { print peeled != "" ? peeled : direct }
    ' "$TMP_DIR/remote-tags"
  )"
  if [[ "$REMOTE_TAG_SHA" != "$HEAD_SHA" ]]; then
    echo "error: origin $TAG exists on a different commit" >&2
    echo "       tag:  $REMOTE_TAG_SHA" >&2
    echo "       HEAD: $HEAD_SHA" >&2
    exit 1
  fi
fi

RELEASE_EXISTS=0
if gh release view "$TAG" --json tagName >"$TMP_DIR/release.json" 2>"$TMP_DIR/release.err"; then
  RELEASE_EXISTS=1
elif ! grep -qi "release not found\\|not found" "$TMP_DIR/release.err"; then
  echo "error: could not determine GitHub release state" >&2
  sed -n '1,20p' "$TMP_DIR/release.err" >&2
  exit 1
fi

echo "==> release state"
echo "    npm ${NEW_VERSION}: $([[ "$NPM_EXISTS" == 1 ]] && echo "present at $NPM_GIT_HEAD" || echo absent)"
echo "    local git ${TAG}: $([[ "$LOCAL_TAG_EXISTS" == 1 ]] && echo "present at $LOCAL_TAG_SHA" || echo absent)"
echo "    origin git ${TAG}: $([[ "$REMOTE_TAG_EXISTS" == 1 ]] && echo "present at $REMOTE_TAG_SHA" || echo absent)"
echo "    GitHub ${TAG}: $([[ "$RELEASE_EXISTS" == 1 ]] && echo present || echo absent)"

if (( CHECK_ONLY )) && (( NPM_EXISTS || LOCAL_TAG_EXISTS || REMOTE_TAG_EXISTS || RELEASE_EXISTS )); then
  echo "error: check-only expects an unpublished version; release state is already partial or complete" >&2
  exit 1
fi
if (( ! NPM_EXISTS )) && (( LOCAL_TAG_EXISTS || REMOTE_TAG_EXISTS || RELEASE_EXISTS )); then
  echo "error: tag/release exists without the immutable npm version; stop for manual audit" >&2
  exit 1
fi
if (( RELEASE_EXISTS )) && (( ! REMOTE_TAG_EXISTS )); then
  echo "error: GitHub release exists without its remote tag; stop for manual audit" >&2
  exit 1
fi

echo "==> npm ci"
npm ci
echo "==> npm run lint"
npm run lint
echo "==> npm run typecheck"
npm run typecheck
echo "==> npm run build"
npm run build
echo "==> npm test (includes exact-tarball clean install and protocol checks)"
npm test
echo "==> npm audit --audit-level=low"
npm audit --audit-level=low

if (( CHECK_ONLY )); then
  echo
  echo "==> release check passed for ${PACKAGE_NAME}@${NEW_VERSION} at $HEAD_SHA"
  echo "    no npm publish, tag, push, or GitHub release was performed"
  exit 0
fi

if (( ! NPM_EXISTS )); then
  echo "==> publishing ${PACKAGE_NAME}@${NEW_VERSION}"
  npm publish --access public

  PUBLISHED_GIT_HEAD="$(
    npm view "${PACKAGE_NAME}@${NEW_VERSION}" gitHead --json \
      | node -e 'const c=[];process.stdin.on("data",x=>c.push(x));process.stdin.on("end",()=>{const v=JSON.parse(Buffer.concat(c));process.stdout.write(typeof v==="string"?v:"")})'
  )"
  if [[ "$PUBLISHED_GIT_HEAD" != "$HEAD_SHA" ]]; then
    echo "error: npm published, but registry gitHead verification failed" >&2
    echo "       expected: $HEAD_SHA" >&2
    echo "       observed: ${PUBLISHED_GIT_HEAD:-(missing)}" >&2
    echo "       do not create a tag; rerun after registry metadata is visible" >&2
    exit 1
  fi
else
  echo "==> npm version already exists at this exact commit; resuming"
fi

if (( ! LOCAL_TAG_EXISTS )); then
  echo "==> creating local tag $TAG"
  git tag -a "$TAG" -m "$TAG"
fi
if (( ! REMOTE_TAG_EXISTS )); then
  echo "==> pushing $TAG"
  git push origin "$TAG"
else
  echo "==> origin $TAG already points at this exact commit; resuming"
fi

if (( ! RELEASE_EXISTS )); then
  NOTES_FILE="$TMP_DIR/notes.md"
  {
    echo "## What's changed in $TAG"
    echo
    echo "**npm**: \`npm install ${PACKAGE_NAME}@${NEW_VERSION}\` or \`npx ${PACKAGE_NAME}@${NEW_VERSION}\`"
    echo
    awk -v version="$NEW_VERSION" '
      $0 ~ "^## \\[" version "\\] - " { found=1; next }
      found && /^## \[/ { exit }
      found { print }
    ' CHANGELOG.md
  } >"$NOTES_FILE"
  gh release create "$TAG" --verify-tag --title "$TAG" --notes-file "$NOTES_FILE"
else
  echo "==> GitHub release $TAG already exists"
fi

echo
echo "==> released ${PACKAGE_NAME}@${NEW_VERSION} from $HEAD_SHA"
