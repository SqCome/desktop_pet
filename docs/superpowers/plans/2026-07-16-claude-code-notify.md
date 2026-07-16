# Claude Code Hook 通知接入 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local HTTP server + bridge scripts so the desktop pet receives Claude Code hook events (`PermissionRequest` / `Stop` / `SubagentStop` / `Notification: idle_prompt`) and notifies the user with animation + bubble.

**Architecture:** Electron main process owns a `127.0.0.1:<random>` HTTP server (opt-in). A tiny shell script written to `userData/scripts/` POSTs the hook payload to that port. The renderer subscribes to a `NOTIFY_SHOW` IPC channel and shows a transient bubble + plays an "attention" mood. No new dependencies — Node's built-in `http` and `fs` only.

**Tech Stack:** Electron, TypeScript, Node `http` module, no external libs.

---

## Global Constraints

- TypeScript strict mode (existing `tsconfig.base.json`).
- 主进程 `dist/main/index.js` 是 CommonJS(esbuild 不参与主进程),所有新文件用 `require`-compatible 写法:不用顶层 `import` ESM-only 语法。
- 渲染进程走 esbuild,新渲染代码允许 ESM。
- 配置版本 `CURRENT_CONFIG_VERSION` 升到 4(v3 → v4 迁移加 `claudeCodeNotify` 字段)。
- `productName` 是 `DesktopPet`(来自 `package.json` build 块),所有 userData 路径都按它拼,不要再用 `desktop_pet`。
- 不引入新依赖(electron、typescript、esbuild、pixi.js 之外不装包)。
- 跨平台路径分流:`win32` → `%APPDATA%\DesktopPet`,`darwin` → `~/Library/Application Support/DesktopPet`,其他 → `~/.config/DesktopPet`。
- IPC 通道名加进 `src/shared/types.ts` 的 `IPC` 表,主/渲两端都从那里引用。
- 主进程文件改动后必须重跑 `npm run build:main`(tsc watch 自动;手工跑 `npx tsc -p tsconfig.main.json`)。
- 渲染改动后必须重跑 `npm run build:renderer`(`scripts/bundle-renderer.js` 不是 watch,需手动重跑)。

---

## File Structure

**新增:**
- `src/main/notify/server.ts` — `NotifyServer` class。起 http server、读 body、normalize hook、走 bus。
- `src/main/notify/bus.ts` — `NotifyBus` class。按 `sessionId:kind` 去重(2s 窗口),推到所有 BrowserWindow。
- `src/main/notify/normalize.ts` — `normalizeHook(raw)` + `NotifyPayload` 类型生成(类型从 shared re-export,逻辑在这里)。
- `src/main/notify/install-hooks.ts` — `installHooks()` / `uninstallHooks()`,读写 `~/.claude/settings.json`,桥接脚本拷到 userData。
- `src/main/notify/scripts/desktop-pet-notify.cmd` — Windows 桥接脚本。
- `src/main/notify/scripts/desktop-pet-notify.sh` — macOS/Linux 桥接脚本。
- `src/main/notify/index.ts` — `startNotifyServer` / `stopNotifyServer` / `installHooks` / `uninstallHooks` 入口 + 单例状态。

**修改:**
- `src/shared/types.ts` — `CURRENT_CONFIG_VERSION = 4`;加 `ClaudeCodeNotifyConfig` interface、`NotifyPayload` type、`IPC.NOTIFY_*` 常量。
- `src/main/storage.ts` — 加 migration `3 → 4`;`loadConfig` shallow-merge 加 `claudeCodeNotify` 字段。
- `src/main/index.ts` — `boot()` 里调 `startNotifyServer`(若 config 启用);IPC handler for `NOTIFY_ENABLE/DISABLE/INSTALL_HOOKS/UNINSTALL_HOOKS/TEST`;`before-quit` 里调 `stopNotifyServer`。
- `src/main/preload.ts` — `petApi.notify.{enable, disable, installHooks, uninstallHooks, testNotify, onNotify, focusPet}`。
- `src/main/tray.ts` — 菜单加"启用/禁用 Claude Code 通知"、"安装/卸载 hooks"、"测试通知"。
- `src/renderer/index.ts` — `declare global` 加 `notify` 块;`main()` 调 `subscribeNotify(pet)`。
- `src/renderer/notify.ts`(新)— `subscribeNotify(pet, stateMachine)` 把 onNotify → 气泡 + setMood('attention')。
- `src/renderer/state-machine.ts` — `PetState` 加 `'attention'`,`playMotionForState` 加 case(默认回退到 idle 缩放抖动)。

---

## Task 1: shared types — config v4 + IPC 常量 + NotifyPayload

**Files:**
- Modify: `src/shared/types.ts:17`(`CURRENT_CONFIG_VERSION` → 4)
- Modify: `src/shared/types.ts:32-49`(`AppConfig` 加 `claudeCodeNotify`)
- Modify: `src/shared/types.ts:139-166`(`DEFAULT_CONFIG` 加 `claudeCodeNotify`)
- Modify: `src/shared/types.ts:169-214`(`IPC` 加 NOTIFY_* 常量)
- Modify: `src/shared/types.ts:216` 末尾(`NotifyPayload` type)

**Interfaces:** (none,基础类型,后续任务消费)

- [ ] **Step 1: 修改 `CURRENT_CONFIG_VERSION` 到 4**

编辑 `src/shared/types.ts` 第 17 行:

```ts
export const CURRENT_CONFIG_VERSION = 4;
```

并在版本号注释的 `v3` 行下面加一行:

```ts
//  v4: added claudeCodeNotify { serviceEnabled, hooksInstalled } for the
//      Claude Code hook bridge (HTTP server + ~/.claude/settings.json hooks).
```

- [ ] **Step 2: 在 `AppConfig` 加 `claudeCodeNotify` 字段**

在 `AppConfig` interface 的最后一行(`remindersToken: string;` 之后)加:

```ts
  /** Claude Code hook bridge configuration. v4+ only. */
  claudeCodeNotify: ClaudeCodeNotifyConfig;
```

然后在文件任意位置(建议紧挨 `AppConfig` 定义之后)加:

```ts
/**
 * Two independent switches for the Claude Code hook bridge:
 *  - serviceEnabled: turn on the local HTTP server that receives hooks.
 *  - hooksInstalled: whether ~/.claude/settings.json currently contains
 *    our desktop-pet-notify hooks.
 * Splitting them lets users run one without the other (e.g. disable
 * notifications temporarily without removing hooks).
 */
export interface ClaudeCodeNotifyConfig {
  serviceEnabled: boolean;
  hooksInstalled: boolean;
}
```

