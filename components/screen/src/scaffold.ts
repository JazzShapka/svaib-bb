import { z } from 'zod';
import manifest from './scaffold-catalog.json';
import { treeConfigSchema, planTree } from './scaffold-tree-model';

const key = z.string().regex(/^[a-z][a-z0-9-]{0,49}$/);
export const kitKeys = ['overview', 'active', 'backlog', 'progress', 'decisions'] as const;
export const kitLabels = { overview: 'Обзор', active: 'Текущая работа', backlog: 'Бэклог', progress: 'Прогресс', decisions: 'Решения' };
export const strategicKeys = ['vision', 'goal', 'strategy'] as const;
export const strategicLabels = { vision: 'Видение', goal: 'Цель', strategy: 'Стратегия' };
const unique = <T extends z.ZodType>(schema: T) => z.array(schema).max(10).refine(items => new Set(items).size === items.length, 'Повторяющийся элемент.');
export const scaffoldNodeSchema = z.object({
  id: key, kind: z.enum(['unit', 'project', 'product', 'clients', 'client', 'ceo']), parentId: z.string().min(1).max(50),
  name: z.string().trim().min(1).max(100), slug: z.string().regex(/^(?:[a-z][a-z0-9-]{0,49}|00_ceo)$/),
  form: z.enum(['file', 'folder']), owner: z.string().trim().max(100), reason: z.string().trim().min(1).max(500),
  kit: unique(z.enum(kitKeys)), strategicFiles: unique(z.enum(strategicKeys)),
}).strict();
export const semanticScaffoldConfigSchema = z.object({
  schemaVersion: z.literal(1), catalogVersion: z.string().max(30), canonSnapshot: z.string().max(40),
  companyName: z.string().trim().min(1).max(100), companyKit: unique(z.enum(kitKeys)),
  nodes: z.array(scaffoldNodeSchema).max(40),
  extras: z.array(z.object({ ownerId: z.string().min(1).max(50), kind: z.enum(['strategic', 'team', 'metrics', 'projects', 'processes', 'knowledge', 'inbox', 'private', 'meetings', 'archive', 'docs', 'contracts', 'drafts']), slug: key.optional() }).strict()).max(160).optional(),
}).strict().superRefine((config, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (config.catalogVersion !== manifest.version || config.canonSnapshot !== manifest.canonSnapshot) issue('Каталог изменился: агент должен пересобрать план по текущей поставке.');
  const nodes = new Map(config.nodes.map(node => [node.id, node]));
  if (nodes.size !== config.nodes.length || nodes.has('root') || nodes.has('company')) issue('ID объектов должны быть уникальны; root и company зарезервированы.');
  const reserved = new Set(['01-company', 'company', 'projects', 'processes', 'knowledge', 'readme', 'agents', 'claude', 'source', 'extractors', 'meetings']);
  const siblings = new Set<string>();
  for (const node of config.nodes) {
    const sibling = `${node.parentId}/${node.kind === 'project' ? 'projects/' : ''}${node.slug}`;
    if (siblings.has(sibling) || reserved.has(node.slug)) issue(`Недопустимое или повторяющееся имя папки: ${node.slug}.`);
    siblings.add(sibling);
    const parent = nodes.get(node.parentId);
    if (!['root', 'company'].includes(node.parentId) && !parent) issue(`Не найден родитель: ${node.name}.`);
    if (parent && parent.form !== 'folder') issue(`Родитель должен быть направлением-папкой: ${node.name}.`);
    if (parent && node.form === 'file' && parent.strategicFiles.length === 1 && parent.strategicFiles[0] === node.slug) issue(`Имя краткого файла занято стратегическим файлом родителя: ${node.slug}.`);
    if (node.kind === 'unit' && node.parentId === 'company') issue('Направление верхнего уровня живёт в корне; у компании размещайте общие проекты.');
    if (node.kind === 'project' && (node.parentId === 'root' || node.form !== 'folder' || node.strategicFiles.length)) issue('Проект размещается в projects/ у владельца; цель проекта описывается в обзоре со ссылкой на цель направления.');
    if (node.form === 'file' && (node.kind !== 'unit' || node.kit.length || node.strategicFiles.length)) issue(`Для управленческой панели и стратегических файлов выберите форму папки: ${node.name}.`);
    if (node.kind === 'ceo' && (node.slug !== '00_ceo' || node.parentId !== 'root' || node.kit.length || node.strategicFiles.length)) issue('Личный контекст CEO использует свой шаблон в 00_ceo/.');
    if (node.kind === 'client' && parent?.kind !== 'clients') issue('Клиент размещается в портфеле клиентов.');
    if (node.form === 'folder' && !['ceo', 'clients'].includes(node.kind) && !node.kit.includes('overview')) issue(`Для папки нужен обзор: ${node.name}.`);
    const seen = new Set([node.id]); let cursor = parent;
    while (cursor) {
      if (seen.has(cursor.id)) { issue('Вложенность содержит цикл.'); break; }
      seen.add(cursor.id); cursor = nodes.get(cursor.parentId);
    }
  }
  const extraKeys = new Set<string>();
  for (const extra of config.extras ?? []) {
    const owner = nodes.get(extra.ownerId);
    if (extra.ownerId !== 'company' && (!owner || owner.form !== 'folder')) issue('Блок можно добавить только в объект-папку.');
    const id = extra.ownerId + '/' + extra.kind;
    if (extraKeys.has(id)) issue('Блок уже добавлен в объект.');
    extraKeys.add(id);
    if (extra.kind === 'private' && !extra.slug) issue('Для приватной папки нужно имя владельца.');
    if (extra.kind === 'strategic' && owner?.kind === 'project') issue('Цель проекта и вклад в цель владельца живут в обзоре.');
  }
});
export const scaffoldConfigSchema = z.union([semanticScaffoldConfigSchema, treeConfigSchema]);
export type AnyScaffoldConfig = z.infer<typeof scaffoldConfigSchema>;
export type ScaffoldConfig = z.infer<typeof semanticScaffoldConfigSchema>;
export type ScaffoldNode = z.infer<typeof scaffoldNodeSchema>;
export type PlanFile = { path: string; template: string | null; templateSha256: string | null; subject: string; purpose: string };
export type ScaffoldPlan = { schemaVersion: 1; catalogVersion: string; canonSnapshot: string; companyName: string; files: PlanFile[]; directories?: { path: string; subject: string; purpose: string }[]; agentSteps: string[] };
export const scaffoldConfirmationSchema = z.object({ blockId: z.string(), documentRevision: z.number().int().positive(), revision: z.number().int().positive(), at: z.iso.datetime(),
  planHash: z.string(), config: scaffoldConfigSchema, plan: z.object({ schemaVersion: z.literal(1), catalogVersion: z.string(), canonSnapshot: z.string(), companyName: z.string(),
    directories: z.array(z.object({ path: z.string(), subject: z.string(), purpose: z.string() }).strict()).optional(),
    files: z.array(z.object({ path: z.string(), template: z.string().nullable(), templateSha256: z.string().nullable(), subject: z.string(), purpose: z.string() }).strict()), agentSteps: z.array(z.string()) }).strict() }).strict();
