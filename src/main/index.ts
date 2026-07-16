// App entry. Wires together:
//   - single-instance lock (so launching twice just focuses the existing pet)
//   - the transparent pet window
//   - tray + menu
//   - IPC handlers for config, chat, and the drag/click-through signals
//
// Note: we *don't* quit when the pet window closes — closing the window only
// hides it; the tray icon keeps the app alive. Quitting happens via the tray
// "退出" entry, which calls `app.exit(0)` explicitly.
import { app, ipcMain, BrowserWindow } from 'electron';
import { createPetWindow, getPetWindow, centerPetWindow, resizePetWindow, snapshotPetBounds, restorePetBounds } from './window';
import { createTray, disposeTray } from './tray';
import { loadConfig, updateConfig } from './storage';
import { streamChat, _stripThink } from './llm/client';
import {
  getMessages as getHistoryMessages,
  getLastChatAt,
  appendMessages as appendHistory,
  clearHistory as clearHistoryStore,
} from './history-store';
import {
  getAll as getCachedReminders,
  replaceAll as replaceCachedReminders,
} from './reminders/store';
import {
  startRemindersScheduler,
  stopRemindersScheduler,
} from './reminders/scheduler';
import { IPC, ChatMessage, PetBounds, Reminder } from '../shared/types';

// Workaround: some Windows GPU drivers crash Chromium's GPU process when
// `transparent: true` is combined with hardware-accelerated compositing
// (manifests as "GPU process exited unexpectedly: exit_code=143"). Disabling
// GPU acceleration forces software rendering, which trades a bit of battery
// for a window that actually paints. To re-enable, set PET_GPU=1.
if (process.env.PET_GPU !== '1') {
  app.disableHardwareAcceleration();
}

// Single-instance lock.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = getPetWindow();
    if (win) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
  });

  app.whenReady().then(boot);
}

function boot() {
  // Don't show in the Dock on macOS — the pet feels more like a "thing on the
  // desktop" that way. (On Windows this is a no-op.)
  if (process.platform === 'darwin') {
    app.dock?.hide();
  }

  createPetWindow();
  createTray(getPetWindow);

  registerIpc();

  // Polls the cross-device reminders service (configurable via the
  // settings panel → remindersUrl / remindersToken) and pushes due
  // reminders to all open BrowserWindows as chat bubbles. No-op if
  // the URL or token is empty — dev machines without a backend still
  // get to test chat.
  const remCfg = loadConfig();
  startRemindersScheduler(
    () => BrowserWindow.getAllWindows(),
    remCfg.remindersUrl,
    remCfg.remindersToken,
  );

  app.on('window-all-closed', (e: Electron.Event) => {
    // Prevent default quit on non-macOS — keep running in the tray.
    e.preventDefault();
  });

  app.on('before-quit', () => {
    stopRemindersScheduler();
    disposeTray();
  });
}

// One active chat stream at a time. If the user fires a new message while
// one is in flight, we abort the previous one.
let currentAbort: AbortController | null = null;

// Session timeout: if the user goes idle for this long, the next message
// starts a "fresh" conversation. The threshold is read against the
// persistent `lastChatAt` so the timer survives app restarts — a user
// who chatted yesterday and opens the app today will get the "memory
// wiped" prompt on their first message of the new day.
const SESSION_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

