import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { registerAccountModule } from './account-module';
import { STAGING_API, stagingOAuth } from './configuration';
export { rpcContract, registerAccountModule } from './account-module';

/** Existing standalone staging registration and settings keep their old identity. */
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    stagingClientId: { type: 'string', label: 'OAuth client ID тестового контура (после настройки перезагрузи плагин)', default: 'svaib-bb-staging' },
    oauthSession: { type: 'string', label: 'Подключение svaib (служебное, не редактировать)', secret: true },
  });
  const { stagingClientId } = await settings.get();
  await registerAccountModule(bb, {
    sessionStore: {
      read: async () => (await settings.get()).oauthSession ?? '',
      write: async value => { await settings.experimental_set({ oauthSession: value || null }); },
    },
    oauthEndpoints: stagingOAuth(stagingClientId), apiBase: STAGING_API,
  });
}
