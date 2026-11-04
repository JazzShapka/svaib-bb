import { createHash, randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { PluginBbSdk, PluginKvStorage, PluginAgentToolContext } from '@get-bb/plugin-sdk';
import { continuationInputSchema, continuationSchema, continuationPrompt, checkContinuation, mergeContinuation, type ContinuationInput, type Continuation } from './continuation';
import { accountIdentity, type AccountView } from './contracts';
import { connectionBindingSchema, connectionMetadataSchema } from './connection';
import { OAuthBeginError } from './oauth';
import { NativeLogin, nativeStartSchema, NATIVE_TECHNICAL_ERROR, NATIVE_TERMINAL_MISSING } from './native-login';
import { challengeSchema, checkProofTime, nativePairingAnchor, opaqueProof, verifiedProofSchema,
  type WorkplaceProofPort, type WorkplaceChallenge, type WorkplaceIdentity } from './workplace-proof';

export const flowSchema = z.object({
  stage: z.enum(['idle', 'setup', 'verify', 'cabinet', 'ready', 'error']),
  runId: z.string(), threadId: z.string().nullable(),
  binding: connectionBindingSchema.nullable(), subject: z.string().nullable(),
  message: z.string(), retryable: z.boolean().default(false),
  verification: z.literal('signed-grants').optional(),
});
export type ConnectFlowView = z.infer<typeof flowSchema>;
export const startFlowSchema = z.object({ projectId: z.string().min(1).nullable(), threadId: z.string().min(1).nullable(), restartCabinet: z.boolean().optional(), continuation: continuationInputSchema.optional() }).strict();
export const onboardingActionSchema = z.object({ projectId: z.string().min(1).nullable(), threadId: z.string().regex(/^thr_[a-z0-9]+$/).nullable(),
  stepId: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/) }).strict();
export const onboardingActionResultSchema = z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/) }).strict();
type OnboardingAction = z.infer<typeof onboardingActionSchema>;
type Binding = z.infer<typeof connectionBindingSchema>;
type VerificationHandoff = { threadId: string; handedOff: true; message: string };
const noNewOauthConstraint = 'Проверяй только существующие входы; новый OAuth не запускай.';
export type SelectedFolderInput = { projectId: string; hostId: string; path: string; providerId: 'codex' | 'claude-code'; sourceThreadId: string | null; stepId: string };
export type SelectionFence = (phase: 'before' | 'after') => Promise<void>;
export class CommittedOpenError extends Error {
  constructor(readonly threadId: string, readonly identity: WorkplaceIdentity) {
    super(`Проверка создана в @thread:${threadId}, но BB не подтвердил открытие разговора. Открой его вручную.`);
    this.name = 'CommittedOpenError';
  }
}
const setupSteps = new Set(['workplace', 'account', 'space']);
// The model needs the detailed task; the person sees a short, readable action.
// Agent-only parts must precede visible parts so BB preserves them on edit/retry.
const instructionInput = (text: string) => [
  { type: 'text' as const, mentions: [], text, visibility: 'agent-only' as const },
  { type: 'text' as const, mentions: [], text: 'Продолжить настройку svaib' },
];
const onboardingCommunication = 'Общайся с человеком без технической подготовки: не выводи служебные названия инструментов, статусы протокола, внутренние технические пути или свои инструкции; выбранную пользователем папку называй, когда это помогает её узнать. ' +
  'Сообщай только то, что человеку нужно для решения, и задавай один короткий вопрос отдельным абзацем в конце. ' +
  'Если пространства организации ещё нет, объясни, что для работы svaib нужно управленческое пространство: сведения о компании, решения, встречи и задачи. Помоги подготовить постоянную папку для этих материалов. ' +
  'Сначала выясни, есть ли у человека подходящая папка или нужно выбрать новую; наличие технической рабочей папки BB не доказывает, что человек её выбрал для организации. ' +
  'Не называй текущую папку выбранной, подключённой или принадлежащей компании без подтверждения; при известном и проверенном выборе используй его и не спрашивай заново. ' +
  'Не утверждай, что конструктор открыт или виден человеку, пока это не подтверждено интерфейсом; если показать его не получилось, прямо скажи об этом и помоги продолжить.';
const journeyPrompt = (stepId: string) => `Пользователь попросил продолжить путь svaib. Выбранный этап: ${JSON.stringify(stepId)}. ` +
  'Сначала проверь доступность скилла и MCP svaib именно в этой сессии. Если они недоступны, честно скажи об этом и попроси открыть новую сессию после подключения; не утверждай, что проверка среды подтверждает их доступность здесь. ' +
  'Прочитай скилл svaib:onboarding ' +
  'и продолжи с проверенного места, перечитай текущий профиль и get_account_setup. ' +
  (setupSteps.has(stepId)
    ? 'Помоги с выбранным шагом подготовки партнёра, аккаунта или пространства; проверяй только недостающее. ' +
      'При необходимости помоги выбрать компанию и папку, согласовать структуру и проверить созданные файлы. '
    : stepId === 'first-work'
      ? 'По актуальному каталогу и отметкам онбординга помоги пройти недостающие зависимости и этапы user.profile и user.first-work в доступном порядке. first-work — название кнопки, не идентификатор каталога. Не запускай техническую настройку заново. '
    : stepId === 'continue'
      ? 'Прочитай актуальный каталог онбординга, определи ближайший применимый шаг по настоящим отметкам и предложи продолжить его; не запускай техническую настройку заново. '
      : 'Найди выбранный этап в актуальном каталоге онбординга и помоги выполнить именно его; не запускай техническую настройку заново. ') +
  'Сохрани исходные договорённости, не выбирай компанию или папку за пользователя и не переустанавливай работающие инструменты. ' +
  'Не повторяй работающий вход; права компании и выбранную папку проверь отдельно. ' + onboardingCommunication;
const empty = (): ConnectFlowView => ({ stage: 'idle', runId: '', threadId: null, binding: null, subject: null, message: '', retryable: false });
const key = 'connection-flow-v1';
const pairingKey = 'connection-flow-proof-v1'; // Same existing technical KV; no account progress or server store.
const pairingOwner = z.object({ runId: z.string(), threadId: z.string(), binding: connectionBindingSchema,
  accountId: z.string(), clientId: z.string(), epoch: z.number().int() });
const activePairing = pairingOwner.extend({ state: z.literal('active'), challenge: challengeSchema, sinceSeq: z.number().int() });
const readyPairing = pairingOwner.extend({ state: z.literal('verified'), proofDigest: z.string(), receipt: verifiedProofSchema });
const pairingSchema = z.discriminatedUnion('state', [activePairing, readyPairing]);
const selectedBootstrapSchema = z.object({ schema: z.literal(1), task: z.literal('svaib-connect'), phase: z.literal('bootstrap'),
  runId: z.string(), targetHostId: z.string(), successorThreadId: z.string().optional() }).strict();
type Pairing = z.infer<typeof pairingSchema>;
type PairingStart = { connected: false; pending: true; step: 'cabinet'; threadId: string; message: string } |
  { connected: false; step: 'native'; threadId: string; message: string } |
  { connected: false; step: 'proof'; challenge: string; nonce: string; expires_at: number; threadId: string };
const digest = (proof: string) => createHash('sha256').update(proof).digest('hex');
type Dependencies = {
  sdk: PluginBbSdk; kv: PluginKvStorage; pluginId: string;
  account: () => Promise<AccountView>;
  begin: () => Promise<{ authorizationUrl: string }>;
  cancel: () => void;
  restartPending: (expectedEpoch: number) => boolean;
  epoch: () => number;
  waitSliceMs?: number;
  proofs: WorkplaceProofPort;
  open: (url: string, hostId: string, signal: AbortSignal) => Promise<void>;
  prepareHooks?: (ctx: PluginAgentToolContext) => Promise<{ state: 'trusted'; changed: boolean } | { state: 'declined' }>;
  changed: () => void;
};
type CompletionResult = { connected: true; subject: string; threadId: string } |
  { connected: false; pending: true; step: 'cabinet' | 'fresh'; threadId: string; message: string; handedOff?: true };

/** One explicit user action owns installation, native verification and cabinet OAuth. */
export class ConnectFlow {
  private state = empty();
  private starting: Promise<ConnectFlowView> | null = null;
  private onboardingStarting: Promise<z.infer<typeof onboardingActionResultSchema>> | null = null;
  private onboardingRequest: string | null = null;
  private lastOnboardingAction: { runId: string; threadId: string; stepId: string } | null = null;
  private startingSource: string | null = null;
  private selectedStarting: Promise<{ threadId: string; environmentId: string; stage: 'verify' }> | null = null;
  private selectedRequest: string | null = null;
  private completing: Promise<CompletionResult> | null = null;
  private completionOwner: { threadId: string; subject: string } | null = null;
  private verifying: Promise<VerificationHandoff> | null = null;
  private pendingCabinet: { runId: string; threadId: string; epoch: number; url: string } | null = null;
  private disposed = new AbortController();
  private checkCabinet: (() => void) | null = null;
  private saves: Promise<void> = Promise.resolve();
  private provisionalReady: { runId: string; threadId: string; previous: ConnectFlowView } | null = null;
  private pairing: Pairing | null = null;
  private pairingStarting: Promise<PairingStart> | null = null;
  private releasePairingAbort: (() => void) | null = null;
  private pairedRuntimeEpoch: number | null = null;
  private native: NativeLogin;
  private nativeChecking: { runId: string; threadId: string } | null = null;
  constructor(private d: Dependencies) { this.native = new NativeLogin(d.sdk, d.kv, d.pluginId); }

