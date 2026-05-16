import { createHash, randomBytes } from 'crypto';
import {
  GitBashWindowController,
  extractCommandName,
  normalizeWorkingDirectory,
} from './web-control/git-bash-window-controller.js';

function instanceTag(cwd) {
  const cwdHash = createHash('sha1').update(String(cwd)).digest('hex').slice(0, 8);
  const nonce = randomBytes(4).toString('hex');
  return `${cwdHash}-${nonce}`;
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = [...argv];
  const command = args[0];
  const cwd = args[1] ?? process.cwd();

  if (!command) {
    throw new Error('Usage: nx-sx <command> [path]');
  }

  const normalizedCwd = normalizeWorkingDirectory(cwd);
  const base = extractCommandName(command);
  const override = (process.env.NXSX_INSTANCE_NAME || '').trim();
  const name = override || `${base}-${instanceTag(normalizedCwd)}`;

  return {
    command,
    cwd: normalizedCwd,
    name,
    title: base,
  };
}

function registerSignalHandlers(onSignal) {
  const signals = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'];
  for (const signal of signals) {
    try {
      process.on(signal, () => onSignal(signal));
    } catch {
      // Signal may not be supported on this platform/runtime.
    }
  }
}

export async function runStartCli(argv = process.argv.slice(2)) {
  const { command, cwd, name, title } = parseCliArgs(argv);
  const controller = new GitBashWindowController({ name, cwd });

  const result = await controller.start({
    name,
    title,
    command,
    cwd,
    allowUnsandboxedWindow: true,
  });

  const pid = result?.pid ?? result?.state?.pid ?? null;
  const shutdown = async (reason = 'signal') => {
    try {
      await controller.stop();
    } catch {
      try {
        controller.stopSync();
      } catch {
        // ignore double-failure during shutdown
      }
    } finally {
      if (reason !== 'signal') {
        process.exit(0);
      }
    }
  };

  let shuttingDown = false;
  registerSignalHandlers(async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await shutdown();
    process.exit(0);
  });

  process.on('exit', () => {
    if (shuttingDown) return;
    try {
      controller.stopSync();
    } catch {
      // ignore exit cleanup failure
    }
  });

  process.stdin.resume();

  return {
    ok: true,
    pid,
    command,
    cwd,
    name,
    sandbox: result?.sandbox ?? result?.state?.sandbox ?? null,
  };
}
