import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { LineClient } from '../packages/line-sdk/src/client.js';
import type { RichMenuObject } from '../packages/line-sdk/src/types.js';

export const ADAPTER_ID = 'line-harness-line-sdk';

export interface LineAccount {
  expectedBasicId: string;
  token:
    | { kind: 'ssh-container'; host: string; container: string; env: string }
    | { kind: 'env'; name: string };
}

export interface AccountRegistry {
  version: 1;
  accounts: Record<string, LineAccount>;
}

export interface LineClientLike {
  request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: unknown; headers: Headers }>;
  getRichMenuList(): Promise<{ richmenus: RichMenuObject[] }>;
  getDefaultRichMenuId(): Promise<string | null>;
  createRichMenu(menu: RichMenuObject): Promise<{ richMenuId: string }>;
  uploadRichMenuImage(
    richMenuId: string,
    imageData: ArrayBuffer,
    contentType?: 'image/png' | 'image/jpeg',
  ): Promise<void>;
  setDefaultRichMenu(richMenuId: string): Promise<unknown>;
}

export interface SshTokenSpec {
  host: string;
  container: string;
  env: string;
}

export interface LineOpsDeps {
  env?: NodeJS.ProcessEnv;
  execAuth?: (spec: SshTokenSpec) => Promise<string>;
  clientFactory?: (token: string) => LineClientLike;
  downloadImage?: (token: string, richMenuId: string) => Promise<Uint8Array>;
  now?: () => Date;
  httpTimeoutMs?: number;
}

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const SSH_TIMEOUT_MS = 15_000;
const RICHMENU_IMAGE_MAX_BYTES = 1_000_000;

class OpsError extends Error {
  constructor(
    readonly code: string,
    readonly stage: string,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

function errResult(err: unknown): { code: number; result: unknown } {
  if (err instanceof OpsError) {
    return {
      code: 1,
      result: {
        ok: false,
        adapter: ADAPTER_ID,
        error: {
          code: err.code,
          stage: err.stage,
          message: err.message,
          ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
        },
      },
    };
  }
  return {
    code: 1,
    result: {
      ok: false,
      adapter: ADAPTER_ID,
      error: { code: 'internal', stage: 'unknown', message: 'unexpected internal error' },
    },
  };
}

function upstreamStatus(err: unknown): number | undefined {
  const m = err instanceof Error ? err.message : String(err);
  const match = /LINE API error: (\d+)/.exec(m);
  return match ? Number(match[1]) : undefined;
}

function apiError(stage: string, err: unknown): OpsError {
  return new OpsError(
    'upstream-error',
    stage,
    `LINE API request failed during ${stage}`,
    upstreamStatus(err),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(
        new OpsError('timeout', stage, `timed out after ${ms}ms during ${stage}`),
      );
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (e) => {
        clearTimeout(timer);
        rejectPromise(e);
      },
    );
  });
}

async function callApi<T>(stage: string, deps: LineOpsDeps, p: Promise<T>): Promise<T> {
  const ms = deps.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  try {
    return await withTimeout(p, ms, stage);
  } catch (err) {
    if (err instanceof OpsError) throw err;
    throw apiError(stage, err);
  }
}

