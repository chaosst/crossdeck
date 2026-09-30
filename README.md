# crossdeck

> 一个平台无关的 Agent 内核 · 多个平台壳。
> One platform-agnostic core, multiple shells.

`crossdeck` 是一个跨端 Agent 桌面客户端的架构示范：把 Agent 运行时抽成**零平台依赖**的
TypeScript 包，再用 Electron / Web / HarmonyOS 三个壳各自注入平台能力。

它要回答的是一个工程问题，而不是一个产品问题：

> **同一个内核，怎么在浏览器、桌面端、鸿蒙端上跑，且边界清晰、降级可控、类型安全？**

---

## 为什么值得看

大多数"跨端"项目的跨端只停留在 UI 层（一套 CSS 适配多个屏幕）。
`crossdeck` 跨的是**能力层**：

- **Core 层零平台 API**，由 ESLint 规则强制（禁止 import `electron` / `node:*` / `@ohos.*`）
- **依赖倒置**：所有平台能力经 `CapabilityPort` 接口注入，core 不认平台名，只认能力
- **类型安全 IPC**：`main` / `preload` / `renderer` 三处共享 `IpcInvokeMap`，
  改错通道名或请求形状会在**编译期**报错（有负例测试证明，见下）
- **能力探测优于平台判断**：core 用 `capabilities.has('shortcut.global')` 决定 UI，
  而不是 `if (platform === 'electron')`

---

## 架构

```
┌──────────────────────────────────────────────────────────┐
│  Shell 层 · 平台相关 · 每端一份                           │
│  ┌───────────┐  ┌───────────────┐  ┌──────────────────┐  │
│  │  Web 壳   │  │ Electron 壳   │  │ HarmonyOS 壳     │  │
│  │  降级实现 │  │  完整实现     │  │ ArkTS 实现       │  │
│  └─────┬─────┘  └───────┬───────┘  └────────┬─────────┘  │
└────────┼────────────────┼───────────────────┼────────────┘
         │                │                   │
         └────────────────┼───────────────────┘
                          ▼
              ┌───────────────────────┐
              │  CapabilityPort       │  ← 平台能力端口（依赖倒置）
              └───────────┬───────────┘
                          ▼
┌──────────────────────────────────────────────────────────┐
│  Core 层 · 平台无关 · 纯 TypeScript                       │
│  Agent 内核 · 会话管理 · 工具编排 · 事件总线              │
└──────────────────────────────────────────────────────────┘
```

### 铁律

> **Core 层不得 import 任何平台 API。**

这条铁律是「一套 core 多端壳」从口号变成**可验证事实**的唯一保证。

---

## 目录结构

```
packages/
  contract/          # 共享类型契约（零运行时依赖，三处共用）
    src/
      capability.ts  #   Platform / Capability / WindowKind
      ipc.ts         #   通道名单（唯一事实源）
      invoke-map.ts  #   请求/响应类型映射 ← 类型安全 IPC 的核心
      stream.ts      #   流式事件（discriminated union）
      types.ts       #   InvokeHandler / InvokeArgs / BridgeApi
      workspace.ts   #   工作区授权模型
  core/              # 平台无关 Agent 内核
    src/ports.ts     #   CapabilityPort 接口定义
  shell-electron/    # Electron 壳
    src/main/        #   主进程：core 宿主 + 系统能力实现
    src/preload/     #   最小 API 桥（contextBridge 白名单）
    src/renderer/    #   React 19 UI
scripts/
  verify-type-alignment.mjs   # 类型安全 IPC 的负例验收
```

---

## 快速开始

```bash
pnpm install
pnpm typecheck      # 全量类型检查（tsc -b，project references）
pnpm verify:ipc     # 类型安全 IPC 负例验收
```

`pnpm verify:ipc` 会依次往源码里注入 5 种**故意写错**的写法，断言每一种都被编译期拦住，
然后还原文件。只有 5/5 全部被拦住才算通过：

| # | 注入的错误 | 期望 |
|---|---|---|
| A | renderer 调用未登记进 `IpcInvokeMap` 的通道 | 拦住 |
| B | renderer 给 `agentRun` 少传 `req.input` | 拦住 |
| C | main handler 给 `agentRun` 返回错类型 | 拦住 |
| D | renderer 在 `token` 分支访问不存在的字段 | 拦住 |
| E | 通道名写成拼错的字符串字面量 | 拦住 |

> 为什么不只跑正例：一个把类型写成 `any` 的项目同样能通过正例。
> 必须证明「写错会被挡住」，类型约束才算真的存在。

---

## 平台能力对照

| 能力 | Web 壳 | Electron 壳 | HarmonyOS 壳 |
|---|---|---|---|
| 文件读写 | OPFS / File System Access API | `node:fs` + scope 授权 | `@ohos.file.fs` |
| 目录选择 | `<input webkitdirectory>` | `dialog.showOpenDialog` | `picker` |
| 多窗口 | `window.open` | `BrowserWindow` 多实例 | 自由窗口 / 子窗口 |
| 系统通知 | Notification API | `new Notification()` | `notificationManager` |
| 剪贴板 | Clipboard API | `clipboard` | `pasteboard` |
| 全局快捷键 | ❌ 降级为页面内快捷键 | `globalShortcut` | 系统级按键 |
| 自动更新 | ❌ 不适用 | `electron-updater` | 应用市场 |

这张表本身就是一个结论：**一套 core 不是所有端都能 100% 复用**。
边界在哪里、怎么降级，才是架构判断力的体现。

---

## 里程碑状态

- [x] **M0** — pnpm workspace 骨架 + `packages/contract` 全量类型 + 类型对齐负例验收
- [ ] **M1** — 从 navigate 抽取 core（session / agent / events）+ ESLint 铁律规则
- [ ] **M2** — Electron 主进程骨架 + 系统能力实现
- [ ] **M3** — React 19 渲染层 + 流式交互（批量 flush + 背压）
- [ ] **M4** — 本地文件系统 + 工作区授权 scope
- [ ] **M5** — 自动更新 + 三平台打包 + 性能量化
- [ ] **M6** — HarmonyOS 壳（ArkTS + 2in1 鸿蒙 PC 形态）

---

## 技术栈

TypeScript（strict）· pnpm workspace · Electron · React 19 · Vite ·
Vitest · ArkTS / ArkUI（HarmonyOS）
