import { createHash } from 'node:crypto';
import { SVAIB_OAUTH, type OAuthEndpoints } from './oauth';

export const STAGING_API = 'https://api-staging.svaib.com';
export const STAGING_RESOURCE = `${STAGING_API}/bb/v1`;
export const STAGING_CALLBACK_PORT = 49231;

/** Closed contour: changing the client cannot reuse another contour's credentials. */
export function stagingOAuth(clientId: string): OAuthEndpoints {
  const client = clientId.trim();
  return { ...SVAIB_OAUTH, registration: '', clientId: client,
    callbackPort: STAGING_CALLBACK_PORT, resource: STAGING_RESOURCE,
    sessionBinding: createHash('sha256').update(JSON.stringify([
      STAGING_API, SVAIB_OAUTH.authorization, STAGING_RESOURCE, client,
    ])).digest('hex'),
  };
}
