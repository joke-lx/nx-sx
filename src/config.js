/**
 * Default sandbox settings.
 * Structure mirrors Claude Code's sandbox settings schema.
 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  failIfUnavailable: false,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: true,
  network: {
    allowedDomains: [],
    deniedDomains: [],
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowLocalBinding: false,
    httpProxyPort: undefined,
    socksProxyPort: undefined,
  },
  filesystem: {
    allowWrite: [],
    denyWrite: [],
    denyRead: [],
    allowRead: [],
  },
  ignoreViolations: {},
  excludedCommands: [],
  enableWeakerNetworkIsolation: false,
});

/**
 * Validate and normalize sandbox config.
 * Fills in missing fields with defaults.
 */
export function normalizeConfig(config) {
  if (!config || typeof config !== 'object') return { ...DEFAULT_CONFIG };

  const merged = {
    ...DEFAULT_CONFIG,
    ...config,
    network: { ...DEFAULT_CONFIG.network, ...(config.network || {}) },
    filesystem: { ...DEFAULT_CONFIG.filesystem, ...(config.filesystem || {}) },
  };

  // Ensure arrays
  for (const key of ['allowedDomains', 'deniedDomains', 'allowUnixSockets']) {
    if (!Array.isArray(merged.network[key])) merged.network[key] = [];
  }
  for (const key of ['allowWrite', 'denyWrite', 'denyRead', 'allowRead']) {
    if (!Array.isArray(merged.filesystem[key])) merged.filesystem[key] = [];
  }
  if (!Array.isArray(merged.excludedCommands)) merged.excludedCommands = [];

  return merged;
}

/**
 * Merge multiple config sources with priority order (last wins).
 * Also applies defaults for unspecified fields.
 */
export function mergeConfigs(...sources) {
  const merged = { ...DEFAULT_CONFIG };
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    merged.enabled = source.enabled ?? merged.enabled;
    merged.failIfUnavailable = source.failIfUnavailable ?? merged.failIfUnavailable;
    merged.autoAllowBashIfSandboxed = source.autoAllowBashIfSandboxed ?? merged.autoAllowBashIfSandboxed;
    merged.allowUnsandboxedCommands = source.allowUnsandboxedCommands ?? merged.allowUnsandboxedCommands;
    merged.enableWeakerNetworkIsolation = source.enableWeakerNetworkIsolation ?? merged.enableWeakerNetworkIsolation;

    if (source.network) {
      merged.network.allowedDomains = [
        ...new Set([...merged.network.allowedDomains, ...(source.network.allowedDomains || [])]),
      ];
      merged.network.deniedDomains = [
        ...new Set([...merged.network.deniedDomains, ...(source.network.deniedDomains || [])]),
      ];
      merged.network.allowUnixSockets = [
        ...new Set([...merged.network.allowUnixSockets, ...(source.network.allowUnixSockets || [])]),
      ];
      merged.network.allowAllUnixSockets = source.network.allowAllUnixSockets ?? merged.network.allowAllUnixSockets;
      merged.network.allowLocalBinding = source.network.allowLocalBinding ?? merged.network.allowLocalBinding;
      merged.network.httpProxyPort = source.network.httpProxyPort ?? merged.network.httpProxyPort;
      merged.network.socksProxyPort = source.network.socksProxyPort ?? merged.network.socksProxyPort;
    }

    if (source.filesystem) {
      // ⚠️ 路径去重但保留顺序
      merged.filesystem.allowWrite = [
        ...merged.filesystem.allowWrite,
        ...(source.filesystem.allowWrite || []),
      ];
      merged.filesystem.denyWrite = [
        ...merged.filesystem.denyWrite,
        ...(source.filesystem.denyWrite || []),
      ];
      merged.filesystem.denyRead = [
        ...merged.filesystem.denyRead,
        ...(source.filesystem.denyRead || []),
      ];
      merged.filesystem.allowRead = [
        ...merged.filesystem.allowRead,
        ...(source.filesystem.allowRead || []),
      ];
    }

    if (source.ignoreViolations) {
      merged.ignoreViolations = { ...merged.ignoreViolations, ...source.ignoreViolations };
    }

    if (Array.isArray(source.excludedCommands)) {
      merged.excludedCommands = [...new Set([...merged.excludedCommands, ...source.excludedCommands])];
    }
  }
  return merged;
}

/**
 * Resolve path patterns with CC-specific conventions.
 *
 * Permission rules use these conventions:
 *   //path → absolute (/path)
 *   /path  → relative to settings file directory ($SETTINGS_DIR/path)
 *   ~/path → home-relative (passthrough)
 *   ./path or path → CWD-relative (passthrough)
 *
 * sandbox.filesystem.* settings use DIFFERENT semantics:
 *   /path → absolute (NOT settings-relative! ⚠️ 常见陷阱)
 *   ~/path → home-relative
 *   ./path → CWD-relative
 *   //path → absolute (legacy compat)
 */
export function resolvePermissionPath(pattern, settingsRoot) {
  if (!pattern) return pattern;
  // //path → absolute
  if (pattern.startsWith('//')) return pattern.slice(1);
  // /path → settings-relative
  if (pattern.startsWith('/') && settingsRoot) {
    const joined = settingsRoot + pattern;
    return joined;
  }
  // ~/path, ./path, path → passthrough
  return pattern;
}

/**
 * Resolve sandbox.filesystem.* paths (NOT permission rules).
 * Here /path IS absolute path.
 */
export function resolveFilesystemPath(pattern, settingsRoot) {
  if (!pattern) return pattern;
  // //path → absolute (legacy compat)
  if (pattern.startsWith('//')) return pattern.slice(1);
  // /path → absolute (直接返回，和 resolvePermissionPath 不同!)
  if (pattern.startsWith('/')) return pattern;
  // ~/path → expand home
  if (pattern.startsWith('~')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return pattern.replace(/^~/, home);
  }
  // ./path or path → resolve against settings root
  if (settingsRoot) {
    return settingsRoot + '/' + pattern;
  }
  return pattern;
}

/**
 * Validate excluded-command match.
 * Supports three pattern types:
 *   command:*  → prefix match (command + space)
 *   command    → exact match
 *   glob pattern → wildcard match
 */
export function matchExcludedCommand(pattern, commandCandidate) {
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return commandCandidate === prefix || commandCandidate.startsWith(prefix + ' ');
  }
  if (pattern.includes('*') || pattern.includes('?')) {
    // Simple wildcard -> regex
    const regexStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    return new RegExp(regexStr).test(commandCandidate);
  }
  return commandCandidate === pattern;
}
