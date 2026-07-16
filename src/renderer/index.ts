// Renderer entry. Boots the pet, wires drag + click-through, and reacts to
// menu actions. Reads the pet render config from main via petApi.config so
// the same config controls all three modes (Live2D / GIF / sequence).
import { startPet, PetHandle } from './pet';
import { setupMenu, MenuAction } from './menu';
import { setupChat } from './chat';
import { setupSettings } from './settings';
import { setupNotify } from './notify';
import type { AppConfig, ChatMessage, PetPosition, PetBounds, Reminder, NotifyPayload } from '../shared/types';

declare global {
  interface Window {
    petApi: {
      config: {
        get: () => Promise<AppConfig>;
        set: (patch: Partial<AppConfig>) => Promise<AppConfig>;
      };
      chat: {
        send: (text: string) => Promise<void>;
        stop: () => Promise<void>;
        getHistory: () => Promise<ChatMessage[]>;
        onStream: (handler: (delta: string) => void) => () => void;
        onDone: (handler: () => void) => () => void;
      };
      pet: {
        setInteractive: (interactive: boolean) => void;
        lockInteractive: (token: string) => void;
        unlockInteractive: (token: string) => void;
        onSessionReset: (handler: () => void) => () => void;
        center: () => Promise<PetPosition | null>;
        resize: (width: number, height: number) => Promise<{ width: number; height: number } | null>;
        snapshotBounds: () => Promise<PetBounds | null>;
        restoreBounds: (bounds: PetBounds) => Promise<PetBounds | null>;
      };
      reminders: {
        list: () => Promise<Reminder[]>;
        add: (text: string, fireAt: number) => Promise<Reminder>;
        remove: (id: string) => Promise<void>;
        onFired: (handler: (r: Reminder) => void) => () => void;
      };
      notify: {
        enable: () => Promise<{ ok: boolean; running: boolean }>;
        disable: () => Promise<{ ok: boolean }>;
        installHooks: () => Promise<{ ok: boolean; message: string }>;
        uninstallHooks: () => Promise<{ ok: boolean; message: string }>;
        testNotify: (kind?: string) => Promise<{ ok: boolean; message?: string }>;
        focusPet: () => Promise<{ ok: boolean } | null>;
        onNotify: (handler: (p: NotifyPayload) => void) => () => void;
      };
    };
    // Set by setupChat so the context menu can toggle the input panel.
    __openChat?: () => void;
    // Set by setupChat so the context menu can toggle the history panel.
    __openHistory?: () => void;
    // Set by setupSettings so the context menu can open the settings drawer.
    __openSettings?: () => void;
  }
}

