// Local cache of reminders pulled from the Go backend (remindersd).
// Lives at userData/reminders-cache.json. The cache is the source of
// truth for "did we already fire this reminder?" — even if the backend
// is unreachable, the desktop side can still consult acknowledged
// flags locally to avoid double-firing.
import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Reminder } from '../../shared/types';

const CACHE_FILENAME = 'reminders-cache.json';
const SCHEMA_VERSION = 1;

interface CacheFile {
  version: number;
  /** ms epoch. Updated every time we pull from the backend. */
  lastSyncAt: number;
  items: Reminder[];
}

let cache: CacheFile | null = null;

function cachePath(): string {
  return path.join(app.getPath('userData'), CACHE_FILENAME);
}

/** Read the cache file once and cache it in-process. Returns an empty
 *  default when the file is missing or unreadable. */
export function loadCache(): CacheFile {
  if (cache) return cache;
  const file = cachePath();
  try {
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<CacheFile>;
      if (parsed.version !== SCHEMA_VERSION) {
        // Future-proof: when the on-disk shape evolves, add a migration.
        // For v1 there's nothing to do.
        console.warn(`[reminders] unknown cache schema v${parsed.version}, ignoring file`);
        cache = { version: SCHEMA_VERSION, lastSyncAt: 0, items: [] };
        return cache;
      }
      cache = {
        version: SCHEMA_VERSION,
        lastSyncAt: typeof parsed.lastSyncAt === 'number' ? parsed.lastSyncAt : 0,
        items: Array.isArray(parsed.items) ? parsed.items : [],
      };
      return cache;
    }
  } catch (err) {
    console.error('[reminders] failed to load cache, starting empty:', err);
  }
  cache = { version: SCHEMA_VERSION, lastSyncAt: 0, items: [] };
  return cache;
}

/** Atomic-ish write: tmp file + rename. */
function persist(state: CacheFile): void {
  cache = state;
  const file = cachePath();
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error('[reminders] failed to save cache:', err);
  }
}

export function getAll(): Reminder[] {
  return loadCache().items;
}

export function getLastSyncAt(): number {
  return loadCache().lastSyncAt;
}

/** Replace the entire local view with a fresh pull from the backend.
 *  Updates lastSyncAt to now. */
export function replaceAll(items: Reminder[]): void {
  persist({
    version: SCHEMA_VERSION,
    lastSyncAt: Date.now(),
    items,
  });
}

/** Mark a single reminder as acknowledged in the local cache so a
 *  second tick of the scheduler doesn't re-fire it. Does NOT touch
 *  the backend — the caller is responsible for DELETEing the row. */
export function markAcknowledged(id: string): void {
  const state = loadCache();
  const next = state.items.map((r) =>
    r.id === id ? { ...r, acknowledged: true } : r,
  );
  persist({ ...state, items: next });
}
