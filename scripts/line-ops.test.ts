import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RichMenuObject } from '../packages/line-sdk/src/types.js';
import {
  runCli,
  validateRichMenuDefinition,
  type LineClientLike,
  type LineOpsDeps,
} from './line-ops.js';

const TOKEN = 'secret-token-xyz-123';

const DESIRED: RichMenuObject = {
  size: { width: 2500, height: 1686 },
  selected: true,
  name: 'test menu',
  chatBarText: 'メニュー',
  areas: [
    {
      bounds: { x: 0, y: 0, width: 2500, height: 1686 },
      action: { type: 'message', label: 'hello', text: 'hi' },
    },
  ],
};

function pngBytes(width: number, height: number, extraBytes = 0): Buffer {
  const b = Buffer.alloc(33 + extraBytes, 0x11);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const DESIRED_PNG = pngBytes(2500, 1686, 64);

interface Fixture {
  dir: string;
  registryPath: string;
  definitionPath: string;
  imagePath: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'line-ops-'));
  const registryPath = join(dir, 'registry.json');
  writeFileSync(
    registryPath,
    JSON.stringify({
      version: 1,
      accounts: {
        prod: { expectedBasicId: '@expected', token: { kind: 'env', name: 'LINE_OPS_TEST_TOKEN' } },
        ssh: {
          expectedBasicId: '@expected',
          token: { kind: 'ssh-container', host: 'box-1', container: 'ctr', env: 'CHANNEL_ACCESS_TOKEN' },
        },
        'ssh-bad': {
          expectedBasicId: '@expected',
          token: { kind: 'ssh-container', host: 'evil;touch /tmp/x', container: 'ctr', env: 'CHANNEL_ACCESS_TOKEN' },
        },
        'ssh-dash': {
          expectedBasicId: '@expected',
          token: { kind: 'ssh-container', host: '-V', container: 'ctr', env: 'CHANNEL_ACCESS_TOKEN' },
        },
      },
    }),
  );
  const definitionPath = join(dir, 'menu.json');
  writeFileSync(definitionPath, JSON.stringify(DESIRED));
  const imagePath = join(dir, 'menu.png');
  writeFileSync(imagePath, DESIRED_PNG);
  return { dir, registryPath, definitionPath, imagePath };
}

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

class FakeLine implements LineClientLike {
  calls: Call[] = [];
  menus: RichMenuObject[] = [];
  images = new Map<string, Uint8Array>();
  defaultId: string | null = null;
  basicId = '@expected';
  displayName = 'Fake Bot';
  nextCreateId = 'richmenu-new-1';
  createCalls = 0;
  uploadCalls = 0;
  setDefaultCalls = 0;
  onStage?: (method: string, path: string) => void;
  failOn?: (method: string, path: string) => Error | undefined;

  private record(method: string, path: string, body?: unknown): void {
    this.calls.push({ method, path, body });
    this.onStage?.(method, path);
    const err = this.failOn?.(method, path);
    if (err) throw err;
  }

  async request(method: string, path: string, body?: unknown) {
    this.record(method, path, body);
    if (method === 'GET' && path === '/v2/bot/info') {
      return { data: { basicId: this.basicId, displayName: this.displayName }, headers: new Headers() };
    }
    if (method === 'POST' && path === '/v2/bot/richmenu/validate') {
      return { data: {}, headers: new Headers() };
    }
    const m = /^\/v2\/bot\/richmenu\/([^/]+)$/.exec(path);
    if (method === 'GET' && m) {
      const id = decodeURIComponent(m[1]);
      const found = this.menus.find((x) => x.richMenuId === id);
      if (!found) throw new Error('LINE API error: 404 Not Found — {}');
      return { data: found, headers: new Headers() };
    }
    throw new Error(`unhandled ${method} ${path}`);
  }

  async getRichMenuList() {
    this.record('GET', '/v2/bot/richmenu/list');
    return { richmenus: this.menus };
  }

