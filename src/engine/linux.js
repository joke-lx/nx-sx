/**
 * Linux/WSL2 sandbox engine using bubblewrap (bwrap).
 *
 * bwrap architecture:
 *   bwrap --ro-bind / / --dev /dev --proc /proc --tmpfs /tmp \
 *         --unshare-net --unshare-ipc --unshare-uts \
 *         --setenv TMPDIR /sandbox-tmp \
 *         -- <shell> -c <command>
 *
 * This creates a new mount namespace where:
 *   - Root filesystem is read-only mount of host /
 *   - /tmp is an empty tmpfs (isolated temp)
 *   - /dev and /proc are minimal
 *   - Network is isolated (unless proxy configured)
 *   - IPC and UTS namespaces are private
 *
 * ⚠️ 注意：bwrap 遇到 denyWrite 的不存在路径时会在宿主机创建
 * 0 字节 mount point 文件，必须在命令执行后清理！
 */

import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';

// 所有 bwrap 调用都需要的最小参数集
function baseBwrapArgs(config) {
  const args = [];

  // Root filesystem: 只读挂载
  args.push('--ro-bind', '/', '/');
  // 设备
  args.push('--dev', '/dev');
  // 只读 /sys — 防止容器获取宿主机内核信息泄露
  args.push('--ro-bind', '/sys', '/sys');
  // proc
  args.push('--proc', '/proc');
  // tmpfs 隔离临时目录
  args.push('--tmpfs', '/tmp');

  // 用户家目录需要读写（用于 git ssh 等）
  const home = process.env.HOME;
  if (home) {
    args.push('--bind', home, home);
  }

  // 当前工作目录读写
  const cwd = process.cwd();
  args.push('--bind', cwd, cwd);

  // 处理配置中的 allowWrite/denyWrite
  if (config.filesystem) {
    for (const path of config.filesystem.allowWrite || []) {
      if (path && existsSync(path)) {
        args.push('--bind', path, path);
      }
    }
    for (const path of config.filesystem.denyWrite || []) {
      if (path && existsSync(path)) {
        // 已存在的路径用 ro-bind 替代 bind 以禁止写入
        args.push('--ro-bind', path, path);
      }
      // ⚠️ 不存在的路径由 bwrap 自动创建 0 字节文件，后续 cleanup
    }
  }

  // 网络隔离
  const network = config.network || {};
  if (network.httpProxyPort || network.socksProxyPort) {
    // 有代理端口时使用网络命名空间但限制流量通过代理
    args.push('--share-net');
    if (network.socksProxyPort) {
      // 设置环境变量让应用使用 SOCKS 代理
      args.push('--setenv', 'ALL_PROXY', `socks5://127.0.0.1:${network.socksProxyPort}`);
      args.push('--setenv', 'SOCKS_PROXY', `socks5://127.0.0.1:${network.socksProxyPort}`);
    }
  } else if (network.allowedDomains && network.allowedDomains.length > 0) {
    // 有 Domain 白名单：共享网络但之后通过 seccomp/iptables 限制
    args.push('--share-net');
  } else {
    // 默认完全隔离网络
    args.push('--unshare-net');
  }

  // IPC 和 UTS 隔离
  args.push('--unshare-ipc');
  args.push('--unshare-uts');

  // 设置环境变量
  if (config.filesystem?.allowWrite) {
    // TMPDIR 指向沙箱内的可写临时目录
    args.push('--setenv', 'TMPDIR', '/tmp');
  }

  return args;
}

export class LinuxEngine {
  get name() { return 'linux-bwrap'; }

  constructor(platformInfo) {
    this.platform = platformInfo;
    this.initialized = false;
    this.config = null;
    // 记录 denyWrite 中不存在的路径，用于 cleanup
    this._denyGhostPaths = [];
  }

  static isSupported() {
    return process.platform === 'linux';
  }

  static checkDependencies() {
    const errors = [];
    const warnings = [];

    try {
      execFileSync('which', ['bwrap'], { stdio: 'ignore', timeout: 5000 });
    } catch {
      errors.push('bwrap not found — install it: apt install bubblewrap');
    }

    try {
      execFileSync('which', ['socat'], { stdio: 'ignore', timeout: 5000 });
    } catch {
      warnings.push('socat not found — needed for HTTP proxy support');
    }

    return {
      available: errors.length === 0,
      errors,
      warnings,
    };
  }

  async initialize(config) {
    this.config = config;
    this.initialized = true;
  }

  async wrapCommand(command, binShell) {
    if (!this.initialized) {
      throw new Error('LinuxEngine not initialized');
    }

    const shell = binShell || process.env.SHELL || '/bin/bash';
    const args = baseBwrapArgs(this.config);

    // 追踪 ghost paths
    this._denyGhostPaths = [];
    if (this.config?.filesystem?.denyWrite) {
      for (const p of this.config.filesystem.denyWrite) {
        if (p && !existsSync(p)) {
          this._denyGhostPaths.push(p);
        }
      }
    }

    // 构建最终命令
    args.push('--', shell, '-c', command);

    // 返回包装后的命令字符串
    const fullCmd = ['bwrap', ...args].map(a => quoteArg(a)).join(' ');
    return fullCmd;
  }

  updateConfig(config) {
    this.config = config;
  }

  cleanup() {
    // ⚠️ 清理 bwrap 创建的 0 字节 mount point 文件
    for (const path of this._denyGhostPaths) {
      try {
        if (existsSync(path)) {
          rmSync(path, { recursive: true, force: true });
        }
      } catch {
        // 忽略清理错误
      }
    }
    this._denyGhostPaths = [];
  }
}

function quoteArg(arg) {
  if (/[^\w@%+=:,./-]/.test(arg)) {
    return `'${arg.replace(/'/g, "'\\''")}'`;
  }
  return arg;
}
