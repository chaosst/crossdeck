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

- **Core 层零平台 API**，两层强制：ESLint 在编辑器里即时报（`noInlineConfig`
  让 `eslint-disable` 失效），CI 扫描兜底（`pnpm verify:core-purity`）——
  不靠自觉
- **依赖倒置**：所有平台能力经 `CapabilityPort` 接口注入，core 不认平台名，只认能力
- **Web 壳当试金石**：`packages/shell-web` 在浏览器里跑**同一份** core。
  它的 tsconfig `types: []`、Vite 不为 node 内置模块兜底 —— 于是
  「core 里还藏着平台假设吗？」变成一个**编译期就能回答**的问题。
  能编译、能打包、能跑（`pnpm selfcheck:web`，59 条断言 + 截图）⇒ 不是口号
- **类型安全 IPC**：`main` / `preload` / `renderer` 三处共享 `IpcInvokeMap`，
  改错通道名或请求形状会在**编译期**报错（11 个负例证明，见下）
- **跨环境类型隔离**：main 项目的 `lib` 里没有 DOM、renderer 项目的 `types` 是空的、
  Web 壳两者都没有只留 DOM —— 负例 F / G / J / K 就是这三条边界的验收
- **能力探测优于平台判断**：core 用 `capabilities.has('shortcut.global')` 决定 UI，
  而不是 `if (platform === 'electron')`
- **工作区 scope 模型**：Agent 要读用户的真实目录，就必须有边界 ——
  `PathGuard` 做归一化 → 最长 root 匹配 → symlink 逃逸校验，越界一律**具体地**拒绝
  （`SCOPE_DENIED:OUT_OF_SCOPE`，不是笼统的 `FORBIDDEN`）
- **流式背压**：产字与推字解耦，按帧 flush，队列超限**合并中间态**而非丢尾部，
  暂停期间零推送（反向通道走 invoke 才有 ack）
- **调度器注入**：core 里没有 `setInterval` / `Date.now`，只有 `AgentDeps.every/now/newId`。
  收益不是"看起来优雅"，而是背压可以**逐帧确定性验证** —— 83 条断言、全程 0ms 真实等待

---

## 快速开始

```bash
pnpm install

# 一次性：Electron 44 起取消了 postinstall，二进制需要显式拉取（约 240MB）
pnpm setup:electron

pnpm dev          # 开发：内嵌 Vite（HMR）+ Electron，只有一个进程
pnpm start        # 生产：跑 dist/ 里的真实产物
pnpm verify       # 全量校验：类型检查 + core 纯度 + IPC 负例 + scope/agent 单测
pnpm selfcheck    # 无人值守端到端自检，产出截图与 JSON 报告
pnpm selfcheck:web  # Web 壳（试金石）端到端自检：真开一个 Chromium 跑同一份 core
```

### 各命令实际做了什么

| 命令 | 说明 |
|---|---|
| `pnpm dev` | esbuild 打 main/preload → Electron 主进程**内嵌启动 Vite** → 加载 dev server |
| `pnpm start` | 全量构建（含 renderer）→ 通过自称协议 `app://` 加载产物 |
| `pnpm dev:web` | 单独的 Vite dev server（:5199）—— core 在浏览器里跑，不需要 Electron |
| `pnpm verify` | `tsc -b` → core 铁律扫描 → 11 个类型负例 → 72 条 scope 断言 → 83 条 agent 断言 |
| `pnpm selfcheck` | 启动应用 → 真实上下文探针 → 截图 → 写报告 → 归档到 `docs/evidence/` |
| `pnpm selfcheck:web` | Vite 构建 → 起静态服务 → 无头 Chromium 走 CDP → 页面内跑 59 条断言 → 截图归档 |

> **受限环境下跑自检**：若本机 Chromium 沙箱起不来 viz 层（表现为
> `GPU process isn't usable. Goodbye.`，退出码 3），可以显式降级：
> `node packages/shell-electron/scripts/launch.mjs --selfcheck --no-sandbox`。
> 这条只影响自检这一次运行，`dev` / `start` 不受影响（见下方「排查」）。

---

## 验证：凭什么说它是成立的

### 1. 类型安全 IPC 与跨环境边界（`pnpm verify:ipc`，11/11 通过）

只跑正例是不够的 —— 一个把类型写成 `any` 的项目同样能通过正例。
所以要证明**写错会被挡住**：

