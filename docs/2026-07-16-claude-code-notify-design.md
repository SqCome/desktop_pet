# Claude Code Hook 通知接入 — 设计文档

**日期**: 2026-07-16
**作者**: brainstorming 与用户协作产出
**状态**: 待审

---

## 1. 目标与边界

### 1.1 要解决的痛点

用户在使用 **Claude Code**(Claude 官方的命令行编码 agent)时,经常出现以下场景:
- Claude 跑任务跑到一半,弹出授权询问框(`PermissionRequest`),需要用户手动批准
- 后台 / 子 agent 任务完成(`SubagentStop`),用户在另一个窗口
- 主任务结束(`Stop`),等你下一句
- 长时间 idle(`Notification: idle_prompt`),等待输入

此时用户在 IDE / 浏览器 / 其他窗口,需要**主动切回** Claude Code。桌面宠物作为常驻应用,适合做"提醒者"。

### 1.2 这次要做什么

让桌面宠物在 Claude Code 触发 hook 时,**通过动画 + 气泡**主动提醒用户,并提供"回到 IDE"的快捷操作。

### 1.3 明确 *不做* 的事

- **不做** LLM 对话(那是另一个特性,CLAUDE.md 里 LLM 模块走 OpenAI 兼容协议)
- **不做** TTS 语音播报(本次选择:纯视觉提醒)
- **不做** 自动批准授权 —— 我们只提醒,不替代用户在 Claude Code 自己的授权弹窗里做决定
- **不动** 现有的 `reminders/` 模块 —— 它是用户主动设的跨设备提醒服务(Go backend),与 Claude Code 外部触发是完全不同的数据流,**两者独立共存**

### 1.4 与现有 reminders 模块的关系

为避免误读,这里明确表格化:

| 维度 | reminders(已有) | claude-code-notify(新) |
|---|---|---|
| 数据来源 | 用户在宠物菜单里主动设 / 跨设备同步 | Claude Code hook 推送 |
| 后端 | Go `remindersd` + bearer token | **无** —— 本地 HTTP server |
| 触发方向 | 时间到了 → 提醒 | 外部事件 → 提醒 |
| 数据形状 | `Reminder[]`,有 `fireAt` | `NotifyPayload`,有 `event` 类型 |

两者入口都在 `webContents.send` → 渲染层,但在主进程的逻辑链是完全分离的两条线。新功能落 `src/main/notify/`,不复用 `reminders/`。

---

## 2. 总体架构

### 2.1 数据流

```
                          ┌─────────────────────────────┐
                          │  Claude Code 进程            │
                          │  (用户终端 / IDE 内)          │
                          └──────────┬──────────────────┘
                                     │ 触发 hook(同步阻塞,<1s)
                                     │ 写 payload 到 stdin
                                     ▼
                          ┌─────────────────────────────┐
                          │  desktop-pet-notify(.cmd/.sh)│
                          │  桥接脚本(用户目录)            │
                          │  ① 读 notify.port 文件        │
                          │  ② curl POST 127.0.0.1:port   │
                          │  ③ 不管成败 exit 0            │
                          └──────────┬──────────────────┘
                                     │ HTTP localhost
                                     ▼
┌────────────────────────────────────────────────────────────────────┐
│  Electron 主进程 (Node 环境)                                        │
│                                                                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐    │
│  │ notify-server.ts│  │ notify-bus.ts   │  │ install-hooks.ts│    │
│  │  HTTP server    │─▶│ 去重 / 防抖 /   │  │ 写 ~/.claude/   │    │
│  │  端口写到文件   │  │ 分类 / 分发     │  │ settings.json   │    │
│  └─────────────────┘  └────────┬────────┘  └─────────────────┘    │
│                                │                                   │
│                  webContents.send('notify:show', payload)         │
└────────────────────────────────────┬───────────────────────────────┘
                                     │ IPC
                                     ▼
┌────────────────────────────────────────────────────────────────────┐
│  渲染进程 (Chromium)                                                │
│                                                                    │
│  petApi.onNotify(payload)                                          │
│       ├─ pet.setMood('attention')                                   │
│       ├─ bubble.show({title, body, kind})                          │
│       └─ 气泡可点击 → petApi.focusPet() → 主进程切焦点            │
└────────────────────────────────────────────────────────────────────┘
```

