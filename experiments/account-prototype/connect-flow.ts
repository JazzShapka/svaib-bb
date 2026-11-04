import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { PluginBbSdk, PluginKvStorage, PluginAgentToolContext } from '@get-bb/plugin-sdk';
import { continuationInputSchema, continuationSchema, continuationPrompt, checkContinuation, mergeContinuation, type ContinuationInput, type Continuation } from './continuation';
import { accountIdentity, type AccountView } from './contracts';
import { connectionBindingSchema, connectionMetadataSchema } from './connection';
import { OAuthBeginError } from './oauth';
import { NativeLogin, nativeStartSchema, NATIVE_TECHNICAL_ERROR, NATIVE_TERMINAL_MISSING } from './native-login';
import { legacyVerifiedReceiptSchema, type WorkplaceIdentity } from './workplace-identity';

export const flowSchema = z.object({
  stage: z.enum(['idle', 'setup', 'verify', 'cabinet', 'ready', 'error']),
  runId: z.string(), threadId: z.string().nullable(),
  binding: connectionBindingSchema.nullable(), subject: z.string().nullable(),
  message: z.string(), retryable: z.boolean().default(false),
  verification: z.literal('signed-grants').optional(),
});
export type ConnectFlowView = z.infer<typeof flowSchema>;
export const startFlowSchema = z.object({ projectId: z.string().min(1).nullable(), threadId: z.string().min(1).nullable(), restartCabinet: z.boolean().optional(), continuation: continuationInputSchema.optional() }).strict();
type Binding = z.infer<typeof connectionBindingSchema>;
type VerificationHandoff = { threadId: string; handedOff: true; message: string };
const noNewOauthConstraint = 'Проверяй только существующие входы; новый OAuth не запускай.';
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
const empty = (): ConnectFlowView => ({ stage: 'idle', runId: '', threadId: null, binding: null, subject: null, message: '', retryable: false });
const key = 'connection-flow-v1';
const pairingKey = 'connection-flow-proof-v1'; // Same existing technical KV; no account progress or server store.
const pairingOwner = z.object({ runId: z.string(), threadId: z.string(), binding: connectionBindingSchema,
  accountId: z.string(), clientId: z.string(), epoch: z.number().int() });
const readyPairing = pairingOwner.extend({ state: z.literal('verified'), proofDigest: z.string(), receipt: legacyVerifiedReceiptSchema });
type Pairing = z.infer<typeof readyPairing>;
type CabinetStart = { connected: false; pending: true; step: 'cabinet'; threadId: string; message: string } |
  { connected: false; step: 'native'; threadId: string; message: string };
type Dependencies = {
  sdk: PluginBbSdk; kv: PluginKvStorage; pluginId: string;
  account: () => Promise<AccountView>;
  begin: () => Promise<{ authorizationUrl: string }>;
  cancel: () => void;
  restartPending: (expectedEpoch: number) => boolean;
  epoch: () => number;
  waitSliceMs?: number;
  identity(signal?: AbortSignal): Promise<WorkplaceIdentity>;
  open: (url: string, hostId: string, signal: AbortSignal) => Promise<void>;
  prepareHooks?: (ctx: PluginAgentToolContext) => Promise<{ state: 'trusted'; changed: boolean } | { state: 'declined' }>;
  changed: () => void;
};
/** One explicit user action owns installation, native verification and cabinet OAuth. */
export class ConnectFlow {
  private state = empty();
  private starting: Promise<ConnectFlowView> | null = null;
  private startingSource: string | null = null;
  private verifying: Promise<VerificationHandoff> | null = null;
  private pendingCabinet: { runId: string; threadId: string; epoch: number; url: string } | null = null;
  private disposed = new AbortController();
  private checkCabinet: (() => void) | null = null;
  private saves: Promise<void> = Promise.resolve();
  private pairing: Pairing | null = null;
  private cabinetStarting: Promise<CabinetStart> | null = null;
  private pairedRuntimeEpoch: number | null = null;
  private native: NativeLogin;
  private nativeChecking: { runId: string; threadId: string } | null = null;
  constructor(private d: Dependencies) { this.native = new NativeLogin(d.sdk, d.kv, d.pluginId); }

