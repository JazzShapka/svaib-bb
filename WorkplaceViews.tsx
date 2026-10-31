import { useState } from 'react';
import { UrlLink } from '@get-bb/plugin-sdk/app';
import type { Action, AspectId, AspectItem, SourceRef, Workspace, WorkspaceAspect } from './types';
import MetricsPanel from './MetricsPanel';
import MetricsDashboardPanel from './MetricsDashboard';
import './workplace-views.css';

export const ASPECTS: { id: AspectId; title: string; hint: string; content: string }[] = [
  { id: 'strategy', title: 'Стратегия', hint: 'Курс и приоритеты', content: 'Курс и стратегические выборы' },
  { id: 'metrics', title: 'Цели и показатели', hint: 'Результат и движение к нему', content: 'Цели и показатели' },
  { id: 'team', title: 'Команда', hint: 'Люди и ответственность', content: 'Люди и ответственность' },
  { id: 'finance', title: 'Финансы', hint: 'Экономика бизнеса', content: 'Финансовая картина' },
  { id: 'projects', title: 'Проекты', hint: 'Изменения ради цели', content: 'Текущие проекты' },
  { id: 'processes', title: 'Процессы', hint: 'Повторяемый результат', content: 'Ключевые процессы' },
  { id: 'rhythm', title: 'Ритм управления', hint: 'Встречи и отчёты', content: 'Встречи и отчёты' },
];

export type Place = { kind: 'overview' } | { kind: 'aspect'; aspectId: AspectId } | { kind: 'item'; aspectId: AspectId; itemId: string } | { kind: 'personal-section'; sectionId: string } | { kind: 'actions' } | { kind: 'sources' };
export type ActionContext = { aspectId?: AspectId; itemId?: string };
export type ViewProps = {
  workspace: Workspace;
  onNavigate: (place: Place) => void;
  onSource: (id: string) => void;
  onAction: (action: Action, context?: ActionContext) => void;
};

export function placeLabel(place: Place, workspace: Workspace): string {
  if (workspace.personal) {
    if (place.kind === 'personal-section') return workspace.personal.sections.find(section => section.id === place.sectionId)?.title ?? workspace.name;
    return place.kind === 'actions' ? 'С партнёром' : place.kind === 'sources' ? 'Материалы и архив' : workspace.name;
  }
  if (place.kind === 'aspect') return ASPECTS.find(a => a.id === place.aspectId)?.title ?? 'Ракурс';
  if (place.kind === 'item') return workspace.aspects?.find(a => a.id === place.aspectId)?.items.find(i => i.id === place.itemId)?.title ?? 'Карточка';
  return place.kind === 'actions' ? 'Действия' : place.kind === 'sources' ? 'Документы' : 'Сводка';
}
export function dateLabel(value?: string) {
  if (!value) return 'Дата не указана';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}
export function Arrow({ back = false }: { back?: boolean }) {
  return <svg className="svb-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={back ? 'M19 12H5m7-7-7 7 7 7' : 'M5 12h14m-6-6 6 6-6 6'} /></svg>;
}

// The seven marks are the original SVG geometry from the seminar slide template.
export function AspectIcon({ id }: { id: AspectId }) {
  return <svg className="svb-aspect-icon" viewBox={id === 'strategy' ? '14 8 284 116' : '14 28 152 100'} aria-hidden="true">
    {id === 'strategy' && <><path className="gs" d="M34 112 L104 70 L150 92 L224 44" /><circle className="gs" cx="262" cy="34" r="20" /><circle className="gf" cx="262" cy="34" r="6" /></>}
    {id === 'metrics' && <><rect className="gf" x="30" y="84" width="22" height="36" rx="5" /><rect className="gf" x="62" y="60" width="22" height="60" rx="5" /><rect className="gf" x="94" y="34" width="22" height="86" rx="5" /></>}
    {id === 'team' && <><circle className="gs" cx="52" cy="78" r="22" /><circle className="gs" cx="86" cy="78" r="22" /><circle className="gs" cx="120" cy="78" r="22" /></>}
    {id === 'finance' && <><circle className="gs" cx="64" cy="78" r="34" /><path className="gf" d="M64 78 L64 44 A34 34 0 0 1 98 78 Z" /></>}
    {id === 'projects' && <><rect className="gf" x="30" y="42" width="84" height="16" rx="8" /><rect className="gf" x="58" y="70" width="96" height="16" rx="8" /><rect className="gf" x="96" y="98" width="62" height="16" rx="8" /></>}
    {id === 'processes' && <><path className="gs" d="M64 44 A34 34 0 1 1 30 78" /><path className="gf" d="M16 84 L30 60 L44 84 Z" /></>}
    {id === 'rhythm' && <><path className="gs" d="M36 46 V110" /><path className="gs" d="M62 64 V92" /><path className="gs" d="M88 46 V110" /><path className="gs" d="M114 64 V92" /><path className="gs" d="M140 46 V110" /></>}
  </svg>;
}

