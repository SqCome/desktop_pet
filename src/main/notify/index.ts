// Notify subsystem entry point. Owns the singleton state:
//   - one NotifyBus
//   - one NotifyServer (when enabled)
// `startNotifyServer` is idempotent — calling it twice is a no-op.
// `stopNotifyServer` clears both.
import * as path from 'node:path';
import { BrowserWindow } from 'electron';
import { NotifyServer } from './server';
import { NotifyBus } from './bus';
import { installHooks, uninstallHooks } from './install-hooks';

let server: NotifyServer | null = null;
let bus: NotifyBus | null = null;

const windowsProvider = (): BrowserWindow[] => BrowserWindow.getAllWindows();

export function startNotifyServer(opts: { userDataDir: string }): Promise<void> {
  if (server) {
    console.log('[notify] startNotifyServer: already running');
    return Promise.resolve();
  }
  const portFile = path.join(opts.userDataDir, 'notify.port');
  bus = new NotifyBus(windowsProvider);
  const srv = new NotifyServer({ portFile, bus });
  return srv.start().then(() => {
    server = srv;
  });
}

export function stopNotifyServer(): Promise<void> {
  const s = server;
  if (!s) return Promise.resolve();
  server = null;
  bus = null;
  return s.stop();
}

export function isNotifyRunning(): boolean {
  return server !== null;
}

/**
 * Internal: the IPC test handler in index.ts dispatches synthetic payloads
 * through the same bus the real server uses. Returns null if disabled.
 */
export function _getNotifyBus(): NotifyBus | null {
  return bus;
}

export { installHooks, uninstallHooks };