import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { Block, Screen } from '../src/model';
import { ScaffoldEditor } from './ScaffoldEditor';
import './screen.css';

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, SVGRenderer]);
type ChartBlock = Extract<Block, { type: 'chart' }>;
const number = (value: number | null | undefined) => value == null ? 'Нет данных' : value.toLocaleString('ru-RU');

function Chart({ block }: { block: ChartBlock }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'svg' });
    chart.setOption({
      color: ['#22988d', '#d977a9'],
      grid: { left: 48, right: 16, top: 48, bottom: 35 },
      tooltip: { trigger: 'axis', renderMode: 'richText' },
      legend: { top: 8, textStyle: { color: '#52647a' } },
      xAxis: { type: 'category', data: block.points.map(point => point.label), axisLabel: { color: '#52647a', hideOverlap: true } },
      yAxis: { type: 'value', axisLabel: { color: '#52647a' } },
      series: [
        { name: 'Факт', type: 'bar', data: block.points.map(point => point.value), barMaxWidth: 30 },
        { name: 'План', type: 'bar', data: block.points.map(point => point.plan ?? null), barMaxWidth: 30 },
      ],
    });
    const resize = new ResizeObserver(() => chart.resize()); resize.observe(ref.current);
    return () => { resize.disconnect(); chart.dispose(); };
  }, [block]);
  return <>
    <div ref={ref} className="screen-chart" role="img" aria-label={`${block.title}. Факт и план; значения в таблице ниже.`} />
    <details><summary>Таблица значений · {block.unit}</summary><div className="screen-table-scroll"><table>
      <caption>{block.title}</caption><thead><tr><th>Период</th><th>Факт</th><th>План</th></tr></thead>
      <tbody>{block.points.map((point, index) => <tr key={index}><td>{point.label}</td><td>{number(point.value)}</td><td>{number(point.plan)}</td></tr>)}</tbody>
    </table></div></details>
    <p className="screen-source">{block.source.title} · проверено {new Date(block.verifiedAt).toLocaleString('ru-RU')}<br /><code>{block.source.ref}</code></p>
  </>;
}

export type ScreenTransport = {
  load(): Promise<Screen>;
  submit(input: { id: string; requestId: string; expectedRevision: number; selectedIds: string[] }): Promise<{ screen: Screen }>;
  update?(input: { id: string; requestId: string; expectedRevision: number; document: Screen['document'] }): Promise<{ screen: Screen }>;
  confirmScaffold?(input: { id: string; requestId: string; expectedRevision: number; blockId: string }): Promise<{ screen: Screen }>;
  subscribe?(invalidate: () => void): () => void;
};

const snapshots = new Map<string, Screen>();
const SNAPSHOT_LIMIT = 20;
export function clearScreenSnapshots() { snapshots.clear(); }
function rememberSnapshot(key: string | undefined, screen: Screen) {
  if (!key) return;
  snapshots.delete(key); snapshots.set(key, screen);
  while (snapshots.size > SNAPSHOT_LIMIT) snapshots.delete(snapshots.keys().next().value!);
}

export function ScreenSurface(props: { transport: ScreenTransport; invalidate?: number; cacheKey?: string }) {
  return <div className="screen-bb-page"><div className="screen-frame"><ScreenContent {...props} /></div></div>;
}

