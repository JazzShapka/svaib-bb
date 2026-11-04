import type { PluginAgentToolContext, PluginBbSdk } from '@get-bb/plugin-sdk';
import { CommittedOpenError, type ConnectFlowView, type SelectedFolderInput, type SelectionFence } from './connect-flow';
import { persistentFolderExclusions, validateFolderPath, type FolderEnvironment } from './folder-selection';

export type CompanyFolderResult = { status: 'opened' | 'open-failed'; threadId: string };
type Project = Awaited<ReturnType<PluginBbSdk['projects']['get']>>;
type Thread = Awaited<ReturnType<PluginBbSdk['threads']['get']>>;
type Environment = Awaited<ReturnType<PluginBbSdk['environments']['get']>>;
type Target = { thread: Thread; environment: Environment; project: Project; path: string; providerId: 'codex' | 'claude-code' };

export type CompanyFolderDependencies = {
  sdk: PluginBbSdk;
  pluginId: string;
  serverDataDir: string;
  connection: {
    view(): Promise<ConnectFlowView>;
    connectSelectedFolder(input: SelectedFolderInput, fence: SelectionFence): Promise<{ threadId: string; environmentId: string; stage: 'verify' }>;
  };
  /** Test seam; production also excludes BB-owned, managed and temporary trees. */
  validatePath?(hostId: string, env: FolderEnvironment, path: string): Promise<string>;
};

function exactProject(project: Project, hostId: string, path: string): boolean {
  const selected = project.sources.filter(source => source.hostId === hostId && source.path === path);
  const defaults = project.sources.filter(source => source.isDefault);
  return project.kind === 'standard' && selected.length === 1 && selected[0].isDefault &&
    selected[0].type === 'local_path' && selected[0].projectId === project.id && defaults.length === 1;
}

/** Continue from a folder the person selected in BB's ordinary New Thread UI. */
export function createCompanyFolderFlow(d: CompanyFolderDependencies) {
  let pending: { threadId: string; projectId: string; operation: Promise<CompanyFolderResult> } | null = null;

  const validatePath = async (hostId: string, env: FolderEnvironment, path: string) => {
    if (d.validatePath) return d.validatePath(hostId, env, path);
    const exclusions = await persistentFolderExclusions(d.sdk, hostId, env);
    exclusions.push(d.serverDataDir);
    return validateFolderPath(path, exclusions);
  };

  const loadTarget = async (ctx: PluginAgentToolContext): Promise<Target> => {
    ctx.signal.throwIfAborted();
    const thread = await d.sdk.threads.get({ threadId: ctx.threadId });
    if (thread.id !== ctx.threadId || thread.projectId !== ctx.projectId || thread.deletedAt || thread.archivedAt ||
        thread.originPluginId || thread.originKind || !thread.environmentId || !['codex', 'claude-code'].includes(thread.providerId))
      throw new Error('Продолжение доступно в обычном новом разговоре BB после выбора папки.');
    const environment = await d.sdk.environments.get({ environmentId: thread.environmentId });
    const system = await d.sdk.system.config();
    if (environment.id !== thread.environmentId || environment.projectId !== thread.projectId || environment.status !== 'ready' ||
        environment.workspaceProvisionType !== 'unmanaged' || !environment.path || !system.primaryHostId || environment.hostId !== system.primaryHostId)
      throw new Error('Сначала выбери постоянную папку через No project → New project или существующий проект и оставь Project checkout. Временная папка не подходит.');
    const path = await validatePath(environment.hostId, environment, environment.path);
    const project = await d.sdk.projects.get({ projectId: thread.projectId });
    if (!exactProject(project, environment.hostId, path)) throw new Error('Папка должна быть единственным основным локальным источником выбранного проекта BB.');
    ctx.signal.throwIfAborted();
    return { thread, environment, project, path, providerId: thread.providerId as Target['providerId'] };
  };

  const matchContinuation = async (view: ConnectFlowView, target: Target) => {
    if (!['verify', 'ready'].includes(view.stage) || !view.threadId || !view.binding) return null;
    if (view.binding.projectId !== target.project.id || view.binding.hostId !== target.environment.hostId ||
        view.binding.providerId !== target.providerId) {
      if (view.stage === 'verify') throw new Error('BB уже проверяет другое рабочее место. Дождись завершения.');
      return null;
    }
    const [thread, environment] = await Promise.all([
      d.sdk.threads.get({ threadId: view.threadId }), d.sdk.environments.get({ environmentId: view.binding.environmentId }),
    ]);
    if (thread.id !== view.threadId || thread.deletedAt || thread.originPluginId !== d.pluginId || thread.originKind !== null ||
        thread.projectId !== view.binding.projectId || thread.environmentId !== view.binding.environmentId || thread.providerId !== view.binding.providerId ||
        environment.id !== view.binding.environmentId || environment.projectId !== target.project.id || environment.hostId !== target.environment.hostId ||
        environment.status !== 'ready' || environment.workspaceProvisionType !== 'unmanaged' || environment.path !== target.path)
      throw new Error('Сохранённое продолжение не совпадает с выбранной папкой.');
    return { thread, environment };
  };

  const openExisting = async (threadId: string): Promise<CompanyFolderResult> => {
    try { await d.sdk.threads.open({ threadId, file: null }); }
    catch { return { status: 'open-failed', threadId }; }
    return { status: 'opened', threadId };
  };

  return async (ctx: PluginAgentToolContext): Promise<CompanyFolderResult> => {
    ctx.signal.throwIfAborted();
    if (pending) {
      if (pending.threadId !== ctx.threadId || pending.projectId !== ctx.projectId) throw new Error('Продолжение уже запущено в другом разговоре.');
      return pending.operation;
    }
    const operation = (async (): Promise<CompanyFolderResult> => {
      const target = await loadTarget(ctx);
      const initial = await d.connection.view();
      const existing = await matchContinuation(initial, target);
      if (existing) return openExisting(existing.thread.id);
      if (initial.stage !== 'ready') throw new Error('Сначала заверши текущее подключение svaib.');
      const fence: SelectionFence = async () => { await loadTarget(ctx); };
      let handoff: { threadId: string; environmentId: string; stage: 'verify' };
      try {
        handoff = await d.connection.connectSelectedFolder({ projectId: target.project.id, hostId: target.environment.hostId,
          path: target.path, providerId: target.providerId, sourceThreadId: null, stepId: 'space' }, fence);
      } catch (error) {
        if (error instanceof CommittedOpenError) {
          const current = await d.connection.view();
          const committed = await matchContinuation(current, target);
          if (committed?.thread.id === error.threadId) return { status: 'open-failed', threadId: error.threadId };
        }
        throw error;
      }
      // The handoff has already opened its verified successor. A late abort of
      // this manual chat must not reopen or undo that committed transition.
      const current = await d.connection.view();
      const committed = await matchContinuation(current, target);
      if (!committed || committed.thread.id !== handoff.threadId || committed.environment.id !== handoff.environmentId)
        throw new Error('BB не подтвердил продолжение в выбранной папке.');
      return { status: 'opened', threadId: handoff.threadId };
    })();
    pending = { threadId: ctx.threadId, projectId: ctx.projectId, operation };
    try { return await operation; } finally { if (pending?.operation === operation) pending = null; }
  };
}