// Interactive-lock state. The renderer asks to "lock" interaction while a
// floating panel (context menu, chat input) is visible. While at least one
// lock is held, we keep the window interactive (events flow into the
// renderer) regardless of mouseenter/leave. This prevents the menu from
// going dead the instant the cursor moves outside the pet canvas.
//
// `interactiveLocks` is a Set so multiple panels can each hold a lock.
const interactiveLocks = new Set<string>();
let interactiveForced = false; // last applied state
function refreshInteractive(): void {
  const win = getPetWindow();
  if (!win) return;
  // Window is interactive iff the cursor is over the pet OR a lock is held.
  // We don't track cursor state here — renderer tells us via PET_INTERACTION.
  // Locks only FORCE interactive = true; the renderer is still in charge
  // of saying "cursor left, go back to click-through" when no locks are held.
  const wanted = interactiveLocks.size > 0;
  if (wanted && !interactiveForced) {
    win.setIgnoreMouseEvents(false, { forward: false });
    interactiveForced = true;
  } else if (!wanted && interactiveForced) {
    // Restore click-through; renderer's next PET_INTERACTION message will
    // re-enable it if the cursor is over the pet.
    win.setIgnoreMouseEvents(true, { forward: true });
    interactiveForced = false;
  }
}

function registerIpc() {
  ipcMain.handle(IPC.CONFIG_GET, () => loadConfig());
  ipcMain.handle(IPC.CONFIG_SET, (_e, patch) => {
    const next = updateConfig(patch);
    // If the reminders config changed, restart the scheduler so the
    // new URL / token takes effect immediately without a restart.
    if (patch.remindersUrl !== undefined || patch.remindersToken !== undefined) {
      startRemindersScheduler(
        () => BrowserWindow.getAllWindows(),
        next.remindersUrl,
        next.remindersToken,
      );
    }
    return next;
  });

  // Reminders: renderer can read the local cache (last-synced view) and
  // can ask main to add / remove a reminder on the backend. Writes go
  // through main because the bearer token and URL are read from
  // AppConfig (set in the settings panel) and never cross the preload
  // bridge — only the renderer→main surface.
  ipcMain.handle(IPC.REMINDERS_LIST, () => getCachedReminders());
  ipcMain.handle(IPC.REMINDERS_ADD, async (_e, body: { text: string; fireAt: number }) => {
    const cfg = loadConfig();
    const url = cfg.remindersUrl?.replace(/\/$/, '');
    const token = cfg.remindersToken;
    if (!url || !token) throw new Error('Reminders 服务未配置,请在 ⚙ 设置中填写 URL 和 Token');
    const r: Reminder = {
      id: `r${Date.now()}`,
      userId: 'local',
      text: body.text,
      fireAt: body.fireAt,
      recurring: 'none',
      acknowledged: false,
      createdAt: Date.now(),
    };
    const res = await fetch(`${url}/api/reminders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(r),
    });
    if (!res.ok) throw new Error(`REMINDERS_ADD HTTP ${res.status}`);
    return r;
  });
  ipcMain.handle(IPC.REMINDERS_REMOVE, async (_e, id: string) => {
    const cfg = loadConfig();
    const url = cfg.remindersUrl?.replace(/\/$/, '');
    const token = cfg.remindersToken;
    if (!url || !token) throw new Error('Reminders 服务未配置,请在 ⚙ 设置中填写 URL 和 Token');
    const res = await fetch(
      `${url}/api/reminders/${encodeURIComponent(id)}?userId=local`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`REMINDERS_REMOVE HTTP ${res.status}`);
  });

  ipcMain.handle(IPC.CHAT_STOP, () => {
    currentAbort?.abort();
    currentAbort = null;
  });

  ipcMain.handle(IPC.CHAT_HISTORY, () => getHistoryMessages());

  ipcMain.handle(IPC.CHAT_SEND, async (e, text: string) => {
    const sender = e.sender as Electron.WebContents;
    const cfg = loadConfig().llm;

    // Session timeout: if the user has been idle for SESSION_IDLE_TIMEOUT_MS
    // and we have prior history, drop it and surface a bubble so the user
    // knows the pet is starting fresh. lastChatAt is read from the
    // persistent history store so the timer survives app restarts.
    const now = Date.now();
    const priorMessages = getHistoryMessages();
    const lastChatAt = getLastChatAt();
    if (
      priorMessages.length > 0 &&
      lastChatAt > 0 &&
      now - lastChatAt > SESSION_IDLE_TIMEOUT_MS
    ) {
      clearHistoryStore();
      sender.send(IPC.SESSION_RESET);
    }

    // Append the user turn to persistent history. The store caps at 50
    // turns and stamps lastChatAt = now for the next idle check.
    const userMsg: ChatMessage = {
      id: String(now),
      role: 'user',
      content: text,
      ts: now,
    };
    appendHistory([userMsg]);

    currentAbort?.abort();
    currentAbort = new AbortController();

    const MAX_REPLY_CHARS = 4000; // hard cap; longer replies are discarded
    let reply = '';

    // Multi-turn chat: send the last MAX_HISTORY_TURNS user/assistant
    // pairs as prior context, then the current user turn. The cap keeps
    // request size small — the pet is a quick-chat companion, not a deep
    // reasoning partner. LLM client.ts strips any leaked ``<think>`` tags
    // from history entries as a defense in depth.
    const MAX_HISTORY_TURNS = 4;
    const recentHistory = getHistoryMessages().slice(-MAX_HISTORY_TURNS * 2);
    const turnOnly: ChatMessage[] = [
      ...recentHistory,
      userMsg,
    ];

    await streamChat(
      cfg,
      turnOnly,
      {
        onDelta: (delta) => {
          // Stream deltas are already think-stripped by streamChat.
          if (reply.length >= MAX_REPLY_CHARS) return;
          reply += delta;
          sender.send(IPC.CHAT_STREAM, delta);
        },
        onDone: () => {
          // Persist the assistant reply into history so the next turn has
          // context, then signal the renderer that the stream is complete.
          // Strip defensively in case a future change leaks reasoning here.
          const clean = _stripThink(reply);
          const assistantContent = clean || '(没有回复)';
          appendHistory([{
            id: String(Date.now()),
            role: 'assistant',
            content: assistantContent,
            ts: Date.now(),
          }]);
          sender.send(IPC.CHAT_DONE);
        },
        onError: (err) => {
          sender.send(IPC.CHAT_STREAM, `\n[错误: ${err.message}]`);
          sender.send(IPC.CHAT_DONE);
        },
      },
      currentAbort.signal,
    );
  });

  // Click-through toggle. The renderer sends `true` when the cursor is over
  // the pet body, `false` when it leaves. We also use this as the
  // "pet is being dragged" signal — moving the window requires mouse events.
  // Suppressed while an interactive lock is held (see refreshInteractive).
  ipcMain.on(IPC.PET_INTERACTION, (_e, interactive: boolean) => {
    if (interactiveLocks.size > 0) return; // lock wins
    const win = getPetWindow();
    if (!win) return;
    win.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  ipcMain.on(IPC.INTERACTIVE_LOCK, (_e, token: string) => {
    interactiveLocks.add(token);
    refreshInteractive();
  });

  ipcMain.on(IPC.INTERACTIVE_UNLOCK, (_e, token: string) => {
    interactiveLocks.delete(token);
    refreshInteractive();
  });

  // Center the pet window on the primary display. Renderer fires this
  // when a reminder zoom-in starts so the whole window — not just the
  // inner canvas — recenters to the screen middle.
  ipcMain.handle(IPC.PET_CENTER, () => centerPetWindow());

  // Resize the pet window. Renderer calls this around the reminder zoom
  // so the scaled-up pet isn't clipped by the default 320×360 chrome.
  ipcMain.handle(IPC.PET_RESIZE, (_e, size: { width: number; height: number }) =>
    resizePetWindow(size.width, size.height),
  );

  // Snapshot the current window geometry so a reminder dismiss can
  // restore the user's exact drag-to position (without forcing the
  // window back to screen center).
  ipcMain.handle(IPC.PET_SNAPSHOT_BOUNDS, () => snapshotPetBounds());
  ipcMain.handle(IPC.PET_RESTORE_BOUNDS, (_e, bounds: PetBounds) => restorePetBounds(bounds));
}