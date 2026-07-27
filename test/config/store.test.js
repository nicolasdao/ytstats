import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useTempConfigDir, mode, isWindows } from '../helpers/tmp.js';
import { readJson, writeJson, removeFile, listFiles, configDir } from '../../src/config/store.js';

describe('secure config store', () => {
  let tmp;
  beforeEach(() => { tmp = useTempConfigDir(); });
  afterEach(() => tmp.cleanup());

  it('round-trips JSON', () => {
    writeJson('creds.json', { clientId: 'abc', nested: { x: 1 } });
    expect(readJson('creds.json')).toEqual({ clientId: 'abc', nested: { x: 1 } });
  });

  it('returns null for a file that does not exist', () => {
    expect(readJson('nope.json')).toBeNull();
  });

  it('returns null for corrupt JSON rather than throwing', () => {
    fs.writeFileSync(path.join(tmp.dir, 'bad.json'), '{ not json');
    expect(readJson('bad.json')).toBeNull();
  });

  it('overwrites cleanly on rewrite', () => {
    writeJson('t.json', { a: 1 });
    writeJson('t.json', { b: 2 });
    expect(readJson('t.json')).toEqual({ b: 2 });
  });

  it('leaves no temp files behind after an atomic write', () => {
    writeJson('t.json', { a: 1 });
    const leftovers = fs.readdirSync(tmp.dir).filter(f => f.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('creates the config dir on demand', () => {
    const sub = path.join(tmp.dir, 'deep', 'nested');
    process.env.YTSTATS_CONFIG_DIR = sub;
    writeJson('t.json', { a: 1 });
    expect(fs.existsSync(path.join(sub, 't.json'))).toBe(true);
  });

  it('removes files and reports whether anything was removed', () => {
    writeJson('t.json', { a: 1 });
    expect(removeFile('t.json')).toBe(true);
    expect(removeFile('t.json')).toBe(false);
    expect(readJson('t.json')).toBeNull();
  });

  it('lists stored files', () => {
    writeJson('a.json', {});
    writeJson('b.json', {});
    expect(listFiles().sort()).toEqual(['a.json', 'b.json']);
  });

  it('exposes the resolved config dir', () => {
    expect(configDir()).toBe(tmp.dir);
  });

  describe('security', () => {
    it.skipIf(isWindows)('writes secrets with 0600 permissions', () => {
      writeJson('tokens.json', { refresh_token: 'secret' });
      expect(mode(path.join(tmp.dir, 'tokens.json'))).toBe('0600');
    });

    it.skipIf(isWindows)('creates the config dir with 0700 permissions', () => {
      writeJson('tokens.json', { a: 1 });
      expect(mode(tmp.dir)).toBe('0700');
    });

    it.skipIf(isWindows)('repairs permissions on a pre-existing world-readable file', () => {
      const p = path.join(tmp.dir, 'tokens.json');
      fs.writeFileSync(p, '{}', { mode: 0o644 });
      writeJson('tokens.json', { a: 1 });
      expect(mode(p)).toBe('0600');
    });

    it('rejects path traversal in the file name', () => {
      expect(() => writeJson('../escape.json', {})).toThrow(/invalid/i);
      expect(() => readJson('../../etc/passwd')).toThrow(/invalid/i);
      expect(() => removeFile('sub/dir.json')).toThrow(/invalid/i);
    });

    it('rejects absolute paths as file names', () => {
      expect(() => writeJson('/etc/passwd', {})).toThrow(/invalid/i);
    });
  });
});
