import type { BbPluginApi, PluginAgentToolContext } from '@get-bb/plugin-sdk';
import { browserContract } from './browser-contract';

export const HOOK_TOOL = 'svaib_codex_hooks';
export function createHookConsent(bb: Pick<BbPluginApi, 'sdk' | 'hosts'>) {
  const host = bb.hosts.experimental_client({ contract: browserContract });
  const active = new Set<string>();
  async function binding(ctx: PluginAgentToolContext) {
    const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
    if (thread.deletedAt || thread.projectId !== ctx.projectId || thread.providerId !== 'codex' || !thread.environmentId)
      throw new Error('Не удалось подтвердить разговор Codex.');
    const [env, system] = await Promise.all([bb.sdk.environments.get({ environmentId: thread.environmentId }), bb.sdk.system.config()]);
    if (!env.path || env.hostId !== system.primaryHostId || env.status !== 'ready') throw new Error('Проверка хуков доступна в локальном рабочем месте.');
    const cli = await bb.sdk.hosts.providerCliStatus({ hostId: env.hostId });
    if (!cli.codex?.installed || !cli.codex.executablePath)
      throw new Error('Не удалось найти Codex в этом рабочем месте.');
    return { threadId: thread.id, projectId: thread.projectId, environmentId: env.id, hostId: env.hostId,
      cwd: env.path, executable: cli.codex.executablePath };
  }
  return async function review(ctx: PluginAgentToolContext) {
    if (active.has(ctx.threadId)) throw new Error('Проверка хуков уже выполняется.');
    active.add(ctx.threadId);
    try {
      ctx.signal.throwIfAborted();
      const initial = await binding(ctx);
      const args = { executable: initial.executable, cwd: initial.cwd };
      const result = await host.call('automaticHooks', args, { hostId: initial.hostId, signal: ctx.signal });
      if (JSON.stringify(await binding(ctx)) !== JSON.stringify(initial)) throw new Error('Рабочее место изменилось во время проверки.');
      return { state: 'trusted' as const, changed: result.changed };
    } finally { active.delete(ctx.threadId); }
  };
}