  async getDefaultRichMenuId() {
    this.record('GET', '/v2/bot/user/all/richmenu');
    return this.defaultId;
  }

  async createRichMenu(menu: RichMenuObject) {
    this.record('POST', '/v2/bot/richmenu', menu);
    this.createCalls++;
    this.menus.push({ ...menu, richMenuId: this.nextCreateId });
    return { richMenuId: this.nextCreateId };
  }

  async uploadRichMenuImage(richMenuId: string, imageData: ArrayBuffer) {
    this.record('POST', `https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`);
    this.uploadCalls++;
    this.images.set(richMenuId, new Uint8Array(imageData));
  }

  async setDefaultRichMenu(richMenuId: string) {
    this.record('POST', `/v2/bot/user/all/richmenu/${richMenuId}`);
    this.setDefaultCalls++;
    this.defaultId = richMenuId;
  }
}

function depsFor(
  fake: FakeLine,
  extra: Partial<LineOpsDeps> = {},
): { deps: LineOpsDeps; factoryCalls: number[]; execAuthCalls: unknown[] } {
  const factoryCalls: number[] = [];
  const execAuthCalls: unknown[] = [];
  const deps: LineOpsDeps = {
    env: { LINE_OPS_TEST_TOKEN: TOKEN },
    execAuth: async (spec) => {
      execAuthCalls.push(spec);
      return TOKEN;
    },
    clientFactory: () => {
      factoryCalls.push(1);
      return fake;
    },
    downloadImage: async (_token, id) => {
      const img = fake.images.get(id);
      if (!img) throw new Error('LINE API error: 404 Not Found — {}');
      return img;
    },
    ...extra,
  };
  return { deps, factoryCalls, execAuthCalls };
}

function receiptPath(dir: string, name = 'receipt.json'): string {
  return join(dir, name);
}

function args(fx: Fixture, ...rest: string[]): string[] {
  return ['--account', 'prod', '--registry', fx.registryPath, ...rest];
}

function applyArgs(fx: Fixture, receipt: string, expectDefault = 'none'): string[] {
  return args(
    fx,
    'richmenu', 'apply',
    '--definition', fx.definitionPath,
    '--image', fx.imagePath,
    '--confirm-basic-id', '@expected',
    '--expect-default', expectDefault,
    '--receipt', receipt,
  );
}

