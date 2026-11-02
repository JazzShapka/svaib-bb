import { randomUUID } from 'node:crypto';
import { accountIdentity, accountViewSchema, meSchema, visibleMeSchema, hasCompanyMembership, verifyProfile, onboardingProgressSchema, type OnboardingView, type AccountView, type Me } from './contracts';
import { companySelector, SvaibApi } from './api';
import { OAuthConnection } from './oauth';
import { MCP_RESOURCE, SvaibMcp, type McpToolResult } from './mcp';
import { challengeSchema, checkProofTime, opaqueProof, verifiedProofSchema, type WorkplaceIdentity } from './workplace-proof';
import { continuationInputSchema } from './continuation';

export interface VerifiedCompany { account_id: string; company_id: string; subject_id: string; epoch: number }
export interface CompanyMcpRequest { name: string; arguments: Record<string, unknown> }
export class AccountAccessError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'AccountAccessError'; }
}

function visibleMe(me: Me): NonNullable<AccountView['me']> {
  return visibleMeSchema.parse(me);
}

export class AccountController {
  constructor(private readonly oauth: OAuthConnection, private readonly api: SvaibApi,
    private readonly mcp = new SvaibMcp()) {}

  private async account(companyId?: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const token = await this.oauth.token();
    signal?.throwIfAborted();
    if (!token) return null;
    const me = meSchema.parse(await this.api.me(token, companyId, signal));
    signal?.throwIfAborted();
    if (me.disabled) throw new Error('Аккаунт svaib отключён.');
    if (companyId !== undefined && (!hasCompanyMembership(me) || me.company_id !== companyId ||
        me.tenant_id !== companyId || me.selected_company_id !== companyId))
      throw new AccountAccessError('context_changed');
    return { token, me };
  }

  async view(companyId?: string, signal?: AbortSignal): Promise<AccountView> {
    const epoch = this.oauth.epoch;
    if (this.oauth.waiting) return { state: 'waiting', message: 'Заверши вход в браузере.', me: null, profile: null, canEdit: false };
    let account: Awaited<ReturnType<AccountController['account']>>;
    try { account = await this.account(companyId, signal); }
    catch { return { state: 'error', message: 'Не удалось проверить подключение svaib. Повтори обновление или войди заново.', me: null, profile: null, canEdit: false }; }
    if (epoch !== this.oauth.epoch) return this.view(companyId, signal);
    if (!account) return { state: 'signed-out', message: this.oauth.message, me: null, profile: null, canEdit: false };
    const { token, me } = account;
    const base = { state: 'connected' as const, me: visibleMe(me), profile: null, canEdit: false };
    if (!hasCompanyMembership(me)) return {
      ...base, me: { ...base.me, capabilities: me.capabilities.filter(capability => !capability.startsWith('ui_profile:')) },
      message: 'Аккаунт подключён. UI-профиль доступен после подтверждения участия в выбранной компании.',
    };
    if (!me.capabilities.includes('ui_profile:read')) return {
      ...base, message: 'Вход выполнен. API персонального интерфейса ещё не включён на сервере svaib.',
    };
    try {
      const profile = verifyProfile(await this.api.profile(token, companyId, signal), me);
      if (epoch !== this.oauth.epoch) return this.view(companyId, signal);
      return accountViewSchema.parse({ ...base, profile, message: '', canEdit: me.capabilities.includes('ui_profile:write') });
    } catch {
      if (epoch !== this.oauth.epoch) return this.view(companyId, signal);
      return { ...base, message: 'Не удалось загрузить UI-профиль. Карточки не показаны по устаревшим или чужим настройкам. Повтори обновление.' };
    }
  }

  async workspaceCard(enabled: boolean, expectedRevision: number, companyId?: string, signal?: AbortSignal): Promise<AccountView> {
    const epoch = this.oauth.epoch;
    const account = await this.account(companyId, signal);
    if (epoch !== this.oauth.epoch) throw new Error('Подключение изменилось. Обнови страницу.');
    if (!account) throw new Error('Сначала войди в svaib.');
    const { token, me } = account;
    if (!hasCompanyMembership(me)) throw new Error('Для изменения UI-профиля нужно подтверждённое участие в выбранной компании.');
    if (!me.capabilities.includes('ui_profile:write')) throw new Error('Изменение UI-профиля недоступно этому подключению.');
    // Never accept a tenant or subject from the browser. The authenticated API principal owns selection.
    verifyProfile(await this.api.update(token, {
      schema_version: 1, features: { workspace_card: enabled }, expected_revision: expectedRevision,
      idempotency_key: randomUUID(),
    }, companyId, signal), me);
    if (epoch !== this.oauth.epoch) throw new AccountAccessError('context_changed');
    return this.view(companyId, signal);
  }

