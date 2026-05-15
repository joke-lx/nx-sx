/**
 * Shell command builder — constructs the full command string
 * to be spawned, including environment setup, security hardening,
 * CWD tracking, and sandbox wrapping.
 *
 * This is the "命令构建" layer from the architecture:
 *
 *   raw command
 *     → Windows >nul rewrite (Windows compatibility)
 *     → snapshot sourcing (env restoration)
 *     → extglob disable (security)
 *     → eval (execution)
 *     → pwd -P (CWD tracking)
 *     → CLAUDE_CODE_SHELL_PREFIX (optional Windows wrapper)
 *     → sandbox wrap (bwrap / sandbox-exec)
 *     → child_process.spawn()
 *
 * ═══════════════════════════════════════════════════
 * Windows 关键要点（from CC 源码）：
 *
 * 1. CC 在 Windows 上用 Git Bash 作为主 shell
 *    查找方式：where.exe git → ../../bin/bash.exe
 *    在 init.ts:186 通过 setShellIfWindows() 设置
 *
 * 2. ⚠️ 所有命令 spawn 都带 windowsHide: true
 *    包括 Bash 和 PowerShell，从不打开可见控制台窗口
 *    唯一打开窗口的地方是 deep link handler (terminalLauncher.ts)
 *
 * 3. PowerShell 工具：仅 Windows 可用，外部用户需 opt-in
 *
 * 4. ⚠️ MSYS2 文件模式坑：
 *    CC 对进程输出文件在 Windows 上用 'w' 模式而非 'a'
 *    因为 MSYS2/Cygwin 用 NtQueryInformationFile 检查句柄
 *    只有 FILE_APPEND_DATA 的句柄被当成只读 → 静默丢弃输出
 *
 * 5. CWD 追踪文件路径需要 POSIX↔Windows 转换
 *    shell 内 pwd -P 输出 POSIX 路径 /c/Users/foo
 *    Node.js readFileSync 需要 C:\Users\foo
 *
 * 6. Windows >nul 重定向 → 改写为 POSIX >/dev/null
 *    否则 bash 会在 CWD 创建名为 "nul" 的文件
 *    (anthropics/claude-code#4928)
 *
 * 7. CLAUDE_CODE_SHELL_PREFIX 环境变量
 *    可指定 wrapper 命令前缀，如 "C:\Program Files\Git\bin\bash.exe -c"
 *    用于在 Windows 上强制使用特定 shell 包装器
 * ═══════════════════════════════════════════════════
 */

