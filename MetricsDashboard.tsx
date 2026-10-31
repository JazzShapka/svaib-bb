import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { UrlLink } from '@get-bb/plugin-sdk/app';
import { init, use } from 'echarts/core';
import { BarChart, LineChart, CustomChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent, DataZoomComponent } from 'echarts/components';
import { SVGRenderer } from 'echarts/renderers';
import type { DashboardMetric, MetricsDashboard, MetricSeries } from './metrics-model';
import {
  availableYears, axisLabel, buildMetricPlot, deltaTone, formatDelta, formatValue, monthLabel, monthRange,
  statusLabel, summary, type MetricMode, type MetricPlot, type MetricScope,
} from './metrics-view';
import { chartOption, visibleChartTraces, type ChartColors } from './metrics-chart';
import './metrics-dashboard.css';

use([BarChart, LineChart, CustomChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent, SVGRenderer]);

const MODES: { id: MetricMode; label: string }[] = [
  { id: 'months', label: 'Месяцы' }, { id: 'year', label: 'Год к году' }, { id: 'current', label: 'Текущий месяц' },
];
const dayLabel = (value: string) => new Date(value.length === 10 ? `${value}T12:00:00Z` : value)
  .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const readLabel = (value: string) => new Date(value).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function Sparkline({ series }: { series: MetricSeries }) {
  const last = summary(series, 'amount').point;
  const data = useMemo(() => {
    if (!last) return [];
    const byPeriod = new Map(series.points.map(point => [point.period, point]));
    const periods = series.points.map(p => p.period).filter(p => p <= last.period).sort();
    return periods.length ? monthRange(periods[0]!, last.period).slice(-12).map(period => {
      const point = byPeriod.get(period);
      return point?.status === 'in_progress' ? null : point?.value ?? null;
    }) : [];
  }, [series, last?.period]);
  const values = data.filter((value): value is number => value !== null);
  if (!values.length) return <span className="svb-md-spark-empty" />;
  const low = Math.min(...values); const high = Math.max(...values);
  const y = (value: number) => 32 - (value - low) / (high - low || 1) * 26;
  const segments: string[] = [];
  let path = '';
  data.forEach((value, index) => {
    if (value === null) { if (path) segments.push(path); path = ''; return; }
    path += `${path ? ' L' : 'M'}${index / Math.max(1, data.length - 1) * 116 + 2},${y(value)}`;
  });
  if (path) segments.push(path);
  const lastValue = data.at(-1);
  return <svg className="svb-md-spark" viewBox="0 0 120 38" aria-hidden="true">
    <path className="svb-md-spark-rule" d="M2 36 H118" />
    {segments.map((segment, index) => <path key={index} d={segment} />)}
    {lastValue !== null && lastValue !== undefined && <circle cx={data.length === 1 ? 2 : 118} cy={y(lastValue)} r="2.8" />}
  </svg>;
}

function MetricCard({ metric, selected, onSelect }: { metric: DashboardMetric; selected: boolean; onSelect: () => void }) {
  const series = metric.series.find(item => item.scope === 'total') ?? metric.series[0]!;
  const { point, mom, yoy } = summary(series, metric.kind);
  return <button type="button" className={`svb-md-card${selected ? ' is-selected' : ''}`} onClick={onSelect} aria-pressed={selected}>
    <span className="svb-md-card-title">{metric.label}<span aria-hidden="true">↗</span></span>
    <span className="svb-md-card-period">{point ? monthLabel(point.period, true) : 'Нет месячного факта'}{series.scope !== 'total' ? ` · ${series.label}` : ''}</span>
    <span className="svb-md-card-middle"><span className="svb-md-card-number">{formatValue(point?.value ?? null, metric.kind, true)} <small>{metric.unit}</small></span><Sparkline series={series} /></span>
    <span className="svb-md-card-deltas">
      <span><b className={`is-${deltaTone(mom, metric.direction)}`}>{formatDelta(mom)}</b><small>к месяцу</small></span>
      <span><b className={`is-${deltaTone(yoy, metric.direction)}`}>{formatDelta(yoy)}</b><small>год к году</small></span>
    </span>
    {point?.status === 'provisional' && <span className="svb-md-card-status">Предварительно</span>}
  </button>;
}

