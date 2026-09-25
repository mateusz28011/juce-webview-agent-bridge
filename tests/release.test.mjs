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

/** Extract a block of the real script between two exact marker strings, so a
 * test can never drift from what actually runs during a release. */
function extractBlock(start, end) {
  const from = releaseScript.indexOf(start);
  const to = releaseScript.indexOf(end);
  assert.ok(from >= 0 && to > from, `markers still present in scripts/release.sh: "${start}" .. "${end}"`);
  return releaseScript.slice(from, to);
}

/** The gate exactly as the release runs it — no second copy to keep in sync. */
function extractGate() {
  return extractBlock(GATE_START, GATE_END);
}

const VERSION_GATE_START = '# --- compute the new version';
const VERSION_GATE_END = 'tag="v${new}"';

/** The version-parsing + validation block (bump keyword / explicit X.Y.Z,
 * regex-checked, and required to be greater than the current version). */
function extractVersionGate() {
  return extractBlock(VERSION_GATE_START, VERSION_GATE_END);
}

/** Run the version gate against a package.json fixture + a bump argument;
 * resolve its exit code, output, and the resulting $new (if it succeeded). */
function runVersionGate(currentVersion, bumpArg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-release-version-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: currentVersion }));
    fs.writeFileSync(path.join(dir, 'gate.sh'), extractVersionGate());
    try {
      const out = execFileSync(
        'bash',
        ['-c', 'set -e; source ./gate.sh; echo "NEW=${new}"', 'gate', bumpArg],
        { cwd: dir, encoding: 'utf8', stdio: 'pipe' },
      );
      const m = out.match(/NEW=(\S+)/);
      return { code: 0, out, new: m ? m[1] : undefined };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, new: undefined };
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Grab a single line of the real script verbatim, by its exact leading text. */
function extractLine(startsWith) {
  const from = releaseScript.indexOf(startsWith);
  assert.ok(from >= 0, `line still present in scripts/release.sh: "${startsWith}"`);
  const to = releaseScript.indexOf('\n', from);
  return releaseScript.slice(from, to);
}

const README_TAG_SED = 'sed -i.bak -E "s|(GIT_TAG +)v[0-9]+\\.[0-9]+\\.[0-9]+|\\1${tag}|" README.md';
const README_TAG_GREP = 'grep -qE "GIT_TAG +${tag}" README.md';

/** Run the README GIT_TAG sed + its grep verification against a README
 * fixture — both lines pulled verbatim from the real script. */
function runReadmeTagUpdate(readme, { tag = 'v0.7.0' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-release-readme-'));
  try {
    fs.writeFileSync(path.join(dir, 'README.md'), readme);
    const sedLine = extractLine(README_TAG_SED);
    const grepLine = extractLine(README_TAG_GREP);
    const script = `${sedLine}\nrm -f README.md.bak\n${grepLine}\n`;
    fs.writeFileSync(path.join(dir, 'gate.sh'), script);
    try {
      const out = execFileSync('bash', ['-c', 'set -e; source ./gate.sh'], {
        cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, tag },
      });
      return { code: 0, out, readme: fs.readFileSync(path.join(dir, 'README.md'), 'utf8') };
    } catch (e) {
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

// --- version validation (patch/minor/major bump, explicit X.Y.Z, and the
// new-must-be-greater-than-current check) ------------------------------------

test('patch/minor/major bumps still compute correctly from the current version', () => {
  assert.equal(runVersionGate('1.2.3', 'patch').new, '1.2.4');
  assert.equal(runVersionGate('1.2.3', 'minor').new, '1.3.0');
  assert.equal(runVersionGate('1.2.3', 'major').new, '2.0.0');
});

test('an explicit well-formed X.Y.Z greater than current is accepted', () => {
  const { code, new: newVersion } = runVersionGate('1.2.3', '1.2.4');
  assert.equal(code, 0);
  assert.equal(newVersion, '1.2.4');
});

test('a malformed explicit version is refused with the usage message', () => {
  for (const bad of ['1.2', '1.2.3.4', 'v1.2.3', '1.2.3-beta', 'abc', '']) {
    const { code, out } = runVersionGate('1.2.3', bad);
    assert.equal(code, 1, `expected "${bad}" to be refused`);
    assert.match(out, /Usage: scripts\/release\.sh patch\|minor\|major\|X\.Y\.Z/, `for input "${bad}"`);
  }
});

test('an explicit version that is not greater than the current one is refused', () => {
  for (const notGreater of ['1.2.3', '1.2.2', '1.2.0', '0.9.9']) {
    const { code, out } = runVersionGate('1.2.3', notGreater);
    assert.equal(code, 1, `expected "${notGreater}" to be refused`);
    assert.match(out, /is not greater than the current version 1\.2\.3/, `for input "${notGreater}"`);
  }
});

// --- README FetchContent GIT_TAG pin: sed writes it, grep must verify what
// sed actually wrote (any amount of padding whitespace, not exactly 8 spaces) --

test('the GIT_TAG sed + verification round-trip regardless of padding width', () => {
  for (const spaces of [1, 4, 8, 12]) {
    const readme = `\`\`\`cmake\nFetchContent_Declare(juce_webview_agent_bridge\n    GIT_REPOSITORY https://github.com/mateusz28011/juce-webview-agent-bridge.git\n    GIT_TAG${' '.repeat(spaces)}v0.6.0)\nFetchContent_MakeAvailable(juce_webview_agent_bridge)\n\`\`\`\n`;
    const { code, readme: updated } = runReadmeTagUpdate(readme, { tag: 'v0.7.0' });
    assert.equal(code, 0, `expected padding of ${spaces} spaces to pass verification`);
    assert.match(updated, /GIT_TAG\s+v0\.7\.0\)/);
  }
});
