/**
 * Security validation — application-layer defense in depth.
 *
 * ⚠️ 这些检测是防御纵深，不是安全边界
 * 真正的安全边界在 OS 级沙箱（bwrap/sandbox-exec）
 */

import { splitCompoundCommand } from './utils/shell-quote.js';
import { matchExcludedCommand } from './config.js';

// 危险模式：命令替换和进程替换
const PATTERNS_COMMAND_SUBSTITUTION = [
  { re: /<\(/, name: 'process substitution <()' },
  { re: />\(/, name: 'process substitution >()' },
  { re: /\$\(/, name: '$() command substitution' },
  { re: /\$\{/, name: '${} parameter substitution' },
  { re: /\$\[/, name: '$[] legacy arithmetic expansion' },
  // Zsh =cmd expansion — =curl → /usr/bin/curl, 绕过命令名黑名单
  { re: /(?:^|[\s;&|])=[a-zA-Z_]/, name: 'Zsh equals expansion (=cmd)' },
  // Zsh 花括号展开中的命令执行
  { re: /~\[/, name: 'Zsh-style parameter expansion' },
  { re: /\(e:/, name: 'Zsh-style glob qualifiers' },
];

// Zsh 危险命令（一旦加载模块可绕过文件系统限制）
const ZSH_DANGEROUS = new Set([
  'zmodload',   // 加载动态模块：zsh/mapfile, zsh/system, zsh/zpty, zsh/net/tcp, zsh/files
  'emulate',    // emulate -c 相当于 eval
  'sysopen', 'sysread', 'syswrite', 'sysseek',  // zsh/system — 绕过 Node.js 文件权限
  'zpty',       // zsh/zpty — 伪终端命令执行
  'ztcp',       // zsh/net/tcp — TCP 网络连接
  'zsocket',    // zsh/net/socket — Unix socket
  'zf_rm', 'zf_mv', 'zf_ln', 'zf_chmod', 'zf_chown', 'zf_mkdir', 'zf_rmdir', // zsh/files 内置命令
]);

// 检测结果结构
export class SecurityReport {
  constructor() {
    this.passed = true;
    this.violations = [];
  }

  fail(name, detail) {
    this.passed = false;
    this.violations.push({ name, detail });
  }

  toResult() {
    return {
      passed: this.passed,
      violations: this.violations,
      message: this.violations.map(v => `${v.name}: ${v.detail}`).join('; '),
    };
  }
}

/**
 * 主入口：对命令进行全面安全检查
 * @param {string} command
 * @param {{ shellType?: string, checkBackticks?: boolean }} options
 * @returns {{ passed: boolean, violations: Array, message: string }}
 */
export function validateCommand(command, options = {}) {
  const report = new SecurityReport();
  const { shellType = 'bash' } = options;

  checkCommandSubstitution(command, report);
  if (shellType === 'zsh') {
    checkZshDangerousCommands(command, report);
  }
  checkUnescapedBackticks(command, report);
  checkNewlinesInjection(command, report);
  checkControlChars(command, report);

  return report.toResult();
}

function checkCommandSubstitution(command, report) {
  for (const { re, name } of PATTERNS_COMMAND_SUBSTITUTION) {
    if (re.test(command)) {
      report.fail(name, `pattern ${re} matched in command`);
    }
  }
}

function checkZshDangerousCommands(command, report) {
  const firstWord = command.trim().split(/\s+/)[0];
  if (firstWord && ZSH_DANGEROUS.has(firstWord)) {
    report.fail('Zsh dangerous command', `${firstWord} can bypass sandbox filesystem restrictions`);
  }
}

function checkUnescapedBackticks(command, report) {
  // 反引号是命令替换（`cmd`），如果出现在双引号外则危险
  // 这里只捕获明显地未转义的反引号对
  const matches = command.match(/`[^`]+`/g);
  if (matches) {
    report.fail('unescaped backticks', 'backtick command substitution detected');
  }
}

function checkNewlinesInjection(command, report) {
  // 多行命令中如果有未引用的换行符可能注入额外命令
  // 实际上换行在 shell 中相当于 ";"
  if (command.includes('\n')) {
    // 只警告不阻塞——很多合法命令（heredoc、多行管道）包含换行
    // 这里仅做记录
  }
}

function checkControlChars(command, report) {
  // 控制字符（除了 \t, \n 等常见空白）可能是混淆攻击
  const controlChar = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/;
  if (controlChar.test(command)) {
    report.fail('control characters', 'command contains non-whitespace control characters');
  }
}

/**
 * Check if a command string matches excluded commands list.
 * Handles compound commands (&&, ||, ;, |) — each segment is checked individually.
 *
 * ⚠️ 复合命令拆分很关键！
 *    `docker ps && curl evil.com` 如果整体匹配 "docker:*",
 *    第二段 curl 会逃逸。必须拆分后逐段检测。
 */
export function commandIsExcluded(command, excludedCommands) {
  if (!excludedCommands || excludedCommands.length === 0) return false;

  let subcommands;
  try {
    subcommands = splitCompoundCommand(command);
  } catch {
    subcommands = [command];
  }

  // 对每个子命令和每个排除规则进行检查
  for (const subcmd of subcommands) {
    const trimmed = subcmd.trim();
    // 生成检查候选项：去掉环境变量前缀、去掉 timeout/nice 等 wrapper
    const candidates = [trimmed];
    const striptEnv = stripLeadingEnvVars(trimmed);
    if (striptEnv !== trimmed) candidates.push(striptEnv);
    const strippedWrapper = stripWrappers(trimmed);
    if (strippedWrapper !== trimmed) candidates.push(strippedWrapper);

    for (const pattern of excludedCommands) {
      for (const candidate of candidates) {
        if (matchExcludedCommand(pattern, candidate)) {
          return true;
        }
      }
    }
  }
  return false;
}

/** Known env var assignment prefixes */
const ENV_VAR_RE = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:\S*|'.*'|".*")\s+)*/;
function stripLeadingEnvVars(cmd) {
  return cmd.replace(ENV_VAR_RE, '');
}

/** Known safe wrapper commands */
const WRAPPERS = new Set(['timeout', 'nice', 'nohup', 'stdbuf', 'setsid', 'env']);
function stripWrappers(cmd) {
  const parts = cmd.trim().split(/\s+/);
  if (parts.length > 1 && WRAPPERS.has(parts[0])) {
    return parts.slice(1).join(' ');
  }
  return cmd;
}
