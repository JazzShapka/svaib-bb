import { UrlLink } from '@get-bb/plugin-sdk/app';
import type { Action, PersonalSection, Workspace } from './types';
import { ActionCard, Arrow, DocumentList } from './WorkplaceViews';
import type { ViewProps } from './WorkplaceViews';
import './personal-views.css';

type PersonalIconName = PersonalSection['icon'] | 'sun' | 'library';

const iconPaths: Record<PersonalIconName, string> = {
  spark: 'm12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3M20 3v4m-2-2h4',
  heart: 'M20.8 5.8a5.2 5.2 0 0 0-7.4 0L12 7.2l-1.4-1.4a5.2 5.2 0 0 0-7.4 7.4L12 22l8.8-8.8a5.2 5.2 0 0 0 0-7.4ZM6 12h3l1.5-3 3 6 1.5-3h3',
  book: 'M12 6C9 3 5 3 2 4v15c3-1 7-1 10 2m0-15c3-3 7-3 10-2v15c-3-1-7-1-10 2V6M6 8h2m-2 4h2m8-4h2m-2 4h2',
  thought: 'M8 18c-3-.8-5-3.3-5-6.3C3 7.4 7 4 12 4s9 3.4 9 7.7-4 7.6-9 7.6H8l-4 2 1-5M8 11h.01M12 11h.01M16 11h.01',
  people: 'M10 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0M20 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0M2 20v-2a5 5 0 0 1 10 0v2m0 0v-2a5 5 0 0 1 10 0v2',
  compass: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0m-5-4-2.5 5.5L8 16l2.5-5.5L16 8',
  home: 'm3 11 9-8 9 8M5 9v12h14V9M9 21v-7h6v7',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0',
  library: 'M4 4h4v16H4zM11 4h4v16h-4zM17 6l3-1 4 14-3 1-4-14M4 8h4m3 0h4M4 16h4m3 0h4',
};

function PersonalIcon({ name }: { name: PersonalIconName }) {
  return <svg className="svb-personal-icon" viewBox={name === 'library' ? '0 0 26 24' : '0 0 24 24'} fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name]} /></svg>;
}

function PersonalBreadcrumb({ workspace, onNavigate, current }: Pick<ViewProps, 'workspace' | 'onNavigate'> & { current: string }) {
  return <nav className="svb-breadcrumb" aria-label="Путь в личном пространстве"><button onClick={() => onNavigate({ kind: 'overview' })}><Arrow back />{workspace.name}</button><span>/</span><span aria-current="page">{current}</span></nav>;
}

function selectedActions(workspace: Workspace, ids: string[]): Action[] {
  return ids.flatMap(id => { const action = workspace.actions.find(item => item.id === id); return action ? [action] : []; });
}

function PersonalActionButton({ action, onAction }: { action: Action; onAction: ViewProps['onAction'] }) {
  return <button className="svb-personal-action-button" onClick={() => onAction(action)} disabled={action.available === false} title={action.available === false ? action.unavailableReason : undefined}><span className="svb-partner-dot" aria-hidden="true" /><span>{action.title}{action.mode === 'draft-only' && <small> · Только подготовка</small>}</span><Arrow /></button>;
}

