import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { HttpFailure, requestJson, type Fetcher } from './http';
import { MCP_RESOURCE } from './mcp';

const sessionSchema = z.object({
  clientId: z.string().min(1), accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(), expiresAt: z.number().finite(),
  sessionBinding: z.string().optional(),
}).strict();
export type OAuthSession = z.infer<typeof sessionSchema>;
export interface SessionStore { read(): Promise<string>; write(value: string): Promise<void> }
export interface OAuthEndpoints { registration: string; authorization: string; token: string; revoke: string; resource: string; clientId?: string; callbackPort?: number; sessionBinding?: string; scopes?: readonly string[] }
export const SVAIB_OAUTH: OAuthEndpoints = {
  registration: 'https://auth.svaib.com/oauth2/register',
  authorization: 'https://auth.svaib.com/oauth2/auth',
  token: 'https://auth.svaib.com/oauth2/token',
  revoke: 'https://auth.svaib.com/oauth2/revoke', resource: MCP_RESOURCE,
};
export const PRODUCTION_SCOPES = ['profile:read', 'profile:write', 'company:read', 'company:write', 'workspace:read', 'workspace:write', 'offline_access'] as const;
const LEGACY_SCOPES = 'profile:read profile:write offline_access';

/** A separate binding prevents old staging or profile-only grants being reused. */
export function productionOAuth(): OAuthEndpoints {
  return { ...SVAIB_OAUTH, scopes: [...PRODUCTION_SCOPES], sessionBinding: createHash('sha256')
    .update(JSON.stringify(['production-bb-v1', SVAIB_OAUTH.registration, SVAIB_OAUTH.authorization,
      SVAIB_OAUTH.token, SVAIB_OAUTH.resource, PRODUCTION_SCOPES])).digest('hex') };
}
const tokenSchema = z.object({
  access_token: z.string().min(1), token_type: z.string().regex(/^bearer$/i),
  refresh_token: z.string().min(1).optional(), expires_in: z.number().int().positive().max(31_536_000),
});
interface Pending { state: string; verifier: string; redirect: string; clientId: string; server: Server; generation: number }
export class OAuthBeginError extends Error {
  constructor(readonly startedEpoch: number, readonly failureEpoch: number) {
    super('Не удалось начать вход в svaib. Проверь соединение и повтори.');
  }
}

