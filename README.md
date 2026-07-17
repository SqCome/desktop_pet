# Desktop Pet 🐾

一个跨平台的桌面宠物(Windows + macOS),基于 **Electron + Live2D + LLM**。

## ✨ 功能

- 🎨 透明无边框置顶窗口,Live2D 模型(占位为 SVG 圆形,等你接入模型)
- 🖱 鼠标拖拽、悬停反馈、点击穿透
- 💬 AI 对话(OpenAI 兼容协议,支持任意厂商)
- 🌤 提醒 / 天气 / 笔记工具入口(规划中)
- 🛡 系统托盘常驻,关闭宠物窗口 ≠ 退出

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 开发模式(自动编译 + 启动)
npm run dev

# 3. 打包发布
npm run pack
```

第一次启动会看到一只占位"小黄鸡"。要让它变成真正的 Live2D 模型,见下一节。

## 📦 项目结构

```
desktop_pet/
├── src/
│   ├── main/         # 主进程:窗口、托盘、LLM、IPC
│   ├── renderer/     # 渲染进程:Live2D、UI、交互
│   └── shared/       # 共享类型
├── scripts/          # 构建脚本
├── assets/
│   └── models/       # ← 把 Live2D 模型放在这里
└── dist/             # 编译产物
```

## 🎭 接入 Live2D 模型

1. 下载 Cubism 4 兼容的模型(`.moc3` + `.model3.json` + 贴图)。
2. 把整个模型文件夹放到 `assets/models/pet/`。
3. 确保目录里存在 `assets/models/pet/pet.model3.json`(否则就改 `src/renderer/pet.ts` 里的探测路径)。
4. 重启 `npm run dev` —— 渲染层会自动检测并加载。

**免费模型资源**:
- [Live2D Cubism 官方示例](https://www.live2d.com/en/download/sample-data/)
- [VTube Studio 模型资源站](https://github.com/malu-Live2D/)

## 🤖 配置 LLM

打开系统托盘 → 设置(未来),或在应用数据目录直接编辑 `config.json`:

- macOS: `~/Library/Application Support/desktop-pet/config.json`
- Windows: `%APPDATA%\desktop-pet\config.json`

```json
{
  "llm": {
    "provider": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "sk-...",
    "model": "gpt-4o-mini"
  }
}
```

任何 OpenAI 兼容服务都能用 —— DeepSeek、Moonshot、Together、Groq、Ollama、LM Studio……

## 🛠 开发

| 命令 | 作用 |
|---|---|
| `npm run dev` | 监听编译 + 启动 Electron |
| `npm run build` | 一次性编译主进程 + 渲染进程 |
| `npm run pack` | 打包成 Win/Mac 安装包 |
| `npm run clean` | 清理 `dist/` |

### 单进程单测运行

```bash
npm run build:main && npx tsc -p tsconfig.main.json --noEmit  # 类型检查
npm run build:renderer                                            # 打包 renderer
```

## 🐛 常见问题

**Q: 启动后看不到宠物?**
A: 检查窗口是否被桌面遮挡,或者 `transparent: true` 在某些 GPU 驱动下失效。试试 `npm run dev` 看控制台。

**Q: 鼠标点不到宠物?**
A: 这是预期的"点击穿透"行为 —— 只有鼠标悬停在宠物本体上时才会接收事件。

**Q: macOS 上从 Dock 启动了两次?**
A: 应用已注册 single-instance lock,第二次启动会自动激活已有窗口。Dock 图标已隐藏,这是有意的。

## 📅 路线图

- [x] MVP:透明窗口 + 占位形象 + 拖拽
- [x] 托盘菜单 + LLM 流式对接
- [ ] Live2D 模型加载与动画状态机
- [ ] 提醒 / 天气 / 笔记工具
- [ ] 启动性能优化(预加载 + 懒加载)
- [ ] 自动更新(electron-updater)
- [ ] 多模型切换 / 换肤

## 📦 构建与发布

### 本地打包

```bash
npm run pack       # 默认按当前平台打 (.exe on Windows, .dmg on macOS)
npm run pack:win   # 强制打 Windows
npm run pack:mac   # 强制打 macOS(在 Mac 上跑才有效)
```

产物在 `release/` 目录:
- Windows: `DesktopPet-Setup-0.1.0.exe`
- macOS: `DesktopPet-0.1.0-arm64.dmg` 和 `DesktopPet-0.1.0-x64.dmg`

### GitHub Actions 自动构建

`.github/workflows/build.yml` 在 tag 推送时跑两个平台:

```bash
git tag v0.1.0
git push origin v0.1.0
```

会产出对应平台的安装包并上传到 GitHub Release。

### 首次启动 — 绕过签名警告

本项目**默认不打代码签名**(Windows 代码签名证书和 Apple Developer 账号都不便宜 —— 这通常不适合个人/小项目)。未签名的安装包依然能装,但首次启动会有 OS 警告:

**Windows (SmartScreen)**:
1. 双击 `DesktopPet-Setup-0.1.0.exe`
2. 看到"Windows 已保护你的电脑" → 点 **更多信息** → **仍要运行**
3. 之后启动就不会再问

**macOS (Gatekeeper)**:
1. 双击 `.dmg` → 拖入 Applications
2. 启动时看到"无法验证开发者" → **按住 Control 键点图标** → **打开** → 在新弹窗里点 **打开**
3. 之后启动就不会再问

### 给项目加签名(可选)

如果你想要无警告的安装体验,需要:

| 平台 | 需要 | 来源 |
|---|---|---|
| Windows | 代码签名 `.pfx` 证书 + 密码 | DigiCert / Sectigo / GlobalSign,几百到几千块/年 |
| macOS | Apple Developer Program($99/年) + Developer ID 应用证书 | [developer.apple.com](https://developer.apple.com) |

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加:

```
CSC_LINK                    # Windows + macOS 通用:证书 base64(.pfx / .p12)
CSC_KEY_PASSWORD            # 证书密码
APPLE_ID                    # Apple ID 邮箱(用于公证)
APPLE_APP_SPECIFIC_PASSWORD # App-specific 密码
APPLE_TEAM_ID               # 10 位 Team ID
```

下次 tag 推送会自动签名 + 公证,产物在 Release 页直接下载安装,无警告。

## 📄 License

MIT