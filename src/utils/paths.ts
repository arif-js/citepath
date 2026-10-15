import os from 'node:os';
import path from 'node:path';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Expands a leading "~" to the user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolves a path from the config file: "~" is expanded and relative paths are
 * resolved against the directory that contains the config file.
 */
export function resolveConfigRelativePath(p: string, configDir: string): string {
  return path.resolve(configDir, expandHome(p));
}

/**
 * Returns the data directory (index location).
 *
 * Precedence:
 * 1. Explicit override (--data-dir)
 * 2. CITEPATH_DATA_DIR environment variable
 * 3. `data_dir` from the config file (resolved relative to the config file)
 * 4. Platform default:
 *    - macOS: ~/Library/Application Support/citepath
 *    - Linux: $XDG_DATA_HOME/citepath or ~/.local/share/citepath
 *    - Windows: %LOCALAPPDATA%\citepath
 */
export function getDataDirectory(overridePath?: string, configDataDir?: string, configDir?: string): string {
  const override = nonEmpty(overridePath);
  if (override) return path.resolve(expandHome(override));

  const envPath = nonEmpty(process.env.CITEPATH_DATA_DIR);
  if (envPath) return path.resolve(expandHome(envPath));

  const fromConfig = nonEmpty(configDataDir);
  if (fromConfig) return resolveConfigRelativePath(fromConfig, configDir ?? process.cwd());

  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'citepath');
  }
  if (process.platform === 'win32') {
    const localAppData = nonEmpty(process.env.LOCALAPPDATA) ?? path.join(home, 'AppData', 'Local');
    return path.join(localAppData, 'citepath');
  }
  const xdgDataHome = nonEmpty(process.env.XDG_DATA_HOME);
  return xdgDataHome ? path.join(xdgDataHome, 'citepath') : path.join(home, '.local', 'share', 'citepath');
}

/**
 * Returns the config file path.
 *
 * Precedence:
 * 1. Explicit override (--config)
 * 2. CITEPATH_CONFIG environment variable
 * 3. Platform default:
 *    - macOS: ~/Library/Application Support/citepath/config.json
 *    - Linux: $XDG_CONFIG_HOME/citepath/config.json or ~/.config/citepath/config.json
 *    - Windows: %APPDATA%\citepath\config.json
 */
export function getConfigPath(overridePath?: string): string {
  const override = nonEmpty(overridePath);
  if (override) return path.resolve(expandHome(override));

  const envPath = nonEmpty(process.env.CITEPATH_CONFIG);
  if (envPath) return path.resolve(expandHome(envPath));

  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'citepath', 'config.json');
  }
  if (process.platform === 'win32') {
    const appData = nonEmpty(process.env.APPDATA) ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'citepath', 'config.json');
  }
  const xdgConfigHome = nonEmpty(process.env.XDG_CONFIG_HOME);
  return xdgConfigHome
    ? path.join(xdgConfigHome, 'citepath', 'config.json')
    : path.join(home, '.config', 'citepath', 'config.json');
}

/** Converts a filesystem-relative path to forward slashes for storage and citations. */
export function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

/** True if `child` is `parent` or inside it (both absolute, already resolved). */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // Different drive on Windows
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}
