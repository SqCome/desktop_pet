// Tray icon + context menu. Lives across the whole app lifetime — closing the
// pet window does NOT quit the app; quitting only happens via the tray's
// "退出" entry (or Cmd+Q / Alt+F4 if you wire those up later).
import { Tray, Menu, nativeImage, BrowserWindow, app } from 'electron';
import {
  startNotifyServer,
  stopNotifyServer,
  isNotifyRunning,
  installHooks,
  _getNotifyBus,
} from './notify';
import { buildTrayIconPng } from './tray-icon';

let tray: Tray | null = null;

export function createTray(getWindow: () => BrowserWindow | null): Tray {
  // Programmatic tray icon — generated at runtime, no asset file required.
  // See tray-icon.ts for the design (pink-to-peach gradient + cat silhouette).
  // We construct the NativeImage once and reuse it across menu rebuilds.
  const icon = nativeImage.createFromBuffer(buildTrayIconPng());
  tray = new Tray(icon);

  const rebuild = () => {
    const win = getWindow();
    const menu = Menu.buildFromTemplate([
      {
        label: win?.isVisible() ? '隐藏宠物' : '显示宠物',
        click: () => {
          if (!win) return;
          if (win.isVisible()) win.hide();
          else win.show();
        },
      },
      { type: 'separator' },
      { label: '设置…', click: () => win?.show() },
      { label: '关于', click: () => win?.show() },
      { type: 'separator' },
      {
        label: isNotifyRunning() ? '禁用 Claude Code 通知' : '启用 Claude Code 通知',
        click: async () => {
          if (isNotifyRunning()) {
            await stopNotifyServer();
          } else {
            await startNotifyServer({ userDataDir: app.getPath('userData') });
          }
          rebuild();
        },
      },
      {
        label: '安装 Claude Code hooks',
        click: () => {
          const r = installHooks({ userDataDir: app.getPath('userData') });
          console.log('[tray] install hooks:', r);
          rebuild();
        },
      },
      {
        label: '测试通知',
        click: () => {
          const bus = _getNotifyBus();
          if (!bus) {
            console.warn('[tray] test notify: service not running');
            return;
          }
          bus.dispatch({
            sessionId: 'tray-test-' + Date.now(),
            kind: 'idle_prompt',
            title: 'Claude Code 在等你',
            body: '这是一条测试通知',
            ts: Date.now(),
          });
        },
      },
      {
        label: '退出',
        click: () => {
          // Bypass the "close hides to tray" behavior.
          app.exit(0);
        },
      },
    ]);
    tray!.setContextMenu(menu);
  };

  rebuild();
  tray.setToolTip('Desktop Pet');
  tray.on('click', () => {
    const win = getWindow();
    if (win?.isVisible()) win.hide();
    else win?.show();
  });

  // Rebuild when window visibility changes so the "显示/隐藏" label stays
  // accurate. Previous versions used setInterval(rebuild, 1000) — that
  // re-allocated the native Menu and reissued NOTIFYICONDATA to the shell
  // every second, pinning one CPU core on Windows.
  const win = getWindow();
  if (win) {
    win.on('show', rebuild);
    win.on('hide', rebuild);
  }

  return tray;
}

export function disposeTray(): void {
  tray?.destroy();
  tray = null;
}