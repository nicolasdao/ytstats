import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useTempConfigDir, mode, isWindows } from '../helpers/tmp.js';
import {
  saveAccount,
  loadAccount,
  listAccounts,
  removeAccount,
  setDefaultAccount,
  clearAllAccounts,
  migrateLegacyTokens,
} from '../../src/auth/tokens.js';

const TOKENS_A = { access_token: 'ya29.aaa', refresh_token: '1//refresh-a', expiry_date: 1 };
const TOKENS_B = { access_token: 'ya29.bbb', refresh_token: '1//refresh-b', expiry_date: 2 };

describe('token store', () => {
  let tmp;
  beforeEach(() => { tmp = useTempConfigDir(); });
  afterEach(() => tmp.cleanup());

  it('returns null when nobody has logged in', () => {
    expect(loadAccount()).toBeNull();
    expect(listAccounts()).toEqual([]);
  });

  it('round-trips an account and makes it the default', () => {
    saveAccount({ channelId: 'UC1', channelTitle: 'Nic', tokens: TOKENS_A });
    const acct = loadAccount();
    expect(acct.channelId).toBe('UC1');
    expect(acct.channelTitle).toBe('Nic');
    expect(acct.tokens).toEqual(TOKENS_A);
  });

  it('stores several channels and selects between them', () => {
    saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
    saveAccount({ channelId: 'UC2', channelTitle: 'Two', tokens: TOKENS_B });
    expect(listAccounts().map(a => a.channelId).sort()).toEqual(['UC1', 'UC2']);
    expect(loadAccount('UC1').channelTitle).toBe('One');
    expect(loadAccount('UC2').channelTitle).toBe('Two');
  });

  it('keeps the first login as default when a second channel is added', () => {
    saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
    saveAccount({ channelId: 'UC2', channelTitle: 'Two', tokens: TOKENS_B });
    expect(loadAccount().channelId).toBe('UC1');
  });

  it('can switch the default', () => {
    saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
    saveAccount({ channelId: 'UC2', channelTitle: 'Two', tokens: TOKENS_B });
    setDefaultAccount('UC2');
    expect(loadAccount().channelId).toBe('UC2');
  });

  it('refuses to default to an unknown channel', () => {
    saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
    expect(() => setDefaultAccount('UC-nope')).toThrow(/not logged in|unknown/i);
  });

  it('updates tokens in place on re-login without duplicating the account', () => {
    saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
    saveAccount({ channelId: 'UC1', channelTitle: 'One Renamed', tokens: TOKENS_B });
    expect(listAccounts()).toHaveLength(1);
    expect(loadAccount('UC1').tokens).toEqual(TOKENS_B);
    expect(loadAccount('UC1').channelTitle).toBe('One Renamed');
  });

  it('resolves lookups by handle as well as channel id', () => {
    saveAccount({ channelId: 'UC1', channelTitle: 'One', customUrl: '@nicolasdao', tokens: TOKENS_A });
    expect(loadAccount('@nicolasdao').channelId).toBe('UC1');
  });

  it('returns null for an unknown selector rather than the default account', () => {
    saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
    expect(loadAccount('UC-ghost')).toBeNull();
  });

  describe('client binding', () => {
    it('records which OAuth client issued the token', () => {
      saveAccount({ channelId: 'UC1', clientId: 'client-A', tokens: TOKENS_A });
      expect(loadAccount('UC1').clientId).toBe('client-A');
    });

    it('preserves the binding when a token refresh writes back without one', () => {
      // The client.on('tokens') handler fires with a partial payload. Dropping
      // the clientId there would silently disarm mismatch detection after the
      // first refresh — exactly when it is still needed.
      saveAccount({ channelId: 'UC1', clientId: 'client-A', tokens: TOKENS_A });
      saveAccount({ channelId: 'UC1', tokens: { access_token: 'ya29.rotated' } });

      const acct = loadAccount('UC1');
      expect(acct.clientId).toBe('client-A');
      expect(acct.tokens.refresh_token).toBe('1//refresh-a');
    });

    it('re-login with a different client updates the binding', () => {
      saveAccount({ channelId: 'UC1', clientId: 'client-A', tokens: TOKENS_A });
      saveAccount({ channelId: 'UC1', clientId: 'client-B', tokens: TOKENS_B });
      expect(loadAccount('UC1').clientId).toBe('client-B');
    });

    it('reads null for an account stored before the field existed', () => {
      saveAccount({ channelId: 'UC1', tokens: TOKENS_A });
      expect(loadAccount('UC1').clientId).toBeNull();
      expect(listAccounts()[0].clientId).toBeNull();
    });

    it('exposes the client id in listAccounts — it is not a secret', () => {
      saveAccount({ channelId: 'UC1', clientId: 'client-A', tokens: TOKENS_A });
      expect(listAccounts()[0].clientId).toBe('client-A');
    });
  });

  describe('removal', () => {
    it('removes an account and reports it', () => {
      saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
      expect(removeAccount('UC1')).toBe(true);
      expect(loadAccount()).toBeNull();
      expect(removeAccount('UC1')).toBe(false);
    });

    it('promotes another account when the default is removed', () => {
      saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
      saveAccount({ channelId: 'UC2', channelTitle: 'Two', tokens: TOKENS_B });
      removeAccount('UC1');
      expect(loadAccount().channelId).toBe('UC2');
    });

    it('clearAllAccounts deletes the token file entirely', () => {
      saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
      clearAllAccounts();
      expect(fs.existsSync(path.join(tmp.dir, 'tokens.json'))).toBe(false);
      expect(loadAccount()).toBeNull();
    });
  });

  describe('security', () => {
    it.skipIf(isWindows)('stores refresh tokens with 0600 permissions', () => {
      saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
      expect(mode(path.join(tmp.dir, 'tokens.json'))).toBe('0600');
    });

    it('keeps refresh tokens out of listAccounts output', () => {
      saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_A });
      const listed = JSON.stringify(listAccounts());
      expect(listed).not.toMatch(/1\/\/refresh-a/);
      expect(listed).not.toMatch(/ya29/);
    });
  });

  describe('migration from the legacy .yta/tokens.json', () => {
    it('imports a legacy token file', () => {
      const legacy = path.join(tmp.dir, 'legacy-tokens.json');
      fs.writeFileSync(legacy, JSON.stringify(TOKENS_A));
      const result = migrateLegacyTokens(legacy, { channelId: 'UC1', channelTitle: 'One' });
      expect(result.migrated).toBe(true);
      expect(loadAccount('UC1').tokens.refresh_token).toBe('1//refresh-a');
    });

    it('is a no-op when there is no legacy file', () => {
      const result = migrateLegacyTokens(path.join(tmp.dir, 'absent.json'), { channelId: 'UC1' });
      expect(result.migrated).toBe(false);
    });

    it('does not clobber an existing logged-in account', () => {
      saveAccount({ channelId: 'UC1', channelTitle: 'One', tokens: TOKENS_B });
      const legacy = path.join(tmp.dir, 'legacy-tokens.json');
      fs.writeFileSync(legacy, JSON.stringify(TOKENS_A));
      const result = migrateLegacyTokens(legacy, { channelId: 'UC1', channelTitle: 'One' });
      expect(result.migrated).toBe(false);
      expect(loadAccount('UC1').tokens).toEqual(TOKENS_B);
    });

    it('ignores a legacy file with no refresh token', () => {
      const legacy = path.join(tmp.dir, 'legacy-tokens.json');
      fs.writeFileSync(legacy, JSON.stringify({ access_token: 'only-access' }));
      expect(migrateLegacyTokens(legacy, { channelId: 'UC1' }).migrated).toBe(false);
    });
  });
});
