import type { MetricsDashboard } from './metrics-model';

export type WorkspaceId = string;
export type AspectId = 'strategy' | 'metrics' | 'team' | 'finance' | 'projects' | 'processes' | 'rhythm';
export interface ActionContext { aspectId?: AspectId; itemId?: string; }
export interface AspectItem {
  id: string; title: string; summary: string;
  role?: string; responsibility?: string; owner?: string; status?: string;
  value?: string; target?: string; period?: string;
  sourceIds: string[]; actionIds: string[];
}
export interface WorkspaceAspect {
  id: AspectId; summary?: string; snapshotAt?: string;
  sourceIds: string[]; actionIds: string[]; items: AspectItem[];
}
export interface SourceRef { id: string; title: string; path: string; updatedAt?: string; }
export interface Signal { title: string; text: string; tone: 'attention' | 'progress' | 'neutral'; sourceId: string; }
export interface Action {
  id: string; title: string; description: string; icon: string; prompt: string;
  skill?: string; aspectIds?: AspectId[]; kind?: 'action' | 'role';
  mode?: 'standard' | 'draft-only';
  effect?: 'metrics-refresh' | 'personal-assistant';
  available?: boolean; unavailableReason?: string;
}
export interface MetricsSnapshot {
  eyebrow: string; title: string; description: string; evidence: string[];
  insight?: { title: string; text: string };
  display: { period: string; baseline: string; periodLabel: string; baselineLabel: string; comparisonLabel: string; days: { current: number; previous: number }; charts: {
    id: string; label: string; unit: string; series: { shopId: string; label: string; previous: number; current: number; changePercent: number; perDayChangePercent: number; sourceCells: string[]; coverage: string }[];
    aggregate: { previous: number; current: number; changePercent: number; perDayChangePercent: number };
  }[] };
  verifiedAt: string; sourceModifiedTime: string; discrepancyNote: string;
  source: { title: string; url: string };
}
export type HubLink = { id: string; title: string; description: string } & (
  { kind: 'source'; sourceId: string } | { kind: 'url'; url: string }
);
export interface LinkHub {
  featured: { eyebrow: string; title: string; dateLabel: string; description: string; links: HubLink[] };
  groups: { id: string; title: string; description: string; links: HubLink[] }[];
}
export interface ClientHub {
  guide: { sourceId: string; title: string; description: string };
  documentSourceIds: string[];
  cards: {
    id: string; title: string; description: string;
    icon: 'meeting' | 'client' | 'proposal';
    actionId?: string; sourceId?: string;
  }[];
  workSourceIds: string[];
}
export interface PersonalSection {
  id: string; title: string; description: string;
  icon: 'spark' | 'heart' | 'book' | 'thought' | 'people' | 'compass' | 'home';
  sourceIds: string[]; actionIds: string[];
}
export interface PersonalSpace {
  assistantActionId?: string;
  day: { description: string; sourceId: string; actionIds: string[] };
  continueItems: { id: string; title: string; description: string; sectionId: string; actionId?: string; sourceId?: string }[];
  sections: PersonalSection[];
  archiveSourceIds: string[];
}
export interface Workspace {
  id: WorkspaceId; name: string; eyebrow: string; description: string;
  tabColor?: 'red' | 'blue' | 'green';
  goal: string; goalLabel: string; updatedAt: string; snapshotAt: string; sources: SourceRef[];
  signals: Signal[]; actions: Action[]; metrics?: MetricsSnapshot; metricsDashboard?: MetricsDashboard; aspects?: WorkspaceAspect[];
  planner?: { url: string; title: string; description: string };
  linkHub?: LinkHub;
  clientHub?: ClientHub;
  personal?: PersonalSpace;
  fileContext?: { hostId: string; environmentId: string; rootPath: string };
}
export interface Overview { workspaces: Workspace[]; generatedAt: string; }
export interface SourceDocument { title: string; path: string; content: string; modifiedAt: string; hostId: string; documentContext?: { threadId: string; rootPath: string; target: { kind: 'workspace'; environmentId: string; path: string } }; }
export interface ActionPreview { prompt: string; title: string; projectId: string; environmentId: string; }
export interface StartedAction { threadId: string; projectId: string; }
