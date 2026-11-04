import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { defineRpcContract, type PluginBbSdk } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { readScreenCompanyBinding } from '../../screen-native-context';
import { nextOnboardingStages } from './onboarding-stages';
import { validatePersistentFolder } from './folder-selection';
import type { AccountView, OnboardingView } from './contracts';
import type { ConnectFlowView } from './connect-flow';

const execFileAsync = promisify(execFile);
const stageSchema = z.object({ id: z.string(), title: z.string(), state: z.enum(['next', 'waiting', 'deferred', 'unverified', 'upcoming']) }).strict();
export const journeyStatusSchema = z.object({ workplace: z.boolean(), account: z.boolean(), space: z.boolean(), firstWork: z.boolean(),
  nextStep: z.string().nullable(), nextStages: z.array(stageSchema).max(3), stagesAvailable: z.boolean() }).strict();
export const journeyContract = defineRpcContract({
  journeyStatus: { input: z.object({ projectId: z.string().nullable(), threadId: z.string().nullable() }).strict(), output: journeyStatusSchema },
});
export type JourneyStatus = z.infer<typeof journeyStatusSchema>;
type Dependencies = {
  sdk: Pick<PluginBbSdk, 'threads' | 'environments' | 'hosts' | 'system' | 'projects'>;
  account: { view(): Promise<AccountView>; onboarding(): Promise<OnboardingView>; companyOnboarding(id: string): Promise<OnboardingView> };
  flow: { view(): Promise<ConnectFlowView> };
  observation?: { read(): Promise<{ threadId: string; accountId: string; environmentId: string; hostId: string; observedAt: number } | null> };
  readCatalog?: (provider: string, cwd: string, sdk: Dependencies['sdk'], hostId: string) => Promise<unknown>;
  /** Test-only: production uses the shared persistent-folder validator. */
  validatePersistentRootForTesting?: (path: string, hostId: string,
    env: Awaited<ReturnType<PluginBbSdk['environments']['get']>>) => Promise<string>;
};

async function hasPersistentProject(d: Dependencies, projectId: string,
  env: Awaited<ReturnType<PluginBbSdk['environments']['get']>>): Promise<boolean> {
  if (env.projectId !== projectId || env.workspaceProvisionType !== 'unmanaged' || !env.path) return false;
  const project = await d.sdk.projects.get({ projectId });
  if (project.id !== projectId || project.kind !== 'standard' || !project.sources.some(source =>
    source.projectId === projectId && source.hostId === env.hostId && source.type === 'local_path' && source.path === env.path)) return false;
  const root = d.validatePersistentRootForTesting
    ? await d.validatePersistentRootForTesting(env.path, env.hostId, env)
    : await validatePersistentFolder(d.sdk, env.hostId, env, env.path);
  return root === env.path;
}

