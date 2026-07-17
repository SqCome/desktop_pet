# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

跨平台桌面宠物(Windows + macOS),技术栈:**Electron + TypeScript + Live2D + LLM**。透明无边框置顶窗口,系统托盘常驻,接 OpenAI 兼容协议的对话 API。

## 常用命令

```bash
npm install          # 装依赖
npm run dev          # 开发:tsc 监听 + esbuild 打包 + electron 启动
npm run build        # 一次性编译主进程(tsc) + 渲染进程(esbuild)
npm run pack         # electron-builder 打 Win/Mac 安装包
npm run clean        # rm -rf dist/
```

`npm run dev` 会同时跑两个 watcher(`tsc -p tsconfig.main.json --watch` 和 `scripts/bundle-renderer.js` 的一次性构建),等主进程编译完自动启动 Electron。

## 架构要点

**两个进程,通过 IPC 解耦:**

- **主进程** (`src/main/`) — Node 环境。负责窗口创建、托盘、本地存储、LLM API 调用。所有敏感操作(API key、文件 I/O)都停留在这里。
- **渲染进程** (`src/renderer/`) — Chromium 环境。负责 Live2D 渲染、动画、UI、鼠标交互。通过 `window.petApi`(在 `src/main/preload.ts` 暴露)与主进程通信。
- **共享类型** (`src/shared/types.ts`) — `IPC` 通道常量、`AppConfig`、`ChatMessage` 等,主/渲两端必须一致。

**构建差异:**
- 主进程:`tsc` 直接编译成 CommonJS 到 `dist/main/`,`package.json` 的 `main` 字段指向 `dist/main/index.js`。
- 渲染进程:`tsc` 不发射(`noEmit: true`),改用 **esbuild** 打包成单文件 ESM 到 `dist/renderer/index.js`。这样 `loadFile()` 能直接加载,且 pixi.js / pixi-live2d-display 的深层 import 也能正确解析。

## 关键设计决策

1. **点击穿透 + 区域检测**:窗口默认 `setIgnoreMouseEvents(true, { forward: true })`。渲染层用 `mouseenter`/`mouseleave` 通知主进程切换 `setInteractive(true)`,主进程再切回 `setIgnoreMouseEvents(false)`。效果是宠物本体可拖动/可点击,周围空白处直接穿透到桌面。
2. **关闭 ≠ 退出**:`window-all-closed` 事件 `preventDefault()`,应用继续在托盘运行。只有托盘"退出"菜单调 `app.exit(0)` 才真正退出。
3. **macOS 差异**:`app.dock?.hide()` + `setVisibleOnAllWorkspaces` + 窗口层级 `floating`,让宠物像"桌面上的东西"而非"应用窗口"。
4. **single-instance lock**:重复启动 `app.quit()`,已有实例聚焦。Mac 上特别需要,因为没有可见 Dock 图标,容易让人误以为没启动。
5. **拖拽实现**:不写自定义移动逻辑 —— `frame: false` + 鼠标事件不穿透,Electron 自动允许用户拖动窗口边界。要加"边缘吸附""锁定边界"再上 `pet:drag` 自定义事件 + 主进程 IPC。
6. **Live2D 渲染限频**:`live2d.ts` 里 `app.ticker.maxFPS = 30`,`pointermove` 用 `requestAnimationFrame` 合并。144Hz 显示器下不做这两步会让透明窗口在 Windows DWM 合成上吃一个核。降到 30fps 肉眼几乎看不出区别,CPU 占用降到原来的 1/3-1/5。要恢复全帧率(给性能更好的机器)直接改这两处。
6. **LLM 适配**:只支持 OpenAI 兼容协议(`/chat/completions` 流式)。OpenAI / DeepSeek / Moonshot / Ollama / LM Studio 都覆盖。Anthropic 协议不同,要加需另写 adapter。

## 添加新功能时的扩展点

- **新工具**(天气/笔记/提醒):在 `src/main/tools/` 加模块,IPC 加通道,在 `src/shared/types.ts` 加常量。渲染层 UI 入口在 `src/renderer/index.html` 的 `#menu`。
- **新动画状态**:Live2D 加载在 `src/renderer/live2d.ts`,目前只做了呼吸缩放。动画状态机还没建,建议用简单的状态字符串(`'idle' | 'walk' | 'touch' | 'speak'`) + PIXI ticker 驱动 motion。
- **新 LLM provider**:在 `src/main/llm/client.ts` 加 switch case,或者直接换 `baseUrl` 即可(OpenAI 协议的话)。
- **新模型**:放 `assets/models/pet/`,确保有 `pet.model3.json`(可在 `src/renderer/pet.ts` 改探测路径)。

## 常见踩坑

- 编译失败先看是哪个进程:`build:main` 还是 `build:renderer`。两者用不同配置,排查方向不同。
- macOS 第一次运行可能弹出"无法验证开发者",需要系统设置 → 隐私与安全性 → 仍要打开。
- `transparent: true` 在某些旧 GPU 驱动下会有黑边。可以在 `src/main/window.ts` 临时关掉排查。
- 桌面宠物默认启用硬件 GPU 加速,Chromium 自己探测并 fallback。如果用户的驱动在 `transparent: true` 下不稳(GPU 进程反复崩),用 `PET_DISABLE_GPU=1 npm run dev` 强制走 SwiftShader 软件渲染作为兜底。**不要**再用旧的 `PET_GPU=1`(已废弃,效果等价于默认行为)。
- esbuild 不会做 CSS 处理。`styles.css` 是手工 `copyFileSync` 过去的,改完要重启 dev 才会生效(`scripts/bundle-renderer.js` 一次性执行,没监听)。如果想要 CSS 热更新,加 chokidar 或换成 vite。