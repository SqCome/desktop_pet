# Pet Assets

把宠物的资源放到这个目录下。**检测优先级**:Live2D > GIF > PNG 序列帧 > 占位小黄鸡。

> 想换资源目录?在 `config.json` 里改 `pet.assetDir`,默认 `pet`。

## 三种模式,任选一种(或都不放,显示占位)

### 模式 1:Live2D(动效最好)

把 Cubism 4 模型的所有文件放到 `live2d/`,**入口文件必须叫 `pet.model3.json`**(否则要改 `src/renderer/pet.ts` 里的探测路径):

```
pet/live2d/
├── pet.model3.json     ← 入口,必须这个名字
├── pet.moc3
├── textures/*.png
└── (可选) motions/*.motion3.json
```

**下载**:https://www.live2d.com/en/download/sample-data/

### 模式 2:GIF(最简单)

放一个 GIF 进来,**文件名必须是 `animation.gif`**:

```
pet/animation.gif     ← 必须是这个文件名
```

网上搜 "GIF 桌面宠物"、"pixel pet gif" 一堆,或用 LottieFiles 导出 GIF。

### 模式 3:PNG 序列帧(画质最好,可控)

按 `frame_001.png`、`frame_002.png` ... 命名,放 `frames/` 下:

```
pet/frames/
├── frame_001.png
├── frame_002.png
├── frame_003.png
└── ...
```

- 最多 256 帧(超出截断)
- 命名必须三位补零
- 遇到第一个不存在的编号就停止
- 帧间隔在 `config.json` 里调 `pet.sequenceFrameMs`,默认 80ms(≈12fps)

**生成工具**:Aseprite 导出 / Photoshop 帧动画 / FFmpeg 切 GIF 都行。

## 优先级示例

如果你同时放了 Live2D 和 GIF,会用 Live2D(优先)。
要强制只用某一种,在 `config.json` 里设:

```json
{
  "pet": {
    "mode": "gif"
  }
}
```

可选项:`"auto"`(默认)、`"live2d"`、`"gif"`、`"sequence"`。

## 没资源?

什么都不放,直接 `npm run dev` —— 会显示一只占位小黄鸡,不影响开发调试。