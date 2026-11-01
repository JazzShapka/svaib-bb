import { HttpFailure, requestJson, type Fetcher } from './http';

export function companySelector(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error('invalid_company_selector');
  return value;
}

/** BB-specific API. OAuth still identifies the existing gateway resource. */
export class SvaibApi {
  constructor(private readonly fetcher: Fetcher = fetch, private readonly base = 'https://api.svaib.com') {}

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
    return this.request(token, 'me', undefined, companyId, signal);
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
