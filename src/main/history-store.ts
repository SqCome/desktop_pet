// Persistent chat-history store. Lives in userData/chat-history.json —
// separate from config.json because:
//
//   1. config.json is tiny user preferences (alwaysOnTop, baseUrl, ...)
//   2. chat-history grows with every conversation — up to 50 turns
//   3. We don't want config migrations to be triggered by chat edits
//
// Persistence is whole-file, synchronous JSON. Volume is small
// (a few KB at most) and write frequency is one round-trip per turn,
// so atomic-rename semantics are not necessary.
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChatMessage } from '../shared/types';

const HISTORY_FILENAME = 'chat-history.json';

/** Schema version for the history file. Bump when the on-disk shape
 *  changes in a way that needs migration. */
const HISTORY_SCHEMA_VERSION = 1;

interface HistoryFile {
  version: number;
  lastChatAt: number;
  messages: ChatMessage[];
}

let cache: HistoryFile | null = null;

function historyPath(): string {
  return path.join(app.getPath('userData'), HISTORY_FILENAME);
}

/** Read the history file once and cache it. Returns an empty default
 *  when the file is missing or unreadable — first-launch users see a
 *  fresh state, and a corrupt file just falls back rather than
 *  blocking the chat. */
export function loadHistory(): HistoryFile {
  if (cache) return cache;
  const file = historyPath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<HistoryFile>;
      // Future-proof: if the file is from an older schema, migrate.
      // For v1 there's nothing to do, but the hook is here for when
      // the shape evolves.
      if (parsed.version !== HISTORY_SCHEMA_VERSION) {
        console.warn(`[history] unknown schema v${parsed.version}, ignoring file`);
        cache = { version: HISTORY_SCHEMA_VERSION, lastChatAt: 0, messages: [] };
        return cache;
      }
      cache = {
        version: HISTORY_SCHEMA_VERSION,
        lastChatAt: typeof parsed.lastChatAt === 'number' ? parsed.lastChatAt : 0,
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      };
      return cache;
    }
  } catch (err) {
    console.error('[history] failed to load, falling back to empty:', err);
  }
  cache = { version: HISTORY_SCHEMA_VERSION, lastChatAt: 0, messages: [] };
  return cache;
}

/** Atomic-ish write: write to a sibling temp file then rename over the
 *  real one. Avoids a torn JSON if the process is killed mid-write. */
function persist(state: HistoryFile): void {
  cache = state;
  const file = historyPath();
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[history] failed to save:', err);
  }
}

export function getMessages(): ChatMessage[] {
  return loadHistory().messages;
}

export function getLastChatAt(): number {
  return loadHistory().lastChatAt;
}

/** Append a batch of messages and persist. Caps at 50 turns. The
 *  `lastChatAt` is set to now. */
export function appendMessages(msgs: ChatMessage[]): void {
  const state = loadHistory();
  state.messages.push(...msgs);
  if (state.messages.length > 50) {
    state.messages.splice(0, state.messages.length - 50);
  }
  state.lastChatAt = Date.now();
  persist(state);
}

/** Drop the entire conversation and reset the idle clock. Used when
 *  the session timeout fires. */
export function clearHistory(): void {
  persist({ version: HISTORY_SCHEMA_VERSION, lastChatAt: Date.now(), messages: [] });
}