import { execFileSync } from 'child_process';
import { accessSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as pathWin32 from 'path/win32';
import { quoteCommand } from './utils/shell-quote.js';
import { getOsPlatform } from './platform.js';

const IS_WINDOWS = getOsPlatform() === 'win32';

// ===== Shell 查找（Windows-aware） =====

/**
 * 在 Windows 上用 where.exe 查找可执行文件
 * ⚠️ 需要过滤掉 CWD 中的结果，防止执行恶意 git.bat
 */
function findWindowsExecutable(name) {
  try {
    const result = execFileSync('where.exe', [name], {
      encoding: 'utf8', timeout: 5000, stdio: 'pipe',
    });
    const cwd = process.cwd().toLowerCase();
    for (const line of result.split('\r\n').filter(Boolean)) {
      const dir = line.substring(0, line.lastIndexOf('\\')).toLowerCase();
      if (dir !== cwd) return line;
    }
  } catch { /* not found */ }
  return null;
}

/**
 * 检查 Windows 路径是否存在（用 dir 命令）
 */
function windowsPathExists(p) {
  try {
    accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 Windows 上查找 Git Bash 路径
 * 策略：where.exe git → ../../bin/bash.exe
 */
function findGitBashPath() {
  // 环境变量覆盖
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    if (windowsPathExists(process.env.CLAUDE_CODE_GIT_BASH_PATH)) {
      return process.env.CLAUDE_CODE_GIT_BASH_PATH;
    }
  }

  // 常见安装路径快速检查
  const commonPaths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of commonPaths) {
    if (windowsPathExists(p)) return p;
  }

  // 通过 git.exe 查找
  const gitPath = findWindowsExecutable('git');
  if (gitPath) {
    // git.exe 在 \cmd\git.exe → bin/bash.exe 在 \..\..\bin\bash.exe
    const bashPath = pathWin32.join(gitPath, '..', '..', 'bin', 'bash.exe');
    if (windowsPathExists(bashPath)) return bashPath;
  }

  return null;
}

/**
 * Find the best available POSIX-compatible shell.
 *
 * Windows 策略（from CC）:
 *   CLAUDE_CODE_GIT_BASH_PATH → where git → ../../bin/bash.exe
 *   找不到时 fallback 到 /bin/sh
 *
 * Linux/macOS 策略:
 *   SHELL env → /bin/bash → /bin/zsh → /bin/sh
 */
export function findShell() {
  if (IS_WINDOWS) {
    const gitBash = findGitBashPath();
    if (gitBash) return gitBash;
    // Fallback: 尝试 SHELL 环境变量
    if (process.env.SHELL) {
      try { accessSync(process.env.SHELL); return process.env.SHELL; } catch {}
    }
    // 最终 fallback — Node.js 有可能在 MSYS2 环境中运行
    return '/bin/sh';
  }

  // POSIX 路径
  const shellEnv = process.env.SHELL;
  if (shellEnv) {
    try { accessSync(shellEnv); return shellEnv; } catch {}
  }
  for (const candidate of ['/bin/bash', '/bin/zsh', '/bin/sh']) {
    try { accessSync(candidate); return candidate; } catch {}
  }
  try {
    const shell = execFileSync('which', ['bash'], { encoding: 'utf8', timeout: 5000 }).trim();
    if (shell) return shell;
  } catch {}
  return '/bin/sh';
}

/**
 * Detect shell type from path.
 */
export function detectShellType(shellPath) {
  if (!shellPath) return 'bash';
  const name = shellPath.toLowerCase();
  if (name.includes('zsh')) return 'zsh';
  if (name.includes('bash')) return 'bash';
  if (name.includes('sh')) return 'sh';
  return 'bash';
}

// ===== 路径转换 =====

/**
 * Windows POSIX 路径 → Windows 原生路径
 *   /c/Users/foo → C:\Users\foo
 *   /cygdrive/c/foo → C:\foo
 *   //server/share → \\server\share
 */
export function posixPathToWindows(posixPath) {
  if (posixPath.startsWith('//')) return posixPath.replace(/\//g, '\\');
  const cygdrive = posixPath.match(/^\/cygdrive\/([A-Za-z])(\/|$)/);
  if (cygdrive) {
    const rest = posixPath.slice(('/cygdrive/' + cygdrive[1]).length);
    return cygdrive[1].toUpperCase() + ':' + (rest || '\\').replace(/\//g, '\\');
  }
  const drive = posixPath.match(/^\/([A-Za-z])(\/|$)/);
  if (drive) {
    const rest = posixPath.slice(2);
    return drive[1].toUpperCase() + ':' + (rest || '\\').replace(/\//g, '\\');
  }
  return posixPath.replace(/\//g, '\\');
}

/**
 * Windows 原生路径 → POSIX 路径（供 shell 内使用）
 *   C:\Users\foo → /c/Users/foo
 *   \\server\share → //server/share
 */
export function windowsPathToPosix(windowsPath) {
  if (windowsPath.startsWith('\\\\')) return windowsPath.replace(/\\/g, '/');
  const match = windowsPath.match(/^([A-Za-z]):[/\\]/);
  if (match) return '/' + match[1].toLowerCase() + windowsPath.slice(2).replace(/\\/g, '/');
  return windowsPath.replace(/\\/g, '/');
}

// ===== Windows 兼容性改写 =====

/**
 * ⚠️ 重写 Windows >nul 重定向为 POSIX /dev/null
 * CC 发现模型常误发 `command 2>nul`（Windows CMD 语法）。
 * 在 Git Bash/MSYS2 中，这会在 CWD 创建名为 "nul" 的文件，
 * 而且 nul 是 Windows 保留设备名 → 后续 git 操作损坏
 * (anthropics/claude-code#4928)
 */
function rewriteWindowsNullRedirect(command) {
  return command.replace(/(\d*[>&]?)>nul\b/gi, (match, prefix) => {
    if (!prefix) return '>/dev/null';
    if (prefix === '>' || /\d/.test(prefix)) return `${prefix}>/dev/null`;
    return match;
  });
}

// ===== 命令构建 =====

/**
 * Build the extglob disable command.
 * Prevents glob-based security bypasses via malicious filenames.
 */
function getDisableExtglob(shellType) {
  if (shellType === 'zsh') return 'setopt NO_EXTENDED_GLOB 2>/dev/null || true';
  return 'shopt -u extglob 2>/dev/null || true';
}

/**
 * Apply CLAUDE_CODE_SHELL_PREFIX if set.
 *
 * 在 Windows 上可能设置为:
 *   "C:\Program Files\Git\bin\bash.exe -c"
 * 让所有命令通过特定 shell wrapper 执行。
 *
 * CC 实现 (shellPrefix.ts):
 *   拆分最后一个 " -" 分隔符，分别引用可执行文件和参数
 */
function applyShellPrefix(commandString) {
  const prefix = process.env.CLAUDE_CODE_SHELL_PREFIX;
  if (!prefix) return commandString;

  // 找到最后一个 " -" 分隔可执行文件和参数
  const sepIndex = prefix.lastIndexOf(' -');
  if (sepIndex === -1) {
    // 只有可执行文件，没有参数
    const quoted = prefix.includes(' ') ? `"${prefix}"` : prefix;
    return `exec "${quoted}" -c ${quoteForBash(commandString)}`;
  }

  const exe = prefix.slice(0, sepIndex);
  const args = prefix.slice(sepIndex + 1); // 包括 "-"
  const quotedExe = exe.includes(' ') ? `"${exe}"` : exe;
  return `exec ${quotedExe} ${args} ${quoteForBash(commandString)}`;
}

function quoteForBash(str) {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Build the full command string for execution.
 *
 * @param {string} command - The original user/LLM command
 * @param {object} options
 * @param {string} options.shellPath - Path to shell binary
 * @param {string|number} options.id - Unique command ID
 * @param {string} options.sandboxTmpDir - Temp dir for sandbox mode
 * @param {boolean} options.useSandbox - Whether to use sandbox paths
 * @returns {{ commandString: string, cwdFilePath: string }}
 */
export async function buildCommand(command, options) {
  const {
    shellPath = findShell(),
    id = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0'),
    sandboxTmpDir,
    useSandbox = false,
  } = options;

  const shellType = detectShellType(shellPath);
  const tmpDir = tmpdir();

  // Step 1: 重写 Windows >nul（在引用之前处理）
  const normalizedCommand = rewriteWindowsNullRedirect(command);

  // Step 2: 命令引用（防止注入）
  const quotedCmd = quoteCommand(normalizedCommand);

  // Step 3: CWD 追踪文件路径
  // ⚠️ Windows 注意：shell 内的 pwd -P 输出 POSIX 路径
  //   shell 端用 POSIX 路径写文件
  //   Node.js 端用 Windows 原生路径读文件
  const shellCwdFilePath = useSandbox && sandboxTmpDir
    ? join(sandboxTmpDir, `cwd-${id}`)
    : join(tmpDir, `cwd-${id}`);

  // Node.js 读取用的路径（Windows 上需要转换）
  let cwdFilePath = shellCwdFilePath;
  if (IS_WINDOWS) {
    // shell 内写文件的路径必须是 POSIX 格式（Git Bash 要求）
    // Node.js readFileSync 用的路径是 Windows 原生格式
    cwdFilePath = shellCwdFilePath; // Node.js 的 join 已经输出 Windows 格式
  }

  const parts = [];

  // 禁用别名展开
  parts.push('unalias -a 2>/dev/null || true');

  // 禁用 extglob
  parts.push(getDisableExtglob(shellType));

  // 执行命令
  parts.push(`eval ${quotedCmd}`);

  // CWD 追踪
  const shellCwdPath = IS_WINDOWS ? windowsPathToPosix(shellCwdFilePath) : shellCwdFilePath;
  parts.push(`pwd -P >| ${quoteForBash(shellCwdPath)}`);

  let commandString = parts.join(' && ');

  // CLAUDE_CODE_SHELL_PREFIX（CC Windows 支持）
  commandString = applyShellPrefix(commandString);

  return {
    commandString,
    cwdFilePath: IS_WINDOWS ? shellCwdFilePath : cwdFilePath,
  };
}

/**
 * Get spawn arguments for the shell.
 * Windows 上用 Git Bash 时不需要 `-l`（login shell 很慢且 snapshot 不可用）
 */
export function getSpawnArgs(commandString) {
  return ['-c', commandString];
}

/**
 * Build the environment overrides map for the spawned process.
 */
export function getEnvironmentOverrides(sandboxTmpDir) {
  const env = {};
  env.GIT_EDITOR = 'true';
  env.CLAUDECODE_SANDBOX = '1';
  if (sandboxTmpDir) {
    // Windows 上 TMPDIR 需要 POSIX 路径（Git Bash 使用）
    env.TMPDIR = IS_WINDOWS ? windowsPathToPosix(sandboxTmpDir) : sandboxTmpDir;
  }
  return env;
}
