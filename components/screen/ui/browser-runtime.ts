import { z } from 'zod';

// Shared UI must run under CSP without eval or runtime code generation.
z.config({ jitless: true });