| # | 注入的错误 | 期望 |
|---|---|---|
| A | renderer 调用未登记进 `IpcInvokeMap` 的通道 | 拦住 |
| B | renderer 给 `agentRun` 少传 `req.input` | 拦住 |
| C | main handler 给 `agentRun` 返回错类型 | 拦住 |
| D | renderer 在 `token` 分支访问不存在的字段 | 拦住 |
| E | 通道名写成拼错的字符串字面量 | 拦住 |
| F | 渲染层 `import 'node:fs'`（它的 lib 里没有 node） | 拦住 |
| G | 主进程使用 `document`（main 项目的 lib 里没有 DOM） | 拦住 |
| H | renderer 调 fs 通道时少传 `workspaceId` | 拦住 |
| I | 把 fs 通道的 `res` 当残缺类型用（`res` 存的是**最终值**，不是 `Promise`） | 拦住 |
| **J** | **Web 壳（试金石）`import 'node:fs'`** | 拦住 |
| **K** | **Web 壳读 `process.env`** | 拦住 |

做法不是跑 `tsc` 子进程，而是用 Compiler API 在进程内检查 ——
所以每个负例都能**落在它所属的 tsconfig 项目里**验证，跨环境的越界引用（F/G/J/K）才抓得住。

J / K 不是 F / G 的重复：它们落在 `shell-web` 这个**第三个环境**里，
而这个环境恰好是「core 无平台假设」这条论断唯一的执行者。它一旦失守，
整条立论就没有证据了。

### 2. Core 铁律：两层执行（`pnpm lint` + `pnpm verify:core-purity` + `pnpm verify:lint`）

扫描 `packages/core/src` 全部 import、检查平台全局引用、核对依赖面只允许
`@crossdeck/contract`。这条铁律是整个项目的立论基础 —— 如果它只写在文档里，
第一个赶进度的人加一行 `import fs from 'node:fs'`，项目就废了，而且不会有东西报警。

但它必须是**两层**，因为两层防的是不同的失败模式：

| 层 | 触发时机 | 防的是 |
|---|---|---|
| `pnpm lint`（ESLint） | 敲下 `import` 的下一秒，编辑器里就红 | 「我根本不知道有这条规矩」 |
| `pnpm verify:core-purity`（扫描） | CI / 提交前 | 「我知道，但我先绕过去」 |

而 `eslint.config.mjs` 里最重要的一行是 `linterOptions.noInlineConfig` ——
它让 `// eslint-disable-next-line` **本身**失效。lint 最常见的死法就是有人
为了赶进度加一行 disable 注释，从此这个文件再没被检查过；CI 那层扫描恰好堵住它。

`pnpm verify:lint` 是这套规则的负例验收（**17/17 拦住 · 5/5 保持沉默**）：
每条规则都有能把它打红的注入用例（静态 / 动态 / re-export 三种入口、
`eslint-disable` 注释、平台全局），外加一组**必须不报**的合法写法 ——
`import './fs/posixPath.js'` 这种形状正是最容易误报的。

> **实测记录**：`no-restricted-imports` 的 pattern 语义和文档不一致，三个写法
> 各跑 14 个用例才定下来 ——
> `paths:[{name:'fs'}]` 会**漏掉** `fs/promises` 和动态 import；
> `fs/*` 这类 pattern 会**误伤相对路径** `./fs/xxx`（ESLint 先剥掉前导 `./` 再匹配）；
> `['*','!./**']` 里的否定**根本不生效**。
> 最后用的是锚定正则的 AST 选择器。一个会误报的规则会被关掉，
> 一个漏报的规则等于没有 —— 两种都不可接受。

### 3. 工作区 scope 边界（`pnpm verify:scope`，72/72 通过）

零依赖、无测试框架：直接加载 core 的**编译产物**（`packages/core/dist/index.js`）
在裸 Node 里跑断言。能这么跑本身就是「core 平台无关 + 零运行时依赖」的一次可执行证明。

断言以负例为主 —— 一个「永远返回 `{ allowed: true }`」的实现能通过全部正例：

