import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'ytstats';

/**
 * Resolve the per-user config directory for the current OS.
 *
 * Pure function — platform/env/home are injected so the behaviour for every OS
 * can be asserted from any OS.
 *
 * Precedence:
 *   1. YTSTATS_CONFIG_DIR (absolute or relative, always resolved to absolute)
 *   2. Platform convention:
 *      - macOS   ~/Library/Application Support/ytstats
 *      - Windows %APPDATA%\ytstats            (roaming, already per-user)
 *      - Linux   $XDG_CONFIG_HOME/ytstats or ~/.config/ytstats
 */
export function resolveConfigDir({ platform, env, home }) {
  if (env.YTSTATS_CONFIG_DIR) return path.resolve(env.YTSTATS_CONFIG_DIR);

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', APP_NAME);
  }

  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, APP_NAME);
  }

  // The XDG spec says a relative XDG_CONFIG_HOME must be ignored.
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(base, APP_NAME);
}

/** The config directory for the running process. */
export function configDir() {
  return resolveConfigDir({
    platform: process.platform,
    env: process.env,
    home: os.homedir(),
  });
}

export const CREDENTIALS_FILE = 'credentials.json';
export const TOKENS_FILE = 'tokens.json';
