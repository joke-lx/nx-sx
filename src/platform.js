import { readFileSync } from 'fs';

/** @returns {'linux'|'darwin'|'win32'} */
export function getOsPlatform() {
  return process.platform;
}

/**
 * Detect WSL1 vs WSL2.
 * WSL1 has "Microsoft" in /proc/version, WSL2 has "microsoft-standard" or "microsoft" (WSL2).
 * @returns {null|'wsl1'|'wsl2'}
 */
export function detectWsl() {
  if (process.platform !== 'linux') return null;
  try {
    const version = readFileSync('/proc/version', 'utf8').toLowerCase();
    if (version.includes('microsoft') || version.includes('wsl')) {
      // WSL2 kernel has 'microsoft-standard' or 'microsoft' in version string.
      // WSL1 (legacy) has 'microsoft' but no 'standard'.
      // Since WSL2 is the default since Windows 10 2004, treat 'microsoft' as WSL2
      // and only flag as WSL1 if explicitly indicated.
      if (version.includes('wsl1') || version.includes('wsl 1')) return 'wsl1';
      return 'wsl2';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get normalized platform identifier for sandbox purposes.
 * @returns {{ os: string, isWsl: boolean, wslVersion: null|'wsl1'|'wsl2', supported: boolean }}
 */
export function getSandboxPlatform() {
  const os = getOsPlatform();
  const wsl = detectWsl();

  let supported = false;
  if (os === 'darwin') supported = true;
  if (os === 'linux' && !wsl) supported = true;
  if (wsl === 'wsl2') supported = true;
  // WSL1 not supported

  return { os, isWsl: !!wsl, wslVersion: wsl, supported };
}
