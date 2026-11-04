import type { OnboardingView } from './contracts';
import type { SetupStep } from './OnboardingJourney';

/** Presentation groups, not additional server stages or a saved local plan. */
export const setupTasks = [
  { id: 'workplace', title: 'Подготовить партнёра', detail: 'Проверим приложения, плагины и работу партнёра.',
    prompt: 'Проверь и заверши подготовку партнёра svaib в моём рабочем месте BB.' },
  { id: 'account', title: 'Войти в svaib', detail: 'Проверим вход и дополним только недостающие данные аккаунта.',
    prompt: 'Проверь и заверши вход в svaib и настройку моего аккаунта.' },
  { id: 'space', title: 'Подключить компанию и пространство', detail: 'Выберем компанию, затем подготовим её папку и проверим файлы.',
    prompt: 'Помоги подключить компанию и подготовить её пространство svaib.' },
  { id: 'first-work', title: 'Познакомиться и начать работу', detail: 'Уточним профиль и зону ответственности, затем выполним первую полезную задачу.',
    prompt: 'Помоги продолжить знакомство с партнёром svaib и перейти к первой полезной работе.' },
] as const;

export function setupSteps(input: { accountReady: boolean; companySelected: boolean;
  accountProgress: OnboardingView | null; progress: OnboardingView | null }): SetupStep[] {
  const done = (source: OnboardingView | null, id: string) =>
    source?.status === 'available' && source.onboarding.marks[id]?.state === 'done';
  // Account connection history can describe the technical start. It never
  // credits company-specific space/profile/work stages or authorizes company access.
  const complete = [done(input.accountProgress, 'user.connect') || done(input.progress, 'user.connect'),
    input.accountReady,
    input.companySelected && done(input.progress, 'user.connect') && done(input.progress, 'user.space'),
    input.companySelected && done(input.progress, 'user.profile') && done(input.progress, 'user.zone') && done(input.progress, 'user.first-work')];
  const current = complete.findIndex(value => !value);
  return setupTasks.map((task, index) => ({ id: task.id, title: task.title, detail: task.detail,
    ...(complete[index] && index === 0 ? { doneLabel: 'Подключение пройдено',
      detail: 'Подключение подтверждено ранее. Текущие плагины и хуки партнёр проверит при продолжении.' } : {}),
    ...(complete[index] && index === 1 ? { doneLabel: 'Кабинет подключён',
      detail: 'Вход кабинета сохранён. Доступ партнёра и совпадение аккаунтов проверяются отдельно.' } : {}),
    state: complete[index] ? 'done' : index === current ? 'current' : 'upcoming' }));
}