| 类别 | 覆盖 |
|---|---|
| 归一化 | `\` 折叠、`.`/`..` 解析、盘符相对形式、上溯越根一律 `null` |
| **前缀陷阱** | `/a/bc` 不得被 `/a/b` 放行（判的是字符串，不是路径段） |
| 归属判定 | 取**最长** root；授权顺序反过来归属不变 |
| 越界 | `..` 逃出 → `OUT_OF_SCOPE`；未授权任何 → `NO_WORKSPACE`（两者 UI 动作不同） |
| **跨工作区** | 限定 A 之后，`/b/x` 必须被拒 —— A 里的 `../` 落进同样已授权的 B |
| **symlink 逃逸** | 注入假 `realpath`：指向外 → `ESCAPE_ATTEMPT` |
| 祖先兜底 | 写新文件（目标不存在）时校验最近存在的祖先；祖先是逃逸链接 → 拒 |
| 大小写 | Windows 不敏感 / Linux 敏感，且 `C:/Workshop` 不被 `C:/Work` 放行 |
| 失败模式 | `realpath` 不可用 → `BAD_PATH`（宁可拒绝，也不把判定权交给文件系统） |

**这套断言本身也被验证过**：故意把 `isWithinPath` 改成朴素 `startsWith`（去掉 `/` 对齐）
会挂 4 条；把 `PathGuard.check` 改成无条件放行会挂 17 条。
一个第一次就全绿、但抓不住错误的测试，等于没测。

### 4. 端到端自检（`pnpm selfcheck`）

产物在 `docs/evidence/`：`selfcheck-prod.json`（全量断言）、`window-prod.png`（真实截图）。

自检覆盖**失败模式完全不同**的多条通路：

| 断言 | 为什么需要 |
|---|---|
| `window.bridge` 已挂载且只有 `invoke` / `onStream` | preload 没生效 / 暴露面超出白名单 |
| `system:info` 返回真实形状 | 正向探针 |
| `session:delete` 删不存在的会话必须抛错 | **反向**探针 —— 只测成功路径会漏掉"永远返回成功"的实现 |
| 错误码解出 `NOT_FOUND`（不是笼统的 `INTERNAL`） | contextBridge 会丢自定义属性，必须验证编码存活 |
| 未注册通道必须失败 | 通道表约束是否真的存在 |
| 流式事件序列 `start → token×N → done` | 单向推送通道（不走 invoke，失败模式不同） |
| **退订后再跑一次，旧订阅不再收到事件** | onStream 泄漏 → 同一条流被渲染多次 |
| 授权目录内能列出夹具文件 | scope 正向探针（走**真实**的 `WorkspaceStore.grant`，不是往表里塞一条） |
| `fs:list-dir` 读 `..` 必须抛 `SCOPE_DENIED:OUT_OF_SCOPE` | 越界拒绝；且要能解出**具体** detail |
| symlink 逃逸必须被拦 | 平台建不出 symlink 时如实记 `skipped` 并进 `warnings`，**不当通过** |
| **暂停期间 token 计数一个都不涨**（等两段等长的时间对比） | 背压失效时 400ms 会多出十几个 token，撞不上 |
| `resume` 之后 token 必须增加 | 暂停不能把流卡死 |
| `agent:control` 对不存在的 runId 必须抛 `NOT_FOUND` | 静默成功会让 UI 状态与真实状态不一致 |
| 渲染层控制台零错误 | 白屏类问题的最直接信号 |

### 5. Agent 内核的确定性单测（`pnpm verify:agent`，83/83 通过）

这个脚本存在的唯一理由：把「跑一遍端到端、等几秒、看 token 数对不对」
换成可以精确到**第 N 帧推了什么**的断言。

时间由 `advance(ms)` 手动推进，两次 produce（12ms）与两次 flush（16ms）
的先后顺序完全确定，所以能测出端到端测不到的东西：

| 断言 | 端到端为什么测不了 |
|---|---|
| 暂停期间**零推送**（不是"少推送"） | 端到端只能对比两段等长的时间窗，撞不上就漏 |
| 队列越限后**保留头尾**（用可辨识内容断言，不是断言长度） | 长度断言抓不住"丢头部"——丢弃后队列会重新增长，长度照样越线 |
| `ttftMs` 恰好等于 16ms | 真实定时器下有抖动，只能写 `> 0` |
| 收尾后调度全部摘掉（定时器泄漏） | 泄漏的定时器不会崩，只会"偶尔多一个 token" |
| 工具失败的语义是 `tool_end.ok=false`，不把 run 打挂 | 同上 |

**这套断言也被验证过**：`isWithinPath` 改成朴素 `startsWith` 挂 4 条、
`PathGuard.check` 无条件放行挂 17 条、
`publish` 不先快照挂 1 条、队列超限只留尾部挂 1 条。

有一条**坏消息**也写在了脚本头部：`AgentRuntime.#settle` 的重复终结保护
在现有调用方下**不可达**（变异存活 0 条），所以不能假装它被测到了。

### 6. Web 壳端到端自检（`pnpm selfcheck:web`，59/59 通过）

