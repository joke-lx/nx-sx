/**
 * 单元测试 — 验证沙箱系统的核心功能
 */
import { strict as assert } from 'assert';
import { validateCommand, SecurityReport } from '../src/security.js';
import { normalizeConfig, mergeConfigs, matchExcludedCommand, resolvePermissionPath, resolveFilesystemPath } from '../src/config.js';
import { splitCompoundCommand, quoteCommand } from '../src/utils/shell-quote.js';
import { detectWsl, getSandboxPlatform, getOsPlatform } from '../src/platform.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

console.log('═══════════════════════════════════════════');
console.log('  单元测试 — 安全模块');
console.log('═══════════════════════════════════════════\n');

// ——— 安全校验 ———
console.log('── Security Validation ──');

test('should allow simple command', () => {
  const r = validateCommand('ls -la');
  assert.equal(r.passed, true);
});

test('should block $() substitution', () => {
  const r = validateCommand('echo $(whoami)');
  assert.equal(r.passed, false);
  assert.ok(r.message.includes('$()'));
});

test('should block backtick substitution', () => {
  const r = validateCommand('echo `whoami`');
  assert.equal(r.passed, false);
  assert.ok(r.message.includes('backtick'));
});

test('should block process substitution', () => {
  const r = validateCommand('diff <(echo a) <(echo b)');
  assert.equal(r.passed, false);
  assert.ok(r.message.includes('process substitution'));
});

test('should not block safe Zsh commands in bash mode', () => {
  const r = validateCommand('zmodload zsh/mapfile', { shellType: 'bash' });
  assert.equal(r.passed, true);
});

test('should block dangerous Zsh commands in zsh mode', () => {
  const r = validateCommand('zmodload zsh/mapfile', { shellType: 'zsh' });
  assert.equal(r.passed, false);
});

test('should block control characters', () => {
  const r = validateCommand('ls\x00-la');
  assert.equal(r.passed, false);
});

// ——— 排除命令匹配 ———
console.log('\n── Excluded Command Matching ──');

test('prefix match: docker:*', () => {
  assert.equal(matchExcludedCommand('docker:*', 'docker ps'), true);
});

test('prefix match: docker run is matched', () => {
  assert.equal(matchExcludedCommand('docker:*', 'docker run nginx'), true);
});

test('prefix match: "docker" alone is exact match', () => {
  assert.equal(matchExcludedCommand('docker:*', 'docker'), true);
});

test('prefix non-match: docker-compose', () => {
  assert.equal(matchExcludedCommand('docker:*', 'docker-compose'), false);
});

test('exact match', () => {
  assert.equal(matchExcludedCommand('node', 'node'), true);
});

test('exact non-match', () => {
  assert.equal(matchExcludedCommand('node', 'node server.js'), false);
});

// ——— 复合命令拆分 ———
console.log('\n── Split Compound Commands ──');

test('split && commands', () => {
  const parts = splitCompoundCommand('cd dir && npm install');
  assert.deepEqual(parts, ['cd dir', 'npm install']);
});

test('split || commands', () => {
  const parts = splitCompoundCommand('cat x || echo fallback');
  assert.deepEqual(parts, ['cat x', 'echo fallback']);
});

test('split pipe', () => {
  const parts = splitCompoundCommand('ls -la | grep foo');
  assert.deepEqual(parts, ['ls -la', 'grep foo']);
});

test('single command returns [command]', () => {
  const parts = splitCompoundCommand('echo hello');
  assert.deepEqual(parts, ['echo hello']);
});

test('does not split inside $()', () => {
  const parts = splitCompoundCommand('echo $(cat file | head -1)');
  assert.deepEqual(parts, ['echo $(cat file | head -1)']);
});

// ——— 路径解析 ———
console.log('\n── Path Resolution ──');

test('//path → /path (permission rule)', () => {
  assert.equal(resolvePermissionPath('//home/user/.aws', '/base'), '/home/user/.aws');
});

test('/path → settings-relative (permission rule)', () => {
  assert.equal(resolvePermissionPath('/foo/**', '/base/settings'), '/base/settings/foo/**');
});

test('/path → absolute (filesystem setting)', () => {
  assert.equal(resolveFilesystemPath('/etc/passwd', '/base'), '/etc/passwd');
});

test('//path → /path (filesystem setting legacy)', () => {
  assert.equal(resolveFilesystemPath('//home/user', '/base'), '/home/user');
});

// ——— Quote ———
console.log('\n── Shell Quoting ──');

test('quoteCommand wraps in double quotes', () => {
  const q = quoteCommand('echo hello');
  assert.equal(q, '"echo hello"');
});

test('quoteCommand escapes $', () => {
  const q = quoteCommand('echo $HOME');
  assert.equal(q, '"echo \\$HOME"');
});

// ——— Config ———
console.log('\n── Config ──');

test('normalizeConfig fills defaults', () => {
  const c = normalizeConfig({ enabled: true });
  assert.equal(c.enabled, true);
  assert.equal(c.autoAllowBashIfSandboxed, true);
  assert.deepEqual(c.network.allowedDomains, []);
  assert.deepEqual(c.filesystem.allowWrite, []);
});

test('mergeConfigs merges multiple sources', () => {
  const a = { enabled: true, network: { allowedDomains: ['example.com'] } };
  const b = { network: { allowedDomains: ['other.com'] }, filesystem: { denyWrite: ['/etc'] } };
  const m = mergeConfigs(a, b);
  assert.equal(m.enabled, true);
  assert.deepEqual(m.network.allowedDomains, ['example.com', 'other.com']);
  assert.deepEqual(m.filesystem.denyWrite, ['/etc']);
});

// ——— Platform ———
console.log('\n── Platform Detection ──');

test('platform is detected', () => {
  const p = getSandboxPlatform();
  assert.ok(['win32', 'linux', 'darwin'].includes(p.os));
  assert.equal(typeof p.supported, 'boolean');
});

// ===== Summary =====
console.log(`\n${'═'.repeat(47)}`);
console.log(`  结果: ${passed} 通过, ${failed} 失败, ${passed + failed} 总计`);
console.log(`${'═'.repeat(47)}`);
process.exit(failed > 0 ? 1 : 0);
