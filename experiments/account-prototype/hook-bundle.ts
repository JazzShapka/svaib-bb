/** Only Codex's installed svaib plugin identity is eligible for automatic trust. */
export const SVAIB_PLUGIN_ID = 'svaib@svaib';
export const HOOK_TOOL = 'svaib_codex_hooks';
export const isSvaibHook = (item: { pluginId?: unknown }) => item.pluginId === SVAIB_PLUGIN_ID;