function finishPage(response: ServerResponse, ok: boolean, expired = false) {
  response.writeHead(expired ? 410 : ok ? 200 : 400, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  });
  response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>svaib</title><h1>${ok ? 'Вход выполнен' : expired ? 'Время входа истекло' : 'Вход не завершён'}</h1><p>${ok ? 'Вернись в BB. Это окно можно закрыть.' : 'Вернись в BB на страницу svaib и нажми «Продолжить подключение». Уже работающие входы сохранятся.'}</p></html>`);
}

/** One account per local BB server. No credentials ever leave this backend. */
export class OAuthConnection {
  private pending: Pending | null = null;
  private generation = 0;
  private refresh: Promise<string | null> | null = null;
  private disposed = false;
  private starting = false;
  private exchanging: number | null = null;
  private writes: Promise<void> = Promise.resolve();
  private error = '';
  constructor(private readonly store: SessionStore, private readonly changed: () => void,
    private readonly fetcher: Fetcher = fetch, private readonly endpoints = SVAIB_OAUTH) {}

  get waiting() { return this.starting || this.pending !== null || this.exchanging !== null; }
  get message() { return this.error; }
  get epoch() { return this.generation; }
  isBoundToResource(resource: string) { return this.endpoints.resource === resource && !!this.endpoints.sessionBinding; }
  /** Public OAuth identifier only. Credentials remain private to this backend. */
  async clientId(): Promise<string | null> { return (await this.stored())?.clientId ?? null; }
  private notify() { if (!this.disposed) this.changed(); }

  private async stored(): Promise<OAuthSession | null> {
    const raw = await this.store.read();
    if (!raw) return null;
    try {
      const session = sessionSchema.parse(JSON.parse(raw));
      if (this.endpoints.sessionBinding && session.sessionBinding !== this.endpoints.sessionBinding) return null;
      if (this.endpoints.clientId && session.clientId !== this.endpoints.clientId) return null;
      return session;
    }
    catch { throw new Error('Сохранённое подключение повреждено. Выйди и войди в svaib заново.'); }
  }

  private save(value: string, generation: number) {
    const next = this.writes.then(async () => {
      if (!this.disposed && generation === this.generation) await this.store.write(value);
    });
    this.writes = next.catch(() => {});
    return next;
  }

  async token(): Promise<string | null> {
    if (this.disposed) throw new Error('Плагин перезагружается. Открой страницу заново.');
    if (this.refresh) return this.refresh;
    const flight = this.readToken(this.generation).finally(() => {
      if (this.refresh === flight) this.refresh = null;
    });
    this.refresh = flight;
    return flight;
  }

  private async readToken(generation: number): Promise<string | null> {
    const session = await this.stored();
    if (this.disposed || generation !== this.generation) return null;
    if (!session) return null;
    if (session.expiresAt > Date.now() + 60_000) return session.accessToken;
    if (!session.refreshToken) { await this.save('', generation); return null; }
    try {
      const raw = await requestJson(this.fetcher, this.endpoints.token, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken }),
      });
      const next = tokenSchema.parse(raw);
      if (this.disposed || generation !== this.generation) return null;
      await this.save(JSON.stringify({ clientId: session.clientId, accessToken: next.access_token,
        ...(this.endpoints.sessionBinding ? { sessionBinding: this.endpoints.sessionBinding } : {}),
        refreshToken: next.refresh_token ?? session.refreshToken, expiresAt: Date.now() + next.expires_in * 1000 }), generation);
      if (this.disposed || generation !== this.generation) return null;
      return next.access_token;
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 400 && error.oauthCode === 'invalid_grant') {
        await this.save('', generation);
        throw new Error('Срок подключения истёк. Войди в svaib заново.');
      }
      throw new Error('Не удалось обновить подключение svaib. Повтори действие; сохранённое подключение не удалено.');
    }
  }

  async begin(): Promise<{ authorizationUrl: string }> {
    if (this.starting || this.pending || this.exchanging !== null) throw new Error('Вход уже начат. Заверши или отмени его.');
    this.starting = true;
    try { return await this.start(); }
    finally { this.starting = false; }
  }

  private async start(): Promise<{ authorizationUrl: string }> {
    if (this.disposed) throw new Error('Плагин перезагружается. Открой страницу заново.');
    if (this.pending) throw new Error('Вход уже начат. Заверши или отмени его.');
    const generation = ++this.generation;
    const session = await this.stored();
    if (this.disposed || generation !== this.generation) throw new Error('Вход отменён.');
    if (session) throw new Error('Сначала выйди из текущего подключения.');
    this.error = '';
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const server = createServer((request, response) => {
      // A callback from an expired listener can never consume a newer request.
      if (generation !== this.generation) { finishPage(response, false, true); return; }
      void this.callback(request.url ?? '', request.headers.host ?? '', response).catch(() => {
        if (!response.headersSent) finishPage(response, false);
      });
    });
    server.headersTimeout = 5_000; server.requestTimeout = 10_000;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(this.endpoints.callbackPort ?? 0, '127.0.0.1', resolve); });
    if (this.disposed || generation !== this.generation) { server.close(); throw new Error('Вход отменён.'); }
    const address = server.address();
    if (!address || typeof address === 'string') { server.close(); throw new Error('Не удалось открыть локальный адрес возврата.'); }
    const redirect = `http://127.0.0.1:${address.port}/callback`;
    // One receiver belongs to the BB process, not to a model turn or browser pause.
    // AS request/code expiry is enforced by the provider, never prolonged here.
    server.unref();
    this.pending = { state, verifier, redirect, clientId: '', server, generation };
    try {
      if (!this.endpoints.clientId && !this.endpoints.registration) {
        throw new Error('Не указан OAuth client ID тестового контура.');
      }
      const raw = this.endpoints.clientId ? { client_id: this.endpoints.clientId } : await requestJson(this.fetcher, this.endpoints.registration, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'svaib BB account prototype',
          redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'], token_endpoint_auth_method: 'none', scope: this.endpoints.scopes?.join(' ') ?? LEGACY_SCOPES }),
      });
      const registered = z.object({ client_id: z.string().min(1) }).parse(raw);
      if (this.disposed || this.pending?.generation !== generation) throw new Error('Вход отменён.');
      this.pending.clientId = registered.client_id;
      const url = new URL(this.endpoints.authorization);
      url.search = new URLSearchParams({ client_id: registered.client_id, redirect_uri: redirect,
        response_type: 'code', scope: this.endpoints.scopes?.join(' ') ?? LEGACY_SCOPES, state,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        resource: this.endpoints.resource }).toString();
      this.notify();
      return { authorizationUrl: url.href };
    } catch {
      if (this.pending?.generation === generation) {
        this.cancel();
        // An owned failure receipt, not an inference from a changed global epoch.
        throw new OAuthBeginError(generation, this.generation);
      }
      throw new Error('Не удалось начать вход в svaib. Проверь соединение и повтори.');
    }
  }

  private async callback(rawUrl: string, host: string, response: ServerResponse) {
    const pending = this.pending;
    if (!pending) { finishPage(response, false); return; }
    const url = new URL(rawUrl, pending.redirect);
    // A rejected/unrelated request must not consume a legitimate pending login.
    if (host !== new URL(pending.redirect).host || url.pathname !== '/callback'
      || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== pending.state) {
      finishPage(response, false); return;
    }
    this.pending = null;
    this.exchanging = pending.generation;
    pending.server.close();
    try {
      const codes = url.searchParams.getAll('code');
      if (url.searchParams.has('error') || codes.length !== 1 || !codes[0] || !pending.clientId) throw new Error();
      const raw = await requestJson(this.fetcher, this.endpoints.token, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: pending.clientId,
          code: codes[0], redirect_uri: pending.redirect, code_verifier: pending.verifier }),
      });
      const token = tokenSchema.parse(raw);
      if (this.disposed || pending.generation !== this.generation) throw new Error();
      await this.save(JSON.stringify({ clientId: pending.clientId, accessToken: token.access_token,
        ...(this.endpoints.sessionBinding ? { sessionBinding: this.endpoints.sessionBinding } : {}),
        ...(token.refresh_token ? { refreshToken: token.refresh_token } : {}), expiresAt: Date.now() + token.expires_in * 1000 }), pending.generation);
      if (this.disposed || pending.generation !== this.generation) throw new Error();
      this.error = ''; finishPage(response, true);
    } catch {
      if (pending.generation === this.generation) this.error = 'Вход не завершён. Начни вход заново.';
      finishPage(response, false);
    }
    if (this.exchanging === pending.generation) this.exchanging = null;
    this.notify();
  }

  cancel() {
    ++this.generation; this.refresh = null; this.exchanging = null;
    if (this.pending) { this.pending.server.close(); this.pending = null; }
    this.notify();
  }

  /** Replace only an unconsumed request owned by this generation. A callback
   * already exchanging/saving its grant wins the race and must finish normally. */
  restartPending(expectedEpoch: number): boolean {
    if (this.disposed || this.generation !== expectedEpoch || !this.pending || this.exchanging !== null) return false;
    this.cancel();
    return true;
  }

  async logout(): Promise<{ revoked: boolean }> {
    this.cancel(); this.error = '';
    const generation = this.generation;
    const session = await this.stored().catch(() => null);
    if (this.disposed || generation !== this.generation) return { revoked: false };
    await this.save('', generation);
    if (this.disposed || generation !== this.generation) return { revoked: false };
    let revoked = true;
    if (session) {
      for (const [value, hint] of [[session.refreshToken, 'refresh_token'], [session.accessToken, 'access_token']]) {
        if (!value) continue;
        try {
          const response = await this.fetcher(this.endpoints.revoke, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: value, token_type_hint: hint!, client_id: session.clientId }) });
          if (!response.ok) revoked = false;
          await response.body?.cancel();
        } catch { revoked = false; }
      }
    }
    this.notify(); return { revoked };
  }

  dispose() { this.disposed = true; this.cancel(); }
}
