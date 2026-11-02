import { defineRpcContract, type BbPluginApi, type PluginAgentConfigurationContext } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { AccountController } from './account';
import { accountViewSchema } from './contracts';
import { SvaibApi } from './api';
import { OAuthConnection, productionOAuth, type OAuthEndpoints, type SessionStore } from './oauth';
import { SvaibMcp } from './mcp';
import type { Fetcher } from './http';
import { connectionConfiguration, connectionMetadataSchema, connectionThreadSchema, BEGIN_TOOL, FINISH_TOOL, FRESH_TOOL, WAIT_TOOL, START_TOOL } from './connection';
import { ConnectFlow, flowSchema, startFlowSchema, onboardingActionSchema, onboardingActionResultSchema } from './connect-flow';
import { browserContract } from './browser-contract';
import { continuationInputSchema } from './continuation';
import { opaqueProof } from './workplace-proof';
import { NATIVE_TOOL, nativeStartSchema } from './native-login';
import { createHookConsent } from './hook-consent';
import { HOOK_TOOL } from './hook-bundle';
import { createFolderSelection, revalidateSelectedFolder, validatePersistentFolder, FOLDER_TOOL } from './folder-selection';
import { createCompanyFolderFlow } from './company-folder-flow';

export const rpcContract = defineRpcContract({
  status: { input: z.object({ company_id: z.string().min(1).max(64) }).strict().nullable(), output: accountViewSchema },
  connectionThread: { input: z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/) }).strict(), output: connectionThreadSchema },
  beginLogin: { input: z.null(), output: z.object({ authorizationUrl: z.string().url() }).strict() },
  connect: { input: startFlowSchema, output: flowSchema },
  continueOnboarding: { input: onboardingActionSchema, output: onboardingActionResultSchema },
  connectionStatus: { input: z.null(), output: flowSchema },
  partnerIdentity: { input: z.null(), output: z.object({ subject: z.string().nullable(), threadId: z.string().nullable() }).strict() },
  folderPickerStatus: { input: z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/) }).strict(), output: z.object({ available: z.boolean(), recoverable: z.boolean().optional() }).strict() },
  chooseCompanyFolder: { input: z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/) }).strict(), output: z.discriminatedUnion('status', [
    z.object({ status: z.literal('cancelled') }).strict(),
    z.object({ status: z.literal('opened'), threadId: z.string().regex(/^thr_[a-z0-9]+$/) }).strict(),
    z.object({ status: z.literal('open-failed'), threadId: z.string().regex(/^thr_[a-z0-9]+$/) }).strict(),
  ]) },
  resumeCompanyFolder: { input: z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/) }).strict(), output: z.discriminatedUnion('status', [
    z.object({ status: z.literal('opened'), threadId: z.string().regex(/^thr_[a-z0-9]+$/) }).strict(),
    z.object({ status: z.literal('open-failed'), threadId: z.string().regex(/^thr_[a-z0-9]+$/) }).strict(),
  ]) },
  cancelLogin: { input: z.null(), output: z.null() },
  logout: { input: z.null(), output: z.object({ revoked: z.boolean() }).strict() },
  setWorkspaceCard: {
    input: z.object({ enabled: z.boolean(), expectedRevision: z.number().int().nonnegative(), company_id: z.string().min(1).max(64).optional() }).strict(),
    output: accountViewSchema,
  },
});

export interface AccountModuleOptions {
  sessionStore: SessionStore;
  oauthEndpoints?: OAuthEndpoints;
  apiBase?: string;
  fetcher?: Fetcher;
  registerConfigure?: boolean;
}
export type AccountModuleApi = Pick<BbPluginApi,
  'pluginId' | 'realtime' | 'onDispose' | 'hosts' | 'sdk' | 'server' | 'storage' | 'agents' | 'events' | 'rpc' | 'ui'>;