/** Read the active native method's own generated catalog. Never infer its version from BB. */
export async function nativeCatalog(provider: string, cwd: string, sdk: Dependencies['sdk'], hostId: string, options?: {
  home?: string; env?: NodeJS.ProcessEnv;
  run?: (exe: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
}): Promise<unknown> {
  try {
  if (!['codex', 'claude-code'].includes(provider) || !isAbsolute(cwd)) return null;
  const env = options?.env ?? process.env;
  const root = join(options?.home ?? homedir(), provider === 'codex' ? '.codex' : '.claude');
  const profile = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR';
  if (env[profile] && resolve(env[profile]!) !== resolve(root)) return null;
  const cli = await sdk.hosts.providerCliStatus({ hostId });
  const executable = cli[provider];
  if (!executable?.installed || !executable.executablePath || !isAbsolute(executable.executablePath)) return null;
  const { stdout } = await (options?.run ?? execFileAsync)(executable.executablePath, ['plugin', 'list', '--json'], {
    cwd, env: { ...env, [profile]: root }, timeout: 15_000, maxBuffer: 2_000_000,
  });
  let cache: string;
  if (provider === 'codex') {
    const result = z.object({ installed: z.array(z.object({ pluginId: z.string(), version: z.string(),
      installed: z.boolean(), enabled: z.boolean() }).passthrough()) }).passthrough().parse(JSON.parse(stdout));
    const matches = result.installed.filter(item => item.pluginId === 'svaib@svaib' && item.installed && item.enabled);
    if (matches.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(matches[0].version)) return null;
    cache = await realpath(join(root, 'plugins/cache/svaib/svaib', matches[0].version));
    const parent = await realpath(join(root, 'plugins/cache/svaib/svaib'));
    if (relative(parent, cache).startsWith('..') || cache === parent) return null;
  } else {
    // plugin list includes installations for other projects; never pick an unrelated or ambiguous copy.
    const list = z.array(z.object({ id: z.string() }).passthrough()).parse(JSON.parse(stdout));
    const own = list.filter(item => item.id === 'svaib@svaib');
    const schema = z.object({ id: z.string(), version: z.string(), scope: z.enum(['user', 'project', 'local', 'managed']),
      enabled: z.boolean(), installPath: z.string(), projectPath: z.string().optional(),
      readFromFolder: z.string().optional(), folderVersion: z.string().optional(), errors: z.array(z.string()).optional() }).passthrough();
    const candidates = [];
    const actualCwd = await realpath(cwd);
    for (const record of own) {
      const parsed = schema.safeParse(record);
      if (!parsed.success) return null;
      const item = parsed.data;
      if (item.scope === 'project' || item.scope === 'local') {
        if (!item.projectPath || !isAbsolute(item.projectPath)) return null;
        // Nonexistent project paths can be stale records and cannot refer to the current directory.
        let project: string;
        try { project = await realpath(item.projectPath); } catch { continue; }
        if (project !== actualCwd) continue;
      }
      candidates.push(item);
    }
    if (candidates.length !== 1 || !candidates[0].enabled || candidates[0].errors?.length) return null;
    const selected = candidates[0];
    if (selected.readFromFolder && !selected.folderVersion) return null;
    const path = selected.readFromFolder ?? selected.installPath;
    if (!isAbsolute(path)) return null;
    cache = await realpath(path);
  }
  const file = await realpath(join(cache, 'skills/onboarding/references/stages.json'));
  if (relative(cache, file).startsWith('..')) return null;
  const data = await readSmallFile(file, 128_000);
  return JSON.parse(data);
  } catch { return null; }
}

async function readSmallFile(path: string, max: number): Promise<string> {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > max) throw new Error('file unavailable');
  const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await fd.stat();
    if (!opened.isFile() || opened.ino !== entry.ino || opened.dev !== entry.dev || opened.size > max) throw new Error('file changed');
    const bytes = await fd.readFile();
    if (!bytes.length || bytes.length > max) throw new Error('file unavailable');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { await fd.close(); }
}

