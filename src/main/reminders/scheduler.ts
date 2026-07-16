// Polls the cross-device reminders service every 60s. The service URL
// and bearer token are passed in as parameters from the caller (read
// from AppConfig.remindersUrl / remindersToken) — not from env vars,
// so the user can configure them through the settings panel.
//
// On each tick:
//   1. fetch GET /api/reminders — if the backend is unreachable, log
//      once and try again next tick. Don't crash.
//   2. replace the local cache with the response.
//   3. for every due + unacknowledged reminder, fire IPC.REMINDER_FIRED
//      to the renderer and DELETE the row from the backend.
//
// A previous tick may have left entries in `acknowledged=true` state if
// the DELETE failed; we don't re-fire those.
import { BrowserWindow } from 'electron';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { IPC, Reminder } from '../../shared/types';
import { getAll, replaceAll, markAcknowledged } from './store';

const POLL_INTERVAL_MS = 2_000;
const FETCH_TIMEOUT_MS = 10_000;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;
let currentConfig: { url: string; token: string } | null = null;
let sseReq: http.ClientRequest | null = null;
let sseStopRequested = false;

async function fetchJson<T>(cfg: { url: string; token: string }, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${cfg.url}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    // Some endpoints (notably DELETE) return 200 with an empty body.
    // .json() on an empty body throws "Unexpected end of JSON input" —
    // check content-length / status before parsing.
    if (res.status === 204) return undefined as unknown as T;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) return undefined as unknown as T;
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    return JSON.parse(text) as T;
  } finally { clearTimeout(t); }
}

async function pull(cfg: { url: string; token: string }, source: 'poll' | 'sse'): Promise<Reminder[]> {
  const startedAt = Date.now();
  const all = await fetchJson<Reminder[]>(cfg, `/api/reminders?userId=local`);
  const elapsed = Date.now() - startedAt;
  console.log(`[reminders] ${source} pull: ${all.length} row(s) in ${elapsed}ms`);
  return all.filter((r) => !r.acknowledged);
}

async function fireOne(
  cfg: { url: string; token: string },
  r: Reminder,
  windows: BrowserWindow[],
  source: 'poll' | 'sse',
): Promise<void> {
  const now = Date.now();
  // Latency breakdown — the user is debugging "reminder arrives late",
  // so we want to know where the time is going:
  //   fireAt → now          = total visible delay (server-side delay included)
  //   now                   = wall clock at fire-time
  const delayMs = now - r.fireAt;
  console.log(
    `[reminders] FIRE via ${source}: id=${r.id} text="${r.text}" ` +
    `delayMs=${delayMs} (fireAt=${new Date(r.fireAt).toISOString()} now=${new Date(now).toISOString()})`,
  );
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send(IPC.REMINDER_FIRED, r);
  }
  markAcknowledged(r.id);
  try {
    await fetchJson(cfg, `/api/reminders/${encodeURIComponent(r.id)}?userId=local`, { method: 'DELETE' });
  } catch (err) {
    console.warn('[reminders] DELETE failed for', r.id, err);
  }
}

async function tick(windows: BrowserWindow[]): Promise<void> {
  if (inFlight || !currentConfig) return;
  inFlight = true;
  try {
    const items = await pull(currentConfig, 'poll');
    replaceAll(items);
    const now = Date.now();
    const due = items.filter((r) => r.fireAt <= now);
    for (const r of due) {
      await fireOne(currentConfig, r, windows, 'poll');
    }
  } catch (err) {
    console.warn('[reminders] tick failed:', (err as Error).message);
  } finally { inFlight = false; }
}

/** Start or restart the polling loop and SSE connection. Config comes
 *  from AppConfig; if url or token is empty the scheduler is a no-op. */
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
  if (same && timer) return;
  if (timer) stopRemindersScheduler();
  currentConfig = { url: cleanUrl, token };

  // SSE connection — real-time push from the backend. EventSource
  // API not available in Node, so we use fetch with streaming.
  connectSSE(getWindows);

  console.log(
    `[reminders] scheduler started url=${cleanUrl} pollEvery=${POLL_INTERVAL_MS}ms ` +
    `fetchTimeout=${FETCH_TIMEOUT_MS}ms`,
  );
  void tick(getWindows());
  timer = setInterval(() => void tick(getWindows()), POLL_INTERVAL_MS);
}

/** Connect to the SSE endpoint. On each event, process the reminder
 *  immediately without waiting for the next poll tick. Reconnects
 *  automatically on disconnect. */
/**
 * Connect to the SSE endpoint using Node's raw http/https module.
 * Why not fetch? Electron's bundled undici has an undocumented idle
 * timeout on streaming response bodies (around 20-30s on no traffic),
 * which would manifest as the connection being aborted by the client
 * even though the server thinks it's still open. Using a raw socket
 * + `response.on('data')` avoids that path entirely.
 *
 * Reconnects on disconnect after 10s. The server sends a keepalive
 * comment line every 20s so the connection stays warm through
 * intermediate proxies.
 */
async function connectSSE(getWindows: () => BrowserWindow[]): Promise<void> {
  if (!currentConfig) return;
  sseStopRequested = false;
  const cfg = currentConfig;

  let parsed: URL;
  try {
    const u = new URL(`${cfg.url}/api/reminders/stream?userId=local&token=${encodeURIComponent(cfg.token)}`);
    parsed = u;
  } catch (err) {
    console.warn('[reminders] SSE bad url:', (err as Error).message);
    if (!sseStopRequested) setTimeout(() => connectSSE(getWindows), 10_000);
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
      // Authorization header is the cleanest form when possible.
      Authorization: `Bearer ${cfg.token}`,
    },
  });
  sseReq = req;
  // 60s total timeout — but we keep reconnecting in the catch below.
  req.setTimeout(0);

  req.on('error', (err) => {
    console.warn(`[reminders] SSE error: ${err.message}`);
  });

  req.on('response', (res) => {
    const connectMs = Date.now() - connectStartedAt;
    if (res.statusCode !== 200) {
      console.warn(`[reminders] SSE HTTP ${res.statusCode} after ${connectMs}ms, retry in 10s`);
      try { res.resume(); } catch { /* ignore */ }
      sseReq = null;
      if (!sseStopRequested) setTimeout(() => connectSSE(getWindows), 10_000);
      return;
    }
    console.log(`[reminders] SSE connected in ${connectMs}ms — listening for pushes`);

    let buf = '';
    let chunkCount = 0;
    res.setEncoding('utf-8');
    res.on('data', (chunk: string) => {
      chunkCount++;
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
          void fireOne(cfg, reminder, getWindows(), 'sse');
        } catch { /* skip malformed */ }
      }
    });
    res.on('end', () => {
      console.log('[reminders] SSE stream ended, retry in 10s');
      sseReq = null;
      if (!sseStopRequested) setTimeout(() => connectSSE(getWindows), 10_000);
    });
    res.on('close', () => {
      console.log('[reminders] SSE response closed, retry in 10s');
      sseReq = null;
      if (!sseStopRequested) setTimeout(() => connectSSE(getWindows), 10_000);
    });
  });

  req.end();
}

export function stopRemindersScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
  sseStopRequested = true;
  if (sseReq) {
    try { sseReq.destroy(); } catch { /* ignore */ }
    sseReq = null;
  }
  currentConfig = null;
}

export function nextDueAt(): number | null {
  const items = getAll().filter((r) => !r.acknowledged);
  if (items.length === 0) return null;
  return items.reduce((min, r) => (r.fireAt < min ? r.fireAt : min), Number.POSITIVE_INFINITY);
}
