import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useRpc, useRealtime } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './account-module';
import { accountIdentity, hasCompanyMembership, type AccountView } from './contracts';
import type { PluginNavPanelProps } from '@get-bb/plugin-sdk/app';
import { useBbContext } from '@get-bb/plugin-sdk/app';
import type { ConnectFlowView } from './connect-flow';
import type { journeyContract, JourneyStatus } from './journey-status';
import { OnboardingJourney, type SetupStep } from './OnboardingJourney';
import { PartnerSetup } from './PartnerSetup';
import './app.css';

export function AccountPage({ production = false }: { production?: boolean } = {}) {
  const context = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const journeyRpc = useRpc<typeof journeyContract>();
  const [view, setView] = useState<AccountView | null>(null);
  const [connection, setConnection] = useState<ConnectFlowView | null>(null);
  const [journey, setJourney] = useState<JourneyStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [companies, setCompanies] = useState<NonNullable<NonNullable<AccountView['me']>['companies']>>([]);
  const needsConnection = connection?.stage !== 'ready' && (view?.state !== 'connected' || !!connection?.threadId);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const progressRequest = journeyRpc.call('journeyStatus', { projectId: context.projectId ?? null, threadId: context.threadId ?? null }).catch(() => null);
      const [account, flow] = await Promise.all([rpc.call('status', null), rpc.call('connectionStatus').catch(() => null)]);
      const selected = companyId ? await rpc.call('status', { company_id: companyId }) : account;
      if (request !== sequence.current) return;
      setCompanies(account.me?.companies ?? []);
      setJourney({ workplace: false, account: account.state === 'connected', space: false, firstWork: false,
        nextStep: null, nextStages: [], stagesAvailable: false });
      void progressRequest.then(progress => { if (request === sequence.current && progress) setJourney(progress); });
      if (companyId && (!account.me || !selected.me || selected.state !== 'connected' ||
          accountIdentity(account.me) !== accountIdentity(selected.me) || !hasCompanyMembership(selected.me) ||
          selected.me.tenant_id !== companyId)) {
        setView(account); setConnection(flow);
        setError('Компания недоступна в этом подключении. Выбери доступную компанию и повтори.');
        return;
      }
      setView(selected); setConnection(flow); setError(flow ? '' : 'Не удалось загрузить статус настройки. Обнови страницу или начни обычный разговор в BB.');
    }
    catch { if (request === sequence.current) { setView(null); setCompanies([]); setError('Не удалось загрузить подключение. Повтори обновление.'); } }
  }, [rpc, journeyRpc, companyId, context.projectId, context.threadId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { sequence.current++; }, []);
  useRealtime('account-changed', () => { void refresh(); });
  // Account marks can also change outside BB, e.g. in Telegram. Re-read when
  // the person returns to this window, without background polling.
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  // Poll only during the interactive login; this is not an agent or a business-data sync.
  useEffect(() => {
    if (view?.state !== 'waiting' && !['setup', 'verify', 'cabinet'].includes(connection?.stage ?? '')) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [view?.state, connection?.stage, refresh]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Действие не завершено. Повтори обновление.'); }
    finally { setBusy(false); }
  }
  async function openConnection() {
    // Recheck on every click: the conversation may have been deleted since refresh.
    const next = await rpc.call('connect', { projectId: context.projectId, threadId: context.threadId,
      ...(['cabinet', 'error'].includes(connection?.stage ?? '') || connection?.retryable ? { restartCabinet: true } : {}) });
    setConnection(next);
    if (!next.threadId && next.stage === 'error') setError(next.message);
  }
  async function continueJourney(stepId: string) {
    await rpc.call('continueOnboarding', { projectId: context.projectId ?? null, threadId: context.threadId ?? null, stepId });
  }
  const done = [!!journey?.workplace, !!journey?.account, !!journey?.space, !!journey?.firstWork];
  const setupComplete = done.every(Boolean);
  const activeStep = done.findIndex(value => !value);
  const setup: SetupStep[] = [
    { id: 'workplace', title: 'Подготовить партнёра', detail: 'Проверим рабочее место и доступ партнёра.', state: 'upcoming' },
    { id: 'account', title: 'Войти в svaib', detail: 'Подключим твой аккаунт.', state: 'upcoming' },
    { id: 'space', title: 'Подключить компанию и пространство', detail: 'Выберем компанию и подготовим место для её материалов.', state: 'upcoming' },
    { id: 'first-work', title: 'Познакомиться и начать работу', detail: 'Расскажешь партнёру о себе и перейдёшь к первой задаче.', state: 'upcoming' },
  ].map((step, index) => ({ ...step, state: done[index] ? 'done' : index === activeStep ? 'current' : 'upcoming' }));
  return <div className="svaib-account-viewport"><main className="svaib-account">
    <header><span className="svaib-account-mark">s.</span><div><p className="svaib-account-eyebrow">{production ? 'svaib' : 'Тестовый контур · Staging'}</p><h1>Моё рабочее место</h1></div></header>
    <p className="svaib-account-note">{production ? 'Работа с партнёром и твоими компаниями.' : 'Прототип для локального BB. Одно подключение svaib на весь BB-сервер; оно доступно всем его окнам.'}</p>
    {journey && <OnboardingJourney setup={setup} setupComplete={setupComplete} nextSteps={journey.nextStages} stagesAvailable={journey.stagesAvailable} busy={busy}
      onContinue={stepId => { void act(() => continueJourney(stepId)); }} />}
    {!journey && <section><h2>Партнёр svaib</h2>
      {!needsConnection ? <p>{connection?.stage === 'ready' ? 'Партнёр подключён.' : 'Кабинет подключён.'} Начни обычный разговор в BB.</p> : <>
        <p>{view?.state === 'connected' ? 'Кабинет подключён. Осталось проверить доступ партнёра.' : 'Агент подготовит svaib к работе. Тебе останется подтвердить вход в браузере.'}</p>
        {connection?.message && <p role="status">{connection.message}</p>}
        {connection?.stage === 'cabinet' && <p>Код истёк или страница не открывается? «Продолжить подключение» откроет новый вход в браузере. Уже выполненные шаги сохранятся.</p>}
        <button className="svaib-account-button svaib-account-primary" disabled={busy} onClick={() => void act(openConnection)}>{connection?.threadId ? 'Продолжить подключение' : 'Подключить svaib'}</button>
      </>}
    </section>}
    {error && <p role="alert" className="svaib-account-error">{error}</p>}
    {!view ? !error && <p role="status">Проверяю подключение…</p> : <>
      {view.message && <p role="status">{view.message}</p>}
      {view.state === 'waiting' && connection?.stage !== 'cabinet' && <section><h2>Вход ожидает подтверждения</h2>
        <p>Подтверди его в уже открытом браузере или отмени незавершённый вход.</p>
        <button className="svaib-account-button" disabled={busy} onClick={() => void act(async () => { await rpc.call('cancelLogin'); await refresh(); })}>Отменить вход</button>
      </section>}
      {view.me && <section><p className="svaib-account-eyebrow">Аккаунт svaib</p><h2>{view.me.display_name || view.me.subject_id}</h2>
        {companies.length > 0 && <label className="svaib-account-company">Компания для просмотра<select value={companyId} disabled={busy} onChange={event => setCompanyId(event.currentTarget.value)}>
          <option value="">Аккаунт без выбранной компании</option>
          {companies.map(company => <option key={company.company_id} value={company.company_id}>{company.company_name || company.tenant_name || company.company_id}</option>)}
        </select></label>}
        {hasCompanyMembership(view.me)
          ? <p>{view.me.tenant_name || view.me.tenant_id} · {view.me.role === 'owner' ? 'Владелец' : 'Участник'}</p>
          : <p>Компания ещё не выбрана.</p>}
        {companies.length > 0 && <p className="svaib-account-note">Выбор здесь показывает настройки компании. Рабочий чат сохраняет свою компанию; для другой начни новый разговор с партнёром.</p>}
      </section>}
      {view.profile && <section><h2>Мой интерфейс</h2>
        <label className="svaib-account-toggle"><input type="checkbox" checked={view.profile.features.workspace_card} disabled={busy || !view.canEdit}
          onChange={event => { const enabled = event.currentTarget.checked; const revision = view.profile!.revision;
            const request = sequence.current;
            void act(async () => {
              const updated = await rpc.call('setWorkspaceCard', { enabled, expectedRevision: revision, ...(companyId ? { company_id: companyId } : {}) });
              if (request === sequence.current) setView(updated);
            }); }}/>
          Показывать карточку рабочего пространства</label>
        <p className="svaib-account-note">Настройка хранится в svaib. Редакция {view.profile.revision}. Изменение применяется без пересборки плагина.</p>
      </section>}
      {view.profile?.features.workspace_card && view.me && <section className="svaib-account-workspace"><h2>Моё пространство</h2>
        {view.me.workspace?.repo ? <><p className="svaib-account-path">{view.me.workspace.repo}</p>
          <p>Профиль: {view.me.workspace.profile_path || 'ещё не указан'}</p></> : <p>Пространство ещё не подключено.</p>}
      </section>}
    </>}
      <footer><button className="svaib-account-button" disabled={busy} onClick={() => void act(refresh)}>Обновить</button>
        {view && view.state !== 'signed-out' && view.state !== 'waiting' && <button className="svaib-account-button" disabled={busy} onClick={() => void act(async () => {
          const result = await rpc.call('logout'); await refresh();
          if (!result.revoked) setError('На этом BB подключение удалено. Серверный отзыв не подтверждён.');
        })}>Выйти из кабинета</button>}
      </footer>
  </main></div>;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: 'account', title: 'Мой svaib · прототип', icon: 'UserRound', path: 'account', component: AccountRouter });
});

export function AccountRouter({ subPath, production = false }: PluginNavPanelProps & { production?: boolean }) {
  const match = /^(connect|verify)(?:\/(thr_[a-z0-9]+))?$/.exec(subPath);
  if (!match) return <AccountPage production={production} />;
  if (match[1] === 'verify' && !match[2]) return <AccountPage production={production} />;
  return <PartnerSetup key={subPath} production={production} phase={match[1] === 'verify' ? 'verify' : match[2] ? 'chat' : 'setup'} threadId={match[2]} />;
}
