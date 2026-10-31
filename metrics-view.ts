import type { DashboardMetric, MetricPoint, MetricSeries } from './metrics-model';

export type MetricMode = 'months' | 'year' | 'current';
export type MetricScope = 'total' | 'unit';
export interface PlotPoint {
  period: string;
  value: number | null;
  status: MetricPoint['status'];
  sourceRef: string;
}
export interface PlotTrace {
  id: string;
  label: string;
  seriesId: string;
  comparison: boolean;
  plan: boolean;
  points: PlotPoint[];
}
export interface MetricPlot { periods: string[]; traces: PlotTrace[]; }
export interface MetricDelta { value: number; unit: '%' | 'п.п.'; }
export interface PlotGrowthRow { seriesId: string; label: string; values: (MetricDelta | null)[]; }

const MONTHS = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн', 'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];
export function monthLabel(period: string, long = false): string {
  if (!/^\d{4}-\d{2}/.test(period)) return period;
  const date = new Date(`${period.slice(0, 7)}-01T12:00:00Z`);
  return long ? date.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(' г.', '')
    : `${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(2, 4)}`;
}
export function monthBefore(period: string, months: number): string {
  const date = new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1 - months, 1));
  return date.toISOString().slice(0, 7);
}
export function monthRange(first: string, last: string): string[] {
  const result: string[] = [];
  for (let period = first; period <= last && result.length < 1200; period = monthBefore(period, -1)) result.push(period);
  return result;
}
export function statusLabel(status: MetricPoint['status']): string {
  return { closed: 'Закрытый месяц', provisional: 'Предварительно', in_progress: 'Неполный период', missing: 'Нет данных' }[status];
}
export function latestMonth(series: MetricSeries): MetricPoint | undefined {
  return series.points.filter(point => point.value !== null && point.status !== 'in_progress')
    .sort((a, b) => b.period.localeCompare(a.period))[0];
}
export function metricDelta(current: MetricPoint | undefined, baseline: MetricPoint | undefined, kind: DashboardMetric['kind']): MetricDelta | null {
  if (!current || !baseline || current.value === null || baseline.value === null
    || current.status === 'in_progress' || baseline.status === 'in_progress') return null;
  if (kind === 'percent') return { value: current.value - baseline.value, unit: 'п.п.' };
  // Negative and zero baselines do not have an unambiguous growth percentage.
  if (baseline.value <= 0) return null;
  return { value: (current.value - baseline.value) / baseline.value * 100, unit: '%' };
}
export function summary(series: MetricSeries, kind: DashboardMetric['kind']) {
  const point = latestMonth(series);
  return {
    point,
    mom: point ? metricDelta(point, series.points.find(p => p.period === monthBefore(point.period, 1)), kind) : null,
    yoy: point ? metricDelta(point, series.points.find(p => p.period === monthBefore(point.period, 12)), kind) : null,
  };
}
export function deltaTone(delta: MetricDelta | null, direction: DashboardMetric['direction']): 'good' | 'bad' | 'neutral' {
  if (!delta || direction === 'neutral' || Math.abs(delta.value) < 0.05) return 'neutral';
  return (delta.value > 0) === (direction === 'higher') ? 'good' : 'bad';
}
export function formatValue(value: number | null, kind: DashboardMetric['kind'], compact = false): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('ru-RU', {
    notation: compact && Math.abs(value) >= 100_000 ? 'compact' : 'standard',
    maximumFractionDigits: kind === 'count' ? 0 : compact ? 1 : 2,
  }).format(value);
}
export function formatDelta(delta: MetricDelta | null): string {
  if (!delta) return '—';
  const value = Math.abs(delta.value) < 0.05 ? 0 : delta.value;
  return `${value > 0 ? '+' : ''}${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)} ${delta.unit}`;
}

