// Backend only. The root caller supplies the freshly resolved native pin; UI JSON
// and a persisted snapshot are never authority to choose a filesystem root.
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { BigIntStats } from 'node:fs';
import { scaffoldCatalog, scaffoldConfigSchema, type AnyScaffoldConfig } from 'bb-plugin-svaib-screen-pilot/scaffold';

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
function canonical(value: unknown): string {
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
function limitsFrom(input: Partial<ScaffoldImportLimits> = {}): ScaffoldImportLimits {
  const limits = { ...scaffoldImportLimits, ...input };
  for (const key of Object.keys(scaffoldImportLimits) as (keyof ScaffoldImportLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > scaffoldImportLimits[key]) fail('snapshot_invalid', 'Недопустимые ограничения снимка.');
  }
  if (Object.keys(input).some(key => !(key in scaffoldImportLimits))) fail('snapshot_invalid', 'Неизвестное ограничение снимка.');
  return limits;
}
const kindOf = (s: BigIntStats): SnapshotKind => s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSymbolicLink() ? 'symlink' : 'other';
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
async function openRoot(path: string): Promise<FileHandle> {
  let handle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const segment of path.split('/').filter(Boolean)) {
      const child = await open(`/proc/self/fd/${handle.fd}/${segment}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await handle.close(); handle = child;
    }
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
const validName = (name: string) => name.length <= 150 && !/[:\\/\u0000-\u001f]/.test(name) && !['.', '..'].includes(name);
const excluded = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '__pycache__', 'venv', 'target']);
function opaque(path: string, kind: SnapshotKind): string | null {
  const name = path.split('/').at(-1)!;
  if (kind === 'symlink') return 'symlink';
  if (kind === 'other') return 'special';
  if (!validName(name)) return 'unsupported_name';
  if (name === '_private') return 'private';
  if (kind === 'directory' && (excluded.has(name) || (name.startsWith('.') && name !== '.svaib') || /^\.svaib\/(usage|cache)(\/|$)/.test(path))) return 'excluded';
  if (kind === 'file' && (name.startsWith('.') || /^\.svaib\//.test(path))) return 'sensitive';
  return null;
}

/** Linux fd-relative traversal: a swapped directory path cannot redirect reads
 * outside the opened root. No symlink target or private/build content is read. */
async function readSnapshot(pinnedRoot: string, limits: ScaffoldImportLimits, signal?: AbortSignal, allowDepthBoundary = false): Promise<ScaffoldSnapshot> {
  signal?.throwIfAborted();
  if (process.platform !== 'linux') fail('importer_unavailable', 'Для безопасного чтения каркаса нужен поддерживаемый локальный файловый адаптер.');
  if (!isAbsolute(pinnedRoot) || resolve(pinnedRoot) !== pinnedRoot) fail('invalid_root', 'Нужен фактический корень из native-привязки.');
  let root: FileHandle;
  try {
    if (await realpath(pinnedRoot) !== pinnedRoot) fail('invalid_root', 'Корень изменился; повторите проверку рабочего места.');
    root = await openRoot(pinnedRoot);
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ScaffoldImportError) throw error;
    return fail('invalid_root', 'Фактический корень недоступен. Проверьте рабочее место.');
  }
  try {
    const rootStat = await root.stat({ bigint: true });
    const entries: SnapshotEntry[] = []; let totalBytes = 0;
    async function walk(directory: FileHandle, prefix: string, depth: number) {
      signal?.throwIfAborted();
      const beforeDirectory = await directory.stat({ bigint: true });
      const directoryPath = `/proc/self/fd/${directory.fd}`;
      const names: string[] = [];
      for await (const child of await opendir(directoryPath)) {
        signal?.throwIfAborted(); names.push(child.name);
        if (entries.length + names.length > limits.maxEntries) fail('too_large', 'Каркас содержит слишком много элементов для одного Screen. Выберите меньший согласованный корень.');
      }
      names.sort();
      const children: [string, SnapshotKind][] = [];
      for (const name of names) {
        signal?.throwIfAborted();
        const path = prefix ? `${prefix}/${name}` : name; const filePath = `${directoryPath}/${name}`;
        const before = await lstat(filePath, { bigint: true }); const kind = kindOf(before); children.push([name, kind]);
        const entry: SnapshotEntry = { path, kind, device: String(before.dev), inode: String(before.ino), size: Number(before.size), mtimeNs: String(before.mtimeNs), sha256: null, childrenHash: null, opaqueReason: opaque(path, kind) };
        if (!Number.isSafeInteger(entry.size)) fail('too_large', 'Размер элемента не поддерживается.');
        if (kind === 'file' && before.size > BigInt(limits.maxFileBytes)) entry.opaqueReason ??= 'file_size';
        entries.push(entry);
        if (entries.length > limits.maxEntries) fail('too_large', 'Каркас содержит слишком много элементов для одного Screen.');
        if (entry.opaqueReason) continue;
        if (kind === 'directory') {
          if (depth >= limits.maxDepth) {
            if (!allowDepthBoundary) fail('too_large', 'Каркас слишком глубоко вложен для одного Screen.');
            entry.opaqueReason = 'depth_limit';
            continue;
          }
          const child = await open(filePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try {
            if (!same(before, await child.stat({ bigint: true }))) fail('snapshot_changed', 'Папка изменилась во время чтения. Повторите импорт.');
            // Native context uses the nearest .svaib boundary. A child workspace
            // is not evidence of rights to import its contents for this company.
            let boundary = false;
            try { await lstat(`/proc/self/fd/${child.fd}/.svaib`); boundary = true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            if (boundary) entry.opaqueReason = 'workspace_boundary';
            else entry.childrenHash = await walk(child, path, depth + 1);
          } finally { await child.close(); }
        } else if (kind === 'file') {
          const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const opened = await file.stat({ bigint: true });
            if (!opened.isFile() || !same(before, opened)) fail('snapshot_changed', 'Файл изменился во время чтения. Повторите импорт.');
            const digest = createHash('sha256'); const buffer = Buffer.alloc(Math.min(limits.maxFileBytes + 1, 64 * 1024)); let size = 0;
            for (;;) {
              signal?.throwIfAborted();
              const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, limits.maxFileBytes + 1 - size), null);
              if (!bytesRead) break;
              size += bytesRead; totalBytes += bytesRead;
              if (size > limits.maxFileBytes || totalBytes > limits.maxTotalBytes) fail('too_large', 'Превышен объём безопасного снимка каркаса.');
              digest.update(buffer.subarray(0, bytesRead));
            }
            if (BigInt(size) !== opened.size || !same(opened, await file.stat({ bigint: true }))) fail('snapshot_changed', 'Файл изменился во время чтения. Повторите импорт.');
            entry.sha256 = digest.digest('hex');
          } finally { await file.close(); }
        }
        if (!same(before, await lstat(filePath, { bigint: true }))) fail('snapshot_changed', 'Каркас изменился во время чтения. Повторите импорт.');
      }
      if (!same(beforeDirectory, await directory.stat({ bigint: true }))) fail('snapshot_changed', 'Папка изменилась во время чтения. Повторите импорт.');
      return sha(canonical(children));
    }
    await walk(root, '', 0);
    const afterRoot = await lstat(pinnedRoot, { bigint: true });
    if (!same(rootStat, afterRoot) || await realpath(pinnedRoot) !== pinnedRoot) fail('snapshot_changed', 'Корень изменился во время чтения. Повторите импорт.');
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const value = { schemaVersion: 1 as const, root: { realPath: pinnedRoot, device: String(rootStat.dev), inode: String(rootStat.ino) }, entries, ignoredRoots: entries.filter(e => e.kind === 'directory' && e.opaqueReason !== null).map(e => e.path), limits };
    const snapshot = { ...value, hash: hashScaffoldSnapshot(value) };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > maxScaffoldSnapshotBytes) fail('too_large', 'Снимок каркаса слишком велик для безопасного сохранения.');
    return snapshot;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ScaffoldImportError) throw error;
    throw new ScaffoldImportError('snapshot_changed', 'Не удалось прочитать стабильный снимок. Проверьте доступ и повторите импорт.');
  } finally { await root.close(); }
}
function parseConfig(input: unknown): ScaffoldTreeConfig {
  const parsed = scaffoldConfigSchema.safeParse(input);
  if (parsed.success && parsed.data.schemaVersion === 2) return parsed.data;
  return fail('invalid_config', 'Нужен действующий проект дерева Screen v2.');
}
const itemId = (path: string) => 'import-' + sha(path).slice(0, 24);
function configFrom(snapshot: ScaffoldSnapshot, companyName: string, roles: Record<string, ScaffoldRoleEvidence>): ScaffoldTreeConfig {
  const root: ScaffoldTreeConfig['tree'][number] = { id: 'root', parentId: null, name: 'scaffold', type: 'folder', note: 'Фактический каркас; содержимое файлов не передаётся.', role: 'root', locked: true, fixedName: false, placeholder: false, proposed: false, acceptsBlocks: false, projectContainer: false, clientContainer: false, template: null, screenKind: null };
  const tree = [root]; const visible = new Set(['']); const protectedParents = new Set<string>();
  // Entries the editor cannot represent still protect their visible parent.
  const hiddenParents = new Set(snapshot.entries.filter(entry => !['file', 'directory'].includes(entry.kind) || !validName(entry.path.split('/').at(-1)!)).map(entry => entry.path.split('/').slice(0, -1).join('/')));
  for (const entry of snapshot.entries) {
    const parts = entry.path.split('/'); const name = parts.pop()!; const parent = parts.join('/');
    // Symlinks and unsupported names are preserved in the snapshot, not disguised
    // as ordinary writable files in the editor.
    if (!visible.has(parent) || !validName(name) || !['file', 'directory'].includes(entry.kind)) continue;
    const folder = entry.kind === 'directory';
    const evidence = Object.hasOwn(roles, entry.path) ? roles[entry.path] : undefined;
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
export async function importScaffold(pinnedRoot: string, options: { companyName: string; roles?: Record<string, ScaffoldRoleEvidence>; limits?: Partial<ScaffoldImportLimits>; signal?: AbortSignal; allowDepthBoundary?: boolean }): Promise<{ snapshot: ScaffoldSnapshot; scaffoldConfig: ScaffoldTreeConfig }> {
  const snapshot = await readSnapshot(pinnedRoot, limitsFrom(options.limits), options.signal, options.allowDepthBoundary === true);
  const roles = options.roles ?? {};
  const entries = new Set(snapshot.entries.map(entry => entry.path));
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
  return { snapshot, scaffoldConfig };
}
function assertSnapshot(snapshot: ScaffoldSnapshot) {
  if (snapshot.schemaVersion !== 1 || snapshot.hash !== hashScaffoldSnapshot(snapshot) || Buffer.byteLength(JSON.stringify(snapshot)) > maxScaffoldSnapshotBytes) fail('snapshot_invalid', 'Сохранённый снимок повреждён. Повторите импорт.');
  limitsFrom(snapshot.limits);
}
export async function verifyScaffoldSnapshot(pinnedRoot: string, snapshot: ScaffoldSnapshot, signal?: AbortSignal): Promise<void> {
  assertSnapshot(snapshot);
  if (snapshot.root.realPath !== pinnedRoot) fail('snapshot_changed', 'Рабочий корень изменился. Повторите импорт.');
  const current = await readSnapshot(pinnedRoot, limitsFrom(snapshot.limits), signal, snapshot.entries.some(entry => entry.opaqueReason === 'depth_limit'));
  if (current.hash !== snapshot.hash) fail('snapshot_changed', 'Каркас изменился после снимка. Повторите импорт и согласуйте новый пакет.');
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
  assertSnapshot(snapshot); const config = parseConfig(confirmedConfig);
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