  /** Account pairing does not select a company or grant company authority. */
  async workplaceIdentity(signal?: AbortSignal): Promise<WorkplaceIdentity> {
    const epoch = this.oauth.epoch;
    if (!this.oauth.isBoundToResource(MCP_RESOURCE)) throw new AccountAccessError('resource_mismatch');
    const current = await this.account(undefined, signal);
    const client = await this.oauth.clientId();
    signal?.throwIfAborted();
    if (epoch !== this.oauth.epoch) throw new AccountAccessError('context_changed');
    if (!current || !client || !current.me.account_id || current.me.account_id !== accountIdentity(current.me))
      throw new AccountAccessError('reauthentication_required');
    return { account_id: current.me.account_id, client_id: client, epoch };
  }

  /** Account-level progress is separate from every company membership. */
  async onboarding(signal?: AbortSignal): Promise<OnboardingView> {
    const unavailable: OnboardingView = { status: 'unavailable', onboarding: null, nextStep: null, role: null };
    try {
      const identity = async () => {
        const expected = await this.workplaceIdentity(signal);
        const account = await this.account(undefined, signal);
        if (!account || this.oauth.epoch !== expected.epoch || account.me.context !== 'account' ||
            account.me.account_id !== expected.account_id || account.me.company_id || account.me.tenant_id ||
            account.me.selected_company_id) throw new AccountAccessError('context_changed');
        return expected;
      };
      const expected = await identity();
      const token = await this.oauth.token();
      if (!token || expected.epoch !== this.oauth.epoch) return unavailable;
      const who = await this.mcp.callResult(token, 'whoami', {}, signal);
      if (who.isError || !who.structuredContent || typeof who.structuredContent !== 'object') return unavailable;
      const facts = who.structuredContent as Record<string, unknown>;
      if (facts.context !== 'account' || facts.account_id !== expected.account_id || facts.company_id ||
          facts.tenant_id || facts.selected_company_id) return unavailable;
      const progress = onboardingProgressSchema.safeParse(facts.onboarding);
      if (!progress.success) return unavailable;
      let nextStep: string | null = null;
      try {
        const setup = await this.mcp.callResult(token, 'get_account_setup', {}, signal);
        const value = setup.structuredContent as { account_id?: unknown; setup?: { next_step?: unknown } } | undefined;
        if (!setup.isError && value?.account_id !== expected.account_id) return unavailable;
        const next = value?.setup?.next_step;
        const safe = continuationInputSchema.shape.nextStep.safeParse(next);
        if (!setup.isError && value?.account_id === expected.account_id && safe.success && safe.data.length <= 320 &&
            !/(?:password|passwd|парол|секрет|secret|api.?key|ключ|код\s+(?:входа|подтверждения)|bearer)/i.test(safe.data))
          nextStep = safe.data;
      } catch { signal?.throwIfAborted(); /* Setup is optional; identity is checked below. */ }
      const actual = await identity();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return unavailable;
      return { status: 'available', onboarding: progress.data, nextStep, role: null };
    } catch { signal?.throwIfAborted(); return unavailable; }
  }

  /** Membership progress is read with the existing checked company binding. */
  async companyOnboarding(companyId: string, signal?: AbortSignal): Promise<OnboardingView> {
    const unavailable: OnboardingView = { status: 'unavailable', onboarding: null, nextStep: null, role: null };
    try {
      const expected = await this.verifiedCompany(companyId, signal);
      const who = await this.callMcpForContext({ name: 'whoami', arguments: {} }, expected, signal);
      if (who.isError || !who.structuredContent || typeof who.structuredContent !== 'object') return unavailable;
      const facts = who.structuredContent as Record<string, unknown>;
      if (facts.context !== 'company' || facts.account_id !== expected.account_id ||
          facts.company_id !== expected.company_id || facts.tenant_id !== expected.company_id ||
          facts.selected_company_id !== expected.company_id || facts.subject_id !== expected.subject_id ||
          !['owner', 'member'].includes(String(facts.role))) return unavailable;
      const progress = onboardingProgressSchema.safeParse(facts.onboarding);
      if (!progress.success) return unavailable;
      return { status: 'available', onboarding: progress.data, nextStep: null, role: facts.role as 'owner' | 'member' };
    } catch { signal?.throwIfAborted(); return unavailable; }
  }

