// Shared snapshot contract and classification. No BB SDK or local filesystem access.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { scaffoldCatalog, scaffoldConfigSchema, type AnyScaffoldConfig } from './scaffold';

export type ScaffoldTreeConfig = Extract<AnyScaffoldConfig, { schemaVersion: 2 }>;
export type ScaffoldRoleEvidence = { role: 'unit' | 'aspect' | 'kit' | 'infrastructure' | 'workspace'; source: string };
export type SnapshotKind = 'file' | 'directory' | 'symlink' | 'other';
export type SnapshotEntry = {
  path: string; kind: SnapshotKind; device: string; inode: string; size: number; mtimeNs: string;
  sha256: string | null; childrenHash: string | null; opaqueReason: string | null;
};
export type ScaffoldImportLimits = { maxEntries: number; maxDepth: number; maxFileBytes: number; maxTotalBytes: number };
export type ScaffoldSnapshot = {
  schemaVersion: 1; root: { realPath: string; device: string; inode: string };
  entries: SnapshotEntry[]; ignoredRoots: string[]; limits: ScaffoldImportLimits; hash: string;
};
export const scaffoldImportLimits: Readonly<ScaffoldImportLimits> = Object.freeze({ maxEntries: 600, maxDepth: 12, maxFileBytes: 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 });
export const maxScaffoldSnapshotBytes = 224 * 1024;
export const maxScaffoldConfigBytes = 256 * 1024;
export class ScaffoldImportError extends Error {
  constructor(readonly code: 'importer_unavailable' | 'invalid_root' | 'snapshot_changed' | 'snapshot_invalid' | 'too_large' | 'invalid_config', message: string) { super(message); this.name = 'ScaffoldImportError'; }
}
const fail = (code: ScaffoldImportError['code'], message: string): never => { throw new ScaffoldImportError(code, message); };
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
/** Stable key order, including nested objects. Arrays retain their meaningful order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}';
  return JSON.stringify(value);
}
export function hashScaffoldSnapshot(snapshot: Omit<ScaffoldSnapshot, 'hash'> | ScaffoldSnapshot): string {
  const { schemaVersion, root, entries, ignoredRoots, limits } = snapshot;
  // Opaque directories are outside coverage: their changing contents must not
  // invalidate the visible snapshot, but identity and the opaque boundary remain bound.
  const covered = entries.map(entry => entry.kind === 'directory' && entry.opaqueReason !== null
    ? { ...entry, size: 0, mtimeNs: 'opaque' } : entry);
  return sha(canonical({ schemaVersion, root, entries: covered, ignoredRoots, limits }));
}
export function limitsFrom(input: Partial<ScaffoldImportLimits> = {}): ScaffoldImportLimits {
  const limits = { ...scaffoldImportLimits, ...input };
  for (const key of Object.keys(scaffoldImportLimits) as (keyof ScaffoldImportLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > scaffoldImportLimits[key]) fail('snapshot_invalid', 'Недопустимые ограничения снимка.');
  }
  if (Object.keys(input).some(key => !(key in scaffoldImportLimits))) fail('snapshot_invalid', 'Неизвестное ограничение снимка.');
  return limits;
}
export const validName = (name: string) => name.length <= 150 && !/[:\\/\u0000-\u001f]/.test(name) && !['.', '..'].includes(name);
export const scaffoldTechnicalNames = new Set(['.git', '.idea', '.vscode', '.fleet', '.cursor', '.claude', '.codex', '.agents', '.bb', '.cache', '.ssh', '.aws', '.azure', '.config', '.local', '.gnupg', '.npm', '.yarn', '.pnpm-store', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.tox', '.gradle', '.venv', '.next', '.nuxt', '.turbo', '.DS_Store', '.gitignore', '.gitattributes', '.gitmodules', '.editorconfig', '.mcp.json', '.npmrc', '.yarnrc', '.yarnrc.yml', 'AGENTS.md', 'CLAUDE.md', 'node_modules', 'dist', 'build', 'coverage', '__pycache__', 'venv', 'target', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'uv.lock', 'poetry.lock']);
export function snapshotEntryBoundary(path: string, kind: SnapshotKind): string | null {
  const name = path.split('/').at(-1)!;
  if (kind === 'symlink') return 'symlink';
  if (kind === 'other') return 'special';
  if (!validName(name)) return 'unsupported_name';
  if (name === '_private') return 'private';
  if (kind === 'directory' && (scaffoldTechnicalNames.has(name) || /^\.svaib\/(usage|cache)(\/|$)/.test(path))) return 'excluded';
  if (scaffoldTechnicalNames.has(name)) return 'excluded';
  if (/^\.env(?:\.|$)/i.test(name) || (kind === 'file' && /^\.svaib\//.test(path))) return 'sensitive';
  return null;
}

function parseConfig(input: unknown): ScaffoldTreeConfig {
  const parsed = scaffoldConfigSchema.safeParse(input);
  if (parsed.success && parsed.data.schemaVersion === 2) return parsed.data;
  return fail('invalid_config', 'Нужен действующий проект дерева Screen v2.');
}
const itemId = (path: string) => 'import-' + sha(path).slice(0, 24);
// These names have a canonical purpose independent of kit completeness.
// Business units and nonstandard aspects still require evidence from their README.
function canonicalRole(path: string, kind: SnapshotKind): ScaffoldRoleEvidence | undefined {
  const name = path.split('/').at(-1)!;
  if (kind === 'directory' && ['_inbox', '_private', 'meetings', 'zz_archive', '.svaib'].includes(name))
    return { role: 'infrastructure', source: 'Канон служебных папок scaffold.' };
  if (kind === 'file' && name === 'README.md')
    return { role: 'infrastructure', source: 'Карта папки по канону README.' };
  if (kind === 'file' && path === '00_ceo/01_profile.md')
    return { role: 'workspace', source: 'Профиль CEO: отдельный документ, не элемент management kit.' };
  if (/^0[1-5]_(overview|active|backlog|progress|decisions)(\.md)?$/.test(name)) {
    const names = ['01_overview', '02_active', '03_backlog', '04_progress', '05_decisions'];
    if (names.includes(name.replace(/\.md$/, '')))
      return { role: 'kit', source: 'Канон management kit: миссия сохраняется в форме файла и папки.' };
  }
  if (path === '01_company' && kind === 'directory') return { role: 'unit', source: 'Компания: обязательный узел пространства.' };
  return undefined;
}
function configFrom(snapshot: ScaffoldSnapshot, companyName: string, roles: Record<string, ScaffoldRoleEvidence>): ScaffoldTreeConfig {
  const root: ScaffoldTreeConfig['tree'][number] = { id: 'root', parentId: null, name: snapshot.root.realPath.replaceAll('\\', '/').split('/').at(-1) || 'пространство', type: 'folder', note: 'Фактический каркас; содержимое файлов не передаётся.', role: 'root', locked: true, fixedName: false, placeholder: false, proposed: false, acceptsBlocks: false, projectContainer: false, clientContainer: false, template: null, screenKind: null };
  const tree = [root]; const visible = new Set(['']); const protectedParents = new Set<string>();
  // Entries the editor cannot represent still protect their visible parent.
  const hiddenParents = new Set(snapshot.entries.filter(entry => !['file', 'directory'].includes(entry.kind) || !validName(entry.path.split('/').at(-1)!)).map(entry => entry.path.split('/').slice(0, -1).join('/')));
  for (const entry of snapshot.entries) {
    const parts = entry.path.split('/'); const name = parts.pop()!; const parent = parts.join('/');
    // Symlinks and unsupported names are preserved in the snapshot, not disguised
    // as ordinary writable files in the editor.
    if (!visible.has(parent) || !validName(name) || !['file', 'directory'].includes(entry.kind)) continue;
    const folder = entry.kind === 'directory';
    const evidence = canonicalRole(entry.path, entry.kind) ?? (Object.hasOwn(roles, entry.path) ? roles[entry.path] : undefined);
    const role = evidence?.role ?? (folder && entry.path === '01_company' ? 'unit' : 'root');
    const unit = folder && role === 'unit';
    const locked = entry.opaqueReason !== null || protectedParents.has(parent) || (folder && hiddenParents.has(entry.path));
    const note = [locked ? 'Сохранить без раскрытия и автоматических изменений.' : '', evidence ? `Основание: ${evidence.source}` : role === 'root' ? 'Роль не определена; требуется разбор.' : 'Компания: обязательный узел пространства.'].filter(Boolean).join(' ');
    tree.push({ ...root, id: itemId(entry.path), parentId: parent ? itemId(parent) : 'root', name, type: folder ? 'folder' : 'file', note, role, locked, acceptsBlocks: unit && !locked, projectContainer: false, screenKind: unit ? entry.path === '00_ceo' ? 'ceo' : 'unit' : null });
    if (folder) { visible.add(entry.path); if (locked) protectedParents.add(entry.path); }
  }
  // Template provenance is deliberately null: filename similarity does not
  // prove that an existing specialized file is a shipped template.
  return parseConfig({ schemaVersion: 2, catalogVersion: scaffoldCatalog.version, canonSnapshot: scaffoldCatalog.canonSnapshot, companyName, tree });
}
/** Portable, bounded data contract. Filesystem readers remain host adapters. */
const relativePath = z.string().min(1).max(2000).refine(path => !path.startsWith('/') && !path.split('/').some(part => !part || part === '.' || part === '..'));
export const scaffoldSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  root: z.object({realPath: z.string().min(1).max(4000), device: z.string(), inode: z.string()}).strict(),
  entries: z.array(z.object({
    path: relativePath, kind: z.enum(['file', 'directory', 'symlink', 'other']), device: z.string(), inode: z.string(),
    size: z.number().int().nonnegative(), mtimeNs: z.string(), sha256: z.string().nullable(), childrenHash: z.string().nullable(), opaqueReason: z.string().nullable(),
  }).strict()).max(scaffoldImportLimits.maxEntries),
  ignoredRoots: z.array(relativePath).max(scaffoldImportLimits.maxEntries),
  limits: z.object({maxEntries: z.number().int().min(1).max(scaffoldImportLimits.maxEntries), maxDepth: z.number().int().min(1).max(scaffoldImportLimits.maxDepth),
    maxFileBytes: z.number().int().min(1).max(scaffoldImportLimits.maxFileBytes), maxTotalBytes: z.number().int().min(1).max(scaffoldImportLimits.maxTotalBytes)}).strict(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict().superRefine((snapshot, ctx) => {
  const paths = new Set<string>();
  for (const entry of snapshot.entries) {
    if (paths.has(entry.path)) ctx.addIssue({code: 'custom', message: 'Duplicate snapshot path'});
    paths.add(entry.path);
  }
  for (const entry of snapshot.entries) {
    const parent = entry.path.split('/').slice(0, -1).join('/');
    if (parent && !snapshot.entries.some(item => item.path === parent && item.kind === 'directory' && item.opaqueReason === null))
      ctx.addIssue({code: 'custom', message: 'Snapshot parent is missing or opaque'});
  }
});

export type ScaffoldOverviewOptions = { companyName: string; roles?: Record<string, ScaffoldRoleEvidence>; previousConfig?: ScaffoldTreeConfig; allowDepthBoundary?: boolean };
/** Same classification for every harness; consumes data, never chooses or reads a local root. */
export function buildScaffoldOverview(snapshot: ScaffoldSnapshot, options: ScaffoldOverviewOptions): ScaffoldTreeConfig {
  assertScaffoldSnapshot(snapshot);
  const roles = { ...options.roles };
  const entries = new Set(snapshot.entries.map(entry => entry.path));
  if (options.previousConfig) {
    const nodes = new Map(options.previousConfig.tree.map(node => [node.id, node]));
    for (const node of nodes.values()) {
      if (node.role === 'root' || (!node.note.includes('Основание: ') && node.note !== 'Роль указана человеком.')) continue;
      const parts = []; let cursor = node;
      while (cursor.parentId) { parts.unshift(cursor.name); cursor = nodes.get(cursor.parentId)!; }
      const path = parts.join('/');
      if (entries.has(path) && !Object.hasOwn(roles, path)) roles[path] = { role: node.role, source: node.note.includes('Основание: ') ? node.note.split('Основание: ')[1] : node.note };
    }
  }
  for (const [path, evidence] of Object.entries(roles)) {
    if (!entries.has(path) || !evidence || !['unit', 'aspect', 'kit', 'infrastructure', 'workspace'].includes(evidence.role) || typeof evidence.source !== 'string' || !evidence.source.trim() || evidence.source.length > 800)
      fail('invalid_config', 'Роль должна относиться к найденному пути и иметь основание.');
  }
  const baseConfig = configFrom(snapshot, options.companyName, roles);
  const scaffoldConfig = options.allowDepthBoundary ? parseConfig({ ...baseConfig, overview: {
    sourceHash: snapshot.hash, maxDepth: snapshot.limits.maxDepth, omittedBranches: snapshot.ignoredRoots.length,
    omittedItems: snapshot.entries.filter(entry => entry.opaqueReason !== null).length,
    reservedPaths: snapshot.entries.filter(entry => !['file', 'directory'].includes(entry.kind) || !validName(entry.path.split('/').at(-1)!)).map(entry => entry.path),
  } }) : baseConfig;
  if (Buffer.byteLength(JSON.stringify(scaffoldConfig)) > maxScaffoldConfigBytes) fail('too_large', 'Дерево каркаса слишком велико для одного Screen.');
  return scaffoldConfig;
}
export function assertScaffoldSnapshot(snapshot: ScaffoldSnapshot) {
  if (!scaffoldSnapshotSchema.safeParse(snapshot).success) fail('snapshot_invalid', 'Сохранённый снимок повреждён. Повторите импорт.');
  if (snapshot.schemaVersion !== 1 || snapshot.hash !== hashScaffoldSnapshot(snapshot) || Buffer.byteLength(JSON.stringify(snapshot)) > maxScaffoldSnapshotBytes) fail('snapshot_invalid', 'Сохранённый снимок повреждён. Повторите импорт.');
  limitsFrom(snapshot.limits);
}
export type ScaffoldDiff = {
  snapshotHash: string; configHash: string;
  added: { path: string; kind: 'file' | 'directory'; template: string | null }[];
  retained: { path: string; kind: SnapshotKind }[];
  removed: { path: string; kind: SnapshotKind; disposition: 'preserve' }[];
  typeChanges: { path: string; from: SnapshotKind; to: 'file' | 'directory'; disposition: 'requires_explicit_approval' }[];
  moves: { from: string; to: string; kind: SnapshotKind; disposition: 'requires_explicit_approval' }[];
  blocked: { path: string; reason: string }[];
  preserved: { path: string; reason: string }[];
  hasDestructiveIntent: boolean;
};
/** Structural intent only. No file bytes, deletion permission, or implicit
 * rename by similar names/content. Imported IDs can identify an intended move. */
export function diffScaffold(snapshot: ScaffoldSnapshot, confirmedConfig: unknown): ScaffoldDiff {
  assertScaffoldSnapshot(snapshot); const config = parseConfig(confirmedConfig);
  const nodes = new Map(config.tree.map(node => [node.id, node]));
  const paths = new Map<string, string>();
  function pathFor(id: string): string { if (paths.has(id)) return paths.get(id)!; const node = nodes.get(id)!; const path = node.parentId ? [pathFor(node.parentId), node.name].filter(Boolean).join('/') : ''; paths.set(id, path); return path; }
  const intended = config.tree.filter(node => node.parentId).map(node => ({ path: pathFor(node.id), kind: node.type === 'folder' ? 'directory' as const : 'file' as const, template: node.template, id: node.id }));
  const before = new Map(snapshot.entries.map(entry => [entry.path, entry])); const after = new Map(intended.map(entry => [entry.path, entry]));
  const result: ScaffoldDiff = { snapshotHash: snapshot.hash, configHash: sha(canonical(config)), added: [], retained: [], removed: [], typeChanges: [], moves: [], blocked: [], preserved: [], hasDestructiveIntent: false };
  for (const entry of snapshot.entries) {
    const next = after.get(entry.path);
    if (entry.opaqueReason) result.preserved.push({ path: entry.path, reason: entry.opaqueReason });
    if (!next) { if (!entry.opaqueReason) result.removed.push({ path: entry.path, kind: entry.kind, disposition: 'preserve' }); }
    else if (entry.kind !== next.kind) result.typeChanges.push({ path: entry.path, from: entry.kind, to: next.kind, disposition: 'requires_explicit_approval' });
    else result.retained.push({ path: entry.path, kind: entry.kind });
    const moved = intended.find(node => node.id === itemId(entry.path));
    if (moved && moved.path !== entry.path) {
      result.moves.push({ from: entry.path, to: moved.path, kind: entry.kind, disposition: 'requires_explicit_approval' });
      if (entry.opaqueReason) result.blocked.push({ path: moved.path, reason: entry.opaqueReason });
    }
  }
  for (const node of intended) {
    if (!before.has(node.path)) result.added.push({ path: node.path, kind: node.kind, template: node.template });
    const barrier = snapshot.entries.find(entry => entry.opaqueReason !== null && (node.path === entry.path || node.path.startsWith(entry.path + '/')));
    if (barrier && (node.path !== barrier.path || node.kind !== barrier.kind || node.id !== itemId(barrier.path) || node.template !== null)) result.blocked.push({ path: node.path, reason: barrier.opaqueReason! });
  }
  // A hidden item must not disappear or move indirectly with an ancestor.
  for (const entry of snapshot.entries.filter(item => item.opaqueReason !== null)) {
    const parts = entry.path.split('/');
    const representable = ['file', 'directory'].includes(entry.kind) && validName(parts.at(-1)!);
    for (let length = 1; length <= parts.length; length++) {
      if (length === parts.length && !representable) break;
      const path = parts.slice(0, length).join('/');
      const node = intended.find(item => item.id === itemId(path));
      const expected = before.get(path);
      if (!node || node.path !== path || node.kind !== expected?.kind) {
        if (!result.blocked.some(item => item.path === path && item.reason === entry.opaqueReason))
          result.blocked.push({ path, reason: entry.opaqueReason! });
      }
    }
  }
  result.hasDestructiveIntent = result.removed.length > 0 || result.typeChanges.length > 0 || result.moves.length > 0;
  return result;
}
