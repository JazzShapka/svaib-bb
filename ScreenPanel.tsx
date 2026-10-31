import { useEffect, useMemo, useState } from 'react';
import { useRpc, useRealtime, type PluginRpcClient } from '@get-bb/plugin-sdk/app';
import type { screenRpcContract } from './screen-module';
import { createScreenTransport, ScreenTransportError, type ScreenBackendPort } from './screen-transport';
import { ScreenSurface } from 'bb-plugin-svaib-screen-pilot/renderer';

type Rpc = PluginRpcClient<typeof screenRpcContract>;
type Reply<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
function unwrap<T>(reply: Reply<T>): T {
  if (reply.ok) return reply.value;
  const error = new ScreenTransportError(reply.error.code); error.message = reply.error.message; throw error;
}
/** Browser-only RPC facade. It receives selectors, never account identity or credentials. */
export function screenRpcBackend(rpc: Rpc, threadId: string, screenId: string,
  onError: (error: unknown) => void): ScreenBackendPort {
  const selector = { threadId, screenId };
  async function call<T>(pending: Promise<Reply<T>>, signal?: AbortSignal, cancel?: () => void): Promise<T> {
    if (signal?.aborted) { cancel?.(); throw signal.reason; }
    let abort: (() => void) | undefined;
    const canceled = new Promise<never>((_, reject) => {
      if (!signal) return;
      abort = () => { cancel?.(); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const result = unwrap(await Promise.race([pending, canceled]));
      signal?.throwIfAborted(); return result;
    } catch (error) { if (!signal?.aborted) onError(error); throw error; }
    finally { if (abort) signal?.removeEventListener('abort', abort); }
  }
  return {
    get: signal => call(rpc.call('screen.get', selector), signal),
    submit: (mutation, signal) => call(rpc.call('screen.submit', { ...selector, mutation }), signal),
    update: (mutation, signal) => call(rpc.call('screen.update', { ...selector, mutation }), signal),
    confirmScaffold: (mutation, signal) => call(rpc.call('screen.confirm', { ...selector, mutation }), signal),
    events: (input, signal) => {
      const pollId = crypto.randomUUID();
      return call(rpc.call('screen.events', { ...selector, pollId, ...input, timeoutMs: Math.min(input.timeoutMs, 10000) }), signal,
        () => { void rpc.call('screen.cancel', { ...selector, pollId }).catch(() => {}); });
    },
  };
}

export function ScreenPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof screenRpcContract>();
  const [screenId, setScreenId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(true);
  useRealtime('screen-changed', payload => {
    if ((payload as { threadId?: string })?.threadId === threadId) setReload(value => value + 1);
  });
  useRealtime('account-changed', () => { setScreenId(null); setReload(value => value + 1); });
  useEffect(() => {
    let live = true; setScreenId(null); setError(''); setLoading(true);
    void rpc.call('screen.binding', { threadId }).then(unwrap).then(value => {
      if (live) setScreenId(value.screenId);
    }, cause => { if (live) setError(cause instanceof Error ? cause.message : 'Не удалось открыть Screen.'); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [rpc, threadId, reload]);
  const transport = useMemo(() => createScreenTransport({
    backend: screenRpcBackend(rpc, threadId, screenId ?? 'missing', cause => {
      if (cause instanceof ScreenTransportError && ['revision_conflict', 'cursor_expired', 'request_conflict'].includes(cause.code)) return;
      setError(cause instanceof Error ? cause.message : 'Screen недоступен.'); setScreenId(null);
    }),
  }), [rpc, threadId, screenId]);
  useEffect(() => () => transport.dispose(), [transport]);
  if (loading) return <section className="sv-screen"><p role="status">Проверяю Screen этого разговора…</p></section>;
  if (!screenId) return <section className="sv-screen"><p role={error ? 'alert' : 'status'}>{error || 'Попроси партнёра открыть Screen в этом разговоре. Он проверит подключение и выбранную компанию.'}</p>
    <button onClick={() => setReload(value => value + 1)}>Повторить проверку</button></section>;
  return <ScreenSurface key={`${threadId}:${screenId}`} transport={transport} />;
}