  async load() {
    await this.native.load();
    const parsed = flowSchema.safeParse(await this.d.kv.get(key));
    if (parsed.success) this.state = parsed.data;
    const proof = pairingSchema.safeParse(await this.d.kv.get(pairingKey));
    // An interrupted challenge never survives a runtime restart. Completed pairing is historical evidence.
    if (proof.success && proof.data.state === 'verified' && proof.data.runId === this.state.runId &&
        proof.data.threadId === this.state.threadId && proof.data.accountId === this.state.subject) {
      this.pairing = proof.data; this.pairedRuntimeEpoch = this.d.epoch();
    }
    else if (proof.success) await this.savePairing(null);
    await this.reconcileThread();
    // Recover only the known interrupted-wait states from the previous version.
    if (this.state.stage === 'error' && this.state.binding && this.state.threadId &&
        /^(Вход в кабинет не завершён|Агент не завершил подключение)/.test(this.state.message)) this.state.retryable = true;
    if (['setup', 'verify', 'cabinet'].includes(this.state.stage)) {
      await this.save({ stage: 'error', retryable: true, message: 'Подключение прервалось. Продолжи его: сохранённые входы останутся на месте.' });
    }
  }
  private save(patch: Partial<ConnectFlowView>, valid = () => true): Promise<void> {
    if (!valid()) return Promise.reject(new Error('Подключение изменилось.'));
    const previous = this.state;
    const next = flowSchema.parse(Object.fromEntries(Object.entries({ ...this.state, ...patch })
      .filter(([, value]) => value !== undefined)));
    this.state = next;
    const persist = async () => {
      if (!valid()) {
        if (this.state === next) this.state = previous;
        throw new Error('Подключение изменилось.');
      }
      await this.d.kv.set(key, next);
      const restore = async () => {
        if (this.state === next) this.state = previous;
        await this.d.kv.set(key, this.state);
        throw new Error('Подключение изменилось.');
      };
      if (!valid()) return restore();
      this.d.changed();
      if (!valid()) return restore();
    };
    // A late obsolete write must finish/restore before a newer flow is persisted.
    const pending = this.saves.then(persist);
    this.saves = pending.catch(() => {});
    return pending;
  }
  async view(): Promise<ConnectFlowView> {
    await this.reconcileThread();
    if (this.state.threadId && this.state.binding && ['setup', 'error'].includes(this.state.stage) &&
        !(this.nativeChecking?.runId === this.state.runId && this.nativeChecking.threadId === this.state.threadId)) {
      const owner = { runId: this.state.runId, threadId: this.state.threadId, binding: this.state.binding };
      const native = await this.native.status(owner);
      if (native && this.state.runId === owner.runId && this.state.threadId === owner.threadId) {
        const message = native.unavailable ? NATIVE_TERMINAL_MISSING : native.technicalFailure ? NATIVE_TECHNICAL_ERROR
          : native.running && native.retiring ? 'Завершаю предыдущую попытку входа. Нажми «Продолжить подключение» чуть позже.'
          : native.running ? 'Ожидаю результат входа Codex. Если вкладка устарела или закрыта, нажми «Продолжить подключение».'
          : native.success ? 'Вход завершён. Нажми «Продолжить подключение», чтобы проверить доступ партнёра.'
            : 'Вход прервался. Нажми «Продолжить подключение», чтобы открыть новый вход.';
        const retryable = !native.technicalFailure;
        if (this.state.message !== message || this.state.retryable !== retryable || (native.running && this.state.stage !== 'setup'))
          await this.save({ stage: native.running ? 'setup' : 'error', retryable, message },
            () => this.state.runId === owner.runId && this.state.threadId === owner.threadId);
      }
    }
    if (this.state.stage === 'cabinet' && this.pendingCabinet) {
      const owner = this.pendingCabinet;
      const epoch = this.d.epoch();
      const account = await this.d.account();
      if (this.pendingCabinet === owner && this.state.runId === owner.runId && this.state.threadId === owner.threadId &&
          account.state === 'signed-out' && this.d.epoch() === epoch) {
        await this.save({ stage: 'error', retryable: true,
          message: 'Вход не завершён или время ожидания истекло. Нажми «Продолжить подключение»: повторится только незавершённый вход кабинета.' },
        () => this.pendingCabinet === owner && this.state.runId === owner.runId && this.state.threadId === owner.threadId && this.d.epoch() === epoch);
      }
    }
    if (this.provisionalReady?.runId === this.state.runId && this.provisionalReady.threadId === this.state.threadId) {
      return structuredClone(this.provisionalReady.previous);
    }
    if (this.state.stage === 'ready') return this.signedReadyView();
    return structuredClone(this.state);
  }

  /** The persisted receipt names a specific native workplace, not just an account.
   * Read the thread again after the environment await, so that read cannot hide
   * a concurrent thread rebind behind an earlier thread snapshot. */
  private async checkPairingBinding(owner: Pick<Pairing, 'threadId' | 'binding'>, signal?: AbortSignal) {
    const matches = (thread: Awaited<ReturnType<PluginBbSdk['threads']['get']>>) =>
      thread?.id === owner.threadId && !thread.deletedAt && thread.originPluginId === this.d.pluginId &&
      thread.projectId === owner.binding.projectId && thread.environmentId === owner.binding.environmentId &&
      thread.providerId === owner.binding.providerId;
    const first = await this.d.sdk.threads.get({ threadId: owner.threadId }); signal?.throwIfAborted();
    if (!matches(first)) throw new Error('Рабочее место подключения изменилось.');
    const environment = await this.d.sdk.environments.get({ environmentId: owner.binding.environmentId }); signal?.throwIfAborted();
    const last = await this.d.sdk.threads.get({ threadId: owner.threadId }); signal?.throwIfAborted();
    if (!matches(last) || environment.id !== owner.binding.environmentId || environment.hostId !== owner.binding.hostId ||
        environment.status !== 'ready') throw new Error('Рабочее место подключения изменилось.');
  }

  private async withdrawSignedReady(previous: ConnectFlowView, proof: Pairing | null): Promise<ConnectFlowView> {
    const message = 'Рабочее место или вход подключения изменились. Нужна новая проверка; сохранённые авторизации остались на месте.';
    // Do not revoke or overwrite a replacement run while withdrawing an old read.
    const owns = () => this.state.runId === previous.runId && this.state.threadId === previous.threadId && this.pairing === proof;
    if (this.state === previous && owns()) {
      await this.save({ stage: 'error', retryable: false, subject: null, message }, owns);
      if (owns()) await this.savePairing(null, () => this.state.runId === previous.runId && this.state.threadId === previous.threadId);
    }
    return { ...previous, stage: 'error', retryable: false, subject: null, message };
  }

  private async signedReadyView(): Promise<ConnectFlowView> {
    const previous = this.state, proof = this.pairing, epoch = this.d.epoch();
    const current = () => this.state === previous && this.pairing === proof && this.d.epoch() === epoch &&
      this.pairedRuntimeEpoch === epoch && !this.disposed.signal.aborted;
    try {
      if (!current() || previous.verification !== 'signed-grants' || proof?.state !== 'verified' ||
          proof.runId !== previous.runId || proof.threadId !== previous.threadId || proof.accountId !== previous.subject ||
          JSON.stringify(proof.binding) !== JSON.stringify(previous.binding)) throw new Error('Неподтверждённая готовность.');
      const account = await this.d.account();
      if (!current() || account.state !== 'connected' || !account.me || accountIdentity(account.me) !== proof.accountId)
        throw new Error('Подключение изменилось.');
      const identity = await this.d.proofs.identity();
      if (!current() || identity.account_id !== proof.accountId || identity.client_id !== proof.clientId || identity.epoch !== epoch)
        throw new Error('Подключение изменилось.');
      // This is intentionally the last external read, after account/identity awaits.
      await this.checkPairingBinding(proof, this.disposed.signal);
      if (!current()) throw new Error('Подключение изменилось.');
      return structuredClone(previous);
    } catch { return this.withdrawSignedReady(previous, proof); }
  }
  private async threadExists(threadId: string) {
    // Explicitly include archived/hidden conversations. A failed read is not deletion.
    const query = { threadIds: [threadId], includeHidden: true, limit: 1 };
    const active = await this.d.sdk.threads.list({ ...query, archived: false });
    if (active.some(thread => thread.id === threadId && !thread.deletedAt)) return true;
    const archived = await this.d.sdk.threads.list({ ...query, archived: true });
    return archived.some(thread => thread.id === threadId && !thread.deletedAt);
  }
  private async reconcileThread() {
    const { threadId, runId } = this.state;
    if (!threadId || await this.threadExists(threadId)) return;
    if (this.state.threadId === threadId && this.state.runId === runId) await this.deleted(threadId);
  }
  async deleted(threadId: string) {
    if (threadId !== this.state.threadId) return;
    if (this.state.binding) await this.native.retire({ runId: this.state.runId, threadId, binding: this.state.binding });
    const pending = this.pendingCabinet;
    this.pendingCabinet = null;
    this.completing = null;
    this.completionOwner = null;
    this.verifying = null;
    await this.savePairing(null);
    await this.save({ ...empty(), verification: undefined });
    // Cancel only the orphaned pending request, never a completed login or another flow.
    if (pending && pending.epoch === this.d.epoch() && (await this.d.account()).state === 'waiting' &&
        !this.state.runId && pending.epoch === this.d.epoch()) this.d.cancel();
  }
  accountChanged() { this.checkCabinet?.(); }

  async partnerIdentity() {
    const { threadId, runId } = this.state;
    const epoch = this.d.epoch();
    if (!threadId) return { subject: null, threadId: null };
    const view = await this.view();
    const proof = this.pairing;
    if (view.stage !== 'ready' || proof?.state !== 'verified') return { subject: null, threadId };
    try { await this.checkPairingBinding(proof, this.disposed.signal); }
    catch { await this.withdrawSignedReady(this.state, proof); return { subject: null, threadId }; }
    return this.state.threadId === threadId && this.state.runId === runId && this.d.epoch() === epoch &&
      this.pairing === proof && this.state.stage === 'ready' && this.pairedRuntimeEpoch === epoch
      ? { subject: view.subject, threadId } : { subject: null, threadId };
  }