export function PersonalOverview({ workspace, onNavigate, onSource, onAction }: ViewProps) {
  const personal = workspace.personal;
  if (!personal) return null;
  const daySource = workspace.sources.find(source => source.id === personal.day.sourceId);
  const dayActions = selectedActions(workspace, personal.day.actionIds);
  const assistant = workspace.actions.find(action => action.id === personal.assistantActionId);
  return <div className="svb-personal">
    <header className="svb-personal-heading"><div><span className="svb-kicker">Место для себя</span><h1>{workspace.name}</h1><p>{workspace.description}</p></div><button className="svb-personal-partner-link" onClick={() => onNavigate({ kind: 'actions' })}><span className="svb-partner-dot" aria-hidden="true" />Все задачи<Arrow /></button></header>

    <section className={`svb-personal-day${dayActions.length || assistant ? '' : ' svb-personal-day--solo'}`} aria-labelledby="svb-personal-day-title">
      <div className="svb-personal-day-main"><span className="svb-personal-day-symbol"><PersonalIcon name="sun" /></span><span className="svb-kicker">Сегодня и ближайшее</span><h2 id="svb-personal-day-title">Мой день</h2><p>{personal.day.description}</p><div className="svb-personal-day-links">{workspace.planner && <UrlLink className="svb-personal-planner" href={workspace.planner.url}>Открыть план<Arrow /></UrlLink>}{daySource && <button className="svb-text-button" onClick={() => onSource(daySource.id)}>Прочитать план<Arrow /></button>}</div></div>
      {assistant ? <aside className="svb-personal-assistant" aria-label="Личный ассистент">
        <span className="svb-personal-partner-label"><span className="svb-partner-dot" aria-hidden="true" />Рядом с твоими делами</span>
        <h2>{assistant.title}</h2>
        <p>{assistant.description}</p>
        <button className="svb-personal-assistant-open" onClick={() => onAction(assistant)} disabled={assistant.available === false} title={assistant.available === false ? assistant.unavailableReason : undefined}>Открыть разговор<Arrow /></button>
        {dayActions.length > 0 && <div className="svb-personal-assistant-tasks" aria-label="Типовые задачи ассистента"><span>Или сразу с задачей</span>{dayActions.map(action => <PersonalActionButton key={action.id} action={action} onAction={onAction} />)}</div>}
      </aside> : dayActions.length > 0 && <div className="svb-personal-day-partner"><span className="svb-personal-partner-label"><span className="svb-partner-dot" aria-hidden="true" />С партнёром</span><div>{dayActions.map(action => <ActionCard key={action.id} action={action} onAction={onAction} compact />)}</div></div>}
    </section>

    {personal.continueItems.length > 0 && <section className="svb-personal-block" aria-labelledby="svb-personal-continue-title"><header className="svb-personal-block-heading"><h2 id="svb-personal-continue-title">Продолжить</h2><span>Вернуться к своему</span></header><div className="svb-personal-continue-grid">{personal.continueItems.map(item => {
      const section = personal.sections.find(candidate => candidate.id === item.sectionId);
      const action = workspace.actions.find(candidate => candidate.id === item.actionId);
      const source = workspace.sources.find(candidate => candidate.id === item.sourceId);
      return <article className={`svb-personal-continue svb-personal-tone--${section?.icon ?? 'spark'}`} key={item.id}><div className="svb-personal-continue-label">{section && <PersonalIcon name={section.icon} />}<span>{section?.title}</span></div><h3>{item.title}</h3><p>{item.description}</p><div className="svb-personal-continue-primary">{action ? <PersonalActionButton action={action} onAction={onAction} /> : source ? <button className="svb-text-button" onClick={() => onSource(source.id)}>Открыть материал<Arrow /></button> : null}</div>{section && <button className="svb-personal-topic-link" onClick={() => onNavigate({ kind: 'personal-section', sectionId: section.id })}>К теме<Arrow /></button>}</article>;
    })}</div></section>}

    <section className="svb-personal-block" aria-labelledby="svb-personal-topics-title"><header className="svb-personal-block-heading"><h2 id="svb-personal-topics-title">Мои темы</h2><span>В своём темпе</span></header><div className="svb-personal-topic-grid">{personal.sections.map(section => <button className={`svb-personal-topic svb-personal-tone--${section.icon}`} key={section.id} onClick={() => onNavigate({ kind: 'personal-section', sectionId: section.id })}><span className="svb-personal-topic-symbol"><PersonalIcon name={section.icon} /></span><Arrow /><strong>{section.title}</strong><span>{section.description}</span></button>)}</div></section>

    <button className="svb-personal-library-entry" onClick={() => onNavigate({ kind: 'sources' })}><span className="svb-personal-library-symbol"><PersonalIcon name="library" /></span><span><strong>Материалы и архив</strong><span>Найти заметку, открыть документ, достать старый замысел.</span></span><Arrow /></button>
  </div>;
}