这是「core 平台无关」这条论断的**运行时**证据 —— 编译通过只证明静态层面，
证明不了它真能跑。产物在 `docs/evidence/`：`web-selfcheck.json`、`web-shell.png`。

零依赖：静态服务器用 `node:http` 手写，CDP 走 Node 内建的 WebSocket，
浏览器用系统已有的 Edge / Chrome。引 puppeteer 当然更省事，
但那样"证明 core 无平台假设"的脚本自己先拖进来两百兆，说服力会打折。

| 类别 | 断言 |
|---|---|
| 能力**如实降级** | `fs.scope` 在；`window.multi` / `shortcut.global` / `tray` / `update.auto` **明确不在**（假实现比没有实现更糟） |
| 能力探测是运行时读的 | `has('fs.scope') === (typeof navigator.storage.getDirectory === 'function')` |
| scope 仍成立 | 正向可读；`NO_WORKSPACE` 与 `OUT_OF_SCOPE` 必须可区分 |
| **前缀陷阱** | `/ws/demo` 的授权不得顺带覆盖 `/ws/demo-sibling` |
| **跨工作区双向** | A → B 与 B → A 都要被拒（`withinWorkspaceId` 真的生效） |
| 条目路径 | 必须是工作区**相对**路径 —— 证明 fs 端口与授权表共用同一个 store |
| 内核流式 | `start → token×33 → done`，`completionTokens` 与文本长度一致 |
| 背压（真实定时器） | 暂停 400ms 计数 **1 → 1**，恢复后 **1 → 7** 且正常收尾 |
| **注入式调度在浏览器也成立** | 假调度器 + `BackpressurePump`：暂停期间零推送 |
| 工具链路 | `start → tool → tool_end → token* → done` |
| **真实 UI 点击** | 点「授权」→ 文件树有 2 条；点「试读 ../」→ 界面上出现 `SCOPE_DENIED:OUT_OF_SCOPE` |
| core 导出核验 | 页面报上来的绑定名，由运行器 import `core/dist` 逐个核对（压缩会把 `.name` 改成单字母，所以这条只能在 Node 侧做） |

**变异测试**（三组，各自挂的正是对应的那条断言）：

| 变异 | 挂掉的断言 |
|---|---|
| `resolveInWorkspace` 不带 `withinWorkspaceId` | `scope.prefixTrapDenied` + `scope.crossWorkspaceDeniedBothWays` |
| UI 只显示原因、隐去错误码 | `ui.escapeDenialVisible` |
| `AgentRuntime.pause` 变成空操作 | `backpressure.pauseFreezesStream` |

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

### Electron 壳的三进程边界

```
Renderer (sandbox)          Preload (contextBridge)        Main (Node)
┌──────────────┐            ┌────────────────────┐        ┌──────────────────┐
│ React 19 UI  │──invoke──▶ │ 白名单：invoke     │──IPC──▶│ core + Agent 内核│
│ 无 Node 能力 │            │       onStream     │        │ 系统能力实现     │
└──────────────┘◀─stream────└────────────────────┘        └──────────────────┘
      ▲                                                          │
      └────────── app:// 协议 + 严格 CSP（响应头下发）────────────┘
```

---

## 目录结构