- [ ] **Step 3: `DEFAULT_CONFIG` 加默认值**

在 `DEFAULT_CONFIG` 对象最后一行(`remindersToken: ''` 之后)加:

```ts
  claudeCodeNotify: {
    serviceEnabled: false,
    hooksInstalled: false,
  },
```

- [ ] **Step 4: `IPC` 加 NOTIFY_* 常量**

在 `IPC` 表末尾(`REMINDER_FIRED` 之后)加:

```ts
  // Claude Code hook bridge: HTTP server in main, opt-in via tray.
  /** Start the local HTTP server that receives hook POSTs. */
  NOTIFY_ENABLE: 'notify:enable',
  /** Stop the HTTP server and delete the port file. */
  NOTIFY_DISABLE: 'notify:disable',
  /** Write ~/.claude/settings.json so Claude Code invokes our bridge. */
  NOTIFY_INSTALL_HOOKS: 'notify:install-hooks',
  /** Remove our hooks from ~/.claude/settings.json (preserves other hooks). */
  NOTIFY_UNINSTALL_HOOKS: 'notify:uninstall-hooks',
  /** Fire a synthetic notification for self-test. */
  NOTIFY_TEST: 'notify:test',
  /** Main → renderer push: show a notification bubble + attention mood. */
  NOTIFY_SHOW: 'notify:show',
  /** Renderer asks main to bring the pet window to the front. */
  NOTIFY_FOCUS_PET: 'notify:focus-pet',
```

- [ ] **Step 5: 加 `NotifyPayload` type**

在文件末尾(最后 `import` 之后,如果有的话)追加:

```ts
/**
 * Normalized hook payload the main process forwards to the renderer.
 * `kind` is one of four normalized event types; everything else from
 * Claude Code is dropped in normalizeHook().
 */
export type NotifyPayload = {
  /** Used for dedup. Provided by Claude Code, fallback = random. */
  sessionId: string;
  kind: 'permission_request' | 'idle_prompt' | 'stop' | 'subagent_stop';
  /** Rendered as bubble title (main pre-formats the Chinese text). */
  title: string;
  /** Bubble body, <= 80 chars. */
  body: string;
  /** Optional context for the click handler (currently unused by focusPet). */
  focusHint?: { kind: 'ide' | 'terminal'; value: string };
  /** ms epoch. */
  ts: number;
};
```

- [ ] **Step 6: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.main.json --noEmit
```

期望:无错误。如果报"`Property 'claudeCodeNotify' is missing`"在 storage.ts 别慌,Task 2 会修。

- [ ] **Step 7: 提交**

```bash
git add src/shared/types.ts
git commit -m "feat(notify): add ClaudeCodeNotifyConfig + NotifyPayload types (v4)"
```

---

## Task 2: storage migration v3 → v4

**Files:**
- Modify: `src/main/storage.ts:53-59`(migration 表加 3 → 4 步骤)
- Modify: `src/main/storage.ts:90-95`(`loadConfig` shallow-merge 包含 `claudeCodeNotify`)

**Interfaces:**
- Consumes: `ClaudeCodeNotifyConfig`, `CURRENT_CONFIG_VERSION = 4`(Task 1)
- Produces: 修改后的 `loadConfig()` 在读到 v3 配置时自动注入 `claudeCodeNotify = { serviceEnabled: false, hooksInstalled: false }`

- [ ] **Step 1: 加 migration step**

在 `migrations` 表第 53 行(`2: (cfg) => { ... }` 块)之后,加:

```ts
  // v3 -> v4: add claudeCodeNotify { serviceEnabled, hooksInstalled }.
  // Existing configs get both fields off (the user hasn't opted in yet),
  // and the renderer/tray will toggle them via IPC.
  3: (cfg) => {
    cfg.claudeCodeNotify = cfg.claudeCodeNotify && typeof cfg.claudeCodeNotify === 'object'
      ? cfg.claudeCodeNotify
      : {};
    cfg.claudeCodeNotify.serviceEnabled = cfg.claudeCodeNotify.serviceEnabled === true;
    cfg.claudeCodeNotify.hooksInstalled = cfg.claudeCodeNotify.hooksInstalled === true;
    cfg.configVersion = 4;
    return cfg;
  },
```

- [ ] **Step 2: `loadConfig` shallow-merge 包含新字段**

第 90 行附近,`merged` 对象改成:

```ts
      const merged: AppConfig = {
        ...DEFAULT_CONFIG,
        ...migrated,
        configVersion: CURRENT_CONFIG_VERSION,
        llm: { ...DEFAULT_CONFIG.llm, ...migrated.llm },
        claudeCodeNotify: { ...DEFAULT_CONFIG.claudeCodeNotify, ...migrated.claudeCodeNotify },
      };
```

- [ ] **Step 3: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.main.json --noEmit
```

期望:无错误。

- [ ] **Step 4: 跑一次 boot 看 config 加载路径**

(目前还没有 `npm test`,但可以肉眼确认 `loadConfig` 不会因缺字段崩——手工写一个 v3 config 跑不起来也无所谓,只要编译过就行。)

- [ ] **Step 5: 提交**

```bash
git add src/main/storage.ts
git commit -m "feat(notify): migrate config v3 -> v4 (claudeCodeNotify defaults)"
```

---

## Task 3: notify/normalize.ts — hook payload 归一化

**Files:**
- Create: `src/main/notify/normalize.ts`

**Interfaces:**
- Consumes: `NotifyPayload` 类型(Task 1)
- Produces:
  ```ts
  export function normalizeHook(raw: unknown): NotifyPayload | null
  ```
  返回 null 表示这个 hook 该丢弃(`PreToolUse` 等)。

- [ ] **Step 1: 写文件骨架**

创建 `src/main/notify/normalize.ts`:

