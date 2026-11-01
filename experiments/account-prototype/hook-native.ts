import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { approveHooks, inspectHooks } from './hook-trust';

/** A separate control process makes no model calls and never reads credential files. */
export async function withCodexHooks<T>(input: { executable: string; cwd: string }, signal: AbortSignal,
  operation: (rpc: (method: string, params: Record<string, unknown>) => Promise<any>) => Promise<T>,
  configRoot = join(homedir(), '.codex')): Promise<T> {
  if (!isAbsolute(input.executable) || !isAbsolute(input.cwd)) throw new Error('Не установлено рабочее место Codex.');
  if (process.env.CODEX_HOME && resolve(process.env.CODEX_HOME) !== configRoot) throw new Error('Нестандартный профиль Codex пока не поддерживается.');
  signal.throwIfAborted();
  const child = spawn(input.executable, ['app-server', '--stdio'], { cwd: input.cwd,
    env: { ...process.env, CODEX_HOME: configRoot }, stdio: ['pipe', 'pipe', 'ignore'], shell: false });
  const reader = createInterface({ input: child.stdout });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let id = 0;
  let exited = false;
  const fail = () => { for (const item of pending.values()) item.reject(new Error('Не удалось связаться с Codex.')); pending.clear(); };
  const stop = () => { fail(); child.kill(); };
  signal.addEventListener('abort', stop, { once: true });
  child.once('error', fail);
  child.stdin.on('error', fail);
  child.stdout.on('error', fail);
  child.once('exit', () => { exited = true; fail(); });
  reader.on('line', line => {
    if (line.length > 2_000_000) { stop(); return; }
    let message: any; try { message = JSON.parse(line); } catch { stop(); return; }
    if (message.method && message.id != null) {
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'unsupported' } }) + '\n');
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error('Codex не выполнил проверку хуков.')); else entry.resolve(message.result);
  });
  const rpc = (method: string, params: Record<string, unknown>) => new Promise<any>((resolveCall, reject) => {
    if (exited || signal.aborted) { reject(new Error('Проверка хуков остановлена.')); return; }
    const requestId = ++id;
    pending.set(requestId, { resolve: resolveCall, reject });
    child.stdin.write(JSON.stringify({ id: requestId, method, params }) + '\n', error => { if (error) { pending.delete(requestId); reject(new Error('Не удалось связаться с Codex.')); } });
  });
  const timeout = setTimeout(stop, 30_000);
  try {
    await rpc('initialize', { clientInfo: { name: 'svaib-hook-review', version: '1' }, capabilities: { experimentalApi: true } });
    child.stdin.write('{"method":"initialized"}\n');
    return await operation(rpc);
  } finally {
    clearTimeout(timeout); signal.removeEventListener('abort', stop); fail(); reader.close(); child.stdin.end();
    if (!exited) child.kill();
  }
}

export const nativeHookAutomaticForProfile = (input: { executable: string; cwd: string }, signal: AbortSignal, configRoot: string) =>
  withCodexHooks(input, signal, async rpc => {
    const review = await inspectHooks(rpc, input.cwd);
    signal.throwIfAborted();
    const result = await approveHooks(rpc, input.cwd, review.fingerprint);
    return { ...result, changed: review.hooks.some(hook => hook.trustStatus !== 'trusted') };
  }, configRoot);

export const nativeHookAutomatic = (input: { executable: string; cwd: string }, signal: AbortSignal) =>
  nativeHookAutomaticForProfile(input, signal, join(homedir(), '.codex'));
