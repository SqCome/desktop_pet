// Creates the transparent, frameless, always-on-top pet window.
// Cross-platform quirks handled inline:
//   - macOS:  needs `setVisibleOnAllWorkspaces` + higher window level so the pet
//             floats above the Dock but doesn't steal focus.
//   - Windows: `transparent: true` + skipping the taskbar (skipTaskbar: true on
//             Win32) keeps the pet out of the Alt-Tab list.
// `setIgnoreMouseEvents(true, { forward: true })` is what lets the user click
// through the empty canvas — the renderer has to toggle it back when the
// pointer is over an interactive part of the pet.
import { BrowserWindow, screen, app } from 'electron';
import * as path from 'node:path';
import type { PetPosition, PetBounds } from '../shared/types';

const PET_WIDTH = 320;
const PET_HEIGHT = 360;

let mainWindow: BrowserWindow | null = null;

export function createPetWindow(initial?: PetPosition): BrowserWindow {
  const display = screen.getPrimaryDisplay();
  // Default to bottom-right corner of the primary display — the classic
  // desktop-pet anchor. Override via `initial` (used for restoring saved
  // position in a future update).
  const defaults = {
    width: PET_WIDTH,
    height: PET_HEIGHT,
    x: initial?.x ?? display.workArea.width - PET_WIDTH - 40,
    y: initial?.y ?? display.workArea.height - PET_HEIGHT - 40,
  };
  if (process.env.PET_DEBUG === '1') {
    console.log('[window] creating BrowserWindow at', JSON.stringify(defaults));
  }

  mainWindow = new BrowserWindow({
    ...defaults,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false, // shown on ready-to-show to avoid white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      // Sandbox blocks relative-path require() in preload, which we need to
      // load ../shared/types. Disable it; security still holds because
      // contextIsolation + nodeIntegration:false keep the renderer isolated.
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[window] renderer failed to load: ${code} ${desc}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[window] renderer process gone:', details.reason);
  });

  // Per-platform tweaks.
  if (process.platform === 'darwin') {
    // Float above normal windows but below the screen-saver/screen-lock level.
    mainWindow.setAlwaysOnTop(true, 'floating');
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Hide from the Dock so the pet feels like a "thing on the desktop".
    app.dock?.hide();
  } else if (process.platform === 'win32') {
    // Win32 click-through flag is set by the renderer via setIgnoreMouseEvents.
    mainWindow.setAlwaysOnTop(true, 'screen-saver');
  }

  mainWindow.setIgnoreMouseEvents(true, { forward: true });

  // Debug: open DevTools detached when PET_DEBUG=1 so we can read renderer
  // errors without intercepting the always-on-top pet window. Also forward
  // every renderer console message to the terminal.
  if (process.env.PET_DEBUG === '1') {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      const tag = ['log', 'warn', 'error'][level] ?? 'log';
      console.log(`[renderer:${tag}] ${message}  (${source}:${line})`);
    });
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.openDevTools({ mode: 'detach' });
    });
  }

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getPetWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Move the pet window to the center of the primary display's work area.
 * Used by the reminder-zoom flow so the whole pet — window and contents —
 * recenters, not just the inner canvas (which would otherwise zoom in
 * place at whatever corner the user had dragged it to).
 *
 * Returns the new top-left position, or null if the window is gone.
 */
export function centerPetWindow(): PetPosition | null {
  if (!mainWindow) return null;
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workArea;
  const [w, h] = mainWindow.getSize();
  const x = Math.round(width / 2 - w / 2);
  const y = Math.round(height / 2 - h / 2);
  mainWindow.setPosition(x, y);
  return { x, y };
}

/**
 * Resize the pet window. Used to grow it during a reminder so the
 * scaled-up pet has room to render without being clipped by the
 * 320×360 default chrome. Returns the new size, or null if the
 * window is gone.
 *
 * NOTE: does NOT recenter — call centerPetWindow() afterwards if you
 * want the (now larger) window to land in the screen middle.
 */
export function resizePetWindow(width: number, height: number): { width: number; height: number } | null {
  if (!mainWindow) return null;
  mainWindow.setSize(width, height);
  return { width, height };
}

/**
 * Snapshot the current window geometry so the renderer can put it
 * back exactly where the user had dragged it before a reminder zoom.
 * Returns null if the window is gone.
 *
 * Pair with restorePetBounds() — never resize/move the window in
 * between without merging into the snapshot, or the restore will
 * discard the user's in-flight changes.
 */
export function snapshotPetBounds(): PetBounds | null {
  if (!mainWindow) return null;
  const [width, height] = mainWindow.getSize();
  const [x, y] = mainWindow.getPosition();
  return { x, y, width, height };
}

/**
 * Restore the window to a previously snapshotted geometry. Used after
 * a reminder dismisses — we want the window to land back exactly
 * where the user had it, not recentered at the screen middle.
 */
export function restorePetBounds(bounds: PetBounds): PetBounds | null {
  if (!mainWindow) return null;
  mainWindow.setBounds(bounds);
  return bounds;
}