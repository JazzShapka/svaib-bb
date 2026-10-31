import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { idSchema, parseConfig } from './config';
import { validateInstructions } from './catalog';
import { metricsDashboardSchema, type MetricsDashboard } from './metrics-model';

const MAX_BYTES = 1_048_576;
const requests = new Map<string, Promise<void>>();
const updateArgs = z.object({
  configPath: z.string().refine(isAbsolute, 'Путь профиля должен быть абсолютным.'),
  workspaceId: idSchema,
  inputPath: z.string().refine(isAbsolute, 'Кандидат должен иметь абсолютный путь.'),
  expectedSnapshot: z.string().datetime({ offset: true }),
  check: z.boolean().optional(),
}).strict();

/** Bounds apply before allocation/parsing; links and directories are never accepted. */
async function readCheckedFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error('Ожидается обычный файл JSON.');
    if (before.size > MAX_BYTES) throw new Error('JSON превышает 1 MiB.');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('JSON превышает 1 MiB.');
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('JSON изменился во время чтения. Повтори обновление.');
    return { bytes: bytes.subarray(0, length), stat: after };
  } finally { await file.close(); }
}

function json(bytes: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function sameIds(before: { id: string }[], after: { id: string }[]) {
  return before.length === after.length && before.every(item => after.some(next => next.id === item.id));
}
function checkCompatibility(before: MetricsDashboard, after: MetricsDashboard, check = false) {
  if (!sameIds(before.metrics, after.metrics)) throw new Error('Обновление должно сохранить все ID показателей.');
  for (const metric of before.metrics) {
    const next = after.metrics.find(item => item.id === metric.id)!;
    if (metric.source.url !== next.source.url) throw new Error(`Нельзя менять URL источника показателя ${metric.id}.`);
    if (Date.parse(next.source.verifiedAt) < Date.parse(metric.source.verifiedAt)) throw new Error(`Дата проверки источника ${metric.id} не может двигаться назад.`);
    if (metric.kind !== next.kind || metric.unit !== next.unit || metric.direction !== next.direction) throw new Error(`Нельзя менять смысл или единицу показателя ${metric.id}.`);
    if (!sameIds(metric.series, next.series)) throw new Error(`Обновление должно сохранить все ID серий показателя ${metric.id}.`);
    if (metric.series.some(series => next.series.find(item => item.id === series.id)!.scope !== series.scope)) throw new Error(`Нельзя менять уровень серии показателя ${metric.id}.`);
    for (const series of metric.series) {
      const nextSeries = next.series.find(item => item.id === series.id)!;
      for (const field of ['points', 'plan'] as const) {
        const periods = new Set((nextSeries[field] ?? []).map(point => point.period));
        if ((series[field] ?? []).some(point => !periods.has(point.period))) throw new Error(`Нельзя терять исторические периоды ${field} в ${metric.id}/${series.id}; неизвестные значения сохраняй как missing.`);
      }
    }
  }
  if (Date.parse(after.preparedAt) < Date.parse(before.preparedAt) || (!check && Date.parse(after.preparedAt) === Date.parse(before.preparedAt))) throw new Error('Дата нового снимка должна быть позже текущей.');
}
async function writeExclusive(path: string, bytes: Buffer, mode: number) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try { await file.chmod(mode); await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
}

export interface MetricsUpdateResult { workspaceId: string; metricCount: number; preparedAt: string; backup?: string; checked?: true; }

/** Only the plugin's configured profile is writable. No caller-supplied output path. */
export async function applyMetricsUpdate(args: z.input<typeof updateArgs>): Promise<MetricsUpdateResult> {
  const input = updateArgs.parse(args);
  const previous = requests.get(input.configPath) ?? Promise.resolve();
  let unlock!: () => void;
  const pending = new Promise<void>(resolve => { unlock = resolve; });
  requests.set(input.configPath, pending);
  await previous;
  try {
    const candidate = metricsDashboardSchema.parse(json((await readCheckedFile(input.inputPath)).bytes));
    const baseline = await readCheckedFile(input.configPath);
    const raw = json(baseline.bytes);
    const config = parseConfig(raw, dirname(input.configPath));
    const workspace = config.workspaces.find(item => item.id === input.workspaceId);
    if (!workspace?.metricsDashboard || !workspace.actions.some(action => action.effect === 'metrics-refresh')) throw new Error('Для этой вкладки ручное обновление графиков не разрешено.');
    if (workspace.metricsDashboard.preparedAt !== input.expectedSnapshot) throw new Error('Снимок уже изменился. Перечитай данные рабочего места и подготовь обновление заново.');
    checkCompatibility(workspace.metricsDashboard, candidate, input.check);
    // Keep the raw descriptor: parseConfig resolves paths and must not be serialized.
    const next = raw as { workspaces: { id: string; metricsDashboard?: MetricsDashboard }[] };
    next.workspaces.find(item => item.id === input.workspaceId)!.metricsDashboard = candidate;
    validateInstructions(parseConfig(next, dirname(input.configPath)));
    const bytes = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    if (bytes.length > MAX_BYTES) throw new Error('Обновлённый профиль превышает 1 MiB.');
    if (input.check) return { workspaceId: input.workspaceId, metricCount: candidate.metrics.length, preparedAt: candidate.preparedAt, checked: true };
    const suffix = randomUUID();
    const backup = `${input.configPath}.backup-metrics-${suffix}.json`;
    const temporary = `${input.configPath}.metrics-${suffix}.tmp`;
    const mode = baseline.stat.mode & 0o777;
    await writeExclusive(backup, baseline.bytes, mode);
    try {
      await writeExclusive(temporary, bytes, mode);
      const current = await readCheckedFile(input.configPath);
      if (!current.bytes.equals(baseline.bytes) || current.stat.ino !== baseline.stat.ino || current.stat.dev !== baseline.stat.dev || current.stat.mode !== baseline.stat.mode) throw new Error('Профиль изменился параллельно. Обновление не применено; перечитай текущий снимок.');
      await rename(temporary, input.configPath);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { workspaceId: input.workspaceId, metricCount: candidate.metrics.length, preparedAt: candidate.preparedAt, backup };
  } finally {
    unlock();
    if (requests.get(input.configPath) === pending) requests.delete(input.configPath);
  }
}
