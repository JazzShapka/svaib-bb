import { createHash } from 'node:crypto';
import { z } from 'zod';
import { idSchema, requestIdSchema, type Screen, type ScreenDocument } from './model';
import { ScreenClient } from './client';
import { Refusal } from './store';
import { scaffoldCatalog } from './scaffold';
import { toTreeConfig } from './scaffold-tree';

export const openSchema = z.object({
  id: idSchema,
  preset: z.literal('space-setup').optional(),
  create: z.object({ requestId: requestIdSchema, companyName: z.string().trim().min(1).max(100) }).strict().optional(),
}).strict();
export const resultSchema = z.object({ id: idSchema }).strict();

// This factory has no company examples, local paths, credentials or filesystem effects.
export function spaceSetupDocument(companyName: string): ScreenDocument {
  const config = toTreeConfig({ schemaVersion: 1, catalogVersion: scaffoldCatalog.version,
    canonSnapshot: scaffoldCatalog.canonSnapshot, companyName, companyKit: [], nodes: [] });
  return { schemaVersion: 1, title: 'Настройка пространства',
    description: 'Согласуйте первоначальный каркас пространства и передайте структуру партнёру.',
    layout: 'stack', blocks: [{ id: 'space-setup', type: 'scaffold', version: 1,
      title: 'Первый каркас пространства', config }] };
}

function scaffold(screen: Screen) {
  const blocks = screen.document.blocks;
  if (blocks.length !== 1 || blocks[0].type !== 'scaffold') {
    return null;
  }
  return blocks[0];
}

function describe(client: ScreenClient, screen: Screen, cursor: number) {
  const block = scaffold(screen);
  return { id: screen.id, revision: screen.revision, cursor,
    status: screen.scaffoldConfirmation ? 'confirmed' as const : screen.submission ? 'submitted' as const : 'pending' as const,
    browserUrl: `${client.base}/?screen=${encodeURIComponent(screen.id)}`,
    ...(block ? { catalogVersion: block.config.catalogVersion, canonSnapshot: block.config.canonSnapshot } : {}),
    applicationStatus: 'not-tracked' as const };
}

export async function openScreen(client: ScreenClient, input: unknown) {
  const data = openSchema.parse(input);
  let replayed: boolean | null = null;
  if (data.create) {
    const result = await client.create({ id: data.id, requestId: data.create.requestId,
      document: spaceSetupDocument(data.create.companyName) });
    replayed = result.replayed;
  }
  const { screen, cursor } = await client.snapshot(data.id);
  return { ...describe(client, screen, cursor), mode: data.create ? 'create' as const : 'resume' as const,
    replayed, screen };
}

export async function screenResult(client: ScreenClient, input: unknown) {
  const { id } = resultSchema.parse(input);
  const { screen, cursor } = await client.snapshot(id);
  const block = scaffold(screen);
  const descriptor = { ...describe(client, screen, cursor), screen,
    intent: block?.config ?? null, submission: screen.submission };
  const confirmation = screen.scaffoldConfirmation;
  if (!confirmation) return { ...descriptor, confirmation: null };
  const confirmedBlock = screen.document.blocks.find(item => item.type === 'scaffold' && item.id === confirmation.blockId);
  if (!confirmedBlock || confirmedBlock.type !== 'scaffold')
    throw new Refusal('invalid_confirmation', 'Переданное намерение не соответствует текущему экрану. Нужна проверка состояния.');
  const hash = createHash('sha256').update(JSON.stringify({ config: confirmedBlock.config, plan: confirmation.plan })).digest('hex');
  if (confirmation.revision !== screen.revision ||
      confirmation.planHash !== hash || JSON.stringify(confirmation.config) !== JSON.stringify(confirmedBlock.config) ||
      (confirmedBlock.config.schemaVersion === 2 && confirmedBlock.config.overview && confirmation.plan !== null)) {
    throw new Refusal('invalid_confirmation', 'Подтверждение не соответствует текущему каркасу. Нужна проверка состояния.');
  }
  return { ...descriptor, confirmation };
}
