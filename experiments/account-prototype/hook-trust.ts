import { createHash } from 'node:crypto';
import { isSvaibHook, SVAIB_PLUGIN_ID } from './hook-bundle';

type Rpc = (method: string, params: Record<string, unknown>) => Promise<any>;
type Hook = { key: string; currentHash: string; trustStatus: string; command: string; statusMessage: string | null; sourcePath: string };
export type HookReview = { hooks: Hook[]; fingerprint: string };

/** The fingerprint covers all svaib hooks, including disabled and already trusted hooks. */
export async function inspectHooks(rpc: Rpc, cwd: string): Promise<HookReview> {
  const result = await rpc('hooks/list', { cwds: [cwd] });
  const scope = result?.data?.find((item: any) => item.cwd === cwd);
  if (!scope || scope.errors?.length || scope.warnings?.length || !Array.isArray(scope.hooks)) throw new Error('Не удалось проверить хуки Codex.');
  const hooks: Hook[] = scope.hooks.filter(isSvaibHook).map((item: any) => {
    if (item.source !== 'plugin' || item.isManaged || typeof item.key !== 'string' || !item.key.startsWith(`${SVAIB_PLUGIN_ID}:`) ||
      !/^sha256:[0-9a-f]{64}\/sha256:[0-9a-f]{64}$/.test(item.currentHash) ||
      !['trusted', 'untrusted', 'modified'].includes(item.trustStatus) || typeof item.command !== 'string' || typeof item.sourcePath !== 'string')
      throw new Error('Состав хуков не удалось подтвердить.');
    return { key: item.key, currentHash: item.currentHash, trustStatus: item.trustStatus,
      command: item.command, statusMessage: item.statusMessage ?? null, sourcePath: item.sourcePath };
  }).sort((a: Hook, b: Hook) => a.key.localeCompare(b.key));
  if (!hooks.length || hooks.length > 128 || new Set(hooks.map(item => item.key)).size !== hooks.length) throw new Error('Хуки svaib не найдены или их состав неоднозначен.');
  const fingerprint = createHash('sha256').update(JSON.stringify(hooks)).digest('hex');
  return { hooks, fingerprint };
}

/** Trust only the unchanged inventory through Codex's own config API. */
export async function approveHooks(rpc: Rpc, cwd: string, fingerprint: string): Promise<HookReview> {
  const config = await rpc('config/read', { includeLayers: true, cwd });
  const user = config?.layers?.filter((layer: any) => layer.name?.type === 'user');
  if (!Array.isArray(user) || user.length !== 1 || typeof user[0].version !== 'string') throw new Error('Не удалось проверить настройки Codex.');
  const review = await inspectHooks(rpc, cwd);
  if (review.fingerprint !== fingerprint) throw new Error('Хуки изменились во время проверки. Повторите её.');
  const pending = review.hooks.filter(item => item.trustStatus !== 'trusted');
  if (!pending.length) return review;
  const edits = pending.map(item => ({ keyPath: `hooks.state.${JSON.stringify(item.key)}`,
    value: { trusted_hash: item.currentHash }, mergeStrategy: 'upsert' }));
  await rpc('config/batchWrite', { edits, expectedVersion: user[0].version, reloadUserConfig: true });
  const after = await inspectHooks(rpc, cwd);
  if (after.hooks.some(item => item.trustStatus !== 'trusted') ||
    JSON.stringify(after.hooks.map(({ key, currentHash }) => ({ key, currentHash }))) !==
    JSON.stringify(review.hooks.map(({ key, currentHash }) => ({ key, currentHash }))))
    throw new Error('Не удалось подтвердить доверие текущим хукам.');
  return after;
}
