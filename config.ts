import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, dirname } from 'node:path';
import { z } from 'zod';
import type { Action, Workspace, MetricsSnapshot, LinkHub, ClientHub, WorkspaceAspect, PersonalSpace } from './types';
import { metricsDashboardSchema } from './metrics-model';

export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const aspectIdSchema = z.enum(['strategy', 'metrics', 'team', 'finance', 'projects', 'processes', 'rhythm']);
const text = z.string().max(24_000);
const url = z.string().url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Только HTTP(S)');
const tabColor = z.enum(['red', 'blue', 'green']).optional();
export const sourceSchema = z.object({ id: idSchema, title: text, path: z.string().min(1), updatedAt: z.string().optional() }).strict();
export const actionSchema = z.object({ id: idSchema, title: text, description: text, icon: text, prompt: text,
  skill: z.string().regex(/^(?:[a-z0-9][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*$/).max(160).optional(), aspectIds: z.array(aspectIdSchema).max(7).optional(),
  kind: z.enum(['action', 'role']).optional(), available: z.boolean().optional(), unavailableReason: text.optional(),
  mode: z.enum(['standard', 'draft-only']).optional(),
  effect: z.enum(['metrics-refresh', 'personal-assistant']).optional(),
}).strict();
export const aspectSchema: z.ZodType<WorkspaceAspect> = z.object({
  id: aspectIdSchema, summary: text.optional(), snapshotAt: text.optional(),
  sourceIds: z.array(idSchema), actionIds: z.array(idSchema),
  items: z.array(z.object({
    id: idSchema, title: text, summary: text,
    role: text.optional(), responsibility: text.optional(), owner: text.optional(), status: text.optional(),
    value: text.optional(), target: text.optional(), period: text.optional(),
    sourceIds: z.array(idSchema), actionIds: z.array(idSchema),
  }).strict()).max(200),
}).strict();
const signalSchema = z.object({ title: text, text, tone: z.enum(['attention', 'progress', 'neutral']), sourceId: idSchema }).strict();
const valuesSchema = z.object({ previous: z.number().finite().nonnegative(), current: z.number().finite().nonnegative(), changePercent: z.number().finite(), perDayChangePercent: z.number().finite() });
export const metricsSchema: z.ZodType<MetricsSnapshot> = z.object({
  eyebrow: text, title: text, description: text, evidence: z.array(text), insight: z.object({ title: text, text }).strict().optional(),
  display: z.object({ period: text, baseline: text, periodLabel: text, baselineLabel: text, comparisonLabel: text,
    days: z.object({ current: z.number().int().positive(), previous: z.number().int().positive() }).strict(),
    charts: z.array(z.object({ id: idSchema, label: text, unit: text,
      series: z.array(valuesSchema.extend({ shopId: idSchema, label: text, sourceCells: z.array(text), coverage: text }).strict()).min(1),
      aggregate: valuesSchema.strict(),
    }).strict()).min(1),
  }).strict(), verifiedAt: text, sourceModifiedTime: text, discrepancyNote: text, source: z.object({ title: text, url }).strict(),
}).strict();
const hubLinkBase = { id: idSchema, title: text, description: text };
const hubLinkSchema = z.discriminatedUnion('kind', [
  z.object({ ...hubLinkBase, kind: z.literal('source'), sourceId: idSchema }).strict(),
  z.object({ ...hubLinkBase, kind: z.literal('url'), url }).strict(),
]);
export const linkHubSchema: z.ZodType<LinkHub> = z.object({
  featured: z.object({ eyebrow: text, title: text, dateLabel: text, description: text, links: z.array(hubLinkSchema).min(1).max(12) }).strict(),
  groups: z.array(z.object({ id: idSchema, title: text, description: text, links: z.array(hubLinkSchema).min(1).max(20) }).strict()).max(8),
}).strict();
export const clientHubSchema: z.ZodType<ClientHub> = z.object({
  guide: z.object({ sourceId: idSchema, title: z.string().min(1).max(160), description: z.string().max(1200) }).strict(),
  documentSourceIds: z.array(idSchema).max(12),
  cards: z.array(z.object({
    id: idSchema, title: z.string().min(1).max(160), description: z.string().max(1200),
    icon: z.enum(['meeting', 'client', 'proposal']),
    actionId: idSchema.optional(), sourceId: idSchema.optional(),
  }).strict().refine(card => !(card.actionId && card.sourceId), 'У клиентской карточки может быть только одно назначение.')).max(12),
  workSourceIds: z.array(idSchema).max(50),
}).strict();
export const personalSchema: z.ZodType<PersonalSpace> = z.object({
  assistantActionId: idSchema.optional(),
  day: z.object({ description: text, sourceId: idSchema, actionIds: z.array(idSchema).max(12) }).strict(),
  continueItems: z.array(z.object({
    id: idSchema, title: text, description: text, sectionId: idSchema,
    actionId: idSchema.optional(), sourceId: idSchema.optional(),
  }).strict().refine(item => Boolean(item.actionId || item.sourceId), 'У карточки продолжения нужен источник или действие.')).max(6),
  sections: z.array(z.object({
    id: idSchema, title: text, description: text,
    icon: z.enum(['spark', 'heart', 'book', 'thought', 'people', 'compass', 'home']),
    sourceIds: z.array(idSchema).max(50), actionIds: z.array(idSchema).max(12),
  }).strict()).max(12),
  archiveSourceIds: z.array(idSchema).max(50),
}).strict();
export const workspaceSchema: z.ZodType<Workspace> = z.object({
  id: idSchema, name: text, eyebrow: text, description: text, goal: text, goalLabel: text, updatedAt: text, snapshotAt: text,
  tabColor,
  sources: z.array(sourceSchema), signals: z.array(signalSchema), actions: z.array(actionSchema), metrics: metricsSchema.optional(), aspects: z.array(aspectSchema).max(7).optional(),
  metricsDashboard: metricsDashboardSchema.optional(),
  planner: z.object({ url, title: text, description: text }).strict().optional(),
  linkHub: linkHubSchema.optional(),
  clientHub: clientHubSchema.optional(),
  personal: personalSchema.optional(),
  fileContext: z.object({ hostId: text, environmentId: text, rootPath: text }).strict().optional(),
}).strict();
export interface CatalogAction extends Action { method: string; sourceIds: string[]; }
export interface CatalogWorkspace extends Omit<Workspace, 'updatedAt' | 'actions' | 'fileContext'> {
  root: string; projectId: string; environmentId: string; hostId: string; documentThreadId?: string; documentRoot?: string; actions: CatalogAction[];
}
export interface WorkplaceConfig { schemaVersion: 1; workspaces: CatalogWorkspace[]; }
const rawWorkspaceSchema = z.object({
  id: idSchema, name: text, eyebrow: text, description: text, goal: text, goalLabel: text, snapshotAt: text,
  tabColor,
  root: z.string().min(1), projectId: z.string().min(1), environmentId: z.string().min(1), hostId: z.string().min(1), documentThreadId: text.optional(), documentRoot: text.optional(),
  sources: z.array(sourceSchema.omit({ updatedAt: true })), signals: z.array(signalSchema),
  actions: z.array(actionSchema.omit({ available: true, unavailableReason: true }).extend({ method: text, sourceIds: z.array(idSchema) }).strict()), metrics: metricsSchema.optional(), aspects: z.array(aspectSchema).max(7).optional(),
  metricsDashboard: metricsDashboardSchema.optional(),
  planner: z.object({ url, title: text, description: text }).strict().optional(),
  linkHub: linkHubSchema.optional(),
  clientHub: clientHubSchema.optional(),
  personal: personalSchema.optional(),
}).strict();
export const configSchema = z.object({ schemaVersion: z.literal(1), workspaces: z.array(rawWorkspaceSchema).max(40) }).strict();
export const EMPTY_CONFIG: WorkplaceConfig = { schemaVersion: 1, workspaces: [] };
function unique(ids: string[], what: string) { if (new Set(ids).size !== ids.length) throw new Error(`Повторяются идентификаторы: ${what}`); }
export function parseConfig(value: unknown, baseDir: string): WorkplaceConfig {
  const raw = configSchema.parse(value);
  unique(raw.workspaces.map(w => w.id), 'пространства');
  const workspaces = raw.workspaces.map(w => {
    const root = resolve(baseDir, w.root);
    unique(w.sources.map(s => s.id), `источники ${w.id}`);
    unique(w.actions.map(a => a.id), `действия ${w.id}`);
    const sources = w.sources.map(s => {
      if (isAbsolute(s.path)) throw new Error('Путь источника должен быть относительным к корню пространства.');
      const path = resolve(root, s.path); const inside = relative(root, path);
      if (!inside || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Источник за пределами пространства.');
      return { ...s, path };
    });
    const ids = new Set(sources.map(s => s.id));
    for (const s of w.signals) if (!ids.has(s.sourceId)) throw new Error('У сигнала нет источника.');
    for (const a of w.actions) for (const id of a.sourceIds) if (!ids.has(id)) throw new Error('В маршруте действия нет источника.');
    const actionIds = new Set(w.actions.map(a => a.id));
    unique((w.aspects ?? []).map(a => a.id), `ракурсы ${w.id}`);
    for (const aspect of w.aspects ?? []) {
      unique(aspect.items.map(item => item.id), `объекты ракурса ${w.id}/${aspect.id}`);
      for (const object of [aspect, ...aspect.items]) {
        unique(object.sourceIds, `источники ракурса ${w.id}/${aspect.id}`);
        unique(object.actionIds, `действия ракурса ${w.id}/${aspect.id}`);
        for (const id of object.sourceIds) if (!ids.has(id)) throw new Error('У ракурса или объекта нет источника.');
        for (const id of object.actionIds) if (!actionIds.has(id)) throw new Error('У ракурса или объекта нет действия.');
      }
    }
    for (const action of w.actions) if (action.aspectIds) unique(action.aspectIds, `ракурсы действия ${w.id}/${action.id}`);
    if (w.clientHub) {
      if (w.personal || w.linkHub || w.aspects !== undefined || w.metrics || w.metricsDashboard
        || w.actions.some(action => action.aspectIds !== undefined || action.effect !== undefined)) {
        throw new Error('Клиентское представление не совмещается с личным пространством, обзором ссылок, бизнес-ракурсами, метриками или специальными действиями.');
      }
      if (w.sources.length > 50) throw new Error('В клиентском представлении допускается не больше 50 источников.');
      if (w.actions.length > 24) throw new Error('В клиентском представлении допускается не больше 24 действий.');
      const hub = w.clientHub;
      unique(hub.cards.map(card => card.id), `клиентские карточки ${w.id}`);
      const checkSources = (sourceIds: string[]) => {
        unique(sourceIds, `источники клиентского представления ${w.id}`);
        for (const id of sourceIds) if (!ids.has(id)) throw new Error('У клиентского сценария или карточки нет источника.');
      };
      checkSources([hub.guide.sourceId]);
      checkSources(hub.documentSourceIds);
      checkSources(hub.workSourceIds);
      for (const card of hub.cards) {
        if (card.sourceId) checkSources([card.sourceId]);
        if (card.actionId && !actionIds.has(card.actionId)) throw new Error('У клиентской карточки нет действия.');
      }
    }
    if (w.actions.some(action => action.mode === 'draft-only' && action.effect)) {
      throw new Error('Режим draft-only нельзя совмещать с effect: выбери подготовку или специальное действие.');
    }
    if (w.actions.some(action => action.effect === 'personal-assistant') && !w.personal) {
      throw new Error('Личный ассистент доступен только в личном пространстве.');
    }
    for (const action of w.actions.filter(action => action.effect === 'metrics-refresh')) {
      if (!w.metricsDashboard || w.personal || w.linkHub) throw new Error('Обновление графиков требует бизнес-пространства с metricsDashboard.');
      if (action.aspectIds?.some(id => id !== 'metrics')) throw new Error('Обновление графиков доступно только в ракурсе metrics.');
      if (w.aspects?.some(aspect => (aspect.id !== 'metrics' && aspect.actionIds.includes(action.id)) || aspect.items.some(item => item.actionIds.includes(action.id)))) throw new Error('Обновление графиков нельзя привязать к другому ракурсу или отдельному объекту.');
    }
    if (w.personal) {
      const personal = w.personal;
      if (w.linkHub || w.metrics || w.metricsDashboard || w.aspects?.length || w.actions.some(action => action.aspectIds?.length)) {
        throw new Error('Личное пространство не совмещается с бизнес-ракурсами, метриками или обзором ссылок.');
      }
      if (w.sources.length > 50) throw new Error('В личном пространстве допускается не больше 50 источников.');
      unique(personal.sections.map(section => section.id), `разделы личного пространства ${w.id}`);
      unique(personal.continueItems.map(item => item.id), `карточки продолжения ${w.id}`);
      const checkSources = (sourceIds: string[]) => {
        unique(sourceIds, `источники личного пространства ${w.id}`);
        for (const id of sourceIds) if (!ids.has(id)) throw new Error('У личного раздела или карточки нет источника.');
      };
      const checkActions = (references: string[]) => {
        unique(references, `действия личного пространства ${w.id}`);
        for (const id of references) if (!actionIds.has(id)) throw new Error('У личного раздела или карточки нет действия.');
      };
      checkSources([personal.day.sourceId]);
      checkSources(personal.archiveSourceIds);
      checkActions(personal.day.actionIds);
      if (personal.assistantActionId !== undefined) {
        checkActions([personal.assistantActionId]);
        if (w.actions.find(action => action.id === personal.assistantActionId)?.effect !== 'personal-assistant') {
          throw new Error('Главный вход личного ассистента требует действие с effect personal-assistant.');
        }
      }
      for (const section of personal.sections) {
        checkSources(section.sourceIds);
        checkActions(section.actionIds);
      }
      for (const item of personal.continueItems) {
        const section = personal.sections.find(section => section.id === item.sectionId);
        if (!section) throw new Error('У карточки продолжения нет личного раздела.');
        if (item.sourceId && !section.sourceIds.includes(item.sourceId)) throw new Error('Источник карточки продолжения не принадлежит её разделу.');
        if (item.actionId && !section.actionIds.includes(item.actionId)) throw new Error('Действие карточки продолжения не принадлежит её разделу.');
      }
    }
    if (w.linkHub) {
      unique(w.linkHub.groups.map(g => g.id), `группы ссылок ${w.id}`);
      const links = [...w.linkHub.featured.links, ...w.linkHub.groups.flatMap(g => g.links)];
      unique(links.map(link => link.id), `ссылки ${w.id}`);
      for (const link of links) if (link.kind === 'source' && !ids.has(link.sourceId)) throw new Error('У ссылки нет источника.');
    }
    const documentRoot = w.documentRoot ? resolve(baseDir, w.documentRoot) : undefined;
    if (Boolean(w.documentThreadId) !== Boolean(documentRoot)) throw new Error('Для ссылок нужны documentThreadId и documentRoot вместе.');
    if (documentRoot) {
      const inside = relative(documentRoot, root);
      if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('documentRoot не содержит пространство.');
    }
    return { ...w, root, sources, ...(documentRoot ? { documentRoot } : {}) };
  });
  return { ...raw, workspaces };
}
export async function loadConfig(path: string): Promise<WorkplaceConfig> {
  if (!path.trim()) return EMPTY_CONFIG;
  if (!isAbsolute(path)) throw new Error('configPath должен быть абсолютным путём на машине BB-сервера.');
  const data = await readFile(path);
  if (data.byteLength > 1_048_576) throw new Error('Настройка рабочего места превышает 1 MiB.');
  return parseConfig(JSON.parse(data.toString('utf8')), dirname(path));
}

/** SDK configure is synchronous; read only the operator-owned descriptor, never source content. */
export function loadConfigSync(path: string): WorkplaceConfig {
  if (!path.trim()) return EMPTY_CONFIG;
  if (!isAbsolute(path)) throw new Error('configPath должен быть абсолютным путём на машине BB-сервера.');
  const data = readFileSync(path);
  if (data.byteLength > 1_048_576) throw new Error('Настройка рабочего места превышает 1 MiB.');
  return parseConfig(JSON.parse(data.toString('utf8')), dirname(path));
}