const SSH_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function defaultExecAuth(spec: SshTokenSpec): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        spec.host,
        `docker exec ${spec.container} node -e 'process.stdout.write(process.env.${spec.env} || "")'`,
      ],
      { timeout: SSH_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) {
          rejectPromise(
            new OpsError('auth-failed', 'auth', `failed to read token from ${spec.host}`),
          );
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

async function resolveToken(account: LineAccount, deps: LineOpsDeps): Promise<string> {
  const spec = account.token;
  if (spec.kind === 'env') {
    if (!ENV_NAME_RE.test(spec.name)) {
      throw new OpsError('invalid-registry', 'auth', `invalid env var name in registry`);
    }
    const token = (deps.env ?? process.env)[spec.name];
    if (!token) {
      throw new OpsError('missing-token', 'auth', `env var ${spec.name} is not set`);
    }
    return token;
  }
  if (!SSH_NAME_RE.test(spec.host) || !SSH_NAME_RE.test(spec.container) || !ENV_NAME_RE.test(spec.env)) {
    throw new OpsError('invalid-registry', 'auth', `invalid ssh-container token spec in registry`);
  }
  const execAuth = deps.execAuth ?? defaultExecAuth;
  const token = await execAuth({ host: spec.host, container: spec.container, env: spec.env });
  if (!token) {
    throw new OpsError('missing-token', 'auth', `token from ${spec.host} was empty`);
  }
  return token;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const SUPPORTED_ACTION_TYPES = new Set([
  'uri',
  'message',
  'postback',
  'datetimepicker',
  'richmenuswitch',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

interface NumericBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function validateAction(action: unknown, index: number, issues: string[]): void {
  if (!isRecord(action) || typeof action.type !== 'string') {
    issues.push(`areas[${index}].action is not an object with a type`);
    return;
  }
  if (!SUPPORTED_ACTION_TYPES.has(action.type)) {
    issues.push(`areas[${index}].action.type '${action.type}' is not supported`);
    return;
  }
  if ('label' in action && action.label !== undefined) {
    if (typeof action.label !== 'string' || action.label.length === 0 || action.label.length > 20) {
      issues.push(`areas[${index}].action.label must be 1-20 chars`);
    }
  }
  switch (action.type) {
    case 'uri':
      if (typeof action.uri !== 'string' || action.uri.length === 0 || action.uri.length > 1000) {
        issues.push(`areas[${index}].action.uri must be 1-1000 chars`);
      } else if (!/^(https?|tel):/.test(action.uri)) {
        issues.push(`areas[${index}].action.uri scheme must be http/https/tel`);
      }
      break;
    case 'message':
      if (typeof action.text !== 'string' || action.text.length === 0 || action.text.length > 300) {
        issues.push(`areas[${index}].action.text must be 1-300 chars`);
      }
      break;
    case 'postback':
      if (typeof action.data !== 'string' || action.data.length === 0 || action.data.length > 300) {
        issues.push(`areas[${index}].action.data must be 1-300 chars`);
      }
      break;
    case 'datetimepicker':
      if (typeof action.data !== 'string' || action.data.length === 0 || action.data.length > 300) {
        issues.push(`areas[${index}].action.data must be 1-300 chars`);
      }
      if (action.mode !== 'date' && action.mode !== 'time' && action.mode !== 'datetime') {
        issues.push(`areas[${index}].action.mode must be date|time|datetime`);
      }
      break;
    case 'richmenuswitch':
      if (typeof action.richMenuAliasId !== 'string' || action.richMenuAliasId.length === 0) {
        issues.push(`areas[${index}].action.richMenuAliasId is required`);
      }
      if (typeof action.data !== 'string' || action.data.length === 0 || action.data.length > 300) {
        issues.push(`areas[${index}].action.data must be 1-300 chars`);
      }
      break;
  }
}

function boundsOverlap(a: NumericBounds, b: NumericBounds): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

export function validateRichMenuDefinition(def: unknown): RichMenuObject {
  const issues: string[] = [];
  if (!isRecord(def)) {
    throw new OpsError('invalid-definition', 'local-validate', 'definition is not a JSON object');
  }
  const size = def.size;
  if (!isRecord(size) || !isPosInt(size.width) || !isPosInt(size.height)) {
    issues.push('size.width/height must be positive integers');
  } else {
    if (size.width < 800 || size.width > 2500) {
      issues.push('size.width must be 800-2500');
    }
    if (size.height < 250) issues.push('size.height must be >= 250');
    if (size.width / size.height < 1.45) {
      issues.push('size aspect ratio must be >= 1.45');
    }
  }
  if (typeof def.selected !== 'boolean') issues.push('selected must be a boolean');
  if (typeof def.name !== 'string' || def.name.length === 0 || def.name.length > 300) {
    issues.push('name must be 1-300 chars');
  }
  if (
    typeof def.chatBarText !== 'string' ||
    def.chatBarText.length === 0 ||
    def.chatBarText.length > 14
  ) {
    issues.push('chatBarText must be 1-14 chars');
  }
  const areas = def.areas;
  if (!Array.isArray(areas) || areas.length === 0 || areas.length > 20) {
    issues.push('areas must contain 1-20 entries');
  } else {
    const width = isRecord(size) && isPosInt(size.width) ? size.width : 0;
    const height = isRecord(size) && isPosInt(size.height) ? size.height : 0;
    const numericBounds: { index: number; bounds: NumericBounds }[] = [];
    areas.forEach((area, i) => {
      if (!isRecord(area) || !isRecord(area.bounds)) {
        issues.push(`areas[${i}].bounds is missing`);
        if (isRecord(area)) validateAction(area.action, i, issues);
        return;
      }
      const b = area.bounds;
      if (!isNonNegInt(b.x) || !isNonNegInt(b.y) || !isPosInt(b.width) || !isPosInt(b.height)) {
        issues.push(`areas[${i}].bounds must be non-negative integer x/y and positive integer width/height`);
      } else {
        if (b.x + b.width > width || b.y + b.height > height) {
          issues.push(`areas[${i}].bounds exceeds the ${width}x${height} canvas`);
        }
        numericBounds.push({ index: i, bounds: { x: b.x, y: b.y, width: b.width, height: b.height } });
      }
      validateAction(area.action, i, issues);
    });
    for (let i = 0; i < numericBounds.length; i++) {
      for (let j = i + 1; j < numericBounds.length; j++) {
        if (boundsOverlap(numericBounds[i].bounds, numericBounds[j].bounds)) {
          issues.push(`areas[${numericBounds[i].index}] and areas[${numericBounds[j].index}] overlap`);
        }
      }
    }
  }
  if (issues.length > 0) {
    throw new OpsError(
      'invalid-definition',
      'local-validate',
      `definition failed local validation: ${issues.join('; ')}`,
    );
  }
  return def as unknown as RichMenuObject;
}

export interface DesiredMenu {
  definition: RichMenuObject;
  image: Buffer;
  imageSha256: string;
  definitionSha256: string;
}

function loadDesired(definitionPath: string, imagePath: string): DesiredMenu {
  let rawDef: unknown;
  try {
    rawDef = JSON.parse(readFileSync(definitionPath, 'utf8'));
  } catch {
    throw new OpsError('invalid-input', 'local-validate', `cannot read/parse definition file: ${definitionPath}`);
  }
  const definition = validateRichMenuDefinition(rawDef);

  let image: Buffer;
  try {
    image = readFileSync(imagePath);
  } catch {
    throw new OpsError('invalid-input', 'local-validate', `cannot read image file: ${imagePath}`);
  }
  const png = readPngSize(image);
  if (!png) {
    throw new OpsError('invalid-image', 'local-validate', 'image is not a valid PNG (magic/IHDR check failed)');
  }
  if (png.width !== definition.size.width || png.height !== definition.size.height) {
    throw new OpsError(
      'invalid-image',
      'local-validate',
      `image is ${png.width}x${png.height} but definition size is ${definition.size.width}x${definition.size.height}`,
    );
  }
  if (image.length > RICHMENU_IMAGE_MAX_BYTES) {
    throw new OpsError(
      'invalid-image',
      'local-validate',
      `image is ${image.length} bytes, over the ${RICHMENU_IMAGE_MAX_BYTES} byte limit`,
    );
  }
  const canonicalJson = JSON.stringify(definition);
  return {
    definition,
    image,
    imageSha256: sha256(image),
    definitionSha256: sha256(Buffer.from(canonicalJson, 'utf8')),
  };
}

function sha256(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function normalizeDefinition(d: RichMenuObject): unknown {
  return {
    size: d.size,
    selected: d.selected,
    name: d.name,
    chatBarText: d.chatBarText,
    areas: d.areas,
  };
}

function normalizeBasicId(id: string): string {
  return id.startsWith('@') ? id : `@${id}`;
}

function defaultRegistryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '.devin', 'line-accounts.json');
}

function loadRegistry(path: string): AccountRegistry {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new OpsError('invalid-registry', 'load-registry', `cannot read/parse registry: ${path}`);
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !isRecord(parsed.accounts)
  ) {
    throw new OpsError('invalid-registry', 'load-registry', 'registry must be {version:1,accounts:{...}}');
  }
  return parsed as unknown as AccountRegistry;
}

const VALUE_FLAGS = new Set([
  '--account',
  '--registry',
  '--id',
  '--definition',
  '--image',
  '--confirm-basic-id',
  '--expect-default',
  '--receipt',
]);

interface ParsedArgs {
  help: boolean;
  positionals: string[];
  options: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { help: false, positionals: [], options: {} };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!VALUE_FLAGS.has(name)) {
        throw new OpsError('bad-args', 'parse-args', `unknown option: ${name}`);
      }
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined || value.startsWith('--')) {
        throw new OpsError('bad-args', 'parse-args', `option ${name} requires a value`);
      }
      if (name in out.options) {
        throw new OpsError('bad-args', 'parse-args', `duplicate option: ${name}`);
      }
      out.options[name] = value;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new OpsError('bad-args', 'parse-args', `unknown option: ${arg}`);
    }
    out.positionals.push(arg);
  }
  return out;
}

