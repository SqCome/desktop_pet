// Preload exposes a tiny, typed surface to the renderer.
// All sensitive work (LLM calls, file I/O) stays in main.
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, AppConfig, ChatMessage, Reminder, PetPosition, PetBounds, NotifyPayload } from '../shared/types';

const api = {
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.CONFIG_GET),
    set: (patch: Partial<AppConfig>): Promise<AppConfig> => ipcRenderer.invoke(IPC.CONFIG_SET, patch),
  },
  chat: {
    send: (text: string): Promise<void> => ipcRenderer.invoke(IPC.CHAT_SEND, text),
    stop: (): Promise<void> => ipcRenderer.invoke(IPC.CHAT_STOP),
    getHistory: (): Promise<ChatMessage[]> => ipcRenderer.invoke(IPC.CHAT_HISTORY),
    onStream: (handler: (delta: string) => void) => {
      const listener = (_e: unknown, chunk: string) => handler(chunk);
      ipcRenderer.on(IPC.CHAT_STREAM, listener);
      return () => ipcRenderer.off(IPC.CHAT_STREAM, listener);
    },
    onDone: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on(IPC.CHAT_DONE, listener);
      return () => ipcRenderer.off(IPC.CHAT_DONE, listener);
    },
  },
  reminders: {
    list: (): Promise<Reminder[]> => ipcRenderer.invoke(IPC.REMINDERS_LIST),
    add: (text: string, fireAt: number): Promise<Reminder> =>
      ipcRenderer.invoke(IPC.REMINDERS_ADD, { text, fireAt }),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(IPC.REMINDERS_REMOVE, id),
    onFired: (handler: (r: Reminder) => void) => {
      const listener = (_e: unknown, r: Reminder) => handler(r);
      ipcRenderer.on(IPC.REMINDER_FIRED, listener);
      return () => ipcRenderer.off(IPC.REMINDER_FIRED, listener);
    },
  },
  pet: {
    // Renderer tells main "the pointer is over an interactive region now".
    setInteractive: (interactive: boolean): void => {
      ipcRenderer.send(IPC.PET_INTERACTION, interactive);
    },
    // Lock the window in interactive mode while a floating panel is visible
    // (menu, chat input). The cursor will leave the pet canvas while the
    // user moves toward the panel — without this lock, the window would
    // revert to click-through and the panel would go dead.
    lockInteractive: (token: string): void => {
      ipcRenderer.send(IPC.INTERACTIVE_LOCK, token);
    },
    unlockInteractive: (token: string): void => {
      ipcRenderer.send(IPC.INTERACTIVE_UNLOCK, token);
    },
    // Subscribe to "session reset" events. Main fires this when the user
    // has been idle long enough that the next chat message starts a fresh
    // conversation. The renderer shows a one-off bubble to acknowledge.
    onSessionReset: (handler: () => void) => {
      const listener = () => handler();
      ipcRenderer.on(IPC.SESSION_RESET, listener);
      return () => ipcRenderer.off(IPC.SESSION_RESET, listener);
    },
    // Move the pet BrowserWindow to the center of the primary display.
    // Renderer fires this alongside the reminder-zoom style change so the
    // whole window — not just the inner canvas — recenters.
    center: (): Promise<PetPosition | null> => ipcRenderer.invoke(IPC.PET_CENTER),
    // Resize the BrowserWindow. Used during a reminder so the scaled-up
    // pet has room to render without being clipped by the default chrome.
    resize: (width: number, height: number): Promise<{ width: number; height: number } | null> =>
      ipcRenderer.invoke(IPC.PET_RESIZE, { width, height }),
    // Snapshot/restore the window's x/y/width/height so a reminder
    // dismiss can put the window back exactly where the user had it,
    // rather than recentering on the screen.
    snapshotBounds: (): Promise<PetBounds | null> => ipcRenderer.invoke(IPC.PET_SNAPSHOT_BOUNDS),
    restoreBounds: (bounds: PetBounds): Promise<PetBounds | null> =>
      ipcRenderer.invoke(IPC.PET_RESTORE_BOUNDS, bounds),
  },
  notify: {
    /** Start the local HTTP server. Idempotent. */
    enable: (): Promise<{ ok: boolean; running: boolean }> =>
      ipcRenderer.invoke(IPC.NOTIFY_ENABLE),
    /** Stop the local HTTP server. Idempotent. */
    disable: (): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.NOTIFY_DISABLE),
    /** Install hooks into ~/.claude/settings.json. */
    installHooks: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IPC.NOTIFY_INSTALL_HOOKS),
    /** Remove our hooks from ~/.claude/settings.json. */
    uninstallHooks: (): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IPC.NOTIFY_UNINSTALL_HOOKS),
    /** Fire a synthetic notification for self-test. */
    testNotify: (kind?: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke(IPC.NOTIFY_TEST, kind),
    /** Bring the pet window to the front. */
    focusPet: (): Promise<{ ok: boolean } | null> =>
      ipcRenderer.invoke(IPC.NOTIFY_FOCUS_PET),
    /** Subscribe to incoming notifications. Returns an unsubscribe fn. */
    onNotify: (handler: (payload: NotifyPayload) => void) => {
      const listener = (_e: unknown, p: NotifyPayload) => handler(p);
      ipcRenderer.on(IPC.NOTIFY_SHOW, listener);
      return () => ipcRenderer.off(IPC.NOTIFY_SHOW, listener);
    },
  },
};

contextBridge.exposeInMainWorld('petApi', api);

// Exported so the renderer can `import type PetApi` for typing `window.petApi`,
// even though the actual instance lives in main. Not used at runtime.
export type PetApi = typeof api;