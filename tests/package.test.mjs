import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('packed npm client supports root/subpath imports and the canonical CLI name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wab-package-'));
  try {
    const packed = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', dir], {
      cwd: ROOT,
      encoding: 'utf8',
    }));
    assert.equal(packed[0].name, 'juce-webview-agent-bridge');
    const paths = new Set(packed[0].files.map((file) => file.path));
    for (const required of ['tools/e2e.mjs', 'tools/e2e.d.mts', 'tools/shared.mjs', 'tools/shared.d.mts', 'tools/web-agent.mjs'])
      assert.ok(paths.has(required), `${required} is included in the tarball`);

    fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"type":"module"}\n');
    execFileSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', packed[0].filename], {
      cwd: dir,
      stdio: 'pipe',
    });

    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import { connect, expect, Page, Locator } from 'juce-webview-agent-bridge';
      import { connect as connectSubpath } from 'juce-webview-agent-bridge/e2e';
      import { DEFAULT_PORT } from 'juce-webview-agent-bridge/shared';
      console.log(JSON.stringify({
        root: [connect, expect, Page, Locator].every(x => typeof x === 'function'),
        subpath: connect === connectSubpath,
        port: DEFAULT_PORT,
      }));
    `], { cwd: dir, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(output), { root: true, subpath: true, port: 8930 });

    const binDir = path.join(dir, 'node_modules', '.bin');
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    assert.ok(fs.existsSync(path.join(binDir, `juce-webview-agent-bridge${suffix}`)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
