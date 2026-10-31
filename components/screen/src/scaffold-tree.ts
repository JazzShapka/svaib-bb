import { planScaffold, type AnyScaffoldConfig, type ScaffoldNode } from './scaffold';
import type { TreeConfig, TreeItem } from './scaffold-tree-model';
import manifest from './scaffold-catalog.json';

// One-time conversion for screens created by the earlier semantic prototype.
// New edits use the source constructor's tree contract without losing its flags.
export function toTreeConfig(config: AnyScaffoldConfig): TreeConfig {
  if (config.schemaVersion === 2) return config;
  const legacy = config;
  const plan = planScaffold(legacy);
  const objects = new Map<string, ScaffoldNode>();
  function location(node: ScaffoldNode): string {
    const parent = legacy.nodes.find(item => item.id === node.parentId);
    return (node.parentId === 'root' ? '' : node.parentId === 'company' ? '01_company/' : location(parent!) + '/') + (node.kind === 'project' ? 'projects/' : '') + node.slug + (node.form === 'file' ? '.md' : '');
  }
  for (const node of legacy.nodes) objects.set(location(node), node);
  const base = new Set<string>();
  for (const template of manifest.templates.filter(file => file.path.startsWith('templates/root/'))) {
    let path = template.path.slice('templates/root/'.length); base.add(path);
    while (path.includes('/')) { path = path.slice(0, path.lastIndexOf('/')); base.add(path); }
  }
  base.add('.svaib/space.json');
  const root: TreeItem = { id: 'root', parentId: null, name: 'scaffold', type: 'folder', note: 'корень клиентского scaffold', role: 'root', locked: true, fixedName: false, placeholder: false, proposed: false, acceptsBlocks: false, projectContainer: false, clientContainer: false, template: null, screenKind: null };
  const entries = new Map<string, TreeItem>([['', root]]);
  function add(path: string, folder: boolean, template: string | null, note = ''): TreeItem {
    const existing = entries.get(path); if (existing) return existing;
    const parts = path.split('/'); const name = parts.pop()!; const parent = add(parts.join('/'), true, null);
    const object = objects.get(path);
    const role = object || path === '01_company' ? 'unit' : /^(01_strategic|02_team|03_metrics|projects|processes|knowledge)$/.test(name) ? 'aspect' : /^0[1-5]_(overview|active|backlog|progress|decisions)\.md$/.test(name) ? 'kit' : /^(_inbox|zz_archive|meetings|_private|\.svaib|usage|source|extractors)$/.test(name) ? 'infrastructure' : /^(docs|contracts|drafts)$/.test(name) ? 'workspace' : 'root';
    const item: TreeItem = { id: path === '01_company' ? 'company' : 'item-' + entries.size, parentId: parent.id, name, type: folder ? 'folder' : 'file', note: object?.name ?? note,
      role, locked: base.has(path), fixedName: object?.kind === 'ceo', placeholder: false, proposed: false,
      acceptsBlocks: folder && (Boolean(object) || path === '01_company'), projectContainer: folder && name === 'projects', clientContainer: object?.kind === 'clients', template, screenKind: object?.kind ?? null };
    entries.set(path, item); return item;
  }
  const notes: Record<string, string> = { '01_company': 'обязательный unit: компания как целое', 'README.md': 'карта папки', 'AGENTS.md': 'рабочая инструкция AI-агента', 'CLAUDE.md': 'подключение инструкции', 'operating-model.md': 'система управления; читать первой', 'vision.md': 'идентичность и видение', 'goal.md': 'цель и план', 'strategy.md': 'действующие стратегические выборы', '01_org-structure.md': 'карта ролей и подчинения', 'business-metrics.md': 'базовые бизнес-метрики', '_inbox': 'входящее', 'zz_archive': 'архив', '.svaib': 'служебное агента', '01_strategic': 'курс компании', '02_team': 'команда', '03_metrics': 'метрики' };
  for (const dir of plan.directories ?? []) add(dir.path, true, null, notes[dir.path.split('/').at(-1)!] ?? '');
  for (const file of plan.files) add(file.path, false, file.template, notes[file.path.split('/').at(-1)!] ?? '');
  return { schemaVersion: 2, catalogVersion: config.catalogVersion, canonSnapshot: config.canonSnapshot, companyName: config.companyName, tree: [...entries.values()] };
}