export function PersonalSectionPage({ workspace, sectionId, onNavigate, onSource, onAction }: ViewProps & { sectionId: string }) {
  const section = workspace.personal?.sections.find(item => item.id === sectionId);
  if (!section) return <section className="svb-depth-page"><PersonalBreadcrumb workspace={workspace} onNavigate={onNavigate} current="Тема" /><p className="svb-empty-copy">Эта тема больше не доступна. Вернитесь в личное пространство.</p></section>;
  const actions = selectedActions(workspace, section.actionIds);
  const sources = section.sourceIds.flatMap(id => { const source = workspace.sources.find(item => item.id === id); return source ? [source] : []; });
  return <section className="svb-depth-page svb-personal-detail"><PersonalBreadcrumb workspace={workspace} onNavigate={onNavigate} current={section.title} /><header className={`svb-personal-detail-heading svb-personal-tone--${section.icon}`}><span className="svb-personal-topic-symbol"><PersonalIcon name={section.icon} /></span><div><h1>{section.title}</h1><p>{section.description}</p></div></header>
    <div className={`svb-personal-section-content${actions.length ? '' : ' svb-personal-section-content--documents'}`}>
      {actions.length > 0 && <section><h2><span className="svb-partner-dot" aria-hidden="true" />С партнёром</h2><div className="svb-partner-actions">{actions.map(action => <ActionCard key={action.id} action={action} onAction={onAction} />)}</div></section>}
      <section><h2>Материалы</h2><DocumentList sources={sources} onSource={onSource} /></section>
    </div>
  </section>;
}

export function PersonalActionsPage({ workspace, onNavigate, onAction }: ViewProps) {
  const personal = workspace.personal;
  if (!personal) return null;
  const actions = workspace.actions;
  return <section className="svb-depth-page svb-personal-detail"><PersonalBreadcrumb workspace={workspace} onNavigate={onNavigate} current="С партнёром" /><header className="svb-library-heading"><span className="svb-kicker">С партнёром</span><h1>С чего начнём?</h1><p>Собрать день, вернуться к занятию или обдумать то, что важно.</p></header><div className="svb-personal-actions-grid">{actions.map(action => <ActionCard key={action.id} action={action} onAction={onAction} />)}</div>{!actions.length && <p className="svb-empty-copy">В этом пространстве пока нет подготовленных действий.</p>}</section>;
}

export interface PersonalLibraryState { query: string; archiveOpen: boolean; }

export function PersonalDocumentsPage({ workspace, onNavigate, onSource, library, onLibraryChange }: ViewProps & { library: PersonalLibraryState; onLibraryChange: (next: PersonalLibraryState) => void }) {
  const personal = workspace.personal;
  if (!personal) return null;
  const query = library.query.trim().toLocaleLowerCase('ru');
  const archiveIds = new Set(personal.archiveSourceIds);
  const sources = workspace.sources.filter(source => [source.title, ...personal.sections.filter(section => section.sourceIds.includes(source.id)).map(section => section.title)].join(' ').toLocaleLowerCase('ru').includes(query));
  const current = sources.filter(source => !archiveIds.has(source.id));
  const archived = sources.filter(source => archiveIds.has(source.id));
  return <section className="svb-depth-page svb-personal-detail"><PersonalBreadcrumb workspace={workspace} onNavigate={onNavigate} current="Материалы и архив" /><header className="svb-library-heading"><span className="svb-kicker">Личная библиотека</span><h1>Материалы и архив</h1><p>Заметки, документы и замыслы — к ним всегда можно вернуться.</p></header><label className="svb-document-search svb-personal-search"><span>Найти материал</span><input value={library.query} onChange={event => onLibraryChange({ ...library, query: event.target.value, archiveOpen: event.target.value.trim() ? true : library.archiveOpen })} placeholder="Название или тема" type="search" /></label>
    {current.length > 0 && <div className="svb-personal-current-documents"><h2>Под рукой</h2><DocumentList sources={current} onSource={onSource} /></div>}
    {archived.length > 0 && <details className="svb-personal-archive" open={library.archiveOpen}><summary onClick={event => { event.preventDefault(); onLibraryChange({ ...library, archiveOpen: !library.archiveOpen }); }}><PersonalIcon name="library" /><span>Архив<span>Старые записи и материалы</span></span><span className="svb-personal-archive-count">{archived.length}</span><span className="svb-expand-mark" aria-hidden="true">+</span></summary><DocumentList sources={archived} onSource={onSource} /></details>}
    {sources.length === 0 && <p className="svb-empty-copy" role="status">{query ? 'По этому запросу ничего не найдено.' : 'Материалы пока не добавлены.'}</p>}
  </section>;
}