function chartColors(element: HTMLElement): ChartColors {
  const styles = getComputedStyle(element);
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    ink: token('--svb-ink', '#2C3E50'), muted: token('--svb-muted', '#72817f'),
    line: token('--svb-line', '#dfe8e6'), card: token('--svb-card', '#ffffff'), pink: token('--svb-pink', '#FF4D8D'),
    fact: token('--md-fact', '#00B4A6'), past: token('--md-past', '#6B8EAD'),
    colors: [token('--svb-teal', '#008B7F'), token('--md-series-blue', '#4E8CCF'), token('--md-series-gold', '#B18B24'), token('--svb-pink', '#FF4D8D'), token('--md-series-purple', '#9472BB')],
  };
}
function MetricChart({ plot, metric, mode, showGrowth }: { plot: MetricPlot; metric: DashboardMetric; mode: MetricMode; showGrowth: boolean }) {
  const element = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = element.current;
    if (!node) return;
    let chart: ReturnType<typeof init> | undefined;
    let frame = 0;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const draw = () => {
      if (!chart || chart.isDisposed()) return;
      try { chart.setOption(chartOption(plot, metric, mode, chartColors(node), motion.matches, showGrowth), { notMerge: true }); chart.resize(); }
      catch { setFailed(true); }
    };
    const scheduleDraw = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(draw); };
    const resize = new ResizeObserver(() => { if (chart && !chart.isDisposed()) chart.resize(); });
    const theme = new MutationObserver(scheduleDraw);
    setFailed(false);
    try {
      chart = init(node, undefined, { renderer: 'svg' });
      draw(); resize.observe(node);
      // Observe only ancestors: never react to ECharts' own SVG mutations.
      for (let parent: HTMLElement | null = node.parentElement; parent; parent = parent.parentElement) {
        theme.observe(parent, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme'] });
      }
      motion.addEventListener('change', scheduleDraw);
    } catch { setFailed(true); }
    return () => {
      cancelAnimationFrame(frame); resize.disconnect(); theme.disconnect(); motion.removeEventListener('change', scheduleDraw); chart?.dispose();
    };
  }, [plot, metric, mode, showGrowth]);
  const growth = mode === 'year' && showGrowth;
  const rowCount = new Set(plot.traces.filter(trace => !trace.comparison && !trace.plan).map(trace => trace.seriesId)).size;
  return <div className={`svb-md-chart-wrap${growth ? ' has-growth' : ''}`} tabIndex={growth ? 0 : undefined} aria-label={growth ? 'График с ростом — при узком экране прокручивается горизонтально' : undefined}>
    <div ref={element} className="svb-md-chart" style={growth ? { height: Math.max(325, 230 + rowCount * 18) } : undefined} role="img" aria-label={`${metric.label}. ${MODES.find(item => item.id === mode)?.label}.${growth ? ` Внизу внутри графика — изменение к тому же месяцу прошлого года${metric.kind === 'percent' ? ' в процентных пунктах' : ' в целых процентах'}, строки в порядке легенды.` : ''} Точные значения и источники доступны в режиме «Таблица».`} />
    {failed && <p className="svb-md-chart-error" role="status">График не удалось показать. Числа и источники доступны в таблице.</p>}
  </div>;
}

function MetricTable({ plot, metric, mode }: { plot: MetricPlot; metric: DashboardMetric; mode: MetricMode }) {
  return <div className="svb-md-table-scroll" tabIndex={0} aria-label="Таблица показателя — горизонтальная прокрутка">
    <table className="svb-md-table">
      <caption>{metric.label}, {metric.unit}. Пропуск — нет данных, не ноль. Источник значения раскрывается в ячейке.</caption>
      <thead><tr><th scope="col">{mode === 'current' ? 'Дата' : 'Месяц'}</th>{plot.traces.map(trace => <th key={trace.id} scope="col">{trace.label}</th>)}</tr></thead>
      <tbody>{plot.periods.map((period, index) => <tr key={period}>
        <th scope="row">{mode === 'current' ? dayLabel(period) : mode === 'year' ? axisLabel(period, mode) : monthLabel(period)}</th>
        {plot.traces.map(trace => {
          const point = trace.points[index]!;
          return <td key={trace.id}><details className="svb-md-cell-detail"><summary>
            <span>{formatValue(point.value, metric.kind)}</span>
            <small>{trace.plan ? 'План' : mode === 'current' && point.value !== null ? 'За день' : statusLabel(point.status)}</small>
          </summary><div>{point.period}<br />{point.sourceRef || 'Адрес ячейки не указан для отсутствующего значения.'}</div></details></td>;
        })}
      </tr>)}</tbody>
    </table>
  </div>;
}

