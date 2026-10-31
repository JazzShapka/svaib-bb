export type Fetcher = typeof fetch;

export class HttpFailure extends Error {
  constructor(public readonly status: number, public readonly oauthCode = '') {
    super(status === 401 ? 'Требуется повторный вход в svaib.' : `Сервис svaib ответил HTTP ${status}.`);
  }
}

/** No upstream bodies, token values or callback URLs are included in errors. */
export async function requestJson(fetcher: Fetcher, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, redirect: 'error', signal: init.signal ?? AbortSignal.timeout(20_000) });
  } catch {
    throw new Error('Не удалось связаться с svaib. Проверь соединение и повтори действие.');
  }
  const reader = response.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        if (size > 1024 * 1024) { await reader.cancel(); throw new Error('Ответ svaib превышает допустимый размер.'); }
        parts.push(item.value);
      }
    } finally { reader.releaseLock(); }
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(data)); }
  catch {
    if (!response.ok) throw new HttpFailure(response.status);
    throw new Error('Сервис svaib вернул нечитаемый ответ.');
  }
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : '';
    throw new HttpFailure(response.status, ['invalid_grant', 'invalid_token'].includes(code) ? code : '');
  }
  return body;
}
