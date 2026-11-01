import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

const hookInput = z.object({ executable: z.string().min(1), cwd: z.string().min(1) }).strict();
const hookReview = z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/), hooks: z.array(z.object({
  key: z.string(), currentHash: z.string(), trustStatus: z.string(), command: z.string(), statusMessage: z.string().nullable(), sourcePath: z.string(),
}).strict()).min(1).max(128) }).strict();

export const browserContract = defineRpcContract({
  automaticHooks: { input: hookInput, output: hookReview.extend({ changed: z.boolean() }).strict() },
  openLogin: {
    input: z.object({ url: z.string().url().refine(value => {
      const url = new URL(value);
      return url.origin === 'https://auth.svaib.com' && !url.username && !url.password;
    }) }).strict(), output: z.null(),
  },
});
