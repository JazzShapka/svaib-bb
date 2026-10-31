import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const text = z.string().max(4000);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const day = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}, 'Некорректная дата');
const stamp = z.string().datetime({ offset: true });
const url = z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Только HTTP(S)');
const status = z.enum(['provisional', 'closed', 'in_progress', 'missing']);

export const metricPointSchema = z.object({
  period: month.or(day), value: z.number().finite().nullable(), status,
  sourceRef: text,
}).strict().superRefine((point, ctx) => {
  if ((point.value === null) !== (point.status === 'missing')) {
    ctx.addIssue({ code: 'custom', message: 'Отсутствующее значение должно иметь статус missing, а не ноль.' });
  }
});

const points = z.array(metricPointSchema).max(1200).superRefine((values, ctx) => {
  if (new Set(values.map(point => point.period)).size !== values.length) {
    ctx.addIssue({ code: 'custom', message: 'Периоды в ряду не должны повторяться.' });
  }
});
const monthlyPoints = points.refine(values => values.every(point => point.period.length === 7), 'Ожидаются месячные периоды');
const dailyPoints = points.refine(values => values.every(point => point.period.length === 10), 'Ожидаются дневные периоды');

export const metricSeriesSchema = z.object({
  id, label: text, scope: z.enum(['total', 'unit']), points: monthlyPoints,
  plan: monthlyPoints.optional(),
}).strict();

export const operationalSchema = z.object({
  period: month, through: day, note: text,
  series: z.array(z.object({
    id, label: text, value: z.number().finite().nullable(),
    status: z.enum(['in_progress', 'missing']), sourceRef: text,
    points: dailyPoints.optional(),
  }).strict()).min(1).max(50),
}).strict().superRefine((value, ctx) => {
  if (!value.through.startsWith(value.period)) ctx.addIssue({ code: 'custom', message: 'Дата среза вне оперативного месяца.' });
  if (new Set(value.series.map(series => series.id)).size !== value.series.length) ctx.addIssue({ code: 'custom', message: 'Повтор серии оперативного месяца.' });
  for (const series of value.series) {
    if ((series.value === null) !== (series.status === 'missing')) ctx.addIssue({ code: 'custom', message: 'Неизвестное накопление должно иметь статус missing.' });
    if (series.points?.some(point => !point.period.startsWith(value.period) || point.period > value.through)) ctx.addIssue({ code: 'custom', message: 'Дневные значения вне интервала среза.' });
  }
});

export const dashboardMetricSchema = z.object({
  id, label: text, unit: z.string().max(40), kind: z.enum(['amount', 'count', 'percent']),
  direction: z.enum(['higher', 'lower', 'neutral']), description: text,
  source: z.object({ title: text, url, verifiedAt: stamp, modifiedAt: stamp.optional() }).strict(),
  series: z.array(metricSeriesSchema).min(1).max(50),
  operational: operationalSchema.optional(), note: text.optional(),
}).strict().superRefine((metric, ctx) => {
  const ids = metric.series.map(series => series.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Повтор серии показателя.' });
  if (metric.operational?.series.some(series => !ids.includes(series.id))) ctx.addIssue({ code: 'custom', message: 'Оперативная серия отсутствует в показателе.' });
});

export const metricsDashboardSchema = z.object({
  title: text, description: text, preparedAt: stamp,
  metrics: z.array(dashboardMetricSchema).min(1).max(30), notes: z.array(text).max(30),
}).strict().superRefine((dashboard, ctx) => {
  if (new Set(dashboard.metrics.map(metric => metric.id)).size !== dashboard.metrics.length) ctx.addIssue({ code: 'custom', message: 'Повтор показателя.' });
});

export type MetricPoint = z.infer<typeof metricPointSchema>;
export type MetricSeries = z.infer<typeof metricSeriesSchema>;
export type DashboardMetric = z.infer<typeof dashboardMetricSchema>;
export type MetricsDashboard = z.infer<typeof metricsDashboardSchema>;
