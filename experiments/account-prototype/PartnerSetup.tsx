import { useEffect, useState } from 'react';
import { useBbContext, useBbNavigate, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import { connectionCompose } from './connection';

/** Old plugin links remain valid, but conversation UI belongs to BB. */
export function PartnerSetup({ phase, threadId, production = false }: { phase: 'setup' | 'chat' | 'verify'; threadId?: string; production?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const context = useBbContext();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setError('');
    if (!threadId) navigate.toCompose(connectionCompose(context.projectId));
    else void rpc.call('connectionThread', { threadId }).then(source => {
      if (!current) return;
      if (phase === 'chat') navigate.toThread(source.threadId);
      else navigate.toCompose(connectionCompose(source.projectId, source));
    }, () => {
      if (current) setError('Не удалось открыть разговор настройки. Повтори переход или вернись к рабочему месту.');
    });
    return () => { current = false; };
  }, [rpc, navigate, phase, threadId, context.projectId, attempt]);
  return <div className="svaib-account-viewport"><main className="svaib-account">
    <p role={error ? 'alert' : 'status'}>{error || 'Перехожу в чат BB…'}</p>
    {error && <button className="svaib-account-button" onClick={() => setAttempt(n => n + 1)}>Повторить</button>}
    <button className="svaib-account-button" onClick={() => production ? navigate.toPluginPanel('workplace', { subPath: 'settings/account' }) : navigate.toPluginPanel('account')}>К рабочему месту</button>
  </main></div>;
}
