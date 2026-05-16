import { strict as assert } from 'assert';
import { createHash } from 'crypto';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  GitBashWindowController,
  buildGitBashLaunchCommand,
  buildPowerShellStartScript,
  extractCommandName,
  normalizeWindowCommand,
  normalizeWorkingDirectory,
} from '../src/web-control/index.js';
import { parseCliArgs } from '../src/cli.js';

function expectedTag(cwd) {
  return createHash('sha1').update(String(cwd)).digest('hex').slice(0, 8);
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  OK ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`     ${error.message}`);
  }
}

console.log('CLI window control tests');

await test('normalizeWindowCommand appends interactive bash', () => {
  assert.equal(normalizeWindowCommand('echo ready'), 'echo ready; exec bash -i');
});

await test('normalizeWindowCommand keeps explicit exec bash -i', () => {
  assert.equal(normalizeWindowCommand('echo ready; exec bash -i'), 'echo ready; exec bash -i');
});

await test('buildGitBashLaunchCommand sets title and cwd', () => {
  const cmd = buildGitBashLaunchCommand({
    title: 'happy',
    cwd: 'D:\\Dev-test\\test1\\happy-test',
    command: 'echo ready',
  });
  assert.ok(cmd.includes("printf '\\033]0;happy\\007'"));
  assert.ok(cmd.includes("cd '/d/Dev-test/test1/happy-test'"));
  assert.ok(cmd.endsWith('echo ready; exec bash -i'));
});

await test('buildPowerShellStartScript uses Start-Process with PassThru', () => {
  const script = buildPowerShellStartScript({
    shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
    cwd: 'D:\\Dev-test\\test1\\happy-test',
    args: ['--login', '-i', '-c', 'echo ready; exec bash -i'],
  });
  assert.ok(script.includes('Start-Process'));
  assert.ok(script.includes('-PassThru'));
  assert.ok(script.includes('bash.exe'));
});

await test('extractCommandName uses first token', () => {
  assert.equal(extractCommandName('happy --debug'), 'happy');
});

await test('normalizeWorkingDirectory expands drive root shorthand', () => {
  assert.equal(normalizeWorkingDirectory('C:'), 'C:\\');
});

await test('parseCliArgs parses command and path', () => {
  delete process.env.NXSX_INSTANCE_NAME;
  const result = parseCliArgs(['happy', 'C:']);
  assert.equal(result.command, 'happy');
  assert.equal(result.cwd, 'C:\\');
  assert.equal(result.title, 'happy');
  assert.match(result.name, /^happy-[0-9a-f]{8}-[0-9a-f]{8}$/);
  assert.ok(result.name.startsWith(`happy-${expectedTag('C:\\')}-`));
});

await test('parseCliArgs defaults path to current working directory', () => {
  delete process.env.NXSX_INSTANCE_NAME;
  const originalCwd = process.cwd;
  process.cwd = () => 'D:\\chat\\bro_chat';
  try {
    const result = parseCliArgs(['happy']);
    assert.equal(result.command, 'happy');
    assert.equal(result.cwd, 'D:\\chat\\bro_chat');
    assert.equal(result.title, 'happy');
    assert.match(result.name, /^happy-[0-9a-f]{8}-[0-9a-f]{8}$/);
    assert.ok(result.name.startsWith(`happy-${expectedTag('D:\\chat\\bro_chat')}-`));
  } finally {
    process.cwd = originalCwd;
  }
});

await test('parseCliArgs gives a fresh name on every call so same dir can multi-open', () => {
  delete process.env.NXSX_INSTANCE_NAME;
  const a = parseCliArgs(['happy', 'D:\\proj\\a']);
  const b = parseCliArgs(['happy', 'D:\\proj\\a']);
  assert.notEqual(a.name, b.name);
  // cwd-hash prefix stable for forensics; nonce differs
  const prefix = `happy-${expectedTag('D:\\proj\\a')}-`;
  assert.ok(a.name.startsWith(prefix));
  assert.ok(b.name.startsWith(prefix));
  assert.equal(a.title, 'happy');
  assert.equal(b.title, 'happy');
});

await test('parseCliArgs disambiguates by cwd so different dirs differ at the hash prefix', () => {
  delete process.env.NXSX_INSTANCE_NAME;
  const a = parseCliArgs(['happy', 'D:\\proj\\a']);
  const b = parseCliArgs(['happy', 'D:\\proj\\b']);
  const hashA = a.name.slice('happy-'.length, 'happy-'.length + 8);
  const hashB = b.name.slice('happy-'.length, 'happy-'.length + 8);
  assert.notEqual(hashA, hashB);
  assert.equal(hashA, expectedTag('D:\\proj\\a'));
  assert.equal(hashB, expectedTag('D:\\proj\\b'));
});

await test('parseCliArgs honors NXSX_INSTANCE_NAME env override', () => {
  const original = process.env.NXSX_INSTANCE_NAME;
  process.env.NXSX_INSTANCE_NAME = 'happy-second-instance';
  try {
    const result = parseCliArgs(['happy', 'C:']);
    assert.equal(result.name, 'happy-second-instance');
    assert.equal(result.title, 'happy');
    assert.equal(result.cwd, 'C:\\');
    assert.equal(result.command, 'happy');
  } finally {
    if (original === undefined) {
      delete process.env.NXSX_INSTANCE_NAME;
    } else {
      process.env.NXSX_INSTANCE_NAME = original;
    }
  }
});

await test('controller status is empty when no state exists', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'web-control-'));
  const controller = new GitBashWindowController({ stateDir, name: 'happy' });
  const status = controller.getStatus();
  assert.equal(status.running, false);
  assert.equal(status.pid, null);
});

await test('controller sandbox policy reports unsandboxed windows on native Windows', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'web-control-'));
  const controller = new GitBashWindowController({ stateDir, name: 'happy' });
  const sandbox = controller.buildSandboxPolicy({ allowUnsandboxedWindow: true });
  assert.equal(sandbox.active, false);
  assert.equal(sandbox.mode, 'unsandboxed-window');
});

console.log(`\nResult: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exit(failed > 0 ? 1 : 0);
