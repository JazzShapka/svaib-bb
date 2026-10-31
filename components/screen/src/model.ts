import { z } from 'zod';
import { scaffoldConfigSchema, scaffoldConfirmationSchema, scaffoldCatalog, type ScaffoldConfirmation } from './scaffold';

export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const text = z.string().min(1).max(2000);
const source = z.object({ title: text, ref: z.string().max(1000) }).strict();
const task = z.object({
  id: idSchema, title: text, owner: text, status: z.enum(['active', 'backlog', 'done']), source,
}).strict();
export const blockSchema = z.discriminatedUnion('type', [
  z.object({ id: idSchema, type: z.literal('note'), version: z.literal(1), title: text, text }).strict(),
  z.object({ id: idSchema, type: z.literal('tasks'), version: z.literal(1), title: text,
    items: z.array(task).max(200) }).strict(),
  z.object({ id: idSchema, type: z.literal('scaffold'), version: z.literal(1), title: text, config: scaffoldConfigSchema }).strict(),
  z.object({ id: idSchema, type: z.literal('chart'), version: z.literal(1), title: text,
    unit: z.string().max(40), source, verifiedAt: z.iso.datetime(),
    points: z.array(z.object({ label: text, value: z.number().finite().nullable(),
      plan: z.number().finite().nullable().optional() }).strict()).min(1).max(60),
  }).strict(),
]);
export const documentSchema = z.object({
  schemaVersion: z.literal(1), title: text, description: text,
  layout: z.enum(['stack', 'columns']), blocks: z.array(blockSchema).min(1).max(20),
}).strict().superRefine((document, ctx) => {
  const blockIds = document.blocks.map(block => block.id);
  const taskIds = document.blocks.flatMap(block => block.type === 'tasks' ? block.items.map(task => task.id) : []);
  if (new Set(blockIds).size !== blockIds.length || new Set(taskIds).size !== taskIds.length) {
    ctx.addIssue({ code: 'custom', message: 'ID компонентов и задач должны быть уникальны в экране.' });
  }
});
export type ScreenDocument = z.infer<typeof documentSchema>;
export type Block = z.infer<typeof blockSchema>;
export const requestIdSchema = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/);
export const createSchema = z.object({ id: idSchema, requestId: requestIdSchema, document: documentSchema }).strict();
export const updateSchema = z.object({ id: idSchema, requestId: requestIdSchema,
  expectedRevision: z.number().int().positive(), document: documentSchema }).strict();
export const submitSchema = z.object({ id: idSchema, requestId: requestIdSchema,
  expectedRevision: z.number().int().positive(), selectedIds: z.array(idSchema).max(200) }).strict();
export const confirmScaffoldSchema = z.object({ id: idSchema, requestId: requestIdSchema, expectedRevision: z.number().int().positive(), blockId: idSchema }).strict();
export type ScreenEvent = { seq: number; type: 'created' | 'updated' | 'submitted' | 'scaffold-confirmed';
  revision: number; at: string; selectedIds?: string[]; confirmation?: ScaffoldConfirmation };
export type Screen = { id: string; revision: number; document: ScreenDocument;
  updatedAt: string; submission: { selectedIds: string[]; revision: number; at: string } | null; scaffoldConfirmation?: ScaffoldConfirmation | null };
export const screenSchema = z.object({ id: idSchema, revision: z.number().int().positive(), document: documentSchema,
  updatedAt: z.iso.datetime(), submission: z.object({ selectedIds: z.array(idSchema), revision: z.number().int().positive(), at: z.iso.datetime() }).nullable(), scaffoldConfirmation: scaffoldConfirmationSchema.nullable().optional() }).strict();
export type Mutation = { screen: Screen; appliedRevision: number; event: ScreenEvent; replayed: boolean };
export type EventPage = { events: ScreenEvent[]; cursor: number; screen: Screen; historyStart: number; truncated: boolean };

export const catalog = {
  schemaVersion: 1,
  components: [
    { type: 'note', version: 1, description: 'Текстовое пояснение' },
    { type: 'tasks', version: 1, description: 'Задачи, локальный фильтр и выбор для передачи агенту' },
    { type: 'chart', version: 1, description: 'График факт/план; пропуск не подменяется нулём; таблица значений' },
    { type: 'scaffold', version: 1, description: 'Конструктор каркаса, семантический JSON и подтверждение конкретной ревизии структуры' },
  ],
  scaffold: scaffoldCatalog,
  documentSchema: z.toJSONSchema(documentSchema, { unrepresentable: 'any' }),
};