/** Compact chart labels: whole growth percentages; percentage-point changes keep one decimal. */
export function formatGrowth(delta: MetricDelta | null): string {
  if (!delta || !Number.isFinite(delta.value)) return '—';
  const digits = delta.unit === '%' ? 0 : 1;
  const factor = 10 ** digits;
  const magnitude = Math.round(Math.abs(delta.value) * factor) / factor;
  const sign = magnitude === 0 ? '' : delta.value > 0 ? '+' : '−';
  return `${sign}${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(magnitude)}${delta.unit === '%' ? '%' : ' п.п.'}`;
}

/** Only aligned actual-vs-previous-year traces qualify; plans and partial months never enter growth. */
export function buildGrowthRows(plot: MetricPlot, kind: DashboardMetric['kind']): PlotGrowthRow[] {
  return plot.traces.filter(trace => !trace.comparison && !trace.plan).flatMap(trace => {
    const previous = plot.traces.find(candidate => candidate.seriesId === trace.seriesId && candidate.comparison && !candidate.plan);
    if (!previous) return [];
    return [{ seriesId: trace.seriesId, label: trace.label, values: plot.periods.map((period, index) => {
      const current = trace.points[index];
      const baseline = previous.points[index];
      if (!/^\d{4}-\d{2}$/.test(period) || current?.period !== period || baseline?.period !== monthBefore(period, 12)) return null;
      return metricDelta(current, baseline, kind);
    }) }];
  });
}
export function availableYears(metric: DashboardMetric): string[] {
  return [...new Set(metric.series.flatMap(series => series.points.filter(p => p.value !== null).map(p => p.period.slice(0, 4))))].sort().reverse();
}
const missing = (period: string): PlotPoint => ({ period, value: null, status: 'missing', sourceRef: '' });
const align = (points: MetricPoint[], periods: string[]): PlotPoint[] => {
  const byPeriod = new Map(points.map(point => [point.period, point]));
  return periods.map(period => byPeriod.get(period) ?? missing(period));
};

/** One projection feeds both chart and table; absent periods remain explicit nulls. */
export function buildMetricPlot(metric: DashboardMetric, selectedIds: string[], mode: MetricMode, year: string, showPlan: boolean): MetricPlot {
  const selected = metric.series.filter(series => selectedIds.includes(series.id));
  if (mode === 'current') {
    if (!metric.operational) return { periods: [], traces: [] };
    const { period, through } = metric.operational;
    const periods = Array.from({ length: Number(through.slice(8, 10)) }, (_, i) => `${period}-${String(i + 1).padStart(2, '0')}`);
    return { periods, traces: metric.operational.series.filter(series => selectedIds.includes(series.id)).map(series => ({
      id: series.id, seriesId: series.id, label: series.label, comparison: false, plan: false,
      points: align(series.points ?? [], periods),
    })) };
  }
  const suppliedPeriods = selected.flatMap(series => [...series.points, ...(showPlan ? series.plan ?? [] : [])].map(point => point.period)).sort();
  const periods = mode === 'year' ? Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
    : suppliedPeriods.length ? monthRange(suppliedPeriods[0]!, suppliedPeriods.at(-1)!) : [];
  const traces: PlotTrace[] = [];
  for (const series of selected) {
    traces.push({ id: `${series.id}-fact`, seriesId: series.id, label: mode === 'year' ? `${series.label} · ${year}` : series.label,
      comparison: false, plan: false, points: align(series.points, periods) });
    if (mode === 'year') traces.push({ id: `${series.id}-previous`, seriesId: series.id, label: `${series.label} · ${Number(year) - 1}`,
      comparison: true, plan: false, points: align(series.points, periods.map(period => monthBefore(period, 12))) });
    if (showPlan && series.plan?.some(point => periods.includes(point.period) && point.value !== null)) traces.push({
      id: `${series.id}-plan`, seriesId: series.id, label: `${series.label} · план`, comparison: false, plan: true,
      points: align(series.plan, periods),
    });
  }
  return { periods, traces };
}

export function axisLabel(period: string, mode: MetricMode): string {
  if (mode === 'current') return String(Number(period.slice(8, 10)));
  if (mode === 'year') return MONTHS[Number(period.slice(5, 7)) - 1] ?? period;
  return monthLabel(period);
}
