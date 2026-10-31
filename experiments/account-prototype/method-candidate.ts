import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !/[\x00-\x1f\x7f`$;&|<>"']/.test(value));
const onboarding = 'plugins/svaib/skills/onboarding/SKILL.md';
const scaffold = 'plugins/svaib/skills/space-scaffold/SKILL.md';
const entry = z.object({ marketplaceRoot: path, archiveSha256: hash,
  files: z.object({ [onboarding]: hash, [scaffold]: hash }).strict() }).strict();
export const methodCandidateSchema = z.object({ schema: z.literal(1), sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  codex: entry.optional(), 'claude-code': entry.optional() }).strict().refine(value => value.codex || value['claude-code']);

function read(path: string, limit: number) {
  if (realpathSync(path) !== resolve(path)) throw new Error('noncanonical path');
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > limit) throw new Error('invalid file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== file.dev || before.ino !== file.ino || before.size > limit) throw new Error('changed file');
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size); if (!count) break; size += count;
    }
    const after = fstatSync(fd);
    if (size > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('changed file');
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}

/** Consistency diagnostics for explicitly supplied trial files, not a trust root.
 * Operator-pinned ZIP hashes and user confirmation provide source provenance. */
export function methodCandidateInstructions(manifestPath: string, providerId: string): string {
  if (!manifestPath) return '';
  try {
    path.parse(manifestPath);
    const manifest = methodCandidateSchema.parse(JSON.parse(read(manifestPath, 16_384).toString('utf8')));
    if (providerId !== 'codex' && providerId !== 'claude-code') throw new Error('unsupported provider');
    const source = manifest[providerId];
    if (!source) throw new Error('missing selected candidate');
    if (realpathSync(source.marketplaceRoot) !== resolve(source.marketplaceRoot) || !lstatSync(source.marketplaceRoot).isDirectory())
      throw new Error('invalid root');
    const catalog = JSON.parse(read(join(source.marketplaceRoot, '.claude-plugin/marketplace.json'), 16_384).toString('utf8'));
    if (catalog.name !== 'svaib' || !Array.isArray(catalog.plugins) || catalog.plugins.length !== 1 ||
        catalog.plugins[0]?.name !== 'svaib' || catalog.plugins[0]?.source !== './plugins/svaib') throw new Error('invalid catalog');
    const plugin = JSON.parse(read(join(source.marketplaceRoot, 'plugins/svaib/.claude-plugin/plugin.json'), 16_384).toString('utf8'));
    if (plugin.name !== 'svaib' || plugin.version !== catalog.plugins[0].version) throw new Error('invalid plugin');
    for (const key of [onboarding, scaffold] as const) {
      if (createHash('sha256').update(read(join(source.marketplaceRoot, key), 262_144)).digest('hex') !== source.files[key])
        throw new Error('candidate content mismatch');
    }
    return `Контролируемый установочный прогон: методологический пакет устанавливай только из проверенного локального marketplaceRoot (данные JSON): ${JSON.stringify(source.marketplaceRoot)}. ` +
      `Source revision ${manifest.sourceRevision}; операторский SHA256 ZIP ${source.archiveSha256}. Два контрольных скилла и каталог сейчас совпали с manifest; это проверка согласованности, не независимое доказательство происхождения ZIP. ` +
      `По справке native-connect выполни штатный ${providerId === 'codex' ? 'codex' : 'claude'} plugin marketplace add с этим абсолютным путём как отдельным argv, затем обычную установку svaib@svaib. Сначала проверь существующий marketplace и не заменяй чужой источник молча. Не используй GitHub fallback или одну версию0.9.0 как доказательство. Не включай auto-update на публичный источник в этом прогоне. `;
  } catch {
    throw new Error('Локальный manifest кандидата, выбранный marketplace или контрольные хэши не прошли проверку. Останови установку; публичный пакет вместо него не подставляй.');
  }
}