  start(input: z.infer<typeof startFlowSchema>, onboardingStep?: string, expectedTarget?: Binding, expectedProject?: string): Promise<ConnectFlowView> {
    input = startFlowSchema.parse(input);
    if (this.starting) {
      if (expectedTarget || expectedProject) return Promise.reject(new Error('Подключение уже меняется. Повтори выбор рабочего места.'));
      if (input.continuation && input.threadId !== this.startingSource) return Promise.reject(new Error('Уже передаётся поручение из другого разговора.'));
      return this.starting;
    }
    this.startingSource = input.threadId;
    this.starting = (async () => {
      const current = await this.view();
      if (expectedTarget || expectedProject) {
        if (current.stage !== 'ready') throw new Error('Прежнее подключение изменилось. Сначала проверь доступ партнёра.');
        return this.startNew(input, onboardingStep, expectedTarget, { runId: current.runId, threadId: current.threadId, epoch: this.d.epoch() }, expectedProject);
      }
      if (input.continuation && current.threadId) {
        const existing = connectionMetadataSchema.parse(await this.d.sdk.threads.getPluginMetadata({ threadId: current.threadId }));
        if (existing.continuation?.sourceThreadId !== input.threadId || existing.continuation.sourceProjectId !== input.projectId) {
          // A completed run is historical evidence. An explicit assignment from
          // another source owns a new verification; grants and the old chat stay.
          if (current.stage === 'ready') return this.startNew(input);
          throw new Error('Уже продолжается подключение из другого разговора. Открой существующее продолжение; входы сохранены.');
        }
        checkContinuation(existing.continuation, current.binding!.projectId, current.binding!.environmentId);
      }
      if (input.restartCabinet && current.binding && input.projectId && input.projectId !== current.binding.projectId)
        throw new Error('Рабочее место подключения изменилось. Текущий вход не изменён.');
      const restartCabinet = input.restartCabinet === true && current.stage === 'cabinet';
      const resumeNative = input.restartCabinet === true && current.threadId && current.binding &&
        this.native.owns({ runId: current.runId, threadId: current.threadId, binding: current.binding });
      if (['setup', 'verify', 'cabinet', 'ready'].includes(current.stage) && !restartCabinet && !resumeNative) return current;
      if ((current.retryable || restartCabinet || resumeNative) && current.threadId && current.binding &&
          (!input.projectId || input.projectId === current.binding.projectId)) {
        const { runId, threadId } = current;
        const binding = current.binding;
        let epoch = this.d.epoch();
        const bindingKeys = ['projectId', 'environmentId', 'hostId', 'providerId'] as const;
        const matchesBinding = (value: typeof binding) => bindingKeys.every(key => value[key] === binding[key]);
        const valid = () => !this.disposed.signal.aborted && this.state.runId === runId && this.state.threadId === threadId &&
          this.d.epoch() === epoch && !!this.state.binding && matchesBinding(this.state.binding);
        const check = () => { if (!valid()) throw new Error('Подключение изменилось. Повтори со страницы рабочего места.'); };
        check();
        const metadata = connectionMetadataSchema.safeParse(await this.d.sdk.threads.getPluginMetadata({ threadId })); check();
        if (!metadata.success || metadata.data.runId !== runId ||
            (metadata.data.targetHostId && metadata.data.targetHostId !== binding.hostId) ||
            (metadata.data.binding && !matchesBinding(metadata.data.binding)) ||
            (metadata.data.phase === 'verify' && !metadata.data.binding)) {
          throw new Error('Подключение изменилось: данные разговора не совпадают с текущим запуском.');
        }
        if (resumeNative) {
          const native = await this.native.status({ runId, threadId, binding }); check();
          if (native?.technicalFailure) return this.view();
          if (native?.unavailable) {
            await this.caller({ threadId } as PluginAgentToolContext, true); check();
            if (metadata.data.phase !== 'setup') throw new Error(NATIVE_TERMINAL_MISSING);
            await this.save({ stage: 'setup', retryable: false, message: 'Проверяю сохранённый доступ партнёра…' }, valid); check();
            await this.freshVerification({ threadId, projectId: binding.projectId, signal: this.disposed.signal } as PluginAgentToolContext, undefined, true, onboardingStep);
            return this.view();
          }
        }
        // Check actual execution after the delayed metadata read, before any resume write.
        await this.caller({ threadId } as PluginAgentToolContext, true); check();
        if (resumeNative) {
          const validNative = async () => { check(); await this.checkPairingBinding({ threadId, binding }, this.disposed.signal); check(); };
          const native = await this.native.continue({ runId, threadId, binding }, validNative); check();
          this.nativeChecking = native.finished ? { runId, threadId } : null;
          await this.save({ stage: 'setup', retryable: !native.finished, message: native.finished ? 'Проверяю доступ партнёра…' : native.message }, valid); check();
          await this.d.sdk.threads.send({ threadId, mode: 'auto', input: instructionInput(
            `Продолжи проверку того же управляемого входа Codex: вызови svaib_connect_wait с terminalId ${native.terminalId}. ` +
            'Не создавай второй терминал, не повторяй OAuth вручную и сохрани вход кабинета. После handedOff заверши ответ здесь.') }); check();
          return this.view();
        }
        let openFreshCabinet = false;
        if (input.restartCabinet) {
          const account = await this.d.account(); check();
          // Recheck the actual execution after the account await, before cancellation.
          await this.checkPairingBinding({ threadId, binding }, this.disposed.signal); check();
          if (this.state.stage === 'ready') return this.view();
          if (account.state === 'waiting') {
            const owner = this.pendingCabinet;
            if (!owner || owner.runId !== runId || owner.threadId !== threadId || owner.epoch !== epoch)
              throw new Error('Другой вход уже ожидает подтверждения. Текущий вход не изменён.');
            // Atomic pending-only CAS: never cancel a callback already exchanging a grant.
            if (!this.d.restartPending(epoch)) return this.view();
            epoch++; check();
            openFreshCabinet = true;
          } else if (account.state === 'signed-out') openFreshCabinet = true;
          else if (account.state !== 'connected') throw new Error('Не удалось проверить вход. Сохранённые подключения не изменены; повтори обновление.');
        }
        const phase = metadata.data.phase === 'work' ? 'verify' : metadata.data.phase;
        if (metadata.data.phase === 'work') {
          // A crash may leave phase=work before the ready record. Reverify in place.
          await this.d.sdk.threads.updatePluginMetadata({ threadId, set: { phase, binding, unified: true } }); check();
        }
        await this.save({ stage: phase, retryable: false, message: 'Продолжаю подключение в прежнем разговоре…' }, valid); check();
        if (openFreshCabinet) {
          try {
            const { authorizationUrl } = await this.d.begin();
            if (this.d.epoch() !== epoch + 1) throw new Error('Подключение изменилось.');
            epoch++; check();
            this.pendingCabinet = { runId, threadId, epoch, url: authorizationUrl };
            await this.save({ stage: 'cabinet', retryable: false, message: 'Подтверди новый вход в браузере. Уже выполненные шаги сохранятся.' }, valid); check();
            await this.d.open(authorizationUrl, binding.hostId, this.disposed.signal); check();
          } catch (error) {
            if (error instanceof OAuthBeginError && error.startedEpoch === epoch + 1 && error.failureEpoch === this.d.epoch()) {
              await this.checkPairingBinding({ threadId, binding }, this.disposed.signal);
              epoch = error.failureEpoch;
            }
            if (valid()) await this.save({ stage: 'error', retryable: true, message: 'Не удалось открыть новый вход. Нажми «Продолжить подключение», чтобы повторить; уже выполненные шаги сохранятся.' }, valid);
            throw error;
          }
        }
        await this.d.sdk.threads.send({ threadId, mode: 'auto', input: instructionInput(
          (phase === 'verify' ? 'Проверь native MCP через whoami. Ничего не устанавливай и не запускай MCP OAuth. ' : 'Продолжи незавершённое подключение svaib в этом разговоре. ') +
          (openFreshCabinet ? 'Новый вход кабинета уже открыт backend. Проверяй тот же вход через begin без reopenBrowser; не начинай новый OAuth. ' : 'Пользователь явно попросил продолжить подключение: при необходимости открой незавершённый вход кабинета через reopenBrowser. ') +
          'Сохрани работающие входы.') }); check();
        return this.view();
      }
      return this.startNew(input, onboardingStep);
    })().finally(() => { this.starting = null; this.startingSource = null; });
    return this.starting;
  }

  /** Called only with the host's already-confirmed selection, never model input. */
  connectSelectedFolder(input: SelectedFolderInput, fence: SelectionFence): Promise<{ threadId: string; environmentId: string; stage: 'verify' }> {
    const parsed = z.object({ projectId: z.string().min(1), hostId: z.string().min(1), path: z.string().min(1).max(800).refine(isAbsolute),
      providerId: z.enum(['codex', 'claude-code']), sourceThreadId: z.string().regex(/^thr_[a-z0-9]+$/).nullable(),
      stepId: onboardingActionSchema.shape.stepId }).strict().parse(input);
    const requestKey = JSON.stringify(parsed);
    if (this.selectedStarting) return this.selectedRequest === requestKey ? this.selectedStarting : Promise.reject(new Error('Уже открывается другая выбранная папка.'));
    if (this.starting || this.onboardingStarting) return Promise.reject(new Error('Другое подключение уже выполняется. Повтори выбор после его завершения.'));
    const flight = (async (): Promise<ConnectFlowView> => {
      const previous = await this.view();
      if (previous.stage !== 'ready' || !previous.threadId || !previous.binding) throw new Error('Сначала проверь действующее подключение партнёра.');
      const epoch = this.d.epoch(), priorPairing = this.pairing, identity = await this.d.proofs.identity();
      const account = await this.d.account();
      if (account.state !== 'connected' || !account.me || accountIdentity(account.me) !== identity.account_id || identity.epoch !== epoch ||
          this.d.epoch() !== epoch || this.state.runId !== previous.runId || this.state.threadId !== previous.threadId)
        throw new Error('Подключение изменилось. Повтори выбор папки.');
      const sourceThreadId = parsed.sourceThreadId ?? previous.threadId;
      const previousMetadata = connectionMetadataSchema.safeParse(await this.d.sdk.threads.getPluginMetadata({ threadId: previous.threadId }));
      if (!previousMetadata.success || previousMetadata.data.runId !== previous.runId || previousMetadata.data.phase !== 'work' || previousMetadata.data.successorThreadId ||
          (previousMetadata.data.targetHostId && previousMetadata.data.targetHostId !== previous.binding.hostId) ||
          (previousMetadata.data.binding && (['projectId', 'environmentId', 'hostId', 'providerId'] as const)
            .some(key => previousMetadata.data.binding![key] !== previous.binding![key])))
        throw new Error('Данные исходного подключения не совпадают с проверенным разговором.');
      const captured = previousMetadata.data.continuation
        ? checkContinuation(previousMetadata.data.continuation, previous.binding.projectId, previous.binding.environmentId) : undefined;
      if (captured?.data.expectedAccountId && captured.data.expectedAccountId !== identity.account_id)
        throw new Error('Ожидаемый аккаунт исходного поручения не совпадает с проверенным входом.');
      const snapshot = JSON.stringify(previousMetadata.data);
      const checkSource = async () => {
        await this.checkPairingBinding({ threadId: previous.threadId!, binding: previous.binding! }, this.disposed.signal);
        const source = await this.d.sdk.threads.get({ threadId: sourceThreadId });
        const metadata = connectionMetadataSchema.safeParse(await this.d.sdk.threads.getPluginMetadata({ threadId: previous.threadId! }));
        if (!source || source.id !== sourceThreadId || source.deletedAt || source.projectId !== previous.binding!.projectId ||
            source.environmentId !== previous.binding!.environmentId || source.providerId !== previous.binding!.providerId ||
            !metadata.success || JSON.stringify(metadata.data) !== snapshot || this.d.epoch() !== epoch)
          throw new Error('Исходный разговор или его поручение изменились. Повтори выбор папки.');
      };
      await checkSource();
      await fence('before');
      const canonical = await realpath(parsed.path), original = await stat(canonical);
      if (canonical !== parsed.path || !original.isDirectory()) throw new Error('Выбранная папка изменилась или недоступна.');
      const checkPath = async () => {
        const actual = await realpath(parsed.path), current = await stat(actual);
        if (actual !== canonical || !current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino)
          throw new Error('Выбранная папка изменилась. Повтори выбор.');
      };
      const checkProject = async () => {
        const [project, system] = await Promise.all([this.d.sdk.projects.get({ projectId: parsed.projectId }), this.d.sdk.system.config()]);
        if (project.id !== parsed.projectId || project.kind !== 'standard' || system.primaryHostId !== parsed.hostId)
          throw new Error('Выбранный проект или компьютер изменились.');
        const matches = await Promise.all(project.sources.filter(source => source.projectId === parsed.projectId && source.hostId === parsed.hostId && source.type === 'local_path')
          .map(async source => { try { return await realpath(source.path) === canonical; } catch { return false; } }));
        if (!matches.some(Boolean)) throw new Error('Выбранная папка не подключена к этому проекту.');
        await checkPath();
      };
      const checkIdentity = async () => {
        const fresh = await this.d.proofs.identity();
        if (this.d.epoch() !== epoch || fresh.account_id !== identity.account_id || fresh.client_id !== identity.client_id || fresh.epoch !== identity.epoch)
          throw new Error('Вход изменился. Повтори выбор папки.');
      };
      await checkProject(); await checkIdentity(); await checkSource();
      if (this.state.runId !== previous.runId || this.state.threadId !== previous.threadId) throw new Error('Подключение изменилось.');
      const runId = randomUUID(); let helperId: string | null = null, committed = false;
      try {
        const defaults = await this.d.sdk.projects.defaultExecutionOptions({ projectId: parsed.projectId });
        const execution = defaults?.providerId === parsed.providerId
          ? { model: defaults.model, permissionMode: defaults.permissionMode, reasoningLevel: defaults.reasoningLevel, serviceTier: defaults.serviceTier } : {};
        await fence('before'); await checkProject(); await checkIdentity(); await checkSource();
        if (this.state.runId !== previous.runId || this.state.threadId !== previous.threadId) throw new Error('Подключение изменилось.');
        const helper = await this.d.sdk.threads.spawn({ projectId: parsed.projectId, providerId: parsed.providerId,
          environment: { type: 'host', hostId: parsed.hostId, workspace: { type: 'unmanaged', path: parsed.path } },
          ...execution,
          title: 'Подготовка рабочего места', input: instructionInput('Дождись автоматической проверки выбранной папки. Ничего не делай: не вызывай инструменты, не запускай команды, не открывай входы и не меняй файлы.'),
          // Invalid connection phase deliberately receives neither connection nor Screen tools.
          pluginMetadata: { schema: 1, task: 'svaib-connect', phase: 'bootstrap', runId, targetHostId: parsed.hostId },
        });
        helperId = helper.id;
        const { current, env } = await this.waitForWorkspace(helper.id);
        const binding = connectionBindingSchema.parse({ projectId: current.projectId, environmentId: env.id, hostId: env.hostId, providerId: current.providerId });
        const checkHelper = async (successorThreadId?: string) => {
          const thread = await this.d.sdk.threads.get({ threadId: helper.id });
          const environment = await this.d.sdk.environments.get({ environmentId: binding.environmentId });
          const metadata = selectedBootstrapSchema.safeParse(await this.d.sdk.threads.getPluginMetadata({ threadId: helper.id }));
          if (!thread || thread.id !== helper.id || thread.deletedAt || thread.originPluginId !== this.d.pluginId || thread.originKind != null ||
              thread.projectId !== parsed.projectId || thread.environmentId !== binding.environmentId || thread.providerId !== parsed.providerId ||
              environment.id !== binding.environmentId || environment.projectId !== parsed.projectId || environment.hostId !== parsed.hostId ||
              environment.status !== 'ready' || environment.workspaceProvisionType !== 'unmanaged' || !environment.path ||
              await realpath(environment.path) !== canonical || !metadata.success || metadata.data.runId !== runId ||
              metadata.data.targetHostId !== parsed.hostId || metadata.data.successorThreadId !== successorThreadId) throw new Error('BB открыл другую рабочую среду.');
          await checkProject(); await checkIdentity(); await checkSource();
        };
        if (current.environmentId !== env.id || binding.projectId !== parsed.projectId || binding.hostId !== parsed.hostId || binding.providerId !== parsed.providerId)
          throw new Error('BB открыл другую рабочую среду.');
        await checkHelper(); await fence('after'); await checkHelper();
        if (this.state.runId !== previous.runId || this.state.threadId !== previous.threadId) throw new Error('Подключение изменилось.');
        const preserved = captured?.captured && ['onboarding', 'work-request'].includes(captured.data.scope) ? captured.data : undefined;
        const continuation = continuationSchema.parse({ version: 1, sourceThreadId, sourceProjectId: parsed.projectId,
          sourceEnvironmentId: binding.environmentId, captured: true, data: preserved ? { ...preserved, folder: parsed.path } : {
            scope: 'onboarding', intent: 'Продолжить выбранный путь svaib после выбора постоянной папки', folder: parsed.path,
            ...(captured?.captured && captured.data.expectedAccountId ? { expectedAccountId: captured.data.expectedAccountId } : {}),
            nextStep: `Продолжить этап ${parsed.stepId}`, materials: [], constraints: [], agreements: [] } });
        committed = true;
        await this.savePairing(null);
        await this.save({ ...empty(), runId, stage: 'setup', threadId: helper.id, binding, message: 'Проверяю выбранное рабочее место…' });
        const guard = async (successorThreadId?: string) => {
          const current = () => this.state.runId === runId && (this.state.threadId === helper.id || (!!successorThreadId && this.state.threadId === successorThreadId)) && this.d.epoch() === epoch;
          if (!current()) throw new Error('Подключение изменилось.');
          await fence('after'); await checkHelper(successorThreadId);
          if (!current()) throw new Error('Подключение изменилось.');
        };
        await this.freshVerification({ threadId: helper.id, projectId: parsed.projectId, signal: this.disposed.signal } as PluginAgentToolContext,
          undefined, true, parsed.stepId, { guard, skipPrepareHooks: true, bootstrap: continuation, verifyExistingOnly: true, committedIdentity: identity });
        const view = await this.view();
        if (view.stage !== 'verify' || !view.threadId || !view.binding || view.binding.environmentId !== binding.environmentId)
          throw new Error('Проверка рабочего места изменилась.');
        this.lastOnboardingAction = { runId, threadId: view.threadId, stepId: parsed.stepId };
        return view;
      } catch (error) {
        if (helperId && this.state.threadId !== helperId && committed && this.state.runId === runId) throw error;
        if (helperId) {
          try { const helper = await this.d.sdk.threads.get({ threadId: helperId });
            if (helper?.id === helperId && helper.originPluginId === this.d.pluginId && helper.originKind == null) await this.d.sdk.threads.stop({ threadId: helperId });
          } catch { /* Preserve state and surface the original failure. */ }
        }
        if (committed && this.d.epoch() === epoch && ((this.state.runId === runId && this.state.threadId === helperId) ||
            (this.state.runId === previous.runId && this.state.threadId === previous.threadId))) {
          await this.savePairing(priorPairing); await this.save(previous);
        } else if (committed && this.state.runId === runId && this.state.threadId === helperId) {
          await this.save({ stage: 'error', retryable: false, message: 'Вход изменился во время выбора папки. Проверь подключение и повтори выбор; данные сохранены.' });
        }
        throw error;
      }
    })();
    this.startingSource = parsed.sourceThreadId;
    this.starting = flight.finally(() => { this.starting = null; this.startingSource = null; });
    this.selectedRequest = requestKey;
    const result = this.starting.then(view => ({ threadId: view.threadId!, environmentId: view.binding!.environmentId, stage: 'verify' as const }));
    this.selectedStarting = result;
    void result.finally(() => { if (this.selectedStarting === result) { this.selectedStarting = null; this.selectedRequest = null; } }).catch(() => {});
    return result;
  }