  private async workplaceCall(name: 'begin_workplace_proof' | 'verify_workplace_proof', arguments_: Record<string, unknown>, signal?: AbortSignal) {
    const expected = await this.workplaceIdentity(signal);
    const token = await this.oauth.token();
    if (!token || expected.epoch !== this.oauth.epoch) throw new AccountAccessError('context_changed');
    const result = await this.mcp.callResult(token, name, arguments_, signal);
    const actual = await this.workplaceIdentity(signal);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new AccountAccessError('context_changed');
    if (result.isError) {
      const reason = (result.structuredContent as { reason?: unknown } | undefined)?.reason;
      // Never expose a server response body containing an opaque receipt to error logs/model.
      const safe = new Set(['workplace-proof-unavailable', 'reauthentication_required', 'workplace-proof-invalid',
        'workplace-proof-expired', 'workplace-account-mismatch', 'workplace-client-mismatch']);
      throw new AccountAccessError(typeof reason === 'string' && safe.has(reason) ? reason : 'workplace-proof-unavailable');
    }
    return { facts: result.structuredContent, identity: actual };
  }

  async beginWorkplaceProof(signal?: AbortSignal) {
    const { facts } = await this.workplaceCall('begin_workplace_proof', {}, signal);
    const challenge = challengeSchema.parse(facts); checkProofTime(challenge); return challenge;
  }

  async verifyWorkplaceProof(proof: string, signal?: AbortSignal) {
    const { facts, identity } = await this.workplaceCall('verify_workplace_proof', { proof: opaqueProof.parse(proof) }, signal);
    const verified = verifiedProofSchema.parse(facts); checkProofTime(verified);
    if (verified.account_id !== identity.account_id || verified.verifier_client_id !== identity.client_id ||
        verified.issuer_client_id === identity.client_id) throw new AccountAccessError('workplace-client-mismatch');
    return verified;
  }

  /** Backend-only: no company selection is persisted and no token is returned. */
  async verifiedCompany(companyId: string, signal?: AbortSignal): Promise<VerifiedCompany> {
    const selector = companySelector(companyId);
    const epoch = this.oauth.epoch;
    if (!this.oauth.isBoundToResource(MCP_RESOURCE)) throw new AccountAccessError('resource_mismatch');
    if (this.oauth.waiting) throw new AccountAccessError('authentication_required');
    let account: Awaited<ReturnType<AccountController['account']>>;
    try { account = await this.account(selector, signal); }
    catch { signal?.throwIfAborted(); throw new AccountAccessError('company_context_unavailable'); }
    signal?.throwIfAborted();
    if (epoch !== this.oauth.epoch) throw new AccountAccessError('context_changed');
    if (!account) throw new AccountAccessError('authentication_required');
    const me = account.me;
    if (me.context !== 'company' || !hasCompanyMembership(me) || me.company_id !== selector ||
        me.tenant_id !== selector || me.selected_company_id !== selector || !me.account_id ||
        accountIdentity(me) !== me.account_id) throw new AccountAccessError('company_context_unavailable');
    return { account_id: me.account_id, company_id: selector, subject_id: me.subject_id, epoch };
  }

  async callMcpForContext(request: CompanyMcpRequest, expected: Readonly<VerifiedCompany>, signal?: AbortSignal): Promise<McpToolResult> {
    const check = async () => {
      signal?.throwIfAborted();
      if (expected.epoch !== this.oauth.epoch) throw new AccountAccessError('context_changed');
      const actual = await this.verifiedCompany(expected.company_id, signal);
      if (actual.account_id !== expected.account_id || actual.subject_id !== expected.subject_id ||
          actual.company_id !== expected.company_id || actual.epoch !== expected.epoch) throw new AccountAccessError('context_changed');
    };
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(request.name) || !request.arguments ||
        typeof request.arguments !== 'object' || Array.isArray(request.arguments) ||
        (request.arguments.company_id !== undefined && request.arguments.company_id !== expected.company_id))
      throw new AccountAccessError('invalid_arguments');
    await check();
    const token = await this.oauth.token();
    signal?.throwIfAborted();
    if (!token || expected.epoch !== this.oauth.epoch) throw new AccountAccessError('context_changed');
    let result: McpToolResult;
    try { result = await this.mcp.callResult(token, request.name, { ...request.arguments, company_id: expected.company_id }, signal); }
    catch (error) { signal?.throwIfAborted(); throw new AccountAccessError(error instanceof Error && error.name === 'McpFailure' ? 'mcp_protocol_error' : 'mcp_unavailable'); }
    await check();
    return result;
  }
}
