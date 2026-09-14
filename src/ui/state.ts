import { ProviderId } from './providers';

export type Mode = 'idle' | 'settings' | 'checkin' | 'chat';
export type ChatMsg = { role: 'user' | 'assistant'; content: string; error?: boolean };

// Only meaningful for OpenRouter, whose free models cost nothing. Paste a key here
// and testers need no setup. It ships inside the plugin, so treat it as public:
// free models only, never a key with credit on it, and don't commit one.
export const SHARED_KEY = '';

// A single mutable object rather than exported `let` bindings: ES module live
// bindings let an importer read an exported `let`, but never assign to it, and
// every screen needs to flip these in place.
export const state = {
  mode: 'idle' as Mode,
  messages: [] as ChatMsg[],
  loading: false,
  boardItems: [] as string[],
  boardReadAt: 0,
  provider: 'openrouter' as ProviderId,
  storedKey: '',
  // code.ts reads storage over a couple of async hops. Until that lands, seeding
  // the settings form would show an empty key and saving it would wipe the real
  // one, so the form waits.
  settingsLoaded: false,
  draftProvider: 'openrouter' as ProviderId,
  draftKey: '',
};

export function activeKey(): string {
  if (state.storedKey.trim()) return state.storedKey.trim();
  return state.provider === 'openrouter' ? SHARED_KEY.trim() : '';
}