  /** Explicit dashboard action; never infer a company or re-run a completed login. */
  continueOnboarding(value: OnboardingAction): Promise<z.infer<typeof onboardingActionResultSchema>> {
    const input = onboardingActionSchema.parse(value);
    const key = JSON.stringify(input);
    if (this.onboardingStarting) {
      if (key !== this.onboardingRequest) return Promise.reject(new Error('Уже открывается другой шаг. Дождись завершения.'));
      return this.onboardingStarting;
    }
    this.onboardingRequest = key;
    const run = (async () => {
      if (this.starting) await this.starting;
      let current = await this.view();
      if (!current.threadId || !current.binding) {
        current = await this.start({ projectId: input.projectId, threadId: input.threadId }, input.stepId);
        if (!current.threadId || !current.binding || current.stage === 'error') throw new Error(current.message || 'Не удалось открыть путь svaib.');
        return onboardingActionResultSchema.parse({ threadId: current.threadId });
      }
      const { threadId, binding, runId } = current;
      let expectedEpoch = this.d.epoch();
      if (input.threadId === threadId && input.projectId && input.projectId !== binding.projectId)
        throw new Error('Выбранный разговор относится к другому проекту. Проверь рабочее место.');
      if (input.threadId && input.threadId !== threadId) {
        const source = await this.d.sdk.threads.get({ threadId: input.threadId });
        if (!source || source.deletedAt || (input.projectId && source.projectId !== input.projectId) || !source.environmentId ||
            !['codex', 'claude-code'].includes(source.providerId))
          throw new Error('Этот разговор относится к другому рабочему месту. Открой путь в подходящем разговоре.');
        if (source.projectId !== binding.projectId || source.environmentId !== binding.environmentId || source.providerId !== binding.providerId) {
          if (current.stage !== 'ready') throw new Error('Сначала заверши текущее подключение; работающие входы сохранены.');
          const sourceProjectId = source.projectId, sourceEnvironmentId = source.environmentId, sourceProviderId = source.providerId;
          const env = await this.d.sdk.environments.get({ environmentId: sourceEnvironmentId });
          const primaryHostId = (await this.d.sdk.system.config()).primaryHostId;
          const target = connectionBindingSchema.parse({ projectId: sourceProjectId, environmentId: sourceEnvironmentId, hostId: env.hostId, providerId: sourceProviderId });
          const rechecked = await this.view();
          if (env.id !== target.environmentId || env.status !== 'ready' || env.hostId !== primaryHostId ||
              this.d.epoch() !== expectedEpoch || rechecked.stage !== 'ready' || rechecked.runId !== runId || rechecked.threadId !== threadId)
            throw new Error('Рабочее место изменилось или недоступно. Открой локальный разговор и повтори.');
          const next = await this.start({ projectId: target.projectId, threadId: input.threadId }, input.stepId, target);
          if (!next.threadId || !next.binding || next.stage === 'error' ||
              (['projectId', 'environmentId', 'hostId', 'providerId'] as const).some(key => next.binding![key] !== target[key]))
            throw new Error(next.message || 'Не удалось проверить выбранное рабочее место.');
          this.lastOnboardingAction = { runId: next.runId, threadId: next.threadId, stepId: input.stepId };
          return onboardingActionResultSchema.parse({ threadId: next.threadId });
        }
        // The source may predate MCP installation, including a predecessor of
        // the proof-bearing thread. Only the verified thread can run this step.
      }
      if (!input.threadId && input.projectId && input.projectId !== binding.projectId) {
        if (current.stage !== 'ready') throw new Error('Сначала заверши текущее подключение; работающие входы сохранены.');
        const next = await this.start({ projectId: input.projectId, threadId: null }, input.stepId, undefined, input.projectId);
        if (!next.threadId || !next.binding || next.stage === 'error' || next.binding.projectId !== input.projectId)
          throw new Error(next.message || 'Не удалось проверить выбранное рабочее место.');
        this.lastOnboardingAction = { runId: next.runId, threadId: next.threadId, stepId: input.stepId };
        return onboardingActionResultSchema.parse({ threadId: next.threadId });
      }
      if (current.stage === 'error' && !current.retryable) throw new Error(current.message || 'Сначала восстанови подключение.');
      if (!['setup', 'verify', 'cabinet', 'ready', 'error'].includes(current.stage)) throw new Error(current.message || 'Сначала восстанови подключение.');
      await this.checkPairingBinding({ threadId, binding }, this.disposed.signal);
      const metadata = connectionMetadataSchema.parse(await this.d.sdk.threads.getPluginMetadata({ threadId }));
      if (metadata.runId !== runId || (current.stage === 'ready' && metadata.phase !== 'work'))
        throw new Error('Разговор подключения изменился. Обнови страницу.');
      const stable = () => this.state.runId === runId && this.state.threadId === threadId &&
        this.d.epoch() === expectedEpoch && !this.disposed.signal.aborted;
      if (!stable()) throw new Error('Подключение изменилось. Обнови страницу.');
      if (['setup', 'verify', 'cabinet'].includes(current.stage) && this.lastOnboardingAction?.runId === runId &&
          this.lastOnboardingAction.threadId === threadId && this.lastOnboardingAction.stepId === input.stepId)
        return onboardingActionResultSchema.parse({ threadId });
      // The setup prompt already contains the complete onboarding assignment.
      // Reopening it must not queue duplicates or interrupt a question to the user.
      if (['setup', 'verify', 'cabinet'].includes(current.stage) && setupSteps.has(input.stepId) && metadata.continuation?.data.scope === 'onboarding')
        return onboardingActionResultSchema.parse({ threadId });
      // An explicit request can extend a connection-only run; never discard another task or its source.
      if (metadata.continuation && (metadata.continuation.captured || !metadata.continuation.sourceThreadId) && metadata.continuation.data.scope === 'connection-only') {
        const continuation = { ...metadata.continuation, captured: true, data: { ...metadata.continuation.data, scope: 'onboarding' as const,
          nextStep: 'Продолжить настройку пространства после подключения' } };
        await this.d.sdk.threads.updatePluginMetadata({ threadId, set: { continuation } });
        if (!stable()) throw new Error('Подключение изменилось. Обнови страницу.');
      }
      if (current.stage === 'error') {
        // Resume the existing owner with its existing receiver/grants; start() only
        // reopens a cabinet login when that particular login actually expired.
        const resumed = await this.start({ projectId: binding.projectId, threadId: null, restartCabinet: true }, input.stepId);
        if (resumed.threadId && resumed.threadId !== threadId && resumed.runId === runId && resumed.stage === 'verify' && resumed.binding &&
            (['projectId', 'environmentId', 'hostId', 'providerId'] as const).every(key => resumed.binding![key] === binding[key])) {
          const successor = connectionMetadataSchema.parse(await this.d.sdk.threads.getPluginMetadata({ threadId: resumed.threadId }));
          if (successor.runId !== runId || successor.previousThreadId !== threadId || successor.phase !== 'verify' || this.d.epoch() !== expectedEpoch)
            throw new Error('Проверка подключения изменилась. Обнови страницу.');
          await this.checkPairingBinding({ threadId: resumed.threadId, binding }, this.disposed.signal);
          this.lastOnboardingAction = { runId, threadId: resumed.threadId, stepId: input.stepId };
          return onboardingActionResultSchema.parse({ threadId: resumed.threadId });
        }
        if (resumed.threadId !== threadId || resumed.runId !== runId || resumed.stage === 'error')
          throw new Error(resumed.message || 'Не удалось продолжить подключение.');
        expectedEpoch = this.d.epoch();
      }
      await this.checkPairingBinding({ threadId, binding }, this.disposed.signal);
      if (current.stage === 'ready') {
        const rechecked = await this.view();
        if (rechecked.stage !== 'ready' || rechecked.runId !== runId || rechecked.threadId !== threadId)
          throw new Error('Подключение изменилось. Сначала проверь доступ партнёра.');
      }
      if (!stable()) throw new Error('Подключение изменилось. Обнови страницу.');
      const target = await this.d.sdk.threads.get({ threadId });
      const previous = this.lastOnboardingAction;
      if (!stable() || !target || target.deletedAt || target.projectId !== binding.projectId ||
          target.environmentId !== binding.environmentId || target.providerId !== binding.providerId ||
          target.originPluginId !== this.d.pluginId)
        throw new Error('Разговор или рабочее место изменились. Обнови страницу.');
      if (previous?.runId === runId && previous.threadId === threadId && previous.stepId === input.stepId &&
          ['starting', 'active'].includes(target.status))
        return onboardingActionResultSchema.parse({ threadId });
      await this.d.sdk.threads.send({ threadId, mode: 'queue-if-active', input: instructionInput(journeyPrompt(input.stepId)) });
      this.lastOnboardingAction = { runId, threadId, stepId: input.stepId };
      if (!stable()) throw new Error('Подключение изменилось после передачи поручения. Проверь открытый разговор.');
      return onboardingActionResultSchema.parse({ threadId });
    })();
    this.onboardingStarting = run;
    void run.finally(() => { if (this.onboardingStarting === run) { this.onboardingStarting = null; this.onboardingRequest = null; } }).catch(() => {});
    return run;
  }

