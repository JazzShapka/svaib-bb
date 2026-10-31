import type { PluginBbSdk } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { isSvaibMcpServer } from './whoami-proof';

const time = z.number().int().nonnegative();
export const opaqueProof = z.string().min(1).max(4096);
export const challengeSchema = z.object({ challenge: opaqueProof, nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  issued_at: time, expires_at: time }).strict();
export const verifiedProofSchema = z.object({ verified: z.literal(true), account_id: z.string().regex(/^acct_[A-Za-z0-9_-]+$/),
  nonce: challengeSchema.shape.nonce, issuer_client_id: z.string().min(1).max(512), verifier_client_id: z.string().min(1).max(512),
  issued_at: time, expires_at: time }).strict();
export type WorkplaceChallenge = z.infer<typeof challengeSchema>;
export type VerifiedWorkplaceProof = z.infer<typeof verifiedProofSchema>;
export type WorkplaceIdentity = { account_id: string; client_id: string; epoch: number };
export interface WorkplaceProofPort {
  identity(signal?: AbortSignal): Promise<WorkplaceIdentity>;
  begin(signal?: AbortSignal): Promise<WorkplaceChallenge>;
  verify(proof: string, signal?: AbortSignal): Promise<VerifiedWorkplaceProof>;
}

export function checkProofTime(value: { issued_at: number; expires_at: number }, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  if (value.issued_at > seconds + 5 || value.expires_at <= seconds || value.expires_at <= value.issued_at ||
      value.expires_at - value.issued_at > 120) throw new Error('Подтверждение подключения истекло или некорректно. Получи новый challenge без повторного входа.');
}

/** A native call's public envelope is observable even when Codex drops its body.
 * This observed timeline slice is an additional check, not account authority or
 * an atomic joint snapshot with independently read workplace binding. */
export async function nativePairingAnchor(sdk: PluginBbSdk, threadId: string, challenge: WorkplaceChallenge, sinceSeq: number) {
  const matchesArguments = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const input = value as Record<string, unknown>;
    return Object.keys(input).length === 2 && Object.hasOwn(input, 'challenge') && Object.hasOwn(input, 'nonce') &&
      typeof input.challenge === 'string' && typeof input.nonce === 'string' &&
      input.challenge === challenge.challenge && input.nonce === challenge.nonce;
  };
  const events = await sdk.threads.events.list({ threadId, order: 'desc', limit: '100' });
  const native = [...events].sort((a, b) => b.seq - a.seq).filter(event => {
    if (event.type !== 'item/started' && event.type !== 'item/completed') return false;
    const item = (event.data as { item?: Record<string, unknown> }).item;
    return item?.type === 'toolCall' && (item.tool === 'issue_workplace_proof' || item.tool === 'whoami') && isSvaibMcpServer(item.server);
  });
  const event = native[0];
  const item = event ? (event.data as { item: Record<string, unknown> }).item : undefined;
  // Public SDK toolCall.arguments, after the daemon normalizes provider shape.args.
  if (!event || event.seq <= sinceSeq || event.type !== 'item/completed' || item?.tool !== 'issue_workplace_proof' || item.status !== 'completed' || item.error ||
      typeof item.id !== 'string' || !item.id || !matchesArguments(item.arguments))
    throw new Error('В этом разговоре нужен завершённый настоящий MCP issue_workplace_proof для текущего challenge.');
  const started = native.find(candidate => candidate.type === 'item/started' &&
    (candidate.data as { item?: Record<string, unknown> }).item?.id === item.id);
  const startedItem = started ? (started.data as { item: Record<string, unknown> }).item : undefined;
  if (!started || started.seq <= sinceSeq || started.seq >= event.seq || startedItem?.tool !== item.tool ||
      !matchesArguments(startedItem.arguments))
    throw new Error('BB не предоставил начало native proof вызова для текущего подключения. Получи новый challenge.');
  return { seq: event.seq, id: item.id };
}
