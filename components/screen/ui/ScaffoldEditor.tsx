import { useEffect, useRef, useState } from 'react';
import type { Block, Screen } from '../src/model';
import type { ScreenTransport } from './ScreenRenderer';
import { treeConfigSchema, type TreeConfig } from '../src/scaffold-tree-model';
import { toTreeConfig } from './scaffold-tree';
import manifest from '../src/scaffold-catalog.json';
import source from './scaffold-source.json';
import './scaffold-site.css';
import type { ScaffoldFrameMessage } from './raw';
import { z } from 'zod';

const html = source.replace('__SCREEN_TEMPLATES__', JSON.stringify(manifest.templates.map(item => item.path)).replaceAll('<', '\\u003c'));
const uiSchema = z.object({ selectedId: z.string().max(200), openIds: z.array(z.string().max(200)).max(5000),
  controlGroups: z.record(z.string(), z.boolean()) }).strict();
type UiState = z.infer<typeof uiSchema>;
type SavedDraft = { draft: TreeConfig; base: string; revision: number; ui?: UiState };
const drafts = new Map<string, SavedDraft>();
const draftOwners = new Map<string, symbol>();
export function clearScaffoldDrafts() { drafts.clear(); draftOwners.clear(); }
function saveDraft(key: string | undefined, owner: symbol, value: SavedDraft) {
  if (!key || draftOwners.get(key) !== owner) return;
  drafts.delete(key); drafts.set(key, value);
  while (drafts.size > 20) { const oldest = drafts.keys().next().value!; drafts.delete(oldest); draftOwners.delete(oldest); }
}
type Props = { block: Extract<Block, { type: 'scaffold' }>; screen: Screen; transport: ScreenTransport; receive(screen: Screen): void; cacheKey?: string };
export function ScaffoldEditor(props: Props) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(650);
  const [conflict, setConflict] = useState(false);
  const latest = useRef(props); latest.current = props;
  const server = useRef(props.screen);
  if (props.screen.revision > server.current.revision) server.current = props.screen;
  const saved = props.cacheKey ? drafts.get(props.cacheKey) : undefined;
  const owner = useRef(Symbol('screen-draft'));
  const draft = useRef<TreeConfig>(saved?.draft ?? toTreeConfig(props.block.config));
  const base = useRef(saved?.base ?? JSON.stringify(toTreeConfig(props.block.config)));
  const revision = useRef(saved?.revision ?? props.screen.revision);
  const ui = useRef<UiState | undefined>(saved?.ui);
  const busy = useRef(false);
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = useRef(false);
  function post(message: unknown) { iframe.current?.contentWindow?.postMessage(message, '*'); }
  function remember() { saveDraft(props.cacheKey, owner.current, { draft: draft.current, base: base.current, revision: revision.current, ui: ui.current }); }
  useEffect(() => { if (props.cacheKey) { draftOwners.set(props.cacheKey, owner.current); remember(); } }, [props.cacheKey]);
  useEffect(() => {
    const incoming = toTreeConfig(props.block.config);
    const clean = JSON.stringify(draft.current) === base.current;
    if (clean || JSON.stringify(draft.current) === JSON.stringify(incoming)) {
      const changed = base.current !== JSON.stringify(incoming);
      draft.current = incoming; base.current = JSON.stringify(incoming); revision.current = props.screen.revision;
      remember();
      if (ready.current && changed) post({ type: 'screen-init', config: incoming, ui: ui.current });
      setConflict(false);
    } else if (!saving.current && props.screen.revision !== revision.current) setConflict(true);
  }, [props.block.config, props.screen.revision]);
  useEffect(() => {
    let alive = true;
    async function saveDraftToServer() {
      if (saving.current) { await saving.current; return; }
      const current = latest.current;
      if (!current.transport.update || JSON.stringify(draft.current) === base.current) return;
      if (server.current.revision !== revision.current) { if (alive) setConflict(true); throw new Error('Структура изменилась в другом месте.'); }
      const config = draft.current;
      const snapshot = server.current;
      const operation = (async () => {
        const result = await current.transport.update!({ id: snapshot.id, requestId: crypto.randomUUID(), expectedRevision: revision.current,
          document: { ...snapshot.document, blocks: snapshot.document.blocks.map(item => item.id === current.block.id ? { ...current.block, config } : item) } });
        const newer = server.current.revision > result.screen.revision;
        if (!newer) server.current = result.screen;
        base.current = JSON.stringify(config); revision.current = result.screen.revision; remember();
        if (newer && alive) setConflict(true);
        if (alive) current.receive(result.screen);
      })();
      saving.current = operation;
      try { await operation; } finally { saving.current = null; }
    }
    function scheduleSave() {
      if (!latest.current.transport.update) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void saveDraftToServer().then(() => {
          if (alive && JSON.stringify(draft.current) !== base.current && server.current.revision === revision.current) scheduleSave();
        }).catch(async () => {
          if (!alive) return;
          post({ type: 'screen-status', message: 'Не удалось сохранить изменения. Черновик сохранён в этом окне.' });
          try { const current = await latest.current.transport.load(); if (alive) latest.current.receive(current); } catch { /* Keep the local draft. */ }
        });
      }, 400);
    }
    async function flushDraft() {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      if (!latest.current.transport.update) return;
      while (JSON.stringify(draft.current) !== base.current || saving.current) await saveDraftToServer();
    }
    const unregisterDrain = latest.current.transport.registerDrain?.(flushDraft);
    async function handoff(raw: unknown) {
      if (busy.current) return;
      const parsed = treeConfigSchema.safeParse(raw);
      if (!parsed.success) { post({ type: 'screen-status', message: parsed.error.issues[0].message }); return; }
      busy.current = true; post({ type: 'screen-status', busy: true, message: '' });
      try {
        if (timer.current) { clearTimeout(timer.current); timer.current = null; }
        draft.current = parsed.data; remember();
        if (!latest.current.transport.update || (!parsed.data.overview && !latest.current.transport.confirmScaffold)) throw new Error('Передача структуры не поддерживается этим подключением.');
        while (JSON.stringify(draft.current) !== base.current || saving.current) await saveDraftToServer();
        const current = latest.current;
        if (parsed.data.overview) {
          post({ type: 'screen-status', message: 'Обзор сохранён. Попросите агента забрать его для обсуждения; это не план файловых изменений.' });
          return;
        }
        const confirmed = await current.transport.confirmScaffold!({ id: current.screen.id, requestId: crypto.randomUUID(), expectedRevision: revision.current, blockId: current.block.id });
        if (!alive) return;
        server.current = confirmed.screen; revision.current = confirmed.screen.revision; remember(); current.receive(confirmed.screen);
        post({ type: 'screen-status', message: 'Структура передана агенту. Если он не продолжил, напишите «Забери структуру».' });
      } catch (cause) {
        if (alive) {
          post({ type: 'screen-status', message: (cause as Error).message });
          try { const current = await latest.current.transport.load(); if (alive) latest.current.receive(current); } catch { /* Keep the draft when refresh fails. */ }
        }
      } finally { busy.current = false; if (alive) post({ type: 'screen-status', busy: false }); }
    }
    function listener(event: MessageEvent) {
      if (event.source !== iframe.current?.contentWindow) return;
      const data = event.data as ScaffoldFrameMessage;
      if (data?.type === 'screen-resize' && typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0 && data.height <= 1_000_000) setHeight(Math.ceil(data.height));
      if (data?.type === 'screen-ready') { ready.current = true; post({ type: 'screen-init', config: draft.current, ui: ui.current }); }
      if (data?.type === 'screen-change') {
        const parsed = treeConfigSchema.safeParse(data.config);
        if (parsed.success) { draft.current = parsed.data; remember(); scheduleSave(); }
      }
      if (data?.type === 'screen-ui') { const parsed = uiSchema.safeParse(data.ui); if (parsed.success) { ui.current = parsed.data; remember(); } }
      if (data?.type === 'screen-handoff') void handoff(data.config);
    }
    window.addEventListener('message', listener);
    if (JSON.stringify(draft.current) !== base.current && latest.current.screen.revision === revision.current) scheduleSave();
    return () => {
      alive = false; ready.current = false;
      window.removeEventListener('message', listener);
      unregisterDrain?.();
      void flushDraft().catch(() => { /* The local cache retains an unsaved draft. */ });
    };
  }, []);
  function acceptServerVersion() {
    const current = latest.current;
    const incoming = toTreeConfig(current.block.config);
    draft.current = incoming; base.current = JSON.stringify(incoming); revision.current = current.screen.revision;
    remember(); setConflict(false); post({ type: 'screen-init', config: incoming, ui: ui.current });
  }
  return <>{conflict && <div role="alert"><p>Структура изменилась в другом месте. Твой черновик сохранён, но передать его поверх новой версии нельзя.</p><button type="button" onClick={acceptServerVersion}>Открыть актуальную версию и отбросить черновик</button></div>}<iframe ref={iframe} className="screen-constructor-frame" style={{ height }} title="Конструктор каркаса" sandbox="allow-scripts" onLoad={() => { if (!ready.current) { ready.current = true; post({ type: 'screen-init', config: draft.current, ui: ui.current }); } }} srcDoc={html} /></>;
}