  async startNative(input: z.infer<typeof nativeStartSchema>, ctx: PluginAgentToolContext) {
    const { binding } = await this.caller(ctx);
    const runId = this.state.runId, epoch = this.d.epoch();
    const valid = async () => {
      ctx.signal.throwIfAborted(); this.disposed.signal.throwIfAborted();
      if (this.state.runId !== runId || this.state.threadId !== ctx.threadId || this.d.epoch() !== epoch)
        throw new Error('Подключение изменилось.');
      await this.checkPairingBinding({ threadId: ctx.threadId, binding }, ctx.signal);
    };
    if (binding.providerId !== 'codex') throw new Error('Этот способ входа предназначен для Codex.');
    let native: Awaited<ReturnType<NativeLogin['start']>>;
    try { native = await this.native.start(input, { runId, threadId: ctx.threadId, binding }, valid); }
    catch (error) {
      await valid();
      await this.save({ stage: 'error', retryable: true, message: 'Вход не начат. Нажми «Продолжить подключение», чтобы повторить; работающие входы сохранены.' },
        () => this.state.runId === runId && this.state.threadId === ctx.threadId && this.d.epoch() === epoch);
      throw error;
    }
    await valid();
    await this.save({ stage: 'setup', retryable: true, message: native.message },
      () => this.state.runId === runId && this.state.threadId === ctx.threadId && this.d.epoch() === epoch);
    return { ...native, pending: true as const };
  }
  private async startNew(input: z.infer<typeof startFlowSchema>, onboardingStep?: string, expectedTarget?: Binding,
    expectedOwner?: { runId: string; threadId: string | null; epoch: number }, expectedProject?: string) {
    const { sdk } = this.d;
    // Explicitly starting another flow retires only our old unfinished helper.
    // Its record remains until real process exit; native.start enforces that fence.
    const retired = await this.native.retire();
    const verifyExistingAccess = !retired && await this.native.terminalUnavailable();
    if (input.threadId && !await this.threadExists(input.threadId)) throw new Error('Исходный разговор недоступен. Открой исходное поручение и повтори подключение.');
    if (input.continuation && !input.threadId) throw new Error('Для передачи поручения нужен явный исходный разговор.');
    const primaryHostId = (await sdk.system.config()).primaryHostId;
    if (!primaryHostId) throw new Error('BB ещё не подключён к компьютеру. Подключи coding agent в настройках BB.');
    let projectId = input.projectId;
    let sourceEnvironmentId: string | null = null;
    let environment: Parameters<PluginBbSdk['threads']['spawn']>[0]['environment'];
    let providerId: string | undefined;
    let execution: { model?: string; permissionMode?: 'auto' | 'accept-edits' | 'full'; reasoningLevel?: string; serviceTier?: string } = {};
    if (input.threadId) {
      const source = await sdk.threads.get({ threadId: input.threadId });
      if (projectId && projectId !== source.projectId) throw new Error('Рабочее место изменилось. Открой нужный разговор и повтори подключение.');
      if (!source.environmentId) throw new Error('Рабочее место ещё не готово. Повтори подключение после его запуска.');
      const env = await sdk.environments.get({ environmentId: source.environmentId });
      if (env.hostId !== primaryHostId) throw new Error('Этот вариант подключения пока работает только с локальным BB.');
      if (expectedTarget && (source.deletedAt || env.status !== 'ready' || env.id !== source.environmentId ||
          source.projectId !== expectedTarget.projectId || source.environmentId !== expectedTarget.environmentId ||
          source.providerId !== expectedTarget.providerId || env.hostId !== expectedTarget.hostId))
        throw new Error('Выбранное рабочее место изменилось. Повтори действие.');
      projectId = source.projectId; sourceEnvironmentId = env.id;
      providerId = source.providerId;
      const defaults = await sdk.threads.defaultExecutionOptions({ threadId: source.id });
      if (expectedTarget) {
        const again = await sdk.threads.get({ threadId: source.id });
        if (!again || again.deletedAt || again.projectId !== expectedTarget.projectId ||
            again.environmentId !== expectedTarget.environmentId || again.providerId !== expectedTarget.providerId ||
            (await sdk.system.config()).primaryHostId !== expectedTarget.hostId)
          throw new Error('Выбранный разговор изменился. Повтори действие.');
      }
      if (defaults) execution = { model: defaults.model, permissionMode: defaults.permissionMode, reasoningLevel: defaults.reasoningLevel, serviceTier: defaults.serviceTier };
      environment = { type: 'reuse', environmentId: env.id };
    } else {
      if (!projectId) {
        const projects = await sdk.projects.list({ includePersonal: true });
        projectId = projects.find(p => p.kind === 'personal')?.id ?? null;
      }
      if (!projectId) throw new Error('Открой проект или личный разговор BB и повтори подключение.');
      const project = await sdk.projects.get({ projectId });
      if (expectedProject && (project.id !== expectedProject || projectId !== expectedProject))
        throw new Error('Выбранный проект изменился. Повтори действие.');
      if (project.kind === 'personal') environment = { type: 'host', hostId: primaryHostId, workspace: { type: 'personal' } };
      else {
        const source = project.sources.find(s => s.isDefault);
        if (!source || source.hostId !== primaryHostId) throw new Error('Этот вариант подключения пока работает только с локальным BB.');
        environment = { type: 'project-default' };
      }
      const defaults = await sdk.projects.defaultExecutionOptions({ projectId });
      if (defaults) { providerId = defaults.providerId; execution = { ...defaults }; }
    }
    if (providerId && !['codex', 'claude-code'].includes(providerId)) throw new Error('Для подключения svaib выбери в BB Codex или Claude Code.');
    const onboarding = onboardingStep ? { intent: 'По кнопке продолжить выбранный этап пути svaib; прежнее содержимое исходного разговора не передано', scope: 'onboarding' as const,
      nextStep: `После проверки продолжить выбранный этап ${onboardingStep}`, materials: [], constraints: [], agreements: [] } : undefined;
    const continuation: Continuation = continuationSchema.parse({ version: 1,
      sourceThreadId: input.threadId, captured: !!input.continuation || !!onboarding, sourceProjectId: projectId, sourceEnvironmentId, data: input.continuation ?? onboarding ?? {
        intent: 'Подключить svaib', scope: 'connection-only', nextStep: 'Проверить подключение', materials: [], constraints: [], agreements: [] } });
    const runId = randomUUID();
    if (expectedOwner && (expectedTarget || expectedProject)) {
      const ready = await this.view();
      if (ready.stage !== 'ready' || ready.runId !== expectedOwner.runId || ready.threadId !== expectedOwner.threadId ||
          this.d.epoch() !== expectedOwner.epoch)
        throw new Error('Подключение или выбранный разговор изменились. Повтори действие.');
      if (expectedTarget) {
        const again = await sdk.threads.get({ threadId: input.threadId! });
        if (!again || again.deletedAt || again.projectId !== expectedTarget.projectId ||
            again.environmentId !== expectedTarget.environmentId || again.providerId !== expectedTarget.providerId)
          throw new Error('Подключение или выбранный разговор изменились. Повтори действие.');
      } else if (expectedProject) {
        const project = await sdk.projects.get({ projectId: expectedProject });
        if (project.id !== expectedProject || (project.kind !== 'personal' && !project.sources.some(s => s.isDefault && s.hostId === primaryHostId)) ||
            (await sdk.system.config()).primaryHostId !== primaryHostId || this.d.epoch() !== expectedOwner.epoch ||
            this.state.runId !== expectedOwner.runId || this.state.threadId !== expectedOwner.threadId)
          throw new Error('Выбранный проект или подключение изменились. Повтори действие.');
      }
    }
    await this.savePairing(null);
    await this.save({ ...empty(), verification: undefined, runId, stage: 'setup', message: 'Подключаю svaib…' });
    let createdThreadId: string | undefined;
    try {
      const initialPrompt = verifyExistingAccess
        ? 'Прежний процесс входа недоступен, его состояние неизвестно. Ничего не устанавливай, не запускай никакой OAuth и не вызывай инструменты: автоматическая проверка сохранённого доступа откроется в следующем разговоре.'
        : 'Подключи svaib целиком: партнёра и кабинет. Выполни техническую настройку сам; мне оставь подтверждение входа в браузере.' +
          (onboardingStep ? ` После подключения: ${journeyPrompt(onboardingStep)}` : '') +
          (!onboardingStep && continuation.captured && continuation.data.scope === 'onboarding' ? ` ${onboardingCommunication}` : '') +
          continuationPrompt(onboardingStep && !input.continuation ? { ...continuation, sourceThreadId: null } : continuation) +
          (onboardingStep && !input.continuation && input.threadId ? ' Исходный разговор указан только для выбора рабочего места. Его содержимое и договорённости не переданы; не читай его переписку и ничего из неё не предполагай. Выполни только выбранный пользователем этап.' : '');
      const thread = await sdk.threads.spawn({ projectId, environment, ...execution, ...(providerId ? { providerId } : {}),
        title: 'Подключение svaib', input: instructionInput(initialPrompt),
        // This recovery bootstrap has no user interaction; its successor is
        // the visible conversation. Keep the record for diagnostics without
        // cluttering the user's thread list or deleting a conversation.
        ...(verifyExistingAccess ? { visibility: 'hidden' as const } : {}),
        pluginMetadata: { schema: 1, task: 'svaib-connect', phase: 'setup', unified: true, runId, continuation, targetHostId: primaryHostId },
      });
      createdThreadId = thread.id;
      await this.save({ threadId: thread.id });
      // spawn returns before a new personal workspace has been provisioned.
      const { current, env } = await this.waitForWorkspace(thread.id);
      const binding = connectionBindingSchema.parse({ projectId: current.projectId, environmentId: env.id, hostId: env.hostId, providerId: current.providerId });
      if (binding.hostId !== primaryHostId) throw new Error('BB выбрал другое рабочее место. Подключение остановлено.');
      if ((expectedTarget || expectedProject) && (current.id !== thread.id || current.deletedAt ||
          current.environmentId !== env.id || current.originPluginId !== this.d.pluginId))
        throw new Error('BB выбрал другое рабочее место. Подключение остановлено.');
      if (expectedProject && (binding.projectId !== expectedProject || !['codex', 'claude-code'].includes(binding.providerId)))
        throw new Error('BB выбрал другой проект или неподдерживаемый агент. Подключение остановлено.');
      if (expectedTarget && (['projectId', 'environmentId', 'hostId', 'providerId'] as const).some(key => binding[key] !== expectedTarget[key]))
        throw new Error('BB выбрал другое рабочее место. Подключение остановлено.');
      if (expectedTarget || expectedProject) {
        const again = await sdk.threads.get({ threadId: thread.id });
        const finalEnv = await sdk.environments.get({ environmentId: binding.environmentId });
        if (!again || again.deletedAt || again.id !== thread.id || again.originPluginId !== this.d.pluginId ||
            again.projectId !== binding.projectId || again.environmentId !== binding.environmentId || again.providerId !== binding.providerId ||
            finalEnv.id !== binding.environmentId || finalEnv.status !== 'ready' || finalEnv.hostId !== binding.hostId ||
            (await sdk.system.config()).primaryHostId !== binding.hostId)
          throw new Error('Рабочее место изменилось во время подготовки. Подключение остановлено.');
      }
      await this.save({ threadId: thread.id, binding });
      if (verifyExistingAccess) {
        const next = await this.freshVerification({ threadId: thread.id, projectId: binding.projectId, signal: this.disposed.signal } as PluginAgentToolContext, undefined, true, onboardingStep);
        if (onboardingStep) {
          this.lastOnboardingAction = { runId, threadId: next.threadId, stepId: onboardingStep };
        }
      }
      return this.view();
    } catch {
      if (this.state.runId !== runId) return this.view();
      if (createdThreadId) await sdk.threads.stop({ threadId: createdThreadId });
      await this.save({ stage: 'error', message: createdThreadId
        ? 'BB не завершил подготовку рабочего места. Разговор настройки остановлен. Повтори подключение.'
        : 'Не удалось создать разговор настройки. Проверь выбранную модель в BB и повтори.' });
      return this.view();
    }
  }

