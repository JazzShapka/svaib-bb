import { defineRpcContract, type BbPluginApi, type PluginAgentConfiguration, type PluginAgentConfigurationContext } from '@get-bb/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import { idSchema, screenSchema, submitSchema, updateSchema, confirmScaffoldSchema } from 'bb-plugin-svaib-screen-pilot/model';
import { createScreenBackend, screenSnapshotSchema, screenEventsSchema, ScreenTransportError,
  type ScreenContext, type ScreenBackendPort, type Snapshot } from './screen-transport';
import { createScreenPluginContext, ScreenContextError, type ScreenAccountPort, type PersistentRootValidator } from './screen-native-context';
import { scaffoldConfirmationSchema, scaffoldConfigSchema } from 'bb-plugin-svaib-screen-pilot/scaffold';
import { spaceSetupDocument } from 'bb-plugin-svaib-screen-pilot/agent-session';
import { importScaffold, verifyScaffoldSnapshot, ScaffoldImportError } from './scaffold-import';

const threadIdSchema = z.string().regex(/^thr_[a-z0-9]+$/);
const select = z.object({ threadId: threadIdSchema, screenId: idSchema }).strict();
const pollId = z.string().uuid();
const errorSchema = z.object({ code: z.string(), message: z.string() }).strict();
const reply = <T extends z.ZodType>(value: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value }).strict(), z.object({ ok: z.literal(false), error: errorSchema }).strict(),
]);
const freshness = { capturedAt: z.string().nullable().optional(), source: z.enum(['matches', 'changed', 'unverified']).optional(), refreshSuggested: z.boolean().optional() };
// The canonical schemas are also Standard Schema compatible across package-local Zod copies.
export const screenRpcContract = defineRpcContract({
  'screen.binding': { input: z.object({ threadId: threadIdSchema }).strict(), output: reply(z.object({ screenId: idSchema.nullable() }).strict()) },
  'screen.openCompany': { input: z.object({ threadId: threadIdSchema, companyId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), companyName: z.string().min(1).max(2000), screenId: idSchema.optional() }).strict(),
    output: reply(z.union([z.object({ screenId: idSchema, revision: z.number(), cursor: z.number(), presentation: z.enum(['tab-opened', 'not-opened']), message: z.string(), ...freshness }).strict(),
      z.object({ choices: z.array(z.object({ id: idSchema, title: z.string(), updatedAt: z.string(), kind: z.enum(['overview', 'scaffold']) }).strict()).min(2).max(100) }).strict()])) },
  'screen.get': { input: select, output: reply(screenSnapshotSchema) },
  'screen.submit': { input: select.extend({ mutation: submitSchema }), output: reply(z.object({ screen: screenSchema }).strict()) },
  'screen.update': { input: select.extend({ mutation: updateSchema }), output: reply(z.object({ screen: screenSchema }).strict()) },
  'screen.confirm': { input: select.extend({ mutation: confirmScaffoldSchema }), output: reply(z.object({ screen: screenSchema }).strict()) },
  'screen.events': { input: select.extend({ pollId, after: z.number().int().nonnegative(), timeoutMs: z.number().int().min(0).max(10000) }), output: reply(screenEventsSchema) },
  'screen.cancel': { input: select.extend({ pollId }), output: z.null() },
  'screen.presentation': { input: z.object({ threadId: threadIdSchema }).strict(), output: z.object({ requestId: z.string().uuid().nullable() }).strict() },
  'screen.presented': { input: z.object({ threadId: threadIdSchema, requestId: z.string().uuid(), opened: z.boolean() }).strict(), output: z.null() },
});
const storedBinding = z.object({ schema: z.literal(1), screen_id: idSchema, context: z.object({
  account_id: z.string(), company_id: z.string(), subject_id: z.string(), thread_id: threadIdSchema,
  environment_id: z.string(), host_id: z.string(),
}).strict(), real_root: z.string() }).strict();
const bindingKey = (threadId: string) => 'screen:binding:' + threadId;
const OPEN_TOOL = 'svaib_screen_open';
const EXISTING_TOOL = 'svaib_screen_existing';
const OVERVIEW_TOOL = 'svaib_screen_overview';
const BIND_TOOL = 'svaib_screen_bind';
const RESULT_TOOL = 'svaib_screen_result';
const PREVIOUS_TOOL = 'svaib_screen_previous';
const selectionSchema = z.object({
  screenId: idSchema, companyId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  mode: z.literal('company').optional(), // accepted for older company callers; never a local fallback
}).strict();
const resultSchema = z.object({ id: idSchema, revision: z.number().int().positive(), cursor: z.number().int().positive(),
  companyId: z.string(), status: z.enum(['pending', 'submitted', 'confirmed']), browserUrl: z.string().url().nullable(),
  catalogVersion: z.string().optional(), canonSnapshot: z.string().optional(), applicationStatus: z.literal('not-tracked'),
  screen: screenSchema, intent: scaffoldConfigSchema.nullable(), submission: screenSchema.shape.submission,
  confirmation: scaffoldConfirmationSchema.nullable(),
}).strict();
const messages: Record<string, string> = {
  permission_denied: 'Нет доступа к Screen выбранной компании. Проверь подключение с партнёром.',
  company_required: 'Сначала выбери компанию через онбординг.',
  context_changed: 'Контекст разговора изменился. Открой новый чистый чат в нужной папке.',
  feature_disabled: 'Серверный Screen пока не включён в этом контуре.',
  not_found: 'Этот Screen не найден в выбранной компании.',
  revision_conflict: 'Экран уже изменился. Обнови его и повтори действие.',
  cursor_expired: 'История событий обновилась; восстанавливаю экран.',
};
function knownError(error: unknown) {
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))
    return { code: error.name === 'AbortError' ? 'aborted' : 'timeout', message: 'Ожидание Screen остановлено.' };
  if (error instanceof ScreenContextError) return { code: error.code, message: error.message };
  if (error instanceof ScaffoldImportError) return { code: error.code, message: error.message };
  if (error instanceof ScreenTransportError) return { code: error.code, message: messages[error.code] ?? 'Screen отклонил запрос. Обнови экран или проверь подключение с партнёром.' };
  const accountCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (['authentication_required', 'resource_mismatch', 'company_context_unavailable', 'context_changed', 'invalid_arguments', 'mcp_unavailable', 'mcp_protocol_error'].includes(accountCode))
    return { code: accountCode, message: messages[accountCode] ?? 'Подключение svaib не подтвердило доступ. Проверь вход в кабинет и выбранную компанию с партнёром.' };
  return { code: 'screen_unavailable', message: 'Не удалось связаться со Screen. Проверь подключение с партнёром и повтори.' };
}

