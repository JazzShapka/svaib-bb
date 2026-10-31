import type { PluginBbSdk } from '@get-bb/plugin-sdk';
import { z } from 'zod';

// Delivery pins both plugin name and bundled MCP key to svaib; see
// dev/plugin-builder/profiles/svaib-plugin/{plugin,mcp}.json and inject_company.py.
const svaibMcpServerIds = new Set(['svaib', 'plugin:svaib:svaib']);
export function isSvaibMcpServer(server: unknown): server is string {
  return typeof server === 'string' && svaibMcpServerIds.has(server);
}

/** Read only the MCP envelope, never user-editable profile/preferences fields. */
export function subjectFromWhoamiResult(value: unknown, depth = 0): string | null {
  if (depth > 5) return null;
  if (typeof value === 'string') {
    try { return subjectFromWhoamiResult(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.isError === true) return null;
  // Explicit company context names a membership subject. Only a canonical
  // account field may supply account proof; bare legacy subject-only stays valid.
  const canonical = data.account_id ?? data.canonical_subject_id;
  if (data.context === 'company' && (typeof canonical !== 'string' || canonical.length === 0)) return null;
  for (const field of ['account_id', 'canonical_subject_id', 'subject_id']) {
    if (data[field] !== undefined && data[field] !== null) {
      return typeof data[field] === 'string' && data[field].length > 0 ? data[field] : null;
    }
  }
  if (data.structuredContent !== undefined) return subjectFromWhoamiResult(data.structuredContent, depth + 1);
  if (data.result !== undefined) return subjectFromWhoamiResult(data.result, depth + 1);
  if (Array.isArray(data.content)) {
    const subjects = data.content.flatMap(block => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return [];
      const subject = subjectFromWhoamiResult(block.text, depth + 1);
      return subject ? [subject] : [];
    });
    if (subjects.length && subjects.every(subject => subject === subjects[0])) return subjects[0];
  }
  return null;
}

export const whoamiIdentitySchema = z.object({
  subject: z.string().min(1), context: z.enum(['account', 'company']).optional(),
  company_id: z.string().min(1).optional(), subject_id: z.string().min(1).optional(),
}).strict();
export type WhoamiIdentity = z.infer<typeof whoamiIdentitySchema>;

/** Company metadata comes only from the same native MCP identity envelope.
 * Unknown/contradictory metadata retains account identity for ConnectFlow, but
 * cannot establish a company context in Screen. No inference from subject spelling.
 */
export function identityFromWhoamiResult(value: unknown, depth = 0): WhoamiIdentity | null {
  if (depth > 5) return null;
  if (typeof value === 'string') {
    try { return identityFromWhoamiResult(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.isError === true) return null;
  if (['account_id', 'canonical_subject_id', 'subject_id'].some(field => data[field] !== undefined && data[field] !== null)) {
    const subject = subjectFromWhoamiResult(data);
    if (!subject) return null;
    const identity: WhoamiIdentity = { subject };
    const company = data.company_id;
    const selected = [data.company_id, data.tenant_id, data.selected_company_id].filter(v => v !== undefined && v !== null && v !== '');
    if (data.context === 'account' && selected.length === 0 && data.subject_id === subject) {
      return { ...identity, context: 'account', subject_id: subject };
    }
    if (data.context === 'company' && typeof company === 'string' && company.length > 0 &&
      selected.every(v => v === company) && typeof data.subject_id === 'string' && data.subject_id.length > 0) {
      return { ...identity, context: 'company', company_id: company, subject_id: data.subject_id };
    }
    return identity;
  }
  if (data.structuredContent !== undefined) return identityFromWhoamiResult(data.structuredContent, depth + 1);
  if (data.result !== undefined) return identityFromWhoamiResult(data.result, depth + 1);
  if (Array.isArray(data.content)) {
    const proofs = data.content.flatMap(block => {
      if (block?.type !== 'text' || typeof block.text !== 'string') return [];
      const proof = identityFromWhoamiResult(block.text, depth + 1); return proof ? [proof] : [];
    });
    if (proofs.length && proofs.every(proof => JSON.stringify(proof) === JSON.stringify(proofs[0]))) return proofs[0];
  }
  return null;
}

export type NativeProofReader = (input: { sessionId: string; cwd: string; hostId: string; configRoot?: string; expectedCallId?: string; signal?: AbortSignal }) => Promise<string | WhoamiIdentity | null>;

/** BB assigns its own item IDs. The current public SDK exposes no mapping back
 * to Codex providerItemId. A session's last raw call is therefore not a safe
 * fallback for a normalized call missing its result; correlated timeline only.
 */
export async function readWhoamiProof(sdk: PluginBbSdk, threadId: string, _nativeProof?: NativeProofReader, signal?: AbortSignal) {
  signal?.throwIfAborted();
  type Events = Awaited<ReturnType<PluginBbSdk['threads']['events']['list']>>;
  function latest(events: Events) {
    return [...events].sort((a, b) => b.seq - a.seq).find(event => {
      if (event.type !== 'item/completed' && event.type !== 'item/started') return false;
      const item = (event.data as { item?: Record<string, unknown> }).item;
      return item?.type === 'toolCall' && item.tool === 'whoami' && isSvaibMcpServer(item.server);
    });
  }
  const read = () => sdk.threads.events.list({ threadId, order: 'desc', limit: '100' });
  const events = await read();
  const event = latest(events);
  if (!event) return null;
  const item = (event.data as { item: Record<string, unknown> }).item;
  if (event.type !== 'item/completed' || item.status !== 'completed' || item.error)
    throw new Error('Последний настоящий MCP whoami ещё не завершён или не подтвердил доступ. Повтори проверку.');
  let identity: WhoamiIdentity | null = null;
  if (Object.hasOwn(item, 'result')) {
    identity = identityFromWhoamiResult(item.result);
    if (!identity) throw new Error('Последний настоящий MCP whoami вернул ошибку или непроверяемый результат. Повтори проверку.');
  } else {
    if (typeof item.id !== 'string' || !item.id || event.scope.kind !== 'turn')
      throw new Error('BB не предоставил связанный с вызовом результат whoami. Непроверенный native fallback отключён.');
    const started = events.find(e => e.type === 'item/started' && (e.data as { item?: { id?: string } }).item?.id === item.id);
    const details = await sdk.threads.timelineTurnSummaryDetails({ threadId, turnId: event.scope.turnId, deferContent: 'false',
      sourceSeqStart: String(started?.seq ?? event.seq), sourceSeqEnd: String(event.seq) });
    const rows = details.rows.filter(row => row.kind === 'work' && row.workKind === 'tool' && row.callId === item.id);
    const row = rows.length === 1 ? rows[0] : undefined;
    if (row?.kind === 'work' && row.workKind === 'tool' && row.status === 'completed') identity = identityFromWhoamiResult(row.output);
    if (!identity) throw new Error('BB не предоставил связанный с вызовом результат whoami. Непроверенный native fallback отключён.');
  }
  // Revalidate the selected native call after every extraction await. A newer
  // started/completed call invalidates the snapshot, even with unchanged OAuth.
  const current = latest(await read());
  signal?.throwIfAborted();
  const currentItem = current ? (current.data as { item?: Record<string, unknown> }).item : undefined;
  if (!current || current.seq !== event.seq || current.type !== event.type || currentItem?.id !== item.id ||
    currentItem?.status !== 'completed' || currentItem?.error ||
    (Object.hasOwn(currentItem, 'result') && JSON.stringify(identityFromWhoamiResult(currentItem.result)) !== JSON.stringify(identity)))
    throw new Error('Настоящий whoami изменился во время проверки. Дождись последнего вызова и повтори.');
  return { ...identity, seq: event.seq };
}