async function main() {
  const canvas = document.getElementById('pet-canvas') as HTMLDivElement;

  // Pull the render config from main. main is the source of truth — storage.ts
  // reads it from disk on boot and merges with defaults.
  const cfg = await window.petApi.config.get();
  const pet: PetHandle = await startPet(canvas, {
    mode: cfg.pet.mode,
    assetDir: cfg.pet.assetDir,
    sequenceFrameMs: cfg.pet.sequenceFrameMs,
    animation: cfg.pet.animation,
  });

  // Wire up the chat input panel and bubble streaming.
  setupChat();
  // Wire up the settings drawer.
  setupSettings();
  // Subscribe to Claude Code hook notifications (bubbles + attention mood).
  setupNotify(pet.stateMachine);

  // Reminder zoom: when a reminder fires, grow the window so the
  // scaled-up pet has room to render (default 320×360 would clip a
  // 1.4×-scaled model), move it to screen center, and apply the
  // inner-canvas zoom style.
  //
  // Without the resize, the CSS `scale: 1.4` would push pixels outside
  // the BrowserWindow's chrome and the system would clip them — the
  // "pet got cut off" bug the user reported. Growing the window to
  // 520×580 (~1.6×) gives the scaled pet headroom on every side.
  //
  // We also lock the window into interactive mode for the duration of
  // the zoom. Without this lock, as soon as the cursor leaves the pet
  // canvas, the renderer's mouseleave handler would re-enable
  // click-through — meaning the "知道了" button on the bubble becomes
  // unreachable.
  //
  // Restore strategy: we snapshot the user's original drag-to bounds
  // BEFORE zooming, so dismiss puts the window back exactly where
  // they had it. Without this, dismiss would resize back to the
  // defaults and recenter on screen — overwriting the user's
  // preferred location.
  const REMINDER_LOCK = 'reminder-bubble';
  const NORMAL_W = 320;
  const NORMAL_H = 360;
  const ZOOM_W = 520;
  const ZOOM_H = 580;
  let preZoomBounds: PetBounds | null = null;

  window.addEventListener('pet:reminder-zoom', () => {
    canvas.classList.add('reminder-zoom');
    window.petApi.pet.lockInteractive(REMINDER_LOCK);
    // Capture the user's current window position/size BEFORE we
    // mutate it. If a previous reminder never dismissed (e.g. the
    // bubble is still up when a new reminder fires), reuse the
    // snapshot from the first one — that snapshot is the only one
    // pointing at the user's true original position.
    window.petApi.pet
      .snapshotBounds()
      .then((bounds) => {
        if (!preZoomBounds) preZoomBounds = bounds;
        // Order matters: resize FIRST so the center math uses the
        // new (larger) bounds, otherwise the window is recentered
        // around the old 320×360 size and the new chrome ends up
        // off-center.
        return window.petApi.pet
          .resize(ZOOM_W, ZOOM_H)
          .then(() => window.petApi.pet.center());
      })
      .catch((err) => {
        console.warn('[renderer] reminder window resize/center failed:', err);
      });
  });
  window.addEventListener('pet:reminder-dismiss', () => {
    canvas.classList.remove('reminder-zoom');
    window.petApi.pet.unlockInteractive(REMINDER_LOCK);
    // Restore the user's original drag-to position. If the snapshot
    // was lost (e.g. window destroyed mid-zoom), fall back to the
    // default size centered on screen so we never strand the pet
    // in an off-screen coordinate.
    const restore = preZoomBounds
      ? window.petApi.pet.restoreBounds(preZoomBounds)
      : window.petApi.pet.resize(NORMAL_W, NORMAL_H).then(() => window.petApi.pet.center());
    preZoomBounds = null;
    restore.catch((err) => {
      console.warn('[renderer] reminder window restore failed:', err);
    });
  });

  // Hide/show the context menu on right-click on the pet.
  setupMenu(canvas, async (action: MenuAction) => {
    switch (action) {
      case 'chat':
        // Toggle the input panel; chat.ts owns the bubble display.
        window.__openChat?.();
        break;
      case 'settings':
        window.__openSettings?.();
        break;
      case 'reminder':
        // First-phase placeholder: just show the current local cache as
        // a one-off bubble so the user can sanity-check that the
        // cross-device polling is reaching the desktop. A proper
        // reminders panel comes with the H5 stage.
        try {
          const list = await window.petApi.reminders.list();
          const msg = list.length
            ? `当前有 ${list.length} 条提醒在本地缓存里~`
            : '本地还没有提醒哦~ 提醒会从远端自动同步';
          window.dispatchEvent(new CustomEvent('pet:feedback', { detail: { msg } }));
        } catch (err) {
          window.dispatchEvent(new CustomEvent('pet:feedback', { detail: { msg: `reminder 列表失败: ${(err as Error).message}` } }));
        }
        break;
      case 'quit':
        window.close();
        break;
      default:
        // For unimplemented tools, surface a one-off bubble as feedback.
        // (chat.ts exposes a helper but we just inline this for brevity.)
        window.dispatchEvent(new CustomEvent('pet:feedback', { detail: { msg: `[${action}] 还没实现` } }));
        break;
    }
  });
}

main().catch((err) => {
  console.error('[renderer] boot failed:', err);
});