/** Register once from the root factory. Server MCP calls and UI share one backend OAuth grant. */
export function registerScreenModule(bb: BbPluginApi, options: { account: ScreenAccountPort; presentationTimeoutMs?: number;
  /** Test-only injection; production uses the shared persistent-folder validator. */
  validatePersistentRootForTesting?: PersistentRootValidator }) {
  const native = createScreenPluginContext({ sdk: bb.sdk, kv: bb.storage.kv, account: options.account,
    validatePersistentRootForTesting: options.validatePersistentRootForTesting });
  const lifetime = new AbortController();
  const requestSignal = (signal?: AbortSignal) => AbortSignal.any([lifetime.signal, AbortSignal.timeout(25000), ...(signal ? [signal] : [])]);
  const polls = new Map<string, AbortController>();
  const canceled = new Map<string, number>();
  const presentations = new Map<string, { requestId: string; finish: (opened: boolean) => void }>();
  async function present(threadId: string, signal: AbortSignal) {
    presentations.get(threadId)?.finish(false);
    const requestId = randomUUID();
    return new Promise<boolean>(resolve => {
      const finish = (opened: boolean) => {
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (presentations.get(threadId)?.requestId === requestId) presentations.delete(threadId);
        resolve(opened);
      };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(false), options.presentationTimeoutMs ?? 3500);
      presentations.set(threadId, { requestId, finish });
      if (signal.aborted) { finish(false); return; }
      signal.addEventListener('abort', abort, { once: true });
      bb.realtime.publish('screen-open-requested', { threadId, requestId });
    });
  }
  const pollKey = (input: { threadId: string; screenId: string; pollId: string }) => `${input.threadId}:${input.screenId}:${input.pollId}`;
  function prune() { const now = Date.now(); for (const [key, expiry] of canceled) if (expiry < now) canceled.delete(key); }
  async function respond<T>(run: () => Promise<T>) {
    try { return { ok: true as const, value: await run() }; }
    catch (error) { return { ok: false as const, error: knownError(error) }; }
  }
  async function backend(threadId: string, screenId: string, signal: AbortSignal): Promise<ReturnType<typeof createScreenBackend>> {
    const live = await native.resolve(threadId, signal);
    const stored = storedBinding.safeParse(await bb.storage.kv.get(bindingKey(threadId)));
    if (!stored.success || stored.data.screen_id !== screenId || stored.data.real_root !== live.realRoot ||
      JSON.stringify(stored.data.context) !== JSON.stringify(live.context))
      throw new ScreenContextError('screen_binding_required', 'Попроси партнёра открыть или привязать Screen в этом разговоре.');
    return createScreenBackend({ binding: { ...live.context, screen_id: screenId },
      readTrustedContext: async active => {
        const checked = await native.resolve(threadId, active);
        if (checked.epoch !== live.epoch || checked.realRoot !== live.realRoot) throw new ScreenTransportError('context_changed');
        return checked.context;
      },
      callMcp: (request, call) => options.account.callMcpForContext(request,
        { ...call.expectedContext, epoch: live.epoch }, call.signal),
    });
  }
  async function useBackend<T>(input: { threadId: string; screenId: string }, run: (port: ScreenBackendPort, signal: AbortSignal) => Promise<T>, signal = requestSignal()) {
    const port = await backend(input.threadId, input.screenId, signal);
    try { return await run(port, signal); } finally { port.dispose(); }
  }
  async function verifyOverviewSource(snapshot: Snapshot, live: Awaited<ReturnType<typeof native.resolve>>, screenId: string, active: AbortSignal) {
    const blocks = snapshot.screen.document.blocks;
    const config = blocks.length === 1 && blocks[0].type === 'scaffold' && blocks[0].config.schemaVersion === 2 ? blocks[0].config : null;
    if (!config?.overview) return undefined;
    const source = z.object({ schema: z.literal(1), root: z.string(), hash: z.string() }).strict().safeParse(
      await bb.storage.kv.get(`screen:overview:${live.context.company_id}:${screenId}`));
    if (!source.success || source.data.root !== live.realRoot || source.data.hash !== config.overview.sourceHash)
      return 'unverified' as const;
    const current = await importScaffold(live.realRoot, { companyName: config.companyName,
      limits: { maxDepth: config.overview.maxDepth }, allowDepthBoundary: true, signal: active });
    return current.snapshot.hash === source.data.hash ? 'matches' as const : 'changed' as const;
  }
  async function bind(threadId: string, screenId: string, active = requestSignal(), companyId?: string, restoreCompanyName?: string) {
    const live = await native.resolve(threadId, active, companyId);
    const port = createScreenBackend({ binding: { ...live.context, screen_id: screenId },
      readTrustedContext: async signal => { const checked = await native.resolve(threadId, signal);
        if (checked.epoch !== live.epoch || checked.realRoot !== live.realRoot) throw new ScreenTransportError('context_changed');
        return checked.context; },
      callMcp: (request, call) => options.account.callMcpForContext(request, { ...call.expectedContext, epoch: live.epoch }, call.signal) });
    try {
      let snapshot = await port.get(active); // Shared /mcp must authorize the actual company and screen first.
      // A requested constructor may have been explicitly cleared. Restore only
      // that empty view for its owner, preserving its ID and CAS boundary.
      if (restoreCompanyName && snapshot.screen.canEdit === true && snapshot.screen.document.blocks.length === 0) {
        if (await hasExistingContent(live.realRoot)) {
          await saveOverview(threadId, { screenId, companyId: live.context.company_id,
            requestId: randomUUID(), companyName: restoreCompanyName, expectedRevision: snapshot.screen.revision }, active);
        } else {
          await remote(live, 'screen_update', { id: screenId, requestId: randomUUID(),
            expectedRevision: snapshot.screen.revision, document: spaceSetupDocument(restoreCompanyName) }, active);
        }
        snapshot = await port.get(active);
      }
      const source = await verifyOverviewSource(snapshot, live, screenId, active);
      const block = snapshot.screen.document.blocks[0];
      const capturedAt = block?.type === 'scaffold' && block.config.schemaVersion === 2 ? block.config.overview?.capturedAt ?? null : null;
      const refreshSuggested = source !== undefined && (source !== 'matches' || !capturedAt || Date.now() - Date.parse(capturedAt) > 24 * 60 * 60 * 1000);
      if (JSON.stringify(await native.resolve(threadId, active)) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
      await bb.storage.kv.set(bindingKey(threadId), { schema: 1, screen_id: screenId, context: live.context, real_root: live.realRoot });
      if (JSON.stringify(await native.resolve(threadId, active)) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
      bb.realtime.publish('screen-changed', { threadId, screenId });
      const opened = await present(threadId, active);
      return { screenId, revision: snapshot.screen.revision, cursor: snapshot.cursor,
        ...(source !== undefined ? { source, capturedAt, refreshSuggested } : {}),
        presentation: opened ? 'tab-opened' as const : 'not-opened' as const,
        message: opened ? 'BB открыл вкладку Screen. Дождись загрузки и попроси пользователя проверить структуру.'
          : 'Screen подготовлен, но открытие вкладки BB не подтверждено. Не утверждай, что пользователь её видит; попроси открыть «Конструктор» в этом разговоре.' };
    } finally { port.dispose(); }
  }
  async function openScreen(threadId: string, screenId: string, companyId: string | undefined, create: { requestId: string; companyName: string; onlyIfEmpty?: boolean } | undefined, active: AbortSignal) {
    const live = await native.resolve(threadId, active, companyId);
    const result = await options.account.callMcpForContext({ name: 'screen_open', arguments: {
      id: screenId, preset: 'space-setup', company_id: live.context.company_id, ...(create ? { create } : {}),
    } }, { ...live.context, epoch: live.epoch }, active);
    const parsed = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(result);
    if (parsed.isError) {
      const reason = z.object({ reason: z.string() }).safeParse(parsed.structuredContent);
      throw new ScreenTransportError(reason.success ? reason.data.reason : 'mcp_error');
    }
    const after = await native.resolve(threadId, active);
    if (JSON.stringify(after) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
    return bind(threadId, screenId, active);
  }
  async function remote(live: Awaited<ReturnType<typeof native.resolve>>, name: string, args: Record<string, unknown>, active: AbortSignal) {
    if (JSON.stringify(await native.resolve(live.context.thread_id, active)) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
    const raw = await options.account.callMcpForContext({ name, arguments: { ...args, company_id: live.context.company_id } }, { ...live.context, epoch: live.epoch }, active);
    const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(raw);
    if (envelope.isError) { const reason = z.object({ reason: z.string() }).safeParse(envelope.structuredContent); throw new ScreenTransportError(reason.success ? reason.data.reason : 'mcp_error'); }
    if (JSON.stringify(await native.resolve(live.context.thread_id, active)) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
    return envelope.structuredContent;
  }
  async function saveOverview(threadId: string, input: { screenId: string; companyId?: string; requestId: string; companyName?: string; roles?: Record<string, {role: 'unit'|'aspect'|'kit'|'infrastructure'|'workspace'; source: string}>; expectedRevision?: number; onlyIfEmpty?: boolean }, active: AbortSignal) {
    const live = await native.resolve(threadId, active, input.companyId);
    const capability = await remote(live, 'screen_catalog', {}, active) as Record<string, unknown>;
    if (capability.overviewVersion !== 1 || (input.expectedRevision !== undefined && capability.overviewRefreshVersion !== 1))
      throw new ScreenContextError('overview_unsupported', 'Сервер ещё не поддерживает обновление обзора. Сохранённый Screen оставлен на месте.');
    const previous = input.expectedRevision === undefined ? undefined : screenSnapshotSchema.parse(await remote(live, 'screen_get', {id: input.screenId}, active)).screen;
    if (previous && previous.revision !== input.expectedRevision) throw new ScreenTransportError('revision_conflict');
    const oldBlock = previous?.document.blocks[0];
    if (previous && previous.document.blocks.length > 0 && (previous.document.blocks.length !== 1 || oldBlock?.type !== 'scaffold')) throw new ScreenContextError('wrong_screen_kind', 'Обновлять из папки можно только конструктор каркаса.');
    const previousConfig = oldBlock?.type === 'scaffold' && oldBlock.config.schemaVersion === 2 ? oldBlock.config : undefined;
    const companyName = input.companyName ?? previousConfig?.companyName;
    if (!companyName) throw new ScreenContextError('wrong_screen_kind', 'Этот экран не является конструктором каркаса.');
    const imported = await importScaffold(live.realRoot, { companyName, roles: input.roles, previousConfig, limits: {maxDepth: 1}, allowDepthBoundary: true, signal: active });
    await verifyScaffoldSnapshot(live.realRoot, imported.snapshot, active);
    imported.scaffoldConfig.overview!.capturedAt = new Date().toISOString();
    const document = { schemaVersion: 1, title: previous?.document.title ?? 'Существующее пространство — обзор',
      description: 'Ограниченный снимок папки. Нераскрытые ветки сохранены; файлы пространства не изменяются.', layout: 'stack',
      blocks: [{ id: oldBlock?.id ?? 'space-setup', type: 'scaffold', version: 1, title: 'Фактические папки и файлы', config: imported.scaffoldConfig }] };
    await remote(live, previous ? 'screen_update' : 'screen_create', { id: input.screenId, requestId: input.requestId, document,
      ...(previous ? { expectedRevision: input.expectedRevision, refreshOverview: true } : input.onlyIfEmpty ? { onlyIfEmpty: true } : {}) }, active);
    await bb.storage.kv.set(`screen:overview:${live.context.company_id}:${input.screenId}`, {schema: 1, root: live.realRoot, hash: imported.snapshot.hash});
    bb.realtime.publish('screen-changed', {threadId, screenId: input.screenId});
    return { imported, live };
  }
  async function hasExistingContent(root: string): Promise<boolean> {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name !== '.svaib' || !entry.isDirectory() || entry.isSymbolicLink()) return true;
      const metadata = await readdir(`${root}/.svaib`, { withFileTypes: true });
      if (metadata.some(item => item.name !== 'platform.json' || !item.isFile() || item.isSymbolicLink())) return true;
    }
    return false;
  }
  const openCompany = (input: { threadId: string; companyId: string; companyName: string; screenId?: string }, signal?: AbortSignal) => respond(async () => {
      const active = requestSignal(signal);
      const live = await native.resolve(input.threadId, active, input.companyId);
      async function remote(name: string, args: Record<string, unknown>) {
        const raw = await options.account.callMcpForContext({ name, arguments: { ...args, company_id: live.context.company_id } }, { ...live.context, epoch: live.epoch }, active);
        const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(raw);
        if (envelope.isError) { const reason = z.object({ reason: z.string() }).safeParse(envelope.structuredContent); throw new ScreenTransportError(reason.success ? reason.data.reason : 'mcp_error'); }
        if (JSON.stringify(await native.resolve(input.threadId, active)) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
        return envelope.structuredContent;
      }
      const catalog = z.object({ screenDiscoveryVersion: z.number().int().min(2) }).passthrough().safeParse(await remote('screen_catalog', {}));
      if (!catalog.success) throw new ScreenContextError('screen_discovery_unsupported', 'Сервер ещё не поддерживает поиск конструкторов компании. Обнови серверный Screen; новый экран автоматически не создаётся.');
      const discoverySchema = z.object({ complete: z.boolean(), screens: z.array(z.object({ id: idSchema, title: z.string().min(1).max(2000), updatedAt: z.string().max(100), kind: z.enum(['overview', 'scaffold']) }).strict()).max(100) }).strict();
      async function choose(allowCreate: boolean): Promise<Awaited<ReturnType<typeof openScreen>> | { choices: z.infer<typeof discoverySchema>['screens'] }> {
        const found = discoverySchema.parse(await remote('screen_get', { discover: true, component: 'scaffold' }));
        if (!found.complete) throw new ScreenContextError('screen_discovery_incomplete', 'Список конструкторов получен не полностью; создание и автоматический выбор остановлены.');
        if (input.screenId) {
          if (!found.screens.some(item => item.id === input.screenId)) throw new ScreenContextError('screen_choice_stale', 'Выбранный конструктор больше не доступен. Обнови список.');
          return bind(input.threadId, input.screenId, active, input.companyId, input.companyName);
        }
        if (found.screens.length === 1) return bind(input.threadId, found.screens[0].id, active, input.companyId, input.companyName);
        if (found.screens.length > 1) return { choices: found.screens };
        if (!allowCreate) throw new ScreenContextError('screen_discovery_changed', 'Список конструкторов изменился. Повтори открытие.');
        const existing = await hasExistingContent(live.realRoot);
        if (JSON.stringify(await native.resolve(input.threadId, active)) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
        const screenId = 'scaffold-' + randomUUID();
        try {
          if (existing) {
            await saveOverview(input.threadId, { screenId, companyId: input.companyId,
              requestId: randomUUID(), companyName: input.companyName, onlyIfEmpty: true }, active);
            return bind(input.threadId, screenId, active, input.companyId);
          }
          return await openScreen(input.threadId, screenId, input.companyId,
            { requestId: randomUUID(), companyName: input.companyName, onlyIfEmpty: true }, active);
        }
        catch (error) {
          if (error instanceof ScreenTransportError && ['screen_discovery_changed', 'already_exists'].includes(error.code)) return choose(false);
          throw error;
        }
      }
      return choose(true);
  });
  bb.rpc.register(screenRpcContract, {
    'screen.openCompany': input => openCompany(input),
    'screen.binding': input => respond(async () => {
      const active = requestSignal();
      const value = await bb.storage.kv.get(bindingKey(input.threadId));
      if (value === undefined) return { screenId: null };
      const parsed = storedBinding.safeParse(value);
      if (!parsed.success) throw new ScreenTransportError('invalid_binding');
      // Read the screen as well: a stale UI binding never becomes authorization.
      const snapshot = await useBackend({ threadId: input.threadId, screenId: parsed.data.screen_id }, port => port.get(active), active);
      const live = await native.resolve(input.threadId, active);
      await verifyOverviewSource(snapshot, live, parsed.data.screen_id, active);
      return { screenId: parsed.data.screen_id };
    }),
    'screen.get': input => respond(() => useBackend(input, (port, signal) => port.get(signal))),
    'screen.submit': input => respond(async () => { const result = await useBackend(input, (port, signal) => port.submit(input.mutation, signal)); return { screen: result.screen }; }),
    'screen.update': input => respond(async () => { const result = await useBackend(input, (port, signal) => port.update(input.mutation, signal)); return { screen: result.screen }; }),
    'screen.confirm': input => respond(async () => { const result = await useBackend(input, (port, signal) => port.confirmScaffold(input.mutation, signal)); return { screen: result.screen }; }),
    'screen.events': input => respond(async () => {
      prune(); const key = pollKey(input);
      if (canceled.has(key)) throw new ScreenTransportError('aborted');
      if (polls.has(key) || polls.size >= 128) throw new ScreenTransportError('poll_conflict');
      const controller = new AbortController(); polls.set(key, controller);
      const signal = requestSignal(controller.signal);
      try { return await useBackend(input, (port, active) => port.events({ after: input.after, timeoutMs: input.timeoutMs }, active), signal); }
      finally { polls.delete(key); }
    }),
    'screen.cancel': input => {
      prune(); const key = pollKey(input); polls.get(key)?.abort();
      if (canceled.size >= 256) canceled.delete(canceled.keys().next().value!);
      canceled.set(key, Date.now() + 60000); return null;
    },
    'screen.presentation': ({ threadId }) => ({ requestId: presentations.get(threadId)?.requestId ?? null }),
    'screen.presented': ({ threadId, requestId, opened }) => {
      const current = presentations.get(threadId);
      if (current?.requestId === requestId) current.finish(opened);
      return null;
    },
  });
  bb.agents.registerTool({ name: BIND_TOOL, description: 'Показать существующий серверный MCP Screen в этом разговоре BB. При первом вызове в пустой папке передай ID выбранной реальной компании; привязка и права проверяются сервером. Файлы не изменяются.',
    parameters: selectionSchema, execute: async ({ screenId, companyId }, ctx) =>
      JSON.stringify(await respond(() => bind(ctx.threadId, screenId, requestSignal(ctx.signal), companyId))) });
  bb.agents.registerTool({ name: OPEN_TOOL, description: 'Открыть конструктор выбранной реальной компании в текущем разговоре BB. Передай companyId и companyName без screenId: сервер найдёт существующий Screen, при нескольких вернёт выбор; выбранный screenId передай вместе с companyName. ID не угадывай. Новый каркас создаётся только в пустой папке при доказанном отсутствии прежнего Screen. Явный screenId сохраняет прежний режим открытия. Подтверждение структуры не создаёт файлы.',
    parameters: selectionSchema.partial({ screenId: true }).extend({ companyName: z.string().min(1).max(2000).optional(), create: z.object({ requestId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), companyName: z.string().min(1).max(2000) }).strict().optional() }).strict(),
    execute: async ({ screenId, create, companyId, companyName }, ctx) => {
      if (screenId && (create || !companyName)) return JSON.stringify(await respond(() => openScreen(ctx.threadId, screenId, companyId, create, requestSignal(ctx.signal))));
      if (create) return JSON.stringify({ ok: false, error: { code: 'invalid_request', message: 'Для поиска по компании передай companyId без create; ID нового Screen определит система.' } });
      return JSON.stringify(await respond(async () => {
        const active = requestSignal(ctx.signal);
        const selected = companyId ?? (await native.resolve(ctx.threadId, active)).context.company_id;
        const result = await openCompany({ threadId: ctx.threadId, companyId: selected, companyName: companyName ?? selected, ...(screenId ? { screenId } : {}) }, active);
        if (!result.ok) throw new ScreenContextError(result.error.code, result.error.message);
        return result.value;
      }));
    } });
  bb.agents.registerTool({ name: EXISTING_TOOL, description: 'Показать ограниченный снимок существующей рабочей папки в Screen. Корень берётся только из проверенной среды BB; роли передаются агентом с основанием. Нераскрытые ветки защищены; снимок предназначен для обзора, не для файловых изменений. Для обновления того же Screen передай прочитанную expectedRevision; это заменит данные обзора и снимет прежнее подтверждение. Канонические служебные папки и kit распознаются сами; для остальных ролей прочитай README.',
    parameters: selectionSchema.extend({ expectedRevision: z.number().int().positive().optional(), requestId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), companyName: z.string().min(1).max(100),
      roles: z.record(z.string().min(1).max(500), z.object({ role: z.enum(['unit', 'aspect', 'kit', 'infrastructure', 'workspace']), source: z.string().min(1).max(800) }).strict()).optional(),
    }).strict(),
    execute: async ({ screenId, companyId, requestId, companyName, roles, expectedRevision }, ctx) => JSON.stringify(await respond(async () => {
      const active = requestSignal(ctx.signal);
      const { imported } = await saveOverview(ctx.threadId, {screenId, companyId, requestId, companyName, roles, expectedRevision}, active);
      const opened = await bind(ctx.threadId, screenId, active);
      return { ...opened, coverage: 'limited-overview', hiddenBranches: imported.snapshot.ignoredRoots.length,
        warning: 'Это частичный обзор, а не план изменения файлов. Нераскрытые ветки сохранены; перед изменениями нужен полный разбор.' };
    })) });
  bb.agents.registerTool({ name: RESULT_TOOL, description: 'Прочитать сохранённое состояние Screen и намерение человека вместе с обратной связью и границами снимка. Можно обсуждать и неподтверждённое состояние; оно само не разрешает файловых изменений и не закрывает онбординг.',
    parameters: z.object({ screenId: idSchema }).strict(), execute: async ({ screenId }, ctx) => JSON.stringify(await respond(async () => {
      const active = requestSignal(ctx.signal);
      await useBackend({ threadId: ctx.threadId, screenId }, port => port.get(active), active);
      const live = await native.resolve(ctx.threadId, active);
      const result = await options.account.callMcpForContext({ name: 'screen_result', arguments: { id: screenId, company_id: live.context.company_id } }, { ...live.context, epoch: live.epoch }, active);
      const envelope = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(result);
      if (envelope.isError) {
        const reason = z.object({ reason: z.string() }).safeParse(envelope.structuredContent);
        throw new ScreenTransportError(reason.success ? reason.data.reason : 'mcp_error');
      }
      const parsed = resultSchema.safeParse(envelope.structuredContent);
      if (!parsed.success || parsed.data.id !== screenId || parsed.data.companyId !== live.context.company_id ||
        parsed.data.cursor !== parsed.data.revision || parsed.data.screen.id !== screenId || parsed.data.screen.revision !== parsed.data.revision ||
        JSON.stringify(parsed.data.submission) !== JSON.stringify(parsed.data.screen.submission) ||
        (parsed.data.status === 'confirmed' ? parsed.data.confirmation?.revision !== parsed.data.revision : parsed.data.confirmation !== null))
        throw new ScreenTransportError('invalid_response');
      const after = await native.resolve(ctx.threadId, active);
      if (JSON.stringify(after) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
      return parsed.data;
    })) });
  bb.agents.registerTool({ name: OVERVIEW_TOOL, description: 'Прочитать сохранённое дерево ограниченного обзора и его границы для обсуждения. Результат не является планом файловых изменений.',
    parameters: z.object({ screenId: idSchema }).strict(), execute: async ({ screenId }, ctx) => JSON.stringify(await respond(async () => {
      const active = requestSignal(ctx.signal);
      const snapshot = await useBackend({ threadId: ctx.threadId, screenId }, port => port.get(active), active);
      const blocks = snapshot.screen.document.blocks;
      if (blocks.length !== 1 || blocks[0].type !== 'scaffold' || blocks[0].config.schemaVersion !== 2 || !blocks[0].config.overview)
        throw new ScreenContextError('not_overview', 'Этот Screen не является ограниченным обзором.');
      const live = await native.resolve(ctx.threadId, active);
      const stored = z.object({ schema: z.literal(1), root: z.string(), hash: z.string() }).strict().safeParse(
        await bb.storage.kv.get(`screen:overview:${live.context.company_id}:${screenId}`));
      let source: 'matches' | 'changed' | 'unverified' = 'unverified';
      if (stored.success && stored.data.root === live.realRoot && stored.data.hash === blocks[0].config.overview.sourceHash) {
        const current = await importScaffold(live.realRoot, { companyName: blocks[0].config.companyName,
          limits: { maxDepth: blocks[0].config.overview.maxDepth }, allowDepthBoundary: true, signal: active });
        source = current.snapshot.hash === stored.data.hash ? 'matches' : 'changed';
      }
      if (JSON.stringify(await native.resolve(ctx.threadId, active)) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
      return { screenId, revision: snapshot.screen.revision, cursor: snapshot.cursor,
        config: blocks[0].config, status: 'overview-only', source,
        warning: source === 'matches' ? 'Исходный снимок соответствует рабочей папке в пределах его границ; изменения дерева выражают намерение, перед файловыми действиями нужен полный разбор.'
          : source === 'changed' ? 'Рабочая папка изменилась после снимка; повторите обзор перед выводами о текущем состоянии.'
            : 'Связь обзора с текущей папкой не подтверждена. Не выдавайте его за текущую структуру; предложите обновить данные того же Screen после согласия.' };
    })) });
  bb.agents.registerTool({ name: PREVIOUS_TOOL, description: 'После явного выбора компании и постоянной папки найди доступные конструкторы Screen этой компании, даже если прежний разговор удалён. Не читает переписку, не выбирает компанию или экран и не переносит прежнюю папку. При нескольких вариантах спроси человека; затем открой выбранный через svaib_screen_bind.',
    parameters: z.object({ companyId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }).strict(),
    execute: async ({ companyId }, ctx) => JSON.stringify(await respond(async () => {
      const active = requestSignal(ctx.signal);
      const live = await native.resolve(ctx.threadId, active, companyId);
      const found = z.object({screens: z.array(z.object({id: idSchema, title: z.string(), updatedAt: z.string(), kind: z.enum(['overview', 'scaffold'])})), complete: z.boolean()}).parse(await remote(live, 'screen_get', {discover: true, component: 'scaffold'}, active));
      const screens = [];
      for (const item of found.screens) {
        const snapshot = screenSnapshotSchema.parse(await remote(live, 'screen_get', {id: item.id}, active));
        const block = snapshot.screen.document.blocks[0];
        const capturedAt = block?.type === 'scaffold' && block.config.schemaVersion === 2 ? block.config.overview?.capturedAt ?? null : null;
        screens.push({screenId: item.id, title: item.title, revision: snapshot.screen.revision, updatedAt: item.updatedAt,
          kind: item.kind, capturedAt, refreshSuggested: (item.kind === 'overview' || await hasExistingContent(live.realRoot)) && (!capturedAt || Date.now() - Date.parse(capturedAt) > 24 * 60 * 60 * 1000)});
      }
      return { screens, truncated: !found.complete };
    })) });
  function dispose() { lifetime.abort(); for (const poll of polls.values()) poll.abort(); polls.clear(); canceled.clear(); }
  bb.onDispose(dispose);
  bb.events.on('thread.deleted', ({ thread }) => { for (const [key, poll] of polls) if (key.startsWith(thread.id + ':')) poll.abort(); });
  return {
    configure(_context: PluginAgentConfigurationContext): PluginAgentConfiguration {
      return { tools: [OPEN_TOOL, EXISTING_TOOL, OVERVIEW_TOOL, BIND_TOOL, RESULT_TOOL, PREVIOUS_TOOL], skills: [], instructions:
        'Для работы со Screen используй выбранную человеком компанию и текущую папку проекта BB. Конструктор — опция: не запускай onboarding и не требуй Screen для обычной работы space-scaffold. На просьбу открыть конструктор вызови svaib_screen_open с companyId и companyName без screenId: инструмент найдёт существующие экраны, проверит среду и доступ. При нескольких choices уточни выбор по названиям и датам; выбранный ID передай в svaib_screen_open вместе с companyId и companyName. Очищенный конструктор при таком открытии восстановится по текущей папке с прежним ID только для владельца; просмотр через svaib_screen_bind данные не меняет. Не угадывай ID и не создавай дубль ради нового разговора или свежих данных; неполный список не доказывает отсутствия экрана. При refreshSuggested или source=changed/unverified предложи обновить данные того же Screen через svaib_screen_existing с его ID и прочитанной expectedRevision; предупреди о замене правок проекта дерева и дождись согласия. Возраст снимка определяй по capturedAt, а не по дате открытия окна; неизвестную дату не считай свежей. Если нужна постоянная папка, помоги выбрать её штатными средствами BB; не выбирай за человека. При presentation=not-opened не утверждай, что вкладка видна: предложи кнопку «Конструктор» в разговоре или доступную браузерную ссылку. Читай сохранённое намерение через svaib_screen_result, а границы и свежесть обзора — через svaib_screen_overview; обсуждай его независимо от pending/confirmed. Изменения файлов согласуй отдельно и выполняй через space-scaffold с проверкой источников. Различие версии шаблона/структуры не запрещает работу само по себе. При конфликте состояния перечитай его и согласуй актуальное намерение; не требуй пересоздать пространство. Номер ревизии, CAS и технические идентификаторы не выводи человеку без необходимости диагностики. Замечай тестовые и утратившие назначение экраны и дубли; предлагай очистить конкретные экраны общими MCP-операциями только после явного согласия, с сохранением нужной обратной связи, правами владельца и проверкой ревизии. Возраст сам по себе не делает экран мусорным. Не выдумывай компанию и не записывай credentials.' };
    }, dispose,
  };
}
