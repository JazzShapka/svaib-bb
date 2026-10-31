import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, sep } from 'node:path';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { CatalogAction, CatalogWorkspace } from './config';
import type { AspectId } from './types';

interface Recommendation {
  name: string;
  title: string;
  description: string;
  prompt: string;
  icon: string;
  kind: 'action' | 'role';
  aspectIds: AspectId[];
}

/** These are entry points, not copies of the skills' procedures. */
export const SKILL_RECOMMENDATIONS: readonly Recommendation[] = [
  { name: 'metrics-values', title: 'Узнать значения показателей', description: 'Факт, план и динамика из подключённых источников.', prompt: 'Помоги посмотреть значения показателей и понять, как мы движемся к цели. Уточни показатель и период, если их не хватает.', icon: 'ChartNoAxesCombined', kind: 'action', aspectIds: ['metrics', 'finance'] },
  { name: 'metrics-intake', title: 'Определить показатели', description: 'Выбрать, что измерять и зачем.', prompt: 'Помоги определить или пересмотреть показатели: что нам нужно измерять, чтобы видеть движение к цели.', icon: 'Target', kind: 'action', aspectIds: ['metrics'] },
  { name: 'team-person-review', title: 'Провести ревью человека', description: 'Ответственность, результат и следующий шаг.', prompt: 'Помоги провести ревью человека: за что он отвечает, какой результат даёт и что нужно обсудить. Уточни человека и период, если они не указаны.', icon: 'UserRound', kind: 'action', aspectIds: ['team'] },
  { name: 'team-unit-review', title: 'Провести ревью подразделения', description: 'Цель, результат и способность двигаться дальше.', prompt: 'Помоги провести ревью подразделения за период: как оно движется к цели и какое решение по нему нужно. Уточни подразделение и период, если их не хватает.', icon: 'Users', kind: 'action', aspectIds: ['team'] },
  { name: 'projects-review', title: 'Провести ревью проекта', description: 'Прогресс, препятствия и нужное решение.', prompt: 'Помоги провести ревью проекта за период: есть ли движение к цели, что мешает и какое решение нужно. Уточни проект и период, если они не указаны.', icon: 'Flag', kind: 'action', aspectIds: ['projects'] },
  { name: 'rhythm-meeting-agenda', title: 'Подготовить повестку', description: 'Что обсудить и решить на ближайшей встрече.', prompt: 'Подготовь повестку к предстоящей встрече: что нужно обсудить и решить. Уточни встречу, участников и дату, если они не указаны.', icon: 'CalendarDays', kind: 'action', aspectIds: ['rhythm', 'team', 'projects', 'metrics'] },
  { name: 'rhythm-meeting-debrief', title: 'Разобрать встречу', description: 'Обсуждения, решения и поручения по транскрипту.', prompt: 'Помоги разобрать прошедшую встречу по транскрипту: что обсудили, решили и поручили. Если транскрипта нет, попроси его.', icon: 'MessageSquare', kind: 'action', aspectIds: ['rhythm', 'team', 'projects'] },
  { name: 'roles-strategy', title: 'Обсудить стратегию', description: 'Сверить выбор и действия с курсом компании.', prompt: 'Посмотри со стороны стратегии: помоги разобраться с курсом компании и нашим выбором. Начни с текущего контекста и моего вопроса.', icon: 'Compass', kind: 'role', aspectIds: ['strategy'] },
  { name: 'roles-metrics', title: 'Обсудить цели и показатели', description: 'Связать желаемый результат с измерением.', prompt: 'Посмотри со стороны целей и показателей: помоги разобраться, какой результат нужен и как увидеть движение к нему.', icon: 'Target', kind: 'role', aspectIds: ['metrics'] },
  { name: 'roles-team', title: 'Обсудить команду', description: 'Люди, ответственность и развитие команды.', prompt: 'Посмотри со стороны команды: помоги разобраться в людях, ответственности и нужных изменениях. Начни с текущего контекста и моего вопроса.', icon: 'Users', kind: 'role', aspectIds: ['team'] },
  { name: 'roles-projects', title: 'Обсудить проекты', description: 'Зачем нужен проект и как он движется.', prompt: 'Посмотри со стороны проектов: помоги разобраться, зачем нужен проект и движется ли он к нужному результату.', icon: 'Flag', kind: 'role', aspectIds: ['projects'] },
  { name: 'roles-rhythm', title: 'Обсудить ритм управления', description: 'Встречи и отчёты, которые помогают делу.', prompt: 'Посмотри со стороны ритма управления: помоги разобраться, каким встречам и отчётам стоит уделять время, чтобы двигаться к цели.', icon: 'CalendarDays', kind: 'role', aspectIds: ['rhythm'] },
];

