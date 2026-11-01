import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const browserContract = defineRpcContract({
  openLogin: {
    input: z.object({ url: z.string().url().refine(value => {
      const url = new URL(value);
      return url.origin === 'https://auth.svaib.com' && !url.username && !url.password;
    }) }).strict(), output: z.null(),
  },
});