### 2.2 模块清单(主进程)

新增 3 个文件 + 1 个目录(放桥接脚本):

| 文件 | 职责 | 估行数 |
|---|---|---|
| `src/main/notify/server.ts` | 起 HTTP server,绑定 `127.0.0.1:<随机空闲端口>`,写 `userData/notify.port`,注册 `POST /notify` 路由 | ~70 |
| `src/main/notify/bus.ts` | 按 `sessionId + kind` 去重(2s 内同 ID 不重复),按事件类型分类,推送给窗口 | ~50 |
| `src/main/notify/install-hooks.ts` | 读写 `~/.claude/settings.json`,幂等地插入/卸载 hooks 块 | ~80 |
| `src/main/notify/scripts/desktop-pet-notify.cmd` | Windows 桥接(读端口 + curl,exit 0) | ~15 |
| `src/main/notify/scripts/desktop-pet-notify.sh` | macOS / Linux 桥接 | ~10 |
| `src/main/notify/index.ts` | 暴露 `startNotifyServer` / `stopNotifyServer` / `installHooks` / `uninstallHooks` | ~10 |

### 2.3 改动现有文件

| 文件 | 改动 |
|---|---|
| `src/main/index.ts` | 在 `app.whenReady` 里注册通知开关(默认关闭),新增 IPC `NOTIFY_ENABLE` / `NOTIFY_DISABLE` / `NOTIFY_INSTALL_HOOKS` / `NOTIFY_UNINSTALL_HOOKS` / `NOTIFY_TEST` |
| `src/main/preload.ts` | 暴露 `petApi.onNotify` / `petApi.focusPet` / `petApi.setNotifyEnabled` / `petApi.installHooks` / `petApi.uninstallHooks` / `petApi.testNotify` |
| `src/main/tray.ts` | 托盘菜单增加:"启用 Claude Code 通知" / "安装 hooks" / "卸载 hooks" / "测试通知" |
| `src/shared/types.ts` | 加 `IPC.NOTIFY_*`、`NotifyPayload` 类型、`AppConfig.claudeCodeNotify: { enabled: boolean }` 字段(版本 `v4` + 迁移) |
| `src/renderer/pet.ts` | 加 `setMood('attention')` —— 实现为 0.3s 缩放抖动,400ms 后回 `idle`(与现有 `state-machine.ts` 对齐) |
| `src/renderer/index.ts` | 订阅 `onNotify` 事件、调 `bubble.show` 和 `pet.setMood`,气泡点击调 `petApi.focusIde` |

---

## 3. 关键设计决策

### 3.1 服务默认关闭,菜单手动开;hooks 安装是独立动作

**为什么这样选**:Electron 启动就 listen 一个端口,对未启用此功能的用户是"无形的负担"——不是性能问题,是心理负担(在系统里留了痕迹)。让用户主动从托盘菜单启用,意图清晰、零默认副作用。

**为什么要拆成两个开关**:
- "起 HTTP server"和"写 ~/.claude/settings.json"是两件事:用户可能想**先关掉 server,留着 hooks**(暂时不想被打扰);也可能在别处装了 hooks,只想**启动 server** 来收通知。把它们合一个布尔位会让用户表达不清。
- 所以 `claudeCodeNotify` 是对象不是布尔位:
  ```ts
  interface ClaudeCodeNotifyConfig {
    /** 是否起本地 HTTP server 接收 hook 推送。默认 false。 */
    serviceEnabled: boolean;
    /** ~/.claude/settings.json 里是否包含 desktop-pet-notify hooks。默认 false。 */
    hooksInstalled: boolean;
  }
  ```
