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
import { FOLDER_TOOL } from './folder-contract';
import { createCompanyFolderFlow } from './company-folder-flow';
import { comparisonSchema, createNativeObservation, nativeObservationInputSchema } from './native-observation';

export const rpcContract = defineRpcContract({
  observeNativeAccount: { input: nativeObservationInputSchema, output: z.object({ recorded: z.literal(true) }).strict() },
  compareNativeAccount: { input: z.null(), output: comparisonSchema },
  status: { input: z.object({ company_id: z.string().min(1).max(64) }).strict().nullable(), output: accountViewSchema },
  connectionThread: { input: z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/) }).strict(), output: connectionThreadSchema },
  beginLogin: { input: z.null(), output: z.object({ authorizationUrl: z.string().url() }).strict() },
  connect: { input: startFlowSchema, output: flowSchema },
  continueOnboarding: { input: onboardingActionSchema, output: onboardingActionResultSchema },
  connectionStatus: { input: z.null(), output: flowSchema },
  partnerIdentity: { input: z.null(), output: z.object({ subject: z.string().nullable(), threadId: z.string().nullable() }).strict() },
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
  const nativeObservation = createNativeObservation({ sdk: bb.sdk, kv: bb.storage.kv,
    account: () => account.view(), changed: () => bb.realtime.publish('account-changed', null) });
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
  const companyFolder = createCompanyFolderFlow({ sdk: bb.sdk, pluginId: bb.pluginId,
    serverDataDir: bb.server.experimental_dataDir, connection,
    hasNativeObservation: async () => !!await nativeObservation.read() });
  bb.agents.registerTool({ name: FOLDER_TOOL,
    description: 'После того как человек выбрал постоянную папку в штатном новом разговоре BB и отправил подготовленное продолжение, проверь фактическую среду этого разговора и открой сохранённое продолжение настройки. Путь не принимается и папка не выбирается агентом. Во временной, личной или управляемой среде откажи без создания файлов.',
    parameters: z.object({}).strict(), execute: async (_input, ctx) => {
      const result = await companyFolder(ctx);
      return JSON.stringify({ ...result, message: result.status === 'ready'
        ? 'Постоянная папка проверена. Продолжи работу в этом разговоре в пределах переданного continuation; если его нет, не выдумывай исходное поручение. Проверь выбранную компанию и существующее пространство. Сверка аккаунтов не является условием работы; не создавай файлы без поручения.'
        : result.status === 'opened'
        ? 'Продолжение открыто в проверенном разговоре. Заверши ответ здесь; не запускай настройку, проверку или создание файлов повторно.'
        : `Продолжение уже создано: @thread:${result.threadId}, но BB не подтвердил его открытие. Дай ссылку человеку. Для повторного открытия вызови этот же инструмент ещё раз; новый разговор не создавай.` });
    },
  });
  bb.agents.registerTool({ name: HOOK_TOOL, description: 'Проверяет и автоматически подключает все хуки установленного svaib@svaib в текущем Codex; другие плагины не изменяются.',
    parameters: z.object({}).strict(),
    execute: async (_, ctx) => JSON.stringify(await reviewHooks(ctx)) });
  bb.onDispose(() => connection.dispose());
    bb.agents.registerTool({ name: BEGIN_TOOL, description: 'Начинает или проверяет вход кабинета svaib. Не проверяет вход партнёра и не возвращает токены или OAuth-ссылки.',
      parameters: z.object({ continuation: continuationInputSchema.optional(), reopenBrowser: z.boolean().optional().describe('Только по просьбе пользователя повторно открыть закрытую вкладку.') }).strict(),
      execute: async ({ reopenBrowser, continuation }, ctx) => JSON.stringify(await connection.prepareCabinet(ctx, reopenBrowser, continuation)) });
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
    observeNativeAccount: input => nativeObservation.record(input),
    compareNativeAccount: () => nativeObservation.compare(),
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
    connect: async input => {
      const result = await connection.start(input);
      if (result.threadId) await bb.sdk.threads.open({ threadId: result.threadId, file: null });
      return result;
    },
    continueOnboarding: async input => {
      const observed = await nativeObservation.read();
      if (observed && !['workplace', 'account'].includes(input.stepId)) {
        const threadId = input.threadId ?? observed.threadId;
        const thread = await bb.sdk.threads.get({ threadId });
        if (thread.deletedAt || thread.environmentId !== observed.environmentId ||
            (input.projectId && thread.projectId !== input.projectId) ||
            !['codex', 'claude-code'].includes(thread.providerId))
          throw new Error('Открой разговор в проверенном рабочем месте и повтори.');
        await bb.sdk.threads.send({ threadId, mode: 'queue-if-active', input: [{ type: 'text', mentions: [],
          text: `Пользователь попросил продолжить путь svaib. Выбранный этап: ${JSON.stringify(input.stepId)}. Продолжи по скиллу onboarding, не расширяя поручение.` }] });
        await bb.sdk.threads.open({ threadId, file: null });
        return { threadId };
      }
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
    account, connection, nativeObservation, configure,
    epoch: () => oauth.epoch,
    verifiedCompany: account.verifiedCompany.bind(account),
    callMcpForContext: account.callMcpForContext.bind(account),
  };
}
