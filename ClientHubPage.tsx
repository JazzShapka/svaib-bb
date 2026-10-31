import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import { Markdown, useRpc } from '@get-bb/plugin-sdk/app';
import type { rpcContract } from './server';
import type { Action, SourceDocument, Workspace } from './types';
import { presentationMarkdown, registeredSourceForHref } from './document-presentation';
import './client-hub.css';

type Props = {
  workspace: Workspace;
  onSource: (id: string) => void;
  onAction: (action: Action) => void;
  guideOpen: boolean;
  onGuideToggle: (open: boolean) => void;
};

function Arrow({ down = false }: { down?: boolean }) {
  return <svg className="svb-client-arrow" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d={down ? 'm6 9 6 6 6-6' : 'M5 19 19 5M5 5h14v14'} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function ScenarioIcon({ kind }: { kind: 'conversation' | 'meeting' | 'client' | 'proposal' }) {
  return <svg className="svb-client-icon" viewBox="0 0 60 44" fill="none" aria-hidden="true">
    {kind === 'conversation' ? <><rect x="4" y="5" width="34" height="25" rx="8" fill="currentColor" opacity=".2" /><path d="M12 30v8l10-8M12 13h17M12 21h12M40 14h6a9 9 0 0 1 9 9v8l-7-4h-9" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></>
      : kind === 'meeting' ? <><rect x="7" y="8" width="42" height="31" rx="6" stroke="currentColor" strokeWidth="2.6" /><path d="M7 18h42M18 4v9M38 4v9m-19 15 6 5 12-11" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></>
        : kind === 'client' ? <><circle cx="24" cy="14" r="8" fill="currentColor" opacity=".3" /><path d="M10 38v-3a14 14 0 0 1 28 0v3M42 9a7 7 0 0 1 0 14m3 5a11 11 0 0 1 7 10" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" /><circle cx="24" cy="14" r="8" stroke="currentColor" strokeWidth="2.6" /></>
          : <><path d="M14 4h22l10 10v25H14V4Z" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" /><path d="M35 4v11h11M22 23h15M22 31h10" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" /></>}
  </svg>;
}

function GuideContent({ document, workspace, onSource }: { document: SourceDocument; workspace: Workspace; onSource: Props['onSource'] }) {
  const parts = presentationMarkdown(document.content).split(/(?=^##[ \t]+)/m).filter(part => part.trim());
  let question = 0;
  function followSource(event: MouseEvent<HTMLDivElement>) {
    const element = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = element?.getAttribute('href');
    if (!href) return;
    const sourceId = registeredSourceForHref(document.path, href, workspace.sources);
    if (!sourceId) return;
    event.preventDefault();
    event.stopPropagation();
    onSource(sourceId);
  }
  return <div className="svb-client-guide-content" onClickCapture={followSource}>
    {parts.map((part, index) => {
      const heading = /^##[ \t]+([^\r\n]+)(?:\r?\n|$)/.exec(part);
      if (!heading) return <div className="svb-client-guide-intro" key={index}><Markdown content={part} /></div>;
      question += 1;
      const title = heading[1].replace(/^(?:🔹\s*)?(?:\d+[.)]\s*)?/, '');
      return <section className="svb-client-question" key={index}>
        <span className="svb-client-question-number" aria-hidden="true">{String(question).padStart(2, '0')}</span>
        <div><h3>{title}</h3><Markdown content={part.slice(heading[0].length).trim()} /></div>
      </section>;
    })}
  </div>;
}

function SourceLinks({ ids, workspace, onSource, compact = false }: { ids: string[]; workspace: Workspace; onSource: Props['onSource']; compact?: boolean }) {
  return <div className={compact ? 'svb-client-material-links' : 'svb-client-work-links'}>{ids.map(id => {
    const source = workspace.sources.find(item => item.id === id);
    return source ? <button key={id} type="button" onClick={() => onSource(id)}><span>{source.title}</span><Arrow /></button> : null;
  })}</div>;
}

export default function ClientHubPage({ workspace, onSource, onAction, guideOpen, onGuideToggle }: Props) {
  const hub = workspace.clientHub;
  const rpc = useRpc<typeof rpcContract>();
  const [document, setDocument] = useState<SourceDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const guideId = hub?.guide.sourceId;
  useEffect(() => {
    if (!guideOpen || !guideId) return;
    let live = true;
    setDocument(null);
    setError(null);
    rpc.call('source', { workspaceId: workspace.id, sourceId: guideId }).then(result => {
      if (live) setDocument(result);
    }, cause => {
      if (live) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { live = false; };
  }, [workspace.id, guideId, guideOpen, attempt]);
  if (!hub) return null;

  return <section className="svb-client-hub" aria-labelledby="svb-client-title">
    <header className="svb-client-heading"><div><span className="svb-kicker">{workspace.eyebrow}</span><h1 id="svb-client-title">{workspace.name}</h1><p>{workspace.description}</p></div><span className="svb-client-heading-mark" aria-hidden="true">s.</span></header>

    <details className="svb-client-guide" open={guideOpen}>
      <summary onClick={event => { event.preventDefault(); onGuideToggle(!guideOpen); }} aria-expanded={guideOpen}>
        <ScenarioIcon kind="conversation" />
        <div><span className="svb-client-eyebrow">Начинаем знакомство</span><h2>{hub.guide.title}</h2><p>{hub.guide.description}</p></div>
        <Arrow down />
      </summary>
      <div className="svb-client-guide-body">
        {error ? <div className="svb-client-feedback" role="alert"><p>{error}</p><button type="button" className="svb-text-button" onClick={() => setAttempt(value => value + 1)}>Попробовать ещё раз</button></div>
          : document ? <GuideContent document={document} workspace={workspace} onSource={onSource} />
            : <p className="svb-client-feedback" role="status">Открываю вопросы для разговора…</p>}
        {hub.documentSourceIds.length > 0 && <footer className="svb-client-guide-materials"><span>Материалы для встречи</span><SourceLinks ids={hub.documentSourceIds} workspace={workspace} onSource={onSource} compact /></footer>}
      </div>
    </details>

    {hub.cards.length > 0 && <section className="svb-client-scenarios" aria-label="Работа с клиентом">{hub.cards.map(card => {
      const action = card.actionId ? workspace.actions.find(item => item.id === card.actionId) : undefined;
      const source = card.sourceId ? workspace.sources.find(item => item.id === card.sourceId) : undefined;
      const content = <><ScenarioIcon kind={card.icon} />{(action || source) && <Arrow />}<h2>{card.title}</h2><p>{card.description}</p></>;
      const className = `svb-client-scenario svb-client-scenario--${card.icon}`;
      return action || source ? <button key={card.id} className={className} type="button" disabled={action?.available === false} title={action?.available === false ? action.unavailableReason : undefined} onClick={() => action ? onAction(action) : source && onSource(source.id)}>{content}</button>
        : <article key={card.id} className={className}>{content}</article>;
    })}</section>}

    {hub.workSourceIds.length > 0 && <section className="svb-client-work"><header><h2>Клиенты в работе</h2><span>Контекст, встречи и договорённости</span></header><SourceLinks ids={hub.workSourceIds} workspace={workspace} onSource={onSource} /></section>}
  </section>;
}
