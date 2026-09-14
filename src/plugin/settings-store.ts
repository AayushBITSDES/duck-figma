export const STORE = 'duckSettings';
// Key names earlier builds used, before settings moved into one object. Each
// names a provider the plugin still supports, so they are migrated rather than
// dropped, and only deleted once the new settings have actually been written.
export const LEGACY_KEYS: [string, string][] = [
  ['openrouterApiKey', 'openrouter'],
  ['openaiApiKey', 'openai'],
  ['anthropicApiKey', 'anthropic'],
];

export async function loadSettings() {
  const settings = { provider: 'openrouter', key: '' };
  try {
    const stored = await figma.clientStorage.getAsync(STORE);
    if (stored) {
      // Settings exist, so they are the truth, including a key the user
      // deliberately cleared. Never second-guess that with an older value.
      if (stored.provider) settings.provider = stored.provider;
      // `keys` is the per-provider shape an earlier build on this branch used.
      settings.key = stored.key || (stored.keys && stored.keys[settings.provider]) || '';
    } else {
      // Nothing saved yet: adopt a key an older build left behind.
      for (const entry of LEGACY_KEYS) {
        const legacy = await figma.clientStorage.getAsync(entry[0]);
        if (typeof legacy === 'string' && legacy.trim()) {
          settings.provider = entry[1];
          settings.key = legacy.trim();
          break;
        }
      }
      if (settings.key) await figma.clientStorage.setAsync(STORE, settings);
    }
    // Either way the old names are no longer read, so don't leave the secrets
    // sitting there. Failing here is harmless; nothing depends on them now.
    for (const entry of LEGACY_KEYS) await figma.clientStorage.deleteAsync(entry[0]);
  } catch (e) {
    // Fall through with the defaults; the UI just shows an empty key field.
  }
  figma.ui.postMessage({ type: 'settings', settings });
}

// A save carries the whole of the settings, so there is nothing to merge onto
// and nothing for two saves to race over.
export function saveSettings(provider: string, key: string) {
  figma.clientStorage
    .setAsync(STORE, { provider, key: key || '' })
    .catch(() => figma.notify("Couldn't save your settings."));
}