/** Composable backend. Settings/credentials remain owned by the containing factory. */
export async function registerAccountModule(bb: AccountModuleApi, options: AccountModuleOptions) {
  const endpoints = options.oauthEndpoints ?? productionOAuth();
  const apiBase = options.apiBase ?? 'https://api.svaib.com';
  if (apiBase !== new URL(endpoints.resource).origin) throw new Error('resource_api_mismatch');
  const fetcher = options.fetcher ?? fetch;
  let flow: ConnectFlow | undefined;
  const changed = () => { bb.realtime.publish('account-changed', null); flow?.accountChanged(); };
  const oauth = new OAuthConnection(options.sessionStore, changed, fetcher, endpoints);
  bb.onDispose(() => oauth.dispose());
  const account = new AccountController(oauth, new SvaibApi(fetcher, apiBase), new SvaibMcp(fetcher, endpoints.resource));
  if (endpoints.resource !== 'https://api.svaib.com/mcp' || apiBase !== 'https://api.svaib.com') throw new Error('production_resource_required');
  const browser = bb.hosts.experimental_client({ contract: browserContract });
  const reviewHooks = createHookConsent(bb);
  flow = new ConnectFlow({ sdk: bb.sdk, kv: bb.storage.kv, pluginId: bb.pluginId,
    account: () => account.view(), begin: () => oauth.begin(), cancel: () => oauth.cancel(), restartPending: epoch => oauth.restartPending(epoch), epoch: () => oauth.epoch, changed,
    open: async (url, hostId, signal) => { await browser.call('openLogin', { url }, { hostId, signal }); },
    prepareHooks: ctx => reviewHooks(ctx),
    proofs: { identity: account.workplaceIdentity.bind(account), begin: account.beginWorkplaceProof.bind(account),
      verify: account.verifyWorkplaceProof.bind(account) },
  });
  await flow.load();
  const connection = flow;
  const assertFolderCaller = async (ctx: import('@get-bb/plugin-sdk').PluginAgentToolContext) => {
    const identity = await connection.partnerIdentity();
    if (!identity.subject || identity.threadId !== ctx.threadId) throw new Error('Сначала проверь подключение в этом разговоре.');
  };
  const chooseFolder = createFolderSelection(bb, assertFolderCaller);
  const folderRecoveries = new Map<string, { threadId: string; sourceProjectId: string; runId: string; epoch: number;
    binding: NonNullable<import('./connect-flow').ConnectFlowView['binding']>; selection: import('./folder-selection').SelectedFolder;
    identity: Awaited<ReturnType<typeof account.workplaceIdentity>> }>();
  const companyFolder = createCompanyFolderFlow({ sdk: bb.sdk, pluginId: bb.pluginId, epoch: () => oauth.epoch, connection,
    choose: chooseFolder, revalidate: (ctx, selection, fence) => revalidateSelectedFolder(bb, ctx, selection, fence),
    connectSelectedFolder: (ctx, input, fence) => connection.connectSelectedFolder({ projectId: input.projectId, hostId: input.hostId,
      path: input.path, providerId: input.providerId, sourceThreadId: ctx.threadId, stepId: 'space' }, fence),
    rememberOpenFailure: async ({ sourceThreadId, sourceProjectId, threadId, runId, binding, subject, epoch, selection, identity: expectedIdentity }) => {
      const identity = await account.workplaceIdentity();
      const current = await connection.view();
      if (identity.account_id !== subject || identity.account_id !== expectedIdentity.account_id || identity.client_id !== expectedIdentity.client_id ||
          identity.epoch !== expectedIdentity.epoch || identity.epoch !== epoch || oauth.epoch !== epoch || current.runId !== runId ||
          current.threadId !== threadId || JSON.stringify(current.binding) !== JSON.stringify(binding))
        throw new Error('Подключение изменилось. Найди продолжение в списке разговоров и проверь его состояние.');
      folderRecoveries.set(sourceThreadId, { threadId, sourceProjectId, runId, epoch, binding, selection, identity });
      bb.realtime.publish('account-changed', null);
    },
  });
  const folderRequests = new Map<string, Set<AbortController>>();
  const abortFolderRequests = (threadId: string) => { for (const controller of folderRequests.get(threadId) ?? []) controller.abort(); };
  bb.events.on('thread.deleted', ({ thread }) => {
    abortFolderRequests(thread.id); folderRecoveries.delete(thread.id);
    for (const [source, recovery] of folderRecoveries) if (recovery.threadId === thread.id) folderRecoveries.delete(source);
  });
  bb.events.on('thread.archived', ({ thread }) => abortFolderRequests(thread.id));
  bb.events.on('thread.active', ({ thread }) => abortFolderRequests(thread.id));
  bb.onDispose(() => { for (const controllers of folderRequests.values()) for (const controller of controllers) controller.abort(); folderRecoveries.clear(); });
  bb.agents.registerTool({ name: FOLDER_TOOL,
    description: 'Когда человек решил выбрать папку для материалов организации, открой понятный выбор папки прямо в этом разговоре. Отмена ничего не создаёт. После выбора открой проверку в новой сессии; не выбирай папку сам и не записывай файлы.',
    parameters: z.object({}).strict(), execute: async (_input, ctx) => {
      const result = await companyFolder(ctx);
      return JSON.stringify({ ...result, message: result.status === 'opened'
        ? 'Продолжение открыто в новом разговоре. Здесь заверши ответ, не запускай настройку или проверку повторно.'
        : result.status === 'open-failed' ? 'Продолжение создано, но открыть его не удалось. Попроси человека нажать «Открыть продолжение» в этом разговоре; не создавай новый разговор.'
          : 'Выбор отменён, ничего не создано. Скажи об этом человеку и предложи выбрать папку позже.' });
    },
  });
  bb.agents.registerTool({ name: HOOK_TOOL, description: 'Проверяет и автоматически подключает все хуки установленного svaib@svaib в текущем Codex; другие плагины не изменяются.',
    parameters: z.object({}).strict(),
    execute: async (_, ctx) => JSON.stringify(await reviewHooks(ctx)) });
  bb.onDispose(() => connection.dispose());
    bb.agents.registerTool({ name: BEGIN_TOOL, description: 'Начинает или проверяет вход кабинета svaib без заявления native готовности. После подтверждения возвращает серверный challenge для native MCP issue_workplace_proof. Токены и OAuth-ссылки не возвращает.',
      parameters: z.object({ continuation: continuationInputSchema.optional(), reopenBrowser: z.boolean().optional().describe('Только по просьбе пользователя повторно открыть закрытую вкладку.') }).strict(),
      execute: async ({ reopenBrowser, continuation }, ctx) => JSON.stringify(await connection.preparePairing(ctx, reopenBrowser, continuation)) });
    bb.agents.registerTool({ name: FINISH_TOOL, description: 'Проверяет opaque proof от настоящего native MCP issue_workplace_proof через отдельный вход backend. Завершает сопоставление двух account grants в текущем подключении. Не принимает account_id или токены.',
      parameters: z.object({ proof: opaqueProof }).strict(),
      execute: async ({ proof }, ctx) => JSON.stringify(await connection.complete(proof, ctx)) });
  bb.agents.registerTool({ name: START_TOOL, description: 'По явному поручению подключить svaib передаёт ограниченное продолжение из текущего BB-разговора и открывает подключение. Сохрани исходный объём поручения; не передавай credentials или полный transcript.',
    parameters: continuationInputSchema, execute: async (continuation, ctx) => {
      const result = await connection.start({ projectId: ctx.projectId, threadId: ctx.threadId, continuation });
      if (result.threadId) await bb.sdk.threads.open({ threadId: result.threadId, file: null });
      return JSON.stringify(result);
    } });
  bb.agents.registerTool({ name: FRESH_TOOL, description: 'После установки и входа MCP запускает свежую проверку в той же среде автоматически. Не выполняет повторный OAuth.', parameters: z.object({ continuation: continuationInputSchema.optional() }).strict(),
    execute: async ({ continuation }, ctx) => JSON.stringify(await connection.freshVerification(ctx, continuation)),
  });
  bb.agents.registerTool({ name: WAIT_TOOL, description: 'Ожидает завершение OAuth-процесса в указанном терминале без чтения вывода, затем автоматически запускает свежую проверку MCP.', parameters: z.object({ terminalId: z.string().regex(/^term_[a-z0-9]+$/), continuation: continuationInputSchema.optional() }).strict(),
    execute: async ({ terminalId, continuation }, ctx) => JSON.stringify(await connection.waitForMcp(terminalId, ctx, continuation)),
  });
  bb.agents.registerTool({ name: NATIVE_TOOL, description: 'Открывает управляемый штатный вход Codex в проверенном локальном профиле; backend сам создаёт один принадлежащий подключению терминал. Возвращает только terminalId. OAuth URL и токены в модель не попадают.',
    parameters: nativeStartSchema, execute: async (input, ctx) => JSON.stringify(await connection.startNative(input, ctx)) });
  bb.events.on('thread.failed', ({ thread }) => connection.failed(thread.id));
  bb.events.on('thread.deleted', ({ thread }) => connection.deleted(thread.id));
  let disposed = false;
  bb.onDispose(() => { disposed = true; });
  bb.events.on('thread.idle', async ({ thread }) => {
    if (disposed || thread.status !== 'idle' || thread.deletedAt || !thread.environmentId) return;
    // Lifecycle notifications are global. Inspect no messages and publish no
    // thread data; the signed ready view validates the actual workspace binding.
    const view = await connection.view();
    if (disposed || view.stage !== 'ready' || !view.binding ||
        thread.projectId !== view.binding.projectId || thread.environmentId !== view.binding.environmentId ||
        thread.providerId !== view.binding.providerId) return;
    bb.realtime.publish('account-changed', null);
  });
  const configure = (context: PluginAgentConfigurationContext) => connectionConfiguration(context, bb.pluginId);
  if (options.registerConfigure !== false) bb.agents.configure(configure);
  bb.rpc.register(rpcContract, {
    connectionThread: async ({ threadId }) => {
      const thread = await bb.sdk.threads.get({ threadId });
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
      if (thread.originPluginId !== bb.pluginId || thread.originKind !== null || !connectionMetadataSchema.safeParse(metadata).success || !thread.environmentId || thread.deletedAt) {
        throw new Error('Этот разговор не относится к настройке подключения.');
      }
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      return connectionThreadSchema.parse({ threadId, projectId: thread.projectId,
        environmentId: environment.id, hostId: environment.hostId, providerId: thread.providerId });
    },
    status: input => account.view(input?.company_id),
    connectionStatus: () => connection.view(),
    partnerIdentity: () => connection.partnerIdentity(),
    folderPickerStatus: async ({ threadId }) => {
      const view = await connection.view();
      const recovery = folderRecoveries.get(threadId);
      const recoverable = !!recovery && recovery.epoch === oauth.epoch && view.runId === recovery.runId && view.threadId === recovery.threadId;
      if (folderRequests.has(threadId) || recoverable) return { available: true, recoverable };
      if (view.stage !== 'ready' || view.threadId !== threadId || !view.binding) return { available: false };
      const [thread, environment] = await Promise.all([bb.sdk.threads.get({ threadId }), bb.sdk.environments.get({ environmentId: view.binding.environmentId })]);
      if (thread.deletedAt || thread.archivedAt || thread.status !== 'idle' || thread.environmentId !== view.binding.environmentId ||
          environment.status !== 'ready' || environment.hostId !== view.binding.hostId) return { available: false };
      let persistent = false;
      if (environment.workspaceProvisionType === 'unmanaged' && environment.path) {
        try {
          const project = await bb.sdk.projects.get({ projectId: thread.projectId });
          const root = await validatePersistentFolder(bb.sdk, environment.hostId, environment, environment.path);
          persistent = project.kind === 'standard' && project.sources.some(source => source.type === 'local_path' &&
            source.projectId === project.id && source.hostId === environment.hostId && source.path === root);
        } catch { /* If the current folder cannot be established as durable, offer selection. */ }
      }
      return { available: !persistent };
    },
    chooseCompanyFolder: async ({ threadId }, rpc) => {
      const controller = new AbortController();
      const controllers = folderRequests.get(threadId) ?? new Set<AbortController>();
      controllers.add(controller); folderRequests.set(threadId, controllers);
      const signal = AbortSignal.any([rpc.experimental_signal, controller.signal]);
      try {
        signal.throwIfAborted();
        const view = await connection.view(); signal.throwIfAborted();
        if (view.stage !== 'ready' || view.threadId !== threadId || !view.binding) throw new Error('Открой разговор с подключённым партнёром.');
        const thread = await bb.sdk.threads.get({ threadId }); signal.throwIfAborted();
        if (thread.deletedAt || thread.archivedAt || thread.status !== 'idle' || thread.projectId !== view.binding.projectId ||
            thread.environmentId !== view.binding.environmentId) throw new Error('Дождись ответа партнёра и повтори выбор папки.');
        return await companyFolder({ threadId, projectId: view.binding.projectId, signal });
      }
      finally { controllers.delete(controller); if (!controllers.size) folderRequests.delete(threadId); }
    },
    resumeCompanyFolder: async ({ threadId }, rpc) => {
      const recovery = folderRecoveries.get(threadId);
      if (!recovery) throw new Error('Продолжение недоступно. Найди его в списке разговоров.');
      const signal = rpc.experimental_signal;
      const check = async () => {
        signal.throwIfAborted();
        const view = await connection.view();
        const identity = await account.workplaceIdentity(signal);
        if (folderRecoveries.get(threadId) !== recovery || oauth.epoch !== recovery.epoch || identity.epoch !== recovery.epoch ||
            identity.account_id !== recovery.identity.account_id || identity.client_id !== recovery.identity.client_id ||
            view.runId !== recovery.runId || view.threadId !== recovery.threadId ||
            JSON.stringify(view.binding) !== JSON.stringify(recovery.binding) || !['verify', 'ready', 'error'].includes(view.stage))
          throw new Error('Подключение изменилось. Найди продолжение в списке разговоров.');
        const target = await bb.sdk.threads.get({ threadId: recovery.threadId });
        const source = await bb.sdk.threads.get({ threadId });
        const metadata = connectionMetadataSchema.safeParse(await bb.sdk.threads.getPluginMetadata({ threadId: recovery.threadId }));
        const env = await bb.sdk.environments.get({ environmentId: recovery.binding.environmentId });
        const project = await bb.sdk.projects.get({ projectId: recovery.binding.projectId });
        if (!source || source.id !== threadId || source.deletedAt || source.archivedAt || source.originPluginId !== bb.pluginId || source.originKind !== null ||
            source.projectId !== recovery.sourceProjectId || source.environmentId !== recovery.selection.sourceEnvironmentId || source.providerId !== recovery.selection.sourceProviderId ||
            !target || target.deletedAt || target.archivedAt || target.id !== recovery.threadId || target.originPluginId !== bb.pluginId || target.originKind !== null ||
            target.projectId !== recovery.binding.projectId || target.environmentId !== recovery.binding.environmentId || target.providerId !== recovery.binding.providerId ||
            !metadata.success || metadata.data.runId !== recovery.runId || !metadata.data.verifyExistingOnly ||
            metadata.data.continuation?.sourceThreadId !== threadId || !['verify', 'work'].includes(metadata.data.phase) ||
            env.id !== recovery.binding.environmentId || env.projectId !== recovery.binding.projectId || env.hostId !== recovery.binding.hostId ||
            env.status !== 'ready' || env.workspaceProvisionType !== 'unmanaged' || env.path !== recovery.selection.path ||
            project.id !== recovery.binding.projectId || project.kind !== 'standard' || !project.sources.some(source => source.type === 'local_path' &&
              source.projectId === project.id && source.hostId === recovery.binding.hostId && source.path === recovery.selection.path) || oauth.epoch !== recovery.epoch)
          throw new Error('Рабочее место изменилось. Найди продолжение в списке разговоров.');
        signal.throwIfAborted();
      };
      const ctx = { threadId, projectId: recovery.sourceProjectId, signal } as import('@get-bb/plugin-sdk').PluginAgentToolContext;
      await revalidateSelectedFolder(bb, ctx, recovery.selection, check);
      await check();
      try { await bb.sdk.threads.open({ threadId: recovery.threadId, file: null }); }
      catch { return { status: 'open-failed' as const, threadId: recovery.threadId }; }
      folderRecoveries.delete(threadId);
      bb.realtime.publish('account-changed', null);
      return { status: 'opened' as const, threadId: recovery.threadId };
    },
    connect: async input => {
      const result = await connection.start(input);
      if (result.threadId) await bb.sdk.threads.open({ threadId: result.threadId, file: null });
      return result;
    },
    continueOnboarding: async input => {
      const result = await connection.continueOnboarding(input);
      await bb.sdk.threads.open({ threadId: result.threadId, file: null });
      return result;
    },
    beginLogin: () => {
      if (!endpoints.clientId?.trim() && !endpoints.registration) throw new Error('Сначала укажи OAuth client ID тестового контура в настройках плагина и перезагрузи его.');
      return oauth.begin();
    },
    cancelLogin: () => { oauth.cancel(); return null; },
    logout: () => oauth.logout(),
    setWorkspaceCard: async ({ enabled, expectedRevision, company_id }) => {
      const view = await account.workspaceCard(enabled, expectedRevision, company_id);
      changed(); return view;
    },
  });
  return {
    account, connection, configure,
    epoch: () => oauth.epoch,
    verifiedCompany: account.verifiedCompany.bind(account),
    callMcpForContext: account.callMcpForContext.bind(account),
  };
}
