import { useCallback, useEffect, useRef, useState } from 'react';
import { useSdk, type PluginPendingInteractionProps } from '@get-bb/plugin-sdk/app';
import { z } from 'zod';

const payloadSchema = z.object({ hostId: z.string().min(1), hostName: z.string().min(1) }).strict();
type Listing = { directory: string; parent: string | null; roots: string[]; entries: { kind: 'directory' | 'file'; name: string; path: string }[] };

/** The choice is submitted to BB's pending interaction, not written to disk. */
export function ChooseCompanyFolder({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const sdk = useSdk();
  const payload = payloadSchema.safeParse(interaction.payload);
  const hostId = payload.success ? payload.data.hostId : null;
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const request = useRef(0);
  const lastAttempt = useRef<string | undefined>(undefined);
  const submittingRef = useRef(false);
  const open = useCallback(async (path?: string) => {
    if (!hostId || submittingRef.current) return;
    lastAttempt.current = path;
    const id = ++request.current; setLoading(true); setError('');
    try {
      const result = await sdk.hosts.directory({ hostId, ...(path ? { path } : {}) });
      if (request.current === id) setListing(result);
    } catch {
      if (request.current === id) setError('Не удалось открыть папки на этом компьютере. Попробуй ещё раз.');
    } finally { if (request.current === id) setLoading(false); }
  }, [hostId, sdk]);
  useEffect(() => { void open(); return () => { request.current++; }; }, [open]);
  const choose = async () => {
    if (!hostId || !listing || loading || submittingRef.current) return;
    submittingRef.current = true; setSubmitting(true); setError('');
    try { await submit({ hostId, path: listing.directory }); }
    catch { submittingRef.current = false; setSubmitting(false); setError('Не удалось сохранить выбор. Попробуй ещё раз.'); }
  };
  if (!payload.success) return <div role="alert">Не удалось определить компьютер. Закрой выбор и попробуй ещё раз. <button type="button" onClick={() => void cancel()}>Отмена</button></div>;
  return <div aria-label="Выбор папки компании">
    <p>Выбери постоянную папку компании на компьютере <strong>{payload.data.hostName}</strong>.</p>
    <p>В ней будут храниться материалы компании. Пока ничего не изменится.</p>
    {listing && <p>Открыта папка: <strong>{listing.directory}</strong></p>}
    {listing && listing.roots.length > 1 && <div aria-label="Диски и расположения">
      <p>Диски и расположения</p>
      {[...new Set(listing.roots)].map(root => <button type="button" key={root} disabled={loading || submitting} onClick={() => void open(root)}>{root}</button>)}
    </div>}
    <div aria-label="Папки">
      {listing?.parent && <button type="button" disabled={loading || submitting} onClick={() => void open(listing.parent!)}>На уровень выше</button>}
      {listing?.entries.filter(entry => entry.kind === 'directory').map(entry =>
        <button type="button" key={entry.path} disabled={loading || submitting} onClick={() => void open(entry.path)}>{entry.name}</button>)}
      {listing && !listing.entries.some(entry => entry.kind === 'directory') && <p>Вложенных папок нет.</p>}
    </div>
    {loading && <p role="status">Открываю папки…</p>}
    {error && <p role="alert">{error} <button type="button" onClick={() => void open(lastAttempt.current)}>Повторить</button></p>}
    <button type="button" disabled={!listing || loading || submitting} onClick={() => void choose()}>Выбрать эту папку</button>
    <button type="button" disabled={submitting} onClick={() => void cancel()}>Отмена</button>
  </div>;
}