- 菜单提供四个动作:启用/禁用服务、安装/卸载 hooks,各自独立写自己的字段。
- 安装 hooks 时**不强制**起 server;启用 server 时**不强制**装 hooks。两者互不干扰。

### 3.2 端口写文件,不硬编码

**为什么**:
- Electron 单实例锁已保证只有一个进程,但跟用户其他本地服务可能冲突
- 用户每次重启应用,端口可能变(用 `server.listen(0)` 让 OS 分配)
- hooks 命令需独立于应用生命周期执行,必须从外部读取当前端口

**实现**:`app.whenReady` → `http.createServer().listen(127.0.0.1, 0, () => { fs.writeFileSync(path.join(userData, 'notify.port'), server.address().port) })`。禁用时立即 `server.close()` 并**删除端口文件**(让钩子命令清晰失败)。

### 3.3 Hook 命令始终 `exit 0`

**为什么**:
- Claude Code 的 hook timeout 默认 15s,超时它会继续跑但 stderr 污染用户终端
- 我们的命令是个"通知员",不是"决策者",挂了不能让用户感知

**实现**:`desktop-pet-notify.cmd/.sh` 用 `try { curl ... } catch { log to file } finally { exit 0 }` 包住,失败只在本地日志留痕。

### 3.4 桥接脚本放在 `userData`,安装时拷过去