```
packages/
  contract/              # 共享契约：类型 + 常量 + 极少量纯函数，零运行时依赖
    src/
      capability.ts      #   Platform / Capability / WindowKind
      ipc.ts             #   通道名单（唯一事实源）
      invoke-map.ts      #   请求/响应类型映射 ← 类型安全 IPC 的核心
      stream.ts          #   流式事件（discriminated union）+ Usage（含背压健康度）
      error.ts           #   错误信封 + 跨 contextBridge 的错误码编码（`[CODE:DETAIL]`）
      types.ts           #   InvokeHandler / InvokeArgs / BridgeApi
      workspace.ts       #   工作区授权模型 + PathGuard 契约 + 拒绝原因文案
      entities.ts        #   SessionMeta / DirEntry / FileStat
  core/                  # 平台无关内核（铁律：不得 import 任何平台 API）
    src/
      ports.ts           #   CapabilityPort 接口定义（含 FsPort）
      session/store.ts   #   SessionStore（时钟与 id 均注入）
      fs/posixPath.ts    #   POSIX 风格纯字符串路径运算（不用 node:path）
      fs/workspaceStore.ts # 授权表 + 归属判定（最长 root 匹配）
      fs/pathGuard.ts    #   scope 校验：归一化 → 归属 → symlink 逃逸
      fs/resolveInWorkspace.ts # { workspaceId, rel } → 已授权绝对路径（两端共用）
      events/streamBus.ts #  事件分发 + 退订（刻意不用 EventEmitter）
      agent/deps.ts      #   注入面：now / every / newId（core 里没有 setInterval）
      agent/backpressure.ts # 下行背压泵：产字↔推字解耦、帧对齐、合并中间态
      agent/tools.ts     #   工具注册表（工具失败是业务结果，不是崩溃）
      agent/model.ts     #   ModelPort + ScriptedModel（未接真 LLM 时的确定性替身）
      agent/runtime.ts   #   run 生命周期：恰好一个终态事件
  shell-web/             #   ★ 试金石：同一份 core 跑在浏览器里
    src/ports.ts         #     OPFS 实现（无 symlink → 逃逸检测退化为纯字符串）
    src/selfcheck.ts     #     59 条断言（能力降级 / scope / 内核 / 真实 UI 点击）
    src/main.ts          #     极简 DOM 壳，刻意不引框架
    tsconfig.json        #     lib=DOM+AsyncIterable，types=[] —— 铁律的机制本身
    scripts/web-selfcheck.mjs # 静态服务 + CDP 驱动无头 Chromium（零依赖）
  shell-electron/
    src/main/            #   主进程：core 宿主 + 系统能力实现
      index.ts           #     启动顺序 + 模式选择
      appProtocol.ts     #     app:// 协议、CSP、权限收口
      windows.ts         #     BrowserWindow 安全基线（集中一处）
      ipc.ts             #     ipcMain.handle 类型安全包装 + 错误信封
      handlers.ts        #     全部 handler（只做"翻译"，不做业务）
      fs.ts              #     FsPort 的 Electron 实现（**校验先于 IO**）
      agentRuntime.ts    #     适配器：core 内核 → Electron（真正属于壳的只剩三行）
      devServer.ts       #     内嵌 Vite（仅 --dev 动态导入）
      selfcheck.ts       #     端到端自检（夹具 + 探针 + 截图 + 报告）
    src/preload/bridge.ts#   最小暴露面（必须是 CJS）
    src/renderer/        #   React 19 渲染层（含工作区文件树）
    scripts/launch.mjs   #   启动器：清 ELECTRON_RUN_AS_NODE + 自检收尾（强杀进程树）
    tsconfig.main.json   #   lib=ES2022 + types=[node]（没有 DOM）
    tsconfig.renderer.json #  lib=ES2022+DOM + types=[]（没有 node）
scripts/
  verify-type-alignment.mjs  # 11 个类型负例（三个 tsconfig 项目各覆盖到）
  verify-lint-boundaries.mjs # 17 个 lint 负例 + 5 个必须沉默的正例
  verify-core-purity.mjs     # core 铁律扫描（CI 层）
  verify-core-scope.mjs      # PathGuard / WorkspaceStore 的 72 条断言（加载 core 编译产物）
  verify-core-agent.mjs      # 事件总线 / 背压 / 工具链路的 83 条断言（假调度器，0ms 真实等待）
  archive-selfcheck.mjs      # Electron 自检证据归档
docs/evidence/               # 自检报告与截图（可核验产物）
```

---

## 几个值得展开的决策

### 为什么不用 `file://`，而自己注册 `app://` 协议

两个都是硬理由，不是偏好：

1. `file://` 下 ES module 会被 CORS 拦掉（origin 为 `null`），而 Vite 的入口就是
   `<script type="module">` —— 这是"能不能跑"的问题。
2. `file://` 无法下发自定义响应头，装不了 CSP。而 CSP 是 Electron 安全基线里
   唯一能约束渲染进程能力的东西。

顺带解决了路径穿越：请求 resolve 后必须仍在 renderer 目录内，否则 403。

### 为什么 preload 必须打成 CJS

`sandbox: true` 下 Electron **不支持 ESM preload**，而本包 `package.json` 是
`"type": "module"`，`tsc` 只会产出 ESM，且无法让产物改扩展名。
用 esbuild 打成单个 `.cjs` 是唯一干净的解法。

### 为什么把 Vite dev server 嵌进主进程

常见做法是起两个进程（vite + electron）再用 concurrently 编排。代价是：多一个编排层、
两个进程生命周期互不知情（vite 挂了 electron 只会白屏）、退出清理靠人肉约定。

内嵌之后 `pnpm dev` 就是一条 `electron . --dev`：无编排层、无孤儿进程、
dev server 生命周期与主进程绑定。代价是 vite 成为主进程的 dev 依赖（动态 import，不进生产包）。

