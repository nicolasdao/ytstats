import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { configDir } from './paths.js';

export { configDir };

// Everything this store holds is a secret (OAuth client secret, refresh tokens),
// so files are 0600 and the directory is 0700. Windows ignores POSIX modes; there
// the per-user %APPDATA% location is the protection.
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * File names are always flat inside the config dir. Anything that could escape it
 * (separators, traversal, absolute paths, NUL) is rejected rather than sanitised —
 * a caller passing one of those has a bug, and silently rewriting it hides it.
 */
function assertSafeName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name !== path.basename(name) ||
    name === '.' ||
    name === '..' ||
    path.isAbsolute(name) ||
    name.includes('\0')
  ) {
    throw new Error(`Invalid config file name: ${JSON.stringify(name)}`);
  }
  return name;
}

function ensureDir() {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is masked by umask, and the dir may predate us, so assert it.
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {
    // Windows and exotic filesystems: not fatal.
  }
  return dir;
}

function filePath(name) {
  return path.join(configDir(), assertSafeName(name));
}

/** Parsed JSON, or null when the file is absent or unreadable/corrupt. */
export function readJson(name) {
  const p = filePath(name);
  let raw;
  try {
    raw = fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Atomically write JSON with 0600 permissions.
 *
 * Written to a unique temp file in the same directory then renamed, so a crash or
 * a concurrent reader never observes a half-written token file. The temp file is
 * created with the final mode, so the secret is never briefly world-readable.
 */
export function writeJson(name, value) {
  const dir = ensureDir();
  const target = path.join(dir, assertSafeName(name));
  const tmp = path.join(dir, `.${name}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);

  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: FILE_MODE });
    try {
      fs.chmodSync(tmp, FILE_MODE);
    } catch {
      // Windows: no-op.
    }
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best effort.
    }
    throw err;
  }

  // rename preserves the temp file's mode, but if the target pre-existed with looser
  // permissions on some filesystems, make sure we end up locked down either way.
  try {
    fs.chmodSync(target, FILE_MODE);
  } catch {
    // Windows: no-op.
  }
  return target;
}

/** Delete a stored file. Returns true if something was removed. */
export function removeFile(name) {
  const p = filePath(name);
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Names of stored files (excludes in-flight temp files). */
export function listFiles() {
  try {
    return fs.readdirSync(configDir()).filter(f => !f.includes('.tmp-'));
  } catch {
    return [];
  }
}
