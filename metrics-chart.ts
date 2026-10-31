import type { EChartsCoreOption } from 'echarts/core';
import type { CustomSeriesOption } from 'echarts/charts';
import type { DashboardMetric } from './metrics-model';
import {
  axisLabel, buildGrowthRows, formatGrowth, formatValue, monthLabel, statusLabel,
  type MetricMode, type MetricPlot, type PlotTrace,
} from './metrics-view';

export interface ChartColors {
  ink: string; muted: string; line: string; card: string; colors: string[]; pink: string; fact: string; past: string;
}
const dayLabel = (value: string) => new Date(`${value}T12:00:00Z`)
  .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, token => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[token]!));

/** The approved multiple-unit chart shows current facts together; the table keeps both years. */
export function visibleChartTraces(plot: MetricPlot, mode: MetricMode): PlotTrace[] {
  const multiple = new Set(plot.traces.map(trace => trace.seriesId)).size > 1;
  return mode === 'year' && multiple ? plot.traces.filter(trace => !trace.comparison && !trace.plan) : plot.traces;
}
function traceColor(trace: PlotTrace, colorIds: string[], colors: ChartColors, single: boolean): string {
  if (trace.plan) return colors.pink;
  if (single) return trace.comparison ? colors.past : colors.fact;
  return colors.colors[Math.max(0, colorIds.indexOf(trace.seriesId)) % colors.colors.length]!;
}

