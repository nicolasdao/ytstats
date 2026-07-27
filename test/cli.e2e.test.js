import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CODES } from '../src/errors.js';

const run = promisify(execFile);
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'ytstats.js');

/**
 * Spawn the real binary the way a user (or a consuming script) would.
 * Never throws on a non-zero exit — the exit code is part of what we assert.
 */
async function ytstats(args, { configDir, cwd } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env: { ...process.env, YTSTATS_CONFIG_DIR: configDir, NO_COLOR: '1' },
      cwd: cwd ?? configDir,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe('ytstats CLI (end to end)', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytstats-e2e-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  describe('help and version', () => {
    it('--version prints the package version', async () => {
      const { code, stdout } = await ytstats(['--version'], { configDir: dir });
      expect(code).toBe(0);
      expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('--help lists the headline commands', async () => {
      const { code, stdout } = await ytstats(['--help'], { configDir: dir });
      expect(code).toBe(0);
      for (const cmd of ['login', 'logout', 'status', 'channel', 'videos', 'fetch', 'reach', 'query']) {
        expect(stdout).toContain(cmd);
      }
    });

    it('help documents the output contract', async () => {
      const { stdout } = await ytstats(['--help'], { configDir: dir });
      expect(stdout).toMatch(/stdout/);
      expect(stdout).toMatch(/exactly one JSON document/);
    });

    it('an unknown command still returns a parseable envelope naming valid commands', async () => {
      const { code, stdout, stderr } = await ytstats(['nonsense-command'], { configDir: dir });
      expect(code).toBe(3);
      const out = JSON.parse(stdout);
      expect(out.errors[0].code).toBe('INPUT_UNKNOWN_COMMAND');
      expect(out.errors[0].context.allowed).toContain('fetch');
      expect(out.nextSteps.join(' ')).toMatch(/ytstats --help/);
      expect(stderr).not.toMatch(/at .*\.js:\d+/);
    });
  });

  describe('status before login', () => {
    it('reports unauthenticated as valid JSON on stdout with exit 0', async () => {
      const { code, stdout } = await ytstats(['status'], { configDir: dir });
      expect(code).toBe(0);
      const out = JSON.parse(stdout);
      expect(out).toMatchObject({ ok: true, command: 'status' });
      expect(out.data.authenticated).toBe(false);
      expect(out.data.accounts).toEqual([]);
    });

    it('points at the per-user config dir for this OS', async () => {
      const { stdout } = await ytstats(['status'], { configDir: dir });
      expect(JSON.parse(stdout).data.configDir).toBe(dir);
    });

    it('includes the BYO setup guide when nothing is configured', async () => {
      const { stdout } = await ytstats(['status'], { configDir: dir });
      expect(JSON.parse(stdout).data.setupGuide).toMatch(/console\.cloud\.google\.com/);
    });
  });

  describe('commands that need auth', () => {
    it('on a machine with nothing configured, points at Google Cloud setup, not at login', async () => {
      const { code, stdout } = await ytstats(['channel'], { configDir: dir, cwd: dir });
      expect(code).toBe(EXIT_CODES.AUTH);
      const out = JSON.parse(stdout);
      expect(out.ok).toBe(false);
      // Telling someone with no OAuth client to "run login" sends them down a
      // path that cannot succeed; the prerequisite must be reported first.
      expect(out.errors[0].code).toBe('AUTH_NO_CREDENTIALS');
      expect(out.errors[0].remediation.steps.join(' ')).toMatch(/console\.cloud\.google\.com/);
    });

    it('once credentials exist but no login has happened, points at login', async () => {
      fs.writeFileSync(path.join(dir, 'credentials.json'), JSON.stringify({
        version: 1, clientId: 'cid.apps.googleusercontent.com', clientSecret: 'GOCSPX-x',
      }));
      const { code, stdout } = await ytstats(['channel'], { configDir: dir, cwd: dir });
      expect(code).toBe(EXIT_CODES.AUTH);
      const out = JSON.parse(stdout);
      expect(out.errors[0].code).toBe('AUTH_NO_TOKENS');
      expect(out.nextSteps.join(' ')).toMatch(/ytstats login/);
    });

    it('emits the failure envelope on stdout and the hint on stderr', async () => {
      const { stdout, stderr } = await ytstats(['fetch'], { configDir: dir });
      expect(() => JSON.parse(stdout)).not.toThrow();
      expect(stderr).toMatch(/ytstats login/);
    });

    it.each(['channel', 'videos', 'daily', 'traffic', 'geography', 'reach', 'fetch'])(
      '%s produces parseable JSON even when it fails',
      async command => {
        const { stdout } = await ytstats([command], { configDir: dir });
        const out = JSON.parse(stdout);
        expect(out.ok).toBe(false);
        expect(out.command).toBe(command);
        expect(out.data).toBeNull();
        expect(out.errors.length).toBeGreaterThan(0);
        expect(out.nextSteps.length).toBeGreaterThan(0);
        expect(out.errors[0].remediation.commands.length).toBeGreaterThan(0);
      },
    );
  });

  describe('input validation happens before any network call', () => {
    it('reports a malformed --start BEFORE the auth error, so one loop fixes both', async () => {
      const { code, stdout } = await ytstats(['daily', '--start', '01/01/2026'], { configDir: dir });
      expect(code).toBe(3);
      const out = JSON.parse(stdout);
      expect(out.errors[0].code).toBe('INPUT_INVALID_DATE');
      expect(out.errors[0].context).toMatchObject({ flag: '--start', value: '01/01/2026' });
      expect(out.errors[0].context.expected).toMatch(/YYYY-MM-DD/);
    });

    it('reports every bad date at once rather than one per run', async () => {
      const { stdout } = await ytstats(
        ['daily', '--start', '01/01/2026', '--end', 'yesterday'], { configDir: dir });
      const out = JSON.parse(stdout);
      expect(out.errors).toHaveLength(2);
      expect(out.errors.map(e => e.context.flag)).toEqual(['--start', '--end']);
    });

    it('rejects an invalid --type choice with the allowed set in the envelope', async () => {
      const { code, stdout } = await ytstats(['videos', '--type', 'BOGUS'], { configDir: dir });
      expect(code).toBe(3);
      const out = JSON.parse(stdout);
      expect(out.errors[0].code).toBe('INPUT_INVALID_CHOICE');
      expect(out.errors[0].context.value).toBe('BOGUS');
      expect(out.errors[0].context.allowed).toEqual(
        expect.arrayContaining(['SHORTS', 'VIDEO_ON_DEMAND', 'LIVE_STREAM']));
    });

    it('requires --metrics on query and names the flag', async () => {
      const { code, stdout } = await ytstats(['query'], { configDir: dir });
      expect(code).toBe(3);
      const out = JSON.parse(stdout);
      expect(out.errors[0].code).toBe('INPUT_MISSING_REQUIRED');
      expect(out.errors[0].detail).toMatch(/--metrics/);
    });
  });

  describe('login without credentials', () => {
    it('explains BYO setup instead of failing obscurely', async () => {
      const { code, stdout, stderr } = await ytstats(['login'], { configDir: dir, cwd: dir });
      expect(code).toBe(EXIT_CODES.AUTH);
      const out = JSON.parse(stdout);
      expect(out.errors[0].code).toBe('AUTH_NO_CREDENTIALS');
      expect(out.errors[0].remediation.steps.join(' ')).toMatch(/Desktop app/);
      expect(out.errors[0].remediation.steps.join(' ')).toMatch(/console\.cloud\.google\.com/);
    });

    it('rejects a service account key with a targeted message', async () => {
      const keyFile = path.join(dir, 'sa.json');
      fs.writeFileSync(keyFile, JSON.stringify({
        type: 'service_account',
        client_email: 'x@y.iam.gserviceaccount.com',
        private_key: 'PRIVATE',
      }));
      const { code, stdout } = await ytstats(['login', '--client-secret', keyFile], { configDir: dir });
      expect(code).toBe(EXIT_CODES.AUTH);
      const out = JSON.parse(stdout);
      expect(out.errors[0].code).toBe('AUTH_SERVICE_ACCOUNT');
      expect(out.errors[0].detail).toMatch(/service account/i);
      expect(out.errors[0].recoverable).toBe(false);
    });

    it('reports a missing credential file clearly', async () => {
      const { stdout } = await ytstats(['login', '--client-secret', path.join(dir, 'ghost.json')], { configDir: dir });
      expect(JSON.parse(stdout).errors[0].code).toBe('AUTH_CREDENTIALS_NOT_FOUND');
    });
  });

  describe('logout is safe when nothing is stored', () => {
    it('succeeds and reports nothing was logged out', async () => {
      const { code, stdout } = await ytstats(['logout'], { configDir: dir });
      expect(code).toBe(0);
      expect(JSON.parse(stdout).data.loggedOut).toBe(false);
    });
  });

  describe('global flags', () => {
    it('--compact emits single-line JSON', async () => {
      const { stdout } = await ytstats(['--compact', 'status'], { configDir: dir });
      expect(stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(stdout).ok).toBe(true);
    });

    it('--quiet keeps stderr clear but still emits JSON', async () => {
      const { stdout, stderr } = await ytstats(['--quiet', 'channel'], { configDir: dir });
      expect(stderr.trim()).toBe('');
      expect(JSON.parse(stdout).ok).toBe(false);
    });
  });

  describe('doctor', () => {
    it('reports every failing prerequisite in one call', async () => {
      const { stdout } = await ytstats(['doctor'], { configDir: dir, cwd: dir });
      const out = JSON.parse(stdout);
      expect(out.ok).toBe(true);
      expect(out.data.healthy).toBe(false);
      const ids = out.data.checks.map(c => c.id);
      expect(ids).toEqual(expect.arrayContaining(
        ['config_writable', 'credentials', 'signed_in', 'api_reachable']));
      expect(out.data.checks.find(c => c.id === 'config_writable').ok).toBe(true);
      expect(out.data.blocking.length).toBeGreaterThan(0);
    });

    it('names the exact diagnostic blocking each check', async () => {
      const { stdout } = await ytstats(['doctor'], { configDir: dir, cwd: dir });
      const out = JSON.parse(stdout);
      const creds = out.data.checks.find(c => c.id === 'credentials');
      expect(creds.ok).toBe(false);
      expect(creds.diagnosticCode).toBe('AUTH_NO_CREDENTIALS');
    });
  });

  describe('stdout purity', () => {
    it('stdout is exactly one JSON document, with progress kept on stderr', async () => {
      const { stdout } = await ytstats(['status'], { configDir: dir });
      const parsed = JSON.parse(stdout); // would throw if anything else were interleaved
      expect(parsed).toHaveProperty('ok');
      expect(stdout.trimEnd().endsWith('}')).toBe(true);
    });
  });
});