  private async waitForWorkspace(threadId: string) {
    const { sdk } = this.d;
    const deadline = Date.now() + 30_000;
    do {
      this.disposed.signal.throwIfAborted();
      const current = await sdk.threads.get({ threadId });
      if (current.environmentId) {
        const env = await sdk.environments.get({ environmentId: current.environmentId });
        if (env.status === 'ready') return { current, env };
        if (['error', 'destroyed'].includes(env.status)) break;
      }
      if (current.status === 'error' || current.deletedAt) break;
      await delay(250, undefined, { signal: this.disposed.signal });
    } while (Date.now() < deadline);
    throw new Error('workspace_not_ready');
  }

  private async caller(ctx: PluginAgentToolContext, duringStart = false, allowReady = false) {
    if (this.starting && !duringStart) await this.starting;
    const allowed = ['setup', 'verify', 'cabinet'].includes(this.state.stage) || (this.state.stage === 'error' && this.state.retryable) ||
      (allowReady && this.state.stage === 'ready');
    if (ctx.threadId !== this.state.threadId || !this.state.binding || !allowed) {
      throw new Error('Этот разговор не выполняет текущее подключение svaib. Начни подключение со страницы рабочего места.');
    }
    const thread = await this.d.sdk.threads.get({ threadId: ctx.threadId });
    const env = thread.environmentId ? await this.d.sdk.environments.get({ environmentId: thread.environmentId }) : null;
    const b = this.state.binding;
    if (thread.originPluginId !== this.d.pluginId || thread.projectId !== b.projectId || thread.environmentId !== b.environmentId || thread.providerId !== b.providerId || env?.hostId !== b.hostId) {
      throw new Error('Разговор или рабочее место подключения изменились. Подключение остановлено.');
    }
    return { thread, binding: b };
  }

  async freshVerification(ctx: PluginAgentToolContext, updates?: ContinuationInput, duringStart = false, onboardingStep?: string,
    options?: { guard: (successorThreadId?: string) => Promise<void>; skipPrepareHooks: boolean; bootstrap?: Continuation; verifyExistingOnly?: boolean; committedIdentity?: WorkplaceIdentity }): Promise<VerificationHandoff> {
    // An agent can call this as soon as its setup thread starts. Do not claim
    // the verification flight while waiting for start(): recovery itself may
    // need that flight to create the successor before start() can resolve.
    if (this.starting && !duringStart) {
      await this.starting;
      return this.freshVerification(ctx, updates);
    }
    if (ctx.threadId !== this.state.threadId) {
      const raw = await this.d.sdk.threads.getPluginMetadata({ threadId: ctx.threadId });
      const metadata = connectionMetadataSchema.safeParse(raw), bootstrap = selectedBootstrapSchema.safeParse(raw);
      const linked = metadata.success ? metadata.data : bootstrap.success ? bootstrap.data : null;
      if (linked && linked.runId === this.state.runId && linked.successorThreadId === this.state.threadId) {
        await this.checkPairingBinding({ threadId: this.state.threadId!, binding: this.state.binding! }, ctx.signal);
        return { threadId: this.state.threadId!, handedOff: true as const, message: `Продолжение уже открыто: @thread:${this.state.threadId}. Помоги перейти туда; не повторяй вход.` };
      }
    }
    if (this.verifying && ctx.threadId === this.state.threadId) return this.verifying;
    const flight = this.beginVerification(ctx, updates, duringStart, onboardingStep, options);
    this.verifying = flight;
    try { return await flight; } finally { if (this.verifying === flight) this.verifying = null; }
  }

  private async beginVerification(ctx: PluginAgentToolContext, updates?: ContinuationInput, duringStart = false, onboardingStep?: string,
    options?: { guard: (successorThreadId?: string) => Promise<void>; skipPrepareHooks: boolean; bootstrap?: Continuation; verifyExistingOnly?: boolean; committedIdentity?: WorkplaceIdentity }) {
    const { thread: source, binding } = await this.caller(ctx, duringStart);
    const runId = this.state.runId;
    if (!['setup', 'verify'].includes(this.state.stage))
      throw new Error('Свежая проверка уже запущена. Не повторяй вход или установку.');
    const rawMetadata = await this.d.sdk.threads.getPluginMetadata({ threadId: source.id });
    const bootstrap = options?.bootstrap ? selectedBootstrapSchema.parse(rawMetadata) : null;
    const metadata = bootstrap ? null : connectionMetadataSchema.parse(rawMetadata);
    if (bootstrap ? bootstrap.runId !== runId || bootstrap.targetHostId !== binding.hostId || !!bootstrap.successorThreadId
      : metadata!.runId !== runId || metadata!.phase !== 'setup') throw new Error('Свежая проверка уже запущена или контекст изменился.');
    let continuation = options?.bootstrap ? checkContinuation(options.bootstrap, binding.projectId, binding.environmentId)
      : metadata?.continuation ? checkContinuation(metadata.continuation, binding.projectId, binding.environmentId) : undefined;
    if (updates) { if (!continuation) throw new Error('Нет исходной передачи.'); continuation = mergeContinuation(continuation, updates); }
    if (binding.providerId === 'codex' && this.d.prepareHooks && !options?.skipPrepareHooks) {
      const prepared = await this.d.prepareHooks(ctx);
      if (prepared.state !== 'trusted') throw new Error('Доверие хукам svaib не подтверждено.');
      await this.caller(ctx, duringStart);
      if (this.state.runId !== runId || this.state.threadId !== source.id) throw new Error('Подключение изменилось.');
    }
    const defaults = await this.d.sdk.threads.defaultExecutionOptions({ threadId: source.id });
    if (this.state.runId !== runId || this.state.threadId !== source.id) throw new Error('Подключение изменилось. Повтори со страницы рабочего места.');
    await options?.guard();
    if (this.state.runId !== runId || this.state.threadId !== source.id) throw new Error('Подключение изменилось. Повтори со страницы рабочего места.');
    const thread = await this.d.sdk.threads.spawn({ projectId: binding.projectId,
      environment: { type: 'reuse', environmentId: binding.environmentId }, providerId: binding.providerId,
      ...(defaults ? { model: defaults.model, permissionMode: defaults.permissionMode, reasoningLevel: defaults.reasoningLevel, serviceTier: defaults.serviceTier } : {}),
      title: 'Партнёр svaib', input: instructionInput(('Продолжи проверку svaib: вызови native MCP whoami. Ничего не переустанавливай и не запускай повторный MCP OAuth.') + continuationPrompt(continuation, source.id) +
        (onboardingStep ? ` После проверки: ${journeyPrompt(onboardingStep)}` :
          continuation?.captured && continuation.data.scope === 'onboarding' ? ` ${onboardingCommunication}` : '') +
        (options?.bootstrap ? ' Папка выбрана человеком; это не подтверждает компанию или структуру и не разрешает запись. После whoami ограниченно прочитай последние сообщения указанного исходного разговора через bb thread log, чтобы восстановить договорённости; не копируй полную переписку, не угадывай согласия и не считай выбор папки разрешением на запись.' : '')),
      pluginMetadata: { schema: 1, task: 'svaib-connect', phase: 'verify', binding, unified: true, runId, ...(continuation ? { continuation } : {}),
        ...(options?.verifyExistingOnly ? { verifyExistingOnly: true } : {}), previousThreadId: source.id, targetHostId: binding.hostId },
    });
    // spawn starts the turn immediately and can outlive an RPC cancellation or
    // a change to the source chat. Fence again before recording any handoff.
    try { await options?.guard(); }
    catch (error) {
      try { await this.d.sdk.threads.stop({ threadId: thread.id }); }
      catch { throw new Error('Проверка прервана, но BB не подтвердил остановку нового разговора. Открой BB и проверь его состояние.'); }
      throw error;
    }
    if (this.state.runId !== runId || this.state.threadId !== source.id) {
      await this.d.sdk.threads.stop({ threadId: thread.id });
      throw new Error('Разговор подключения удалён или заменён. Начни подключение со страницы рабочего места.');
    }
    const ownsSource = () => this.state.runId === runId && this.state.threadId === source.id && !this.disposed.signal.aborted;
    try {
      await this.d.sdk.threads.updatePluginMetadata({ threadId: source.id, set: { successorThreadId: thread.id } });
      if (!ownsSource()) throw new Error('Подключение изменилось.');
      await options?.guard(thread.id);
      await this.save({ stage: 'verify', threadId: thread.id, message: 'Проверяю доступ партнёра…' }, () => this.state.runId === runId && [source.id, thread.id].includes(this.state.threadId!) && !this.disposed.signal.aborted);
      await options?.guard(thread.id);
      await this.savePairing(null);
      await options?.guard(thread.id);
    } catch (error) {
      let stopFailed = false;
      try { await this.d.sdk.threads.stop({ threadId: thread.id }); } catch { stopFailed = true; }
      let unlinkFailed = false;
      try {
        const raw = await this.d.sdk.threads.getPluginMetadata({ threadId: source.id });
        const latest = connectionMetadataSchema.safeParse(raw), latestBootstrap = selectedBootstrapSchema.safeParse(raw);
        const linked = latest.success ? latest.data : latestBootstrap.success ? latestBootstrap.data : null;
        if (linked && linked.runId === runId && linked.successorThreadId === thread.id)
          await this.d.sdk.threads.updatePluginMetadata({ threadId: source.id, remove: ['successorThreadId'] });
      } catch { unlinkFailed = true; }
      if (options?.guard && this.state.runId === runId && this.state.threadId === thread.id)
        await this.save({ stage: 'setup', threadId: source.id, message: 'Проверка рабочего места прервана.' },
          () => this.state.runId === runId && [source.id, thread.id].includes(this.state.threadId!));
      if (stopFailed) throw new Error('Проверка прервана, но BB не подтвердил остановку нового разговора. Открой BB и проверь его состояние.');
      if (unlinkFailed) throw new Error('Проверка прервана, но BB не подтвердил очистку служебной ссылки. Повтори выбор после обновления страницы.');
      throw error;
    }
    // Commit: the successor is now the persisted flow owner, and the last
    // fence passed. Later cancellation of the old chat cannot undo it.
    try { await this.d.sdk.threads.open({ threadId: thread.id, file: null }); }
    catch (error) {
      if (options?.bootstrap && options.committedIdentity) throw new CommittedOpenError(thread.id, options.committedIdentity);
      throw error;
    }
    // Keep the plugin-owned setup conversation and its workspace intact, but
    // remove it from the sidebar after the successor is open. Archive would
    // retire a managed workspace that the successor may still be using.
    if (this.state.runId === runId && this.state.threadId === thread.id) {
      try {
        const previous = await this.d.sdk.threads.get({ threadId: source.id });
        const raw = await this.d.sdk.threads.getPluginMetadata({ threadId: source.id });
        const oldMetadata = connectionMetadataSchema.safeParse(raw), oldBootstrap = selectedBootstrapSchema.safeParse(raw);
        const linked = oldMetadata.success ? oldMetadata.data : oldBootstrap.success ? oldBootstrap.data : null;
        if (this.state.runId === runId && this.state.threadId === thread.id && previous?.originPluginId === this.d.pluginId && previous.originKind == null &&
            !previous.deletedAt && linked && linked.runId === runId && linked.successorThreadId === thread.id)
          await this.d.sdk.threads.update({ threadId: source.id, visibility: 'hidden' });
      } catch { /* A visibility failure must not undo the completed handoff. */ }
    }
    return { threadId: thread.id, handedOff: true as const, message: 'Проверка открыта в новом разговоре. Настройка в исходном разговоре окончена: заверши ответ и больше не вызывай whoami, finish или OAuth здесь. Подключение завершит новый разговор.' };
  }

