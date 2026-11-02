import { basename } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { PluginAgentToolContext, PluginBbSdk } from '@get-bb/plugin-sdk';
import { CommittedOpenError, type ConnectFlowView } from './connect-flow';
import type { SelectedFolder } from './folder-selection';
import type { WorkplaceIdentity } from './workplace-proof';

type Choice = { status: 'cancelled' } | ({ status: 'selected' } & SelectedFolder);
type Project = Awaited<ReturnType<PluginBbSdk['projects']['get']>>;
export type CompanyFolderResult = { status: 'cancelled' } | { status: 'opened' | 'open-failed'; threadId: string };
export type ConnectSelectedFolder = (ctx: PluginAgentToolContext, input: {
  projectId: string; hostId: string; path: string; providerId: 'codex' | 'claude-code'; selection: SelectedFolder;
}, fence: (phase: 'before' | 'after') => Promise<void>) => Promise<{ threadId: string }>;

export type CompanyFolderDependencies = {
  sdk: Pick<PluginBbSdk, 'threads' | 'environments' | 'projects' | 'system'>;
  pluginId: string;
  epoch(): number;
  connection: { view(): Promise<ConnectFlowView>; partnerIdentity(): Promise<{ subject: string | null; threadId: string | null }> };
  choose(ctx: PluginAgentToolContext): Promise<Choice>;
  revalidate(ctx: PluginAgentToolContext, selection: SelectedFolder, fence: (ctx: PluginAgentToolContext) => Promise<void>): Promise<SelectedFolder>;
  /** Test seam; production resolves existing source aliases on the local host. */
  canonicalSourcePath?(path: string): Promise<string>;
  /** Must fence the old flow itself and start a verified-path-only, no-OAuth handoff. */
  connectSelectedFolder: ConnectSelectedFolder;
  rememberOpenFailure?(input: { sourceThreadId: string; sourceProjectId: string; threadId: string; runId: string;
    binding: NonNullable<ConnectFlowView['binding']>; subject: string; epoch: number; selection: SelectedFolder; identity: WorkplaceIdentity }): Promise<void>;
};

function exactProject(project: Project, hostId: string, path: string): boolean {
  const selected = project.sources.filter(source => source.hostId === hostId && source.path === path);
  const defaults = project.sources.filter(source => source.isDefault);
  return project.kind === 'standard' && selected.length === 1 && selected[0].isDefault &&
    selected[0].type === 'local_path' && selected[0].projectId === project.id && defaults.length === 1;
}

