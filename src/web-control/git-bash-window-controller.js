import { execFile, execFileSync } from 'child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { promisify } from 'util';
import { join } from 'path';
import { findShell, windowsPathToPosix } from '../command-builder.js';
import { getOsPlatform } from '../platform.js';
import { validateCommand } from '../security.js';

const execFileAsync = promisify(execFile);

function quoteForBashSingle(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

function quoteForPowerShellSingle(str) {
  return `'${String(str).replace(/'/g, "''")}'`;
}

function toPowerShellArray(args) {
  return `@(${args.map(arg => quoteForPowerShellSingle(arg)).join(', ')})`;
}

export function normalizeWindowCommand(command) {
  const trimmed = (command || '').trim();
  if (!trimmed) return 'exec bash -i';
  if (/\bexec\s+bash\s+-i\s*$/i.test(trimmed)) return trimmed;
  return `${trimmed}; exec bash -i`;
}

export function extractCommandName(command, fallback = 'start-window') {
  const trimmed = String(command || '').trim();
  if (!trimmed) return fallback;
  const [firstWord] = trimmed.split(/\s+/);
  return firstWord || fallback;
}

export function normalizeWorkingDirectory(cwd) {
  const raw = String(cwd || '').trim();
  if (!raw) return process.cwd();
  if (/^[A-Za-z]:$/.test(raw)) return `${raw}\\`;
  return raw;
}

export function buildGitBashLaunchCommand({ title = 'happy', cwd, command }) {
  const posixCwd = windowsPathToPosix(cwd);
  const titleCommand = `printf '\\033]0;${String(title).replace(/'/g, "'\\''")}\\007'`;
  const cdCommand = `cd ${quoteForBashSingle(posixCwd)}`;
  const shellCommand = normalizeWindowCommand(command);
  return `${titleCommand}; ${cdCommand} || exit 1; ${shellCommand}`;
}

export function buildCmdHostedGitBashCommand({ shellPath, title = 'happy', cwd, command }) {
  const posixCwd = windowsPathToPosix(cwd);
  const shellCommand = normalizeWindowCommand(command);
  const bashPayload = `cd ${quoteForBashSingle(posixCwd)} || exit 1; ${shellCommand}`;
  const escapedBashPayload = bashPayload.replace(/"/g, '\\"');
  return `set CHERE_INVOKING=1 && title ${title} && "${shellPath}" --login -i -c "${escapedBashPayload}"`;
}

export function buildPowerShellStartScript({
  shellPath,
  cwd,
  args,
}) {
  return [
    '$ErrorActionPreference = "Stop"',
    `$p = Start-Process -FilePath ${quoteForPowerShellSingle(shellPath)} ` +
      `-ArgumentList ${toPowerShellArray(args)} ` +
      `-WorkingDirectory ${quoteForPowerShellSingle(cwd)} ` +
      '-WindowStyle Normal -PassThru',
    '$p.Id',
  ].join('; ');
}

function isWindows() {
  return getOsPlatform() === 'win32';
}

function getDefaultStateDir() {
  return join(homedir(), '.start-cli');
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    const output = execFileSync(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8', stdio: 'pipe', timeout: 5000 },
    );
    if (/No tasks are running/i.test(output)) return false;
    return output.includes(`"${pid}"`);
  } catch {
    return false;
  }
}

function stopPidTreeSync(pid) {
  execFileSync(
    'taskkill',
    ['/T', '/F', '/PID', String(pid)],
    { windowsHide: true, stdio: 'ignore', timeout: 10000 },
  );
}

async function stopPidTree(pid) {
  await execFileAsync(
    'taskkill',
    ['/T', '/F', '/PID', String(pid)],
    { windowsHide: true },
  );
}

export class GitBashWindowController {
  constructor(options = {}) {
    this.name = options.name || 'happy';
    this.cwd = normalizeWorkingDirectory(options.cwd || process.cwd());
    this.stateDir = options.stateDir || getDefaultStateDir();
    this.shellPath = options.shellPath || null;
    mkdirSync(this.stateDir, { recursive: true });
  }

  get statePath() {
    return join(this.stateDir, `${this.name}.json`);
  }

  assertSupported() {
    if (!isWindows()) {
      throw new Error('Git Bash window control is only supported on Windows');
    }
  }

  readState() {
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8'));
    } catch {
      return null;
    }
  }

  writeState(state) {
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf8');
  }

  clearState() {
    try {
      rmSync(this.statePath, { force: true });
    } catch {
      // ignore cleanup failure
    }
  }

  getStatus() {
    const state = this.readState();
    if (!state) {
      return { name: this.name, running: false, pid: null, state: null };
    }

    const running = isProcessAlive(state.pid);
    if (!running) {
      this.clearState();
      return { name: this.name, running: false, pid: null, state: null };
    }

    return { name: this.name, running: true, pid: state.pid, state };
  }

  stopStateSync(state) {
    if (!state) return { ok: true, action: 'noop', running: false, pid: null, state: null };
    if (isProcessAlive(state.pid)) {
      stopPidTreeSync(state.pid);
    }
    this.clearState();
    return { ok: true, action: 'stopped', running: false, pid: null, state: null };
  }

  buildSandboxPolicy(options = {}) {
    const requireSandbox = options.requireSandbox === true;
    const allowUnsandboxedWindow = options.allowUnsandboxedWindow !== false;
    const available = false;
    const active = false;
    const reason = 'No OS-level sandbox available on native Windows visible terminal windows';

    if (requireSandbox && !available) {
      throw new Error(`Sandbox required for window launch, but unavailable: ${reason}`);
    }

    if (!allowUnsandboxedWindow && !active) {
      throw new Error(`Unsandboxed window launch is disabled: ${reason}`);
    }

    return {
      requested: requireSandbox,
      available,
      active,
      mode: active ? 'os-sandbox' : 'unsandboxed-window',
      reason,
    };
  }

  async start(options = {}) {
    this.assertSupported();

    const current = this.getStatus();
    if (current.running) {
      return { ok: true, action: 'noop', ...current };
    }

    const shellPath = options.shellPath || this.shellPath || findShell();
    if (!/bash(\.exe)?$/i.test(shellPath)) {
      throw new Error(`Git Bash was not found: ${shellPath}`);
    }

    const command = options.command || this.name;
    const cwd = normalizeWorkingDirectory(options.cwd || this.cwd);
    const title = options.title || options.name || this.name || extractCommandName(command);
    const validation = validateCommand(command, { shellType: 'bash' });
    if (!validation.passed) {
      throw new Error(`Command blocked by security validation: ${validation.message}`);
    }
    const sandbox = this.buildSandboxPolicy(options);
    const hostCommand = buildCmdHostedGitBashCommand({ shellPath, title, cwd, command });
    const startCmdScript = [
      '$ErrorActionPreference = "Stop"',
      `$p = Start-Process -FilePath 'cmd.exe' ` +
        `-ArgumentList ${toPowerShellArray(['/k', hostCommand])} ` +
        `-WorkingDirectory ${quoteForPowerShellSingle(cwd)} ` +
        '-WindowStyle Normal -PassThru',
      '$p.Id',
    ].join('; ');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', startCmdScript],
      { encoding: 'utf8', windowsHide: true },
    );

    const pid = Number.parseInt(String(stdout).trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Failed to acquire process id from PowerShell: ${stdout}`);
    }

    const state = {
      name: this.name,
      pid,
      shellPath,
      cwd,
      title,
      startedAt: new Date().toISOString(),
      command: normalizeWindowCommand(command),
      host: 'cmd.exe',
      sandbox,
    };
    this.writeState(state);

    return { ok: true, action: 'started', running: true, pid, state, sandbox };
  }

  async stop() {
    this.assertSupported();

    const state = this.readState();
    if (!state) {
      return { ok: true, action: 'noop', running: false, pid: null, state: null };
    }

    if (isProcessAlive(state.pid)) {
      await stopPidTree(state.pid);
    }

    this.clearState();
    return { ok: true, action: 'stopped', running: false, pid: null, state: null };
  }

  stopSync() {
    this.assertSupported();
    return this.stopStateSync(this.readState());
  }
}
