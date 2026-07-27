import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useTempConfigDir } from '../helpers/tmp.js';
import {
  parseClientSecret,
  resolveCredentials,
  saveCredentials,
  loadStoredCredentials,
  clearCredentials,
  discoverClientSecretFile,
} from '../../src/auth/credentials.js';
import { ERROR_CODES } from '../../src/errors.js';

const INSTALLED = {
  installed: {
    client_id: '123-abc.apps.googleusercontent.com',
    client_secret: 'GOCSPX-topsecret',
    redirect_uris: ['http://localhost'],
  },
};

const WEB = {
  web: {
    client_id: '456-web.apps.googleusercontent.com',
    client_secret: 'GOCSPX-websecret',
  },
};

function writeSecretFile(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(body));
  return p;
}

describe('parseClientSecret', () => {
  it('reads the "installed" (Desktop app) shape', () => {
    expect(parseClientSecret(INSTALLED)).toEqual({
      clientId: '123-abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-topsecret',
    });
  });

  it('reads the "web" shape', () => {
    expect(parseClientSecret(WEB).clientId).toBe('456-web.apps.googleusercontent.com');
  });

  it('accepts an already-flat {client_id, client_secret} object', () => {
    expect(parseClientSecret({ client_id: 'x', client_secret: 'y' })).toEqual({
      clientId: 'x',
      clientSecret: 'y',
    });
  });

  it('rejects a service account key with a targeted error', () => {
    const err = (() => {
      try {
        parseClientSecret({ type: 'service_account', client_email: 'a@b.iam.gserviceaccount.com' });
      } catch (e) { return e; }
    })();
    expect(err.code).toBe('AUTH_SERVICE_ACCOUNT');
    expect(err.message).toMatch(/service account/i);
  });

  it('rejects an unrecognised shape', () => {
    expect(() => parseClientSecret({ nonsense: true })).toThrow(/client_id/i);
  });

  it('rejects a shape missing the secret', () => {
    expect(() => parseClientSecret({ installed: { client_id: 'x' } })).toThrow(/client_secret/i);
  });
});

describe('credential resolution precedence', () => {
  let tmp, cwd;
  beforeEach(() => {
    tmp = useTempConfigDir();
    cwd = fs.mkdtempSync(path.join(tmp.dir, 'cwd-'));
  });
  afterEach(() => tmp.cleanup());

  it('1. an explicit --client-secret file wins over everything', () => {
    const file = writeSecretFile(cwd, 'explicit.json', INSTALLED);
    saveCredentials({ clientId: 'stored', clientSecret: 'stored-secret' });
    const got = resolveCredentials({
      clientSecretPath: file,
      env: { YTSTATS_CLIENT_ID: 'env', YTSTATS_CLIENT_SECRET: 'env-secret' },
      cwd,
    });
    expect(got.clientId).toBe('123-abc.apps.googleusercontent.com');
    expect(got.source).toMatch(/explicit.json$/);
  });

  it('2. env vars win over stored credentials', () => {
    saveCredentials({ clientId: 'stored', clientSecret: 'stored-secret' });
    const got = resolveCredentials({
      env: { YTSTATS_CLIENT_ID: 'env', YTSTATS_CLIENT_SECRET: 'env-secret' },
      cwd,
    });
    expect(got.clientId).toBe('env');
    expect(got.source).toBe('environment');
  });

  it('3. stored credentials win over cwd auto-discovery', () => {
    writeSecretFile(cwd, 'client_secret_999.json', INSTALLED);
    saveCredentials({ clientId: 'stored', clientSecret: 'stored-secret' });
    const got = resolveCredentials({ env: {}, cwd });
    expect(got.clientId).toBe('stored');
    expect(got.source).toBe('stored');
  });

  it('4. falls back to auto-discovering client_secret*.json in the working dir', () => {
    writeSecretFile(cwd, 'client_secret_999.json', INSTALLED);
    const got = resolveCredentials({ env: {}, cwd });
    expect(got.clientId).toBe('123-abc.apps.googleusercontent.com');
    expect(got.source).toMatch(/client_secret_999\.json$/);
  });

  it('throws MISSING_CREDENTIALS with setup guidance when nothing is available', () => {
    const err = (() => {
      try { resolveCredentials({ env: {}, cwd }); } catch (e) { return e; }
    })();
    expect(err.code).toBe('AUTH_NO_CREDENTIALS');
    expect(err.diagnostic.remediation.steps.join(' ')).toMatch(/console\.cloud\.google\.com/);
    expect(err.diagnostic.remediation.steps.join(' ')).toMatch(/Desktop app/);
  });

  it('ignores a half-set env pair rather than producing broken credentials', () => {
    writeSecretFile(cwd, 'client_secret_1.json', INSTALLED);
    const got = resolveCredentials({ env: { YTSTATS_CLIENT_ID: 'only-id' }, cwd });
    expect(got.source).not.toBe('environment');
  });

  it('surfaces a clear error when the explicit path does not exist', () => {
    expect(() => resolveCredentials({ clientSecretPath: path.join(cwd, 'ghost.json'), env: {}, cwd }))
      .toThrow(/does not exist|not found/i);
  });

  it('surfaces a clear error when the explicit file is not JSON', () => {
    const p = path.join(cwd, 'bad.json');
    fs.writeFileSync(p, 'nope');
    expect(() => resolveCredentials({ clientSecretPath: p, env: {}, cwd })).toThrow(/valid JSON|could not be read/i);
  });
});

describe('discoverClientSecretFile', () => {
  let tmp, cwd;
  beforeEach(() => {
    tmp = useTempConfigDir();
    cwd = fs.mkdtempSync(path.join(tmp.dir, 'cwd-'));
  });
  afterEach(() => tmp.cleanup());

  it('returns null when there is no candidate', () => {
    expect(discoverClientSecretFile(cwd)).toBeNull();
  });

  it('prefers the exact name client_secret.json over a suffixed one', () => {
    writeSecretFile(cwd, 'client_secret_222.json', INSTALLED);
    writeSecretFile(cwd, 'client_secret.json', INSTALLED);
    expect(path.basename(discoverClientSecretFile(cwd))).toBe('client_secret.json');
  });

  it('picks deterministically when several suffixed files exist', () => {
    writeSecretFile(cwd, 'client_secret_b.json', INSTALLED);
    writeSecretFile(cwd, 'client_secret_a.json', INSTALLED);
    expect(path.basename(discoverClientSecretFile(cwd))).toBe('client_secret_a.json');
  });
});

describe('stored credential lifecycle', () => {
  let tmp;
  beforeEach(() => { tmp = useTempConfigDir(); });
  afterEach(() => tmp.cleanup());

  it('saves and loads', () => {
    saveCredentials({ clientId: 'a', clientSecret: 'b' });
    expect(loadStoredCredentials()).toMatchObject({ clientId: 'a', clientSecret: 'b' });
  });

  it('clears', () => {
    saveCredentials({ clientId: 'a', clientSecret: 'b' });
    expect(clearCredentials()).toBe(true);
    expect(loadStoredCredentials()).toBeNull();
  });

  it('never writes the secret anywhere except the 0600 credentials file', () => {
    saveCredentials({ clientId: 'a', clientSecret: 'super-secret-value' });
    const files = fs.readdirSync(tmp.dir);
    const hits = files.filter(f => {
      const full = path.join(tmp.dir, f);
      return fs.statSync(full).isFile()
        && fs.readFileSync(full, 'utf-8').includes('super-secret-value');
    });
    expect(hits).toEqual(['credentials.json']);
  });
});
