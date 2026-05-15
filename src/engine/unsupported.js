/**
 * Unsupported platform engine.
 * Provides a no-op implementation that passes commands through unsandboxed.
 * Used on Windows and WSL1 where OS-level sandbox is unavailable.
 */
export class UnsupportedEngine {
  get name() { return 'unsupported'; }

  /**
   * @param {import('../platform.js').SandboxPlatform} platformInfo
   */
  constructor(platformInfo) {
    this.platform = platformInfo;
  }

  static isSupported() { return false; }

  static checkDependencies() {
    return {
      available: false,
      errors: ['No OS-level sandbox available on this platform'],
      warnings: [],
    };
  }

  /**
   * No-op — nothing to initialize on unsupported platforms.
   */
  async initialize(config) {
    // Nothing to do
  }

  /**
   * Identity — command runs unsandboxed.
   */
  async wrapCommand(command, binShell) {
    return command;
  }

  updateConfig(config) {
    // No-op
  }

  cleanup() {
    // No-op
  }
}
