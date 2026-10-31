import { useState } from 'react';
import { UrlLink } from '@get-bb/plugin-sdk/app';
import type { MetricsSnapshot } from './types';
import './metrics.css';

const number = (value: number | null, digits = 0) => value !== null && Number.isFinite(value)
  ? value.toLocaleString('ru-RU', { maximumFractionDigits: digits }) : '—';
const percent = (value: number | null) => value !== null && Number.isFinite(value)
  ? `${value > 0 ? '+' : ''}${number(value, 1)}%` : '—';
const dateLabel = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('ru-RU');
};

export default function MetricsPanel({ data }: { data: MetricsSnapshot }) {
  const [metricId, setMetricId] = useState(data.display.charts[0]?.id ?? '');
  const [daily, setDaily] = useState(false);
  const chart = data.display.charts.find(item => item.id === metricId) ?? data.display.charts[0];
  const days = data.display.days;
  const canCompareDaily = days.current > 0 && days.previous > 0;
  const perDay = daily && canCompareDaily;
  const value = (amount: number, period: 'current' | 'previous') => Number.isFinite(amount)
    ? perDay ? amount / days[period] : amount : null;
  const change = (item: { previous: number; changePercent: number; perDayChangePercent: number }) =>
    item.previous === 0 ? null : perDay ? item.perDayChangePercent : item.changePercent;
  const largest = Math.max(0, ...(chart?.series.flatMap(series => [
    value(series.current, 'current') ?? 0, value(series.previous, 'previous') ?? 0,
  ]) ?? []));
  const barWidth = (amount: number | null) => largest > 0 && amount !== null
    ? `${Math.max(0, Math.min(100, amount / largest * 100))}%` : '0%';

  return <section className="svb-metrics" aria-label={data.title}>
    <header className="svb-metrics-head">
      <div><span className="svb-metrics-eyebrow">{data.eyebrow}</span><h2>{data.title}</h2></div>
      <span className="svb-metrics-stamp">Снимок источника<br />Прочитан {dateLabel(data.verifiedAt)}</span>
    </header>
    {chart ? <>
      <div className="svb-metrics-controls">
        <div className="svb-metrics-switch" role="group" aria-label="Показатель">
          {data.display.charts.map(item => <button key={item.id} type="button" aria-pressed={chart.id === item.id} onClick={() => setMetricId(item.id)}>{item.label}</button>)}
        </div>
        <label className="svb-metrics-daily"><input type="checkbox" checked={perDay} disabled={!canCompareDaily} onChange={event => setDaily(event.target.checked)} /> В среднем за день</label>
      </div>
      <div className="svb-metrics-body">
        <div className="svb-metrics-total">
          <div className="svb-metrics-value">{number(value(chart.aggregate.current, 'current'), perDay ? 1 : 0)}</div>
          <div className="svb-metrics-unit">{chart.unit}{perDay ? ' / день' : ''} · {data.display.periodLabel}</div>
          <div className="svb-metrics-change">{percent(change(chart.aggregate))} <span>{data.display.comparisonLabel}</span></div>
          <p>{data.description}</p>
          {perDay && <p>{data.display.periodLabel}: {number(days.current)} дн. · {data.display.baselineLabel}: {number(days.previous)} дн. Поправка только на число дней.</p>}
          {chart.aggregate.previous === 0 && <p>В периоде сравнения нулевое значение. Процент изменения не рассчитан.</p>}
        </div>
        <div className="svb-metrics-plot">
          <div className="svb-metrics-legend"><span><i className="previous" />{data.display.baselineLabel}</span><span><i className="current" />{data.display.periodLabel}</span></div>
          {chart.series.length === 0 ? <p className="svb-metrics-empty">Для этого показателя пока нет рядов данных.</p> : chart.series.map(series => <div className="svb-metrics-series" key={series.shopId}>
            <div className="svb-metrics-rowtitle"><strong>{series.label}</strong><span>{percent(change(series))}</span></div>
            {(['previous', 'current'] as const).map(period => <div className="svb-metrics-barline" key={period}>
              <span className="svb-metrics-bartrack"><span className={period} style={{ width: barWidth(value(series[period], period)) }} /></span>
              <span className="svb-metrics-barvalue">{number(value(series[period], period), perDay ? 1 : 0)}</span>
            </div>)}
          </div>)}
        </div>
      </div>
    </> : <p className="svb-metrics-empty">Показатели ещё не подготовлены для отображения.</p>}
    {data.insight && <aside className="svb-metrics-thought">
      <span className="svb-metrics-signal" aria-hidden="true">↗</span><div><strong>{data.insight.title}</strong><p>{data.insight.text}</p></div>
    </aside>}
    <details className="svb-metrics-evidence"><summary>На чём основаны числа и где граница вывода</summary>
      {data.evidence.map((item, index) => <p key={index}>{item}</p>)}
      {data.discrepancyNote && <p>{data.discrepancyNote}</p>}
      {data.sourceModifiedTime && <p>Источник изменён {dateLabel(data.sourceModifiedTime)}.</p>}
      {!!chart?.series.length && <table><thead><tr><th>Серия</th><th>{data.display.baselineLabel}</th><th>{data.display.periodLabel}</th><th>Ячейки</th></tr></thead><tbody>{chart.series.map(series => <tr key={series.shopId}><td>{series.label}</td><td>{number(series.previous, 2)}</td><td>{number(series.current, 2)}</td><td>{series.sourceCells.join(' → ')}</td></tr>)}</tbody></table>}
      <UrlLink href={data.source.url}>Открыть источник «{data.source.title}» ↗</UrlLink>
    </details>
  </section>;
}
