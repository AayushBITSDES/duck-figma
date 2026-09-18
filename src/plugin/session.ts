import { SESSION_LIMITS } from '../shared/protocol';

// Document-scoped opaque room token. Never figma.fileKey: that value is
// guessable, and this demo has no account auth. Stored on the root so every
// plugin instance in this file reads the same capability after collab sync.
export const ROOM_PLUGIN_DATA_KEY = 'duckRoomId';
export const ROOM_ID_PREFIX = 'room:';
// Per-machine identity, not per file. The Worker keys presence on this.
export const CLIENT_STORAGE_KEY = 'duckClientId';

const FALLBACK_NAME = 'Anonymous';

let postedRoomId = '';
let postedClientId = '';
let watchingRoomRace = false;

function mintUuid(): string {
  // The plugin sandbox does not expose crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const n = (Math.random() * 16) | 0;
    const v = ch === 'x' ? n : (n & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function displayName(): string {
  try {
    const raw = (figma.currentUser && figma.currentUser.name) || '';
    const name = raw.trim();
    if (!name) return FALLBACK_NAME;
    return name.slice(0, SESSION_LIMITS.maxDisplayNameLength);
  } catch {
    // currentuser permission missing, or Figma returned something unreadable.
    return FALLBACK_NAME;
  }
}

export function resolveRoomId(): string {
  const existing = figma.root.getPluginData(ROOM_PLUGIN_DATA_KEY);
  if (existing) return ROOM_ID_PREFIX + existing;

  const minted = mintUuid();
  figma.root.setPluginData(ROOM_PLUGIN_DATA_KEY, minted);
  return ROOM_ID_PREFIX + (figma.root.getPluginData(ROOM_PLUGIN_DATA_KEY) || minted);
}

function isClientId(value: string): boolean {
  return /^[A-Za-z0-9-]{8,64}$/.test(value);
}

export async function loadClientId(): Promise<string> {
  try {
    const stored = await figma.clientStorage.getAsync(CLIENT_STORAGE_KEY);
    if (typeof stored === 'string' && isClientId(stored.trim())) return stored.trim();
    const minted = mintUuid();
    try {
      await figma.clientStorage.setAsync(CLIENT_STORAGE_KEY, minted);
    } catch {
      // This session still has an id; the next boot will mint another.
    }
    return minted;
  } catch {
    return mintUuid();
  }
}

function postSession() {
  figma.ui.postMessage({
    type: 'session',
    roomId: postedRoomId,
    clientId: postedClientId,
    displayName: displayName(),
  });
}

// Two first-opens can mint two UUIDs before pluginData syncs. Once a remote
// write lands, reconnect to the surviving id. This is the room capability,
// so it runs for saved and unsaved files alike.
function watchRoomRace() {
  if (watchingRoomRace) return;
  watchingRoomRace = true;
  figma.on('documentchange', (e: DocumentChangeEvent) => {
    if (!postedRoomId.startsWith(ROOM_ID_PREFIX)) return;
    let remote = false;
    for (let i = 0; i < e.documentChanges.length; i++) {
      if (e.documentChanges[i].origin === 'REMOTE') {
        remote = true;
        break;
      }
    }
    if (!remote) return;
    const next = resolveRoomId();
    if (next === postedRoomId) return;
    postedRoomId = next;
    postSession();
  });
}

export function bootSession(): Promise<void> {
  return loadClientId()
    .then((clientId) => {
      postedClientId = clientId;
      postedRoomId = resolveRoomId();
      postSession();
      watchRoomRace();
    })
    .catch(() => {
      postedClientId = mintUuid();
      postedRoomId = resolveRoomId();
      postSession();
      watchRoomRace();
    });
}