function ScreenContent({ transport, invalidate = 0, cacheKey }: { transport: ScreenTransport; invalidate?: number; cacheKey?: string }) {
  const cached = cacheKey ? snapshots.get(cacheKey) : undefined;
  const [screen, setScreen] = useState<Screen | null>(cached ?? null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(cached?.submission?.selectedIds ?? []));
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(false);
  const sequence = useRef(0);
  const latest = useRef<Screen | null>(cached ?? null);
  const alive = useRef(true);
  function receive(next: Screen) {
    const previous = latest.current;
    if (previous?.id === next.id && previous.revision > next.revision) return;
    const sharedChoiceChanged = previous?.id !== next.id || previous?.submission?.revision !== next.submission?.revision;
    latest.current = next;
    rememberSnapshot(cacheKey, next);
    setScreen(next); setOnline(true);
    const ids = new Set(next.document.blocks.flatMap(block => block.type === 'tasks' ? block.items.map(task => task.id) : []));
    setSelected(current => new Set((sharedChoiceChanged ? next.submission?.selectedIds ?? [] : [...current]).filter(id => ids.has(id))));
  }
  const load = async () => {
    const current = ++sequence.current;
    try {
      const next = await transport.load();
      if (!alive.current || current !== sequence.current) return;
      receive(next);
    } catch (cause) { if (alive.current && current === sequence.current) { setOnline(false); setError(String((cause as Error).message)); } }
  };
  useEffect(() => {
    alive.current = true; latest.current = cached ?? null; setScreen(cached ?? null);
    setSelected(new Set(cached?.submission?.selectedIds ?? [])); setError(''); void load();
    const unsubscribe = transport.subscribe?.(() => void load());
    return () => { alive.current = false; ++sequence.current; unsubscribe?.(); };
  }, [transport]);
  useEffect(() => { if (invalidate) void load(); }, [invalidate]);
  const owners = useMemo(() => screen ? [...new Set(screen.document.blocks.flatMap(block => block.type === 'tasks' ? block.items.map(task => task.owner) : []))] : [], [screen]);
  async function submit() {
    if (!screen || busy) return;
    setBusy(true); setError('');
    try {
      const result = await transport.submit({ id: screen.id, expectedRevision: screen.revision, requestId: crypto.randomUUID(), selectedIds: [...selected] });
      if (alive.current) receive(result.screen);
    } catch (cause) { if (alive.current) { setError((cause as Error).message); void load(); } }
    finally { if (alive.current) setBusy(false); }
  }
  if (!screen) return <section className="sv-screen"><p role="status">{error || 'Открываю экран…'}</p>{error && <button onClick={() => void load()}>Повторить</button>}</section>;
  const onlyBlock = screen.document.blocks.length === 1 ? screen.document.blocks[0] : null;
  if (onlyBlock?.type === 'scaffold') return <main data-screen-id={screen.id} data-revision={screen.revision}>
    <ScaffoldEditor block={onlyBlock} screen={screen} transport={transport} receive={receive} />
  </main>;
  return <main className="sv-screen" data-screen-id={screen.id} data-revision={screen.revision}>
    <header className="screen-header"><div><span className="screen-eyebrow">svaib · Screen · локальный пилот</span><h1>{screen.document.title}</h1><p>{screen.document.description}</p></div>
      <span className="screen-revision">Ревизия {screen.revision} · {online ? 'подключён' : 'нет связи'}</span></header>
    <div className="screen-toolbar">{owners.length > 0 && <label>Ответственный <select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">Все</option>{owners.map(owner => <option key={owner}>{owner}</option>)}</select></label>}
      <button className="screen-secondary" onClick={() => { setError(''); void load(); }}>Обновить</button></div>
    {error && <p role="alert" className="screen-error">{error}</p>}
    <div className={`screen-blocks screen-${screen.document.layout}`}>
      {screen.document.blocks.map(block => <section key={block.id} className={`screen-card screen-block-${block.type}`} data-block-id={block.id}><h2>{block.title}</h2>
        {block.type === 'note' ? <p className="screen-note-text">{block.text}</p> : block.type === 'chart' ? <Chart block={block} /> : block.type === 'scaffold' ?
          <ScaffoldEditor block={block} screen={screen} transport={transport} receive={receive} /> :
          <ul className="screen-tasks">{block.items.filter(task => filter === 'all' || task.owner === filter).map(task => <li key={task.id}>
            <label><input type="checkbox" aria-label={`Выбрать: ${task.title}`} checked={selected.has(task.id)} onChange={() => setSelected(previous => { const next = new Set(previous); next.has(task.id) ? next.delete(task.id) : next.add(task.id); return next; })} />
              <span><strong>{task.title}</strong><small>{task.owner} · {({ active: 'В работе', backlog: 'Отложено', done: 'Сделано' })[task.status]}</small><small className="screen-source">{task.source.title}<br /><code>{task.source.ref}</code></small></span></label>
          </li>)}</ul>}
      </section>)}
    </div>
    {screen.document.blocks.some(block => block.type === 'tasks') && <footer className="screen-submit"><div><strong>Выбрано: {selected.size}</strong><p>Передаём выбор партнёру. Статусы задач в источниках не меняются.</p></div>
      <button onClick={() => void submit()} disabled={busy}>{busy ? 'Сохраняю…' : 'Передать выбранное агенту'}</button>
      {screen.submission && <p role="status" className="screen-saved">Выбор сохранён: {screen.submission.selectedIds.length} · ревизия {screen.submission.revision}. Если агент не продолжил, попросите его забрать результат.</p>}
    </footer>}
  </main>;
}