/** Project existing proofs to the page without creating or modifying progress. */
export async function journeyStatus(d: Dependencies, context: { projectId: string | null; threadId: string | null }): Promise<JourneyStatus> {
  const fallback: JourneyStatus = { workplace: false, account: false, space: false, firstWork: false, nextStep: null, nextStages: [], stagesAvailable: false };
  // A real whoami observation is sufficient for the onboarding UI; it is
  // advisory and does not give Screen or company operations any authority.
  const readFlow = async (): Promise<ConnectFlowView> => {
    const observed = await d.observation?.read();
    if (observed) {
      const thread = await d.sdk.threads.get({ threadId: observed.threadId });
      if (!thread.deletedAt && thread.environmentId === observed.environmentId &&
          ['codex', 'claude-code'].includes(thread.providerId)) {
        return { stage: 'ready', runId: `observation:${observed.observedAt}`, threadId: thread.id,
          binding: { projectId: thread.projectId, environmentId: observed.environmentId,
            hostId: observed.hostId, providerId: thread.providerId as 'codex' | 'claude-code' },
          subject: observed.accountId, message: '', retryable: false };
      }
    }
    return d.flow.view();
  };
  let flow: ConnectFlowView;
  let view: AccountView;
  try { [flow, view] = await Promise.all([readFlow(), d.account.view()]); }
  catch { return fallback; }
  const account = view.state === 'connected' && !!view.me;
  const out: JourneyStatus = { ...fallback, account };
  if (account) try {
    const info = await d.account.onboarding();
    if (info.status === 'available') out.nextStep = info.nextStep;
  } catch { /* an unavailable setup never changes proof of a sign-in */ }
  if (flow.stage !== 'ready' || !flow.binding || !flow.threadId || !flow.subject) return out;
  if (context.projectId && context.projectId !== flow.binding.projectId) return out;
  const threadId = context.threadId ?? flow.threadId;
  try {
    const thread = await d.sdk.threads.get({ threadId });
    if (thread.deletedAt || thread.projectId !== flow.binding.projectId || !thread.environmentId ||
        thread.environmentId !== flow.binding.environmentId || thread.providerId !== flow.binding.providerId) return out;
    const [environment, system] = await Promise.all([d.sdk.environments.get({ environmentId: thread.environmentId }), d.sdk.system.config()]);
    if (environment.status !== 'ready' || environment.hostId !== flow.binding.hostId ||
        environment.hostId !== system.primaryHostId || !environment.path) return out;
    out.workplace = true;
    if (!account) return out;
    if (!await hasPersistentProject(d, thread.projectId, environment)) return out;
    const binding = await readScreenCompanyBinding(environment.path);
    if (binding.realRoot !== environment.path) return out;
    const company = await d.account.companyOnboarding(binding.companyId);
    if (company.status !== 'available' || company.onboarding.marks['user.space']?.state !== 'done') return out;
    // The mark records a completed stage; independently confirm the actual bound files remain readable.
    const [agents, readme, state] = await Promise.all([
      readSmallFile(join(binding.realRoot, 'AGENTS.md'), 256_000),
      readSmallFile(join(binding.realRoot, 'README.md'), 256_000),
      readSmallFile(join(binding.realRoot, '.svaib/space.json'), 128_000),
    ]);
    const metadata = z.object({ schema_version: z.literal(1),
      scaffold_version: z.string().regex(/^\d+(?:\.\d+){0,2}$/),
      in_progress: z.union([z.null(), z.literal('')]).optional(),
    }).passthrough().safeParse(JSON.parse(state));
    if (!agents.trim() || !readme.trim() || !metadata.success) return out;
    let catalog: unknown = null;
    try { catalog = await (d.readCatalog ?? nativeCatalog)(thread.providerId, environment.path, d.sdk, environment.hostId); }
    catch { /* The workspace can be ready even if its native stage catalog is unavailable. */ }
    const [currentFlow, currentThread, currentBinding, currentCompany, currentEnvironment] = await Promise.all([
      readFlow(), d.sdk.threads.get({ threadId }), readScreenCompanyBinding(environment.path),
      d.account.companyOnboarding(binding.companyId), d.sdk.environments.get({ environmentId: thread.environmentId }),
    ]);
    if (currentFlow.stage !== 'ready' || currentFlow.runId !== flow.runId || currentFlow.subject !== flow.subject ||
        JSON.stringify(currentFlow.binding) !== JSON.stringify(flow.binding) || currentThread.deletedAt ||
        currentThread.projectId !== thread.projectId || currentThread.environmentId !== thread.environmentId ||
        currentThread.providerId !== thread.providerId || currentBinding.realRoot !== binding.realRoot ||
        currentBinding.companyId !== binding.companyId || currentCompany.status !== 'available' ||
        JSON.stringify(currentCompany.onboarding) !== JSON.stringify(company.onboarding) || currentCompany.role !== company.role ||
        currentEnvironment.id !== environment.id || currentEnvironment.status !== 'ready' || currentEnvironment.path !== environment.path ||
        currentEnvironment.hostId !== environment.hostId || !await hasPersistentProject(d, thread.projectId, currentEnvironment)) return out;
    const [lastFlow, lastThread, lastCompany] = await Promise.all([
      readFlow(), d.sdk.threads.get({ threadId }), d.account.companyOnboarding(binding.companyId),
    ]);
    if (lastFlow.stage !== 'ready' || lastFlow.runId !== flow.runId || lastFlow.subject !== flow.subject ||
        JSON.stringify(lastFlow.binding) !== JSON.stringify(flow.binding) || lastThread.deletedAt ||
        lastThread.projectId !== thread.projectId || lastThread.environmentId !== thread.environmentId || lastThread.providerId !== thread.providerId ||
        lastCompany.status !== 'available' || JSON.stringify(lastCompany.onboarding) !== JSON.stringify(company.onboarding) || lastCompany.role !== company.role) return out;
    out.space = true;
    out.firstWork = currentCompany.onboarding.marks['user.profile']?.state === 'done' &&
      currentCompany.onboarding.marks['user.first-work']?.state === 'done';
    const stages = nextOnboardingStages(catalog, currentCompany.onboarding, currentCompany.role);
    if (stages.status === 'available') {
      out.stagesAvailable = true;
      out.nextStages = stages.stages.map(stage => ({ id: stage.id, title: stage.title, state: stage.state ?? 'next' }));
    }
    return out;
  } catch { return out; }
}