export function DocumentList({ sources, onSource }: { sources: SourceRef[]; onSource: (id: string) => void }) {
  return sources.length ? <div className="svb-documents">{sources.map(source => <button key={source.id} onClick={() => onSource(source.id)} className="svb-document-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M14 3H6v18h12V7l-4-4v5h4M8 12h6m-6 4h8" /></svg><span>{source.title}</span><Arrow /></button>)}</div> : <p className="svb-empty-copy">Документы пока не добавлены.</p>;
}
export function ActionCard({ action, onAction, compact = false }: { action: Action; onAction: (action: Action) => void; compact?: boolean }) {
  return <button className={`svb-partner-action${compact ? ' is-compact' : ''}`} onClick={() => onAction(action)} disabled={action.available === false} title={action.available === false ? action.unavailableReason : undefined}>
    <span className="svb-partner-dot" aria-hidden="true" /><span className="svb-partner-copy"><strong>{action.title}</strong>{action.mode === 'draft-only' && <small>Только подготовка</small>}{!compact && <span>{action.description}</span>}{action.available === false && <small>{action.unavailableReason || 'Скилл не подключён'}</small>}</span><Arrow />
  </button>;
}
function ActionList({ actions, onAction }: { actions: Action[]; onAction: (action: Action) => void }) {
  const tasks = actions.filter(action => action.kind !== 'role');
  const roles = actions.filter(action => action.kind === 'role');
  if (!actions.length) return <p className="svb-empty-copy">Для этого контекста пока нет подготовленных действий.</p>;
  return <>{tasks.length > 0 && <div className="svb-partner-actions">{tasks.map(action => <ActionCard key={action.id} action={action} onAction={onAction} />)}</div>}{roles.length > 0 && <div className="svb-partner-roles"><span className="svb-mini-label">Посмотреть вместе с партнёром</span>{roles.map(action => <ActionCard key={action.id} action={action} onAction={onAction} compact />)}</div>}</>;
}
function relevantActions(workspace: Workspace, aspect: WorkspaceAspect | undefined, aspectId: AspectId, item?: AspectItem) {
  const ids = item ? item.actionIds : aspect?.actionIds ?? [];
  const canonicalSkill = (action: Action) => action.skill?.split(':').pop();
  const priority = (action: Action) => item?.actionIds.includes(action.id) ? 0
    : aspect?.actionIds.includes(action.id) ? 1 : action.id.startsWith('skill-') ? 3 : 2;
  const candidates = workspace.actions.filter(action => (ids.includes(action.id) || action.aspectIds?.includes(aspectId)) &&
    (!item || canonicalSkill(action) !== 'team-unit-review' || item.actionIds.includes(action.id)));
  const seen = new Set<string>();
  return candidates.sort((a, b) => priority(a) - priority(b)).filter(action => {
    const key = canonicalSkill(action) || `action:${action.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function ContextTools({ workspace, aspect, aspectId, item, onSource, onAction }: ViewProps & { aspect?: WorkspaceAspect; aspectId: AspectId; item?: AspectItem }) {
  const ids = item ? item.sourceIds : aspect?.sourceIds ?? [];
  const sources = workspace.sources.filter(source => ids.includes(source.id));
  const actions = relevantActions(workspace, aspect, aspectId, item);
  return <aside className="svb-context-tools" aria-label="Работа с выбранным контекстом">
    <section><h2><span className="svb-partner-dot" aria-hidden="true" />С партнёром</h2><ActionList actions={actions} onAction={action => onAction(action, { aspectId, ...(item ? { itemId: item.id } : {}) })} /></section>
    <section><h2>Документы</h2><DocumentList sources={sources} onSource={onSource} /></section>
  </aside>;
}

function itemOnlyActions(workspace: Workspace): Set<string> {
  const itemActionIds = new Set(workspace.aspects?.flatMap(aspect => aspect.items.flatMap(item => item.actionIds)) ?? []);
  const aspectActionIds = new Set(workspace.aspects?.flatMap(aspect => aspect.actionIds) ?? []);
  return new Set(workspace.actions.filter(action => itemActionIds.has(action.id) &&
    !action.aspectIds?.length && !aspectActionIds.has(action.id)).map(action => action.id));
}

export function WorkspaceOverview({ workspace, onNavigate, onSource, onAction }: ViewProps) {
  const itemOnlyIds = itemOnlyActions(workspace);
  const eligibleActions = workspace.actions.filter(action => action.kind !== 'role' && action.available !== false &&
    !itemOnlyIds.has(action.id));
  const configuredActions = eligibleActions.filter(action => !action.id.startsWith('skill-'));
  const quickActions = configuredActions.length ? configuredActions : eligibleActions;
  const first = workspace.sources[0];
  return <div className="svb-dashboard">
    <header className="svb-compact-heading"><div><span className="svb-kicker">{workspace.eyebrow}</span><h1>{workspace.name}</h1></div><span className="svb-snapshot">Сводка · {dateLabel(workspace.snapshotAt)}</span></header>
    <section className="svb-summary" aria-label="Сводка">
      <article className="svb-summary-goal"><span className="svb-mini-label">{workspace.goalLabel || 'Куда идём'}</span><h2>{workspace.goal}</h2>{first && <button className="svb-text-button" onClick={() => onSource(first.id)}>{first.title}<Arrow /></button>}</article>
      <div className="svb-summary-signals"><span className="svb-mini-label">В поле внимания</span>{workspace.signals.length ? workspace.signals.slice(0, 2).map((signal, index) => <details className={`svb-summary-signal svb-summary-signal--${signal.tone}`} key={index}><summary><span className="svb-signal-dot" /><span>{signal.title}</span><span className="svb-expand-mark">+</span></summary><p>{signal.text}</p>{workspace.sources.some(s => s.id === signal.sourceId) && <button className="svb-text-button" onClick={() => onSource(signal.sourceId)}>Открыть источник<Arrow /></button>}</details>) : <p className="svb-empty-copy">В сводке пока нет отдельных сигналов.</p>}
      {workspace.signals.length > 2 && <details className="svb-other-signals"><summary>Ещё в поле внимания · {workspace.signals.length - 2}</summary>{workspace.signals.slice(2).map((signal, index) => <article key={index}><h3>{signal.title}</h3><p>{signal.text}</p>{workspace.sources.some(s => s.id === signal.sourceId) && <button className="svb-text-button" onClick={() => onSource(signal.sourceId)}>Источник<Arrow /></button>}</article>)}</details>}</div>
    </section>
    <section className="svb-aspects" aria-labelledby="svb-aspects-title"><header className="svb-block-heading"><h2 id="svb-aspects-title">Семь ракурсов управления</h2><span>Один бизнес. Связанные решения.</span></header>
      <div className="svb-aspect-grid">{ASPECTS.map(meta => {
        const aspect = workspace.aspects?.find(a => a.id === meta.id);
        return <button key={meta.id} className={`svb-aspect-card svb-aspect--${meta.id}`} onClick={() => onNavigate({ kind: 'aspect', aspectId: meta.id })}><AspectIcon id={meta.id} /><Arrow /><strong>{meta.title}</strong><span>{aspect?.summary || meta.hint}</span></button>;
      })}</div>
    </section>
    <div className="svb-dashboard-bottom"><section><header className="svb-block-heading"><h2><span className="svb-partner-dot" aria-hidden="true" />С партнёром</h2><button className="svb-text-button" onClick={() => onNavigate({ kind: 'actions' })}>Все действия<Arrow /></button></header>{quickActions.length ? <div className="svb-quick-actions">{quickActions.slice(0, 3).map(action => <ActionCard key={action.id} action={action} onAction={onAction} compact />)}</div> : <p className="svb-empty-copy">Откройте ракурс — там доступны действия по теме.</p>}</section>
      <section><header className="svb-block-heading"><h2>Документы</h2><button className="svb-text-button" onClick={() => onNavigate({ kind: 'sources' })}>Все документы<Arrow /></button></header><DocumentList sources={workspace.sources.slice(0, 2)} onSource={onSource} /></section></div>
    {workspace.planner && <div className="svb-planner-link"><span>Личный план</span><UrlLink href={workspace.planner.url}>{workspace.planner.title}<Arrow /></UrlLink></div>}
    <footer className="svb-dashboard-footer">Работа на партнёре. Решения — за вами.</footer>
  </div>;
}

function Breadcrumb({ onNavigate, aspectId, item }: { onNavigate: ViewProps['onNavigate']; aspectId?: AspectId; item?: boolean }) {
  return <nav className="svb-breadcrumb" aria-label="Путь внутри пространства"><button onClick={() => onNavigate({ kind: 'overview' })}><Arrow back />Сводка</button>{aspectId && <><span>/</span>{item ? <button onClick={() => onNavigate({ kind: 'aspect', aspectId })}>{ASPECTS.find(a => a.id === aspectId)?.title}</button> : <span aria-current="page">{ASPECTS.find(a => a.id === aspectId)?.title}</span>}</>}</nav>;
}
function ItemCard({ item, aspectId, onNavigate }: { item: AspectItem; aspectId: AspectId; onNavigate: ViewProps['onNavigate'] }) {
  return <button className={`svb-item-card${aspectId === 'team' ? ' svb-person-card' : ''}`} onClick={() => onNavigate({ kind: 'item', aspectId, itemId: item.id })}>
    <div className="svb-item-card-head">{aspectId === 'team' && <span className="svb-person-initials" aria-hidden="true">{item.title.split(/\s+/).slice(0, 2).map(word => word[0]).join('')}</span>}<span><strong>{item.title}</strong>{item.role && <span className="svb-item-role">{item.role}</span>}</span><Arrow /></div>
    <p>{item.responsibility || item.summary}</p>
    {item.value && <div className="svb-item-value">{item.value}{item.target && <span> / {item.target}</span>}</div>}
    {(item.owner || item.status || item.period) && <div className="svb-item-meta">{item.owner && <span>{item.owner}</span>}{item.status && <span>{item.status}</span>}{item.period && <span>{item.period}</span>}</div>}
  </button>;
}
export function AspectPage(props: ViewProps & { aspectId: AspectId }) {
  const { workspace, aspectId, onNavigate } = props;
  const meta = ASPECTS.find(a => a.id === aspectId)!;
  const aspect = workspace.aspects?.find(a => a.id === aspectId);
  const refreshAction = workspace.actions.find(action => action.effect === 'metrics-refresh');
  return <section className="svb-depth-page"><Breadcrumb onNavigate={onNavigate} aspectId={aspectId} />
    <header className="svb-depth-heading"><span className={`svb-aspect-badge svb-aspect--${aspectId}`}><AspectIcon id={aspectId} /></span><div><h1>{meta.title}</h1><p>{aspect?.summary || meta.hint}</p></div></header>
    <nav className="svb-aspect-switcher" aria-label="Ракурсы управления">{ASPECTS.map(a => <button key={a.id} aria-current={a.id === aspectId ? 'page' : undefined} onClick={() => onNavigate({ kind: 'aspect', aspectId: a.id })}>{a.title}</button>)}</nav>
    <div className="svb-depth-layout"><main className="svb-depth-content"><div className="svb-content-heading"><h2>{meta.content}</h2><span>Снимок · {dateLabel((aspectId === 'metrics' && workspace.metricsDashboard?.preparedAt) || aspect?.snapshotAt || workspace.snapshotAt)}</span></div>
      {aspectId === 'metrics' && workspace.metricsDashboard && <MetricsDashboardPanel key={workspace.id} data={workspace.metricsDashboard} onRefresh={refreshAction ? () => props.onAction(refreshAction, { aspectId: 'metrics' }) : undefined} refreshUnavailable={refreshAction?.available === false ? refreshAction.unavailableReason || 'Обновление пока недоступно' : undefined} />}
      {!!aspect?.items.length ? <div className="svb-item-grid">{aspect.items.map(item => <ItemCard key={item.id} item={item} aspectId={aspectId} onNavigate={onNavigate} />)}</div> : !(aspectId === 'metrics' && (workspace.metricsDashboard || workspace.metrics)) && <div className="svb-content-empty"><AspectIcon id={aspectId} /><h3>Картина ещё не собрана</h3><p>Здесь появятся {aspectId === 'team' ? 'люди, их роли и ответственность' : meta.content.toLowerCase()}. Пока можно открыть документы или поработать с партнёром.</p></div>}
      {aspectId === 'metrics' && !workspace.metricsDashboard && workspace.metrics && <MetricsPanel data={workspace.metrics} />}
    </main><ContextTools {...props} aspect={aspect} /></div>
  </section>;
}
export function ItemPage(props: ViewProps & { aspectId: AspectId; itemId: string }) {
  const { workspace, aspectId, itemId, onNavigate } = props;
  const aspect = workspace.aspects?.find(a => a.id === aspectId);
  const item = aspect?.items.find(i => i.id === itemId);
  if (!item) return <section className="svb-depth-page"><Breadcrumb onNavigate={onNavigate} aspectId={aspectId} item /><p className="svb-empty-copy">Карточка больше не доступна. Вернитесь к ракурсу.</p></section>;
  return <section className="svb-depth-page"><Breadcrumb onNavigate={onNavigate} aspectId={aspectId} item />
    <header className="svb-depth-heading"><span className={`svb-aspect-badge svb-aspect--${aspectId}`}>{aspectId === 'team' ? <span className="svb-large-initials">{item.title.split(/\s+/).slice(0, 2).map(word => word[0]).join('')}</span> : <AspectIcon id={aspectId} />}</span><div><span className="svb-kicker">{ASPECTS.find(a => a.id === aspectId)?.title}</span><h1>{item.title}</h1>{item.role && <p>{item.role}</p>}</div></header>
    <div className="svb-depth-layout"><main className="svb-depth-content"><article className="svb-item-detail"><span className="svb-mini-label">{aspectId === 'team' ? 'О человеке' : 'Главное'}</span><p>{item.summary}</p>{item.responsibility && <section><h2>За что отвечает</h2><p>{item.responsibility}</p></section>}<dl>{item.owner && <><dt>Ответственный</dt><dd>{item.owner}</dd></>}{item.status && <><dt>Состояние</dt><dd>{item.status}</dd></>}{item.value && <><dt>Факт</dt><dd>{item.value}</dd></>}{item.target && <><dt>Цель / план</dt><dd>{item.target}</dd></>}{item.period && <><dt>Период</dt><dd>{item.period}</dd></>}</dl><span className="svb-snapshot">Снимок · {dateLabel(aspect?.snapshotAt || workspace.snapshotAt)}</span></article></main><ContextTools {...props} aspect={aspect} item={item} /></div>
  </section>;
}
export function ActionsPage(props: ViewProps) {
  const { workspace, onNavigate, onAction } = props;
  const [filter, setFilter] = useState<AspectId | 'all'>('all');
  const itemOnlyIds = itemOnlyActions(workspace);
  const actions = workspace.actions.filter(action => !itemOnlyIds.has(action.id) && (filter === 'all' || action.aspectIds?.includes(filter) || workspace.aspects?.find(a => a.id === filter)?.actionIds.includes(action.id)));
  return <section className="svb-depth-page"><Breadcrumb onNavigate={onNavigate} /><header className="svb-library-heading"><span className="svb-kicker">Работа с партнёром</span><h1>С чем поработаем?</h1><p>Выберите задачу. Запрос можно будет уточнить перед отправкой.</p></header><div className="svb-aspect-switcher" role="group" aria-label="Действия по ракурсу"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Все</button>{ASPECTS.map(a => <button key={a.id} aria-pressed={filter === a.id} onClick={() => setFilter(a.id)}>{a.title}</button>)}</div><div className="svb-actions-library"><ActionList actions={actions} onAction={action => onAction(action, filter === 'all' ? undefined : { aspectId: filter })} /></div></section>;
}
export function DocumentsPage({ workspace, onNavigate, onSource }: ViewProps) {
  const [query, setQuery] = useState('');
  const sources = workspace.sources.filter(source => source.title.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
  return <section className="svb-depth-page"><Breadcrumb onNavigate={onNavigate} /><header className="svb-library-heading"><span className="svb-kicker">Память о деле</span><h1>Документы</h1><p>Откройте источник и прочитайте его прямо здесь.</p></header><label className="svb-document-search"><span>Найти документ</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Название документа" type="search" /></label><DocumentList sources={sources} onSource={onSource} />{query && sources.length === 0 && <p className="svb-empty-copy">По этому названию ничего не найдено.</p>}</section>;
}
