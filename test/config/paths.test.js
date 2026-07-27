import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { resolveConfigDir } from '../../src/config/paths.js';

// resolveConfigDir is a pure function taking injected platform/env/home so we can
// assert Windows and Linux behaviour while running the suite on any OS.
describe('resolveConfigDir', () => {
  it('honours YTSTATS_CONFIG_DIR above everything else', () => {
    const dir = resolveConfigDir({
      platform: 'darwin',
      env: { YTSTATS_CONFIG_DIR: '/custom/place', APPDATA: 'C:\\ignored' },
      home: '/Users/nic',
    });
    expect(dir).toBe(path.resolve('/custom/place'));
  });

  it('expands a relative YTSTATS_CONFIG_DIR to an absolute path', () => {
    const dir = resolveConfigDir({
      platform: 'linux',
      env: { YTSTATS_CONFIG_DIR: './rel' },
      home: '/home/nic',
    });
    expect(path.isAbsolute(dir)).toBe(true);
  });

  it('uses Application Support on macOS', () => {
    const dir = resolveConfigDir({ platform: 'darwin', env: {}, home: '/Users/nic' });
    expect(dir).toBe('/Users/nic/Library/Application Support/ytstats');
  });

  it('uses APPDATA on Windows', () => {
    const dir = resolveConfigDir({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\nic\\AppData\\Roaming' },
      home: 'C:\\Users\\nic',
    });
    expect(dir).toBe(path.join('C:\\Users\\nic\\AppData\\Roaming', 'ytstats'));
  });

  it('falls back to a home-relative path on Windows when APPDATA is unset', () => {
    const dir = resolveConfigDir({ platform: 'win32', env: {}, home: 'C:\\Users\\nic' });
    expect(dir).toBe(path.join('C:\\Users\\nic', 'AppData', 'Roaming', 'ytstats'));
  });

  it('honours XDG_CONFIG_HOME on Linux', () => {
    const dir = resolveConfigDir({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: '/home/nic/.xdg' },
      home: '/home/nic',
    });
    expect(dir).toBe(path.join('/home/nic/.xdg', 'ytstats'));
  });

  it('defaults to ~/.config on Linux', () => {
    const dir = resolveConfigDir({ platform: 'linux', env: {}, home: '/home/nic' });
    expect(dir).toBe('/home/nic/.config/ytstats');
  });

  it('ignores a relative XDG_CONFIG_HOME per the XDG spec', () => {
    const dir = resolveConfigDir({
      platform: 'linux',
      env: { XDG_CONFIG_HOME: 'not-absolute' },
      home: '/home/nic',
    });
    expect(dir).toBe('/home/nic/.config/ytstats');
  });
});
