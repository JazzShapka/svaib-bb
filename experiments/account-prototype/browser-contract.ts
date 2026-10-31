import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { whoamiIdentitySchema } from './whoami-proof';

export const browserContract = defineRpcContract({
  readCodexWhoami: {
    input: z.object({ sessionId: z.string().uuid(), cwd: z.string().min(1), expectedCallId: z.string().min(1).max(256), configRoot: z.string().min(1).optional() }).strict(),
    output: z.object({ subject: z.string().nullable(), proof: whoamiIdentitySchema.nullable().optional() }).strict(),
  },
  openLogin: {
    input: z.object({ url: z.string().url().refine(value => {
      const url = new URL(value);
      return url.origin === 'https://auth.svaib.com' && !url.username && !url.password;
    }) }).strict(), output: z.null(),
  },
});
