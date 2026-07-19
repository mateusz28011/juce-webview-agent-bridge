#!/usr/bin/env bash
# release.sh — release helper for juce-webview-agent-bridge (GitHub edition).
#
# Bumps the ONE module version everywhere it lives, commits it as
# `chore(release): vX.Y.Z`, tags an ANNOTATED `vX.Y.Z`, pushes main + the
# exact tag atomically, creates the GitHub Release, and publishes npm. Version
# sites kept in sync (package.json is the source
# the bump reads from):
#   - package.json                                "version"
#   - package-lock.json                           root/package versions
#   - juce_webview_agent_bridge/juce_webview_agent_bridge.h         JUCE module declaration `version:`
#                                                 AND the WEB_AGENT_BRIDGE_VERSION
#                                                 macro the `hello` reply reports
#   - tests/CMakeLists.txt                        project(... VERSION X.Y.Z ...)
#   - README.md                                   FetchContent GIT_TAG pin
#
# The ordered, recoverable sequence (bump -> commit -> annotated tag -> verify
# annotated -> atomic push by EXPLICIT tag ref) is deliberate: a failure before
# the push leaves the repo inspectable and retryable (worst case: a local
# annotated tag not yet pushed — push it, never re-run the bump). Never use
# `git push --follow-tags` (it can publish other reachable annotated tags).
#
# Usage:
#   bash scripts/release.sh patch|minor|major    # bump from package.json
#   bash scripts/release.sh 1.2.0                # explicit X.Y.Z
#
# Refuses to run off `main` unless RELEASE_ALLOW_ANY_BRANCH=1 (emergency only).
# With no `origin` remote (pre-publish local repo) it stops after the tag.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${ROOT_DIR}"

# --- guardrails ---------------------------------------------------------------
branch="$(git rev-parse --abbrev-ref HEAD)"
if [[ "${branch}" != "main" && "${RELEASE_ALLOW_ANY_BRANCH:-}" != "1" ]]; then
  echo "✗ Releases must be cut from 'main' — you are on '${branch}'." >&2
  echo "  (emergency only: RELEASE_ALLOW_ANY_BRANCH=1)" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Working tree is not clean — commit or stash first." >&2
  git status --short >&2
  exit 1
