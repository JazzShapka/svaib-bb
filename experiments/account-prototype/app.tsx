import { useCallback, useEffect, useRef, useState } from 'react';
import { definePluginApp, useBbContext, useBbNavigate, useRpc, useRealtime } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './account-module';
import type { screenRpcContract } from '../../screen-module';
import { accountIdentity, hasCompanyMembership, type AccountView, type OnboardingView } from './contracts';
import type { PluginNavPanelProps } from '@get-bb/plugin-sdk/app';
import type { ConnectFlowView } from './connect-flow';
import catalog from './onboarding-catalog.json';
import { PartnerSetup } from './PartnerSetup';
import './app.css';
import './onboarding-journey.css';

const progressCache = new Map<string, OnboardingView>();

export function AccountPage({ production = false }: { production?: boolean } = {}) {
  const rpc = useRpc<typeof rpcContract>();
  const screenRpc = useRpc<typeof screenRpcContract>();
  const context = useBbContext();
  const navigate = useBbNavigate();
  const [view, setView] = useState<AccountView | null>(null);
  const [connection, setConnection] = useState<ConnectFlowView | null>(null);
  const [comparison, setComparison] = useState<'unknown' | 'match' | 'mismatch'>('unknown');
  const [nativeHost, setNativeHost] = useState<string | null>(null);
  const [progress, setProgress] = useState<OnboardingView | null>(null);
  const [selectionLoaded, setSelectionLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [screenChoices, setScreenChoices] = useState<{ companyId: string; items: { id: string; title: string; updatedAt: string; kind: 'overview' | 'scaffold' }[] } | null>(null);
  const selectedCompany = useRef(companyId); selectedCompany.current = companyId;
  const [companies, setCompanies] = useState<NonNullable<NonNullable<AccountView['me']>['companies']>>([]);
  const sequence = useRef(0);
  const currentAccount = useRef<string | null | undefined>(undefined);
  const refresh = useCallback(async () => {
    const request = ++sequence.current;
    try {
      const [account, flow, native] = await Promise.all([rpc.call('status', null), rpc.call('connectionStatus').catch(() => null),
        rpc.call('compareNativeAccount').catch(() => ({ status: 'unknown' as const, observedAt: null, hostId: null }))]);
      if (request !== sequence.current) return;
      const identity = account.state === 'connected' ? account.me?.account_id ?? null : null;
      if (identity !== currentAccount.current) {
        setProgress(null); setSelectionLoaded(false);
        const saved = identity ? await rpc.call('selectedCompany').catch(() => ({ company_id: null })) : { company_id: null };
        if (request !== sequence.current) return;
        currentAccount.current = identity;
        const next = saved.company_id ?? '';
        setSelectionLoaded(true);
        if (next !== companyId) { setCompanyId(next); return; }
      }
      const selected = companyId ? await rpc.call('status', { company_id: companyId }) : account;
      if (request !== sequence.current) return;
      setComparison(native.status);
      setNativeHost(native.hostId);
      setCompanies(account.me?.companies ?? []);
      const progressKey = `${identity ?? 'signed-out'}:${companyId}`;
      const cached = identity ? progressCache.get(progressKey) : undefined;
      if (cached) setProgress(cached);
      void rpc.call('onboardingProgress', { company_id: companyId || null }).then(value => {
        if (request === sequence.current) { if (identity && value.status === 'available') { progressCache.set(progressKey, value); if (progressCache.size > 20) progressCache.delete(progressCache.keys().next().value!); } setProgress(value); }
      }).catch(() => { if (request === sequence.current) setProgress({ status: 'unavailable', onboarding: null, nextStep: null, role: null }); });
      if (companyId && (!account.me || !selected.me || selected.state !== 'connected' ||
          accountIdentity(account.me) !== accountIdentity(selected.me) || !hasCompanyMembership(selected.me) ||
          selected.me.tenant_id !== companyId)) {
        setView(account); setConnection(flow);
        setError('Компания недоступна в этом подключении. Выбери доступную компанию и повтори.');
        return;
      }
      setView(selected.me && !selected.me.display_name && account.me?.display_name
        ? { ...selected, me: { ...selected.me, display_name: account.me.display_name } } : selected);
      setConnection(flow); setError(flow ? '' : 'Не удалось загрузить статус настройки. Обнови страницу или начни обычный разговор в BB.');
    }
    catch { if (request === sequence.current) { setView(null); setCompanies([]); setSelectionLoaded(true); setProgress({ status: 'unavailable', onboarding: null, nextStep: null, role: null }); setError('Не удалось загрузить подключение. Повтори обновление.'); } }
  }, [rpc, companyId]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => { sequence.current++; }, []);
  useRealtime('account-changed', () => { setProgress(null); setScreenChoices(null); setSelectionLoaded(false); currentAccount.current = undefined; void refresh(); });
  useEffect(() => { setScreenChoices(null); }, [companyId]);
  // Account marks can also change outside BB, e.g. in Telegram. Re-read when
  // the person returns to this window, without background polling.
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  // Poll only during the interactive login; this is not an agent or a business-data sync.
  useEffect(() => {
    if (view?.state !== 'waiting' && (nativeHost || !['setup', 'verify', 'cabinet'].includes(connection?.stage ?? ''))) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [view?.state, connection?.stage, nativeHost, refresh]);
  async function act(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Действие не завершено. Повтори обновление.'); }
    finally { setBusy(false); }
  }
  function continueJourney(stageTitle?: string) {
    const company = companies.find(item => item.company_id === companyId);
    const choice = company ? ` Моя компания: ${company.company_name || company.tenant_name || (view?.me?.tenant_id === company.company_id && view.me.tenant_name) || company.company_id} (ID: ${company.company_id}).` : '';
    const stage = stageTitle ? ` Хочу продолжить: «${stageTitle}».` : '';
    navigate.toCompose({ initialPrompt: `Помоги продолжить настройку svaib.${stage}${choice} Продолжим в папке текущего проекта.`, focusPrompt: false });
  }
  async function openConstructor(screenId?: string) {
    if (!companyId) return;
    if (!context.threadId) throw new Error('Открой разговор в проекте BB и повтори открытие конструктора.');
    const selected = companyId;
    const name = view?.me?.tenant_name || companyId;
    const result = await screenRpc.call('screen.openCompany', { threadId: context.threadId, companyId, companyName: name, ...(screenId ? { screenId } : {}) });
    if (selectedCompany.current !== selected) return;
    if (!result.ok) throw new Error(result.error.message);
    if ('choices' in result.value) { setScreenChoices({ companyId: selected, items: result.value.choices }); return; }
    setScreenChoices(null);
    if (result.value.presentation !== 'tab-opened') setError('Конструктор подготовлен. Открой вкладку «Конструктор» в текущем разговоре.');
  }
  const marks = progress?.status === 'available' ? progress.onboarding.marks : {};
  const audience = progress?.status === 'available' ? progress.onboarding.audience || (progress.role === 'owner' ? 'ceo' : progress.role === 'member' ? 'employee' : null) : null;
  const stages = catalog.stages.filter(stage => stage.track === 'user' && stage.active && (stage.kind === 'base' ||
    (stage.kind === 'tool' && progress?.status === 'available' && progress.onboarding.tools.includes(stage.id))) &&
    (!stage.audiences.length || (!!audience && (stage.audiences as string[]).includes(audience))) && marks[stage.id]?.state !== 'skip').sort((a, b) => a.order - b.order);
  const completed = (stage: typeof stages[number]) => marks[stage.id]?.state === 'done' || (!marks[stage.id] && stage.replaces.some(id => marks[id]?.state === 'done'));
  const first = stages.find(stage => !completed(stage));
  const currentIndex = first ? stages.indexOf(first) : stages.length;
  const windowStart = currentIndex < 4 ? 0 : Math.max(0, currentIndex - 1);
  const visibleStages = stages.slice(windowStart, currentIndex < 4 ? 4 : currentIndex + 3);
  return <div className="svaib-account-viewport"><main className="svaib-account">
    <header><span className="svaib-account-mark">s.</span><div><p className="svaib-account-eyebrow">{production ? 'svaib' : 'Тестовый контур · Staging'}</p><h1>Моё рабочее место</h1></div></header>
    <p className="svaib-account-note">{production ? 'Работа с партнёром и твоими компаниями.' : 'Прототип для локального BB. Одно подключение svaib на весь BB-сервер; оно доступно всем его окнам.'}</p>
    <section className="svaib-journey"><h2>Твой путь</h2>
      {view?.state === 'signed-out' ? <><p>Войди в svaib, чтобы продолжить настройку и выбрать компанию.</p>
        <button className="svaib-journey-action" disabled={busy} onClick={() => void act(async () => { await rpc.call('startCabinetLogin'); await refresh(); })}>Войти в svaib</button></> :
      view?.state === 'waiting' ? <p role="status">Заверши вход в открывшемся браузере.</p> :
      !selectionLoaded || !progress ? <p role="status">Проверяю этапы…</p> : progress.status === 'unavailable' ?
        <p role="status">Не удалось загрузить этапы. Можно продолжить работу с партнёром.</p> :
        <ol className="svaib-journey-list">{visibleStages.map((stage, index) => {
          const mark = marks[stage.id]?.state;
          const done = completed(stage);
          return <li key={stage.id} className={`svaib-journey-step ${done ? 'svaib-journey-step--done' : stage === first ? 'svaib-journey-step--current' : ''}`}>
            <span className="svaib-journey-number">{done ? '✓' : windowStart + index + 1}</span><div className="svaib-journey-copy"><div className="svaib-journey-step-header"><h3>{stage.title}</h3><span className="svaib-journey-status">{done ? 'Готово' : mark === 'waiting' ? 'Ожидает' : mark === 'deferred' ? 'Отложено' : mark === 'unverified' ? 'Не проверено' : stage === first ? 'Сейчас' : 'Предстоит'}</span></div>
            {!done && stage === first && <button type="button" className="svaib-journey-action" disabled={busy} onClick={() => continueJourney(stage.title)}>Продолжить</button>}</div></li>;
        })}</ol>}
      {view?.state !== 'signed-out' && view?.state !== 'waiting' && selectionLoaded && progress?.status === 'unavailable' && <button type="button" className="svaib-journey-action" onClick={() => continueJourney()}>Продолжить</button>}
    </section>
    {error && <p role="alert" className="svaib-account-error">{error}</p>}
    {!view ? !error && <p role="status">Проверяю подключение…</p> : <>
      {view.message && <p role="status">{view.message}</p>}
      {view.state === 'waiting' && connection?.stage !== 'cabinet' && <section><h2>Вход ожидает подтверждения</h2>
        <p>Подтверди его в уже открытом браузере или отмени незавершённый вход.</p>
        <button className="svaib-account-button" disabled={busy} onClick={() => void act(async () => { await rpc.call('cancelLogin'); await refresh(); })}>Отменить вход</button>
      </section>}
      {view.me && <section><p className="svaib-account-eyebrow">Аккаунт svaib</p><h2>{view.me.display_name || view.me.subject_id}</h2>
        {comparison === 'match' && <p role="status">Последний вход партнёра и кабинет: один аккаунт.</p>}
        {comparison === 'mismatch' && <p role="alert">В кабинете и у партнёра разные аккаунты. Чтобы сверить их, войди в нужный аккаунт.</p>}
        {companies.length > 0 && <label className="svaib-account-company">Компания<select value={companyId} disabled={busy} onChange={event => { const next = event.currentTarget.value; void act(async () => { await rpc.call('selectCompany', { company_id: next || null }); setProgress(null); setCompanyId(next); }); }}>
          <option value="">Аккаунт без выбранной компании</option>
          {companies.map(company => <option key={company.company_id} value={company.company_id}>{company.company_name || company.tenant_name || (view.me?.tenant_id === company.company_id && view.me.tenant_name) || company.company_id}</option>)}
        </select></label>}
        {hasCompanyMembership(view.me)
          ? <p>{view.me.tenant_name || view.me.tenant_id} · {view.me.role === 'owner' ? 'Владелец' : 'Участник'}</p>
          : <p>Компания ещё не выбрана.</p>}
        {companyId && hasCompanyMembership(view.me) && <><button type="button" className="svaib-account-button" disabled={busy} onClick={() => void act(() => openConstructor())}>Открыть конструктор пространства</button>
          <p className="svaib-account-note">Конструктор показывает проект каркаса; содержимое папки автоматически не считывается.</p>
          {screenChoices?.companyId === companyId && <div role="group" aria-label="Выбери конструктор"><p>Найдено несколько конструкторов. Выбери нужный:</p>
            {screenChoices.items.map((item, index) => <button key={item.id} type="button" className="svaib-account-button" disabled={busy}
              onClick={() => void act(() => openConstructor(item.id))}>{item.title} · {item.kind === 'overview' ? 'обзор' : 'каркас'} · {item.updatedAt.replace('T', ' ').slice(0, 16)} · {index + 1}</button>)}
          </div>}</>}
        {companies.length > 0 && <p className="svaib-account-note">Компания определяет отображаемый путь. Привязка рабочей папки проверяется отдельно.</p>}
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
