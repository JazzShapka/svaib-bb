import type { Screen, Mutation, EventPage } from './model';
import { Refusal } from './store';

export function localEndpoint(value = 'http://127.0.0.1:5066') {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Локальный пилот принимает только http://127.0.0.1:PORT.');
  }
  return url.origin;
}
export class ScreenClient {
  readonly base: string;
  constructor(base?: string) { this.base = localEndpoint(base); }
  async call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(this.base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(50000) });
    const result = await response.json();
    if (!response.ok) throw new Refusal(result.code ?? 'service_error', result.message ?? 'Сервис недоступен.', response.status);
    return result as T;
  }
  list() { return this.call<Screen[]>('/api/screens'); }
  get(id: string) { return this.call<Screen>(`/api/screens/${encodeURIComponent(id)}`); }
  snapshot(id: string) { return this.call<{ screen: Screen; cursor: number }>(`/api/screens/${encodeURIComponent(id)}/snapshot`); }
  create(input: unknown) { return this.call<Mutation>('/api/create', input); }
  update(input: unknown) { return this.call<Mutation>('/api/update', input); }
  submit(input: unknown) { return this.call<Mutation>('/api/submit', input); }
  confirmScaffold(input: unknown) { return this.call<Mutation>('/api/scaffold/confirm', input); }
  wait(id: string, after: number, timeoutMs = 0, signal?: AbortSignal) {
    return this.call<EventPage>(`/api/screens/${encodeURIComponent(id)}/events?after=${after}&timeout=${timeoutMs}`, undefined, signal);
  }
}
