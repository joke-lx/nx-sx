/**
 * 基本用法示例 — 展示沙箱系统的完整生命周期
 */

import { SandboxManager, getSandboxPlatform } from '../src/index.js';
import { validateCommand } from '../src/security.js';

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  终端沙箱隔离系统 — 示例');
  console.log('═══════════════════════════════════════════');

  // 1. 检测平台
  const platform = getSandboxPlatform();
  console.log(`\n📦 平台: ${platform.os}${platform.isWsl ? ` (${platform.wslVersion})` : ''}`);
  console.log(`   沙箱支持: ${platform.supported ? '✅' : '❌'}`);

  // 2. 初始化 SandboxManager
  const sm = new SandboxManager();
  const initResult = await sm.initialize({
    enabled: platform.supported,
    failIfUnavailable: false,
    allowUnsandboxedCommands: true,
    excludedCommands: ['docker', 'npm install:*', 'pip install:*'],
    network: {
      allowedDomains: ['github.com', 'api.github.com', 'registry.npmjs.org'],
    },
    filesystem: {
      denyWrite: ['/etc', '/usr', '/bin'],
    },
  });

  console.log(`\n🔧 引擎: ${initResult.engine}`);
  console.log(`   沙箱: ${initResult.sandboxEnabled ? '✅ 已启用' : '⏸️ 未启用'}`);

  if (initResult.dependencies.errors.length > 0) {
    console.log(`   依赖缺失: ${initResult.dependencies.errors.join(', ')}`);
  }

  // 3. 检查不可用原因
  const reason = sm.getUnavailableReason();
  if (reason) {
    console.log(`\n⚠️  ${reason}`);
  }

  // 4. 执行简单命令
  console.log('\n───────────────────────────────────────────');
  console.log('📋 执行命令: echo "hello sandbox"');
  const result1 = await sm.exec('echo "hello sandbox"');
  console.log(`   输出: ${result1.stdout.trim()}`);
  console.log(`   退出码: ${result1.code}`);

  // 5. 多行/复合命令
  console.log('\n───────────────────────────────────────────');
  console.log('📋 执行复合命令: ls -la | head -5');
  const result2 = await sm.exec('ls -la | head -5');
  console.log(`   输出:\n${result2.stdout}`);
  console.log(`   退出码: ${result2.code}`);

  // 6. 安全校验测试
  console.log('\n───────────────────────────────────────────');
  console.log('🔒 安全校验测试:');

  const testCommands = [
    'ls -la',
    'echo $(whoami)',       // 命令替换
    'zmodload zsh/mapfile',  // Zsh 危险命令
  ];

  for (const cmd of testCommands) {
    const sec = validateCommand(cmd);
    console.log(`   ${sec.passed ? '✅' : '❌'} ${cmd}`);
    if (!sec.passed) {
      console.log(`     原因: ${sec.message}`);
    }
  }

  // 7. 排除命令匹配测试
  console.log('\n───────────────────────────────────────────');
  console.log('🚫 排除命令匹配测试:');

  const excluded = ['docker:*', 'npm install:*'];
  const testCmds = ['docker ps', 'npm install express', 'ls'];

  const { commandIsExcluded } = await import('../src/security.js');
  for (const cmd of testCmds) {
    const blocked = commandIsExcluded(cmd, excluded);
    console.log(`   ${blocked ? '🚫 已排除' : '✅ 允许'} → ${cmd}`);
  }

  console.log('\n═══════════════════════════════════════════');
  console.log('  示例完成');
  console.log('═══════════════════════════════════════════');
}

main().catch(console.error);