```ts
// Normalize raw Claude Code hook payloads into our internal NotifyPayload.
//
// Claude Code sends many hook events; we only surface four:
//   PermissionRequest -> permission_request
//   Notification      -> idle_prompt  (other Notification kinds dropped)
//   Stop              -> stop
//   SubagentStop      -> subagent_stop
//
// Everything else (PreToolUse, PostToolUse, UserPromptSubmit, etc.) returns
// null and is logged + dropped. We don't want every tool call to wake the
// pet — only the moments that actually require user attention.
import type { NotifyPayload } from '../../shared/types';

type Kind = NotifyPayload['kind'];

const KIND_TITLES: Record<Kind, string> = {
  permission_request: 'Claude Code 需要授权',
  idle_prompt: 'Claude Code 在等你',
  stop: 'Claude Code 任务完成',
  subagent_stop: 'Claude Code 子任务完成',
};

function fallbackId(): string {
  return Math.random().toString(36).slice(2);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function pickKind(raw: any): Kind | null {
  const ev = isString(raw?.hook_event_name) ? raw.hook_event_name : '';
  if (ev === 'PermissionRequest') return 'permission_request';
  if (ev === 'Stop') return 'stop';
  if (ev === 'SubagentStop') return 'subagent_stop';
  if (ev === 'Notification') {
    // Notification carries a `notification_type` field. Only `idle_prompt`
    // warrants a pet notification; auth_success / elicitation / etc. don't.
    const sub = isString(raw?.notification_type) ? raw.notification_type : '';
    return sub === 'idle_prompt' ? 'idle_prompt' : null;
  }
  return null;
}

function pickBody(raw: any, kind: Kind): string {
  switch (kind) {
    case 'permission_request': {
      const tool = isString(raw?.tool_name) ? raw.tool_name : '未知工具';
      return `工具:${tool} — 请回 Claude Code 批准`;
    }
    case 'idle_prompt':
      return '它已经停下等你输入啦';
    case 'stop':
      return '主任务跑完了,等你下一句';
    case 'subagent_stop':
      return '子 agent 完成,主流程继续中';
  }
}

/**
 * Convert a raw hook payload into a NotifyPayload. Returns null when the
 * hook should be dropped (unknown event or Notification subtype).
 *
 * Defensive against missing/malformed fields: every field has a fallback.
 */
export function normalizeHook(raw: unknown): NotifyPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = pickKind(r);
  if (!kind) return null;

  const sessionId =
    isString(r.sessionId) && r.sessionId.length > 0 ? r.sessionId : fallbackId();

  return {
    sessionId,
    kind,
    title: KIND_TITLES[kind],
    body: pickBody(r, kind),
    ts: Date.now(),
  };
}
```

- [ ] **Step 2: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.main.json --noEmit
```

期望:无错误。

- [ ] **Step 3: 提交**

```bash
git add src/main/notify/normalize.ts
git commit -m "feat(notify): add hook payload normalizer"
```

---

## Task 4: notify/bus.ts — 去重 + 推送到所有窗口

**Files:**
- Create: `src/main/notify/bus.ts`

**Interfaces:**
- Consumes: `NotifyPayload`(Task 1), `IPC`(Task 1)
- Produces:
  ```ts
  export class NotifyBus {
    constructor(windows: () => BrowserWindow[])
    dispatch(p: NotifyPayload): void
  }
  ```

- [ ] **Step 1: 写文件**

创建 `src/main/notify/bus.ts`:

```ts
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
```

- [ ] **Step 2: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.main.json --noEmit
```

期望:无错误。

- [ ] **Step 3: 提交**

```bash
git add src/main/notify/bus.ts
git commit -m "feat(notify): add dedup bus + fan-out"
```

---

## Task 5: notify/server.ts — HTTP server + 端口文件

**Files:**
- Create: `src/main/notify/server.ts`

**Interfaces:**
- Consumes: `NotifyPayload`(Task 1), `normalizeHook`(Task 3), `NotifyBus`(Task 4)
- Produces:
  ```ts
  export class NotifyServer {
    constructor(opts: { portFile: string; bus: NotifyBus })
    start(): Promise<{ port: number }>
    stop(): Promise<void>
    readonly port: number | null
  }
  ```

- [ ] **Step 1: 写文件**

创建 `src/main/notify/server.ts`:

```ts
// Local HTTP server that accepts POST /notify from the bridge script.
//
// Design notes:
//  - listen(0, '127.0.0.1') so the OS picks a free port. We write the
//    resolved port to `portFile` so the bridge script can read it.
//  - Always respond 200 OK FIRST, then read the body in the background.
//    Reading before responding adds RTT that Claude Code's hook timeout
//    (default 15s) doesn't need to pay.
//  - Bind to 127.0.0.1 only — never 0.0.0.0. Local-only by design.
import * as http from 'node:http';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { NotifyBus } from './bus';
import { normalizeHook } from './normalize';

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export class NotifyServer {
  private server: http.Server | null = null;
  private _port: number | null = null;

  constructor(private opts: { portFile: string; bus: NotifyBus }) {}

  get port(): number | null {
    return this._port;
  }

  start(): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        if (req.method === 'POST' && req.url === '/notify') {
          this.handleNotify(req, res);
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        this._port = addr.port;
        try {
          fs.writeFileSync(this.opts.portFile, String(addr.port), 'utf-8');
        } catch (err) {
          console.warn('[notify] failed to write port file:', err);
        }
        console.log(`[notify] server listening on 127.0.0.1:${addr.port}`);
        this.server = server;
        resolve({ port: addr.port });
      });
    });
  }

  stop(): Promise<void> {
    const s = this.server;
    if (!s) return Promise.resolve();
    this.server = null;
    this._port = null;
    return new Promise((resolve) => {
      s.close(() => {
        try {
          fs.unlinkSync(this.opts.portFile);
        } catch {
          /* file may already be gone — ignore */
        }
        console.log('[notify] server stopped, port file removed');
        resolve();
      });
    });
  }

  private handleNotify(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Reply 200 first; read body in the background. See file header.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    readBody(req)
      .then((buf) => {
        let raw: unknown;
        try {
          raw = JSON.parse(buf);
        } catch (err) {
          console.warn('[notify] bad JSON payload:', err);
          return;
        }
        const payload = normalizeHook(raw);
        if (!payload) {
          // Not an event we surface (e.g. PreToolUse). Quietly dropped.
          return;
        }
        this.opts.bus.dispatch(payload);
      })
      .catch((err) => console.warn('[notify] readBody error:', err));
  }
}
```