const USAGE = `line-ops — account-scoped LINE operations (adapter: ${ADAPTER_ID})

  line-ops.ts --account NAME info
  line-ops.ts --account NAME richmenu list
  line-ops.ts --account NAME richmenu inspect --id ID
  line-ops.ts --account NAME richmenu plan  --definition FILE --image FILE
  line-ops.ts --account NAME richmenu apply --definition FILE --image FILE \
      --confirm-basic-id @ID --expect-default ID|none --receipt FILE

Options:
  --registry PATH     account registry (default: <repo>/.devin/line-accounts.json)
  --account NAME      mandatory; no default account exists
`;

const COMMANDS = new Set([
  'info',
  'richmenu list',
  'richmenu inspect',
  'richmenu plan',
  'richmenu apply',
]);

interface Mutation {
  stage: string;
  at: string;
  detail?: string;
}

interface Receipt {
  version: 1;
  adapter: string;
  account: string;
  basicId: string;
  startedAt: string;
  updatedAt: string;
  expectDefault: string;
  beforeDefaultId: string | null;
  desired: {
    name: string;
    definitionSha256: string;
    imageSha256: string;
    imageBytes: number;
  };
  createdId: string | null;
  effectiveId: string | null;
  mutations: Mutation[];
  verification: {
    definitionMatch: boolean;
    imageMatch: boolean;
    defaultMatch: boolean;
  };
  ok: boolean;
  error?: { code: string; stage: string; httpStatus?: number };
}