function SelectedMetric({ metric }: { metric: DashboardMetric }) {
  const [mode, setMode] = useState<MetricMode>('months');
  const [table, setTable] = useState(false);
  const initialScope = metric.series.some(series => series.scope === 'total') ? 'total' : 'unit';
  const [scope, setScope] = useState<MetricScope>(initialScope);
  const [selectedUnits, setSelectedUnits] = useState<string[]>(metric.series.filter(series => series.scope === 'unit').map(series => series.id));
  const years = availableYears(metric);
  const [year, setYear] = useState(years[0] ?? String(new Date(metric.source.verifiedAt).getFullYear()));
  const [showPlan, setShowPlan] = useState(false);
  const [showGrowth, setShowGrowth] = useState(false);
  const scoped = metric.series.filter(series => series.scope === scope);
  const selected = scoped.filter(series => scope === 'total' || selectedUnits.includes(series.id));
  const idsKey = selected.map(series => series.id).join(',');
  const plot = useMemo(() => buildMetricPlot(metric, idsKey.split(',').filter(Boolean), mode, year, showPlan), [metric, idsKey, mode, year, showPlan]);
  const hasValues = plot.traces.some(trace => trace.points.some(point => point.value !== null));
  const hasPlan = mode !== 'current' && selected.some(series => series.plan?.some(point => point.value !== null && (mode !== 'year' || point.period.startsWith(year))));
  const hasTotals = metric.series.some(series => series.scope === 'total');
  const hasUnits = metric.series.some(series => series.scope === 'unit');
  const operational = metric.operational;
  const operationalSelected = operational?.series.filter(series => selected.some(item => item.id === series.id)) ?? [];
  const headingId = useId();
  const toggleUnit = (id: string) => setSelectedUnits(previous => previous.includes(id)
    ? previous.length > 1 ? previous.filter(item => item !== id) : previous : [...previous, id]);
  const pointStatuses = new Set(plot.traces.filter(trace => !trace.plan).flatMap(trace => trace.points.filter(point => point.value !== null).map(point => point.status)));
  const single = selected.length === 1;
  const legendTraces = table ? plot.traces : visibleChartTraces(plot, mode);

  return <section className="svb-md-explorer" aria-labelledby={headingId}>
    <header className="svb-md-explorer-head"><div><span className="svb-md-overline">Динамика бизнеса</span><h3 id={headingId}>{metric.label}</h3></div><span className="svb-md-unit">{metric.unit}</span></header>
    <p className="svb-md-description">{metric.description}</p>
    <div className="svb-md-mode-row">
      <div className="svb-md-segments" role="group" aria-label="Период представления">{MODES.map(item => <button key={item.id} type="button" aria-pressed={mode === item.id} onClick={() => setMode(item.id)}>{item.label}</button>)}</div>
      <div className="svb-md-view-switch" role="group" aria-label="Вид представления"><button type="button" aria-pressed={!table} onClick={() => setTable(false)}>График</button><button type="button" aria-pressed={table} onClick={() => setTable(true)}>Таблица</button></div>
    </div>
    <div className="svb-md-filter-row">
      {hasTotals && hasUnits ? <div className="svb-md-scope" role="group" aria-label="Охват показателя"><button type="button" aria-pressed={scope === 'total'} onClick={() => setScope('total')}>Весь бизнес</button><button type="button" aria-pressed={scope === 'unit'} onClick={() => setScope('unit')}>По точкам</button></div> : <span className="svb-md-scope-label">{scope === 'total' ? scoped[0]?.label || 'Весь бизнес' : 'По точкам'}</span>}
      {mode === 'year' && <label className="svb-md-year">Год <select value={year} onChange={event => setYear(event.target.value)}>{(years.length ? years : [year]).map(value => <option key={value} value={value}>{value}</option>)}</select><span>к {Number(year) - 1}</span></label>}
      {hasPlan && (table || mode !== 'year' || selected.length === 1) && <label className="svb-md-plan"><input type="checkbox" checked={showPlan} onChange={event => setShowPlan(event.target.checked)} />План</label>}
      {mode === 'year' && !table && <label className="svb-md-growth" title="Изменение к тому же месяцу прошлого года; неполные периоды не сравниваются"><input type="checkbox" checked={showGrowth} onChange={event => setShowGrowth(event.target.checked)} />Рост</label>}
    </div>
    {scope === 'unit' && <div className="svb-md-unit-picks" role="group" aria-label="Точки на графике">{scoped.map((series, index) => <button type="button" key={series.id} aria-pressed={selectedUnits.includes(series.id)} onClick={() => toggleUnit(series.id)}><i className={`svb-md-dot svb-md-color-${index % 5}`} />{series.label}</button>)}</div>}
    {mode === 'current' && operational && <>
      <div className="svb-md-operational-head"><span>{monthLabel(operational.period, true)}</span><span className="svb-md-badge">Неполный месяц · по {dayLabel(operational.through)}</span></div>
      <div className="svb-md-mtd-grid">{operationalSelected.map(series => <div key={series.id}><span>{series.label}</span><strong>{formatValue(series.value, metric.kind)} <small>{metric.unit}</small></strong><span>{metric.kind === 'percent' ? 'Значение на дату среза' : 'С начала месяца по дату среза'}</span><details><summary>Источник значения</summary><p>{series.sourceRef || 'Не указан'}</p></details></div>)}</div>
      <p className="svb-md-operational-note">{operational.note}</p>
    </>}
    {hasValues ? <>
      <div className="svb-md-legend" aria-label="Легенда">{legendTraces.map(trace => {
        const index = scoped.findIndex(series => series.id === trace.seriesId);
        const color = trace.plan ? 'svb-md-color-3' : single ? trace.comparison ? 'svb-md-color-past' : 'svb-md-color-fact' : `svb-md-color-${Math.max(0, index) % 5}`;
        const bar = single && (mode === 'year' || metric.kind !== 'percent') && !trace.comparison && !trace.plan;
        return <span key={trace.id}><i className={`svb-md-legend-line ${color}${trace.plan ? ' is-dashed' : ''}${bar ? ' is-bar' : ''}`} />{trace.label}</span>;
      })}</div>
      {table ? <MetricTable plot={plot} metric={metric} mode={mode} /> : <MetricChart plot={plot} metric={metric} mode={mode} showGrowth={showGrowth} />}
      <div className="svb-md-chart-notes">
        {pointStatuses.has('provisional') && <span>Предварительные значения: закрытие месяца не подтверждено.</span>}
        {pointStatuses.has('in_progress') && <span>Неполный период отмечен светлее; с полным месяцем не сравнивается.</span>}
        <span>{mode === 'current' ? 'Каждая точка — отдельный день, не накопленная сумма.' : 'Разрыв ряда — нет данных. Значения не заменяются нулями.'}</span>
        {metric.kind === 'percent' && <span>Изменение долей — в процентных пунктах; доли не суммируются.</span>}
      </div>
    </> : <div className="svb-md-empty" role="status"><span aria-hidden="true">◌</span><strong>{mode === 'current' ? operational ? 'Дневной ряд пока не подключён' : 'Оперативного среза пока нет' : 'Для этого периода нет значений'}</strong><p>{mode === 'current' ? operational ? 'Выше — доступное значение на дату среза. Его нельзя достоверно разложить по дням.' : 'Месячная история остаётся в соседних режимах. Текущий месяц не подменяется нулём или последним полным месяцем.' : 'Выбери другой год или точку. Пропуски в источнике остаются пропусками.'}</p>{table && plot.periods.length > 0 && <MetricTable plot={plot} metric={metric} mode={mode} />}</div>}
    <footer className="svb-md-source"><UrlLink href={metric.source.url}>Открыть «{metric.source.title}» ↗</UrlLink><span>Прочитано {readLabel(metric.source.verifiedAt)}</span></footer>
    {(metric.note || metric.source.modifiedAt) && <details className="svb-md-evidence"><summary>О данных и границах сравнения</summary>{metric.note && <p>{metric.note}</p>}{metric.source.modifiedAt && <p>Источник изменён {readLabel(metric.source.modifiedAt)}. Это дата файла, не подтверждение закрытия месяца.</p>}<p>Месяц сравнивается только с предыдущим календарным месяцем и тем же месяцем прошлого года. При пропуске, неполном периоде или неположительной базе процент роста не показывается.</p></details>}
  </section>;
}