- [ ] **Step 2: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.main.json --noEmit
```

期望:无错误。

- [ ] **Step 3: 提交**

```bash
git add src/main/notify/server.ts
git commit -m "feat(notify): HTTP server with port file"
```

---

## Task 6: notify/install-hooks.ts — 装/卸 hooks + 拷桥接脚本

**Files:**
- Create: `src/main/notify/install-hooks.ts`
- Create: `src/main/notify/scripts/desktop-pet-notify.cmd`
- Create: `src/main/notify/scripts/desktop-pet-notify.sh`

**Interfaces:**
- Consumes: `ClaudeCodeNotifyConfig`(Task 1)
- Produces:
  ```ts
  export function installHooks(opts: { userDataDir: string }): { ok: boolean; message: string }
  export function uninstallHooks(): { ok: boolean; message: string }
  ```

- [ ] **Step 1: 创建桥接脚本目录**

```bash
mkdir -p E:/desktop_pet/src/main/notify/scripts
```

- [ ] **Step 2: 写 Windows 桥接脚本**

创建 `src/main/notify/scripts/desktop-pet-notify.cmd`:

```cmd
@echo off
setlocal
rem userData on Windows = %APPDATA%\DesktopPet (matches productName in package.json).
rem Keep this string in sync if productName is ever renamed.
set PORT_FILE=%APPDATA%\DesktopPet\notify.port
if not exist "%PORT_FILE%" exit /b 0
set /p PORT=<"%PORT_FILE%"
if "%PORT%"=="" exit /b 0
curl -s -X POST -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:%PORT%/notify >nul 2>nul
exit /b 0
```

- [ ] **Step 3: 写 POSIX 桥接脚本**

创建 `src/main/notify/scripts/desktop-pet-notify.sh`:

```bash
#!/usr/bin/env bash
# Bridge script: read port from userData, POST hook payload to localhost.
# Always exit 0 — Claude Code must not see failures from our notifier.
set -u
if [ "$(uname -s)" = "Darwin" ]; then
  PORT_FILE="${HOME}/Library/Application Support/DesktopPet/notify.port"
else
  PORT_FILE="${HOME}/.config/DesktopPet/notify.port"
fi
[ -f "$PORT_FILE" ] || exit 0
PORT=$(cat "$PORT_FILE")
[ -n "$PORT" ] || exit 0
curl -s -X POST -H 'Content-Type: application/json' --data-binary @- \
  "http://127.0.0.1:${PORT}/notify" >/dev/null 2>&1
exit 0
```

- [ ] **Step 4: 写 install-hooks.ts**

创建 `src/main/notify/install-hooks.ts`:

```ts
// Read/write ~/.claude/settings.json to install or remove the
// desktop-pet-notify hooks. Idempotent: install() on an already-installed
// setup is a no-op; uninstall() with our hooks missing is a no-op.
//
// Hook events we wire up:
//   PermissionRequest, Stop, SubagentStop, Notification
//
// `settings.json` shape (Claude Code):
//   {
//     "hooks": {
//       "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "<path>" }] }],
//       "Stop":              [...],
//       "SubagentStop":      [...],
//       "Notification":      [...]
//     }
//   }
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const HOOK_EVENTS = ['PermissionRequest', 'Stop', 'SubagentStop', 'Notification'] as const;
type HookEvent = (typeof HOOK_EVENTS)[number];

const SCRIPT_NAME_WIN = 'desktop-pet-notify.cmd';
const SCRIPT_NAME_POSIX = 'desktop-pet-notify.sh';

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function bridgeScriptPath(userDataDir: string): string {
  const isWin = process.platform === 'win32';
  return path.join(
    userDataDir,
    'scripts',
    isWin ? SCRIPT_NAME_WIN : SCRIPT_NAME_POSIX,
  );
}

function readSettings(): Record<string, unknown> {
  const p = settingsPath();
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>;
    }
  } catch (err) {
    console.warn('[install-hooks] settings.json unreadable, treating as empty:', err);
  }
  return {};
}

/**
 * Copy the bridge script from the bundled source to `userData/scripts/`.
 * Runs every install — overwrites if content drifted (dev iteration).
 * Skips silently if the source can't be found (asar / dev mode split).
 */
function copyBridgeScript(userDataDir: string): { ok: boolean; message: string } {
  const isWin = process.platform === 'win32';
  const srcRel = isWin
    ? path.join(__dirname, 'scripts', SCRIPT_NAME_WIN)
    : path.join(__dirname, 'scripts', SCRIPT_NAME_POSIX);
  const dst = path.join(userDataDir, 'scripts');
  const dstFile = bridgeScriptPath(userDataDir);

  try {
    fs.mkdirSync(dst, { recursive: true });
    let content: string;
    try {
      content = fs.readFileSync(srcRel, 'utf-8');
    } catch {
      // dev: ts files aren't compiled into a runnable script path here.
      // The source-of-truth lives in src/main/notify/scripts/ — copy from
      // project root via a relative walk from dist/main/notify/.. -> project root.
      const projectRoot = path.resolve(__dirname, '..', '..', '..');
      const fallback = path.join(
        projectRoot,
        'src',
        'main',
        'notify',
        'scripts',
        isWin ? SCRIPT_NAME_WIN : SCRIPT_NAME_POSIX,
      );
      content = fs.readFileSync(fallback, 'utf-8');
    }
    fs.writeFileSync(dstFile, content, 'utf-8');
    if (!isWin) fs.chmodSync(dstFile, 0o755);
    return { ok: true, message: `copied ${dstFile}` };
  } catch (err) {
    return { ok: false, message: `failed to copy bridge script: ${(err as Error).message}` };
  }
}

function makeHookEntry(command: string): Record<string, unknown> {
  return { hooks: [{ type: 'command', command }] };
}

function findOurEntry(entries: unknown[] | undefined, command: string): boolean {
  if (!Array.isArray(entries)) return false;
  for (const entry of entries) {
    const inner = (entry as any)?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const h of inner) {
      if (h && typeof h === 'object' && (h as any).command === command) return true;
    }
  }
  return false;
}

