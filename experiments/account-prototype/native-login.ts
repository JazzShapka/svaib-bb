import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { PluginBbSdk, PluginKvStorage } from '@get-bb/plugin-sdk';
import { connectionBindingSchema, type ConnectionBinding } from './connection';

export const NATIVE_TOOL = 'svaib_connect_native_start';
export const nativeStartSchema = z.object({ executable: z.string().refine(isAbsolute), configRoot: z.string().refine(isAbsolute),
  serverKey: z.enum(['svaib', 'plugin:svaib:svaib']) }).strict();
type Input = z.infer<typeof nativeStartSchema>;
type Owner = { runId: string; threadId: string; binding: ConnectionBinding };
const recordSchema = z.object({ runId: z.string(), threadId: z.string(), binding: connectionBindingSchema,
  terminalId: z.string(), startedAt: z.number(), input: nativeStartSchema, retiring: z.boolean().optional() }).strict();
type Record = z.infer<typeof recordSchema>;
const key = 'connection-native-login-v1';
export const NATIVE_TECHNICAL_ERROR = 'Не удалось проверить доступ партнёра. Вход кабинета сохранён. Продолжи в разговоре BB: повторный вход сейчас не поможет.';
export const NATIVE_TERMINAL_MISSING = 'Прежний терминал входа больше недоступен. Проверим сохранённый доступ без повторного входа; данные и работающие входы сохранены.';
class NativeTerminalMissing extends Error {}
const exited = (terminal: Awaited<ReturnType<PluginBbSdk['terminals']['get']>>) =>
  terminal.status === 'exited' && terminal.closeReason === 'process-exit' && terminal.exitCode !== null;

