/*
 * release.test.mjs — tests the release script's changelog gate.
 *
 * Every version site in scripts/release.sh is written by sed and verified by
 * grep, so a silent miss there cannot happen. The changelog is prepared by hand
 * and had no such check, which is how v0.5.0 shipped with its entries still
 * under [Unreleased] and stale comparison links. The gate closes that hole, and
 * this suite proves the gate actually fires — an unverified guard is worse than
 * none, because it reads like protection while providing nothing.
 *
 * The gate block is EXTRACTED from the real script rather than copied here, so
 * these tests cannot drift away from what actually runs during a release.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseScript = fs.readFileSync(path.join(repoRoot, 'scripts/release.sh'), 'utf8');

const GATE_START = '# --- the changelog must already describe this release';
const GATE_END = '# --- write every version site';

/** The gate exactly as the release runs it — no second copy to keep in sync. */
function extractGate() {
  const from = releaseScript.indexOf(GATE_START);
  const to = releaseScript.indexOf(GATE_END);
  assert.ok(from >= 0 && to > from, 'the changelog gate markers are still in scripts/release.sh');
  return releaseScript.slice(from, to);
}

/** Run the gate against a changelog fixture; resolve its exit code + output. */
function runGate(changelog, { version = '0.5.1' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-release-'));
  try {
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);
    fs.writeFileSync(path.join(dir, 'gate.sh'), extractGate());
    try {
      const out = execFileSync('bash', ['-c', 'set -e; source ./gate.sh'], {
        cwd: dir, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, new: version, tag: `v${version}` },
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const LINKS = (unreleasedFrom, ...versions) => [
  `[Unreleased]: https://github.com/o/r/compare/v${unreleasedFrom}...HEAD`,
  ...versions.map((v) => `[${v}]: https://github.com/o/r/releases/tag/v${v}`),
].join('\n');

test('a correctly prepared changelog passes the gate', () => {
  const { code, out } = runGate(`# Changelog

## [Unreleased]

## [0.5.1] - 2026-07-19

### Fixed

- something

## [0.5.0] - 2026-07-19

${LINKS('0.5.1', '0.5.1', '0.5.0')}
`);
  assert.equal(code, 0, out);
  assert.match(out, /changelog ready for v0\.5\.1/);
});

test('entries left under [Unreleased] with no version section are refused', () => {
  // The exact mistake that shipped in v0.5.0.
  const { code, out } = runGate(`# Changelog

## [Unreleased]

### Fixed

- something

## [0.5.0] - 2026-07-19

${LINKS('0.5.0', '0.5.0')}
`);
  assert.equal(code, 1);
  assert.match(out, /no '## \[0\.5\.1\] - YYYY-MM-DD' section/);
  assert.match(out, /Nothing has been modified/, 'promises the tree is untouched');
});

test('entries copied instead of moved are refused', () => {
  const { code, out } = runGate(`# Changelog

## [Unreleased]

### Fixed

- leftover

## [0.5.1] - 2026-07-19

### Fixed

- something

${LINKS('0.5.1', '0.5.1')}
`);
  assert.equal(code, 1);
  assert.match(out, /\[Unreleased\] section still has entries/);
});

test('a missing release link is refused', () => {
  const { code, out } = runGate(`# Changelog

## [Unreleased]

## [0.5.1] - 2026-07-19

### Fixed

- something

${LINKS('0.5.1', '0.5.0')}
`);
  assert.equal(code, 1);
  assert.match(out, /no '\[0\.5\.1\]:' link/);
});

test('a stale [Unreleased] comparison link is refused', () => {
  const { code, out } = runGate(`# Changelog

## [Unreleased]

## [0.5.1] - 2026-07-19

### Fixed

- something

${LINKS('0.5.0', '0.5.1', '0.5.0')}
`);
  assert.equal(code, 1);
  assert.match(out, /does not compare from v0\.5\.1/);
});

test("the repo's own changelog is prepared for the version in package.json", () => {
  // Catches the released-but-undocumented state directly: after a release, the
  // shipped version must have its own section and links.
  const version = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
  const changelog = fs.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'),
    `CHANGELOG.md has no section for the current version ${version}`);
  assert.match(changelog, new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]: .*/releases/tag/v${version.replace(/\./g, '\\.')}$`, 'm'),
    `CHANGELOG.md has no bottom link for v${version}`);
});
