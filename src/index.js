/**
 * Sandbox Terminal — Public API
 *
 * Usage:
 *   import { SandboxManager } from './src/index.js';
 *   const sm = new SandboxManager();
 *   await sm.initialize({ enabled: true });
 *   const result = await sm.exec('ls -la');
 */

export { SandboxManager } from './sandbox-manager.js';
export { validateCommand } from './security.js';
export { normalizeConfig, mergeConfigs } from './config.js';
export { findShell, detectShellType } from './command-builder.js';
export { getSandboxPlatform, detectWsl, getOsPlatform } from './platform.js';

// Engine factory for advanced usage
export { createEngine, checkEngineDependencies } from './engine/index.js';
export { LinuxEngine } from './engine/linux.js';
export { MacOsEngine } from './engine/macos.js';
export { UnsupportedEngine } from './engine/unsupported.js';
export {
  GitBashWindowController,
  buildGitBashLaunchCommand,
  buildPowerShellStartScript,
  extractCommandName,
  normalizeWindowCommand,
  normalizeWorkingDirectory,
} from './web-control/index.js';
export { parseCliArgs, runStartCli } from './cli.js';
