// Connects to the reminders service's SSE stream and dispatches reminders
// to the renderer. NO polling — the SSE channel is the single source of
// truth. Earlier versions also polled /api/reminders every 2s as a fallback,
// but that pinned the main-process event loop at ~30% CPU on idle and
// masked real SSE bugs. Reminders fire in real time when the stream works;
// if the stream is broken, no reminders will surface until it's fixed at
// the backend / proxy layer.
//
// The service URL and bearer token come from AppConfig (settings panel).
import { BrowserWindow } from 'electron';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { IPC, Reminder } from '../../shared/types';

// Reconnect backoff. Some backends (or proxies in front of them) accept
// the SSE connection then immediately close it — without backoff we loop
// 24/7 reconnecting at the maximum rate. Doubles each failure up to a cap.
const SSE_BACKOFF_INITIAL_MS = 1_000;
const SSE_BACKOFF_MAX_MS = 60_000;
// If we receive no bytes (events or keepalive comments) for this long,
// the socket is being held open by something but isn't actually working.
// Tear it down and reconnect. Catches the "reverse-proxy returns 200 then
// closes after its own idle timeout" failure mode — without this we'd sit
// on a zombie connection indefinitely and never recover when the proxy
// hiccups.
const SSE_IDLE_TIMEOUT_MS = 45_000;

let currentConfig: { url: string; token: string } | null = null;
let sseReq: http.ClientRequest | null = null;
let sseStopRequested = false;
let reconnectAttempts = 0;
let idleTimer: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function armIdleTimer(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    console.warn(
      `[reminders] SSE idle for ${SSE_IDLE_TIMEOUT_MS / 1000}s — destroying socket and reconnecting`,
    );
    if (sseReq) {
      try { sseReq.destroy(); } catch { /* ignore */ }
      sseReq = null;
    }
  }, SSE_IDLE_TIMEOUT_MS);
}

function scheduleReconnect(getWindows: () => BrowserWindow[]): void {
  if (sseStopRequested) return;
  const delay = Math.min(
    SSE_BACKOFF_INITIAL_MS * 2 ** reconnectAttempts,
    SSE_BACKOFF_MAX_MS,
  );
  reconnectAttempts++;
  console.log(`[reminders] SSE reconnect in ${delay}ms (attempt #${reconnectAttempts})`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSSE(getWindows);
  }, delay);
}

async function fireOne(
  cfg: { url: string; token: string },
  r: Reminder,
  windows: BrowserWindow[],
): Promise<void> {
  const now = Date.now();
  const delayMs = now - r.fireAt;
  console.log(
    `[reminders] FIRE: id=${r.id} text="${r.text}" delayMs=${delayMs} ` +
    `(fireAt=${new Date(r.fireAt).toISOString()} now=${new Date(now).toISOString()})`,
  );
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send(IPC.REMINDER_FIRED, r);
  }
  // Best-effort DELETE so the backend doesn't re-fire on next connection.
  try {
    await fetch(`${cfg.url}/api/reminders/${encodeURIComponent(r.id)}?userId=local`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
  } catch (err) {
    console.warn('[reminders] DELETE failed for', r.id, err);
  }
}

/** Connect to the SSE endpoint using Node's raw http/https module.
 *  Why not fetch? Electron's bundled undici has an undocumented idle
 *  timeout on streaming response bodies (around 20-30s on no traffic),
 *  which would manifest as the connection being aborted by the client
 *  even though the server thinks it's still open. Using a raw socket
 *  + `response.on('data')` avoids that path entirely.
 *
 *  Authentication: token goes in the Authorization header (the server
 *  accepts this — see remindersd's requireAuth). We also keep ?token=
 *  as a fallback for any reverse proxy that strips Authorization on
 *  upstream requests.
 *
 *  Reconnects with exponential backoff on any failure path. */
