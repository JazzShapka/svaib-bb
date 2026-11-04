import { z } from 'zod';
import manifest from './scaffold-catalog.json';
const identifier = z.string().regex(/^[a-zA-Z0-9а-яёА-ЯЁ_-]{1,200}$/).refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
// A colon can qualify a Windows drive or alternate data stream, not a workspace segment.
const segment = z.string().min(1).max(150).regex(/^[^:]+$/, 'Недопустимое имя элемента.').refine(value => !/[\\/\u0000-\u001f]/.test(value) && !['.', '..'].includes(value), 'Недопустимое имя элемента.');
export const treeItemSchema = z.object({
  id: identifier, parentId: identifier.nullable(), name: segment, type: z.enum(['file', 'folder']),
  note: z.string().max(1000), role: z.enum(['root', 'unit', 'aspect', 'kit', 'infrastructure', 'workspace']),
  locked: z.boolean(), fixedName: z.boolean(), placeholder: z.boolean(), proposed: z.boolean(), acceptsBlocks: z.boolean(), projectContainer: z.boolean(), clientContainer: z.boolean(),
  template: z.string().nullable(), screenKind: z.string().max(30).nullable(),
}).strict();
export const treeConfigSchema = z.object({ schemaVersion: z.literal(2), catalogVersion: z.string(), canonSnapshot: z.string(), companyName: z.string().min(1).max(100),
  overview: z.object({ sourceHash: z.string().regex(/^[0-9a-f]{64}$/), maxDepth: z.number().int().positive(), omittedBranches: z.number().int().nonnegative(), omittedItems: z.number().int().nonnegative(), reservedPaths: z.array(z.string().min(1).max(2000)).max(600) }).strict().optional(),
  tree: z.array(treeItemSchema).min(1).max(700) }).strict().superRefine((config, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (config.catalogVersion !== manifest.version || config.canonSnapshot !== manifest.canonSnapshot) issue('Каталог изменился; нужна сверка с установленной поставкой.');
  const nodes = new Map(config.tree.map(item => [item.id, item]));
  if (nodes.size !== config.tree.length) issue('ID элементов должны быть уникальны.');
  const roots = config.tree.filter(item => item.parentId === null);
  if (roots.length !== 1 || roots[0]?.id !== 'root' || roots[0]?.type !== 'folder' || !roots[0]?.locked) issue('У дерева должен быть один защищённый корень-папка с ID root.');
  const siblings = new Set<string>();
  for (const node of config.tree) {
    if (node.template && !manifest.templates.some(file => file.path === node.template)) issue('Шаблон отсутствует в каталоге.');
    const parent = node.parentId ? nodes.get(node.parentId) : null;
    if (node.parentId && (!parent || parent.type !== 'folder')) issue('Родитель должен быть существующей папкой.');
    const sibling = `${node.parentId}/${node.name}`;
    if (siblings.has(sibling)) issue('Повторяющееся имя среди соседних элементов.');
    siblings.add(sibling);
    const seen = new Set([node.id]); let cursor = parent;
    while (cursor) { if (seen.has(cursor.id)) { issue('Цикл в дереве.'); break; } seen.add(cursor.id); cursor = cursor.parentId ? nodes.get(cursor.parentId) : null; }
  }
  if (config.overview) for (const node of config.tree.filter(item => item.parentId)) {
    const segments = []; let cursor: TreeItem | undefined = node; const visited = new Set<string>();
    while (cursor?.parentId && !visited.has(cursor.id)) { visited.add(cursor.id); segments.unshift(cursor.name); cursor = nodes.get(cursor.parentId); }
    const path = segments.join('/');
    if (config.overview.reservedPaths.some(reserved => path === reserved || path.startsWith(reserved + '/'))) issue('Скрытый путь нельзя заменять видимым элементом.');
  }
});
export type TreeConfig = z.infer<typeof treeConfigSchema>;
export type TreeItem = z.infer<typeof treeItemSchema>;
export function checkOverviewUpdate(previous: TreeConfig, updated: TreeConfig) {
  if (!previous.overview && !updated.overview) return;
  if (!previous.overview || !updated.overview || JSON.stringify(previous.overview) !== JSON.stringify(updated.overview)) throw new Error('overview_immutable');
  const locked = (config: TreeConfig) => {
    const nodes = new Map(config.tree.map(node => [node.id, node]));
    const result = new Map<string, string>();
    for (const node of config.tree.filter(item => item.locked)) {
      let cursor = node; const path = [];
      while (cursor.parentId) { path.unshift(cursor.name); cursor = nodes.get(cursor.parentId)!; }
      result.set(node.id, JSON.stringify({ path: path.join('/'), node }));
    }
    return result;
  };
  const before = locked(previous), after = locked(updated);
  for (const [id, value] of before) if (after.get(id) !== value) throw new Error('overview_locked_path');
  const lockedPaths = [...before.values()].map(value => (JSON.parse(value) as {path:string}).path).filter(Boolean);
  const underLocked = (config: TreeConfig) => {
    const nodes = new Map(config.tree.map(node => [node.id, node]));
    return config.tree.flatMap(node => { let cursor = node; const path = [];
      while (cursor.parentId) { path.unshift(cursor.name); cursor = nodes.get(cursor.parentId)!; }
      const full = path.join('/'); return lockedPaths.some(parent => full.startsWith(parent + '/')) ? [JSON.stringify({path:full,node})] : [];
    }).sort();
  };
  if (JSON.stringify(underLocked(previous)) !== JSON.stringify(underLocked(updated))) throw new Error('overview_locked_path');
}
export function planTree(config: TreeConfig) {
  if (config.overview) throw new Error('Ограниченный обзор не является планом файловых изменений.');
  const nodes = new Map(config.tree.map(item => [item.id, item]));
  function path(node: TreeItem): string { const parent = node.parentId ? nodes.get(node.parentId)! : null; return parent ? [path(parent), node.name].filter(Boolean).join('/') : ''; }
  const files = config.tree.filter(item => item.parentId && item.type === 'file').map(item => ({ path: path(item), template: item.template,
    templateSha256: manifest.templates.find(file => file.path === item.template)?.sha256 ?? null, subject: config.companyName, purpose: item.note }));
  const directories = config.tree.filter(item => item.parentId && item.type === 'folder').map(item => ({ path: path(item), subject: config.companyName, purpose: item.note }));
  return { schemaVersion: 1 as const, catalogVersion: config.catalogVersion, canonSnapshot: config.canonSnapshot, companyName: config.companyName, files, directories,
    agentSteps: ['Это согласованный проект структуры, а не разрешение заменять существующие файлы. Получить корень и проверить space-scaffold readiness.',
      'Сверить версию, отпечаток канона и SHA-256 шаблонов. Уточнить оставшиеся шаблонные имена и предложенные элементы; проверить полноту узлов по канону 4.3.',
      'Подготовить тексты и карты README по текущим спецификациям. Для приватных папок сначала настроить права хранилища.',
      'Показать чувствительные изменения существующего пространства отдельно; после согласованного применения проверить файлы и ссылки, затем записать достоверную версию каркаса и подтверждённую привязку реальной компании. Подтверждение Screen не закрывает другие этапы онбординга.',
      'Интейки стратегии, целей и профиля руководителя, содержательное наполнение и синхронизация пространства выполняются следующими треками; их готовность не требуется для создания каркаса.'] };
}
