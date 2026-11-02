import { useCallback, useEffect, useRef, useState } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './account-module';

/** Keep the observer mounted, but show the action only for the active temporary workspace. */
export function useFolderLauncher({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [available, setAvailable] = useState(false);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const request = ++sequence.current;
    void rpc.call('folderPickerStatus', { threadId }).then(result => {
      if (sequence.current === request) setAvailable(result.available);
    }).catch(() => { if (sequence.current === request) setAvailable(false); });
  }, [rpc, threadId]);
  useRealtime('account-changed', refresh);
  useEffect(() => { setAvailable(false); refresh(); return () => { sequence.current++; }; }, [refresh]);
  return available;
}

export function FolderLauncher({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [recoverable, setRecoverable] = useState(false);
  const inFlight = useRef(false);
  const statusSequence = useRef(0);
  const refresh = useCallback(() => {
    const sequence = ++statusSequence.current;
    void rpc.call('folderPickerStatus', { threadId }).then(result => {
      if (statusSequence.current === sequence) setRecoverable(!!result.recoverable);
    }).catch(() => {});
  }, [rpc, threadId]);
  useRealtime('account-changed', refresh);
  useEffect(() => { refresh(); return () => { statusSequence.current++; }; }, [refresh]);
  return <span>
    <button type="button" disabled={busy} onClick={() => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true); setError('');
      const action = recoverable ? 'resumeCompanyFolder' : 'chooseCompanyFolder';
      void rpc.call(action, { threadId }).then(result => {
        if (result.status === 'open-failed') {
          statusSequence.current++;
          setRecoverable(true);
          setError('Продолжение создано, но BB не подтвердил его открытие. Попробуй открыть его ещё раз.');
        } else if (result.status === 'opened') setRecoverable(false);
      }).catch(() => setError(recoverable ? 'Не удалось безопасно открыть продолжение. Попробуй ещё раз.' : 'Не удалось открыть выбор папки. Попробуй ещё раз.'))
        .finally(() => { inFlight.current = false; setBusy(false); });
    }}>{recoverable ? 'Открыть продолжение' : 'Выбрать папку'}</button>
    {error && <span role="alert">{error}</span>}
  </span>;
}