function connectSSE(getWindows: () => BrowserWindow[]): void {
  if (!currentConfig || sseStopRequested) return;
  const cfg = currentConfig;

  let parsed: URL;
  try {
    parsed = new URL(`${cfg.url}/api/reminders/stream?userId=local&token=${encodeURIComponent(cfg.token)}`);
  } catch (err) {
    console.warn('[reminders] SSE bad url:', (err as Error).message);
    scheduleReconnect(getWindows);
    return;
  }

  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;
  const connectStartedAt = Date.now();

  console.log(`[reminders] SSE connecting to ${parsed.origin}${parsed.pathname} ...`);

  const req = lib.request({
    method: 'GET',
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.pathname + parsed.search,
    headers: {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Authorization: `Bearer ${cfg.token}`,
    },
  });
  sseReq = req;
  req.setTimeout(0); // we manage idleness ourselves below

  req.on('error', (err) => {
    console.warn(`[reminders] SSE error: ${err.message}`);
  });

  req.on('response', (res) => {
    const connectMs = Date.now() - connectStartedAt;
    if (res.statusCode !== 200) {
      console.warn(`[reminders] SSE HTTP ${res.statusCode} after ${connectMs}ms`);
      try { res.resume(); } catch { /* ignore */ }
      sseReq = null;
      scheduleReconnect(getWindows);
      return;
    }
    console.log(`[reminders] SSE connected in ${connectMs}ms — listening for pushes`);
    // First successful connect (or reconnect) resets backoff so the next
    // disconnect doesn't start at the max delay.
    reconnectAttempts = 0;
    armIdleTimer();

    let buf = '';
    let chunkCount = 0;
    res.setEncoding('utf-8');
    res.on('data', (chunk: string) => {
      chunkCount++;
      // Any received byte resets the idle timer — server keepalive
      // comments (": keepalive\n\n") count.
      armIdleTimer();
      buf += chunk;
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const block of parts) {
        if (!block.includes('event: reminder')) continue;
        const dataLine = block.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) continue;
        try {
          const reminder: Reminder = JSON.parse(dataLine.slice(5).trim());
          console.log(`[reminders] SSE event received after ${chunkCount} chunk(s) since connect`);
          void fireOne(cfg, reminder, getWindows());
        } catch { /* skip malformed */ }
      }
    });
    res.on('end', () => {
      console.log('[reminders] SSE stream ended');
      clearIdleTimer();
      sseReq = null;
      scheduleReconnect(getWindows);
    });
    res.on('close', () => {
      console.log('[reminders] SSE response closed');
      clearIdleTimer();
      sseReq = null;
      scheduleReconnect(getWindows);
    });
  });

  req.end();
}

/** Start (or restart) the SSE connection. No-op if url or token empty.
 *  If config changed since last call, the old connection is torn down
 *  and a fresh one started with reset backoff. */
export function startRemindersScheduler(getWindows: () => BrowserWindow[], url: string, token: string): void {
  const cleanUrl = url.replace(/\/$/, '');
  if (!cleanUrl || !token) {
    if (currentConfig) {
      stopRemindersScheduler();
      currentConfig = null;
    }
    console.log('[reminders] scheduler disabled (empty url or token)');
    return;
  }
  const same = currentConfig?.url === cleanUrl && currentConfig?.token === token;
  if (same && sseReq) return;
  if (sseReq) stopRemindersScheduler();
  currentConfig = { url: cleanUrl, token };
  reconnectAttempts = 0;
  sseStopRequested = false;
  console.log(`[reminders] scheduler started url=${cleanUrl} (SSE only)`);
  connectSSE(getWindows);
}

export function stopRemindersScheduler(): void {
  sseStopRequested = true;
  if (sseReq) {
    try { sseReq.destroy(); } catch { /* ignore */ }
    sseReq = null;
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  clearIdleTimer();
  currentConfig = null;
}

/** Next reminder fire time, for the renderer to show a countdown. */
export function nextDueAt(): number | null {
  // Read from local cache (last SSE payload). The store module's getAll
  // is a plain Map — lazy-import to avoid pulling it on every file load.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getAll } = require('./store') as typeof import('./store');
  const items = getAll().filter((r) => !r.acknowledged);
  if (items.length === 0) return null;
  return items.reduce((min, r) => (r.fireAt < min ? r.fireAt : min), Number.POSITIVE_INFINITY);
}