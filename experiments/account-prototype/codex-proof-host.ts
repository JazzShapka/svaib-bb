import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { isSvaibMcpServer, identityFromWhoamiResult, type WhoamiIdentity } from './whoami-proof';

/** Official read-only app-server protocol: no resume, turn, MCP login or credential reads. */
export async function readCodexWhoami(input: { sessionId: string; cwd: string; configRoot?: string; expectedCallId?: string }, signal: AbortSignal): Promise<string | null> {
  return (await readCodexWhoamiIdentity(input, signal))?.subject ?? null;
}

export async function readCodexWhoamiIdentity(input: { sessionId: string; cwd: string; configRoot?: string; expectedCallId?: string }, signal: AbortSignal): Promise<WhoamiIdentity | null> {
  signal.throwIfAborted();
  if (!input.expectedCallId) return null;
  return new Promise((resolveResult, reject) => {
    const child = spawn('codex', ['app-server'], { cwd: input.cwd, shell: false,
      env: input.configRoot ? { ...process.env, CODEX_HOME: input.configRoot } : process.env,
      stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false, buffer = '', bytes = 0;
    const finish = (subject: WhoamiIdentity | null, error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      child.stdin.destroy(); child.kill();
      error ? reject(error) : resolveResult(subject);
    };
    const failure = () => finish(null, new Error('Не удалось прочитать подтверждение аккаунта из исходного разговора Codex.'));
    const abort = () => finish(null, new Error('Проверка результата Codex отменена.'));
    const timer = setTimeout(failure, 15_000);
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    child.once('error', failure); child.once('close', () => { if (!settled) failure(); });
    child.stdin.on('error', failure);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(data);
      if (bytes > 4 * 1024 * 1024) { failure(); return; }
      buffer += data;
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { failure(); return; }
        if (message.id === 1) {
          if (message.error) { failure(); return; }
          send({ method: 'initialized' });
          send({ id: 2, method: 'thread/read', params: { threadId: input.sessionId, includeTurns: true } });
        } else if (message.id === 2) {
          const thread = message.result?.thread;
          if (message.error || thread?.id !== input.sessionId || typeof thread.cwd !== 'string' || resolve(thread.cwd) !== resolve(input.cwd)) { failure(); return; }
          if (!Array.isArray(thread.turns)) { failure(); return; }
          const calls = thread.turns.flatMap((turn: any) => Array.isArray(turn?.items) ? turn.items : []).filter((item: any) =>
            item?.type === 'mcpToolCall' && item.tool === 'whoami' && isSvaibMcpServer(item.server));
          const latest = calls.at(-1);
          finish(latest?.id === input.expectedCallId && latest?.status === 'completed' && !latest.error ? identityFromWhoamiResult(latest.result) : null);
        } else if (message.id !== undefined && message.method) {
          // A read-only reader never services execution requests.
          failure(); return;
        }
      }
    });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    else send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'svaib-identity-reader', version: '1' } } });
  });
}
