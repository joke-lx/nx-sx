/**
 * SandboxManager — 核心编排器
 *
 * 职责：统筹所有子模块，提供统一 API
 *   - 引擎选择与初始化
 *   - 配置管理（合并、刷新）
 *   - 命令执行决策（shouldUseSandbox）
 *   - 完整执行管道（构建→包装→spawn→清理）
 */

import { spawn, execFileSync } from 'child_process';
import { accessSync, constants, mkdirSync, readFileSync, unlinkSync, rmSync } from 'fs';
import { mkdir } from 'fs/promises';
import { join } from 'path';
import { createEngine, checkEngineDependencies } from './engine/index.js';
import { normalizeConfig, matchExcludedCommand } from './config.js';
import { buildCommand, findShell, getEnvironmentOverrides, getSpawnArgs } from './command-builder.js';
import { getSandboxPlatform, getOsPlatform } from './platform.js';
import { validateCommand, commandIsExcluded } from './security.js';
import { splitCompoundCommand } from './utils/shell-quote.js';

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class SandboxManager {
  constructor() {
    this._engine = null;
    this._platform = null;
    this._config = normalizeConfig({});
    this._initialized = false;
    this._shellPath = null;
    this._sandboxTmpDir = null;
  }

  // ===== 初始化 =====

  /**
   * Initialize the sandbox system.
   * Must be called before exec().
   */
  async initialize(config = {}) {
    this._config = normalizeConfig(config);
    this._shellPath = findShell();

    // 检测平台并创建引擎
    const result = createEngine();
    this._engine = result.engine;
    this._platform = result.platform;

    // 检查依赖
    const deps = this._engine.constructor.checkDependencies();
    if (!deps.available && this._config.enabled) {
      if (this._config.failIfUnavailable) {
        throw new Error(
          `Sandbox required but unavailable: ${deps.errors.join(', ')}`
        );
      }
      // 软失败：显示警告但继续（沙箱不会启用）
      console.warn(`[Sandbox] Warning: ${deps.errors.join(', ')}`);
    }

    // 如果所有检查通过，初始化引擎
    if (this._config.enabled && deps.available) {
      await this._engine.initialize(this._config);
      this._initialized = true;

      // 创建沙箱临时目录
      this._setupSandboxTmpDir();
    }

    return {
      platform: this._platform,
      engine: this._engine.name,
      sandboxEnabled: this._initialized,
      dependencies: deps,
    };
  }

  _setupSandboxTmpDir() {
    const tmpDirBase = process.env.CLAUDE_CODE_TMPDIR || '/tmp';
    this._sandboxTmpDir = join(tmpDirBase, 'sandbox-tmp');
    try {
      mkdirSync(this._sandboxTmpDir, { recursive: true, mode: 0o700 });
    } catch { /* dir may already exist */ }
  }

  // ===== 查询方法 =====

  get engine() { return this._engine; }
  get config() { return this._config; }
  get platform() { return this._platform; }
  get shellPath() { return this._shellPath; }
  get isSandboxingEnabled() { return this._initialized && this._config.enabled; }
  get sandboxAvailable() {
    return this._engine && this._engine.constructor.checkDependencies().available;
  }
  get isSupportedPlatform() { return this._platform && this._platform.supported; }

  checkDependencies() {
    if (!this._engine) return checkEngineDependencies();
    return this._engine.constructor.checkDependencies();
  }

  /**
   * 沙箱不可用原因（用于用户提示）
   */
  getUnavailableReason() {
    if (!this._config.enabled) return undefined;
    if (!this._platform) return 'System not initialized';

    if (!this._platform.supported) {
      if (this._platform.wslVersion === 'wsl1') {
        return 'WSL1 is not supported (requires WSL2)';
      }
      return `${this._platform.os} is not supported (requires macOS, Linux, or WSL2)`;
    }

    const deps = this.checkDependencies();
    if (deps.errors.length > 0) {
      const hint = this._platform.os === 'darwin'
        ? 'run /doctor for details'
        : 'install missing tools (apt install bubblewrap socat)';
      return `Dependencies missing: ${deps.errors.join(', ')} — ${hint}`;
    }

    return undefined;
  }

  // ===== 配置管理 =====

  updateConfig(newConfig) {
    this._config = normalizeConfig(newConfig);
    if (this._engine && this._initialized) {
      this._engine.updateConfig(this._config);
    }
  }

  // ===== 命令执行决策 =====

  /**
   * 判断一条命令是否应该入沙箱
   *
   * 决策链：
   *   enabled? → dangerouslyDisable? → excludedCommands?
   */
  shouldUseSandbox(input = {}) {
    if (!this.isSandboxingEnabled) return false;

    // 如果显式要求跳过且策略允许
    if (input.dangerouslyDisableSandbox && this._config.allowUnsandboxedCommands) {
      return false;
    }

    if (!input.command) return false;

    // 检查排除命令列表
    if (this._isExcludedCommand(input.command)) {
      return false;
    }

    return true;
  }

  /**
   * 检查命令是否在排除列表中。
   * 复合命令（&&, ||, ;, |）拆分后逐段检查。
   */
  _isExcludedCommand(command) {
    const excluded = this._config.excludedCommands || [];
    if (excluded.length === 0) return false;

    const subcommands = splitCompoundCommand(command);
    for (const subcmd of subcommands) {
      const trimmed = subcmd.trim();
      // 生成待检查候选项
      const candidates = this._generateExclusionCandidates(trimmed);
      for (const pattern of excluded) {
        for (const candidate of candidates) {
          if (matchExcludedCommand(pattern, candidate)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /**
   * 生成命令的多种变体用于排除匹配。
   * 处理环境变量前缀和 wrapper 命令。
   */
  _generateExclusionCandidates(cmd) {
    const candidates = [cmd];

    // 去掉环境变量前缀 (FOO=bar BAZ=qux command → command)
    const envStripped = cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:\S*|'.*'|".*")\s+)+/, '');
    if (envStripped !== cmd) candidates.push(envStripped);

    // 去掉 timeout/nice/nohup 等 wrapper
    const stripped = this._stripWrappers(cmd);
    if (stripped !== cmd) candidates.push(stripped);
    const strippedEnv = this._stripWrappers(envStripped);
    if (strippedEnv !== envStripped && !candidates.includes(strippedEnv)) {
      candidates.push(strippedEnv);
    }

    return candidates;
  }

  _stripWrappers(cmd) {
    const wrappers = new Set(['timeout', 'nice', 'nohup', 'stdbuf', 'setsid', 'env']);
    const parts = cmd.trim().split(/\s+/);
    if (parts.length > 1 && wrappers.has(parts[0])) {
      return parts.slice(1).join(' ');
    }
    return cmd;
  }

  // ===== 沙箱包装 =====

  async wrapWithSandbox(command, binShell) {
    if (!this._initialized) return command;
    return this._engine.wrapCommand(command, binShell);
  }

  // ===== 完整执行管道 =====

  /**
   * 执行命令的完整管道：
   *
   *   1. Security validation
   *   2. Build command string (env, extglob, eval, pwd tracking)
   *   3. Wrap with sandbox (bwrap / sandbox-exec)
   *   4. child_process.spawn()
   *   5. Post-command cleanup (bwrap ghost files, bare-repo scrub)
   *
   * @param {string} command
   * @param {object} options
   * @param {AbortSignal} [options.signal]
   * @param {number} [options.timeout]
   * @param {boolean} [options.dangerouslyDisableSandbox]
   * @param {function} [options.onProgress]
   * @returns {Promise<{ stdout: string, stderr: string, code: number, interrupted: boolean }>}
   */
  async exec(command, options = {}) {
    const {
      signal,
      timeout = DEFAULT_TIMEOUT_MS,
      dangerouslyDisableSandbox = false,
      onProgress,
    } = options;

    // ===== Step 1: Security validation =====
    const secResult = validateCommand(command, {
      shellType: 'bash',
    });
    if (!secResult.passed) {
      return {
        stdout: '',
        stderr: `[Security] Command blocked: ${secResult.message}`,
        code: 126,
        interrupted: false,
      };
    }

    // ===== Step 2: Build command =====
    const useSandbox = this.shouldUseSandbox({ command, dangerouslyDisableSandbox });
    const { commandString, cwdFilePath } = await buildCommand(command, {
      shellPath: this._shellPath,
      useSandbox,
      sandboxTmpDir: this._sandboxTmpDir,
    });

    let finalCommand = commandString;

    // ===== Step 3: Wrap with sandbox =====
    if (useSandbox) {
      try {
        finalCommand = await this._engine.wrapCommand(commandString, this._shellPath);
      } catch (err) {
        return {
          stdout: '',
          stderr: `[Sandbox] Failed to wrap command: ${err.message}`,
          code: 126,
          interrupted: false,
        };
      }
    }

    // ===== Step 4: Spawn =====
    //
    // ═══════════════════════════════════════════════════════════════
    // Windows 命令执行（from CC 源码解析）：
    //
    // CC 在 Windows 上**从不打开可见控制台窗口**执行命令.
    // 所有子进程都用以下模式：
    //
    //   spawn(gitBashPath, ['-c', command], {
    //     windowsHide: true,      // ← 关键：隐藏控制台窗口
    //     detached: true,         // ← 进程组独立，方便 kill
    //     stdio: ['pipe', fd, fd] // ← 管道/文件，非继承
    //   })
    //
    // ⚠️ windowsHide: true 在 CC 中用于所有子进程：
    //   - Shell.ts:336            — 主命令执行
    //   - hooks.ts:971,982        — hook 执行
    //   - sessionRunner.ts:339    — bridge 模式
    //   - LSPClient.ts:103        — LSP 服务器
    //
    // CC 唯一打开可见终端窗口的地方是 deep link handler
    // (terminalLauncher.ts)，当用户点击 claude:// 链接启动时
    // 才会创建新终端窗口：wt.exe / pwsh.exe / cmd.exe
    //
    // ⚠️ MSYS2 输出文件模式（容易踩的坑）：
    //   CC 在 Windows 上用 'w' 模式（FILE_GENERIC_WRITE）
    //   而非 'a' 模式（FILE_APPEND_DATA）打开输出文件，
    //   因为 MSYS2/Cygwin 进程用 NtQueryInformationFile 检查
    //   继承句柄的权限，只有 FILE_APPEND_DATA 的句柄被当成
    //   只读 → 静默丢弃所有输出！
    //
    // 这里我们使用管道模式（stdio: pipe），避免文件模式问题。
    // ═══════════════════════════════════════════════════════════════

    const shellArgs = getSpawnArgs(finalCommand);
    const envOverrides = getEnvironmentOverrides(
      useSandbox ? this._sandboxTmpDir : undefined
    );

    const child = spawn(this._shellPath, shellArgs, {
      env: {
        ...process.env,
        ...envOverrides,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });

    // 收集输出
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      if (onProgress) onProgress({ stdout: stdout, chunk: data.toString() });
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // 超时/中断处理
    const timer = timeout ? setTimeout(() => {
      killProcessTree(child.pid);
    }, timeout) : null;

    if (signal) {
      if (signal.aborted) {
        killProcessTree(child.pid);
        return { stdout, stderr, code: -1, interrupted: true };
      }
      signal.addEventListener('abort', () => {
        killProcessTree(child.pid);
        timer && clearTimeout(timer);
      }, { once: true });
    }

    // 等待完成
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        child.on('close', resolve);
        child.on('error', reject);
      });
    } catch (err) {
      timer && clearTimeout(timer);
      return {
        stdout,
        stderr: stderr || err.message,
        code: 126,
        interrupted: false,
      };
    } finally {
      timer && clearTimeout(timer);
    }

    // ===== Step 5: Read CWD file =====
    try {
      const newCwd = readFileSync(cwdFilePath, { encoding: 'utf8' }).trim();
      // 可以在这里更新全局 CWD 状态
    } catch {
      // CWD 文件可能不存在（命令中途失败）
    }

    // 清理临时文件
    try { unlinkSync(cwdFilePath); } catch { /* ignore */ }

    // ===== Step 6: Post-command cleanup =====
    if (useSandbox) {
      this._engine.cleanup();
      // Bare-repo scrub
      this._scrubBareGitRepoFiles();
    }

    return { stdout, stderr, code, interrupted: false };
  }

  // ===== 清理 =====

  /**
   * ⚠️ 清理 bwrap 创建的 0 字节 mount point 文件
   * bwrap 对 denyWrite 的不存在路径在宿主机创建 mount point 残影
   */
  cleanup() {
    if (this._engine) {
      this._engine.cleanup();
    }
  }

  /**
   * 裸仓库攻击防护：
   * 攻击者在 CWD 种植 HEAD + objects/ + refs/ 伪装 git bare repo，
   * LLM 执行 git 命令时会因为 core.fsmonitor 配置而执行任意命令。
   *
   * 这些文件在沙箱命令执行后被清除，确保后续 unsandboxed git 操作安全。
   */
  _scrubBareGitRepoFiles() {
    const cwd = process.cwd();
    const bareFiles = ['HEAD', 'objects', 'refs', 'hooks', 'config'];
    for (const file of bareFiles) {
      const p = join(cwd, file);
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // ENOENT is expected — nothing was planted
      }
    }
  }

  /**
   * 重置整个沙箱状态
   */
  async reset() {
    this.cleanup();
    this._initialized = false;
    this._config = normalizeConfig({});
    this._engine = null;
    this._platform = null;
  }
}

// ===== 工具函数 =====

function killProcessTree(pid) {
  if (!pid) return;
  try {
    const platform = getOsPlatform();
    if (platform === 'win32') {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        timeout: 3000,
      });
    } else {
      // 向整个进程组发信号（因为我们用了 detached: true）
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // 如果负 pid 不行（Windows），直接 kill
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    // 进程可能已经结束
  }
}
