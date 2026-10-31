import { z } from 'zod';
import { requestJson, type Fetcher } from './http';

export const MCP_RESOURCE = 'https://api.svaib.com/mcp';
export const MCP_PROTOCOL = '2025-11-25';
const envelope = z.object({ jsonrpc: z.literal('2.0'), id: z.number(), result: z.unknown().optional(), error: z.unknown().optional() });
const toolResult = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional() }).passthrough();
export type McpToolResult = z.infer<typeof toolResult>;
export class McpFailure extends Error {
  constructor(readonly code: string) { super(code); this.name = 'McpFailure'; }
}

/** Narrow adapter for svaib's stateless JSON MCP transport, not a generic SSE client. */
export class SvaibMcp {
  constructor(private readonly fetcher: Fetcher = fetch, private readonly resource = MCP_RESOURCE) {}

  async callResult(token: string, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<McpToolResult> {
    signal?.throwIfAborted();
    // Long polls may take 45s; caller cancellation and a 55s bound both apply.
    const active = AbortSignal.any([AbortSignal.timeout(55_000), ...(signal ? [signal] : [])]);
    const raw = await requestJson(this.fetcher, this.resource, {
      method: 'POST', headers: {
        authorization: `Bearer ${token}`, 'content-type': 'application/json',
        accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MCP_PROTOCOL,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: active,
    });
    signal?.throwIfAborted();
    const response = envelope.parse(raw);
    if (response.id !== 1 || response.error !== undefined) throw new McpFailure('mcp_protocol_error');
    return toolResult.parse(response.result);
  }

  async call(token: string, name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const result = await this.callResult(token, name, args, signal);
    if (result.isError) {
      const facts = result.structuredContent;
      const reason = facts && typeof facts === 'object' && 'reason' in facts ? facts.reason : '';
      if (reason === 'ui-profile-conflict') throw new Error('Настройки уже изменены. Обнови страницу и повтори изменение.');
      if (reason === 'feature_disabled' || reason === 'tool-unavailable' || reason === 'scope-missing') {
        throw new Error('UI-профиль пока недоступен в этом подключении svaib.');
      }
      throw new Error('MCP svaib отказал в операции. Проверь доступность функции и права аккаунта.');
    }
    if (result.structuredContent === undefined) throw new Error('MCP svaib не вернул структурированные данные.');
    return result.structuredContent;
  }
}