export interface AvailableSkill { name: string; path: string; catalogId: string; }
export interface SkillCatalog { skills: AvailableSkill[]; checkedAt: string; error?: string; }
type SkillScope = Pick<CatalogWorkspace, 'projectId' | 'environmentId'>;
type SkillSdk = { skills: Pick<BbPluginApi['sdk']['skills'], 'list'> };
const knownNames = new Set(SKILL_RECOMMENDATIONS.map(skill => skill.name));
const missingReason = 'Скилл сейчас недоступен в этой среде. Обновите рабочее место после подключения.';

export function canonicalSkillName(name: string): string | undefined {
  const canonical = name.startsWith('svaib:') ? name.slice('svaib:'.length) : name;
  return knownNames.has(canonical) ? canonical : undefined;
}

/** Metadata only. Symlinks used by installed skill packages are resolved. */
function checkedSkillPath(path: string): string | undefined {
  try {
    if (!isAbsolute(path) || basename(path) !== 'SKILL.md' || /[\r\n\0]/.test(path)) return undefined;
    const resolved = realpathSync(path);
    const metadata = statSync(resolved);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > 1_048_576) return undefined;
    accessSync(resolved, constants.R_OK);
    return resolved;
  } catch {
    return undefined;
  }
}

/** BB owns installed/enabled skill discovery; no scanning home or source content. */
export async function discoverSkills(sdk: SkillSdk, scope: SkillScope): Promise<SkillCatalog> {
  const checkedAt = new Date().toISOString();
  try {
    const { skills } = await sdk.skills.list({ projectId: scope.projectId, environmentId: scope.environmentId });
    const found = new Map<string, AvailableSkill>();
    for (const entry of skills) {
      const name = canonicalSkillName(entry.name);
      if (!name || found.has(name)) continue;
      // Do not relabel an unrelated package's coincidentally named operation as svaib.
      const isSvaib = entry.name.startsWith('svaib:') || /^svaib(?:$|[:@.-])/.test(entry.pluginId ?? '') || entry.filePath.split(sep).includes('svaib');
      if (!isSvaib) continue;
      const path = checkedSkillPath(entry.filePath);
      if (path) found.set(name, { name, path, catalogId: entry.id });
    }
    return { skills: [...found.values()], checkedAt };
  } catch {
    // A failed catalog lookup is not evidence that a cached package is available.
    return { skills: [], checkedAt, error: 'Не удалось проверить установленные скиллы. Обновите рабочее место.' };
  }
}

function withSkill(action: CatalogAction, catalog: SkillCatalog): CatalogAction {
  if (!action.skill) return action;
  const name = canonicalSkillName(action.skill);
  const recommendation = SKILL_RECOMMENDATIONS.find(skill => skill.name === name);
  const installed = name && catalog.skills.find(skill => skill.name === name);
  // Also runs synchronously at agent configuration, after the composer was opened.
  const path = installed && checkedSkillPath(installed.path);
  const { unavailableReason: _previousReason, ...base } = action;
  return {
    ...base,
    skill: name ?? action.skill,
    kind: recommendation?.kind ?? action.kind ?? 'action',
    available: Boolean(path),
    ...(path ? {
      method: `Используй скилл svaib:${name}. Сначала прочитай его инструкцию ${JSON.stringify(path)} и следуй ей. Не заменяй процедуру догадкой.\n\n${action.method}`,
    } : { unavailableReason: catalog.error ?? missingReason }),
  };
}

/** Apply to a freshly loaded profile. UI chooses a recommendation within the selected context. */
export function enrichWorkspaceActions(workspace: CatalogWorkspace, catalog: SkillCatalog): CatalogWorkspace {
  const configuredIds = new Set(workspace.actions.map(action => action.id));
  const actions = workspace.actions.map(action => withSkill(action, catalog));
  if (workspace.personal || workspace.clientHub) return { ...workspace, actions };
  for (const recommendation of SKILL_RECOMMENDATIONS) {
    const id = `skill-${recommendation.name}`;
    if (configuredIds.has(id) || !catalog.skills.some(skill => skill.name === recommendation.name)) continue;
    const action = withSkill({
      id, title: recommendation.title, description: recommendation.description, prompt: recommendation.prompt,
      icon: recommendation.icon, kind: recommendation.kind, aspectIds: [...recommendation.aspectIds],
      skill: recommendation.name, method: 'Учитывай выбранный объект и контекст запроса.', sourceIds: [],
    }, catalog);
    if (action.available) actions.push(action);
  }
  return { ...workspace, actions };
}