describe('account + identity gating', () => {
  it('unknown account fails before any client/auth work', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps, factoryCalls } = depsFor(fake);
    const { code, result } = await runCli(
      ['--account', 'nope', '--registry', fx.registryPath, 'info'],
      deps,
    );
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('unknown-account');
    expect(factoryCalls).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });

  it('missing --account fails nonzero', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps } = depsFor(fake);
    const { code, result } = await runCli(['--registry', fx.registryPath, 'info'], deps);
    expect(code).not.toBe(0);
    expect((result as { ok: boolean }).ok).toBe(false);
  });

  it('missing token fails before any API call', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps, factoryCalls } = depsFor(fake, { env: {} });
    const { code, result } = await runCli(args(fx, 'info'), deps);
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('missing-token');
    expect(factoryCalls).toHaveLength(0);
  });

  it('bot basicId mismatch aborts after bot-info only', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    fake.basicId = '@other-bot';
    const { deps } = depsFor(fake);
    const { code, result } = await runCli(args(fx, 'info'), deps);
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('bot-mismatch');
    expect(fake.calls).toEqual([{ method: 'GET', path: '/v2/bot/info', body: undefined }]);
    expect(fake.createCalls + fake.uploadCalls + fake.setDefaultCalls).toBe(0);
  });

  it('invalid registry file fails nonzero', async () => {
    const fx = makeFixture();
    writeFileSync(fx.registryPath, '{not json');
    const fake = new FakeLine();
    const { deps, factoryCalls } = depsFor(fake);
    const { code, result } = await runCli(args(fx, 'info'), deps);
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('invalid-registry');
    expect(factoryCalls).toHaveLength(0);
  });

  it('ssh-container spec is validated; unsafe host never reaches execAuth', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps, execAuthCalls, factoryCalls } = depsFor(fake);
    const { code, result } = await runCli(
      ['--account', 'ssh-bad', '--registry', fx.registryPath, 'info'],
      deps,
    );
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('invalid-registry');
    expect(execAuthCalls).toHaveLength(0);
    expect(factoryCalls).toHaveLength(0);
  });

  it('host starting with - is rejected before execAuth', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps, execAuthCalls, factoryCalls } = depsFor(fake);
    const { code, result } = await runCli(
      ['--account', 'ssh-dash', '--registry', fx.registryPath, 'info'],
      deps,
    );
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('invalid-registry');
    expect(execAuthCalls).toHaveLength(0);
    expect(factoryCalls).toHaveLength(0);
  });

  it('ssh-container token is resolved through execAuth privately', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps, execAuthCalls } = depsFor(fake);
    const { code, result } = await runCli(
      ['--account', 'ssh', '--registry', fx.registryPath, 'info'],
      deps,
    );
    expect(code).toBe(0);
    expect(execAuthCalls).toEqual([{ host: 'box-1', container: 'ctr', env: 'CHANNEL_ACCESS_TOKEN' }]);
    expect((result as { basicId: string }).basicId).toBe('@expected');
  });

  it('--help exits 0 without an account', async () => {
    const { code, result } = await runCli(['--help'], {});
    expect(code).toBe(0);
    expect((result as { usage: string }).usage).toContain('--account');
  });

  it('unknown args fail nonzero with JSON error', async () => {
    const { code, result } = await runCli(['--frobnicate', 'info'], {});
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('bad-args');
  });
});