interface BotInfo {
  basicId: string;
  displayName: string;
}

async function fetchBotInfo(client: LineClientLike, deps: LineOpsDeps): Promise<BotInfo> {
  const { data } = await callApi('bot-info', deps, client.request('GET', '/v2/bot/info'));
  const info = data as { basicId?: string; displayName?: string };
  if (typeof info.basicId !== 'string' || info.basicId.length === 0) {
    throw new OpsError('upstream-error', 'bot-info', 'bot info response lacked basicId');
  }
  return { basicId: info.basicId, displayName: info.displayName ?? '' };
}

async function fetchDefinition(
  client: LineClientLike,
  deps: LineOpsDeps,
  richMenuId: string,
): Promise<RichMenuObject> {
  const { data } = await callApi(
    'fetch-definition',
    deps,
    client.request('GET', `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`),
  );
  return data as RichMenuObject;
}

async function fetchImage(
  token: string,
  deps: LineOpsDeps,
  richMenuId: string,
): Promise<Uint8Array> {
  const download =
    deps.downloadImage ??
    (async (t: string, id: string): Promise<Uint8Array> => {
      const res = await fetch(
        `https://api-data.line.me/v2/bot/richmenu/${encodeURIComponent(id)}/content`,
        {
          headers: { Authorization: `Bearer ${t}` },
          signal: AbortSignal.timeout(deps.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS),
        },
      );
      if (!res.ok) {
        throw new Error(`LINE API error: ${res.status} ${res.statusText}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    });
  try {
    const bytes = await withTimeout(
      download(token, richMenuId),
      deps.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
      'fetch-image',
    );
    if (!readPngSize(Buffer.from(bytes))) {
      throw new OpsError('upstream-error', 'fetch-image', 'downloaded content is not a PNG');
    }
    return bytes;
  } catch (err) {
    if (err instanceof OpsError) throw err;
    throw apiError('fetch-image', err);
  }
}

async function findReusableMenu(
  client: LineClientLike,
  token: string,
  deps: LineOpsDeps,
  desired: DesiredMenu,
): Promise<string | null> {
  const { richmenus } = await callApi('list', deps, client.getRichMenuList());
  for (const menu of richmenus) {
    if (!menu.richMenuId) continue;
    if (!isDeepStrictEqual(normalizeDefinition(menu), normalizeDefinition(desired.definition))) {
      continue;
    }
    let image: Uint8Array;
    try {
      image = await fetchImage(token, deps, menu.richMenuId);
    } catch (err) {
      if (err instanceof OpsError && err.httpStatus === 404) continue;
      throw err;
    }
    if (sha256(image) === desired.imageSha256) return menu.richMenuId;
  }
  return null;
}

interface Session {
  account: string;
  accountDef: LineAccount;
  token: string;
  client: LineClientLike;
  bot: BotInfo;
}

async function openSession(accountName: string, registry: AccountRegistry, deps: LineOpsDeps): Promise<Session> {
  const accountDef = registry.accounts[accountName];
  if (!accountDef) {
    throw new OpsError('unknown-account', 'resolve-account', `no account named '${accountName}' in registry`);
  }
  if (typeof accountDef.expectedBasicId !== 'string' || accountDef.expectedBasicId.length === 0) {
    throw new OpsError('invalid-registry', 'resolve-account', `account '${accountName}' lacks expectedBasicId`);
  }
  const token = await resolveToken(accountDef, deps);
  const clientFactory = deps.clientFactory ?? ((t: string) => new LineClient(t));
  const client = clientFactory(token);
  const bot = await fetchBotInfo(client, deps);
  const expected = normalizeBasicId(accountDef.expectedBasicId);
  const actual = normalizeBasicId(bot.basicId);
  if (actual !== expected) {
    throw new OpsError(
      'bot-mismatch',
      'verify-account',
      `account '${accountName}' resolved to ${actual}, expected ${expected}`,
    );
  }
  return { account: accountName, accountDef, token, client, bot };
}

function baseOutput(session: Session): Record<string, unknown> {
  return {
    ok: true,
    adapter: ADAPTER_ID,
    account: session.account,
    basicId: normalizeBasicId(session.bot.basicId),
    displayName: session.bot.displayName,
  };
}

async function cmdInfo(session: Session): Promise<Record<string, unknown>> {
  return { ...baseOutput(session), command: 'info' };
}

async function cmdList(session: Session, deps: LineOpsDeps): Promise<Record<string, unknown>> {
  const [{ richmenus }, defaultId] = await Promise.all([
    callApi('list', deps, session.client.getRichMenuList()),
    callApi('get-default', deps, session.client.getDefaultRichMenuId()),
  ]);
  return {
    ...baseOutput(session),
    command: 'richmenu list',
    defaultRichMenuId: defaultId,
    richmenus: richmenus.map((m) => ({ ...m })),
  };
}

async function cmdInspect(
  session: Session,
  deps: LineOpsDeps,
  richMenuId: string,
): Promise<Record<string, unknown>> {
  const [definition, image] = await Promise.all([
    fetchDefinition(session.client, deps, richMenuId),
    fetchImage(session.token, deps, richMenuId),
  ]);
  return {
    ...baseOutput(session),
    command: 'richmenu inspect',
    richMenuId,
    definition: normalizeDefinition(definition),
    image: { sha256: sha256(image), bytes: image.length },
  };
}

interface PlanResult {
  beforeDefaultId: string | null;
  reuseId: string | null;
  plannedMutations: string[];
}

async function buildPlan(session: Session, deps: LineOpsDeps, desired: DesiredMenu): Promise<PlanResult> {
  await callApi('validate', deps, session.client.request('POST', '/v2/bot/richmenu/validate', desired.definition));
  const defaultId = await callApi('get-default', deps, session.client.getDefaultRichMenuId());
  const reuseId = await findReusableMenu(session.client, session.token, deps, desired);
  const mutations: string[] = [];
  if (!reuseId) mutations.push('create-richmenu', 'upload-image');
  const targetId = reuseId ?? '<new>';
  if (defaultId !== targetId) mutations.push('set-default');
  return { beforeDefaultId: defaultId, reuseId, plannedMutations: mutations };
}

async function cmdPlan(session: Session, deps: LineOpsDeps, desired: DesiredMenu): Promise<Record<string, unknown>> {
  const plan = await buildPlan(session, deps, desired);
  return {
    ...baseOutput(session),
    command: 'richmenu plan',
    beforeDefaultId: plan.beforeDefaultId,
    desired: {
      name: desired.definition.name,
      size: desired.definition.size,
      definition: desired.definition,
      definitionSha256: desired.definitionSha256,
      imageSha256: desired.imageSha256,
      imageBytes: desired.image.length,
    },
    reuseId: plan.reuseId,
    plannedMutations: plan.plannedMutations,
    validated: true,
  };
}

function writeReceipt(path: string, receipt: Receipt, first: boolean): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (first) {
    writeFileSync(path, json, { flag: 'wx' });
    return;
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, json);
  renameSync(tmp, path);
}

async function cmdApply(
  session: Session,
  deps: LineOpsDeps,
  desired: DesiredMenu,
  options: Record<string, string>,
): Promise<Record<string, unknown>> {
  const now = deps.now ?? (() => new Date());
  const confirmBasicId = options['--confirm-basic-id'];
  const expectDefaultRaw = options['--expect-default'];
  const receiptPath = options['--receipt'];
  if (!confirmBasicId || !expectDefaultRaw || !receiptPath) {
    throw new OpsError(
      'bad-args',
      'parse-args',
      'apply requires --confirm-basic-id, --expect-default and --receipt',
    );
  }
  const expected = normalizeBasicId(session.accountDef.expectedBasicId);
  const actual = normalizeBasicId(session.bot.basicId);
  const confirmed = normalizeBasicId(confirmBasicId);
  if (confirmed !== expected || confirmed !== actual) {
    throw new OpsError(
      'bot-mismatch',
      'verify-account',
      `--confirm-basic-id ${confirmed} does not match expected ${expected}`,
    );
  }
  const expectDefault = expectDefaultRaw === 'none' ? null : expectDefaultRaw;

  const receipt: Receipt = {
    version: 1,
    adapter: ADAPTER_ID,
    account: session.account,
    basicId: actual,
    startedAt: now().toISOString(),
    updatedAt: now().toISOString(),
    expectDefault: expectDefaultRaw,
    beforeDefaultId: null,
    desired: {
      name: desired.definition.name,
      definitionSha256: desired.definitionSha256,
      imageSha256: desired.imageSha256,
      imageBytes: desired.image.length,
    },
    createdId: null,
    effectiveId: null,
    mutations: [],
    verification: { definitionMatch: false, imageMatch: false, defaultMatch: false },
    ok: false,
  };

  const saveReceipt = (first = false): void => {
    receipt.updatedAt = now().toISOString();
    writeReceipt(receiptPath, receipt, first);
  };
  const failReceipt = (err: OpsError): never => {
    receipt.error = { code: err.code, stage: err.stage, ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}) };
    try {
      saveReceipt(false);
    } catch {
      void 0;
    }
    throw err;
  };
  const checkpoint = (stage: string, detail?: string): void => {
    receipt.mutations.push({ stage, at: now().toISOString(), ...(detail ? { detail } : {}) });
    saveReceipt(false);
  };

  await callApi('validate', deps, session.client.request('POST', '/v2/bot/richmenu/validate', desired.definition));

  const beforeDefault = await callApi('get-default', deps, session.client.getDefaultRichMenuId());
  if (beforeDefault !== expectDefault) {
    throw new OpsError(
      'stale-plan',
      'check-default',
      `default rich menu is ${beforeDefault ?? 'none'}, expected ${expectDefaultRaw}`,
    );
  }
  receipt.beforeDefaultId = beforeDefault;

  if (existsSync(receiptPath)) {
    throw new OpsError('receipt-exists', 'save-receipt', `receipt file already exists: ${receiptPath}`);
  }
  try {
    saveReceipt(true);
  } catch (err) {
    if (err instanceof OpsError) throw err;
    throw new OpsError('receipt-exists', 'save-receipt', `cannot create new receipt file: ${receiptPath}`);
  }

  try {
    let targetId: string;
    const reuseId = await findReusableMenu(session.client, session.token, deps, desired);
    if (reuseId) {
      targetId = reuseId;
      receipt.effectiveId = reuseId;
      checkpoint('reuse-existing', reuseId);
    } else {
      const created = await callApi('create', deps, session.client.createRichMenu(desired.definition));
      receipt.createdId = created.richMenuId;
      receipt.effectiveId = created.richMenuId;
      checkpoint('create', created.richMenuId);
      targetId = created.richMenuId;
      const imageData = desired.image.buffer.slice(
        desired.image.byteOffset,
        desired.image.byteOffset + desired.image.byteLength,
      ) as ArrayBuffer;
      await callApi('upload-image', deps, session.client.uploadRichMenuImage(targetId, imageData, 'image/png'));
      checkpoint('upload-image', targetId);
    }

    const [storedDef, storedImage] = await Promise.all([
      fetchDefinition(session.client, deps, targetId),
      fetchImage(session.token, deps, targetId),
    ]);
    receipt.verification.definitionMatch = isDeepStrictEqual(
      normalizeDefinition(storedDef),
      normalizeDefinition(desired.definition),
    );
    receipt.verification.imageMatch = sha256(storedImage) === desired.imageSha256;
    if (!receipt.verification.definitionMatch || !receipt.verification.imageMatch) {
      throw new OpsError(
        'verify-mismatch',
        'verify-created',
        `stored resource ${targetId} does not match desired definition/image`,
      );
    }
    checkpoint('verify-created', targetId);

    const currentDefault = await callApi('get-default', deps, session.client.getDefaultRichMenuId());
    if (currentDefault !== expectDefault) {
      throw new OpsError(
        'stale-plan',
        'check-default',
        `default changed during apply (${expectDefaultRaw} -> ${currentDefault ?? 'none'})`,
      );
    }

    if (currentDefault !== targetId) {
      await callApi('set-default', deps, session.client.setDefaultRichMenu(targetId));
      checkpoint('set-default', targetId);
    } else {
      checkpoint('set-default-skipped', 'default already equals target');
    }

    const [finalDefault, finalDef, finalImage] = await Promise.all([
      callApi('get-default', deps, session.client.getDefaultRichMenuId()),
      fetchDefinition(session.client, deps, targetId),
      fetchImage(session.token, deps, targetId),
    ]);
    receipt.verification.defaultMatch = finalDefault === targetId;
    receipt.verification.definitionMatch =
      receipt.verification.definitionMatch &&
      isDeepStrictEqual(normalizeDefinition(finalDef), normalizeDefinition(desired.definition));
    receipt.verification.imageMatch =
      receipt.verification.imageMatch && sha256(finalImage) === desired.imageSha256;
    const allOk =
      receipt.verification.defaultMatch &&
      receipt.verification.definitionMatch &&
      receipt.verification.imageMatch;
    if (!allOk) {
      throw new OpsError(
        'verify-mismatch',
        'read-back',
        `read-back verification failed for ${targetId}`,
      );
    }
    receipt.ok = true;
    saveReceipt(false);

    return {
      ...baseOutput(session),
      command: 'richmenu apply',
      beforeDefaultId: receipt.beforeDefaultId,
      createdId: receipt.createdId,
      effectiveId: receipt.effectiveId,
      mutations: receipt.mutations,
      verification: receipt.verification,
      receipt: receiptPath,
    };
  } catch (err) {
    failReceipt(err instanceof OpsError ? err : apiError('apply', err));
  }
}

export interface CliResult {
  code: number;
  result: unknown;
}

export async function runCli(argv: string[], deps: LineOpsDeps = {}): Promise<CliResult> {
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) {
      return { code: 0, result: { ok: true, adapter: ADAPTER_ID, usage: USAGE } };
    }
    const command = parsed.positionals.join(' ');
    if (!COMMANDS.has(command)) {
      throw new OpsError('bad-args', 'parse-args', `unknown command: '${command || '(none)'}'`);
    }
    const accountName = parsed.options['--account'];
    if (!accountName) {
      throw new OpsError('bad-args', 'parse-args', '--account NAME is required (no default account)');
    }
    const registryPath = parsed.options['--registry'] ?? defaultRegistryPath();
    const registry = loadRegistry(registryPath);

    let desired: DesiredMenu | null = null;
    if (command === 'richmenu plan' || command === 'richmenu apply') {
      const defPath = parsed.options['--definition'];
      const imgPath = parsed.options['--image'];
      if (!defPath || !imgPath) {
        throw new OpsError('bad-args', 'parse-args', `${command} requires --definition and --image`);
      }
      desired = loadDesired(defPath, imgPath);
      if (command === 'richmenu apply') {
        for (const flag of ['--confirm-basic-id', '--expect-default', '--receipt']) {
          if (!parsed.options[flag]) {
            throw new OpsError('bad-args', 'parse-args', `apply requires ${flag}`);
          }
        }
      }
    }
    if (command === 'richmenu inspect' && !parsed.options['--id']) {
      throw new OpsError('bad-args', 'parse-args', 'inspect requires --id');
    }

    const session = await openSession(accountName, registry, deps);

    switch (command) {
      case 'info':
        return { code: 0, result: await cmdInfo(session) };
      case 'richmenu list':
        return { code: 0, result: await cmdList(session, deps) };
      case 'richmenu inspect':
        return { code: 0, result: await cmdInspect(session, deps, parsed.options['--id']!) };
      case 'richmenu plan':
        return { code: 0, result: await cmdPlan(session, deps, desired!) };
      case 'richmenu apply':
        return { code: 0, result: await cmdApply(session, deps, desired!, parsed.options) };
      default:
        throw new OpsError('bad-args', 'parse-args', `unhandled command: ${command}`);
    }
  } catch (err) {
    return errResult(err);
  }
}

const invokedAsScript = ((): boolean => {
  try {
    return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  runCli(process.argv.slice(2))
    .then(({ code, result }) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = code;
    })
    .catch(() => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, adapter: ADAPTER_ID, error: { code: 'internal', stage: 'unknown', message: 'unexpected internal error' } })}\n`,
      );
      process.exitCode = 1;
    });
}