### 为什么错误要包一层信封，而不是直接抛

`ipcMain.handle` 抛错时 Electron 会把 Error 拍平成字符串，**自定义属性全部丢失** ——
renderer 只能拿到一句没法编程处理的文本，无法区分"参数错了"和"上游限流"。

于是 main 统一返回 `{ ok, value } | { ok, error }`，preload 解包还原成抛错。

但**实测**发现还有第二段损耗：错误穿过 `contextBridge` 后，自定义属性同样被丢弃
（`name` 变回 `Error`、`code` 变 `undefined`、own keys 为空），**只有 `message` 活下来**。
所以错误码最终编码进 message 前缀（`[NOT_FOUND] 会话不存在：…`），
由 `parseIpcError` 解出。这个坑和修法都固化在自检断言里了。

### 为什么 main 和 renderer 用两个 tsconfig

一个 `lib: ["ES2022","DOM"]` 的单一配置能让渲染层写出 `document`、也能让主进程
`import 'node:fs'` —— 边界只存在于文档里。拆开之后：

- `tsconfig.main.json`：`lib: ["ES2022"]` + `types: ["node"]` → 用不了 `document`
- `tsconfig.renderer.json`：`lib: ["ES2022","DOM"]` + `types: []` → 用不了 `node:*`
- `shell-web/tsconfig.json`：`lib: [DOM, DOM.AsyncIterable]` + `types: []` → 两者都没有

这和"渲染进程 `nodeIntegration: false`"是同一条边界的三种表述，
负例 F / G / J / K 就是它的验收。

顺带记一个"错误信息指向错误方向"的坑：OPFS 的
`FileSystemDirectoryHandle.entries()` 定义在 `DOM.AsyncIterable` 里，
不在 `DOM.Iterable`。缺了它只报 `Property 'entries' does not exist` ——
看起来像 API 不存在，其实是 lib 选错了。

### 为什么 PathGuard 自己写路径运算，而不用 `node:path`

两条硬理由：

1. core 的铁律不允许 —— Web 壳里根本没有 `node:path`。
2. **`node:path` 的行为跟着宿主平台变**（win32 / posix 两套实现），而 core 需要的是
   「同一份输入在任何壳里得到同一个结论」。