  async load() {
    await this.native.load();
    const parsed = flowSchema.safeParse(await this.d.kv.get(key));
    if (parsed.success) this.state = parsed.data;
    const proof = readyPairing.safeParse(await this.d.kv.get(pairingKey));
    // Read historical receipts for existing ready states; never mint or restore a proof challenge.
    if (proof.success && proof.data.state === 'verified' && proof.data.runId === this.state.runId &&
        proof.data.threadId === this.state.threadId && proof.data.accountId === this.state.subject) {
      this.pairing = proof.data; this.pairedRuntimeEpoch = this.d.epoch();
    }
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
          : native.running && native.retiring ? 'Завершаю предыдущую попытку входа. Продолжи разговор с партнёром чуть позже.'
          : native.running ? 'Ожидаю результат входа Codex. Если вкладка устарела или закрыта, продолжи разговор с партнёром.'
          : native.success ? 'Вход завершён. Продолжи разговор с партнёром, чтобы проверить доступ партнёра.'
            : 'Вход прервался. Продолжи разговор с партнёром, чтобы проверить и при необходимости повторить незавершённый вход.';
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
          message: 'Вход не завершён или время ожидания истекло. Продолжи разговор с партнёром: повторится только незавершённый вход кабинета.' },
        () => this.pendingCabinet === owner && this.state.runId === owner.runId && this.state.threadId === owner.threadId && this.d.epoch() === epoch);
      }
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
      const identity = await this.d.identity();
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

  start(input: z.infer<typeof startFlowSchema>): Promise<ConnectFlowView> {
    input = startFlowSchema.parse(input);
    if (this.starting) {
      if (input.continuation && input.threadId !== this.startingSource) return Promise.reject(new Error('Уже передаётся поручение из другого разговора.'));
      return this.starting;
    }
    this.startingSource = input.threadId;
    this.starting = (async () => {
      const current = await this.view();
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
            await this.freshVerification({ threadId, projectId: binding.projectId, signal: this.disposed.signal } as PluginAgentToolContext, undefined, true);
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
            if (valid()) await this.save({ stage: 'error', retryable: true, message: 'Не удалось открыть новый вход. Продолжи разговор с партнёром, чтобы повторить; уже выполненные шаги сохранятся.' }, valid);
            throw error;
          }
        }
        await this.d.sdk.threads.send({ threadId, mode: 'auto', input: instructionInput(
          (phase === 'verify' ? 'Проверь native MCP через whoami. Ничего не устанавливай и не запускай MCP OAuth. ' : 'Продолжи незавершённое подключение svaib в этом разговоре. ') +
          (openFreshCabinet ? 'Новый вход кабинета уже открыт backend. Проверяй тот же вход через begin без reopenBrowser; не начинай новый OAuth. ' : 'Пользователь явно попросил продолжить подключение: при необходимости открой незавершённый вход кабинета через reopenBrowser. ') +
          'Сохрани работающие входы.') }); check();
        return this.view();
      }
      return this.startNew(input);
    })().finally(() => { this.starting = null; this.startingSource = null; });
    return this.starting;
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
      await this.save({ stage: 'error', retryable: true, message: 'Вход не начат. Продолжи разговор с партнёром, чтобы повторить; работающие входы сохранены.' },
        () => this.state.runId === runId && this.state.threadId === ctx.threadId && this.d.epoch() === epoch);
      throw error;
    }
    await valid();
    await this.save({ stage: 'setup', retryable: true, message: native.message },
      () => this.state.runId === runId && this.state.threadId === ctx.threadId && this.d.epoch() === epoch);
    return { ...native, pending: true as const };
  }
  private async startNew(input: z.infer<typeof startFlowSchema>) {
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
      projectId = source.projectId; sourceEnvironmentId = env.id;
      providerId = source.providerId;
      const defaults = await sdk.threads.defaultExecutionOptions({ threadId: source.id });
      if (defaults) execution = { model: defaults.model, permissionMode: defaults.permissionMode, reasoningLevel: defaults.reasoningLevel, serviceTier: defaults.serviceTier };
      environment = { type: 'reuse', environmentId: env.id };
    } else {
      if (!projectId) {
        const projects = await sdk.projects.list({ includePersonal: true });
        projectId = projects.find(p => p.kind === 'personal')?.id ?? null;
      }
      if (!projectId) throw new Error('Открой проект или личный разговор BB и повтори подключение.');
      const project = await sdk.projects.get({ projectId });
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
    const continuation: Continuation = continuationSchema.parse({ version: 1,
      sourceThreadId: input.threadId, captured: !!input.continuation, sourceProjectId: projectId, sourceEnvironmentId, data: input.continuation ?? {
        intent: 'Подключить svaib', scope: 'connection-only', nextStep: 'Проверить подключение', materials: [], constraints: [], agreements: [] } });
    const runId = randomUUID();
    await this.savePairing(null);
    await this.save({ ...empty(), verification: undefined, runId, stage: 'setup', message: 'Подключаю svaib…' });
    let createdThreadId: string | undefined;
    try {
      const initialPrompt = verifyExistingAccess
        ? 'Прежний процесс входа недоступен, его состояние неизвестно. Ничего не устанавливай, не запускай никакой OAuth и не вызывай инструменты: автоматическая проверка сохранённого доступа откроется в следующем разговоре.'
        : 'Подключи svaib целиком: партнёра и кабинет. Выполни техническую настройку сам; мне оставь подтверждение входа в браузере.' +
          (continuation.captured && continuation.data.scope === 'onboarding' ? ` ${onboardingCommunication}` : '') +
          continuationPrompt(continuation);
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
      await this.save({ threadId: thread.id, binding });
      if (verifyExistingAccess) {
        await this.freshVerification({ threadId: thread.id, projectId: binding.projectId, signal: this.disposed.signal } as PluginAgentToolContext, undefined, true);
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

  async freshVerification(ctx: PluginAgentToolContext, updates?: ContinuationInput, duringStart = false): Promise<VerificationHandoff> {
    // An agent can call this as soon as its setup thread starts. Do not claim
    // the verification flight while waiting for start(): recovery itself may
    // need that flight to create the successor before start() can resolve.
    if (this.starting && !duringStart) {
      await this.starting;
      return this.freshVerification(ctx, updates);
    }
    if (ctx.threadId !== this.state.threadId) {
      const raw = await this.d.sdk.threads.getPluginMetadata({ threadId: ctx.threadId });
      const metadata = connectionMetadataSchema.safeParse(raw);
      const linked = metadata.success ? metadata.data : null;
      if (linked && linked.runId === this.state.runId && linked.successorThreadId === this.state.threadId) {
        await this.checkPairingBinding({ threadId: this.state.threadId!, binding: this.state.binding! }, ctx.signal);
        return { threadId: this.state.threadId!, handedOff: true as const, message: `Продолжение уже открыто: @thread:${this.state.threadId}. Помоги перейти туда; не повторяй вход.` };
      }
    }
    if (this.verifying && ctx.threadId === this.state.threadId) return this.verifying;
    const flight = this.beginVerification(ctx, updates, duringStart);
    this.verifying = flight;
    try { return await flight; } finally { if (this.verifying === flight) this.verifying = null; }
  }

  private async beginVerification(ctx: PluginAgentToolContext, updates?: ContinuationInput, duringStart = false) {
    const { thread: source, binding } = await this.caller(ctx, duringStart);
    const runId = this.state.runId;
    if (!['setup', 'verify'].includes(this.state.stage))
      throw new Error('Свежая проверка уже запущена. Не повторяй вход или установку.');
    const rawMetadata = await this.d.sdk.threads.getPluginMetadata({ threadId: source.id });
    const metadata = connectionMetadataSchema.parse(rawMetadata);
    if (metadata.runId !== runId || metadata.phase !== 'setup') throw new Error('Свежая проверка уже запущена или контекст изменился.');
    let continuation = metadata.continuation ? checkContinuation(metadata.continuation, binding.projectId, binding.environmentId) : undefined;
    if (updates) { if (!continuation) throw new Error('Нет исходной передачи.'); continuation = mergeContinuation(continuation, updates); }
    if (binding.providerId === 'codex' && this.d.prepareHooks) {
      const prepared = await this.d.prepareHooks(ctx);
      if (prepared.state !== 'trusted') throw new Error('Доверие хукам svaib не подтверждено.');
      await this.caller(ctx, duringStart);
      if (this.state.runId !== runId || this.state.threadId !== source.id) throw new Error('Подключение изменилось.');
    }
    const defaults = await this.d.sdk.threads.defaultExecutionOptions({ threadId: source.id });
    if (this.state.runId !== runId || this.state.threadId !== source.id) throw new Error('Подключение изменилось. Повтори со страницы рабочего места.');
    const thread = await this.d.sdk.threads.spawn({ projectId: binding.projectId,
      environment: { type: 'reuse', environmentId: binding.environmentId }, providerId: binding.providerId,
      ...(defaults ? { model: defaults.model, permissionMode: defaults.permissionMode, reasoningLevel: defaults.reasoningLevel, serviceTier: defaults.serviceTier } : {}),
      title: 'Партнёр svaib', input: instructionInput(('Продолжи проверку svaib: вызови native MCP whoami. Ничего не переустанавливай и не запускай повторный MCP OAuth.') + continuationPrompt(continuation, source.id) +
        (continuation?.captured && continuation.data.scope === 'onboarding' ? ` ${onboardingCommunication}` : '')),
      pluginMetadata: { schema: 1, task: 'svaib-connect', phase: 'verify', binding, unified: true, runId, ...(continuation ? { continuation } : {}),
        previousThreadId: source.id, targetHostId: binding.hostId },
    });
    // spawn starts the turn immediately and can outlive an RPC cancellation or
    // a change to the source chat. Fence again before recording any handoff.
    if (this.state.runId !== runId || this.state.threadId !== source.id) {
      await this.d.sdk.threads.stop({ threadId: thread.id });
      throw new Error('Разговор подключения удалён или заменён. Начни подключение со страницы рабочего места.');
    }
    const ownsSource = () => this.state.runId === runId && this.state.threadId === source.id && !this.disposed.signal.aborted;
    try {
      await this.d.sdk.threads.updatePluginMetadata({ threadId: source.id, set: { successorThreadId: thread.id } });
      if (!ownsSource()) throw new Error('Подключение изменилось.');
      await this.save({ stage: 'verify', threadId: thread.id, message: 'Проверяю доступ партнёра…' }, () => this.state.runId === runId && [source.id, thread.id].includes(this.state.threadId!) && !this.disposed.signal.aborted);
      await this.savePairing(null);
    } catch (error) {
      let stopFailed = false;
      try { await this.d.sdk.threads.stop({ threadId: thread.id }); } catch { stopFailed = true; }
      let unlinkFailed = false;
      try {
        const raw = await this.d.sdk.threads.getPluginMetadata({ threadId: source.id });
        const latest = connectionMetadataSchema.safeParse(raw);
        const linked = latest.success ? latest.data : null;
        if (linked && linked.runId === runId && linked.successorThreadId === thread.id)
          await this.d.sdk.threads.updatePluginMetadata({ threadId: source.id, remove: ['successorThreadId'] });
      } catch { unlinkFailed = true; }
      if (stopFailed) throw new Error('Проверка прервана, но BB не подтвердил остановку нового разговора. Открой BB и проверь его состояние.');
      if (unlinkFailed) throw new Error('Проверка прервана, но BB не подтвердил очистку служебной ссылки. Повтори выбор после обновления страницы.');
      throw error;
    }
    // Commit: the successor is now the persisted flow owner, and the last
    // fence passed. Later cancellation of the old chat cannot undo it.
    await this.d.sdk.threads.open({ threadId: thread.id, file: null });
    // Keep the plugin-owned setup conversation and its workspace intact, but
    // remove it from the sidebar after the successor is open. Archive would
    // retire a managed workspace that the successor may still be using.
    if (this.state.runId === runId && this.state.threadId === thread.id) {
      try {
        const previous = await this.d.sdk.threads.get({ threadId: source.id });
        const raw = await this.d.sdk.threads.getPluginMetadata({ threadId: source.id });
        const oldMetadata = connectionMetadataSchema.safeParse(raw);
        const linked = oldMetadata.success ? oldMetadata.data : null;
        if (this.state.runId === runId && this.state.threadId === thread.id && previous?.originPluginId === this.d.pluginId && previous.originKind == null &&
            !previous.deletedAt && linked && linked.runId === runId && linked.successorThreadId === thread.id)
          await this.d.sdk.threads.update({ threadId: source.id, visibility: 'hidden' });
      } catch { /* A visibility failure must not undo the completed handoff. */ }
    }
    return { threadId: thread.id, handedOff: true as const, message: 'Проверка открыта в новом разговоре. Настройка в исходном разговоре окончена: заверши ответ и больше не вызывай whoami или OAuth здесь. Подключение завершит новый разговор.' };
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
          const message = technicalFailure ? NATIVE_TECHNICAL_ERROR : 'Процесс входа партнёра завершился без подтверждения. Продолжи разговор с партнёром в BB: он проверит и при необходимости повторит только незавершённый вход. Уже работающий вход кабинета сохранён.';
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

  /** Set up the cabinet independently; native whoami is observed locally. */
  prepareCabinet(ctx: PluginAgentToolContext, reopenBrowser = false, updates?: ContinuationInput): Promise<CabinetStart> {
    if (ctx.threadId !== this.state.threadId) return Promise.reject(new Error('Этот разговор не выполняет текущее подключение svaib.'));
    if (this.cabinetStarting) return this.cabinetStarting;
    this.cabinetStarting = this.beginCabinet(ctx, reopenBrowser, updates).finally(() => { this.cabinetStarting = null; });
    return this.cabinetStarting;
  }

  private async beginCabinet(ctx: PluginAgentToolContext, reopenBrowser: boolean, updates?: ContinuationInput): Promise<CabinetStart> {
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
    this.pendingCabinet = null;
    await this.save({ stage: 'verify', retryable: false, message: 'Кабинет подключён. Проверь партнёра в разговоре.' }, valid);
    return { connected: false, step: 'native', threadId: ctx.threadId,
      message: 'Кабинет подключён. Вызови whoami партнёра; сверка аккаунтов необязательна для работы.' };
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
  dispose() { this.disposed.abort(); }
}