export type ScaffoldConfirmation = z.infer<typeof scaffoldConfirmationSchema>;
export const scaffoldCatalog = { version: manifest.version, canonSnapshot: manifest.canonSnapshot, kit: kitLabels, strategicFiles: strategicLabels };
const kitFiles = { overview: '01_overview.md', active: '02_active.md', backlog: '03_backlog.md', progress: '04_progress.md', decisions: '05_decisions.md' };

export function planScaffold(input: unknown): ScaffoldPlan {
  const config = scaffoldConfigSchema.parse(input);
  if (config.schemaVersion === 2) return planTree(config);
  const files = new Map<string, PlanFile>();
  function add(path: string, template: string | null, subject: string, purpose: string) {
    const found = template ? manifest.templates.find(item => item.path === template) : null;
    if (template && !found) throw new Error(`Шаблон отсутствует в поставке: ${template}`);
    const existing = files.get(path);
    if (existing) throw new Error(`Два назначения одного пути: ${path}`);
    files.set(path, { path, template, templateSha256: found?.sha256 ?? null, subject, purpose });
  }
  for (const item of manifest.templates.filter(item => item.path.startsWith('templates/root/'))) {
    const path = item.path.slice('templates/root/'.length);
    add(path, item.path, config.companyName, 'Основа нового пространства; специализировать по компании');
  }
  add('.svaib/space.json', null, config.companyName, 'Метаданные версии: записать только после выполненного и проверенного развёртывания');
  function kit(directory: string, keys: ScaffoldConfig['companyKit'], subject: string) {
    for (const key of kitKeys.filter(key => keys.includes(key))) add(`${directory}/${kitFiles[key]}`, `templates/management-kit/${kitFiles[key]}`, subject, kitLabels[key]);
  }
  kit('01_company', config.companyKit, config.companyName);
  const nodes = new Map(config.nodes.map(node => [node.id, node]));
  const paths = new Map<string, string>();
  function location(node: ScaffoldNode): string {
    if (paths.has(node.id)) return paths.get(node.id)!;
    const parent = nodes.get(node.parentId);
    const base = node.parentId === 'root' ? '' : node.parentId === 'company' ? '01_company/' : location(parent!) + '/';
    const path = base + (node.kind === 'project' ? 'projects/' : '') + node.slug;
    paths.set(node.id, path); return path;
  }
  for (const node of config.nodes) {
    const path = location(node);
    if (node.kind === 'project') {
      const container = path.slice(0, path.lastIndexOf('/')) + '/README.md';
      if (!files.has(container)) add(container, 'templates/aspects/projects/README.md', nodes.get(node.parentId)?.name ?? config.companyName, 'Карта проектов владельца');
    }
    if (node.form === 'file') { add(path + '.md', null, node.name, 'Краткий контекст направления по общей спецификации; ответственный, состояние, ссылки'); continue; }
    if (['ceo', 'product', 'clients', 'client'].includes(node.kind)) {
      const prefix = `templates/nodes/${node.kind === 'client' ? 'clients/client-name' : node.kind}/`;
      for (const file of manifest.templates.filter(file => file.path.startsWith(prefix) && !file.path.slice(prefix.length).includes('/'))) {
        add(path + '/' + file.path.slice(prefix.length), file.path, node.name, 'Шаблон объекта');
      }
    } else add(path + '/README.md', 'templates/nodes/unit/README.md', node.name, 'Карта объекта и маршруты');
    kit(path, node.kit, node.name);
    const strategic = (config.extras ?? []).some(extra => extra.ownerId === node.id && extra.kind === 'strategic') ? [...strategicKeys] : node.strategicFiles;
    for (const file of strategicKeys.filter(key => strategic.includes(key))) {
      const directory = strategic.length > 1 ? path + '/01_strategic' : path;
      add(`${directory}/${file}.md`, `templates/aspects/01_strategic/${file}.md`, node.name, strategicLabels[file]);
    }
  }
  const explicitDirectories: { path: string; subject: string; purpose: string }[] = [];
  for (const extra of config.extras ?? []) {
    const owner = nodes.get(extra.ownerId);
    const path = extra.ownerId === 'company' ? '01_company' : location(owner!);
    const subject = owner?.name ?? config.companyName;
    const addIfMissing = (target: string, template: string, purpose: string) => { if (!files.has(target)) add(target, template, subject, purpose); };
    if (extra.kind === 'strategic') {
      if (extra.ownerId !== 'company') continue;
      for (const key of strategicKeys) addIfMissing(`${path}/01_strategic/${key}.md`, `templates/aspects/01_strategic/${key}.md`, strategicLabels[key]);
    } else if (extra.kind === 'team') addIfMissing(`${path}/02_team/01_org-structure.md`, 'templates/aspects/02_team/01_org-structure.md', 'Карта ролей и подчинения');
    else if (extra.kind === 'metrics') {
      addIfMissing(`${path}/03_metrics/README.md`, 'templates/aspects/03_metrics/README.md', 'Карта метрик');
      if (extra.ownerId !== 'company') addIfMissing(`${path}/03_metrics/${owner!.slug}-metrics.md`, 'templates/aspects/03_metrics/domain-metrics.md', 'Семантика метрик направления');
    } else if (['projects', 'processes', 'knowledge'].includes(extra.kind)) addIfMissing(`${path}/${extra.kind}/README.md`, `templates/aspects/${extra.kind}/README.md`, 'Карта ракурса');
    else if (extra.kind === 'meetings') addIfMissing(`${path}/meetings/README.md`, 'templates/meetings/README.md', 'Память встреч; папки датированных встреч появятся по факту');
    else if (extra.kind === 'inbox' || extra.kind === 'archive') {
      const folder = extra.kind === 'inbox' ? '_inbox' : 'zz_archive';
      addIfMissing(`${path}/${folder}/README.md`, `templates/infrastructure/${folder}/README.md`, 'Служебная папка');
    } else if (extra.kind === 'private') explicitDirectories.push({ path: `${path}/_private/${extra.slug}`, subject, purpose: 'Приватная папка участника; права хранилища настроить до размещения данных' });
    else explicitDirectories.push({ path: `${path}/${extra.kind}`, subject, purpose: 'Рабочие материалы клиента' });
  }
  const directories = new Map(explicitDirectories.map(item => [item.path, item]));
  for (const file of files.values()) {
    const parts = file.path.split('/'); parts.pop();
    while (parts.length) { const path = parts.join('/'); if (!directories.has(path)) directories.set(path, { path, subject: file.subject, purpose: 'Папка каркаса' }); parts.pop(); }
  }
  return { schemaVersion: 1, directories: [...directories.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')), catalogVersion: manifest.version, canonSnapshot: manifest.canonSnapshot, companyName: config.companyName,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    agentSteps: ['Получить объявленный пользователем корень пространства и проверить его через space-scaffold readiness.',
      'Сверить версию, отпечаток канона и SHA-256 используемых шаблонов с установленной поставкой.',
      'Подготовить содержимое файлов: названия, миссии, ответственные, причины размещения, ссылки и карты README. Не копировать каталог шаблонов в пространство.',
      'В непустом корне подготовить отдельный diff; подтверждение структуры не разрешает замену существующего текста, удаление или правку final и правил владельца.',
      'Применить согласованный пакет через space-scaffold, проверить файлы, ссылки и состав. Только затем записать достоверную версию каркаса и подтверждённую привязку реальной компании; не закрывать другие этапы онбординга по подтверждению Screen.',
      'Интейки стратегии, целей и профиля руководителя, содержательное наполнение и синхронизация пространства выполняются следующими треками; их готовность не требуется для создания каркаса.'] };
}
export const initialScaffold: ScaffoldConfig = { schemaVersion: 1, catalogVersion: manifest.version, canonSnapshot: manifest.canonSnapshot,
  companyName: 'Учебная компания', companyKit: [], nodes: [
    { id: 'sales', kind: 'unit', parentId: 'root', name: 'Продажи', slug: 'sales', form: 'folder', owner: '', reason: 'Есть регулярная работа по продажам.', kit: ['overview', 'active'], strategicFiles: [] },
    { id: 'delivery', kind: 'unit', parentId: 'root', name: 'Операции', slug: 'delivery', form: 'file', owner: '', reason: 'Пока нужен краткий контекст направления.', kit: [], strategicFiles: [] },
  ] };
