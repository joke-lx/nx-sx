import { strict as assert } from 'assert';
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
  assert.deepEqual(parseCliArgs(['happy', 'C:']), {
    command: 'happy',
    cwd: 'C:\\',
    name: 'happy',
  });
});

await test('parseCliArgs defaults path to current working directory', () => {
  const originalCwd = process.cwd;
  process.cwd = () => 'D:\\chat\\bro_chat';
  try {
    assert.deepEqual(parseCliArgs(['happy']), {
      command: 'happy',
      cwd: 'D:\\chat\\bro_chat',
      name: 'happy',
    });
  } finally {
    process.cwd = originalCwd;
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
