import { lstat, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { BbPluginApi, PluginAgentToolContext } from '@get-bb/plugin-sdk';
import { FOLDER_INTERACTION } from './folder-contract';

export { FOLDER_INTERACTION, FOLDER_TOOL } from './folder-contract';
const selectionSchema = z.object({ hostId: z.string().min(1), path: z.string().min(1).max(4096) }).strict();
const checkedSelectionSchema = selectionSchema.extend({ sourceEnvironmentId: z.string().min(1), sourceProviderId: z.string().min(1),
  device: z.string().regex(/^\d+$/), inode: z.string().regex(/^[1-9]\d*$/) }).strict();
export type SelectedFolder = z.infer<typeof checkedSelectionSchema>;

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

type Api = Pick<BbPluginApi, 'sdk' | 'ui' | 'server'>;
type Result = { status: 'cancelled' } | ({ status: 'selected' } & SelectedFolder);
type Options = { systemExclusions?: readonly string[] };
type Fence = (ctx: PluginAgentToolContext) => Promise<void>;
type FolderEnvironment = { hostId: string; path: string | null; managed: boolean; isWorktree: boolean; workspaceProvisionType: string | null };
type FolderInventory = {
  system: { config(): Promise<{ primaryHostId: string | null; dataDir: string }> };
  environments: { list(args: { hostId: string; limit: number; offset: number; status?: 'destroyed' }): Promise<FolderEnvironment[]> };
};

/** The same conservative boundary is used by the picker and every Screen resolve. */
export async function persistentFolderExclusions(sdk: FolderInventory,
  hostId: string, env: FolderEnvironment, options?: Options): Promise<string[]> {
  const system = await sdk.system.config();
  if (!system.primaryHostId || system.primaryHostId !== hostId || typeof system.dataDir !== 'string' || !isAbsolute(system.dataDir))
    throw new Error('Не удалось проверить расположение BB.');
  const paths = [...(options?.systemExclusions ?? [system.dataDir, join(homedir(), '.bb'), tmpdir(),
    ...(process.platform === 'win32' ? [] : ['/tmp', '/var/tmp'])])];
  const addManaged = (other: typeof env) => {
    if (other.hostId !== hostId || typeof other.managed !== 'boolean' || typeof other.isWorktree !== 'boolean' ||
        ![null, 'unmanaged', 'personal', 'managed-worktree'].includes(other.workspaceProvisionType))
      throw new Error('Не удалось проверить служебные папки BB.');
    if (!other.managed && !other.isWorktree && other.workspaceProvisionType === 'unmanaged') return;
    if (!other.path || !isAbsolute(other.path)) throw new Error('Не удалось проверить служебные папки BB.');
    paths.push(other.path);
  };
  addManaged(env);
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
async function folderIdentity(path: string) {
  const entry = await lstat(path, { bigint: true });
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.ino === 0n) throw new Error('Не удалось надёжно проверить папку.');
  return { device: entry.dev.toString(), inode: entry.ino.toString() };
}

/**
 * Recheck a server-held result immediately before attaching it to a project.
 * Never accept an arbitrary agent-provided path as proof of the user's choice.
 * Path checks are observations, not an atomic filesystem lock.
 */
export async function revalidateSelectedFolder(bb: Pick<Api, 'sdk' | 'server'>, ctx: PluginAgentToolContext,
  selection: SelectedFolder, stillCurrent: Fence, options?: Options): Promise<SelectedFolder> {
  const selected = checkedSelectionSchema.parse(selection);
  await stillCurrent(ctx); ctx.signal.throwIfAborted();
  const readScope = async () => {
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
    if (thread.id !== ctx.threadId || thread.deletedAt || thread.projectId !== ctx.projectId ||
        thread.environmentId !== selected.sourceEnvironmentId || thread.providerId !== selected.sourceProviderId)
      throw new Error('Рабочее место изменилось. Выбери папку заново.');
    const [env, system] = await Promise.all([
      bb.sdk.environments.get({ environmentId: selected.sourceEnvironmentId }), bb.sdk.system.config(),
    ]);
    if (env.id !== selected.sourceEnvironmentId || env.status !== 'ready' || env.hostId !== selected.hostId ||
        system.primaryHostId !== selected.hostId) throw new Error('Рабочее место изменилось. Выбери папку заново.');
    return env;
  };
  const exclusions = async (env: Awaited<ReturnType<Api['sdk']['environments']['get']>>) => {
    const paths = await persistentFolderExclusions(bb.sdk, env.hostId, env, options);
    if (!options?.systemExclusions) paths.push(bb.server.experimental_dataDir);
    return paths;
  };
  let env = await readScope();
  await validateFolderPath(selected.path, await exclusions(env));
  if (JSON.stringify(await folderIdentity(selected.path)) !== JSON.stringify({ device: selected.device, inode: selected.inode }))
    throw new Error('Папка изменилась. Выбери её заново.');
  await stillCurrent(ctx); ctx.signal.throwIfAborted();
  env = await readScope();
  await validateFolderPath(selected.path, await exclusions(env));
  if (JSON.stringify(await folderIdentity(selected.path)) !== JSON.stringify({ device: selected.device, inode: selected.inode }))
    throw new Error('Папка изменилась. Выбери её заново.');
  await stillCurrent(ctx); ctx.signal.throwIfAborted();
  return selected;
}

/**
 * Collect a user choice only. Callers must revalidate before creating a project
 * and bind/reverify the resulting thread; a checked pathname is not a file handle.
 * `stillCurrent` must fence the owning flow and account epoch, not just the UI.
 */
export function createFolderSelection(bb: Api, stillCurrent: Fence, options?: Options) {
  const pending = new Map<string, { projectId: string; operation: Promise<Result> }>();
  return async (ctx: PluginAgentToolContext): Promise<Result> => {
    const existing = pending.get(ctx.threadId);
    if (existing) {
      ctx.signal.throwIfAborted();
      if (ctx.projectId !== existing.projectId) throw new Error('Разговор изменился. Открой выбор папки заново.');
      return existing.operation;
    }
    const operation = (async (): Promise<Result> => {
      await stillCurrent(ctx); ctx.signal.throwIfAborted();
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      if (thread.id !== ctx.threadId || thread.deletedAt || thread.projectId !== ctx.projectId || !thread.environmentId) throw new Error('Разговор изменился. Открой выбор папки заново.');
      const env = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      const system = await bb.sdk.system.config();
      if (env.id !== thread.environmentId || env.status !== 'ready' || !env.hostId || env.hostId !== system.primaryHostId) throw new Error('Выбор папки доступен только на основном компьютере BB.');
      const host = await bb.sdk.hosts.get({ hostId: env.hostId });
      await stillCurrent(ctx); ctx.signal.throwIfAborted();
      const answer = await bb.ui.requestInput({ threadId: ctx.threadId, rendererId: FOLDER_INTERACTION,
        title: 'Выбери папку компании', payload: { hostId: env.hostId, hostName: host.name } }, { signal: ctx.signal });
      if (answer.outcome === 'cancelled') return { status: 'cancelled' };
      const selected = selectionSchema.parse(answer.value);
      if (selected.hostId !== env.hostId) throw new Error('Компьютер изменился. Выбери папку заново.');
      const identity = await folderIdentity(selected.path);
      const checked = await revalidateSelectedFolder(bb, ctx, { ...selected, sourceEnvironmentId: env.id,
        sourceProviderId: thread.providerId, ...identity }, stillCurrent, options);
      return { status: 'selected', ...checked };
    })();
    pending.set(ctx.threadId, { projectId: ctx.projectId, operation });
    try { return await operation; } finally { if (pending.get(ctx.threadId)?.operation === operation) pending.delete(ctx.threadId); }
  };
}
