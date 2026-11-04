import { z } from 'zod';
import type { PluginBbSdk } from '@get-bb/plugin-sdk';

const inputSchema = z.object({ threadId: z.string().regex(/^thr_[a-z0-9]+$/),
  accountId: z.string().regex(/^acct_[A-Za-z0-9_-]{1,59}$/) }).strict();
const storedSchema = inputSchema.extend({ environmentId: z.string(), hostId: z.string(),
  observedAt: z.number().int().nonnegative() }).strict();
export const comparisonSchema = z.object({ status: z.enum(['unknown', 'match', 'mismatch']),
  observedAt: z.number().int().nonnegative().nullable(), hostId: z.string().nullable() }).strict();
const KEY = 'native-account-observation-v1';

/** Advisory last observation only. It is never an authorization or signed receipt. */
export function createNativeObservation(d: {
  sdk: Pick<PluginBbSdk, 'threads' | 'environments'>;
  kv: { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };
  account: () => Promise<{ state: string; me: { account_id?: string | null } | null }>;
  changed: () => void;
}) {
  return {
    async read() {
      const result = storedSchema.safeParse(await d.kv.get(KEY));
      return result.success ? result.data : null;
    },
    async record(input: z.infer<typeof inputSchema>) {
      const value = inputSchema.parse(input);
      const thread = await d.sdk.threads.get({ threadId: value.threadId });
      if (thread.deletedAt || !thread.environmentId || !['codex', 'claude-code'].includes(thread.providerId))
        throw new Error('Разговор BB недоступен.');
      const environment = await d.sdk.environments.get({ environmentId: thread.environmentId });
      if (environment.id !== thread.environmentId || environment.projectId !== thread.projectId || environment.status !== 'ready')
        throw new Error('Рабочее место BB недоступно.');
      await d.kv.set(KEY, storedSchema.parse({ ...value, environmentId: environment.id,
        hostId: environment.hostId, observedAt: Date.now() }));
      d.changed();
      return { recorded: true as const };
    },
    async compare() {
      const stored = storedSchema.safeParse(await d.kv.get(KEY));
      if (!stored.success) return { status: 'unknown' as const, observedAt: null, hostId: null };
      const account = await d.account();
      if (account.state !== 'connected' || !account.me?.account_id)
        return { status: 'unknown' as const, observedAt: stored.data.observedAt, hostId: stored.data.hostId };
      return { status: account.me.account_id === stored.data.accountId ? 'match' as const : 'mismatch' as const,
        observedAt: stored.data.observedAt, hostId: stored.data.hostId };
    },
  };
}
export { inputSchema as nativeObservationInputSchema };
