import { useEffect, useRef, useState } from 'react';
import type { Block, Screen } from '../src/model';
import type { ScreenTransport } from './ScreenRenderer';
import { treeConfigSchema, type TreeConfig } from '../src/scaffold-tree-model';
import { toTreeConfig } from './scaffold-tree';
import manifest from '../src/scaffold-catalog.json';
import source from './scaffold-source.json';
import './scaffold-site.css';
import type { ScaffoldFrameMessage } from './raw';

const html = source.replace('__SCREEN_TEMPLATES__', JSON.stringify(manifest.templates.map(item => item.path)).replaceAll('<', '\\u003c'));
type Props = { block: Extract<Block, { type: 'scaffold' }>; screen: Screen; transport: ScreenTransport; receive(screen: Screen): void };
export function ScaffoldEditor(props: Props) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(650);
  const latest = useRef(props); latest.current = props;
  const draft = useRef<TreeConfig>(toTreeConfig(props.block.config));
  const base = useRef(JSON.stringify(draft.current));
  const revision = useRef(props.screen.revision);
  const busy = useRef(false);
  const ready = useRef(false);
  function post(message: unknown) { iframe.current?.contentWindow?.postMessage(message, '*'); }
  useEffect(() => {
    const incoming = toTreeConfig(props.block.config);
    const clean = JSON.stringify(draft.current) === base.current;
    if (clean || JSON.stringify(draft.current) === JSON.stringify(incoming)) {
      const changed = base.current !== JSON.stringify(incoming);
      draft.current = incoming; base.current = JSON.stringify(incoming); revision.current = props.screen.revision;
      if (ready.current && changed) post({ type: 'screen-init', config: incoming });
    }
  }, [props.block.config, props.screen.revision]);
  useEffect(() => {
    let alive = true;
    async function handoff(raw: unknown) {
      if (busy.current) return;
      const parsed = treeConfigSchema.safeParse(raw);
      if (!parsed.success) { post({ type: 'screen-status', message: parsed.error.issues[0].message }); return; }
      busy.current = true; post({ type: 'screen-status', busy: true, message: '' });
      try {
        const current = latest.current;
        if (!current.transport.update || !current.transport.confirmScaffold) throw new Error('Передача структуры не поддерживается этим подключением.');
        const config = parsed.data;
        const result = await current.transport.update({ id: current.screen.id, requestId: crypto.randomUUID(), expectedRevision: revision.current,
          document: { ...current.screen.document, blocks: current.screen.document.blocks.map(item => item.id === current.block.id ? { ...current.block, config } : item) } });
        if (!alive) return;
        draft.current = config; base.current = JSON.stringify(config); revision.current = result.screen.revision;
        current.receive(result.screen);
        const confirmed = await current.transport.confirmScaffold({ id: result.screen.id, requestId: crypto.randomUUID(), expectedRevision: result.screen.revision, blockId: current.block.id });
        if (!alive) return;
        revision.current = confirmed.screen.revision; current.receive(confirmed.screen);
        post({ type: 'screen-status', message: 'Структура передана агенту. Если он не продолжил, напишите «Забери структуру».' });
      } catch (cause) {
        if (alive) post({ type: 'screen-status', message: (cause as Error).message });
      } finally { busy.current = false; if (alive) post({ type: 'screen-status', busy: false }); }
    }
    function listener(event: MessageEvent) {
      if (event.source !== iframe.current?.contentWindow) return;
      const data = event.data as ScaffoldFrameMessage;
      if (data?.type === 'screen-resize' && typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0 && data.height <= 1_000_000) setHeight(Math.ceil(data.height));
      if (data?.type === 'screen-ready') { ready.current = true; post({ type: 'screen-init', config: draft.current }); }
      if (data?.type === 'screen-change') {
        const parsed = treeConfigSchema.safeParse(data.config);
        if (parsed.success) draft.current = parsed.data;
      }
      if (data?.type === 'screen-handoff') void handoff(data.config);
    }
    window.addEventListener('message', listener);
    return () => { alive = false; ready.current = false; window.removeEventListener('message', listener); };
  }, []);
  return <iframe ref={iframe} className="screen-constructor-frame" style={{ height }} title="Конструктор каркаса" sandbox="allow-scripts" onLoad={() => { if (!ready.current) { ready.current = true; post({ type: 'screen-init', config: draft.current }); } }} srcDoc={html} />;
}
