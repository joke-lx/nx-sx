/**
 * Sandbox engine factory.
 * Selects the appropriate engine based on platform.
 */

import { getSandboxPlatform } from '../platform.js';
import { LinuxEngine } from './linux.js';
import { MacOsEngine } from './macos.js';
import { UnsupportedEngine } from './unsupported.js';

const ENGINES = [LinuxEngine, MacOsEngine];

/**
 * Factory: create engine for current platform.
 * @returns {{ engine: import('./unsupported.js').UnsupportedEngine, platform: import('../platform.js').SandboxPlatform }}
 */
export function createEngine() {
  const platform = getSandboxPlatform();

  for (const EngineClass of ENGINES) {
    if (EngineClass.isSupported() && platform.supported) {
      return { engine: new EngineClass(platform), platform };
    }
  }

  return { engine: new UnsupportedEngine(platform), platform };
}

/**
 * Aggregate dependency checks across all possible engines.
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkEngineDependencies() {
  const errors = [];
  const warnings = [];

  for (const EngineClass of ENGINES) {
    if (EngineClass.isSupported()) {
      const result = EngineClass.checkDependencies();
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }
  }

  return { errors, warnings };
}
