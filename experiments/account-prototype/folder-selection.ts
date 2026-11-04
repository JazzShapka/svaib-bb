import { lstat, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

export { FOLDER_TOOL } from './folder-contract';

// True for equality, descendants and ancestors: selecting a parent of BB-owned
// storage would otherwise make that ephemeral tree part of the company folder.
function overlaps(a: string, b: string): boolean {
  const inside = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  return inside(a, b) || inside(b, a);
}

/** Validate an existing local directory without following any symlink component. */
export async function validateFolderPath(path: string, excludedRoots: readonly string[]): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) throw new Error('Выбери обычную существующую папку.');
  const root = parse(path).root;
  let part = root;
  const initial = await lstat(root);
  if (!initial.isDirectory() || initial.isSymbolicLink()) throw new Error('Папку не удалось проверить.');
  const segments = relative(root, path).split(sep).filter(Boolean);
  for (const segment of segments) {
    part = join(part, segment);
    const entry = await lstat(part);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Папка или один из её родителей является ссылкой. Выбери другую папку.');
  }
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error('Путь к папке изменился. Выбери её ещё раз.');
  for (const excluded of excludedRoots) {
    if (!isAbsolute(excluded) || overlaps(canonical, resolve(excluded))) throw new Error('Эта папка принадлежит BB или временному рабочему месту. Выбери постоянную папку.');
  }
  return canonical;
}

type Options = { systemExclusions?: readonly string[] };
export type FolderEnvironment = { hostId: string; path: string | null; managed: boolean; isWorktree: boolean; workspaceProvisionType: string | null };
export type FolderInventory = {
  system: { config(): Promise<{ primaryHostId: string | null; dataDir: string }> };
  environments: { list(args: { hostId: string; limit: number; offset: number; status?: 'destroyed' }): Promise<FolderEnvironment[]> };
};

/** The same conservative boundary is used by the handoff and every Screen resolve. */
export async function persistentFolderExclusions(sdk: FolderInventory,
  hostId: string, env: FolderEnvironment, options?: Options): Promise<string[]> {
  const system = await sdk.system.config();
  if (!system.primaryHostId || system.primaryHostId !== hostId || typeof system.dataDir !== 'string' || !isAbsolute(system.dataDir))
    throw new Error('Не удалось проверить расположение BB.');
  const paths = [...(options?.systemExclusions ?? [system.dataDir, join(homedir(), '.bb'), tmpdir(),
    ...(process.platform === 'win32' ? [] : ['/tmp', '/var/tmp'])])];
  const selectedRoot = env.path && isAbsolute(env.path) ? env.path : null;
  const strictAncestor = (parent: string, child: string) => {
    const rel = relative(parent, child);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  const addManaged = (other: FolderEnvironment, selected = false) => {
    if (other.hostId !== hostId || typeof other.managed !== 'boolean' || typeof other.isWorktree !== 'boolean' ||
        ![null, 'unmanaged', 'personal', 'managed-worktree'].includes(other.workspaceProvisionType))
      throw new Error('Не удалось проверить служебные папки BB.');
    // Older BB records omit the provision type for ordinary user directories.
    if (!other.managed && !other.isWorktree && [null, 'unmanaged'].includes(other.workspaceProvisionType)) return;
    // A persistent parent may contain a BB worktree without becoming temporary itself.
    if (!selected && other.isWorktree && other.path && selectedRoot && strictAncestor(selectedRoot, other.path)) return;
    if (!other.path || !isAbsolute(other.path)) throw new Error('Не удалось проверить служебные папки BB.');
    paths.push(other.path);
  };
  addManaged(env, true);
  for (const status of [undefined, 'destroyed'] as const) {
    for (let offset = 0; ; offset += 100) {
      if (offset >= 1000) throw new Error('Не удалось проверить рабочие места BB.');
      const environments = await sdk.environments.list({ hostId, limit: 100, offset, ...(status ? { status } : {}) });
      for (const other of environments) {
        if (status === 'destroyed' && !other.path) continue;
        addManaged(other);
      }
      if (environments.length < 100) break;
    }
  }
  const canonical: string[] = [];
  for (const path of paths) {
    if (!isAbsolute(path)) throw new Error('Не удалось проверить служебные папки BB.');
    canonical.push(path);
    try { canonical.push(await realpath(path)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return canonical;
}

export async function validatePersistentFolder(sdk: FolderInventory,
  hostId: string, env: FolderEnvironment, path: string, options?: Options): Promise<string> {
  return validateFolderPath(path, await persistentFolderExclusions(sdk, hostId, env, options));
}