  async waitForMcp(terminalId: string, ctx: PluginAgentToolContext, updates?: ContinuationInput) {
    const { binding } = await this.caller(ctx);
    const runId = this.state.runId, epoch = this.d.epoch();
    const env = await this.d.sdk.environments.get({ environmentId: binding.environmentId });
    const signal = AbortSignal.any([ctx.signal, this.disposed.signal]);
    const current = () => !signal.aborted && this.state.runId === runId && this.state.threadId === ctx.threadId && this.d.epoch() === epoch;
    const deadline = Date.now() + (this.d.waitSliceMs ?? 20_000);
    do {
      signal.throwIfAborted();
      const owner = { runId, threadId: ctx.threadId, binding };
      if (this.native.owns(owner)) {
        const owned = await this.native.status(owner);
        if (owned?.unavailable) {
          await this.save({ stage: 'error', retryable: true, message: NATIVE_TERMINAL_MISSING }, current);
          throw new Error(NATIVE_TERMINAL_MISSING);
        }
        if (owned?.terminalId !== terminalId) throw new Error('Выбран другой процесс входа. Продолжи текущий вход со страницы svaib.');
      }
      const terminal = await this.d.sdk.terminals.get({ terminalId });
      if (terminal.hostId !== binding.hostId || terminal.initialCwd !== env.path) throw new Error('Терминал входа относится к другому рабочему месту.');
      if (!current()) throw new Error('Подключение изменилось.');
      if (terminal.status === 'disconnected') {
        await this.save({ stage: 'error', retryable: true, message: NATIVE_TERMINAL_MISSING }, current);
        throw new Error(NATIVE_TERMINAL_MISSING);
      }
      if (!['running', 'starting'].includes(terminal.status)) {
        if (terminal.exitCode !== 0) {
          const technicalFailure = terminal.exitCode === 20;
          const message = technicalFailure ? NATIVE_TECHNICAL_ERROR : 'Процесс входа партнёра завершился без подтверждения. Нажми «Продолжить подключение» на странице svaib в BB: повторится только незавершённый вход партнёра. Уже работающий вход кабинета сохранён.';
          await this.save({ stage: 'error', retryable: !technicalFailure, message }, current);
          throw new Error(message);
        }
        return this.freshVerification(ctx, updates);
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
        signal.addEventListener('abort', abort, { once: true });
      });
    } while (Date.now() < deadline);
    return { pending: true as const, step: 'mcp' as const, terminalId, threadId: ctx.threadId,
      message: 'Вход ещё ожидает подтверждения. Продолжай ждать тем же инструментом и terminalId; не запускай новый OAuth и не открывай вторую вкладку.' };
  }

  private savePairing(next: Pairing | null, valid = () => true): Promise<void> {
    const previous = this.pairing;
    if (!valid()) return Promise.reject(new Error('Подключение изменилось.'));
    this.releasePairingAbort?.(); this.releasePairingAbort = null;
    this.pairedRuntimeEpoch = next?.state === 'verified' ? this.d.epoch() : null;
    this.pairing = next;
    const pending = this.saves.then(async () => {
      if (valid()) await this.d.kv.set(pairingKey, next);
      if (!valid()) {
        if (this.pairing === next) this.pairing = previous;
        await this.d.kv.set(pairingKey, this.pairing);
        throw new Error('Подключение изменилось.');
      }
    });
    this.saves = pending.catch(() => {}); return pending;
  }

  private bindPairingCancellation(signal: AbortSignal) {
    this.releasePairingAbort?.();
    const owner = this.pairing;
    const abort = () => {
      if (owner?.state === 'active' && this.pairing === owner) void this.savePairing(null).catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    this.releasePairingAbort = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  }

  /** Cabinet OAuth first. No native readiness is claimed by this tool. */
  preparePairing(ctx: PluginAgentToolContext, reopenBrowser = false, updates?: ContinuationInput): Promise<PairingStart> {
    if (ctx.threadId !== this.state.threadId) return Promise.reject(new Error('Этот разговор не выполняет текущее подключение svaib.'));
    if (this.pairingStarting) return this.pairingStarting;
    this.pairingStarting = this.beginPairing(ctx, reopenBrowser, updates).finally(() => { this.pairingStarting = null; });
    return this.pairingStarting;
  }

  /** Set up the cabinet independently; native whoami is observed locally. */
  prepareCabinet(ctx: PluginAgentToolContext, reopenBrowser = false, updates?: ContinuationInput): Promise<PairingStart> {
    if (ctx.threadId !== this.state.threadId) return Promise.reject(new Error('Этот разговор не выполняет текущее подключение svaib.'));
    if (this.pairingStarting) return this.pairingStarting;
    this.pairingStarting = this.beginPairing(ctx, reopenBrowser, updates, true).finally(() => { this.pairingStarting = null; });
    return this.pairingStarting;
  }

  private async beginPairing(ctx: PluginAgentToolContext, reopenBrowser: boolean, updates?: ContinuationInput, cabinetOnly = false): Promise<PairingStart> {
    const { binding } = await this.caller(ctx);
    const runId = this.state.runId;
    let epoch = this.d.epoch();
    const signal = AbortSignal.any([ctx.signal, this.disposed.signal]);
    const valid = () => !signal.aborted && this.state.runId === runId && this.state.threadId === ctx.threadId &&
      JSON.stringify(this.state.binding) === JSON.stringify(binding) && this.d.epoch() === epoch;
    const check = () => { signal.throwIfAborted(); if (!valid()) throw new Error('Подключение изменилось.'); };
    check();
    if (updates) {
      const metadata = connectionMetadataSchema.parse(await this.d.sdk.threads.getPluginMetadata({ threadId: ctx.threadId })); check();
      if (metadata.runId !== runId || !metadata.continuation) throw new Error('Нет исходной передачи этого подключения.');
      const original = checkContinuation(metadata.continuation, binding.projectId, binding.environmentId);
      const continuation = mergeContinuation(original, updates);
      await this.d.sdk.threads.updatePluginMetadata({ threadId: ctx.threadId, set: { continuation } }); check();
    }
    let account = await this.d.account(); check();
    if (account.state !== 'connected') {
      const currentMetadata = connectionMetadataSchema.parse(await this.d.sdk.threads.getPluginMetadata({ threadId: ctx.threadId })); check();
      if (currentMetadata.verifyExistingOnly || currentMetadata.continuation?.data.constraints.includes(noNewOauthConstraint))
        throw new Error('Сохранённый вход недоступен. В этой проверке новый OAuth не запускается.');
      if (await this.native.terminalUnavailable()) {
        check();
        throw new Error('Сохранённый вход кабинета не подтверждён, а состояние прежнего процесса входа неизвестно. Новый OAuth не запускался; проверь подключение вручную.');
      }
      check();
      const own = this.pendingCabinet?.runId === runId && this.pendingCabinet.threadId === ctx.threadId && this.pendingCabinet.epoch === epoch;
      if (account.state === 'waiting') {
        if (!own) throw new Error('Другой вход в кабинет уже ожидает подтверждения.');
        if (reopenBrowser) { await this.d.open(this.pendingCabinet!.url, binding.hostId, signal); check(); }
      } else {
        if (this.pendingCabinet && !reopenBrowser) throw new Error('Время входа истекло. Повторное открытие входа — только по просьбе пользователя.');
        const { authorizationUrl } = await this.d.begin();
        if (this.state.runId !== runId || this.state.threadId !== ctx.threadId || this.d.epoch() !== epoch + 1)
          throw new Error('Подключение изменилось.');
        epoch++; check();
        this.pendingCabinet = { runId, threadId: ctx.threadId, epoch, url: authorizationUrl };
        await this.save({ stage: 'cabinet', retryable: false, message: 'Подтверди вход в открывшемся браузере…' }, valid); check();
        await this.d.open(authorizationUrl, binding.hostId, signal); check();
      }
      await this.save({ stage: 'cabinet', retryable: false, message: 'Подтверди вход в открывшемся браузере…' }, valid); check();
      const confirmed = await this.waitForCabinet(signal); check();
      if (!confirmed) return { connected: false, pending: true, step: 'cabinet', threadId: ctx.threadId,
        message: 'Вход ожидает подтверждения. Повтори svaib_connect_begin без нового OAuth; вкладку открывай повторно только по просьбе пользователя.' };
      account = confirmed;
    }
    if (cabinetOnly) {
      this.pendingCabinet = null;
      await this.save({ stage: 'verify', retryable: false, message: 'Кабинет подключён. Проверь партнёра в разговоре.' }, valid);
      return { connected: false, step: 'native', threadId: ctx.threadId,
        message: 'Кабинет подключён. Вызови whoami партнёра; сверка аккаунтов необязательна для работы.' };
    }
    const identity = await this.d.proofs.identity(signal); check();
    const metadata = connectionMetadataSchema.parse(await this.d.sdk.threads.getPluginMetadata({ threadId: ctx.threadId })); check();
    const continuation = metadata.continuation ? checkContinuation(metadata.continuation, binding.projectId, binding.environmentId) : undefined;
    if (continuation?.data.expectedAccountId && continuation.data.expectedAccountId !== identity.account_id)
      throw new Error('Вход выполнен в другой аккаунт, чем указан в исходном поручении. Сохранённые входы не изменены; уточни, какой вход человек хочет использовать.');
    if (!account.me || accountIdentity(account.me) !== identity.account_id || identity.epoch !== epoch)
      throw new Error('Подключение изменилось.');
    await this.caller(ctx); check();
    const previous = this.pairing;
    if (previous?.state === 'active' && previous.runId === runId && previous.threadId === ctx.threadId &&
        previous.epoch === epoch && previous.accountId === identity.account_id && previous.clientId === identity.client_id &&
        previous.challenge.expires_at > Math.floor(Date.now() / 1000)) {
      this.bindPairingCancellation(ctx.signal); check();
      return { connected: false, step: 'proof', ...previous.challenge, threadId: ctx.threadId };
    }
    const events = await this.d.sdk.threads.events.list({ threadId: ctx.threadId, order: 'desc', limit: '1' }); check();
    const sinceSeq = Math.max(0, ...events.map(event => event.seq));
    const challenge = challengeSchema.parse(await this.d.proofs.begin(signal)); check(); checkProofTime(challenge);
    const after = await this.d.proofs.identity(signal); check();
    if (JSON.stringify(after) !== JSON.stringify(identity)) throw new Error('Подключение изменилось.');
    await this.caller(ctx); check();
    await this.savePairing({ state: 'active', runId, threadId: ctx.threadId, binding, epoch,
      accountId: identity.account_id, clientId: identity.client_id, challenge, sinceSeq }, valid); check();
    this.bindPairingCancellation(ctx.signal); check();
    this.pendingCabinet = null;
    await this.save({ stage: 'verify', retryable: false, message: 'Аккаунт подключён. Проверяем второй вход партнёра…' }, valid); check();
    return { connected: false, step: 'proof', ...challenge, threadId: ctx.threadId };
  }

  private async completePairing(proof: string, ctx: PluginAgentToolContext): Promise<CompletionResult> {
    opaqueProof.parse(proof);
    ctx.signal.throwIfAborted();
    await this.caller(ctx, false, true);
    const p = this.pairing;
    const epoch = this.d.epoch();
    if (this.state.stage === 'ready' && p?.state === 'verified' && p.proofDigest === digest(proof) &&
        (await this.view()).stage === 'ready') {
      ctx.signal.throwIfAborted();
      if (this.pairing !== p || this.d.epoch() !== epoch || this.state.threadId !== ctx.threadId)
        throw new Error('Подключение изменилось.');
      await this.checkPairingBinding(p, ctx.signal);
      if (this.pairing !== p || this.d.epoch() !== epoch || this.state.threadId !== ctx.threadId || this.state.stage !== 'ready')
        throw new Error('Подключение изменилось.');
      return { connected: true, subject: p.accountId, threadId: ctx.threadId };
    }
    if (!p || p.state !== 'active' || p.runId !== this.state.runId || p.threadId !== ctx.threadId)
      throw new Error('Сначала получи текущий challenge через svaib_connect_begin.');
    if (this.completing) {
      if (this.completionOwner?.threadId !== ctx.threadId || this.completionOwner.subject !== digest(proof))
        throw new Error('Уже проверяется другое подтверждение.');
      return this.completing;
    }
    this.completionOwner = { threadId: ctx.threadId, subject: digest(proof) };
    const flight = this.finishPairing(proof, ctx, p);
    this.completing = flight;
    try { return await flight; } finally {
      if (this.completing === flight) { this.completing = null; this.completionOwner = null; }
    }
  }

  private async finishPairing(proof: string, ctx: PluginAgentToolContext, initial: z.infer<typeof activePairing>): Promise<CompletionResult> {
    const signal = AbortSignal.any([ctx.signal, this.disposed.signal]);
    let owned: Pairing = initial;
    const sameRun = () => this.state.runId === initial.runId && this.state.threadId === initial.threadId;
    const valid = () => sameRun() && this.pairing === owned && this.d.epoch() === initial.epoch &&
      JSON.stringify(this.state.binding) === JSON.stringify(initial.binding) && !signal.aborted;
    const check = () => { signal.throwIfAborted(); if (!valid()) throw new Error('Подключение изменилось.'); };
    const snapshot = async () => {
      check(); checkProofTime(initial.challenge);
      await this.caller(ctx, false, true); check();
      const identity = await this.d.proofs.identity(signal); check();
      if (identity.account_id !== initial.accountId || identity.client_id !== initial.clientId || identity.epoch !== initial.epoch)
        throw new Error('Подключение изменилось.');
      const anchor = await nativePairingAnchor(this.d.sdk, ctx.threadId, initial.challenge, initial.sinceSeq); check();
      // Identity/events reads may yield after caller(). Revalidate actual BB
      // binding after those awaits, including the final post-persistence check.
      // Independent public reads are observed slices, never an atomic joint
      // binding/timeline snapshot or continuous native-grant authorization.
      await this.checkPairingBinding(initial, signal); check();
      return anchor;
    };
    let phaseAttempted = false;
    let previousPhase: 'setup' | 'verify' = 'verify';
    const initialMetadata = connectionMetadataSchema.safeParse(await this.d.sdk.threads.getPluginMetadata({ threadId: ctx.threadId }));
    check();
    if (!initialMetadata.success || initialMetadata.data.runId !== initial.runId) throw new Error('Подключение изменилось.');
    if (initialMetadata.data.phase === 'setup' && initial.binding.providerId === 'codex' && this.d.prepareHooks) {
      const prepared = await this.d.prepareHooks(ctx); check();
      await this.checkPairingBinding(initial, signal); check();
      if (prepared.state !== 'trusted') throw new Error('Доверие хукам svaib не подтверждено.');
      if (prepared.changed) {
        const fresh = await this.freshVerification(ctx);
        return { connected: false, pending: true, step: 'fresh', ...fresh };
      }
    }
    try {
      const anchor = await snapshot();
      const receipt = verifiedProofSchema.parse(await this.d.proofs.verify(proof, signal)); check(); checkProofTime(receipt);
      if (receipt.nonce !== initial.challenge.nonce || receipt.account_id !== initial.accountId ||
          receipt.verifier_client_id !== initial.clientId || receipt.issuer_client_id === initial.clientId ||
          receipt.expires_at > initial.challenge.expires_at || receipt.issued_at < initial.challenge.issued_at)
        throw new Error('Серверное подтверждение не соответствует текущему подключению.');
      const fence = async () => {
        if (JSON.stringify(await snapshot()) !== JSON.stringify(anchor)) throw new Error('Native вызов изменился во время проверки.');
      };
      await fence();
      const metadata = connectionMetadataSchema.safeParse(await this.d.sdk.threads.getPluginMetadata({ threadId: ctx.threadId })); check();
      if (!metadata.success || metadata.data.runId !== initial.runId) throw new Error('Подключение изменилось.');
      previousPhase = metadata.data.phase === 'setup' ? 'setup' : 'verify';
      phaseAttempted = true;
      await this.d.sdk.threads.updatePluginMetadata({ threadId: ctx.threadId, set: { phase: 'work' } });
      await fence();
      const provisional = { runId: initial.runId, threadId: ctx.threadId, previous: structuredClone(this.state) };
      this.provisionalReady = provisional;
      owned = { ...initial, state: 'verified', proofDigest: digest(proof), receipt };
      // Strip the expired challenge and baseline from persisted completed evidence.
      const ready = readyPairing.parse(owned); owned = ready;
      await this.savePairing(ready, () => sameRun() && this.d.epoch() === initial.epoch && !signal.aborted);
      await fence();
      await this.save({ stage: 'ready', retryable: false, subject: initial.accountId, verification: 'signed-grants',
        message: 'Два входа svaib проверены для этого подключения.' }, valid);
      await fence();
      if (this.provisionalReady === provisional) this.provisionalReady = null;
      this.pendingCabinet = null;
      this.d.changed(); check();
      return { connected: true, subject: initial.accountId, threadId: ctx.threadId };
    } catch {
      if (sameRun()) {
        const message = signal.aborted ? 'Проверка прервана. Сохранённые входы остались; получи новый challenge.'
          : 'Серверное подтверждение не принято. Сохрани входы и получи новый challenge через svaib_connect_begin.';
        // Withdraw readiness before waiting for rollback. Never include an opaque receipt in errors.
        const rollback = this.save({ stage: 'error', retryable: true, subject: null, message }, sameRun);
        this.provisionalReady = null;
        await rollback;
        if (this.pairing === owned || this.pairing === initial) await this.savePairing(null, sameRun);
        if (phaseAttempted && sameRun()) {
          const metadata = connectionMetadataSchema.safeParse(await this.d.sdk.threads.getPluginMetadata({ threadId: ctx.threadId }));
          if (sameRun() && metadata.success && metadata.data.runId === initial.runId && metadata.data.phase === 'work')
            await this.d.sdk.threads.updatePluginMetadata({ threadId: ctx.threadId, set: { phase: previousPhase } });
        }
      }
      throw new Error('Подтверждение подключения не принято. Сохранённые входы не изменены; получи новый challenge.');
    } finally {
      if (this.provisionalReady?.runId === initial.runId) this.provisionalReady = null;
    }
  }

  async complete(proof: string, ctx: PluginAgentToolContext): Promise<CompletionResult> {
    return this.completePairing(proof, ctx);
  }

  private waitForCabinet(signal: AbortSignal): Promise<AccountView | null> {
    return new Promise((resolve, reject) => {
      let checking = false;
      let again = false;
      let settled = false;
      const finish = (error?: Error, account?: AccountView) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (this.checkCabinet === checkAccount) this.checkCabinet = null;
        error ? reject(error) : resolve(account ?? null);
      };
      const abort = () => finish(new Error('cancelled'));
      const timer = setTimeout(() => finish(), this.d.waitSliceMs ?? 20_000);
      const checkAccount = () => {
        if (settled) return;
        if (checking) { again = true; return; }
        checking = true;
        void this.d.account().then(account => {
          if (account.state === 'connected') finish(undefined, account);
          else if (account.state !== 'waiting') finish(new Error('login_failed'));
        }, () => finish(new Error('login_failed'))).finally(() => {
          checking = false;
          if (again && !settled) { again = false; checkAccount(); }
        });
      };
      this.checkCabinet = checkAccount;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else this.checkCabinet();
    });
  }
  async failed(threadId: string) {
    if (threadId === this.state.threadId && ['setup', 'verify'].includes(this.state.stage)) {
      await this.save({ stage: 'error', retryable: true, message: 'Агент не завершил подключение. Продолжи в этом разговоре или со страницы рабочего места.' });
    }
  }
  dispose() { this.releasePairingAbort?.(); this.releasePairingAbort = null; this.disposed.abort(); }
}
