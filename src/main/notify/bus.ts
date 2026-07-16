// Dedup + fan-out for incoming hook notifications.
//
// Dedup window: same (sessionId, kind) within 2s is dropped. Claude Code can
// retry the same hook on transient errors; we don't want the pet to wiggle
// three times in a row.
import { BrowserWindow } from 'electron';
import { IPC, NotifyPayload } from '../../shared/types';

const DEDUP_WINDOW_MS = 2000;

type Key = string;

interface RecentFire {
  at: number;
}

export class NotifyBus {
  private recent = new Map<Key, RecentFire>();

  constructor(private windows: () => BrowserWindow[]) {}

  /**
   * Send `p` to every live BrowserWindow, unless the same sessionId+kind
   * fired within DEDUP_WINDOW_MS.
   */
  dispatch(p: NotifyPayload): void {
    const key: Key = `${p.sessionId}:${p.kind}`;
    const prev = this.recent.get(key);
    const now = Date.now();
    if (prev && now - prev.at < DEDUP_WINDOW_MS) {
      console.log(`[notify] dedup ${key} (${now - prev.at}ms ago)`);
      return;
    }
    this.recent.set(key, { at: now });

    for (const w of this.windows()) {
      if (w.isDestroyed()) continue;
      w.webContents.send(IPC.NOTIFY_SHOW, p);
    }
  }
}