所以 `core/src/fs/posixPath.ts` 只认 `/` 分隔的 POSIX 形态，`\` 的归一化也在这一层做完。
各壳在边界处（`FsPort` 实现里）把结果翻译回本机形式。**只有一种形态，才不会有
"两套正则分别在两处漂移"**。

顺带说三个具体的坑，它们都是"看着对"的实现：

- **前缀必须按 `/` 对齐**。`child.startsWith(parent)` 会让 `/a/bc` 被 `/a/b` 的授权放行 ——
  这是路径校验里最经典的一个洞，因为它匹配的是**字符串**而不是**路径段**。
- **绝对路径上溯越根必须判非法**，不能退化成 `/`。`/a/../..` 归一成 `/` 看着"合规"，
  实际是把一次越界伪装成了根目录访问。
- **盘符相对形式（`C:foo`）必须拒绝**。它的语义是「C 盘当前目录下的 foo」，
  纯字符串层面无法确定，放行等于给逃逸开一个后门。

### 为什么 `resolved` 不回写 realpath

校验放行时返回的是**归一化后的逻辑路径**，不是 `realpath`。看着多绕一步，实际是必须的：
`lstat` 要靠逻辑路径才能把符号链接如实报成 `kind: 'symlink'`
（换成 realpath 之后就永远看不到链接本身了）。逃逸判定单独用 realpath 做一次，
IO 用逻辑路径是安全的。

这条在截图里是可见的：文件树里 `link-out` 的 kind 显示为 `SYMLINK` 而不是 `FILE`。

### 为什么背压是「合并中间态」而不是「丢尾部」

上游产字快过下游消费时，队列会涨。两种处理方式：

- **丢尾部**：UI 的内容会缺一块，而用户**看不出来少了什么** —— 只觉得"答案不对"。
- **合并中间态**（保留头尾）：中间的字跳过去了，但语义与长度感都还在。

选后者。同时把合并次数放进 `Usage.mergedChunks` —— 于是"有点卡"从一个模糊的抱怨
变成了一个可观测的数字。

### 为什么越界要报 `SCOPE_DENIED` 而不是复用 `FORBIDDEN`

UI 需要区分两件事，而它们该引导用户做的动作完全不同：

- 「还没授权任何目录」→ 应该引导去点「授权目录…」
- 「越界了」→ 应该报错

压成一个码之后，前端只能去解析 message 文本 —— 那正是本项目要消灭的东西。
所以错误码之外还带一层 `detail`（`NO_WORKSPACE` / `BAD_PATH` / `OUT_OF_SCOPE` /
`ESCAPE_ATTEMPT`），并且**每一端说同一句话**（文案放在契约层，
不然同一件事在不同端有不同说法，排查时对不上号）。

### 为什么自检夹具必须走和用户点击完全相同的授权路径

无头环境弹不出系统授权对话框，所以夹具由 main 侧预先造好。但授权那一步**没有抄近路**：
走的就是 `workspaces.grant({ root })`，和用户点「授权目录…」是同一条代码路径。

理由：直接往授权表里塞一条会让自检去验证一条**用户永远走不到的分支** ——
测试通过，真实路径照样坏。

### 为什么用 Web 壳当试金石（而不是"顺手也做一个 Web 版"）

「core 平台无关」这句话，如果只写在文档里，它和没写是一样的 ——
没人能证伪，也就没人会去维护。所以需要一个**机器可验**的判据：

- `shell-web/tsconfig.json` 把 `types` 置空 → 这个项目拿不到任何 node 全局类型
- 它用 Vite 做浏览器构建 → `node:*` 根本没有解析目标

于是「core 里还藏着平台假设吗」变成一个编译期就能回答的问题：
core 只要有一处依赖 node，这个壳就**编译不过**。

但编译通过仍然只是静态证据。所以它还必须**真的跑起来**：
`pnpm selfcheck:web` 会起一个静态服务、开一个无头 Chromium、在页面里跑 59 条断言。
两件事都成立，这句话才算被验证过 —— 而不是被宣布过。

顺带一个副产品：Web 壳要复用「把 `{workspaceId, rel}` 解析成已授权绝对路径」这段逻辑时，
摆在面前的是"抄一份"或"下沉到 core"。**抄一份的代价不是多写 15 行，而是两端的授权语义
从此可能走散** —— 某天有人在 Electron 那份里加了「只读工作区不许写」，Web 那份不会跟着变，
而这是安全代码。所以它成了 `core/src/fs/resolveInWorkspace.ts`。

### 为什么把调度器注入 core，而不是直接用 `setInterval`

core 的 `lib` 只有 ES2022 —— 它**写不出** `setInterval`，这不是自律，是编译不过。
所以时间与调度必须由壳注入：`AgentDeps.every / now / newId`。

收益不是"看起来优雅"，而是**可确定性测试**：测试注入一个手动推进的 `every()`，
就能在没有一个真实定时器的情况下，把背压算法逐帧验完 ——
见 `scripts/verify-core-agent.mjs`，83 条断言、全程 0ms 真实等待。

反过来说：如果哪天有人为了"方便"在 core 里直接写 `setInterval`，
背压就会退化回"只能靠端到端碰运气验"。

这条设计还有个自我验证：`shell-web` 的自检里**又建了一个假调度器**
（`src/selfcheck.ts` 的 `fakeScheduler`）。目的就是证明这套做法本身与平台无关 ——
如果"可确定性测试"依赖 Node 的某种特性，它就不是平台无关的。

### 为什么 `agent:abort` 抛错，而 `agent:control` 会抛 `NOT_FOUND`

两者看着像同一类操作，语义却相反：

- `agent:control`（pause / resume）—— **静默成功会撒谎**。run 早就结束了，
  却回一句"成功"，UI 就停在"已暂停"上，与真实状态不一致。所以必须失败。
- `agent:abort` —— run 已经不跑了，**目标已经达成**就是成功。
  抛错反而会在"点停止时刚好跑完"这个常见竞态上弹出莫名的错误。

---

## 平台能力对照

这张表不是设想，是 `shell-web` 的实际输出（`docs/evidence/web-selfcheck.json` 的
`detectedCapabilities`）：Web 壳在**运行时探测**能力，探测不到就如实报「没有」。

| 能力 | Web 壳 | Electron 壳 | HarmonyOS 壳 |
|---|---|---|---|
| `fs.scope` 文件读写 | ✅ OPFS / File System Access API | ✅ `node:fs` + scope 授权 | `@ohos.file.fs` |
| `notify.system` 系统通知 | ⚠️ 有，但先要用户授权 | `new Notification()` | `notificationManager` |
| `window.multi` 多窗口 | ❌ 只有页面内面板 | ✅ `BrowserWindow` 多实例 | 自由窗口 / 子窗口 |
| `shortcut.global` 全局快捷键 | ❌ 网页不允许注册 | ✅ `globalShortcut` | 系统级按键 |
| `update.auto` 自动更新 | ❌ 刷新即最新 | `electron-updater` | 应用市场 |
| `tray` 托盘 | ❌ 不存在 | `Tray` | — |

三条硬事实：

1. **不装假实现。** 一个把能力表填满的 Web 壳看起来更"完整"，但 UI 会据此渲染出
   永远点不动的按钮 —— 假实现比没有实现更糟。
2. **能力探测先于调用**，不是先调用再兜底。UI 少渲染一块，是设计结果而不是降级事故。
3. **差异文档化，不做"假装统一的抽象"。** `window.multi` 在 Web 壳里返回面板 id 而不是抛错，
   但 `has('window.multi')` 是 `false` —— 调用方本来就该先探测再决定要不要显示"新建窗口"。

这张表本身就是一个结论：**一套 core 不是所有端都能 100% 复用**。
边界在哪里、怎么降级，才是架构判断力的体现。

---

## 里程碑状态

- [x] **M0** — pnpm workspace 骨架 + `packages/contract` 全量类型 + 类型对齐负例
- [x] **M2** — Electron 主进程骨架 + 全通道实现 + `app://` 协议 + 安全基线
- [x] **M3** — React 19 渲染层 + 流式通道端到端打通
- [x] **M4** — 本地文件系统 + 工作区授权 scope（WorkspaceStore / PathGuard / symlink 逃逸）
      + 流式下行背压（按帧 flush + 合并中间态 + 暂停零推送）
