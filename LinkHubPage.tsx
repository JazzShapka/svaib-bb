import { experimental_FileLink as FileLink, UrlLink } from '@get-bb/plugin-sdk/app';
import type { HubLink, Workspace } from './types';
import './link-hub.css';

function Arrow() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 19 19 5M5 5h14v14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

function HubLinkView({ link, workspace, className = '' }: { link: HubLink; workspace: Workspace; className?: string }) {
  const content = <><div><h3>{link.title}</h3><p>{link.description}</p></div><Arrow /></>;
  if (link.kind === 'url') return <UrlLink className={className} href={link.url}>{content}</UrlLink>;
  const source = workspace.sources.find(item => item.id === link.sourceId);
  const context = workspace.fileContext;
  if (!source || !context) return <div className={className} role="status">{content}<span>Источник не подключён</span></div>;
  const prefix = context.rootPath.endsWith('/') ? context.rootPath : `${context.rootPath}/`;
  const target = source.path.startsWith(prefix)
    ? { kind: 'workspace' as const, environmentId: context.environmentId, path: source.path.slice(prefix.length) }
    : { kind: 'host' as const, hostId: context.hostId, path: source.path };
  return <FileLink className={className} target={target}>{content}</FileLink>;
}

function Geometry() {
  return <svg className="svb-hub-geometry" viewBox="0 0 240 190" fill="none" aria-hidden="true">
    <circle cx="174" cy="93" r="65" stroke="currentColor" strokeWidth="1" opacity=".22" />
    <path d="M19 153h202M54 32v140" stroke="currentColor" opacity=".12" />
    <rect x="53" y="67" width="72" height="72" rx="18" fill="currentColor" opacity=".13" />
    <rect x="111" y="33" width="71" height="71" rx="18" fill="currentColor" />
    <rect x="125" y="105" width="44" height="44" rx="12" fill="var(--svb-hub-blue)" />
    <circle cx="87" cy="103" r="12" fill="var(--svb-pink)" />
    <path d="m137 79 21-21m-21 0h21v21" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="209" cy="155" r="5" fill="var(--svb-pink)" />
  </svg>;
}

export default function LinkHubPage({ workspace }: { workspace: Workspace }) {
  const hub = workspace.linkHub;
  if (!hub) return null;
  return <section className="svb-link-hub" aria-labelledby="svb-hub-title">
    <header className="svb-hub-heading">
      <div><span className="svb-hub-eyebrow">{workspace.eyebrow}</span><h1 id="svb-hub-title">{workspace.goal}<span className="svb-hub-dot">.</span></h1><p>{workspace.description}</p></div>
      <Geometry />
    </header>

    <section className="svb-hub-feature" aria-labelledby="svb-hub-feature-title">
      <header><span className="svb-hub-eyebrow">{hub.featured.eyebrow}</span><span className="svb-hub-date"><i />{hub.featured.dateLabel}</span></header>
      <h2 id="svb-hub-feature-title">{hub.featured.title}</h2>
      <p className="svb-hub-feature-copy">{hub.featured.description}</p>
      <div className="svb-hub-feature-links">{hub.featured.links.slice(0, 3).map((link, index) => <div className="svb-hub-feature-item" key={link.id}><span className="svb-hub-link-number">0{index + 1}</span><HubLinkView link={link} workspace={workspace} className="svb-hub-main-link" /></div>)}</div>
      {hub.featured.links.length > 3 && <div className="svb-hub-support-links">{hub.featured.links.slice(3).map(link => <HubLinkView key={link.id} link={link} workspace={workspace} className="svb-hub-support-link" />)}</div>}
    </section>

    <div className="svb-hub-section-heading"><h2>База и быстрые переходы</h2><span>Рядом, когда понадобятся</span></div>
    <div className="svb-hub-groups">{hub.groups.map((group, index) => <section key={group.id} className="svb-hub-group" aria-labelledby={`svb-hub-${group.id}`}>
      <header><span className="svb-hub-group-number">0{index + 1}</span><h2 id={`svb-hub-${group.id}`}>{group.title}</h2><p>{group.description}</p></header>
      <div>{group.links.map(link => <HubLinkView key={link.id} link={link} workspace={workspace} className="svb-hub-resource" />)}</div>
    </section>)}</div>
    <footer className="svb-hub-footer"><span>Материалы остаются в своих источниках.</span><span>Подборка · {workspace.snapshotAt}</span></footer>
  </section>;
}
