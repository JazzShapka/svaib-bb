import { z } from 'zod';

// UI preferences do not grant permission to execute any business operation.
export const profileSchema = z.object({
  schema_version: z.literal(1),
  revision: z.number().int().nonnegative(),
  subject_id: z.string().min(1),
  tenant_id: z.string().min(1),
  features: z.object({ workspace_card: z.boolean() }).strict(),
}).strict();
export type UiProfile = z.infer<typeof profileSchema>;

export const meSchema = z.object({
  subject_id: z.string().min(1), tenant_id: z.string().min(1).optional(),
  account_id: z.string().min(1).nullable().optional(),
  company_id: z.string().min(1).optional(),
  context: z.enum(['account', 'company']).optional(),
  selected_company_id: z.string().min(1).nullable().optional(),
  companies: z.array(z.object({
    company_id: z.string().min(1), subject_id: z.string().min(1).optional(),
    role: z.enum(['owner', 'member']).optional(),
    tenant_name: z.string().optional(), company_name: z.string().optional(),
  })).optional(),
  canonical_subject_id: z.string().min(1).optional(),
  display_name: z.string().optional(), tenant_name: z.string().optional(),
  role: z.enum(['owner', 'member']).optional(), disabled: z.boolean().optional(),
  workspace: z.object({ repo: z.string(), repo_ref: z.string(), profile_path: z.string() }).optional(),
  capabilities: z.array(z.string()).default([]),
}).passthrough();
export type Me = z.infer<typeof meSchema>;

export const visibleMeSchema = meSchema.pick({
  subject_id: true, account_id: true, company_id: true, context: true,
  selected_company_id: true, companies: true, canonical_subject_id: true,
  tenant_id: true, display_name: true, tenant_name: true, role: true,
  workspace: true, capabilities: true,
}).strip();

/** Account identity is independent of the membership subject and selected company. */
export function accountIdentity(me: Pick<Me, 'account_id' | 'canonical_subject_id' | 'subject_id'>): string {
  return me.account_id ?? me.canonical_subject_id ?? me.subject_id;
}

/** A list of memberships or an account login alone never grants company operations. */
export function hasCompanyMembership(me: Me): boolean {
  return me.context !== 'account' && !!me.tenant_id && !!me.role &&
    (me.company_id === undefined || me.company_id === me.tenant_id) &&
    (me.selected_company_id === undefined || me.selected_company_id === me.tenant_id);
}

export const accountViewSchema = z.object({
  state: z.enum(['signed-out', 'waiting', 'connected', 'error']),
  message: z.string(),
  me: visibleMeSchema.nullable(),
  profile: profileSchema.nullable(),
  canEdit: z.boolean(),
});
export type AccountView = z.infer<typeof accountViewSchema>;

const stageId = z.string().max(64).regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/);
export const onboardingProgressSchema = z.object({
  schema: z.literal(1),
  marks: z.record(stageId, z.object({ state: z.enum(['done', 'waiting', 'unverified', 'skip', 'deferred']) }).strip()),
  audience: z.string().max(32).regex(/^[a-z][a-z0-9-]*$/).nullable(),
  tools: z.array(stageId).max(50),
}).strip();
export const onboardingViewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), onboarding: onboardingProgressSchema,
    nextStep: z.string().max(320).nullable(), role: z.enum(['owner', 'member']).nullable() }).strict(),
  z.object({ status: z.literal('unavailable'), onboarding: z.null(), nextStep: z.null(), role: z.null() }).strict(),
]);
export type OnboardingView = z.infer<typeof onboardingViewSchema>;

export function verifyProfile(profile: unknown, me: Me): UiProfile {
  if (!hasCompanyMembership(me)) throw new Error('Для UI-профиля нужно подтверждённое участие в выбранной компании.');
  const parsed = profileSchema.parse(profile);
  if (parsed.subject_id !== me.subject_id || parsed.tenant_id !== me.tenant_id) {
    throw new Error('Сервер вернул настройки другого аккаунта. Настройки не применены.');
  }
  return parsed;
}
