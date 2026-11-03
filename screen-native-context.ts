/** Native BB identity and immutable per-thread company pin. Never writes platform.json. */
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { PluginBbSdk, PluginKvStorage } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import type { ScreenContext } from './screen-transport';
import { validatePersistentFolder } from './experiments/account-prototype/folder-selection';

export type VerifiedScreenCompany = { account_id: string; company_id: string; subject_id: string; epoch: number };
export interface ScreenAccountPort {
  epoch(): number;
  verifiedCompany(companyId: string, signal?: AbortSignal): Promise<VerifiedScreenCompany>;
  callMcpForContext(request: { name: string; arguments: Record<string, unknown> },
    expectedContext: VerifiedScreenCompany, signal?: AbortSignal): Promise<unknown>;
}

export class ScreenContextError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ScreenContextError'; }
}
const id = z.string().min(1).max(256);
const companyId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const pinSchema = z.object({ schema: z.literal(1), state: z.enum(['pinned', 'blocked']),
  thread_id: id, environment_id: id, host_id: id, real_root: z.string().refine(isAbsolute),
  company_id: companyId, account_id: id, subject_id: id,
  source_thread_id: id.nullable(), parent_thread_id: id.nullable(),
}).strict();
type Pin = z.infer<typeof pinSchema>;
const key = (threadId: string) => 'screen:context:' + threadId;
const freshChat = () => new ScreenContextError('new_clean_thread_required',
  'Контекст этого разговора нельзя безопасно перепривязать. Открой новый чистый чат в нужной рабочей папке.');

function parseBinding(raw: string): string {
  // The canonical file is a flat two-key object. Token checks also reject duplicate keys
  // and non-integer schema_version spellings, matching the Python onboarding writer.
  const shape = z.object({ schema_version: z.literal(1), company_id: companyId }).strict();
  const value = shape.safeParse(JSON.parse(raw));
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g);
  if (!value.success || !tokens || tokens.length !== 9 || tokens[0] !== '{' || tokens[8] !== '}' ||
    tokens[2] !== ':' || tokens[4] !== ',' || tokens[6] !== ':') throw new Error('invalid binding');
  const keys = [JSON.parse(tokens[1]), JSON.parse(tokens[5])];
  if (new Set(keys).size !== 2 || !keys.includes('schema_version') || !keys.includes('company_id') ||
    tokens[keys[0] === 'schema_version' ? 3 : 7] !== '1') throw new Error('invalid binding');
  return value.data.company_id;
}

export async function readScreenCompanyBinding(environmentPath: string): Promise<{ realRoot: string; companyId: string }> {
  return readCompanyBinding(environmentPath, false) as Promise<{ realRoot: string; companyId: string }>;
}