fi
# --- compute the new version ----------------------------------------------------
current="$(node -p "require('./package.json').version")"
bump="${1:-}"
case "${bump}" in
  patch|minor|major)
    new="$(node -e "
      const [ma, mi, pa] = '${current}'.split('.').map(Number);
      const b = '${bump}';
      console.log(b === 'major' ? \`\${ma + 1}.0.0\` : b === 'minor' ? \`\${ma}.\${mi + 1}.0\` : \`\${ma}.\${mi}.\${pa + 1}\`);
    ")" ;;
  [0-9]*.[0-9]*.[0-9]*)
    new="${bump}" ;;
  *)
    echo "Usage: scripts/release.sh patch|minor|major|X.Y.Z   (current: v${current})" >&2
    exit 1 ;;
esac
tag="v${new}"
if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  echo "✗ Tag ${tag} already exists." >&2
  exit 1
fi
echo "▸ ${current} -> ${new}"

# --- the changelog must already describe this release ---------------------------
# Every version site below is written by sed and then verified by grep, so a
# silent miss there is impossible. The changelog is prepared BY HAND and had no
# such check — which is exactly how v0.5.0 shipped with its entries still sitting
# under [Unreleased], no [0.5.0] section, and stale comparison links. Enforce it
# here, before anything is mutated, so a failure leaves the tree untouched.
changelog_fail() {
  echo "✗ CHANGELOG.md is not prepared for ${tag}: $1" >&2
  echo "  Prepare it first (see AGENTS.md 'Preparing a release'):" >&2
  echo "    1. move the [Unreleased] entries under '## [${new}] - $(date +%Y-%m-%d)'" >&2
  echo "    2. leave a new, EMPTY [Unreleased] section above it" >&2
  echo "    3. bottom links: '[${new}]: <repo>/releases/tag/${tag}' and" >&2
  echo "       '[Unreleased]: <repo>/compare/${tag}...HEAD'" >&2
  echo "  Then re-run the release. Nothing has been modified." >&2
  exit 1
}
grep -qE "^## \[${new}\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md \
  || changelog_fail "no '## [${new}] - YYYY-MM-DD' section"
# The released entries must have been MOVED, not copied: anything still left under
# [Unreleased] means the section was never emptied.
if sed -n '/^## \[Unreleased\]$/,/^## \[/p' CHANGELOG.md | sed '1d;$d' | grep -q '[^[:space:]]'; then
  changelog_fail "the [Unreleased] section still has entries in it"
fi
grep -qE "^\[${new}\]: .*/releases/tag/${tag}$" CHANGELOG.md \
  || changelog_fail "no '[${new}]:' link at the bottom"
grep -qE "^\[Unreleased\]: .*/compare/${tag}\.\.\.HEAD$" CHANGELOG.md \
  || changelog_fail "the [Unreleased] link does not compare from ${tag}"
echo "▸ changelog ready for ${tag}"

# --- write every version site ---------------------------------------------------
node -e "
  const fs = require('fs');
  const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  p.version = '${new}';
  fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
  const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  lock.version = '${new}';
  lock.packages[''].version = '${new}';
  fs.writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
"
sed -i.bak -E "s|^(   version: +)[0-9]+\.[0-9]+\.[0-9]+$|\1${new}|" juce_webview_agent_bridge/juce_webview_agent_bridge.h
sed -i.bak -E "s|(#define WEB_AGENT_BRIDGE_VERSION \")[0-9]+\.[0-9]+\.[0-9]+\"|\1${new}\"|" juce_webview_agent_bridge/juce_webview_agent_bridge.h
sed -i.bak -E "s|(project\(web_agent_bridge_tests VERSION )[0-9]+\.[0-9]+\.[0-9]+|\1${new}|" tests/CMakeLists.txt
sed -i.bak -E "s|(GIT_TAG +)v[0-9]+\.[0-9]+\.[0-9]+|\1${tag}|" README.md
rm -f juce_webview_agent_bridge/juce_webview_agent_bridge.h.bak tests/CMakeLists.txt.bak README.md.bak

# Every site must now carry the new version — catch a silently-unmatched sed.
grep -q "version:            ${new}" juce_webview_agent_bridge/juce_webview_agent_bridge.h
grep -q "#define WEB_AGENT_BRIDGE_VERSION \"${new}\"" juce_webview_agent_bridge/juce_webview_agent_bridge.h
grep -q "VERSION ${new}" tests/CMakeLists.txt
grep -q "GIT_TAG        ${tag}" README.md
node -e "const p=require('./package-lock.json'); if(p.version!=='${new}' || p.packages[''].version!=='${new}') process.exit(1)"

# --- verify, commit, tag ----------------------------------------------------------
npm ci --ignore-scripts >/dev/null 2>&1
npm run build >/dev/null 2>&1 || { echo '✗ TypeScript build failed — aborting (tree left bumped for inspection).' >&2; exit 1; }
npm test >/dev/null 2>&1 || { echo '✗ npm test failed — aborting (tree left bumped for inspection).' >&2; exit 1; }
npm run test:types >/dev/null 2>&1 || { echo '✗ public TypeScript API check failed — aborting (tree left bumped for inspection).' >&2; exit 1; }
npm pack --dry-run >/dev/null 2>&1 || { echo '✗ npm package dry-run failed — aborting (tree left bumped for inspection).' >&2; exit 1; }
git add package.json package-lock.json juce_webview_agent_bridge/juce_webview_agent_bridge.h tests/CMakeLists.txt README.md tools
git commit -m "chore(release): ${tag}"
git tag -a "${tag}" -m "${tag}"
[[ "$(git cat-file -t "${tag}")" == "tag" ]] || { echo "✗ ${tag} is not annotated." >&2; exit 1; }

# --- publish ---------------------------------------------------------------------
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "▸ No 'origin' remote — stopped after the local tag. When the GitHub repo exists:"
  echo "    git push --atomic origin main ${tag}"
  echo "    gh release create ${tag} --generate-notes"
  exit 0
fi
git push --atomic origin main "${tag}"
if command -v gh >/dev/null 2>&1; then
  if ! gh release create "${tag}" --generate-notes; then
    echo "⚠ Tag was pushed but GitHub Release failed — retry that command, then run: npm publish --access public" >&2
    exit 1
  fi
else
  echo "⚠ Tag was pushed, but 'gh' is required before npm publication." >&2
  echo "  Create the GitHub Release, then run: npm publish --access public" >&2
  exit 1
fi
if ! npm publish --access public; then
  echo "⚠ GitHub release succeeded but npm publish failed — retry: npm publish --access public" >&2
  exit 1
fi
echo "✓ Released ${tag} to GitHub and npm"