describe('richmenu plan', () => {
  it('plan performs zero mutations (validate + reads only)', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps } = depsFor(fake);
    const { code, result } = await runCli(
      args(fx, 'richmenu', 'plan', '--definition', fx.definitionPath, '--image', fx.imagePath),
      deps,
    );
    expect(code).toBe(0);
    const r = result as { plannedMutations: string[]; beforeDefaultId: string | null; reuseId: string | null };
    expect(r.plannedMutations).toEqual(['create-richmenu', 'upload-image', 'set-default']);
    expect(r.beforeDefaultId).toBeNull();
    expect(r.reuseId).toBeNull();
    expect(fake.createCalls + fake.uploadCalls + fake.setDefaultCalls).toBe(0);
    expect(fake.calls.some((c) => c.path === '/v2/bot/richmenu/validate')).toBe(true);
  });

  it('plan reuses an existing identical definition+image', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    fake.menus.push({ ...DESIRED, richMenuId: 'richmenu-existing' });
    fake.images.set('richmenu-existing', DESIRED_PNG);
    const { deps } = depsFor(fake);
    const { code, result } = await runCli(
      args(fx, 'richmenu', 'plan', '--definition', fx.definitionPath, '--image', fx.imagePath),
      deps,
    );
    expect(code).toBe(0);
    const r = result as { reuseId: string | null; plannedMutations: string[] };
    expect(r.reuseId).toBe('richmenu-existing');
    expect(r.plannedMutations).toEqual(['set-default']);
  });

  it('plan output includes the full desired definition and size', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps } = depsFor(fake);
    const { code, result } = await runCli(
      args(fx, 'richmenu', 'plan', '--definition', fx.definitionPath, '--image', fx.imagePath),
      deps,
    );
    expect(code).toBe(0);
    const r = result as { desired: { size: { width: number }; definition: RichMenuObject } };
    expect(r.desired.size).toEqual({ width: 2500, height: 1686 });
    expect(r.desired.definition.areas).toHaveLength(1);
  });

  it.each([401, 500])('image read %i during reuse detection is an error, not absence (plan)', async (status) => {
    const fx = makeFixture();
    const fake = new FakeLine();
    fake.menus.push({ ...DESIRED, richMenuId: 'richmenu-existing' });
    const { deps } = depsFor(fake, {
      downloadImage: async () => {
        throw new Error(`LINE API error: ${status} — {"echo":"x"}`);
      },
    });
    const { code, result } = await runCli(
      args(fx, 'richmenu', 'plan', '--definition', fx.definitionPath, '--image', fx.imagePath),
      deps,
    );
    expect(code).not.toBe(0);
    const r = result as { error: { code: string; httpStatus?: number } };
    expect(r.error.code).toBe('upstream-error');
    expect(r.error.httpStatus).toBe(status);
    expect(fake.createCalls + fake.uploadCalls + fake.setDefaultCalls).toBe(0);
  });

  it.each([401, 500])('image read %i during reuse detection is an error, not absence (apply)', async (status) => {
    const fx = makeFixture();
    const fake = new FakeLine();
    fake.menus.push({ ...DESIRED, richMenuId: 'richmenu-existing' });
    const { deps } = depsFor(fake, {
      downloadImage: async () => {
        throw new Error(`LINE API error: ${status} — {"echo":"x"}`);
      },
    });
    const rc = receiptPath(fx.dir);
    const { code, result } = await runCli(applyArgs(fx, rc), deps);
    expect(code).not.toBe(0);
    const r = result as { error: { code: string; httpStatus?: number } };
    expect(r.error.code).toBe('upstream-error');
    expect(r.error.httpStatus).toBe(status);
    expect(fake.createCalls + fake.uploadCalls + fake.setDefaultCalls).toBe(0);
    const receipt = JSON.parse(readFileSync(rc, 'utf8'));
    expect(receipt.ok).not.toBe(true);
    expect(receipt.error.code).toBe('upstream-error');
    expect(receipt.mutations).toHaveLength(0);
  });

  it('image 404 on a matching menu means create exactly once', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    fake.menus.push({ ...DESIRED, richMenuId: 'richmenu-noimg' });
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code } = await runCli(applyArgs(fx, rc), deps);
    expect(code).toBe(0);
    expect(fake.createCalls).toBe(1);
    expect(fake.uploadCalls).toBe(1);
    expect(fake.setDefaultCalls).toBe(1);
  });

  it('local validation rejects wrong-dimension PNG before any API call', async () => {
    const fx = makeFixture();
    writeFileSync(fx.imagePath, pngBytes(1200, 800, 8));
    const fake = new FakeLine();
    const { deps, factoryCalls } = depsFor(fake);
    const { code, result } = await runCli(
      args(fx, 'richmenu', 'plan', '--definition', fx.definitionPath, '--image', fx.imagePath),
      deps,
    );
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('invalid-image');
    expect(factoryCalls).toHaveLength(0);
  });

  it('local validation rejects oversize PNG before any API call', async () => {
    const fx = makeFixture();
    writeFileSync(fx.imagePath, pngBytes(2500, 1686, 1_000_100));
    const fake = new FakeLine();
    const { deps, factoryCalls } = depsFor(fake);
    const { code, result } = await runCli(
      args(fx, 'richmenu', 'plan', '--definition', fx.definitionPath, '--image', fx.imagePath),
      deps,
    );
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('invalid-image');
    expect(factoryCalls).toHaveLength(0);
  });

  it('local validation rejects out-of-bounds areas before any API call', async () => {
    const fx = makeFixture();
    const bad = {
      ...DESIRED,
      areas: [
        { bounds: { x: 100, y: 0, width: 2500, height: 1686 }, action: { type: 'message', text: 'x' } },
      ],
    };
    writeFileSync(fx.definitionPath, JSON.stringify(bad));
    const fake = new FakeLine();
    const { deps, factoryCalls } = depsFor(fake);
    const { code, result } = await runCli(
      args(fx, 'richmenu', 'plan', '--definition', fx.definitionPath, '--image', fx.imagePath),
      deps,
    );
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('invalid-definition');
    expect(factoryCalls).toHaveLength(0);
  });

  it('local validation rejects null/missing bounds as invalid-definition, not internal', async () => {
    const fx = makeFixture();
    const bad = {
      ...DESIRED,
      areas: [
        { bounds: { x: 0, y: 0, width: 1250, height: 1686 }, action: { type: 'message', text: 'a' } },
        { bounds: null, action: { type: 'message', text: 'b' } },
        { action: { type: 'message', text: 'c' } },
      ],
    };
    writeFileSync(fx.definitionPath, JSON.stringify(bad));
    const fake = new FakeLine();
    const { deps, factoryCalls } = depsFor(fake);
    const { code, result } = await runCli(
      args(fx, 'richmenu', 'plan', '--definition', fx.definitionPath, '--image', fx.imagePath),
      deps,
    );
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('invalid-definition');
    expect(factoryCalls).toHaveLength(0);
  });

  it.each([
    { width: 700, height: 1686 },
    { width: 2600, height: 1686 },
    { width: 2500, height: 200 },
    { width: 1000, height: 1000 },
  ])('local validation rejects invalid size %j', async ({ width, height }) => {
    const fx = makeFixture();
    const bad = {
      ...DESIRED,
      size: { width, height },
      areas: [{ bounds: { x: 0, y: 0, width, height }, action: { type: 'message', text: 'x' } }],
    };
    writeFileSync(fx.definitionPath, JSON.stringify(bad));
    writeFileSync(fx.imagePath, pngBytes(width, height, 8));
    const fake = new FakeLine();
    const { deps, factoryCalls } = depsFor(fake);
    const { code, result } = await runCli(
      args(fx, 'richmenu', 'plan', '--definition', fx.definitionPath, '--image', fx.imagePath),
      deps,
    );
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('invalid-definition');
    expect(factoryCalls).toHaveLength(0);
  });

  it('local validation rejects unsupported action types', () => {
    const bad = {
      ...DESIRED,
      areas: [
        { bounds: { x: 0, y: 0, width: 2500, height: 1686 }, action: { type: 'teleport', data: 'x' } },
      ],
    };
    expect(() => validateRichMenuDefinition(bad)).toThrowError(/not supported/);
  });
});

