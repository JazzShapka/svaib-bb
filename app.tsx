import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp, useRpc, useSdk, useBbNavigate, Markdown, ThreadChat, UrlLink,
  experimental_NewThreadComposer as NewThreadComposer,
  experimental_useFixedTabTarget as useFixedTabTarget, experimental_FileLink as FileLink,
} from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Action, ActionPreview, Overview, SourceDocument, SourceRef, Workspace, WorkspaceId } from "./types";
import "./app.css";
import { WorkspaceOverview, AspectPage, ItemPage, ActionsPage, DocumentsPage, placeLabel } from "./WorkplaceViews";
import type { Place, ActionContext } from "./WorkplaceViews";
import LinkHubPage from "./LinkHubPage";
import ClientHubPage from "./ClientHubPage";
import { presentationMarkdown, registeredSourceForHref } from "./document-presentation";
import "./document-presentation.css";
import { PersonalOverview, PersonalSectionPage, PersonalActionsPage, PersonalDocumentsPage } from "./PersonalViews";
import type { PersonalLibraryState } from "./PersonalViews";
import { AccountPage, AccountRouter } from "./experiments/account-prototype/app";
import { ScreenPanel } from "./ScreenPanel";

const report = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function dateLabel(value?: string) {
  if (!value) return "Источник";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date);
}
function Wordmark({ small = false }: { small?: boolean }) {
  return <span className={`svb-wordmark${small ? " svb-wordmark-small" : ""}`} aria-label="svaib"><span>sv</span><span className="svb-pink">ai</span><span>b</span><i aria-hidden="true" /></span>;
}
const glyphs: Record<string, string> = {
 ArrowLeft: 'M19 12H5m7-7-7 7 7 7', ArrowUpRight: 'M7 17 17 7M7 7h10v10',
 Flag: 'M5 21V4m0 0c5-4 9 4 14 0v10c-5 4-9-4-14 0',
 Sun: 'M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
 Calendar: 'M8 3v4m8-4v4M4 10h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2',
 CalendarDays: 'M8 3v4m8-4v4M4 10h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2M8 14h1m6 0h1m-8 4h1m6 0h1',
 CalendarPlus: 'M8 3v4m8-4v4M4 10h16M12 13v5m-2.5-2.5h5M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2',
 FileText: 'M14 3H6v18h12V7l-4-4v5h4M8 12h6m-6 4h8',
 Users: 'M15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0M5 21v-3a7 7 0 0 1 14 0v3M18 4a3 3 0 0 1 0 6m3 11v-4a5 5 0 0 0-3-4',
 ChartNoAxesCombined: 'M4 20V4m0 16h17M7 15l4-4 4 2 5-8',
 Target: 'M21 12a9 9 0 1 1-9-9m5 9a5 5 0 1 1-5-5m0 5 9-9m-5 0h5v5',
 ListChecks: 'M3 6l2 2 3-4m3 2h10M3 14l2 2 3-4m3 2h10M11 21h10',
 Search: 'M17 17l4 4M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
 MessageSquare: 'M4 4h16v13H9l-5 4V4',
 Clock3: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M12 7v5l3 2',
 Layers: 'm3 8 9-5 9 5-9 5-9-5m0 5 9 5 9-5M3 18l9 5 9-5',
 Compass: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0m-5-4-3 5-5 3 3-5 5-3',
 CircleAlert: 'M12 8v5m0 3v.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
 LoaderCircle: 'M21 12a9 9 0 1 1-9-9',
};
function Glyph({ name, className = '' }: { name: string; className?: string }) {
 return <svg className={`svb-icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={glyphs[name] || glyphs.MessageSquare}/></svg>;
}
type ContextTarget = { workspaceId: WorkspaceId; sourceId: string };
const contextTab = {
 context: { kind: 'nav-panel' as const, panelId: 'workplace' }, availability: 'fixed' as const,
 id: 'context', experimental_target: {
  validate(value: unknown): value is ContextTarget {
   return !!value && typeof value === 'object' && 'workspaceId' in value && 'sourceId' in value &&
    typeof value.workspaceId === 'string' && value.workspaceId.length > 0 && value.workspaceId.length < 80 &&
    typeof value.sourceId === 'string' && value.sourceId.length > 0 && value.sourceId.length < 80;
  },
 },
};
function Feedback({ error, children, retry }: { error?: string | null; children?: ReactNode; retry?: () => void }) {
  return <div className={`svb-feedback${error ? " svb-feedback-error" : ""}`} role={error ? "alert" : "status"}>
    <Glyph name={error ? "CircleAlert" : "LoaderCircle"} className={error ? "" : "svb-spin"} />
    <span>{error || children || "Поднимаю контекст…"}</span>
    {error && retry && <button className="svb-text-button" onClick={retry}>Повторить</button>}
  </div>;
}
function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const refresh = useCallback(() => {
    const current = ++sequence.current;
    setError(null);
    rpc.call("overview", null).then((result) => { if (current === sequence.current) setData(result); },
      (cause) => { if (current === sequence.current) setError(report(cause)); });
  }, [rpc]);
  useEffect(() => { refresh(); return () => { sequence.current++; }; }, [refresh]);
  return { data, error, refresh };
}
function SourceButton({ source, onClick }: { source: SourceRef; onClick: () => void }) {
  return <button className="svb-source-link" onClick={onClick} title={`Открыть: ${source.title}`}>
    <Glyph name="FileText" /><span>{source.title}</span><span className="svb-date">{dateLabel(source.updatedAt)}</span><Glyph name="ArrowUpRight" />
  </button>;
}
function SourceView({ workspaceId, sourceId, onBack, backLabel = "К обзору", presentation = false, sources = [], onSource }: { workspaceId: WorkspaceId; sourceId: string; onBack: () => void; backLabel?: string; presentation?: boolean; sources?: SourceRef[]; onSource?: (id: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [document, setDocument] = useState<SourceDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [presenting, setPresenting] = useState(false);
  useEffect(() => {
    if (!presenting) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setPresenting(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [presenting]);
  useEffect(() => {
    let live = true;
    setDocument(null); setError(null);
    rpc.call("source", { workspaceId, sourceId }).then((result) => { if (live) setDocument(result); }, (cause) => { if (live) setError(report(cause)); });
    return () => { live = false; };
  }, [rpc, workspaceId, sourceId, attempt]);
  return <section className={`svb-document-view${presentation ? " svb-document-view--client" : ""}${presenting ? " svb-document-view--presenting" : ""}`}>
    <div className="svb-document-toolbar"><button className="svb-back" onClick={presenting ? () => setPresenting(false) : onBack}><Glyph name="ArrowLeft" />{presenting ? "Вернуться в рабочее место" : backLabel}</button>
      {presentation && document && !presenting && <button className="svb-text-button" onClick={() => setPresenting(true)}>Режим показа<Glyph name="ArrowUpRight" /></button>}
      {presenting && <span className="svb-kicker">svaib</span>}
    </div>
    {!document ? <Feedback error={error} retry={() => setAttempt(n => n + 1)}>Открываю источник…</Feedback> : <>
      <header className="svb-document-header"><span className="svb-kicker">{presentation ? "svaib · вместе с вашей командой" : "Первоисточник · только чтение"}</span><h1>{document.title}</h1>{presentation ? <details className="svb-document-provenance"><summary>Источник</summary><div className="svb-document-meta"><span>Изменён {dateLabel(document.modifiedAt)}</span><span>{document.path}</span></div><FileLink className="svb-original-file" target={{ kind: "host", hostId: document.hostId, path: document.path }}>Открыть исходный файл<Glyph name="ArrowUpRight" /></FileLink></details> : <><div className="svb-document-meta"><span>Изменён {dateLabel(document.modifiedAt)}</span><span title={document.path}>{document.path}</span></div><FileLink className="svb-original-file" target={{ kind: "host", hostId: document.hostId, path: document.path }}>Открыть исходный файл<Glyph name="ArrowUpRight" /></FileLink></>}</header>
      <div className="svb-document" onClickCapture={event => {
        if (!presentation || !onSource || !(event.target instanceof Element)) return;
        const href = event.target.closest('a')?.getAttribute('href');
        const targetId = href ? registeredSourceForHref(document.path, href, sources) : undefined;
        if (targetId) { event.preventDefault(); event.stopPropagation(); onSource(targetId); }
      }}><Markdown content={presentation ? presentationMarkdown(document.content) : document.content} experimental_document={document.documentContext} /></div>
    </>}
  </section>;
}
function ActionSetup({ workspace, action, context, backLabel, onBack, onStarted }: { workspace: Workspace; action: Action; context?: ActionContext; backLabel: string; onBack: () => void; onStarted: (threadId: string, title: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const [preview, setPreview] = useState<ActionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const liveSetup = useRef(true);
  const personalAssistant = action.effect === "personal-assistant";
  const freeAssistant = workspace.personal?.assistantActionId === action.id;
  const submitSequence = useRef(0);
  useEffect(() => {
    liveSetup.current = true;
    return () => { liveSetup.current = false; submitSequence.current++; };
  }, []);
  useEffect(() => {
    let live = true;
    setPreview(null); setError(null);
    rpc.call("preview", { workspaceId: workspace.id, actionId: action.id, ...context }).then(result => { if (live) setPreview(result); }, cause => { if (live) setError(report(cause)); });
    return () => { live = false; };
  }, [rpc, workspace.id, action.id, context?.aspectId, context?.itemId, attempt]);
  return <section className="svb-setup"><button className="svb-back" onClick={onBack}><Glyph name="ArrowLeft" />{backLabel}</button><div className="svb-setup-heading"><span className="svb-kicker">{personalAssistant ? "Личный ассистент" : "Работа с партнёром"}</span><h1>{action.title}</h1><p>{action.description}</p></div>
    {!preview ? <Feedback error={error} retry={() => setAttempt(n => n + 1)}>Готовлю контекст задачи…</Feedback> : <><div className="svb-setup-note"><Glyph name="MessageSquare" /><p>{action.mode === "draft-only" ? "Только подготовка: партнёр покажет анализ и черновик. Эта кнопка не меняет документы и не отправляет сообщения." : action.effect === "metrics-refresh" ? "Отправьте готовый запрос: партнёр перечитает источники и обновит графики. Исходные таблицы не изменятся. После завершения нажмите «К графикам»." : personalAssistant ? (freeAssistant ? "Напиши или надиктуй, с чем помочь. Ассистент учтёт твой план; разговор откроется прямо здесь." : "Запрос уже готов — можно уточнить его и отправить. Ассистент подключит нужные инструменты.") : "Задача уже сформулирована. Уточните её своими словами и отправьте партнёру."}</p></div>{error && <Feedback error={error} />}{starting && <Feedback>Открываю рабочий разговор…</Feedback>}<div className="svb-native-composer"><NewThreadComposer key={`${workspace.id}/${action.id}/${context?.aspectId ?? ""}/${context?.itemId ?? ""}/${attempt}`} defaultProjectId={preview.projectId} defaultEnvironment={{ type: "reuse", environmentId: preview.environmentId }} initialPrompt={freeAssistant ? "" : preview.prompt} draftKey={`svaib-workplace/${workspace.id}/${action.id}/${context?.aspectId ?? ""}/${context?.itemId ?? ""}`} layout="document" onSubmit={async request => {
      const sequence = ++submitSequence.current;
      const isCurrent = () => liveSetup.current && sequence === submitSequence.current;
      setStarting(true); setError(null);
      try {
        const current = await rpc.call("preview", { workspaceId: workspace.id, actionId: action.id, ...context });
        if (!isCurrent()) throw new Error("Отправка отменена: задача больше не открыта. Черновик сохранён.");
        const result = await sdk.threads.spawn({ ...request, title: current.title, pluginMetadata: { workspaceId: workspace.id, actionId: action.id, ...context, schema: 1 } });
        if (isCurrent()) onStarted(result.id, current.title);
      }
      catch (cause) { if (isCurrent()) setError(report(cause)); throw cause; }
      finally { if (isCurrent()) setStarting(false); }
    }} /></div><p className="svb-setup-footnote">{personalAssistant ? "Можно продолжить разговор здесь или открыть его отдельным чатом." : "Откроется отдельный разговор. Модель, рабочее место и права запуска остаются под вашим контролем."}</p></>}
  </section>;
}
type View = Place | { kind: "source"; sourceId: string; returnTo: Place } | { kind: "action"; action: Action; context?: ActionContext; returnTo: Place } | { kind: "thread"; threadId: string; title: string; returnTo: Place; metricsRefresh?: boolean };
function EmptyWorkspaces() {
  const navigate = useBbNavigate();
  return <section className="svb-empty" role="status"><Glyph name="Layers" /><h2>Продолжим настройку рабочего места</h2><p>Подключи партнёра и пройди онбординг своей компании.</p><button className="svb-primary-button" onClick={() => navigate.toPluginPanel('account')}>Подключить svaib<Glyph name="ArrowUpRight" /></button></section>;
}
function WorkplacePage({ subPath = "" }: Partial<PluginNavPanelProps>) {
  const { data, error, refresh } = useOverview();
  const navigate = useBbNavigate();
  const route = subPath.split("/")[0];
  const workspace = data?.workspaces.find(item => item.id === route) ?? data?.workspaces[0];
  const [view, setView] = useState<View>({ kind: "overview" });
  const [personalLibraries, setPersonalLibraries] = useState<Record<string, PersonalLibraryState>>({});
  const [clientGuides, setClientGuides] = useState<Record<string, boolean>>({});
  const scroll = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, number>());
  const viewKey = JSON.stringify(view);
  const go = (next: View) => {
    if (scroll.current) positions.current.set(viewKey, scroll.current.scrollTop);
    setView(next);
  };
  useEffect(() => { positions.current.clear(); setView({ kind: "overview" }); }, [subPath, workspace?.id]);
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = positions.current.get(viewKey) ?? 0; }, [viewKey]);
  const place: Place = 'returnTo' in view ? view.returnTo : view;
  const handlers = workspace ? {
    workspace,
    onNavigate: (next: Place) => { if (next.kind === "aspect" && next.aspectId === "metrics") refresh(); go(next); },
    onSource: (sourceId: string) => go({ kind: "source", sourceId, returnTo: place }),
    onAction: (action: Action, context?: ActionContext) => go({ kind: "action", action, context, returnTo: place }),
  } : null;
  if (data && !error && data.workspaces.length === 0) return <AccountPage production />;
  return <div className={`svb svb-workplace${view.kind === "thread" ? " svb-workplace-chat" : ""}`}>
    <nav className="svb-contexts" aria-label="Рабочие контексты"><div className="svb-context-tabs">{data?.workspaces.map(item => <button key={item.id} className={workspace?.id === item.id ? "is-active" : ""} aria-current={workspace?.id === item.id ? "page" : undefined} onClick={() => { go({ kind: "overview" }); navigate.toPluginPanel("workplace", { subPath: item.id }); }}>{item.tabColor && <span className={`svb-tab-dot svb-tab-dot--${item.tabColor}`} aria-hidden="true" />}{item.name}</button>)}<button onClick={() => navigate.toPluginPanel('account')}>Аккаунт svaib</button></div></nav>
    {view.kind === "thread" && workspace ? <div className="svb-conversation"><div className="svb-conversation-heading"><button className="svb-back" onClick={() => { refresh(); go(view.returnTo); }}><Glyph name="ArrowLeft" />{view.metricsRefresh ? "К графикам" : placeLabel(view.returnTo, workspace)}</button><span>{view.title}</span><button className="svb-text-button" onClick={() => navigate.toThread(view.threadId)}>Открыть разговор<Glyph name="ArrowUpRight" /></button></div><ThreadChat threadId={view.threadId} variant="full" layout="contained" permissionPolicy="inherit" className="svb-thread-chat" /></div> : <div className="svb-scroll" ref={scroll}><div className="svb-page">
      {data && error && <Feedback error={error} retry={refresh} />}
      {!data ? <Feedback error={error} retry={refresh} /> : !workspace || !handlers ? <EmptyWorkspaces /> : view.kind === "source" ? <SourceView key={`${workspace.id}/${view.sourceId}`} workspaceId={workspace.id} sourceId={view.sourceId} backLabel={workspace.clientHub ? "К клиентам" : placeLabel(view.returnTo, workspace)} onBack={() => go(view.returnTo)} presentation={Boolean(workspace.clientHub)} sources={workspace.sources} onSource={handlers.onSource} /> : view.kind === "action" ? <ActionSetup key={`${workspace.id}/${view.action.id}/${view.context?.aspectId ?? ""}/${view.context?.itemId ?? ""}`} workspace={workspace} action={view.action} context={view.context} backLabel={placeLabel(view.returnTo, workspace)} onBack={() => go(view.returnTo)} onStarted={(threadId, title) => go({ kind: "thread", threadId, title, returnTo: view.action.effect === "metrics-refresh" ? { kind: "aspect", aspectId: "metrics" } : view.returnTo, metricsRefresh: view.action.effect === "metrics-refresh" })} /> : workspace.clientHub ? <ClientHubPage {...handlers} guideOpen={clientGuides[workspace.id] ?? false} onGuideToggle={open => setClientGuides(previous => ({ ...previous, [workspace.id]: open }))} /> : workspace.personal ? (
        view.kind === "personal-section" ? <PersonalSectionPage {...handlers} sectionId={view.sectionId} />
          : view.kind === "actions" ? <PersonalActionsPage {...handlers} />
          : view.kind === "sources" ? <PersonalDocumentsPage {...handlers} library={personalLibraries[workspace.id] ?? { query: "", archiveOpen: false }} onLibraryChange={next => setPersonalLibraries(previous => ({ ...previous, [workspace.id]: next }))} />
          : <PersonalOverview {...handlers} />
      ) : workspace.linkHub ? <LinkHubPage workspace={workspace} /> : view.kind === "aspect" ? <AspectPage {...handlers} aspectId={view.aspectId} /> : view.kind === "item" ? <ItemPage {...handlers} aspectId={view.aspectId} itemId={view.itemId} /> : view.kind === "actions" ? <ActionsPage {...handlers} /> : view.kind === "sources" ? <DocumentsPage {...handlers} /> : <WorkspaceOverview {...handlers} />}
    </div></div>}
  </div>;
}
function HomeSection() {
  const navigate = useBbNavigate();
  const { data, error, refresh } = useOverview();
  return <section className="svb svb-home"><div className="svb-home-copy"><Wordmark /><h2>Не начинать с нуля.</h2><p>Цель, дела и нужный следующий шаг — уже в контексте.</p></div><div className="svb-home-contexts">{!data ? <Feedback error={error} retry={refresh} /> : data.workspaces.length === 0 ? <EmptyWorkspaces /> : data.workspaces.map(workspace => <button key={workspace.id} onClick={() => navigate.toPluginPanel("workplace", { subPath: workspace.id })}><span>{workspace.name}</span><Glyph name="ArrowUpRight" /></button>)}</div></section>;
}
function ContextPanel({ subPath = "", selected, clear }: Partial<PluginNavPanelProps> & { selected?: { sequence: number; target: ContextTarget }; clear?: () => void }) {
  const { data, error, refresh } = useOverview();
  const navigate = useBbNavigate();
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId>(subPath.split("/")[0]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  useEffect(() => {
    setWorkspaceId(subPath.split("/")[0]);
    setSourceId(null);
  }, [subPath]);
  useEffect(() => {
    if (selected) { setWorkspaceId(selected.target.workspaceId); setSourceId(selected.target.sourceId); }
  }, [selected?.sequence, selected?.target.workspaceId, selected?.target.sourceId]);
  const workspace = data?.workspaces.find(item => item.id === workspaceId) ?? data?.workspaces[0];
  return <div className="svb svb-context-panel">{sourceId && workspace ? <SourceView workspaceId={workspace.id} sourceId={sourceId} onBack={() => { setSourceId(null); clear?.(); }} /> : <><Wordmark small /><h2>Держать целое в поле зрения</h2>{!data ? <Feedback error={error} retry={refresh} /> : !workspace ? <EmptyWorkspaces /> : <><label className="svb-select-label">Контекст<select value={workspace.id} onChange={event => { setWorkspaceId(event.target.value); setSourceId(null); clear?.(); }}>{data.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><span className="svb-kicker">{workspace.goalLabel}</span><p className="svb-context-goal">{workspace.goal}</p><div className="svb-source-list">{workspace.sources.map(source => <SourceButton key={source.id} source={source} onClick={() => setSourceId(source.id)} />)}</div><button className="svb-primary-button" onClick={() => navigate.toPluginPanel("workplace", { subPath: workspace.id })}>Открыть рабочее место<Glyph name="ArrowUpRight" /></button></>}</>}</div>;
}
function FixedContextPanel(props: PluginNavPanelProps) {
 const selected = useFixedTabTarget(contextTab);
 return <ContextPanel {...props} selected={selected || undefined} clear={selected?.clear}/>;
}
export default definePluginApp(app => {
  app.experimental_icons.register({ name: "svaib-workplace/brand", component: ({className}) => <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true"><text x="2" y="20" fontFamily="Montserrat, Inter, sans-serif" fontSize="25" fontWeight="800" fill="var(--svb-teal, #00B4A6)">s</text><circle cx="21" cy="19.5" r="2" fill="#FF4D8D"/></svg> });
  app.experimental_icons.register({ name: "svaib-workplace/compass", component: ({className}) => <Glyph name="Compass" className={className} /> });
  app.slots.navPanel({ id: "workplace", path: "workplace", title: "svaib", icon: "svaib-workplace/brand", component: WorkplacePage });
  app.slots.navPanel({ id: 'account', path: 'account', title: 'Мой svaib', icon: 'UserRound', component: props => <AccountRouter {...props} production /> });
  app.slots.experimental_tab({ ...contextTab, title: "Контекст", icon: "svaib-workplace/compass", component: FixedContextPanel, layout: "flush" });
  app.slots.homepageSection({ id: "workplace-home", title: "svaib · рабочее место", component: HomeSection });
  app.slots.experimental_tab({ context: { kind: "thread" }, availability: "action", id: "svaib-context", title: "Контекст svaib", icon: "svaib-workplace/compass", component: () => <ContextPanel />, layout: "flush" });
  app.slots.experimental_tab({ context: { kind: 'thread' }, availability: 'action', id: 'svaib-screen', title: 'Screen', icon: 'PanelsTopLeft', component: ({ threadId }) => <ScreenPanel threadId={threadId} />, layout: 'flush' });
});
