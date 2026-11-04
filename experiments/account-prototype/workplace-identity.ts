import { z } from 'zod';

// Existing saved ready receipts are readable compatibility data only. New
// connections use cabinet OAuth and the native MCP observation independently.
const time = z.number().int().nonnegative();
export const legacyVerifiedReceiptSchema = z.object({ verified: z.literal(true), account_id: z.string().regex(/^acct_[A-Za-z0-9_-]+$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/), issuer_client_id: z.string().min(1).max(512), verifier_client_id: z.string().min(1).max(512),
  issued_at: time, expires_at: time }).strict();
export type WorkplaceIdentity = { account_id: string; client_id: string; epoch: number };