- [x] **M4.5(a)** — core `agent/` + `events/` 内核：`AgentRuntime` / `BackpressurePump` /
      `StreamBus` / `ToolRegistry`；调度器注入；壳侧只剩三行适配
- [x] **M4.5(b)** — `shell-web` 试金石：同一份 core 在浏览器里编译、打包、运行，
      59 条断言 + 截图归档
- [x] **M4.5(c)** — ESLint `no-restricted-syntax` 把铁律提到编辑器即时反馈
      （`noInlineConfig` 让 disable 注释失效；17 个负例 + 5 个必须沉默的正例）
- [ ] **M1** — 从 navigate 抽取更多 core 模块（真实 LLM 适配层）
- [ ] **M5** — 自动更新 + 三平台打包 + 性能量化（冷启动 / 内存基线）
- [ ] **M6** — HarmonyOS 壳（ArkTS + 2in1 鸿蒙 PC 形态）

---

## 排查

| 现象 | 原因 |
|---|---|
| 窗口闪一下就退出 / `app` 为 undefined | 环境里有 `ELECTRON_RUN_AS_NODE=1`，Electron 退化成了普通 Node。`pnpm dev` 走 `scripts/launch.mjs`，它会主动清掉这个变量 |
| `Electron failed to install correctly` | 二进制没拉下来，跑 `pnpm setup:electron` |
| 无头 / CI 下 `GPU process isn't usable`（退出码 3） | 受限会话里 Chromium 沙箱起不来 viz 层。自检已关 GPU；若仍崩，加 `--no-sandbox`（见下方说明） |
| `pnpm selfcheck` 出完报告却不返回 | 同一原因：主进程卡在残留的 GPU/viz 子进程上，`app.exit()` 结束不掉。**这不该由应用自己救**（事件循环已停摆，兜底 `setTimeout` 不会触发）。所以 `launch.mjs` 监听应用的 `[selfcheck] DONE ok=… code=…` 哨兵，据此强杀进程树并以**判定结果**而不是"能不能退出"作为退出码 |
| 白屏、控制台报 CSP 拦截 | 生产 CSP 的 `script-src` 只有 `'self'`。注意 Vite 的 modulepreload polyfill 会注入行内脚本，已在 `vite.config.ts` 关掉 |
| `selfcheck:web` 报「找不到 Chromium 内核浏览器」 | 它只用系统已有的 Edge / Chrome。装在别处时用 `CROSSDECK_BROWSER=<路径>` 指定 |
| `selfcheck:web` 的 OPFS 断言失败 | OPFS 需要**安全上下文**：只认 `https://` 或 `127.0.0.1` / `localhost`。脚本起的就是 `127.0.0.1` —— 换成局域网 IP 会失效 |

---

## 技术栈

TypeScript（strict，含 `exactOptionalPropertyTypes`）· pnpm workspace · Electron 44 ·
React 19 · Vite 8 · Tailwind 4 · esbuild · Node 20+
