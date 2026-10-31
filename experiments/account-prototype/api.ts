import { HttpFailure, requestJson, type Fetcher } from './http';
import { SvaibMcp } from './mcp';

export function companySelector(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('invalid_company_selector');
  return value;
}

/** BB-specific API. OAuth still identifies the existing gateway resource. */
export class SvaibApi {
  private readonly legacy: SvaibMcp;
  constructor(private readonly fetcher: Fetcher = fetch, private readonly base = 'https://api.svaib.com',
    private readonly allowLegacyIdentity = true) {
    this.legacy = new SvaibMcp(fetcher, `${base}/mcp`);
  }

  private request(token: string, path: string, body?: unknown, companyId?: string, signal?: AbortSignal) {
    const selector = companyId === undefined ? '' : `?company_id=${encodeURIComponent(companySelector(companyId))}`;
    return requestJson(this.fetcher, `${this.base}/bb/v1/${path}${selector}`, {
      method: body === undefined ? 'GET' : 'PATCH', headers: {
        authorization: `Bearer ${token}`, accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) } : {}),
    });
  }

  async me(token: string, companyId?: string, signal?: AbortSignal): Promise<unknown> {
    try { return await this.request(token, 'me', undefined, companyId, signal); }
    catch (error) {
      if (!this.allowLegacyIdentity || !(error instanceof HttpFailure) || error.status !== 404) throw error;
      // Explicit compatibility with the deployed gateway: identity only, never UI settings.
      signal?.throwIfAborted();
      const me = await this.legacy.call(token, 'whoami', companyId === undefined ? {} : { company_id: companySelector(companyId) }, signal);
      if (!me || typeof me !== 'object') throw new Error('Не удалось проверить аккаунт.');
      return { ...me, capabilities: [] };
    }
  }

  profile(token: string, companyId?: string, signal?: AbortSignal) { return this.request(token, 'ui-profile', undefined, companyId, signal); }

  async update(token: string, body: unknown, companyId?: string, signal?: AbortSignal) {
    try { return await this.request(token, 'ui-profile', body, companyId, signal); }
    catch (error) {
      if (error instanceof HttpFailure && error.status === 409) {
        throw new Error('Настройки уже изменены. Обнови страницу и повтори изменение.');
      }
      throw error;
    }
  }
}
