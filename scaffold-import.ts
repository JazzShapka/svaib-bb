// Linux filesystem adapter. The caller supplies the verified root; Screen JSON never chooses it.
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  ScaffoldImportError, hashScaffoldSnapshot, scaffoldImportLimits, maxScaffoldSnapshotBytes,
  canonical, limitsFrom, snapshotEntryBoundary, buildScaffoldOverview, assertScaffoldSnapshot,
  type SnapshotKind, type ScaffoldSnapshot, type SnapshotEntry, type ScaffoldImportLimits,
  type ScaffoldOverviewOptions,
} from 'bb-plugin-svaib-screen-pilot/scaffold-import';
export * from 'bb-plugin-svaib-screen-pilot/scaffold-import';
const fail = (code: ScaffoldImportError['code'], message: string): never => { throw new ScaffoldImportError(code, message); };
const sha = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
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
        const entry: SnapshotEntry = { path, kind, device: String(before.dev), inode: String(before.ino), size: Number(before.size), mtimeNs: String(before.mtimeNs), sha256: null, childrenHash: null, opaqueReason: snapshotEntryBoundary(path, kind) };
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
export async function importScaffold(pinnedRoot: string, options: ScaffoldOverviewOptions & { limits?: Partial<ScaffoldImportLimits>; signal?: AbortSignal }): Promise<{ snapshot: ScaffoldSnapshot; scaffoldConfig: ReturnType<typeof buildScaffoldOverview> }> {
  const snapshot = await readSnapshot(pinnedRoot, limitsFrom(options.limits), options.signal, options.allowDepthBoundary === true);
  return { snapshot, scaffoldConfig: buildScaffoldOverview(snapshot, options) };
}
export async function verifyScaffoldSnapshot(pinnedRoot: string, snapshot: ScaffoldSnapshot, signal?: AbortSignal): Promise<void> {
  assertScaffoldSnapshot(snapshot);
  if (snapshot.root.realPath !== pinnedRoot) fail('snapshot_changed', 'Рабочий корень изменился. Повторите импорт.');
  const current = await readSnapshot(pinnedRoot, limitsFrom(snapshot.limits), signal, snapshot.entries.some(entry => entry.opaqueReason === 'depth_limit'));
  if (current.hash !== snapshot.hash) fail('snapshot_changed', 'Каркас изменился после снимка. Повторите импорт и согласуйте новый пакет.');
}
