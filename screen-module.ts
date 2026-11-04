import { defineRpcContract, type BbPluginApi, type PluginAgentConfiguration, type PluginAgentConfigurationContext } from '@get-bb/plugin-sdk';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FOLDER_TOOL } from './experiments/account-prototype/folder-selection';
import { idSchema, screenSchema, submitSchema, updateSchema, confirmScaffoldSchema } from 'bb-plugin-svaib-screen-pilot/model';
import { createScreenBackend, screenSnapshotSchema, screenEventsSchema, ScreenTransportError,
  type ScreenContext, type ScreenBackendPort } from './screen-transport';
import { createScreenPluginContext, ScreenContextError, type ScreenAccountPort, type PersistentRootValidator } from './screen-native-context';
import { scaffoldConfirmationSchema } from 'bb-plugin-svaib-screen-pilot/scaffold';

const threadIdSchema = z.string().regex(/^thr_[a-z0-9]+$/);
const select = z.object({ threadId: threadIdSchema, screenId: idSchema }).strict();
const pollId = z.string().uuid();
const errorSchema = z.object({ code: z.string(), message: z.string() }).strict();
const reply = <T extends z.ZodType>(value: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value }).strict(), z.object({ ok: z.literal(false), error: errorSchema }).strict(),
]);
// The canonical schemas are also Standard Schema compatible across package-local Zod copies.
export const screenRpcContract = defineRpcContract({
  'screen.binding': { input: z.object({ threadId: threadIdSchema }).strict(), output: reply(z.object({ screenId: idSchema.nullable() }).strict()) },
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
const BIND_TOOL = 'svaib_screen_bind';
const RESULT_TOOL = 'svaib_screen_result';
const PREVIOUS_TOOL = 'svaib_screen_previous';
const selectionSchema = z.object({
  screenId: idSchema, companyId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),
  mode: z.literal('company').optional(), // accepted for older company callers; never a local fallback
}).strict();
const resultSchema = z.object({ id: idSchema, revision: z.number().int().positive(), cursor: z.number().int().positive(),
  companyId: z.string(), status: z.enum(['pending', 'confirmed']), browserUrl: z.string().url().nullable(),
  catalogVersion: z.string(), canonSnapshot: z.string(), applicationStatus: z.literal('not-tracked'),
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
  async function bind(threadId: string, screenId: string, active = requestSignal(), companyId?: string) {
    const live = await native.resolve(threadId, active, companyId);
    const port = createScreenBackend({ binding: { ...live.context, screen_id: screenId },
      readTrustedContext: async signal => { const checked = await native.resolve(threadId, signal);
        if (checked.epoch !== live.epoch || checked.realRoot !== live.realRoot) throw new ScreenTransportError('context_changed');
        return checked.context; },
      callMcp: (request, call) => options.account.callMcpForContext(request, { ...call.expectedContext, epoch: live.epoch }, call.signal) });
    try {
      const snapshot = await port.get(active); // Shared /mcp must authorize the actual company and screen first.
      if (JSON.stringify(await native.resolve(threadId, active)) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
      await bb.storage.kv.set(bindingKey(threadId), { schema: 1, screen_id: screenId, context: live.context, real_root: live.realRoot });
      if (JSON.stringify(await native.resolve(threadId, active)) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
      bb.realtime.publish('screen-changed', { threadId, screenId });
      const opened = await present(threadId, active);
      return { screenId, revision: snapshot.screen.revision, cursor: snapshot.cursor,
        presentation: opened ? 'tab-opened' as const : 'not-opened' as const,
        message: opened ? 'BB открыл вкладку Screen. Дождись загрузки и попроси пользователя проверить структуру.'
          : 'Screen подготовлен, но открытие вкладки BB не подтверждено. Не утверждай, что пользователь её видит; попроси открыть «Конструктор» в этом разговоре.' };
    } finally { port.dispose(); }
  }
  bb.rpc.register(screenRpcContract, {
    'screen.binding': input => respond(async () => {
      const active = requestSignal();
      const value = await bb.storage.kv.get(bindingKey(input.threadId));
      if (value === undefined) return { screenId: null };
      const parsed = storedBinding.safeParse(value);
      if (!parsed.success) throw new ScreenTransportError('invalid_binding');
      // Read the screen as well: a stale UI binding never becomes authorization.
      await useBackend({ threadId: input.threadId, screenId: parsed.data.screen_id }, port => port.get(active), active);
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
  bb.agents.registerTool({ name: OPEN_TOOL, description: 'Открыть серверный MCP Screen и конструктор каркаса в этом разговоре BB. Использует вход кабинета плагина и подтверждённое членство. При первом вызове до каркаса передай companyId выбранной реальной компании. Подтверждение структуры не создаёт файлы.',
    parameters: selectionSchema.extend({ create: z.object({ requestId: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/), companyName: z.string().min(1).max(2000) }).strict().optional() }).strict(),
    execute: async ({ screenId, create, companyId }, ctx) => JSON.stringify(await respond(async () => {
      const active = requestSignal(ctx.signal);
      const live = await native.resolve(ctx.threadId, active, companyId);
      const result = await options.account.callMcpForContext({ name: 'screen_open', arguments: {
        id: screenId, preset: 'space-setup', company_id: live.context.company_id, ...(create ? { create } : {}),
      } }, { ...live.context, epoch: live.epoch }, active);
      const parsed = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown() }).passthrough().parse(result);
      if (parsed.isError) {
        const reason = z.object({ reason: z.string() }).safeParse(parsed.structuredContent);
        throw new ScreenTransportError(reason.success ? reason.data.reason : 'mcp_error');
      }
      // A grant/folder change while screen_open was in flight must not bind its response.
      const after = await native.resolve(ctx.threadId, active);
      if (JSON.stringify(after) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
      return bind(ctx.threadId, screenId, active);
    })) });
  bb.agents.registerTool({ name: RESULT_TOOL, description: 'Получить с сервера актуальную подтверждённую ревизию и план Screen для штатного space-scaffold. При pending сначала дождись подтверждения структуры. Результат не создаёт файлы и не закрывает этапы онбординга.',
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
        parsed.data.cursor !== parsed.data.revision ||
        (parsed.data.status === 'confirmed' ? parsed.data.confirmation?.revision !== parsed.data.revision : parsed.data.confirmation !== null))
        throw new ScreenTransportError('invalid_response');
      const after = await native.resolve(ctx.threadId, active);
      if (JSON.stringify(after) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
      return parsed.data;
    })) });
  bb.agents.registerTool({ name: PREVIOUS_TOOL, description: 'После явного выбора компании и постоянной папки найди ранее открытые доступные Screen этой компании, даже если прежний разговор удалён. Не читает переписку, не выбирает компанию или экран и не переносит прежнюю папку. При нескольких вариантах спроси человека; затем открой выбранный через svaib_screen_bind.',
    parameters: z.object({ companyId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/) }).strict(),
    execute: async ({ companyId }, ctx) => JSON.stringify(await respond(async () => {
      const active = requestSignal(ctx.signal);
      const live = await native.resolve(ctx.threadId, active, companyId);
      const keys = await bb.storage.kv.list('screen:binding:');
      const candidates = new Set<string>();
      for (const key of keys.slice(0, 200)) {
        const previous = storedBinding.safeParse(await bb.storage.kv.get(key));
        if (previous.success && previous.data.context.account_id === live.context.account_id &&
            previous.data.context.company_id === live.context.company_id && previous.data.context.subject_id === live.context.subject_id)
          candidates.add(previous.data.screen_id);
      }
      const screens: { screenId: string; revision: number }[] = [];
      for (const screenId of candidates) {
        const port = createScreenBackend({ binding: { ...live.context, screen_id: screenId },
          readTrustedContext: async signal => { const checked = await native.resolve(ctx.threadId, signal);
            if (checked.epoch !== live.epoch || checked.realRoot !== live.realRoot) throw new ScreenTransportError('context_changed');
            return checked.context; },
          callMcp: (request, call) => options.account.callMcpForContext(request, { ...call.expectedContext, epoch: live.epoch }, call.signal) });
        try { const value = await port.get(active); screens.push({ screenId, revision: value.screen.revision }); }
        catch (error) { if (!(error instanceof ScreenTransportError) || error.code !== 'not_found') throw error; }
        finally { port.dispose(); }
      }
      if (JSON.stringify(await native.resolve(ctx.threadId, active)) !== JSON.stringify(live)) throw new ScreenTransportError('context_changed');
      return { screens, truncated: keys.length > 200 };
    })) });
  function dispose() { lifetime.abort(); for (const poll of polls.values()) poll.abort(); polls.clear(); canceled.clear(); }
  bb.onDispose(dispose);
  bb.events.on('thread.deleted', ({ thread }) => { for (const [key, poll] of polls) if (key.startsWith(thread.id + ':')) poll.abort(); });
  return {
    configure(_context: PluginAgentConfigurationContext): PluginAgentConfiguration {
      return { tools: [OPEN_TOOL, BIND_TOOL, RESULT_TOOL, PREVIOUS_TOOL, FOLDER_TOOL], skills: [], instructions:
        'Продолжи svaib:onboarding с текущего account setup. До Screen человек выбирает реальную компанию и постоянную папку через штатный новый разговор BB: No project → New project или существующий проект, затем оставляет Project checkout; personal и управляемые временные среды не подходят, Git не нужен. Когда человек отправил подготовленное продолжение после такого выбора, вызови svaib_choose_folder без пути: инструмент проверит фактическую среду текущего разговора, сохранит прежнее поручение и откроет проверку продолжения. Если постоянной папки нет, не создавай файлы и помоги открыть новый разговор со стандартным выбором папки BB. Не выбирай папку за человека. Для прежнего Screen после выбора компании вызови svaib_screen_previous, предложи продолжить и уточни выбор, если их несколько. Открой через svaib_screen_open/bind; передай companyId, если привязки ещё нет. Прежняя папка и права не переносятся. Не утверждай, что вкладка открыта, при presentation=not-opened: предложи кнопку «Конструктор» в разговоре. После подтверждения получи svaib_screen_result и продолжи через space-scaffold с необходимыми согласиями и проверкой файлов. Pending не разрешает создавать файлы; Screen не разрешает затирать чужое. Не выдумывай компанию и не записывай credentials.' };
    }, dispose,
  };
}
