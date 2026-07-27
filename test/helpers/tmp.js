import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Create an isolated config dir for a test and point YTSTATS_CONFIG_DIR at it.
 * Returns { dir, cleanup }.
 */
export function useTempConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytstats-test-'));
  const previous = process.env.YTSTATS_CONFIG_DIR;
  process.env.YTSTATS_CONFIG_DIR = dir;

  return {
    dir,
    cleanup() {
      if (previous === undefined) delete process.env.YTSTATS_CONFIG_DIR;
      else process.env.YTSTATS_CONFIG_DIR = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Octal permission string for a path, e.g. '0600'. Meaningless on Windows. */
export function mode(p) {
  return '0' + (fs.statSync(p).mode & 0o777).toString(8);
}

export const isWindows = process.platform === 'win32';