/** Pure ECharts options: the same exported function can be rendered with ECharts SVG SSR. */
export function chartOption(plot: MetricPlot, metric: DashboardMetric, mode: MetricMode, colors: ChartColors, reducedMotion: boolean, showGrowth = false): EChartsCoreOption {
  const selectedIds = [...new Set(plot.traces.map(trace => trace.seriesId))];
  const scope = metric.series.find(series => series.id === selectedIds[0])?.scope;
  const colorIds = metric.series.filter(series => series.scope === scope).map(series => series.id);
  const singleYear = mode === 'year' && selectedIds.length === 1;
  const isBar = selectedIds.length === 1 && (mode === 'year' || metric.kind !== 'percent');
  const zoom = plot.periods.length > 14;
  const traces = visibleChartTraces(plot, mode);
  const growthRows = mode === 'year' && showGrowth ? buildGrowthRows(plot, metric.kind) : [];
  const series: (EChartsCoreOption | CustomSeriesOption)[] = traces.map(trace => {
    const color = traceColor(trace, colorIds, colors, selectedIds.length === 1);
    const bar = isBar && !trace.plan && !trace.comparison;
    return {
      id: trace.id, name: trace.label, type: bar ? 'bar' : 'line',
      data: trace.points.map(point => ({ value: point.value, itemStyle: {
        color, opacity: point.status === 'in_progress' ? 0.38 : 1,
        ...(bar ? { borderRadius: point.value !== null && point.value < 0 ? [0, 0, 4, 4] : [4, 4, 0, 0] } : {}),
      } })),
      color, barMaxWidth: mode === 'year' ? 34 : 27, connectNulls: false, smooth: false,
      showSymbol: mode === 'year' || plot.periods.length < 15, symbol: 'circle', symbolSize: 5,
      lineStyle: { color, width: trace.plan ? 2 : 2.8, type: trace.plan ? 'dashed' : 'solid', opacity: 1 },
      emphasis: { focus: 'series' },
      ...(mode === 'months' && selectedIds.length === 1 && !trace.plan && !bar ? { areaStyle: { color, opacity: 0.07 } } : {}),
    };
  });
  if (growthRows.length) {
    // x only: no numeric y value reaches scale extent calculation. The text is anchored
    // to the Cartesian pixel rectangle and is laid out again by ECharts on every resize.
    const growth: CustomSeriesOption = {
      id: 'growth-labels', name: 'Рост к прошлому году', type: 'custom', coordinateSystem: 'cartesian2d',
      dimensions: ['month'], encode: { x: 0, y: -1, tooltip: [] },
      data: plot.periods.map((_, index) => [index]),
      silent: true, animation: false, clip: false, z: 20,
      tooltip: { show: false },
      renderItem: (params, api) => {
        const monthIndex = Number(api.value(0));
        const rect = params.coordSys as typeof params.coordSys & { x: number; y: number; width: number; height: number };
        const x = api.coord([monthIndex, 0])[0]!;
        return { type: 'group', children: growthRows.flatMap((row, index) => {
          const delta = row.values[monthIndex];
          if (!delta) return [];
          const color = singleYear ? colors.ink : colors.colors[Math.max(0, colorIds.indexOf(row.seriesId)) % colors.colors.length]!;
          return [{ type: 'text' as const, silent: true, style: {
            text: formatGrowth(delta), x, y: rect.y + rect.height - 12 - (growthRows.length - 1 - index) * 18,
            align: 'center' as const, verticalAlign: 'middle' as const,
            fill: color, stroke: colors.card, lineWidth: 4, lineJoin: 'round' as const,
            font: '600 11px Inter, sans-serif',
          } }];
        }) };
      },
    };
    series.push(growth);
  }
  return {
    backgroundColor: 'transparent', animation: !reducedMotion, animationDuration: 380, animationDurationUpdate: 220,
    textStyle: { fontFamily: 'Inter, sans-serif', color: colors.ink },
    grid: { top: 18, left: 12, right: 16, bottom: zoom ? 63 : 22, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    tooltip: {
      trigger: 'axis', confine: true, enterable: true, backgroundColor: colors.card, borderColor: colors.line,
      padding: 14, textStyle: { color: colors.ink, fontSize: 12 },
      extraCssText: 'max-width:340px;max-height:340px;overflow:auto;border-radius:12px;box-shadow:0 8px 32px #00000015;white-space:normal;',
      axisPointer: { type: isBar ? 'shadow' : 'line', lineStyle: { color: colors.muted, type: 'dashed' } },
      formatter: (raw: unknown) => {
        const values = (Array.isArray(raw) ? raw : [raw]) as { dataIndex?: number; seriesId?: string }[];
        const index = values.find(value => value.seriesId !== 'growth-labels')?.dataIndex;
        if (index === undefined || !plot.periods[index]) return '';
        const title = mode === 'current' ? dayLabel(plot.periods[index]!) : mode === 'year' ? axisLabel(plot.periods[index]!, mode) : monthLabel(plot.periods[index]!, true);
        return `<strong>${escapeHtml(title)}</strong>` + plot.traces.map(trace => {
          const point = trace.points[index];
          if (!point) return '';
          const quality = trace.plan ? 'План' : mode === 'current' && point.value !== null ? 'Дневное значение' : statusLabel(point.status);
          const period = mode === 'current' ? dayLabel(point.period) : monthLabel(point.period, true);
          return `<div style="margin-top:10px"><div>${escapeHtml(trace.label)}</div><div style="font-size:10px;opacity:.65">${escapeHtml(period)}</div><b>${escapeHtml(formatValue(point.value, metric.kind))} ${escapeHtml(metric.unit)}</b><span style="opacity:.65"> · ${escapeHtml(quality)}</span>${point.sourceRef ? `<div style="font-size:10px;opacity:.65;overflow-wrap:anywhere;margin-top:3px">${escapeHtml(point.sourceRef)}</div>` : ''}</div>`;
        }).join('');
      },
    },
    xAxis: {
      type: 'category', data: plot.periods, boundaryGap: isBar || mode === 'year',
      axisTick: { show: false }, axisLine: { lineStyle: { color: colors.line } },
      axisLabel: { color: colors.muted, fontSize: 10, margin: 14, hideOverlap: true, formatter: (period: string) => axisLabel(period, mode) },
    },
    yAxis: {
      type: 'value', min: metric.kind === 'percent' ? undefined : (value: { min: number }) => Math.min(0, value.min),
      axisLabel: { color: colors.muted, fontSize: 10, formatter: (value: number) => `${formatValue(value, metric.kind, true)}${metric.kind === 'percent' ? ' %' : ''}` },
      splitLine: { lineStyle: { color: colors.line, type: 'dashed' } },
    },
    dataZoom: zoom ? [{ type: 'slider', height: 18, bottom: 6, start: 0, end: 100, showDetail: false, brushSelect: false,
      borderColor: 'transparent', backgroundColor: 'transparent', fillerColor: colors.line, handleStyle: { color: colors.muted }, dataBackground: { lineStyle: { color: colors.muted }, areaStyle: { color: colors.line } },
    }, { type: 'inside', zoomOnMouseWheel: false, moveOnMouseWheel: false, moveOnMouseMove: true }] : [],
    series,
  };
}