export default function MetricsDashboardPanel({ data, onRefresh, refreshUnavailable }: { data: MetricsDashboard; onRefresh?: () => void; refreshUnavailable?: string }) {
  const [selectedId, setSelectedId] = useState(data.metrics[0]?.id ?? '');
  const selected = data.metrics.find(metric => metric.id === selectedId) ?? data.metrics[0];
  if (!selected) return null;
  return <section className="svb-metrics-dashboard" aria-label={data.title}>
    <header className="svb-md-heading"><div><span className="svb-md-overline">Показатели · движение во времени</span><h2>{data.title}</h2></div><div className="svb-md-heading-actions"><span className="svb-md-stamp">Снимок<br />{readLabel(data.preparedAt)}</span>{onRefresh && <button type="button" className="svb-md-refresh" onClick={onRefresh} disabled={!!refreshUnavailable} title={refreshUnavailable || 'Партнёр перечитает источники и обновит графики этой вкладки'}>Обновить графики <span aria-hidden="true">↻</span></button>}</div></header>
    <p className="svb-md-intro">{data.description}</p>
    <div className="svb-md-cards" aria-label="Выбор показателя">{data.metrics.map(metric => <MetricCard key={metric.id} metric={metric} selected={metric.id === selected.id} onSelect={() => setSelectedId(metric.id)} />)}</div>
    <p className="svb-md-cards-caption">Карточки — последний доступный месячный факт без незавершённых периодов. Выбери показатель, чтобы раскрыть историю.</p>
    <SelectedMetric key={selected.id} metric={selected} />
    {data.notes.length > 0 && <details className="svb-md-dashboard-notes"><summary>Источники и важные оговорки</summary>{data.notes.map((note, index) => <p key={index}>{note}</p>)}</details>}
    <p className="svb-md-snapshot-note">Подготовленный снимок. Автоматическое обновление не включено.</p>
  </section>;
}