/** The complete selection, project and handoff operation is single-flight. */
export function createCompanyFolderFlow(d: CompanyFolderDependencies) {
  let pending: { threadId: string; projectId: string; operation: Promise<CompanyFolderResult> } | null = null;
  return async (ctx: PluginAgentToolContext): Promise<CompanyFolderResult> => {
    ctx.signal.throwIfAborted();
    if (pending) {
      if (pending.threadId !== ctx.threadId || pending.projectId !== ctx.projectId) throw new Error('Выбор папки уже открыт в другом разговоре.');
      return pending.operation;
    }
    const operation = (async (): Promise<CompanyFolderResult> => {
      const epoch = d.epoch();
      const initial = await d.connection.view();
      if (initial.stage !== 'ready' || initial.verification !== 'signed-grants' || !initial.binding || !initial.subject ||
          initial.threadId !== ctx.threadId || initial.binding.projectId !== ctx.projectId) throw new Error('Сначала проверь подключение в этом разговоре.');
      const binding = initial.binding;
      const check = async (_ctx = ctx) => {
        ctx.signal.throwIfAborted();
        if (d.epoch() !== epoch) throw new Error('Подключение изменилось. Выбери папку заново.');
        const view = await d.connection.view();
        if (view.stage !== 'ready' || view.verification !== 'signed-grants' || view.runId !== initial.runId ||
            view.threadId !== ctx.threadId || view.subject !== initial.subject || JSON.stringify(view.binding) !== JSON.stringify(binding))
          throw new Error('Подключение изменилось. Выбери папку заново.');
        const identity = await d.connection.partnerIdentity();
        if (identity.subject !== initial.subject || identity.threadId !== ctx.threadId || d.epoch() !== epoch)
          throw new Error('Подключение изменилось. Выбери папку заново.');
        const thread = await d.sdk.threads.get({ threadId: ctx.threadId });
        const env = await d.sdk.environments.get({ environmentId: binding.environmentId });
        if (thread.id !== ctx.threadId || thread.deletedAt || thread.originPluginId !== d.pluginId || thread.originKind !== null ||
            thread.projectId !== binding.projectId || thread.environmentId !== binding.environmentId || thread.providerId !== binding.providerId ||
            env.id !== binding.environmentId || env.hostId !== binding.hostId || env.status !== 'ready' ||
            (await d.sdk.system.config()).primaryHostId !== binding.hostId || d.epoch() !== epoch)
          throw new Error('Рабочее место изменилось. Выбери папку заново.');
        ctx.signal.throwIfAborted();
      };
      await check();
      const choice = await d.choose(ctx);
      if (choice.status === 'cancelled') return { status: 'cancelled' };
      const { status: _status, ...selection } = choice;
      if (selection.hostId !== binding.hostId || selection.sourceEnvironmentId !== binding.environmentId ||
          selection.sourceProviderId !== binding.providerId) throw new Error('Выбрана папка другого рабочего места.');
      const recheck = async () => {
        const verified = await d.revalidate(ctx, selection, check);
        if ((['hostId', 'path', 'sourceEnvironmentId', 'sourceProviderId', 'device', 'inode'] as const).some(key => verified[key] !== selection[key]))
          throw new Error('Папка изменилась. Выбери её заново.');
        await check();
      };
      const findMatches = async (projects: Project[]) => {
        const candidates = projects.flatMap(project => project.sources.filter(source => source.hostId === selection.hostId)
          .map(source => ({ project, source })));
        await Promise.all(candidates.filter(item => item.source.path !== selection.path).map(async ({ source }) => {
          let canonical: string;
          try { canonical = await (d.canonicalSourcePath ?? realpath)(source.path); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
          if (canonical === selection.path) throw new Error('Эта папка уже подключена к проекту BB через другой путь.');
        }));
        return projects.filter(project => project.sources.some(source => source.hostId === selection.hostId && source.path === selection.path));
      };
      const checkAfter = async () => {
        const sameAccount = async () => {
          ctx.signal.throwIfAborted();
          if (d.epoch() !== epoch) throw new Error('Подключение изменилось.');
        };
        const verified = await d.revalidate(ctx, selection, sameAccount);
        if ((['hostId', 'path', 'sourceEnvironmentId', 'sourceProviderId', 'device', 'inode'] as const).some(key => verified[key] !== selection[key]))
          throw new Error('Папка изменилась. Выбери её заново.');
        await sameAccount();
      };
      await recheck();
      const projects = await d.sdk.projects.list({ includePersonal: false });
      await recheck();
      const matches = await findMatches(projects);
      if (matches.length > 1 || (matches.length === 1 && !exactProject(matches[0], selection.hostId, selection.path)))
        throw new Error('Эта папка неоднозначно подключена к проектам BB. Выбери существующий проект вручную.');
      let project: Project;
      if (matches.length === 1) {
        project = await d.sdk.projects.get({ projectId: matches[0].id });
      } else {
        await recheck();
        const name = basename(selection.path).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) || 'Компания';
        project = await d.sdk.projects.create({ name, source: { type: 'local_path', hostId: selection.hostId, path: selection.path } });
      }
      await recheck();
      project = await d.sdk.projects.get({ projectId: project.id });
      if (!exactProject(project, selection.hostId, selection.path)) throw new Error('Проект BB изменился. Папка не подключена.');
      // Recheck all projects: another writer may have created the same source meanwhile.
      const latest = await d.sdk.projects.list({ includePersonal: false });
      const latestMatches = await findMatches(latest);
      if (latestMatches.length !== 1 || latestMatches[0].id !== project.id || !exactProject(latestMatches[0], selection.hostId, selection.path))
        throw new Error('Папка неоднозначно подключена к проектам BB.');
      await recheck();
      let handoff: { threadId: string }, openFailed = false, committedIdentity: WorkplaceIdentity | undefined;
      try {
        handoff = await d.connectSelectedFolder(ctx, { projectId: project.id, hostId: selection.hostId,
          path: selection.path, providerId: binding.providerId, selection }, phase => phase === 'before' ? recheck() : checkAfter());
      } catch (error) {
        if (!(error instanceof CommittedOpenError)) throw error;
        handoff = { threadId: error.threadId }; openFailed = true; committedIdentity = error.identity;
      }
      // connectSelectedFolder has committed the successor and confirmed its UI
      // open. A late abort of the old chat must not cancel that completed handoff.
      if (d.epoch() !== epoch) throw new Error('Подключение изменилось.');
      const thread = await d.sdk.threads.get({ threadId: handoff.threadId });
      if (thread.id !== handoff.threadId || thread.deletedAt || thread.originPluginId !== d.pluginId || thread.originKind !== null ||
          thread.projectId !== project.id || thread.providerId !== binding.providerId || !thread.environmentId)
        throw new Error('BB открыл другое рабочее место.');
      const env = await d.sdk.environments.get({ environmentId: thread.environmentId });
      const finalProject = await d.sdk.projects.get({ projectId: project.id });
      if (env.id !== thread.environmentId || env.projectId !== project.id || env.status !== 'ready' ||
          env.hostId !== selection.hostId || env.path !== selection.path || env.workspaceProvisionType !== 'unmanaged' ||
          !exactProject(finalProject, selection.hostId, selection.path) || d.epoch() !== epoch)
        throw new Error('BB открыл другое рабочее место.');
      const current = await d.connection.view();
      if (!['verify', 'ready'].includes(current.stage) || current.runId === initial.runId || current.threadId !== thread.id ||
          !current.binding || current.binding.projectId !== project.id || current.binding.environmentId !== env.id ||
          current.binding.hostId !== env.hostId || current.binding.providerId !== binding.providerId ||
          (current.subject !== null && current.subject !== initial.subject) || d.epoch() !== epoch)
        throw new Error('Проверка выбранного рабочего места изменилась.');
      if (current.stage === 'ready') {
        const verified = await d.connection.partnerIdentity();
        if (verified.subject !== initial.subject || verified.threadId !== thread.id || d.epoch() !== epoch)
          throw new Error('Проверка выбранного рабочего места изменилась.');
      }
      if (openFailed && d.rememberOpenFailure) await d.rememberOpenFailure({ sourceThreadId: ctx.threadId, sourceProjectId: ctx.projectId,
        threadId: thread.id, runId: current.runId, binding: current.binding, subject: initial.subject, epoch, selection, identity: committedIdentity! });
      return { status: openFailed ? 'open-failed' : 'opened', threadId: thread.id };
    })();
    pending = { threadId: ctx.threadId, projectId: ctx.projectId, operation };
    try { return await operation; } finally { if (pending?.operation === operation) pending = null; }
  };
}
