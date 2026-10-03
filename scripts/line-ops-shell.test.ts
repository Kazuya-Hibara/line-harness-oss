import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LH = join(homedir(), '.agents/skills/line-harness/scripts/lh.sh');
const PREFLIGHT = join(homedir(), '.agents/skills/line-harness/scripts/lh-preflight.sh');

const STUB_CURL =
  '#!/usr/bin/env bash\n' +
  'printf \'%s\' "$FAKE_CURL_BODY"\n' +
  'exit "${FAKE_CURL_EXIT:-0}"\n';

function stubBin(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lh-stub-'));
  const p = join(dir, 'curl');
  writeFileSync(p, STUB_CURL);
  chmodSync(p, 0o755);
  return dir;
}

function lhEnv(bin: string, body: string, exitCode = '0'): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    LINE_HARNESS_API_URL: 'http://stub.invalid',
    LINE_HARNESS_API_KEY: 'stub-key',
    FAKE_CURL_BODY: body,
    FAKE_CURL_EXIT: exitCode,
  };
}

function runLh(
  script: string,
  argv: string[],
  opts: { body: string; exit?: number },
): { status: number; stdout: string; stderr: string } {
  const env = lhEnv(stubBin(), opts.body, String(opts.exit ?? 0));
  const r = spawnSync('bash', [script, ...argv], { env, encoding: 'utf8' });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('lh.sh _out envelope handling (stub curl, no network)', () => {
  it.each([
    ['{"success":true,"data":null}', 'null'],
    ['{"success":true,"data":0}', '0'],
    ['{"success":true,"data":false}', 'false'],
  ])('success envelope with %s passes', (body, expectedOut) => {
    const r = runLh(LH, ['get', '/api/friends/count'], { body });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(expectedOut);
  });

  it('success:false envelope fails without echoing the raw body', () => {
    const r = runLh(LH, ['get', '/api/x'], {
      body: '{"success":false,"data":{"detail":"MARKER-secret"},"error":"MARKER-secret"}',
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('MARKER-secret');
    expect(r.stderr).not.toContain('MARKER-secret');
  });

  it.each([22, 7])('curl exit %i (http error / unreachable) fails without echoing body', (exitCode) => {
    const r = runLh(LH, ['get', '/api/x'], {
      body: '{"error":"MARKER-401-body"}',
      exit: exitCode,
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('MARKER-401-body');
    expect(r.stderr).not.toContain('MARKER-401-body');
  });

  it('missing envelope keys fails', () => {
    const r = runLh(LH, ['get', '/api/x'], { body: '{"data":{"n":1}}' });
    expect(r.status).not.toBe(0);
  });
});

describe('lh-preflight.sh --ping envelope handling (stub curl, no network)', () => {
  it('200 with success:true envelope passes', () => {
    const body = '{"success":true,"data":{"count":10}}\n200';
    const env = lhEnv(stubBin(), body);
    const r = spawnSync('bash', [PREFLIGHT, '--ping'], { env, encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('reachable');
  });

  it('200 without success envelope fails', () => {
    const body = '{"unexpected":true}\n200';
    const env = lhEnv(stubBin(), body);
    const r = spawnSync('bash', [PREFLIGHT, '--ping'], { env, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
  });
});