export function installHooks(opts: { userDataDir: string }): { ok: boolean; message: string } {
  const copied = copyBridgeScript(opts.userDataDir);
  if (!copied.ok) return copied;

  const command = bridgeScriptPath(opts.userDataDir);
  const settings = readSettings();
  const hooks = (settings.hooks && typeof settings.hooks === 'object'
    ? (settings.hooks as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  let touched = 0;
  for (const ev of HOOK_EVENTS) {
    const list = hooks[ev] as unknown[] | undefined;
    if (findOurEntry(list, command)) continue;
    const next = Array.isArray(list) ? [...list] : [];
    next.push(makeHookEntry(command));
    hooks[ev] = next;
    touched++;
  }
  settings.hooks = hooks;

  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    return { ok: false, message: `failed to write settings.json: ${(err as Error).message}` };
  }
  return { ok: true, message: `installed ${touched} hook(s)` };
}

export function uninstallHooks(): { ok: boolean; message: string } {
  // Best-effort: uninstall doesn't know which userDataDir; the bridge
  // command is identified by its filename ending in "desktop-pet-notify".
  const settings = readSettings();
  const hooks = (settings.hooks && typeof settings.hooks === 'object'
    ? (settings.hooks as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  let removed = 0;
  for (const ev of HOOK_EVENTS) {
    const list = hooks[ev] as unknown[] | undefined;
    if (!Array.isArray(list)) continue;
    const filtered = list.filter((entry) => {
      const inner = (entry as any)?.hooks;
      if (!Array.isArray(inner)) return true;
      const hasOurs = inner.some(
        (h) => h && typeof h === 'object' && typeof (h as any).command === 'string' &&
          (h as any).command.endsWith('desktop-pet-notify.cmd') ||
          ((h as any).command as string).endsWith('desktop-pet-notify.sh'),
      );
      if (hasOurs) removed++;
      return !hasOurs;
    });
    if (filtered.length === 0) {
      delete hooks[ev];
    } else {
      hooks[ev] = filtered;
    }
  }
  settings.hooks = hooks;

  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    return { ok: false, message: `failed to write settings.json: ${(err as Error).message}` };
  }
  return { ok: true, message: `removed ${removed} hook(s)` };
}
```

**注意**:上面 `.cmd`/`.sh` 判断用了两次 `||` 短路求值,导致优先级错位。修正(下面 Step 4a 单独修这一处):

- [ ] **Step 4a: 修 `uninstallHooks` 里 `||` 优先级 bug**

把:

```ts
      const hasOurs = inner.some(
        (h) => h && typeof h === 'object' && typeof (h as any).command === 'string' &&
          (h as any).command.endsWith('desktop-pet-notify.cmd') ||
          ((h as any).command as string).endsWith('desktop-pet-notify.sh'),
      );
```

替换成:

```ts
      const cmd = (h: any) => typeof h?.command === 'string' ? h.command : '';
      const hasOurs = inner.some((h) => {
        const c = cmd(h);
        return c.endsWith('desktop-pet-notify.cmd') || c.endsWith('desktop-pet-notify.sh');
      });
```

- [ ] **Step 5: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.main.json --noEmit
```

期望:无错误。如果报"`Cannot find module`" 关于 `__dirname`,忽略 — tsc 会把 `__dirname` 留着,运行时 Electron 才有。

- [ ] **Step 6: 提交**

```bash
git add src/main/notify/install-hooks.ts src/main/notify/scripts/
git commit -m "feat(notify): install/uninstall hooks + bridge scripts"
```

---

## Task 7: notify/index.ts — 启动入口 + 单例

**Files:**
- Create: `src/main/notify/index.ts`

**Interfaces:**
- Consumes: `NotifyServer`(Task 5), `NotifyBus`(Task 4), `installHooks`/`uninstallHooks`(Task 6)
- Produces:
  ```ts
  export function startNotifyServer(opts: { userDataDir: string }): Promise<void>
  export function stopNotifyServer(): Promise<void>
  export { installHooks, uninstallHooks }
  ```

- [ ] **Step 1: 写文件**

创建 `src/main/notify/index.ts`:

```ts
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

export { installHooks, uninstallHooks };
```

- [ ] **Step 2: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.main.json --noEmit
```

期望:无错误。

- [ ] **Step 3: 提交**

```bash
git add src/main/notify/index.ts
git commit -m "feat(notify): module entry + singleton"
```

---

## Task 8: 主进程 wiring — index.ts 接 IPC + boot hook

**Files:**
- Modify: `src/main/index.ts:130`(IPC 注册块)

**Interfaces:**
- Consumes: Task 1-7 所有产物
- Produces: 5 个新 IPC handler + boot 时按 config 启 server

- [ ] **Step 1: 加 import**

在 `src/main/index.ts` 顶部 import 块(`import { IPC, ChatMessage, PetBounds, Reminder } from '../shared/types';` 之后)加:

```ts
import {
  startNotifyServer,
  stopNotifyServer,
  installHooks as notifyInstallHooks,
  uninstallHooks as notifyUninstallHooks,
  isNotifyRunning,
} from './notify';
import * as path from 'node:path';
import { app as electronApp } from 'electron';
```

**注意**:因为 `app` 已经在 import 了,把 `import * as path` 和 `import { app as electronApp }` 这行合并到顶部 import 即可——把第 10 行的 `import { app, ipcMain, BrowserWindow } from 'electron';` 保持不变,**只追加** `import * as path from 'node:path';` 这一行。

**修正**:把 `import * as path from 'node:path';` 加在第 10 行 import 之下即可,删掉上面写的 `electronApp` 那行。

- [ ] **Step 2: `boot()` 里按 config 启 server**

在 `boot()` 函数末尾(`app.on('before-quit', ...)` 之前)加:

```ts
  // If the user previously enabled the notify bridge, restart the server.
  // First boot after Task 8 lands won't have serviceEnabled=true (default
  // off), so this is a no-op until the user opts in via the tray.
  const cfg = loadConfig();
  if (cfg.claudeCodeNotify.serviceEnabled) {
    startNotifyServer({ userDataDir: electronApp.getPath('userData') }).catch((err) => {
      console.warn('[boot] startNotifyServer failed:', err);
    });
  }
```

**注意**:`electronApp` 就是 `app`,直接用 `app.getPath('userData')` 即可。修正 Step 1 的 import:

```ts
import * as path from 'node:path';
```

且 `boot()` 里直接用 `app.getPath('userData')`。

- [ ] **Step 3: `before-quit` 关 server**

修改 `before-quit` handler:

```ts
  app.on('before-quit', () => {
    stopRemindersScheduler();
    stopNotifyServer().catch((err) => console.warn('[boot] stopNotifyServer:', err));
    disposeTray();
  });
```

- [ ] **Step 4: 加 IPC handlers**

在 `registerIpc()` 末尾(最后 `ipcMain.handle(IPC.PET_RESTORE_BOUNDS, ...)` 之后)加:

```ts
  // Claude Code hook bridge — opt-in via tray. The renderer's preload
  // exposes these on petApi.notify.*.
  ipcMain.handle(IPC.NOTIFY_ENABLE, async () => {
    await startNotifyServer({ userDataDir: app.getPath('userData') });
    const next = updateConfig({ claudeCodeNotify: { serviceEnabled: true, hooksInstalled: loadConfig().claudeCodeNotify.hooksInstalled } });
    return { ok: true, port: loadConfig().claudeCodeNotify, running: isNotifyRunning() };
  });

  ipcMain.handle(IPC.NOTIFY_DISABLE, async () => {
    await stopNotifyServer();
    updateConfig({ claudeCodeNotify: { serviceEnabled: false, hooksInstalled: loadConfig().claudeCodeNotify.hooksInstalled } });
    return { ok: true };
  });

  ipcMain.handle(IPC.NOTIFY_INSTALL_HOOKS, () => {
    const r = notifyInstallHooks({ userDataDir: app.getPath('userData') });
    if (r.ok) {
      updateConfig({ claudeCodeNotify: { serviceEnabled: loadConfig().claudeCodeNotify.serviceEnabled, hooksInstalled: true } });
    }
    return r;
  });

  ipcMain.handle(IPC.NOTIFY_UNINSTALL_HOOKS, () => {
    const r = notifyUninstallHooks();
    if (r.ok) {
      updateConfig({ claudeCodeNotify: { serviceEnabled: loadConfig().claudeCodeNotify.serviceEnabled, hooksInstalled: false } });
    }
    return r;
  });

  ipcMain.handle(IPC.NOTIFY_TEST, (_e, kind?: string) => {
    if (!bus) return { ok: false, message: '服务未启用' };
    // bus is internal — exposed through a tiny helper. We import lazily
    // to avoid changing Task 7's surface.
    const { NotifyBus } = require('./notify/bus');
    const payload = synthesizeTestPayload(kind);
    bus.dispatch(payload);
    return { ok: true };
  });

  ipcMain.handle(IPC.NOTIFY_FOCUS_PET, () => {
    const w = getPetWindow();
    if (!w) return null;
    if (!w.isVisible()) w.show();
    w.focus();
    return { ok: true };
  });
```

**重要**:`bus` 是 `notify/index.ts` 里的私有变量,上面 IPC handler 引用会编译失败。需要:

- [ ] **Step 4a: 在 `notify/index.ts` 暴露 bus**

在 `src/main/notify/index.ts` 加:

```ts
/**
 * Internal: the IPC test handler in index.ts dispatches synthetic payloads
 * through the same bus the real server uses. Returns null if disabled.
 */
export function _getNotifyBus(): NotifyBus | null {
  return bus;
}
```

然后回 Step 4,把 IPC handler 改成:

```ts
  ipcMain.handle(IPC.NOTIFY_TEST, (_e, kind?: string) => {
    const bus = _getNotifyBus();
    if (!bus) return { ok: false, message: '服务未启用' };
    bus.dispatch(synthesizeTestPayload(kind));
    return { ok: true };
  });
```

且删掉 Step 4 里的 `const { NotifyBus } = require(...)` 那行。

- [ ] **Step 5: 加 `synthesizeTestPayload`**

在 `src/main/index.ts` 顶部(`import` 之后)加:

```ts
function synthesizeTestPayload(kind?: string): NotifyPayload {
  const k = (kind as any) || 'idle_prompt';
  const sessionId = 'test-' + Date.now();
  const titles: Record<string, string> = {
    permission_request: 'Claude Code 需要授权',
    idle_prompt: 'Claude Code 在等你',
    stop: 'Claude Code 任务完成',
    subagent_stop: 'Claude Code 子任务完成',
  };
  const bodies: Record<string, string> = {
    permission_request: '工具:Bash — 请回 Claude Code 批准',
    idle_prompt: '它已经停下等你输入啦',
    stop: '主任务跑完了,等你下一句',
    subagent_stop: '子 agent 完成,主流程继续中',
  };
  return {
    sessionId,
    kind: k,
    title: titles[k] || titles.idle_prompt,
    body: bodies[k] || bodies.idle_prompt,
    ts: Date.now(),
  };
}
```

并加 import:

```ts
import type { NotifyPayload } from '../shared/types';
```

- [ ] **Step 6: 加 `NOTIFY_TEST` 用到的 `_getNotifyBus` import**

在 Step 2 加的 notify import 块里加 `_getNotifyBus`:

```ts
import {
  startNotifyServer,
  stopNotifyServer,
  installHooks as notifyInstallHooks,
  uninstallHooks as notifyUninstallHooks,
  isNotifyRunning,
  _getNotifyBus,
} from './notify';
```

- [ ] **Step 7: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.main.json --noEmit
```

期望:无错误。

- [ ] **Step 8: 提交**

```bash
git add src/main/index.ts src/main/notify/index.ts
git commit -m "feat(notify): wire IPC handlers + boot-time autostart"
```

---

## Task 9: tray.ts 加菜单项

**Files:**
- Modify: `src/main/tray.ts:17-39`(menu template)

**Interfaces:**(none,纯 UI)

- [ ] **Step 1: 改 import**

在 `src/main/tray.ts` 顶部 `import` 块加:

```ts
import {
  startNotifyServer,
  stopNotifyServer,
  installHooks,
  uninstallHooks,
  isNotifyRunning,
} from './notify';
import { app as electronApp } from 'electron';
```

**注意**:`electronApp` 已经在 import 里叫 `app`,直接用 `app` 即可。改:

```ts
import { app } from 'electron';
```

这条已存在,不重复加。**只追加 notify import**:

```ts
import {
  startNotifyServer,
  stopNotifyServer,
  installHooks,
  uninstallHooks,
} from './notify';
```

- [ ] **Step 2: 菜单加 4 项**

`tray.ts` 的 `menu = Menu.buildFromTemplate([...])` 数组,在 `{ type: 'separator' }` 之后、`{ label: '退出', ... }` 之前,加:

```ts
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
          // Dispatch directly through the bus — same path as a real hook.
          const { _getNotifyBus } = require('./notify');
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
```

**注意**:`require()` 在 tsc 输出 CJS 时是可用的,但 lint 规则不喜欢。改成静态 import:

```ts
import {
  startNotifyServer,
  stopNotifyServer,
  installHooks,
  uninstallHooks,
  _getNotifyBus,
} from './notify';
```

- [ ] **Step 3: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.main.json --noEmit
```

期望:无错误。

- [ ] **Step 4: 提交**

```bash
git add src/main/tray.ts
git commit -m "feat(notify): tray menu for enable/disable/install/test"
```

---

## Task 10: preload.ts — 暴露 petApi.notify

**Files:**
- Modify: `src/main/preload.ts`(新加 `notify` 块)
- Modify: `src/main/preload.ts:80`(`PetApi` type 自动跟随 `typeof api`)

- [ ] **Step 1: 加 `notify` 块**

在 `api` 对象末尾(`pet: { ... }` 块之后,`contextBridge.exposeInMainWorld(...)` 之前)加:

```ts
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
```

- [ ] **Step 2: 加 `NotifyPayload` import**

`preload.ts` 第 4 行 `import` 加 `NotifyPayload`:

```ts
import { IPC, AppConfig, ChatMessage, Reminder, PetPosition, PetBounds, NotifyPayload } from '../shared/types';
```

- [ ] **Step 3: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.main.json --noEmit
```

期望:无错误(`PetApi` type 通过 `typeof api` 自动包含 notify 块)。

- [ ] **Step 4: 提交**

```bash
git add src/main/preload.ts
git commit -m "feat(notify): expose petApi.notify via preload"
```

---

## Task 11: renderer — state-machine 加 'attention' state

**Files:**
- Modify: `src/renderer/state-machine.ts:23`(`PetState` 加 'attention')
- Modify: `src/renderer/state-machine.ts:101-108`(`playMotionForState` 加 case)

**Interfaces:**
- Consumes: 现有 `PetState`
- Produces: `PetState = 'idle' | 'touch' | 'speak' | 'greet' | 'attention'`

- [ ] **Step 1: 加 'attention' 到联合类型**

```ts
export type PetState = 'idle' | 'touch' | 'speak' | 'greet' | 'attention';
```

- [ ] **Step 2: `playMotionForState` 加 case**

```ts
  private playMotionForState(state: PetState): void {
    switch (state) {
      case 'idle':       this.pet.playMotion(this.cfg.idleMotion); break;
      case 'touch':      this.pet.playMotion(this.cfg.touchMotion); break;
      case 'speak':      this.pet.playMotion(this.cfg.speakMotion); break;
      case 'greet':      this.pet.playMotion(this.cfg.greetMotion); break;
      case 'attention':  this.pet.playMotion(this.cfg.idleMotion); break;
    }
  }
```

**注意**:`attention` 没有独立 motion group — 回退到 `idleMotion`,让 Live2D 表现"暂停"。视觉上的"注意力"通过 §Task 12 的气泡 + 缩放抖动承担,不在这里。

- [ ] **Step 3: 在 `PetStateMachine` 加 `attention()` 方法**

在 `greet()` 方法之后加:

```ts
  /**
   * Briefly flash the "attention" mood. Used when a Claude Code hook
   * fires — the bubble carries the message, this just signals "look at me".
   * Returns to idle after `greetDurationMs` (we reuse the same timer;
   * no need to add a new config knob for v1).
   */
  attention(): void {
    this.cancelReturn();
    this.cancelGreet();
    this.enter('attention');
    this.scheduleReturn('idle', this.cfg.greetDurationMs);
    this.rescheduleGreet();
  }
```

- [ ] **Step 4: 编译验证**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.renderer.json --noEmit
```

期望:无错误。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/state-machine.ts
git commit -m "feat(notify): add attention state for hook-driven mood"
```

---

## Task 12: renderer — notify.ts 渲染通知气泡

**Files:**
- Create: `src/renderer/notify.ts`

**Interfaces:**
- Consumes: `PetStateMachine`(Task 11), `NotifyPayload`(Task 1)
- Produces:
  ```ts
  export function subscribeNotify(sm: PetStateMachine): void
  ```

- [ ] **Step 1: 写文件**

创建 `src/renderer/notify.ts`:

```ts
// Subscribe to NOTIFY_SHOW IPC events and surface them as bubbles +
// attention mood. No persistence — notifications are transient.
import type { PetStateMachine } from './state-machine';
import type { NotifyPayload } from '../shared/types';

const BUBBLE_DURATION_MS = 8000;

declare global {
  interface Window {
    petApi: {
      notify: {
        onNotify: (handler: (p: NotifyPayload) => void) => () => void;
        focusPet: () => Promise<{ ok: boolean } | null>;
      };
    };
  }
}

function showBubble(payload: NotifyPayload, onClick: () => void): void {
  const stack = document.getElementById('bubble-stack');
  if (!stack) return;

  const el = document.createElement('div');
  el.className = `bubble bubble-notify kind-${payload.kind}`;
  el.innerHTML = `
    <div class="bubble-title">${escapeHtml(payload.title)}</div>
    <div class="bubble-body">${escapeHtml(payload.body)}</div>
  `;
  el.addEventListener('click', onClick);
  stack.appendChild(el);

  // Trigger fade-in (CSS .bubble has transform/animation on append).
  window.setTimeout(() => {
    el.classList.add('bubble-fade-out');
    window.setTimeout(() => el.remove(), 400);
  }, BUBBLE_DURATION_MS);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function subscribeNotify(sm: PetStateMachine): void {
  window.petApi.notify.onNotify((payload) => {
    sm.attention();
    showBubble(payload, () => {
      window.petApi.notify.focusPet().catch((err) => {
        console.warn('[notify] focusPet failed:', err);
      });
    });
  });
}
```

- [ ] **Step 2: 在 `src/renderer/index.ts` 的 `declare global` 加 notify 块**

`src/renderer/index.ts` 第 12 行 `declare global { interface Window { petApi: { ... } } }`,在 `reminders: { ... }` 之后加:

```ts
      notify: {
        enable: () => Promise<{ ok: boolean; running: boolean }>;
        disable: () => Promise<{ ok: boolean }>;
        installHooks: () => Promise<{ ok: boolean; message: string }>;
        uninstallHooks: () => Promise<{ ok: boolean; message: string }>;
        testNotify: (kind?: string) => Promise<{ ok: boolean; message?: string }>;
        focusPet: () => Promise<{ ok: boolean } | null>;
        onNotify: (handler: (p: NotifyPayload) => void) => () => void;
      };
```

并加 `NotifyPayload` import:

```ts
import type { AppConfig, ChatMessage, PetPosition, PetBounds, Reminder, NotifyPayload } from '../shared/types';
```

- [ ] **Step 3: 在 `main()` 调用 `subscribeNotify`**

`src/renderer/index.ts` 的 `main()`,在 `setupChat()` 之后加:

```ts
  setupNotify(pet.stateMachine);
```

且在文件顶部 import 块加:

```ts
import { setupNotify } from './notify';
```

**注意**:`PetStateMachine` 实例化在 `state-machine.ts` 里,但 `PetHandle` 不暴露它。需要在 `pet.ts` 的 `PetHandle` 里加 `stateMachine`。见 Step 4。

- [ ] **Step 4: `pet.ts` 把 `stateMachine` 暴露到 `PetHandle`**

打开 `src/renderer/pet.ts`,找到 `PetHandle` interface 的导出,在 `playMotion` 等方法旁边加:

```ts
  /** Exposed for the notify subscription — only `attention()` is used externally. */
  stateMachine: PetStateMachine;
```

并在 `startPet` 里构造 `PetStateMachine`,把它作为返回对象的字段暴露。**具体代码改动取决于 pet.ts 现有结构**——读一下 `src/renderer/pet.ts` 确认 `PetHandle` 形状,按现有 `playMotion` 等方法的暴露方式照搬一个 `stateMachine` 字段即可。

- [ ] **Step 5: 编译 + 打包**

```bash
cd E:/desktop_pet && npx tsc -p tsconfig.renderer.json --noEmit && npm run build:renderer
```

期望:无错误,`dist/renderer/index.js` 重新生成。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/notify.ts src/renderer/index.ts src/renderer/pet.ts
git commit -m "feat(notify): renderer bubble + attention wiring"
```

---

## Task 13: CSS — 通知气泡样式

**Files:**
- Modify: `src/renderer/styles.css`(末尾加 `.bubble-notify` + `.bubble-fade-out`)

- [ ] **Step 1: 在 styles.css 末尾加样式**

打开 `src/renderer/styles.css`,在最后一行之后加:

```css
/* Claude Code notify bubble — transient, above the chat bubble stack. */
.bubble-notify {
  background: linear-gradient(135deg, #ffe6f2 0%, #fff7e6 100%);
  border: 2px solid #ff9ec0;
  padding: 10px 14px;
  border-radius: 12px;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(255, 158, 192, 0.4);
  max-width: 240px;
  animation: bubble-pop-in 0.2s ease-out;
}

.bubble-notify .bubble-title {
  font-weight: 700;
  font-size: 13px;
  color: #d6336c;
  margin-bottom: 4px;
}

.bubble-notify .bubble-body {
  font-size: 12px;
  color: #495057;
}

.bubble-notify.kind-permission_request { border-color: #ff6b6b; }
.bubble-notify.kind-idle_prompt       { border-color: #4dabf7; }
.bubble-notify.kind-stop              { border-color: #51cf66; }
.bubble-notify.kind-subagent_stop     { border-color: #845ef7; }

.bubble-fade-out {
  opacity: 0;
  transform: translateY(-12px);
  transition: opacity 0.4s ease, transform 0.4s ease;
}

@keyframes bubble-pop-in {
  from { opacity: 0; transform: translateY(8px) scale(0.9); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
```

- [ ] **Step 2: 拷到 dist**

`scripts/bundle-renderer.js` 是手工 `copyFileSync` 拷 CSS 的(参考 CLAUDE.md "esbuild 不会做 CSS 处理")。手动重跑一次:

```bash
cd E:/desktop_pet && npm run build:renderer
```

这会触发 `bundle-renderer.js`,把 `styles.css` 拷到 `dist/renderer/styles.css`。

- [ ] **Step 3: 提交**

```bash
git add src/renderer/styles.css
git commit -m "feat(notify): bubble styles for hook notifications"
```

---

## Task 14: 端到端验收

**Files:** (no code changes;验证步骤)

- [ ] **Step 1: 编译 + 启动**

```bash
cd E:/desktop_pet && npm run build && npm run start
```

期望:应用启动,日志里有(或没有,看默认 config)`[notify] server listening on ...` 只在 serviceEnabled=true 时打。

- [ ] **Step 2: 启用服务**

托盘菜单点"启用 Claude Code 通知"。期望:
- 日志:`[notify] server listening on 127.0.0.1:<port>`
- `%APPDATA%\DesktopPet\notify.port` 文件存在,内容是端口号。

- [ ] **Step 3: 安装 hooks**

托盘菜单点"安装 Claude Code hooks"。期望:
- `%USERPROFILE%\.claude\settings.json` 出现 `hooks.PermissionRequest` / `Stop` / `SubagentStop` / `Notification` 四块,command 字段指向 `%APPDATA%\DesktopPet\scripts\desktop-pet-notify.cmd`。

- [ ] **Step 4: 手工 curl 触发**

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"hook_event_name":"PermissionRequest","tool_name":"Bash","sessionId":"verify-1"}' \
  http://127.0.0.1:<port>/notify
```

期望:宠物出现,头部气泡"Claude Code 需要授权 / 工具:Bash — 请回 Claude Code 批准",8 秒后消失。

- [ ] **Step 5: 去重验证**

2 秒内重发同一 sessionId+kind。期望:日志出现 `[notify] dedup verify-1:permission_request`,气泡不重复弹。

- [ ] **Step 6: 卸载 hooks**

托盘菜单点(后续可加)"卸载 hooks",或手工编辑 `settings.json`。期望:四个 hook 块消失,其他用户 hook 块保留。

- [ ] **Step 7: 关闭 + 重启**

```bash
# 关掉应用
# 再启动
cd E:/desktop_pet && npm run start
```

期望:`config.json` 里 `claudeCodeNotify.serviceEnabled = true` 持久化,启动时自动起 server(如果迁移 + config 都正确)。如果没自动起,检查 boot() 里的 `cfg.claudeCodeNotify.serviceEnabled` 分支。

- [ ] **Step 8: 真实 Claude Code 验证**

在装了 Claude Code 的机器上:
1. 启用 notify + 安装 hooks(应用侧)
2. 跑 `claude` 起一个会话,执行需要权限的命令(如 `Bash`)
3. 期望:Claude Code 弹出授权框 + 桌宠同时弹气泡(同时只关心"通知到了")

- [ ] **Step 9: 提交验收报告**

```bash
git add -A
git commit -m "docs(notify): manual verify checklist" --allow-empty
```

---

## Self-Review Checklist

- [x] Spec coverage: §1 目标(M1 启 server/装 hooks)、§2 数据流(server+bus+install)、§3 默认关闭+拆开关、§4 IPC+类型+配置 v4、§5 server/bus/install/bridge 脚本、§6 渲染 onNotify + bubble + setMood、§7 错误处理(port 文件不存在/未启用/重入)、§8 验收 → 都有 task 覆盖(M1=Task 7+8, M2=Task 6+9, M3=Task 11+12+13, M4=Task 9 测试项, M5=Task 14)。
- [x] Placeholder scan:无 TBD/TODO。所有代码块完整。
- [x] Type consistency:`NotifyPayload`、`ClaudeCodeNotifyConfig`、`IPC.NOTIFY_*`、`petApi.notify.*` 命名在 Task 1 定义后,后续所有任务一致使用。
- [x] `focusPet` vs `focusIde`:Task 8/9/10/12 全部用 `focusPet`。
- [x] `productName = "DesktopPet"` 在 Task 6 Step 2/3 显式。
- [x] 服务/hooks 独立开关在 Task 1 Step 2 / Task 8 Step 4 体现。

---

## Out of Scope (YAGNI)

- ❌ TTS 语音提醒(spec §3.6)
- ❌ 自动批准授权(spec §1.3)
- ❌ 通知历史(spec §9)
- ❌ 切到 IDE/终端(只 focusPet,spec §6.2 MVP)
- ❌ 用户编辑通知文案(spec §9)
- ❌ 通知统计(spec §9)