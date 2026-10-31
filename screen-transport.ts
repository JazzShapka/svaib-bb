/** Shared gateway protocol adapters for the composed BB Screen module. */
import { z } from 'zod';
import type { ScreenTransport } from 'bb-plugin-svaib-screen-pilot/renderer';
import {
  confirmScaffoldSchema, idSchema, screenSchema, submitSchema, updateSchema,
  type Screen, type ScreenEvent,
} from 'bb-plugin-svaib-screen-pilot/model';

const contextSchema = z.object({
  account_id: z.string().min(1).max(256), company_id: z.string().min(1).max(64),
  subject_id: z.string().min(1).max(256), thread_id: z.string().min(1).max(256),
  environment_id: z.string().min(1).max(256), host_id: z.string().min(1).max(256),
}).strict();
export type ScreenContext = z.infer<typeof contextSchema>;
export type ScreenBinding = ScreenContext & { screen_id: string };
type Submit = Parameters<ScreenTransport['submit']>[0];
type Update = Parameters<NonNullable<ScreenTransport['update']>>[0];
type Confirm = Parameters<NonNullable<ScreenTransport['confirmScaffold']>>[0];
export type Snapshot = { screen: Screen; cursor: number };
export type Events = Snapshot & { events: ScreenEvent[]; historyStart: number; truncated: boolean };
type Operation = 'screen_get' | 'screen_submit' | 'screen_update' | 'screen_scaffold_confirm' | 'screen_events';

export class ScreenTransportError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ScreenTransportError'; }
}

/** Backend/RPC boundary. This facade never exposes credentials or identity to the UI. */
export interface ScreenBackendPort {
  get(signal?: AbortSignal): Promise<Snapshot>;
  submit(input: Submit, signal?: AbortSignal): Promise<{ screen: Screen }>;
  update(input: Update, signal?: AbortSignal): Promise<{ screen: Screen }>;
  confirmScaffold(input: Confirm, signal?: AbortSignal): Promise<{ screen: Screen }>;
  events(input: { after: number; timeoutMs: number }, signal?: AbortSignal): Promise<Events>;
}

export const screenSnapshotSchema = z.object({ screen: screenSchema, cursor: z.number().int().positive() }).strict();
const eventSchema = z.object({
  seq: z.number().int().positive(), revision: z.number().int().positive(), at: z.iso.datetime(),
  type: z.enum(['created', 'updated', 'submitted', 'scaffold-confirmed']),
  selectedIds: z.array(idSchema).optional(), confirmation: screenSchema.shape.scaffoldConfirmation.unwrap().unwrap().optional(),
}).strict();
export const screenEventsSchema = screenSnapshotSchema.extend({ events: z.array(eventSchema).max(512),
  historyStart: z.number().int().positive(), truncated: z.boolean() });
const mutationSchema = z.object({ screen: screenSchema, appliedRevision: z.number().int().positive(),
  event: eventSchema, replayed: z.boolean() }).strict();
const eventInput = z.object({ after: z.number().int().nonnegative(),
  timeoutMs: z.number().int().min(0).max(45000) }).strict();

/** Backend only. Binding/provider must come from native BB and verified svaib context.
 * callMcp must select the server-side grant for expectedContext, or refuse if it changed;
 * it returns the MCP SDK tools/call result (not a JSON-RPC envelope). No new OAuth here.
 * Re-reading is a local fence; gateway /mcp remains the authority for current rights.
 */
