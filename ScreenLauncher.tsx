import { useCallback, useEffect, useRef, useState } from 'react';
import { experimental_useAppPanel, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { screenRpcContract } from './screen-module';

const screenTab = { id: 'svaib-screen', context: { kind: 'thread' as const }, availability: 'action' as const };

/** The host keeps visibility hooks mounted even while their segment is hidden. */
export function useScreenLauncher({ threadId }: { threadId: string }) {
  const panel = experimental_useAppPanel();
  const rpc = useRpc<typeof screenRpcContract>();
  const handled = useRef<string | null>(null);
  const checkSequence = useRef(0);
  const [available, setAvailable] = useState(false);
  const refresh = useCallback(() => {
    const sequence = ++checkSequence.current;
    void rpc.call('screen.binding', { threadId }).then(result => { if (checkSequence.current === sequence) setAvailable(result.ok && !!result.value.screenId); })
      .catch(() => { if (checkSequence.current === sequence) setAvailable(false); });
  }, [rpc, threadId]);
  const present = useCallback((requestId: string) => {
    if (handled.current === requestId) return;
    handled.current = requestId;
    let opened = false;
    try { opened = panel.openTab({ tab: screenTab }); } catch { /* host refused */ }
    void rpc.call('screen.presented', { threadId, requestId, opened }).catch(() => {});
  }, [panel, rpc, threadId]);
  useRealtime('screen-open-requested', payload => {
    const request = payload as { threadId?: unknown; requestId?: unknown } | null;
    if (request?.threadId === threadId && typeof request.requestId === 'string') { ++checkSequence.current; setAvailable(true); present(request.requestId); }
  });
  useRealtime('screen-changed', payload => { if ((payload as { threadId?: string })?.threadId === threadId) refresh(); });
  useRealtime('account-changed', refresh);
  useEffect(() => {
    let alive = true;
    setAvailable(false); refresh();
    void rpc.call('screen.presentation', { threadId }).then(({ requestId }) => { if (alive && requestId) { ++checkSequence.current; setAvailable(true); present(requestId); } }).catch(() => {});
    return () => { alive = false; ++checkSequence.current; };
  }, [rpc, threadId, present, refresh]);
  return available;
}

export function ScreenLauncher() {
  const panel = experimental_useAppPanel();
  return <button type="button" onClick={() => panel.openTab({ tab: screenTab })}>Конструктор</button>;
}