describe('richmenu apply', () => {
  it('new menu: create -> upload -> verify -> set-default -> read-back, receipt ok', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code, result } = await runCli(applyArgs(fx, rc), deps);
    expect(code).toBe(0);
    expect(fake.createCalls).toBe(1);
    expect(fake.uploadCalls).toBe(1);
    expect(fake.setDefaultCalls).toBe(1);
    expect(fake.defaultId).toBe('richmenu-new-1');
    const stages = fake.calls.map((c) => `${c.method} ${c.path}`);
    const idxCreate = stages.indexOf('POST /v2/bot/richmenu');
    const idxUpload = stages.findIndex((p) => p.includes('api-data.line.me'));
    const idxSet = stages.indexOf('POST /v2/bot/user/all/richmenu/richmenu-new-1');
    const idxGetDef = stages.indexOf('GET /v2/bot/richmenu/richmenu-new-1');
    expect(idxCreate).toBeGreaterThan(-1);
    expect(idxUpload).toBeGreaterThan(idxCreate);
    expect(idxGetDef).toBeGreaterThan(idxUpload);
    expect(idxSet).toBeGreaterThan(idxGetDef);
    const receipt = JSON.parse(readFileSync(rc, 'utf8'));
    expect(receipt.ok).toBe(true);
    expect(receipt.createdId).toBe('richmenu-new-1');
    expect(receipt.effectiveId).toBe('richmenu-new-1');
    expect(receipt.beforeDefaultId).toBeNull();
    expect(receipt.verification).toEqual({ definitionMatch: true, imageMatch: true, defaultMatch: true });
    expect((result as { verification: { defaultMatch: boolean } }).verification.defaultMatch).toBe(true);
  });

  it('identical resource + same default -> zero mutations', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    fake.menus.push({ ...DESIRED, richMenuId: 'richmenu-existing' });
    fake.images.set('richmenu-existing', DESIRED_PNG);
    fake.defaultId = 'richmenu-existing';
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code } = await runCli(applyArgs(fx, rc, 'richmenu-existing'), deps);
    expect(code).toBe(0);
    expect(fake.createCalls + fake.uploadCalls + fake.setDefaultCalls).toBe(0);
    const receipt = JSON.parse(readFileSync(rc, 'utf8'));
    expect(receipt.ok).toBe(true);
    expect(receipt.mutations.every((m: { stage: string }) => !['create', 'upload-image', 'set-default'].includes(m.stage))).toBe(true);
  });

  it('stale default refuses before any write or receipt', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    fake.defaultId = 'richmenu-someone-else';
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code, result } = await runCli(applyArgs(fx, rc, 'none'), deps);
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('stale-plan');
    expect(fake.createCalls + fake.uploadCalls + fake.setDefaultCalls).toBe(0);
    expect(existsSync(rc)).toBe(false);
  });

  it('confirm-basic-id mismatch refuses before writes', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const a = applyArgs(fx, rc).map((x) => (x === '@expected' ? '@wrong' : x));
    const { code, result } = await runCli(a, deps);
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('bot-mismatch');
    expect(fake.createCalls + fake.uploadCalls + fake.setDefaultCalls).toBe(0);
  });

  it('default changed between check and set -> refusal, no set-default', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    fake.onStage = (method, path) => {
      if (path.includes('api-data.line.me')) fake.defaultId = 'richmenu-interloper';
    };
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code, result } = await runCli(applyArgs(fx, rc), deps);
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('stale-plan');
    expect(fake.setDefaultCalls).toBe(0);
    const receipt = JSON.parse(readFileSync(rc, 'utf8'));
    expect(receipt.ok).not.toBe(true);
    expect(receipt.createdId).toBe('richmenu-new-1');
  });

  it('stored image mismatch -> never sets default, receipt keeps createdId', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const origUpload = fake.uploadRichMenuImage.bind(fake);
    fake.uploadRichMenuImage = async (id, data) => {
      await origUpload(id, pngBytes(2500, 1686, 32).buffer as ArrayBuffer);
    };
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code, result } = await runCli(applyArgs(fx, rc), deps);
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('verify-mismatch');
    expect(fake.setDefaultCalls).toBe(0);
    expect(fake.defaultId).toBeNull();
    const receipt = JSON.parse(readFileSync(rc, 'utf8'));
    expect(receipt.ok).not.toBe(true);
    expect(receipt.createdId).toBe('richmenu-new-1');
  });

  it('stored definition mismatch -> never sets default', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const origRequest = fake.request.bind(fake);
    fake.request = async (method, path, body) => {
      const res = await origRequest(method, path, body);
      if (method === 'GET' && path === '/v2/bot/richmenu/richmenu-new-1') {
        return { data: { ...DESIRED, name: 'tampered name', richMenuId: 'richmenu-new-1' }, headers: res.headers };
      }
      return res;
    };
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code } = await runCli(applyArgs(fx, rc), deps);
    expect(code).not.toBe(0);
    expect(fake.setDefaultCalls).toBe(0);
  });

  it('upstream 500 on default check is an error, never treated as absent', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    fake.getDefaultRichMenuId = async () => {
      fake.calls.push({ method: 'GET', path: '/v2/bot/user/all/richmenu' });
      throw new Error('LINE API error: 500 Internal Server Error — {"secret":"x"}');
    };
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code, result } = await runCli(applyArgs(fx, rc), deps);
    expect(code).not.toBe(0);
    const r = result as { error: { code: string; httpStatus?: number; message?: string } };
    expect(r.error.code).toBe('upstream-error');
    expect(r.error.httpStatus).toBe(500);
    expect(r.error.message ?? '').not.toContain('secret');
    expect(fake.createCalls).toBe(0);
  });

  it('final read-back failure after set-default keeps stages in a saved receipt', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    let setDone = false;
    const origSet = fake.setDefaultRichMenu.bind(fake);
    fake.setDefaultRichMenu = async (id) => {
      await origSet(id);
      setDone = true;
    };
    const origRequest = fake.request.bind(fake);
    fake.request = async (method, path, body) => {
      if (setDone && method === 'GET' && path === '/v2/bot/richmenu/richmenu-new-1') {
        fake.calls.push({ method, path });
        throw new Error('LINE API error: 500 — {"echo":"x"}');
      }
      return origRequest(method, path, body);
    };
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code } = await runCli(applyArgs(fx, rc), deps);
    expect(code).not.toBe(0);
    const receipt = JSON.parse(readFileSync(rc, 'utf8'));
    expect(receipt.ok).not.toBe(true);
    expect(receipt.createdId).toBe('richmenu-new-1');
    expect(receipt.mutations.map((m: { stage: string }) => m.stage)).toContain('create');
    expect(receipt.mutations.map((m: { stage: string }) => m.stage)).toContain('set-default');
    expect(receipt.error.stage).toBe('fetch-definition');
    expect(JSON.stringify(receipt)).not.toContain('echo');
  });

  it('failure receipt retains createdId with ok != true', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    fake.uploadRichMenuImage = async () => {
      fake.uploadCalls++;
      throw new Error('LINE API error: 401 Unauthorized — {"token":"echo"}');
    };
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code, result } = await runCli(applyArgs(fx, rc), deps);
    expect(code).not.toBe(0);
    const receipt = JSON.parse(readFileSync(rc, 'utf8'));
    expect(receipt.ok).not.toBe(true);
    expect(receipt.createdId).toBe('richmenu-new-1');
    expect(receipt.error.code).toBe('upstream-error');
    expect(receipt.error.httpStatus).toBe(401);
    expect(JSON.stringify(receipt)).not.toContain('echo');
    expect((result as { error: { message?: string } }).error.message ?? '').not.toContain('echo');
  });

  it('existing receipt file is never overwritten', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    writeFileSync(rc, '{"sentinel":true}');
    const { code, result } = await runCli(applyArgs(fx, rc), deps);
    expect(code).not.toBe(0);
    expect((result as { error: { code: string } }).error.code).toBe('receipt-exists');
    expect(readFileSync(rc, 'utf8')).toBe('{"sentinel":true}');
    expect(fake.createCalls).toBe(0);
  });

  it('second apply reuses the created resource (no duplicate create)', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps } = depsFor(fake);
    const first = await runCli(applyArgs(fx, receiptPath(fx.dir, 'r1.json')), deps);
    expect(first.code).toBe(0);
    expect(fake.createCalls).toBe(1);
    const second = await runCli(
      applyArgs(fx, receiptPath(fx.dir, 'r2.json'), 'richmenu-new-1'),
      deps,
    );
    expect(second.code).toBe(0);
    expect(fake.createCalls).toBe(1);
    expect(fake.uploadCalls).toBe(1);
    expect(fake.setDefaultCalls).toBe(1);
    const receipt2 = JSON.parse(readFileSync(receiptPath(fx.dir, 'r2.json'), 'utf8'));
    expect(receipt2.ok).toBe(true);
    expect(receipt2.createdId).toBeNull();
    expect(receipt2.effectiveId).toBe('richmenu-new-1');
  });

  it('token never appears in output or receipt', async () => {
    const fx = makeFixture();
    const fake = new FakeLine();
    const { deps } = depsFor(fake);
    const rc = receiptPath(fx.dir);
    const { code, result } = await runCli(applyArgs(fx, rc), deps);
    expect(code).toBe(0);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(readFileSync(rc, 'utf8')).not.toContain(TOKEN);
  });
});