async function readCompanyBinding(environmentPath: string, allowUnbound: boolean): Promise<{ realRoot: string; companyId: string | null }> {
  if (!isAbsolute(environmentPath) || !(await stat(environmentPath)).isDirectory())
    throw new ScreenContextError('workspace_root_invalid', 'BB не предоставил доступную рабочую папку.');
  let current = environmentPath;
  for (;;) {
    let marker;
    try { marker = await lstat(join(current, '.svaib')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (marker) {
      // First boundary wins, even if broken. Never fall through to a parent company.
      if (marker.isSymbolicLink() || !marker.isDirectory())
        throw new ScreenContextError('workspace_binding_invalid', 'Ближайшая .svaib повреждена. Исправь привязку через онбординг; родительская компания не подставляется.');
      let file;
      try {
        const path = join(current, '.svaib', 'platform.json');
        let before;
        try { before = await lstat(path); } catch (error) {
          if (allowUnbound && (error as NodeJS.ErrnoException).code === 'ENOENT')
            return { realRoot: await realpath(current), companyId: null };
          throw error;
        }
        if (!before.isFile() || before.isSymbolicLink() || before.size > 4096) throw new Error('invalid file');
        file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const opened = await file.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('changed file');
        const raw = await file.readFile();
        if (raw.byteLength > 4096) throw new Error('invalid file');
        const company = parseBinding(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        return { realRoot: await realpath(current), companyId: company };
      } catch {
        throw new ScreenContextError('workspace_binding_invalid', 'В ближайшей .svaib нет корректного platform.json. Попроси партнёра завершить выбор компании через онбординг.');
      } finally { await file?.close(); }
    }
    const parent = dirname(current);
    if (parent === current) {
      if (allowUnbound) return { realRoot: await realpath(environmentPath), companyId: null };
      throw new ScreenContextError('workspace_binding_missing',
      'Рабочая папка ещё не связана с компанией. Попроси партнёра продолжить онбординг и записать привязку штатным помощником.');
    }
    current = parent;
  }
}

export type PersistentRootValidator = (path: string, hostId: string,
  environment: Awaited<ReturnType<PluginBbSdk['environments']['get']>>) => Promise<string>;
type ContextOptions = { sdk: PluginBbSdk; kv: PluginKvStorage; account: ScreenAccountPort;
  /** Test-only injection; production uses the shared persistent-folder validator. */
  validatePersistentRootForTesting?: PersistentRootValidator };

/** The plugin server and UI use one backend OAuth grant.
 * First use may select an actual company before scaffold files exist. Later use is pinned. */
export function createScreenPluginContext(options: ContextOptions) {
  const queues = new Map<string, Promise<unknown>>();
  async function stored(threadId: string): Promise<Pin | undefined> {
    const value = await options.kv.get<unknown>(key(threadId));
    if (value === undefined) return;
    const parsed = pinSchema.safeParse(value);
    if (!parsed.success || parsed.data.thread_id !== threadId) throw freshChat();
    return parsed.data;
  }
  async function native(threadId: string) {
    const thread = await options.sdk.threads.get({ threadId });
    if (thread.id !== threadId || thread.deletedAt || !thread.environmentId) throw new ScreenContextError('thread_unavailable', 'Разговору нужна действующая рабочая среда BB.');
    const [environment, system, project] = await Promise.all([
      options.sdk.environments.get({ environmentId: thread.environmentId }), options.sdk.system.config(),
      options.sdk.projects.get({ projectId: thread.projectId }),
    ]);
    if (environment.id !== thread.environmentId || environment.status !== 'ready')
      throw new ScreenContextError('workspace_unavailable', 'Рабочая среда BB ещё не готова. Повтори после её запуска.');
    const chooseFolder = () => new ScreenContextError('workspace_selection_required', 'Для материалов организации нужна постоянная папка. Открой новый разговор BB и выбери Project → New project или существующий проект, затем отправь подготовленное продолжение svaib. Файлы пока не меняются.');
    if (environment.workspaceProvisionType !== 'unmanaged' || project.kind !== 'standard' || project.id !== thread.projectId ||
        environment.projectId !== thread.projectId || !environment.path) throw chooseFolder();
    if (!system.primaryHostId || environment.hostId !== system.primaryHostId)
      throw new ScreenContextError('remote_host_unsupported', 'Этот Screen-кандидат работает на основном локальном компьютере BB. Удалённое рабочее место пока не подключено.');
    let selectedRoot: string;
    try {
      selectedRoot = await (options.validatePersistentRootForTesting
        ? options.validatePersistentRootForTesting(environment.path, environment.hostId, environment)
        : validatePersistentFolder(options.sdk, environment.hostId, environment, environment.path));
    } catch { throw chooseFolder(); }
    if (selectedRoot !== environment.path || !project.sources.some(source => source.type === 'local_path' && source.hostId === environment.hostId &&
      source.projectId === project.id && source.path === selectedRoot)) throw chooseFolder();
    const binding = await readCompanyBinding(environment.path, true);
    if (binding.realRoot !== selectedRoot) throw chooseFolder();
    return { thread, environment, binding };
  }
  async function resolveUnlocked(threadId: string, signal: AbortSignal, selector?: string) {
    if (!/^thr_[a-z0-9]+$/.test(threadId)) throw new ScreenContextError('invalid_thread', 'Неизвестный разговор BB.');
    signal.throwIfAborted();
    const previous = await stored(threadId);
    if (previous?.state === 'blocked') throw freshChat();
    const live = await native(threadId);
    signal.throwIfAborted();
    if (selector !== undefined && !companyId.safeParse(selector).success)
      throw new ScreenContextError('invalid_company', 'Выбери действительную компанию svaib.');
    const selectedCompany = live.binding.companyId ?? previous?.company_id ?? selector;
    if (!selectedCompany) throw new ScreenContextError('company_required', 'Сначала выбери или создай компанию в svaib и передай её ID при открытии Screen.');
    if (selector !== undefined && selector !== selectedCompany) {
      if (previous) await options.kv.set(key(threadId), { ...previous, state: 'blocked' });
      throw freshChat();
    }
    const verified = await options.account.verifiedCompany(selectedCompany, signal);
    signal.throwIfAborted();
    if (!verified.account_id.startsWith('acct_') || !verified.subject_id ||
      verified.company_id !== selectedCompany || verified.epoch !== options.account.epoch())
      throw new ScreenContextError('account_mismatch', 'Кабинет BB не подтвердил доступ к выбранной компании. Проверь подключение с партнёром.');
    const candidate: Pin = { schema: 1, state: 'pinned', thread_id: threadId,
      environment_id: live.environment.id, host_id: live.environment.hostId, real_root: live.binding.realRoot,
      company_id: verified.company_id, account_id: verified.account_id, subject_id: verified.subject_id,
      source_thread_id: live.thread.sourceThreadId, parent_thread_id: live.thread.parentThreadId };
    if (previous && JSON.stringify(previous) !== JSON.stringify(candidate)) {
      await options.kv.set(key(threadId), { ...previous, state: 'blocked' }); throw freshChat();
    }
    if (!previous) {
      const lineage = [...new Set([live.thread.sourceThreadId].filter((v): v is string => !!v))];
      if (lineage.length) {
        for (const parentId of lineage) {
          const parent = await stored(parentId);
          if (!parent || parent.state !== 'pinned' || parent.thread_id === threadId ||
            parent.real_root !== candidate.real_root || parent.host_id !== candidate.host_id ||
            parent.company_id !== candidate.company_id || parent.account_id !== candidate.account_id ||
            parent.subject_id !== candidate.subject_id) throw freshChat();
        }
      }
      if (!live.thread.sourceThreadId && live.thread.originKind === 'fork') {
        // A mutable parent/group link cannot prove the origin of old history.
        // Unknown old history is not evidence of a clean chat. No transcript parsing or metadata trust.
        const history = await options.sdk.threads.events.list({ threadId,
          types: ['turn/completed', 'thread/compacted'], order: 'desc', limit: '1' });
        if (history.length || live.thread.originKind === 'fork') throw freshChat();
      }
    }
    // Fence folder/native changes that occurred while reading proof or contacting the gateway.
    const after = await native(threadId);
    if (after.environment.id !== candidate.environment_id || after.environment.hostId !== candidate.host_id ||
      after.binding.realRoot !== candidate.real_root ||
      (after.binding.companyId !== null && after.binding.companyId !== candidate.company_id) ||
      after.thread.sourceThreadId !== candidate.source_thread_id || after.thread.parentThreadId !== candidate.parent_thread_id ||
      verified.epoch !== options.account.epoch()) {
      if (previous) await options.kv.set(key(threadId), { ...previous, state: 'blocked' });
      throw freshChat();
    }
    signal.throwIfAborted();
    if (!previous) await options.kv.set(key(threadId), candidate);
    signal.throwIfAborted();
    return { context: { account_id: candidate.account_id, company_id: candidate.company_id,
      subject_id: candidate.subject_id, thread_id: candidate.thread_id, environment_id: candidate.environment_id,
      host_id: candidate.host_id } satisfies ScreenContext, realRoot: candidate.real_root, epoch: verified.epoch };
  }
  return { async resolve(threadId: string, signal = new AbortController().signal, companyId?: string) {
    const pending = (queues.get(threadId) ?? Promise.resolve()).catch(() => {}).then(() => resolveUnlocked(threadId, signal, companyId));
    queues.set(threadId, pending);
    try { return await pending; } finally { if (queues.get(threadId) === pending) queues.delete(threadId); }
  } };
}