export function createScreenBackend(options: {
  binding: ScreenBinding;
  readTrustedContext(signal: AbortSignal): Promise<unknown>;
  callMcp(request: { name: Operation; arguments: Record<string, unknown> },
    options: { expectedContext: Readonly<ScreenContext>; signal: AbortSignal }): Promise<unknown>;
}): ScreenBackendPort & { dispose(): void } {
  const binding = contextSchema.extend({ screen_id: idSchema }).strict().parse(options.binding);
  const { screen_id: id, ...identity } = binding;
  const expectedContext = Object.freeze(identity);
  const lifetime = new AbortController();
  async function check(signal: AbortSignal) {
    signal.throwIfAborted();
    const parsed = contextSchema.safeParse(await options.readTrustedContext(signal));
    signal.throwIfAborted();
    if (!parsed.success || (Object.keys(expectedContext) as (keyof ScreenContext)[])
      .some(key => parsed.data[key] !== expectedContext[key])) throw new ScreenTransportError('context_changed');
  }
  async function call(name: Operation, args: Record<string, unknown>, signal?: AbortSignal) {
    const active = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
    await check(active);
    const result = await options.callMcp({ name, arguments: { ...args, id, company_id: expectedContext.company_id } },
      { expectedContext, signal: active });
    await check(active);
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ScreenTransportError('invalid_response');
    const envelope = result as { isError?: unknown; structuredContent?: unknown };
    if (envelope.isError === true) {
      const error = z.object({ reason: z.string().regex(/^[a-z_]{1,80}$/) }).safeParse(envelope.structuredContent);
      throw new ScreenTransportError(error.success ? error.data.reason : 'mcp_error');
    }
    if (envelope.isError !== false && envelope.isError !== undefined) throw new ScreenTransportError('invalid_response');
    return envelope.structuredContent;
  }
  function snapshot(value: unknown): Snapshot {
    const parsed = screenSnapshotSchema.safeParse(value);
    if (!parsed.success || parsed.data.screen.id !== id || parsed.data.cursor !== parsed.data.screen.revision)
      throw new ScreenTransportError('invalid_response');
    return parsed.data;
  }
  async function mutate(name: Operation, input: Submit | Update | Confirm, schema: { parse(value: unknown): Record<string, unknown> }, signal?: AbortSignal) {
    let parsed: Record<string, unknown>;
    try { parsed = schema.parse(input); } catch { throw new ScreenTransportError('invalid_arguments'); }
    if (parsed.id !== id) throw new ScreenTransportError('invalid_arguments');
    // Structural parse port keeps canonical schemas independent of package-local Zod versions.
    const result = mutationSchema.safeParse(await call(name, parsed, signal));
    if (!result.success || result.data.screen.id !== id || result.data.appliedRevision !== result.data.event.revision ||
      result.data.event.seq !== result.data.appliedRevision || result.data.appliedRevision > result.data.screen.revision)
      throw new ScreenTransportError('invalid_response');
    return { screen: result.data.screen };
  }
  return {
    get: async signal => snapshot(await call('screen_get', {}, signal)),
    submit: (input, signal) => mutate('screen_submit', input, submitSchema, signal),
    update: (input, signal) => mutate('screen_update', input, updateSchema, signal),
    confirmScaffold: (input, signal) => mutate('screen_scaffold_confirm', input, confirmScaffoldSchema, signal),
    events: async (input, signal) => {
      const checked = eventInput.safeParse(input);
      if (!checked.success) throw new ScreenTransportError('invalid_arguments');
      const parsed = screenEventsSchema.safeParse(await call('screen_events', checked.data, signal));
      if (!parsed.success) throw new ScreenTransportError('invalid_response');
      snapshot({ screen: parsed.data.screen, cursor: parsed.data.cursor });
      if (parsed.data.cursor < input.after || parsed.data.historyStart > parsed.data.cursor ||
        parsed.data.events.some((event, i, all) => event.seq <= input.after || event.seq > parsed.data.cursor ||
          event.revision !== event.seq || (i > 0 && all[i - 1].seq >= event.seq)))
        throw new ScreenTransportError('invalid_response');
      return parsed.data as Events;
    },
    dispose: () => lifetime.abort(),
  };
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Frontend only: backend is an injected RPC facade. No context/provider/token here.
 * The eventual RPC wiring must propagate cancellation or bound requests to its lifecycle.
 */
export function createScreenTransport(options: {
  backend: ScreenBackendPort;
  onError?(error: unknown): void;
}): ScreenTransport & { dispose(): void } {
  const lifetime = new AbortController();
  const subscriptions = new Set<AbortController>();
  const backend = options.backend;
  async function request<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    lifetime.signal.throwIfAborted();
    const result = await run(lifetime.signal);
    lifetime.signal.throwIfAborted();
    return result;
  }
  return {
    load: () => request(async signal => (await backend.get(signal)).screen),
    submit: input => request(signal => backend.submit(input, signal)),
    update: input => request(signal => backend.update(input, signal)),
    confirmScaffold: input => request(signal => backend.confirmScaffold(input, signal)),
    subscribe(invalidate) {
      lifetime.signal.throwIfAborted();
      const controller = new AbortController(); subscriptions.add(controller);
      const signal = AbortSignal.any([lifetime.signal, controller.signal]);
      const notify = () => { if (!signal.aborted) invalidate(); };
      void (async () => {
        let cursor: number | undefined;
        while (!signal.aborted) {
          try {
            if (cursor === undefined) { cursor = (await backend.get(signal)).cursor; notify(); }
            const page = await backend.events({ after: cursor, timeoutMs: 45000 }, signal);
            signal.throwIfAborted();
            if (page.cursor > cursor || page.events.length || page.truncated) notify();
            cursor = page.cursor;
          } catch (error) {
            if (signal.aborted) return;
            if (error instanceof ScreenTransportError && error.code === 'cursor_expired') { cursor = undefined; continue; }
            options.onError?.(error);
            if (error instanceof ScreenTransportError) { notify(); return; }
            cursor = undefined;
          }
          // Also prevents a busy loop if an upstream transport returns empty pages immediately.
          await delay(250, signal);
        }
      })().catch(error => { if (!signal.aborted) options.onError?.(error); })
        .finally(() => subscriptions.delete(controller));
      return () => { controller.abort(); subscriptions.delete(controller); };
    },
    dispose() { lifetime.abort(); for (const controller of subscriptions) controller.abort(); subscriptions.clear(); },
  };
}