/** Only terminals created here may receive Continue input. Their output is never read. */
export class NativeLogin {
  private record: Record | null = null;
  private starting: Promise<{ terminalId: string; message: string; finished: boolean }> | null = null;
  constructor(private sdk: PluginBbSdk, private kv: PluginKvStorage, private pluginId: string) {}
  async load() { const parsed = recordSchema.safeParse(await this.kv.get(key)); if (parsed.success) this.record = parsed.data; }
  owns(owner: Owner) { return !!this.record && this.record.runId === owner.runId && this.record.threadId === owner.threadId &&
    JSON.stringify(this.record.binding) === JSON.stringify(owner.binding); }
  async terminalUnavailable() {
    const record = this.record;
    if (!record) return false;
    const status = await this.status({ runId: record.runId, threadId: record.threadId, binding: record.binding });
    return this.record === record && status?.unavailable === true;
  }
  private async terminal(owner: Owner) {
    if (!this.owns(owner)) throw new Error('Этот процесс входа относится к другому подключению.');
    const record = this.record!;
    let terminal: Awaited<ReturnType<PluginBbSdk['terminals']['get']>>;
    try { terminal = await this.sdk.terminals.get({ terminalId: record.terminalId }); }
    catch (error) {
      // The exact terminal-specific 404 is not proof that the old process has
      // exited. Preserve its record and fence any replacement login.
      if (error instanceof Error && /^HTTP 404: Terminal session not found\s*$/.test(error.message)) throw new NativeTerminalMissing(NATIVE_TERMINAL_MISSING);
      throw error;
    }
    const environment = await this.sdk.environments.get({ environmentId: owner.binding.environmentId });
    if (!this.owns(owner) || this.record !== record || terminal.hostId !== owner.binding.hostId ||
        terminal.threadId !== owner.threadId || terminal.environmentId !== owner.binding.environmentId ||
        environment.hostId !== owner.binding.hostId || terminal.initialCwd !== environment.path)
      throw new Error('Рабочее место процесса входа изменилось.');
    return { terminal, record, environment };
  }
  async status(owner: Owner) {
    if (!this.owns(owner)) return null;
    const expectedRecord = this.record;
    let result: Awaited<ReturnType<NativeLogin['terminal']>>;
    try { result = await this.terminal(owner); }
    catch (error) {
      if (error instanceof NativeTerminalMissing && this.record === expectedRecord && this.owns(owner)) return { terminalId: this.record!.terminalId,
        running: false, success: false, retiring: this.record!.retiring === true, technicalFailure: false, unavailable: true };
      throw error;
    }
    const { terminal, record } = result;
    const running = ['running', 'starting'].includes(terminal.status);
    return { terminalId: terminal.id, running, success: exited(terminal) && terminal.exitCode === 0,
      retiring: record.retiring === true, technicalFailure: exited(terminal) && terminal.exitCode === 20, unavailable: !running && !exited(terminal) };
  }
  start(input: Input, owner: Owner, valid: () => Promise<void>) {
    if (this.starting) return this.starting.then(async result => {
      await valid();
      if (!this.owns(owner)) throw new Error('Другой разговор уже запускает вход. Его процесс не изменён.');
      return result;
    });
    this.starting = this.create(input, owner, valid).finally(() => { this.starting = null; });
    return this.starting;
  }
  private async create(input: Input, owner: Owner, valid: () => Promise<void>) {
    input = nativeStartSchema.parse(input); await valid();
    if (this.record && (!this.owns(owner) || this.record.retiring)) {
      if (!await this.retire()) throw new Error('Предыдущая попытка входа ещё завершается. Продолжи разговор с партнёром чуть позже; второй вход не запущен.');
      await valid();
    }
    const previous = await this.status(owner); await valid();
    if (previous?.unavailable) throw new Error(NATIVE_TERMINAL_MISSING);
    if (previous && JSON.stringify(this.record!.input) !== JSON.stringify(input))
      throw new Error('Профиль текущего входа не совпал. Уже работающий вход не изменён.');
    if (previous?.running || previous?.success) return { terminalId: previous.terminalId, finished: previous.success,
      message: previous.running ? 'Вход уже ожидает подтверждения в браузере.' : 'Штатный вход завершён; теперь проверим доступ в BB.' };
    const [system, plugins, environment, cli] = await Promise.all([this.sdk.system.config(), this.sdk.plugins.list(),
      this.sdk.environments.get({ environmentId: owner.binding.environmentId }), this.sdk.hosts.providerCliStatus({ hostId: owner.binding.hostId })]); await valid();
    const plugin = plugins.plugins.find(item => item.id === this.pluginId);
    if (!plugin?.rootDir || !environment.path || system.primaryHostId !== owner.binding.hostId || environment.hostId !== owner.binding.hostId || owner.binding.providerId !== 'codex')
      throw new Error('Управляемый вход доступен только на проверенном локальном рабочем месте Codex.');
    if (!cli.codex?.installed || cli.codex.executablePath !== input.executable || !['0.166.0', 'codex-cli 0.166.0'].includes(cli.codex.currentVersion ?? ''))
      throw new Error('Выбранный Codex не совпал с проверенным executable этого рабочего места.');
    const helper = join(plugin.rootDir, 'experiments/account-prototype/skills/svaib-workplace-connect/scripts/codex_oauth_login.py');
    const argv = ['python3', helper, '--codex', input.executable, '--config-root', input.configRoot, '--server-key', input.serverKey,
      '--cwd', environment.path, '--thread-id', owner.threadId, '--project-id', owner.binding.projectId,
      '--environment-id', owner.binding.environmentId, '--host-id', owner.binding.hostId];
    const terminal = await this.sdk.terminals.create({ scope: { kind: 'thread', threadId: owner.threadId },
      start: { mode: 'argv', argv }, title: 'Вход svaib · Codex', cols: 80, rows: 24 });
    const record: Record = { ...owner, terminalId: terminal.id, startedAt: Date.now(), input };
    this.record = record;
    try { await valid(); await this.terminal(owner); await valid(); await this.kv.set(key, record); await valid(); }
    catch (error) {
      await this.cancelCreated(terminal.id);
      // Keep the owned terminal discoverable until its graceful shutdown really
      // finishes, even if its flow became stale while create() was in flight.
      if (this.record === record) {
        record.retiring = true;
        await this.kv.set(key, record).catch(() => {});
      }
      throw error;
    }
    return { terminalId: terminal.id, finished: false, message: 'Подтверди вход в браузере. Если вернёшься позже, продолжи разговор с партнёром — выполненные шаги сохранятся.' };
  }
  private async cancelCreated(terminalId: string) {
    // The owned helper closes its native app-server with EOF and waits for real
    // exit. Never force-kill a process that may be persisting native credentials.
    await this.sdk.terminals.input({ terminalId, dataBase64: Buffer.from('cancel\n').toString('base64') }).catch(() => {});
  }
  async retire(owner?: Owner): Promise<boolean> {
    if (!this.record || (owner && !this.owns(owner))) return true;
    const record = this.record;
    const oldOwner = { runId: record.runId, threadId: record.threadId, binding: record.binding };
    let terminal: Awaited<ReturnType<NativeLogin['terminal']>>['terminal'];
    try { ({ terminal } = await this.terminal(oldOwner)); }
    catch (error) { if (error instanceof NativeTerminalMissing) return false; throw error; }
    if (!['running', 'starting'].includes(terminal.status)) return exited(terminal);
    record.retiring = true;
    await this.kv.set(key, record);
    await this.sdk.terminals.input({ terminalId: terminal.id, dataBase64: Buffer.from('cancel\n').toString('base64') });
    // A cancel request is not proof of exit. Do not overwrite this record or
    // launch another native process while EOF/shutdown may still be pending.
    for (let check = 0; check < 10; check++) {
      const after = await this.terminal(oldOwner);
      if (!['running', 'starting'].includes(after.terminal.status)) return exited(after.terminal);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  }
  async continue(owner: Owner, valid: () => Promise<void>) {
    await valid(); const { terminal, record } = await this.terminal(owner); await valid();
    if (record.retiring) return this.start(record.input, owner, valid);
    if (['running', 'starting'].includes(terminal.status)) {
      // The helper keeps the URL private. Near its deadline it shuts down its
      // own native process first, then checks native credential status before retry.
      // Only the helper knows the current native attempt's deadline after an
      // in-process renewal; an outer terminal timestamp would become stale.
      await this.sdk.terminals.input({ terminalId: terminal.id, dataBase64: Buffer.from('reopen\n').toString('base64') }); await valid();
      return { terminalId: terminal.id, finished: false, message: 'Продолжаю вход Codex. Уже работающий доступ сохранится.' };
    }
    if (!exited(terminal)) throw new Error(NATIVE_TERMINAL_MISSING);
    if (terminal.exitCode === 0) return { terminalId: terminal.id, finished: true, message: 'Штатный вход завершён; теперь проверим доступ в BB.' };
    if (terminal.exitCode === 20) throw new Error(NATIVE_TECHNICAL_ERROR);
    return this.start(record.input, owner, valid);
  }
}
