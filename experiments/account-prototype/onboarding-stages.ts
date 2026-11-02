import { z } from 'zod';

// This projection consumes the method package's catalog; it does not own a
// second list of stages or write account/company progress.
const stageSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), track: z.string().min(1),
  kind: z.string().min(1), order: z.number().int().nonnegative(), active: z.boolean(),
  audiences: z.array(z.string().min(1)), requires: z.array(z.string().min(1)),
  replaces: z.array(z.string().min(1)),
}).passthrough();
const catalogSchema = z.object({ schema: z.literal(1), stages: z.array(stageSchema).min(1) }).passthrough();
const onboardingSchema = z.object({
  schema: z.literal(1), audience: z.string().min(1).nullable(),
  tools: z.array(z.string().min(1)), marks: z.record(z.string(), z.unknown()),
}).passthrough();
const markSchema = z.object({
  state: z.enum(['done', 'waiting', 'unverified', 'skip', 'deferred']),
  actor: z.string().optional(), reason: z.string().optional(),
}).passthrough();

export type OnboardingStage = {
  id: string;
  title: string;
  state: 'waiting' | 'unverified' | 'deferred' | 'upcoming' | null;
  actor?: string;
  reason?: string;
};
export type OnboardingStagesResult =
  | { status: 'available'; stages: OnboardingStage[] }
  | { status: 'unavailable'; stages: [] };

/** Select at most three upcoming user stages from one account OR membership.
 * A missing/invalid source is unavailable, not an empty completed path.
 */
export function nextOnboardingStages(catalog: unknown, onboarding: unknown,
  role?: string | null): OnboardingStagesResult {
  const unavailable: OnboardingStagesResult = { status: 'unavailable', stages: [] };
  const parsedCatalog = catalogSchema.safeParse(catalog);
  const parsedOnboarding = onboardingSchema.safeParse(onboarding);
  if (!parsedCatalog.success || !parsedOnboarding.success ||
      (role != null && (typeof role !== 'string' || !role))) return unavailable;

  const all = parsedCatalog.data.stages;
  const state = parsedOnboarding.data;
  const byId = new Map(all.map(stage => [stage.id, stage]));
  if (byId.size !== all.length) return unavailable;
  const mine = all.filter(stage => stage.track === 'user' && stage.active);
  if (mine.some(stage => !['base', 'tool'].includes(stage.kind))) return unavailable;
  // Account-level whoami may not include membership role. Do not infer that a
  // person is an employee if an audience-filtered stage could be relevant.
  if (!state.audience && !role && mine.some(stage => stage.audiences.length > 0)) return unavailable;
  const audience = state.audience || (role === 'owner' ? 'ceo' : 'employee');

  const relevant = new Set(all.flatMap(stage => [stage.id, ...stage.replaces]));
  const marks = new Map<string, z.infer<typeof markSchema>>();
  for (const [id, value] of Object.entries(state.marks)) {
    if (!relevant.has(id) || value == null) continue; // Unknown ids belong to a newer catalog.
    const mark = markSchema.safeParse(value);
    if (!mark.success) return unavailable;
    marks.set(id, mark.data);
  }
  const done = (id: string): boolean => {
    const own = marks.get(id);
    if (own) return own.state === 'done'; // Explicit successor mark wins over predecessors.
    return (byId.get(id)?.replaces ?? []).some(previous => marks.get(previous)?.state === 'done');
  };
  const stages = mine
    .filter(stage => (!stage.audiences.length || stage.audiences.includes(audience)) &&
      (stage.kind === 'base' || state.tools.includes(stage.id)))
    .sort((a, b) => a.order - b.order)
    .filter(stage => !done(stage.id) && marks.get(stage.id)?.state !== 'skip')
    .slice(0, 3)
    .map((stage): OnboardingStage => {
      const mark = marks.get(stage.id);
      return { id: stage.id, title: stage.title,
        state: mark && mark.state !== 'done' && mark.state !== 'skip' ? mark.state
          : stage.requires.every(done) ? null : 'upcoming',
        ...(mark?.actor !== undefined ? { actor: mark.actor } : {}),
        ...(mark?.reason !== undefined ? { reason: mark.reason } : {}) };
    });
  return { status: 'available', stages };
}
