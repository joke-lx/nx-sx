/**
 * macOS sandbox engine using sandbox-exec (Seatbelt).
 *
 * sandbox-exec uses Seatbelt sandbox profiles (SBPL) to restrict
 * system calls and file system access. Unlike bwrap, it operates
 * at the syscall level rather than namespace level.
 *
 * Architecture:
 *   sandbox-exec -f seatbelt.sb -- <shell> -c <command>
 *
 * Profile capabilities:
 *   (deny file-write*)          — block file writes
 *   (allow file-write* (subpath "/path/to/allow"))  — except allowlisted paths
 *   (deny network*)            — block all network
 *   (allow network* (to "domain:443"))  — except specific domains
 *
 * ⚠️ macOS 限制：
 *   - sandbox-exec 不可嵌套（已沙箱的进程不能再创建沙箱）
 *   - macOS 13+ 对 sandbox-exec 有更严格的限制
 *   - Unix socket 可以通过 com.apple.trustd.agent 绕过（HTTPS）
 */

import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let profileCounter = 0;

export class MacOsEngine {
  get name() { return 'macos-seatbelt'; }

  constructor(platformInfo) {
    this.platform = platformInfo;
    this.initialized = false;
    this.config = null;
    this._profilePath = null;
    this._profilesDir = null;
  }

  static isSupported() {
    return process.platform === 'darwin';
  }

  static checkDependencies() {
    try {
      execFileSync('which', ['sandbox-exec'], { stdio: 'ignore', timeout: 5000 });
      return { available: true, errors: [], warnings: [] };
    } catch {
      return {
        available: false,
        errors: ['sandbox-exec not found'],
        warnings: [],
      };
    }
  }

  async initialize(config) {
    this.config = config;
    this.initialized = true;
  }

  async wrapCommand(command, binShell) {
    if (!this.initialized) {
      throw new Error('MacOsEngine not initialized');
    }

    // 创建 Seatbelt profile
    const profile = this._buildProfile();
    if (!this._profilesDir) {
      this._profilesDir = mkdtempSync(join(tmpdir(), 'sandbox-profile-'));
    }
    profileCounter++;
    const profilePath = join(this._profilesDir, `profile-${profileCounter}.sb`);
    writeFileSync(profilePath, profile, 'utf-8');
    this._profilePath = profilePath;

    const shell = binShell || process.env.SHELL || '/bin/zsh';

    // shell 命令需要先引用再传递给 sandbox-exec
    const args = ['sandbox-exec', '-f', profilePath, shell, '-c', command];
    const fullCmd = args.map(a => quoteMacArg(a)).join(' ');
    return fullCmd;
  }

  /**
   * Build Seatbelt profile (.sb) from config.
   * SBPL uses Lisp-like S-expression syntax.
   */
  _buildProfile() {
    const cfg = this.config || {};
    const lines = ['(version 1)'];

    // ——— File system ———
    const denyWrite = cfg.filesystem?.denyWrite || [];
    const allowWrite = cfg.filesystem?.allowWrite || [];

    if (denyWrite.length > 0 || true) {
      lines.push(`(deny file-write* (subpath "/"))`); // 默认禁止所有写入
      // 明确允许的路径
      const home = process.env.HOME || '/Users';
      const cwd = process.cwd();
      const allowed = [
        home,
        cwd,
        '/tmp',
        '/var/tmp',
        '/dev/null',
        '/dev/urandom',
        '/dev/random',
        '/dev/zero',
        ...allowWrite,
      ];
      for (const p of allowed) {
        if (p && existsSync(p)) {
          lines.push(`(allow file-write* (subpath "${p}"))`);
        }
      }
      // 明确禁止的路径（在 allow 之后应用）
      for (const p of denyWrite) {
        if (p) {
          // 再 deny 一次确保覆盖上面 allow 的同路径
          lines.push(`(deny file-write* (subpath "${p}"))`);
        }
      }
    }

    // ——— Network ———
    const network = cfg.network || {};
    if (network.allowAllUnixSockets) {
      // 允许所有 Unix socket（减弱网络隔离）
      lines.push(`(allow network*)`);
    } else if (network.allowedDomains && network.allowedDomains.length > 0) {
      // 仅允许白名单域名
      lines.push('(deny network*)');
      for (const domain of network.allowedDomains || ['github.com', 'api.github.com']) {
        lines.push(`(allow network* (to "domain:${domain}"))`);
      }
      // 允许本地回环（代理通信）
      lines.push('(allow network* (to "local:127.0.0.1"))');
      if (network.allowUnixSockets) {
        for (const socket of network.allowUnixSockets) {
          if (socket) lines.push(`(allow network* (to "unix-socket:${socket}"))`);
        }
      }
    } else {
      // 默认完全网络隔离
      lines.push('(deny network*)');
      if (network.allowLocalBinding) {
        lines.push('(allow network* (to "local:127.0.0.1"))');
      }
    }

    // ——— 必要系统权限 ———
    lines.push('(allow process-fork)');
    lines.push('(allow sysctl-read)');
    lines.push('(allow signal)');

    // POSIX IPC 必要
    lines.push('(allow ipc-posix*)');

    // 读取系统信息
    lines.push('(allow file-read-metadata (literal "/"))');

    return lines.join('\n') + '\n';
  }

  updateConfig(config) {
    this.config = config;
    // 配置变化时由调用方重新 wrapCommand（重新生成 profile）
  }

  cleanup() {
    // 清理 profile 文件
    if (this._profilePath) {
      try {
        rmSync(this._profilePath, { force: true });
      } catch { /* ignore */ }
      this._profilePath = null;
    }
  }

  /** Clean up temp directory on engine shutdown */
  _cleanupProfilesDir() {
    if (this._profilesDir) {
      try {
        rmSync(this._profilesDir, { recursive: true, force: true });
      } catch { /* ignore */ }
      this._profilesDir = null;
    }
  }
}

function quoteMacArg(arg) {
  if (/[\s'"]/.test(arg)) {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
  return arg;
}