**为什么**:
- 命令里需要硬编码脚本路径,放项目目录开发期 OK,打 `asar` 后路径会变
- `userData` 在 dev / prod 都是稳定路径(`C:\Users\<u>\AppData\Roaming\desktop_pet\scripts\` 或 `~/Library/Application Support/desktop_pet/scripts/`)
- 安装 hooks 时由主进程自己负责拷文件 + 写 `settings.json`,**省得用户复制粘贴**

**路径记法**:`hooks command` 字段最终是 `"<userData>/scripts/desktop-pet-notify.cmd"`(Windows) / `"<userData>/scripts/desktop-pet-notify.sh"`(其他)。脚本里**第一行** 根据平台选择执行器(`@echo off` vs `#!/usr/bin/env bash`)。

### 3.5 去重 / 分类在主进程,不在渲染

**为什么**:
- 渲染层只关心"现在该显示什么 + 怎么显示",主进程管"该不该显示"
- 同一个 hook 因为网络重试可能在 1~2s 内触发多次,要去重
- `PermissionRequest` 紧接着 `Stop`(用户批准了)中间不要再触发两次"idle 等待"

**实现**(`bus.ts`):维护 `Map<sessionId, lastFireAtMs>`,同 sessionId 同 kind 在 2000ms 内不重复触发。

### 3.6 不引 TTS 语音

**已与用户确认**:仅动画 + 气泡。理由是 TTS 在 Windows 上要走 SAPI 5,macOS 上用 `say` 命令,跨平台一致性差、增加 Electron 体积,且在工位上语音提醒打扰他人。只动效 + 气泡,够用且克制。

---

## 4. IPC 与类型契约

### 4.1 新增 IPC 通道(`src/shared/types.ts`)

```typescript
export const IPC = {
  // ... 既有通道 ...
  /** 启用 Claude Code 通知(起 HTTP server) */
  NOTIFY_ENABLE: 'notify:enable',
  /** 停用(关 server) */
  NOTIFY_DISABLE: 'notify:disable',
  /** 写 ~/.claude/settings.json */
  NOTIFY_INSTALL_HOOKS: 'notify:install-hooks',
  /** 从 ~/.claude/settings.json 移除 */
  NOTIFY_UNINSTALL_HOOKS: 'notify:uninstall-hooks',
  /** 触发一次测试通知(payload 里注入假数据) */
  NOTIFY_TEST: 'notify:test',
} as const;
```

`notify:show` 跟其他通道一起进 `IPC` 表(main → renderer 推送也走统一的常量,方便两端搜索引用):

```typescript
NOTIFY_SHOW: 'notify:show',  // main → renderer 推送
```

### 4.2 NotifyPayload 类型

```typescript
/**
 * 主进程收到的 hook payload → 转发给渲染端。
 * 字段尽量兼容 Claude Code hooks 文档,但宽容解析:缺失字段降级。
 */
export type NotifyPayload = {
  /** 用于去重。Claude Code 自带,fallback 用 Math.random。 */
  sessionId: string;
  /**
   * 归一化后的事件类型。`normalizeHook()` 把 Claude Code 的 hook_event_name
   * 映射到以下四种:
   *   PermissionRequest → permission_request
   *   Notification      → idle_prompt(我们只关心 idle_prompt 这一种)
   *   Stop              → stop
   *   SubagentStop      → subagent_stop
   * 其他 hook(PreToolUse、PostToolUse 等)被 `normalizeHook` 丢弃 —— 我们
   * 不需要"每次工具调用都提醒"那么高频率。Notification 里其它子类
   * (auth_success、elicitation 等)也丢弃。
   */
  kind: 'permission_request' | 'idle_prompt' | 'stop' | 'subagent_stop';
  /** 渲染层显示的标题(主进程拼好,渲染层不二次翻译) */
  title: string;
  /** 气泡正文(<= 80 字) */
  body: string;
  /** 鼠标点击气泡 → focusPet() 的额外上下文 */
  focusHint?: { kind: 'ide' | 'terminal'; value: string };
  /** ms epoch,渲染层展示 "3 秒前" 用 */
  ts: number;
};
```

### 4.3 配置字段(版本 v4 迁移)

```typescript
export interface ClaudeCodeNotifyConfig {
  serviceEnabled: boolean;   // 起 HTTP server
  hooksInstalled: boolean;   // 写 ~/.claude/settings.json
}

export interface AppConfig {
  // ... 既有字段 ...
  claudeCodeNotify: ClaudeCodeNotifyConfig;
}

export const CURRENT_CONFIG_VERSION = 4;  // 之前是 3
```

迁移逻辑在 `src/main/storage.ts` 已有框架(`loadConfig` 走版本链),新增 v3 → v4 加默认值即可:`claudeCodeNotify = { serviceEnabled: false, hooksInstalled: false }`。`DEFAULT_CONFIG` 同步加同样默认值。

---

## 5. 主进程行为详解

### 5.1 `notify-server.ts`

```typescript
// 伪代码核心
export class NotifyServer {
  private server: http.Server | null = null;
  private portFile: string;

  start(bus: NotifyBus): Promise<{ port: number }> {
    this.server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/notify') {
        this.handleNotify(req, res, bus);
      } else {
        res.writeHead(404); res.end();
      }
    });
    return new Promise((resolve) => {
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address() as AddressInfo;
        fs.writeFileSync(this.portFile, String(addr.port));
        console.log(`[notify] server listening on 127.0.0.1:${addr.port}`);
        resolve({ port: addr.port });
      });
    });
  }

  private async handleNotify(req, res, bus) {
    // 关键:先把 200 OK 写出去,再读 body,避免 Claude Code 被无谓的 RTT 拖住。
    // 然后在后台异步读 body + dispatch。HTTP server 会在 callback 返回后自动
    // 关闭 socket;读完 body 后 dispatch() 通过 webContents.send 推到渲染层,
    // 不依赖 res。
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    readBody(req).then((buf) => {
      try {
        const raw = JSON.parse(buf);
        const payload = normalizeHook(raw);
        bus.dispatch(payload);
      } catch (err) {
        console.warn('[notify] bad payload:', err);
      }
    }).catch((err) => console.warn('[notify] readBody:', err));
  }

  stop() {
    if (this.server) { this.server.close(); this.server = null; }
    try { fs.unlinkSync(this.portFile); } catch { /* */ }
  }
}
```

**注意 `res.end()` 在 `await readBody` 之前** —— 不能等读完才回,否则 Claude Code 会被不必要的延迟。这是反直觉但必须的写法(读 body 完成前先回 200)。

### 5.2 `notify-bus.ts`

```typescript
type Kind = NotifyPayload['kind'];
interface RecentFire { at: number; kind: Kind; }
const recent = new Map<string, RecentFire>();
const DEDUP_WINDOW_MS = 2000;

export class NotifyBus {
  constructor(private windows: () => BrowserWindow[]) {}

  dispatch(p: NotifyPayload): void {
    const key = `${p.sessionId}:${p.kind}`;
    const prev = recent.get(key);
    if (prev && Date.now() - prev.at < DEDUP_WINDOW_MS) {
      console.log(`[notify] dedup ${key}`);
      return;
    }
    recent.set(key, { at: Date.now(), kind: p.kind });
    for (const w of this.windows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.NOTIFY_SHOW, p);
    }
  }
}
```

### 5.3 `install-hooks.ts`

```typescript
const SETTINGS_PATH_WIN = join(homedir(), '.claude', 'settings.json');
// path-on-mac 不一样,但目录名一样,跨平台一致

export function installHooks(): { ok: boolean; message: string } {
  const scriptPath = join(userData, 'scripts', isWin ? 'desktop-pet-notify.cmd' : 'desktop-pet-notify.sh');
  // 1. 拷脚本到 userData(若尚未存在)
  copyBridgeScripts();
  // 2. 读 ~/.claude/settings.json(若无则建空 {})
  // 3. 合并 hooks:
  //    settings.hooks.PermissionRequest = [{ hooks: [{ type: 'command', command: scriptPath }] }]
  //    同理 Stop / SubagentStop / Notification
  // 4. 写回 settings.json(注意保留用户已有 hooks)
  //    用 JSON.stringify(..., null, 2) 保证可读
}
```

**幂等性**:每次写入前先判断 `PermissionRequest` 数组里是否已有 `"desktop-pet-notify"` 命令,有则跳过。卸载同理。

### 5.4 桥接脚本

**`desktop-pet-notify.cmd`(Windows)**:
```cmd
@echo off
setlocal
rem Windows userData = %APPDATA%\<productName>,productName 来自 package.json build.productName,
rem 当前为 "DesktopPet"。脚本是桥接器,不知道 productName 字段名,直接用字面值。
rem 如果改 productName 务必同步这里(或者改成由主进程 install 时生成模板)。
set PORT_FILE=%APPDATA%\DesktopPet\notify.port
if not exist "%PORT_FILE%" exit /b 0
set /p PORT=<"%PORT_FILE%"
if "%PORT%"=="" exit /b 0
curl -s -X POST -H "Content-Type: application/json" --data-binary @- http://127.0.0.1:%PORT%/notify >nul 2>nul
exit /b 0
```

**`desktop-pet-notify.sh`(macOS / Linux)**:
```bash
#!/usr/bin/env bash
# macOS userData = $HOME/Library/Application Support/DesktopPet
# Linux userData = $HOME/.config/DesktopPet
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

---

## 6. 渲染层交互

### 6.1 通知展示流程

```
[onNotify 触发]
     │
     ├─ 1. pet.setMood('attention')
     │     └─ 调用现有 state-machine.ts 的 setMood,
     │        新增 'attention' 状态:0.3s 缩放抖动 2 次后回 'idle'
     │
     ├─ 2. bubble.show({ title, body, kind })
     │     └─ 在宠物头顶 50px 处显示气泡,8 秒后自动消失
     │        用户点击 → petApi.focusPet(payload.focusHint)
     │
     └─ 3. 不持久化,不留历史(避免误以为是聊天消息)
```

### 6.2 `focusPet` 的诚实实现

**坦白说**:从 Electron 里切到"用户上次活跃的 IDE/终端窗口"是平台相关的、不可靠的。我们做:
- macOS: `tell application "Terminal" to activate` / `tell application id "com.microsoft.VSCode" to activate`(通过 `child_process.exec`)
- Windows: 用 `GetForegroundWindow` + EnumWindows 找到最近一次的 VS Code 窗口(借助 `node-window-manager` 或干脆不实现,只 `BrowserWindow.focus()` 把自己切到前台)

**MVP 决定**:`focusPet()` 只做一件事 —— 把宠物自己窗口 focus 到前台(`mainWindow.focus()`)。命名也跟着改名 —— 既然实际只 focus 宠物自己,IPC 接口名就叫 `focusPet`,不再叫 `focusIde`。用户视觉上会被"打断",自然会去想"我刚才在干嘛",回忆起 Claude Code 在等他。这是一个**诚实且不依赖平台魔法**的降级实现。

后续如果用户强烈需要"切到 IDE",再加 `focusIde` IPC,接口名也对应起来。

---

## 7. 错误处理与边界

| 场景 | 当前行为 |
|---|---|
| HTTP server 启动失败(端口被占) | 主进程 warn,不 crash;写"未运行"标记文件,菜单显示"启动失败,点击重试" |
| 钩子命令调用时 app 未启动 | 端口文件不存在,桥接脚本立即 exit 0,Claude Code 不感知 |
| 钩子命令调用时 app 已退出 | 同上 |
| port 文件存在但端口是上次的(进程崩了没删) | 主进程启动时检查文件与真实端口是否一致,不一致覆盖 |
| `~/.claude/settings.json` 不存在 | install 时创建,uninstall 不报错 |
| `~/.claude/settings.json` 已有其他 hook | 用深度合并,保留用户已有 hook 块 |
| 用户切换 shell(PowerShell / zsh / fish) | 桥接脚本是独立 `.cmd`/`.sh` 文件,不依赖 shell |
| macOS Gatekeeper 拦截脚本 | 不存在,`.sh` 不需要签名,文件权限 755 |

---

## 8. 验收清单(可测试项)

- [ ] 托盘菜单点"启用通知",日志显示 `[notify] server listening on 127.0.0.1:<port>`,端口文件已写入
- [ ] 同菜单点"禁用",日志显示 `[notify] server stopped`,端口文件已删除
- [ ] 菜单点"安装 hooks",`~/.claude/settings.json` 出现 `PermissionRequest`、`Stop`、`SubagentStop`、`Notification` 四块
- [ ] 卸载后,这四块从 `settings.json` 消失,其他用户 hook 块保留
- [ ] 手工触发:
  ```bash
  curl -X POST -H "Content-Type: application/json" \
    -d '{"hook_event_name":"PermissionRequest","tool_name":"Bash","sessionId":"test-1"}' \
    http://127.0.0.1:<port>/notify
  ```
  宠物出现,头部气泡"Claude Code 需要授权 Bash"
- [ ] 同一 sessionId 在 2 秒内重发不重复触发(日志 `[notify] dedup test-1:permission_request`)
- [ ] 关闭窗口(只隐藏到托盘),通知仍然能进来
- [ ] 把宠物主进程 kill 掉后,Claude Code 触发 hook,Claude Code 仍能继续(只 stderr 有 curl 失败日志)
- [ ] 跨平台实测:macOS + Windows 各跑一次手工 curl

---

## 9. 不在本次范围(明确 YAGNI)

- ❌ 通知历史 / 列表
- ❌ 自定义每个事件的通知文案(只有内置模板)
- ❌ TTS 语音
- ❌ 自动批准授权
- ❌ 把 Claude Code 的对话也接到宠物(那是另一个特性)
- ❌ 通知统计 / 用户行为分析

---

## 10. 实施步骤概要

不写逐步实现(留给 writing-plans skill 详细展开),只列里程碑:

1. **M1 主进程骨架**:`notify/index.ts` + `server.ts` + 配置字段 v4 + 启动/停止 API
2. **M2 桥接 & 安装**:`install-hooks.ts` + 两个桥接脚本 + 菜单按钮
3. **M3 渲染端**:`onNotify` 订阅 + 气泡 + `setMood('attention')`
4. **M4 测试**:`NOTIFY_TEST` IPC + 托盘"测试通知"按钮
5. **M5 跨平台验证**:macOS + Windows 手工 curl + 真实 Claude Code 各跑一次
