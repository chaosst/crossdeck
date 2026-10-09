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
  能编译、能打包、能跑（`pnpm selfcheck:web`，61 条断言 + 截图）⇒ 不是口号
- **类型安全 IPC**：`main` / `preload` / `renderer` 三处共享 `IpcInvokeMap`，
  改错通道名或请求形状会在**编译期**报错（13 个负例证明，见下）
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
- **第二个真壳，不是"顺手也做一个"**：`shell-ohos` 是 ArkTS（DevEco）工程，
  与 Electron **非同族**，跑的是**同一份** contract/core 源码
  （构建期同步，不维护第二份副本），UI 换成 ArkUI、能力端口换成 `@ohos.*`。
  Electron 壳证明得了架构，但证明不了**可移植** ——
  除非真有一个非同族的壳编译过、装上、跑起来、并且有截图

---

## 快速开始

```bash
pnpm install

# 一次性：Electron 44 起取消了 postinstall，二进制需要显式拉取（约 240MB）
pnpm setup:electron

pnpm dev          # 开发：内嵌 Vite（HMR）+ Electron，只有一个进程
pnpm start        # 生产：跑 dist/ 里的真实产物
pnpm verify       # 全量校验：类型检查 + core 纯度 + IPC 负例 + scope/agent/update 单测
pnpm selfcheck    # 无人值守端到端自检，产出截图与 JSON 报告
pnpm selfcheck:web  # Web 壳（试金石）端到端自检：真开一个 Chromium 跑同一份 core
pnpm pack:win     # 打 Windows NSIS 安装包（约 98MB，见「已知限制」）
pnpm verify:update-feed  # 用本地真实 feed 在打包产物上跑通更新链路（须先 pack:win）
pnpm verify:ohos  # 鸿蒙壳端到端：编译 → 安装 → 启动 → 点击 → 截图（需 DevEco + 模拟器在线）
```

### 各命令实际做了什么

| 命令 | 说明 |
|---|---|
| `pnpm dev` | esbuild 打 main/preload → Electron 主进程**内嵌启动 Vite** → 加载 dev server |
| `pnpm start` | 全量构建（含 renderer）→ 通过自称协议 `app://` 加载产物 |
| `pnpm dev:web` | 单独的 Vite dev server（:5199）—— core 在浏览器里跑，不需要 Electron |
| `pnpm verify` | `tsc -b` → core 铁律扫描 → 13 个类型负例 → 72 条 scope / 83 条 agent / 72 条 update 断言 |
| `pnpm selfcheck` | 启动应用 → 真实上下文探针 → 截图 → 写报告 → 归档到 `docs/evidence/` |
| `pnpm selfcheck:web` | Vite 构建 → 起静态服务 → 无头 Chromium 走 CDP → 页面内跑 61 条断言 → 截图归档 |
| `pnpm pack:win` | electron-builder → NSIS 安装包 + `latest.yml`；**不含 node_modules**，`app.asar` 0.93MB |
| `pnpm verify:update-feed` | 起本地静态 feed → 打包产物以 `CROSSDECK_UPDATE_URL` 指过去 → 跑完检查/下载/就绪 → 按哨兵判定 |
| `pnpm sync:ohos` | 把 `contract` / `core` 源码同步进鸿蒙工程并改写裸包名（`verify:ohos` 会自动带这一步） |
| `pnpm verify:ohos` | `hvigorw assembleHap` → `hdc install` → `aa start` → 按 UI 树真实坐标点击 → 截图归档（环境不具备时**如实报 skipped 并非零退出**） |

> **受限环境下跑自检**：若本机 Chromium 沙箱起不来 viz 层（表现为
> `GPU process isn't usable. Goodbye.`，退出码 3），可以显式降级：
> `node packages/shell-electron/scripts/launch.mjs --selfcheck --no-sandbox`。
> 这条只影响自检这一次运行，`dev` / `start` 不受影响（见下方「排查」）。

---

## 验证：凭什么说它是成立的

### 1. 类型安全 IPC 与跨环境边界（`pnpm verify:ipc`，16/16 拦住）

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
| L | 把 invoke 通道传给 `on()`（调用与推送两张表必须互斥，否则一条通道会有两种用法） | 拦住 |
| M | `UpdateStatus` 判别联合：`available` 阶段访问 `percent` —— 这是「永远转圈」的类型级拦截 | 拦住 |
| N | `GuestLoginResult` **没有** `token` 字段 —— 渲染层"顺手读一下"就编译不过 | 拦住 |
| O | `NavigateLoginStatus` 同样没有 `token`（与 N 是**两条不同的路**，不是重复） | 拦住 |
| P | `setNavigateUpstream` 只收 `string \| null`，收不了"顺便把 token 传上来"的扩展形状 | 拦住 |

N / O / P 是接真实上游时才补的：新增通道最容易在**凭据**这一处被悄悄撑开一个口子，
而"凭据只活主进程"这条约束的证据不该是文档，应该是**编译不过**。

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

### 5. Agent 内核的确定性单测（`pnpm verify:agent`，103/103 通过）

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

### 6. Web 壳端到端自检（`pnpm selfcheck:web`，101 项断言）

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
| **真实上游链路** | 同源假 SSE 上游：匿名必须 401 → guest 登录 → 五场景（正常 / 干净 EOF / socket 销毁 / 上游 error / 中途 abort）；断言逐帧到达、正文逐字一致、`completionTokens` 与文本长度相等、诊断里凭据形态确实是 cookie；**对端**看见 `abort` 断连 |
| **反向（词表）** | 不认识的场景必须 400 —— 证明前面那些是**被词表认出来**的，而不是"假上游对什么 prompt 都吐同一套" |

假上游与**鸿蒙壳的验证脚本共用同一份实现**（`scripts/fake-navigate-upstream.mjs`）：
两个宿主脚本各抄一套的话，场景词表会长出两个版本 —— 一端改了 prompt、另一端还认旧的，
症状是"这个场景不存在（400）"，看起来像客户端的问题。

**变异测试**（四组，各自挂的正是对应的那条断言）：

| 变异 | 挂掉的断言 |
|---|---|
| `resolveInWorkspace` 不带 `withinWorkspaceId` | `scope.prefixTrapDenied` + `scope.crossWorkspaceDeniedBothWays` |
| UI 只显示原因、隐去错误码 | `ui.escapeDenialVisible` |
| `AgentRuntime.pause` 变成空操作 | `backpressure.pauseFreezesStream` |
| 真实上游那 7 发（abort 不断连 / 干净 EOF 当正常收尾 / 终态多投递一次 / 两条断流合成一条 / 去掉 cookie 闸门 / 凭据形态报错 / 不上报 `navRan`） | 见 §10 —— 7 发 7 杀，存活 0 条 |

### 7. 自动更新链路（`pnpm verify:update-feed`，须先 `pnpm pack:win`）

自动更新是**两半**，只验一半等于没验：

| | 跑在哪 | 验证的是 |
|---|---|---|
| `pnpm selfcheck` | 未打包形态 | **不具备条件时会不会如实说** —— 界面停在 `error`（`retryable=false`）而不是转圈到天荒地老，拒绝码 `UNSUPPORTED:NOT_PACKAGED`，退订后事件数不再增长 |
| `pnpm verify:update-feed` | **打包产物** | **真的有新版本时能不能检出、能不能下载** |

后者的做法：本地起一个静态 feed（`latest.yml` + 8MB 假安装包，支持 Range），
用 `CROSSDECK_UPDATE_URL` 把产物指过去，跑完再按哨兵判定 —— 校验链挂在
「断言过没过」，不挂在「进程能不能退出」（受限会话里 Electron 退不干净，
这条经验在自检里已经吃过一次）。

打包产物的实测轨迹（**渲染层收到的全量推送**，`packaged=true`）：

```
checking → available(9.9.9) → downloading(0%) → downloading(100%) → ready(9.9.9)
```

服务端确实收到了 `GET /latest.yml`、blockmap、安装包 —— 真走了一趟 HTTP，
不是把 feed 层换成假对象自欺。

两个设计点值得说：

1. **状态收集放在渲染层订阅推送通道，不在主进程轮询。**
   第一版用 50ms 轮询，本机回环上整个 check 只花几毫秒，`checking` 与 `available`
   两帧**完整落在同一个采样间隔里**，于是断言报"没出现 checking" ——
   而主进程日志里那两行写得清清楚楚。**采样永远会漏，拿它断言事件序列必然出假阴性**，
   而假阴性比没有断言更糟：它把一条好链路报成坏的。改成正路后顺带证明了
   另一件事 —— 推送真的走到了渲染层（主进程状态对不对，和界面收没收到，是两回事）。
2. **断言"三处一致"**：主进程状态机 / 渲染层收到的最后一帧 / DOM 上的 `data-stage`。
   只对其中两处，「状态对了但界面没刷新」这种故障就没人看得见。

为什么"永远转圈"能被结构性挡住：`UpdateStatus` 写成**判别联合**
（`idle | checking | available | downloading | ready | error`）而不是
`{stage; info?; percent?; message?}` 那种松形状 —— 松形状下
「只有 stage、什么都不填」在类型上完全合法，而它渲染出来的正是那个转圈的按钮。

### 8. 性能量化（`pnpm selfcheck` 的 `perf` 节 → `docs/perf.md`）

性能报告最容易变成装饰品，所以每一项都追得到一个具体的采集点。
完整口径（含采集方式、两项贴近上限的改进项、以及**已知的测不准之处**）见
`docs/perf.md`；这里只放表：

| 指标 | 目标 | 实测（4 次采样） | 判定 |
|---|---|---|---|
| 冷启动到首帧可交互 | < 1200 ms | **316 – 935 ms** | ✅ 最坏值余量 22% |
| 主进程常驻内存 | < 150 MB | **138.3 – 144.4 MB** | ⚠️ 最坏值余量仅 3.7% |
| 渲染进程内存 | < 250 MB | **39.6 – 40.9 MB** | ✅ 余量 84% |
| 本地首帧延迟（不含上游） | < 300 ms | **27 – 28 ms** | ✅ 余量 91% |
| 流式帧率 | ≥ 55 fps | **179 – 180 fps** | ✅ 见下 |
| Win 安装包体积 | < 100 MB | **98.1 MB** | ⚠️ 余量仅 1.9% |

同机、同产物、同命令跑 4 次，表里给的是**范围**；判定一律取**最坏值**。
（接真实上游改造后又抽样复测了 4 趟，`ttft` 落在 27 – 29 ms，与归档值同一区间；详见下面第 4 点。）

四处容易糊弄过去、这里偏要说清的：

1. **冷启动的起点是 main 模块顶层，不是 `app.whenReady()`。** 后者少算了整个
   Electron 引导阶段 —— 而那正是用户真正在等的时间。终点是渲染层**连续两帧**
   `requestAnimationFrame` 之后（`useEffect` 只说明 DOM 建好了，第一帧还没上屏）。
   两侧都用挂钟时间：两个进程的 `performance.now()` 各有自己的原点是加不起来的。
   **这一项的方差有 2.9 倍**（316 ~ 935 ms，代码和命令都没变），最可能来自 OS 页缓存
   是否命中 —— Electron 运行时主体 234.6 MB 在不在缓存里，差的正是几百毫秒。
   所以这里取最坏值判定并把区间写出来：复现的人跑出 320ms 不该以为自己测错了。
   完整分析与改进项见 `docs/perf.md` §2.1 / §3.3。
2. **渲染进程内存踩过一次坑。** Electron 44 **移除**了
   `webContents.getProcessMemoryInfo()`；现在只能 `app.getAppMetrics()` 再按
   `getOSProcessId()` 匹配该窗口 —— 不能按 `type === 'Tab'` 挑（多窗口下会有好几个）。
   而且那个结构体的 `memory` 字段单位是 **KB**：不乘 1024 会得到"渲染进程占 39.6 KB"
   这种荒谬但看着正常的数字，它不报错，只是悄悄错。
3. **180 fps 必须带解释边界。** rAF 的上限就是显示器刷新率，所以这个数的信息量
   不是"比 55 高很多"，而是**实测顶到了硬件上限**（180Hz 屏、流式期间一帧没掉）。
   换到 60Hz 机器，这条的天花板就是 60 —— 它真正测的是"流式有没有把主线程堵死"，
   而这件事与刷新率无关：真堵住了，180Hz 上也掉到个位数。

4. **口径订正：「流式首 token 延迟」→「本地首帧延迟」。** 这一条以前是写错的，
   现在更正。`Usage.ttftMs` 量的是 **run 开始 → 背压泵第一次吐出一帧**
   （`backpressure.ts:#flush`），起点时上游**还没有吐出任何东西** ——
   所以它量的是**本项目自己的**调度开销，不是端到端首 token 延迟。
   在 `pnpm selfcheck` 这条链路上上游是脚本化的，这个数就约等于
   `produceIntervalMs + flushIntervalMs`（12 + 16 ≈ 28 ms），与上游无关。

   **理由**：留着旧名字会让读者把 27 ms 读成"接了真模型也只要 27ms 就出字"，
   而那是错的 —— 真实上游下这个数会被上游首 token 主导，可能变成几百毫秒。

   **代价**：现在表里**没有**端到端首 token 延迟这一项了。要拿到它得在
   `navigateStream` 收到**首个上游 chunk** 的时刻再打一个点，把它和泵的首帧分开记录 ——
   那是一次采集点的增加（改 core），不是改个标签就能有。当前刻意不做：
   在脚本上游下它只会量出"本地回环有多快"，是个好看但没有信息量的数字。
   接上真实 navigate 之后再补这一项才有意义。

   **复测**（改造之后，同一台机器）：4 趟得到 `27 / 27 / 28 / 29 ms`，与归档区间一致。
   另有 1 趟读到 `17 ms`，但**同一趟**渲染层的 rAF 探针是 `0 fps` ——
   说明那趟窗口没上屏、整条链路处于退化状态。那个 17ms 仍来自泵（相位不同罢了），
   但它不适合和正常趟一起报：**看到一个好看的数之前，先确认这一趟是不是正常的**。

两项虽然达标但**贴近上限**，改进项写在 `docs/perf.md` §3。
不达标或快不达标就如实写清并给出下一步 —— 而不是把标尺挪一挪。

### 9. 鸿蒙壳端到端（`pnpm verify:ohos`）

这是「同一个 core，换一个壳」这句主张的**另一半证据**。Electron 壳证明得了架构，
但证明不了**可移植** —— 除非真有一个非同族的壳跑起来。

一条命令走完全链路：同步源码 → `hvigorw assembleHap` → `hdc install` →
`aa start` → UI 点击 → 截图 → 归档 → 判定。

下面这一段是**真机跑通那一次**的输出（改造前，所以还没有自检面板那几步）：

```
✅ 工具链              DevEco @ D:/software/DevEco Studio
✅ 设备在线             127.0.0.1:5555（x86_64）
✅ 同步 contract/core   （复制源码 + 改写裸包名）
✅ hvigorw assembleHap  BUILD SUCCESSFUL
✅ HAP 产物             193.7 KB
✅ hdc install          install bundle successfully
✅ aa start             start ability successfully
✅ 截图 · 首屏           246.9 KB → docs/screenshots/ohos-shell.jpg
✅ 点击「发送」→ ohos-shell-stream.jpg
✅ 点击「带工具」→ ohos-shell-tool.jpg
```

现在它还多走三步（**尚未在真机上复现过** —— 手上的机器没有模拟器，跑不了就不写假输出）：

1. **带配置启动**：`aa start … --ps upstreamUrl <宿主> --ps ohosToken <token>`
   → `EntryAbility` 把值放进 `AppStorage` → 页面的 `@StorageLink` 读出来。
2. **慢流中间帧**：点「自检·慢流」，在流还没结束时抓一帧 —— 判定是
   UI 树上出现了**终文的真前缀且更短**（截图文件存在证明不了逐字）。
3. **跑判定**：点「自检·跑判定」，应用只打印 `[SELFCHECK]` 原始数字，
   判定交给脚本（见下面第 1 点）。

截图证据在 `docs/screenshots/`。UI 里跑的都是**同一份** core：
会话列表来自 `core/session/store`，流式来自 `core/agent/runtime` +
`core/events/streamBus`，能力表来自 `shared/ports.ets` 的运行时探测
（`deviceInfo.deviceType` 读出来是 `phone`，所以 `window.multi` 显示「—」，
UI 据此少渲染一块 —— 这是设计结果，不是降级事故）。

截图里能直接读到实测的事件序列：

- 纯流式 —— `start×1 → token×N → done×1`
- 工具链路 —— `start×1 → tool×1 → tool_end×1 → token×N → done×1`

两者都带首帧延迟、总耗时与「合并 0 次」。**具体数值不写进 README** ——
它每次跑都会变，抄进来只会变成过期数字；要看精确值请读截图本身或
`docs/evidence/ohos-selfcheck.json`。

四个设计点：

1. **四种"跑不了"被严格区分，且都返回非零**：工具链缺失 / 派生子进程被拒 /
   设备不在线 / core 产物缺失 —— 报告里落成 `skipped` 而不是 `ok`。这和 Electron 侧
   "未打包形态必须报 `error` 而不是永远转圈"是同一条原则：
   **环境不具备时如实说，不假装成功**。失去鸿蒙环境的机器上跑它也不会给出假绿。

   ⚠️ **中间那两条必须分开**：受限会话里 `hdc list targets` 自己也会 `EBUSY`，
   不区分就会把**环境问题**报成**设备问题** —— 排查方向当场就错。
   （本仓库的受限会话里跑它：停在设备探测那一步，exit 2、`skipped: 'spawn-blocked'`。）

2. **判定必须落在脚本里，不能由被测应用自己宣布。** 模拟器里的自检只打印
   `[SELFCHECK]` 原始数字，成败由宿主脚本判。判定逻辑抽成了一个**纯函数**
   （`parse-ohos-selfcheck.mjs`），因为真机上够不着它的时候还得能验它 ——
   `pnpm verify:ohos-judge` 用**合成行**驱动它做变异测试，不需要设备、不派生进程：

   | 变异 | 被哪一条杀掉 |
   |---|---|
   | 终态数 1→2 | 场景 normal · 恰好一个终态 |
   | 两条断流合成一条 | 场景 killed · 措辞 |
   | 断流当成功 | 场景 silent-close · 终态与错误码 |
   | abort 没被认出来 | 场景 abort · 终态与错误码 |
   | 少收几片 / 正文差 1 字 | 场景 normal · 逐帧 / 正文长度 |
   | 不认识场景没被拒 | 反向 · 不认识场景被拒 |
   | 上游给截断场景也发了 done | 对端 · 截断场景没发 done |
   | 停止没真断连 | 对端 · 看见了 abort 断连 |
   | 没有 DONE 行 | 自检跑完 |

   13 发变异 + 1 发**反向**（把期望表里承重的那条 `msgHas` 拿掉，对应的坏输入必须
   变得**杀不掉**）—— 全部符合预期。反向那条是必要的：只证明"改坏输入会挂"还不够，
   得证明挂**确实靠那条断言**，否则可能只是别的断言恰好也不同意。

   这个抽取当场抓到一个真缺陷：解析器把 `text=` / `frames=` 当成必需字段，
   而应用给 `unknown` 那行**不打**这两个字段 → 反向断言**恒红**，
   真机上"跑对了"也会报失败。改真机之前抓到的。

3. **「成功」的判定方式本身要先被验证。** 这个脚本的第一版是**假绿的**，
   而且是两层，都很安静：

   | 层 | 症状 | 根因 |
   |---|---|---|
   | 截图 | 报"成功"，但文件是**上一次**的 | 判成败用的是 `existsSync(本地文件)`；设备端没生成时旧文件还在，于是通过。而且 `hdc file recv` 失败时**退出码仍是 0**，唯一信号是 stdout 里的 `[Fail]` |
   | 截图 | 设备端**从来没生成过**文件 | `snapshot_display` 只认 `.jpeg` 后缀。传 `.jpg` 得到 `error: suffix must be .jpeg` 并什么都不产出 |

   怎么发现的：**文件 mtime 没变**。跑完一轮验证后截图时间戳还是上一次的 ——
   这个 grep 起来毫无异常的细节是唯一线索。顺着它实测 `hdc file recv`
   才发现退出码不可信，再往前才挖到后缀限制。

4. **点击坐标也错过，而且错得更隐蔽。** 第一版按截图像素估坐标，点空；
   改成从 UI 树取 bounds 后**还是错的** ——
   用 `indexOf('"text":"X"')` 再向后 slice 找第一个 `"bounds"`，拿到的是
   **下一个节点**的（attributes 里 `bounds` 排在 `text` 之前）。后果是整体错位一个按钮：

   | 目标 | 真实中心 | 切片法算出 | 实际落点 |
   |---|---|---|---|
   | 「发送」 | (165,1810) | (420,1810) | 「带工具」 |
   | 「带工具」 | (420,1810) | (674,1810) | 「暂停」 |

   这比"点空"危险得多：点空当场能看出来，点错位置产出的是
   **看起来合理、内容却是另一次操作**的截图。暴露它的是
   **两张图的 MD5 完全相同** —— 字节数一样还可以说是巧合，
   哈希一样就只能是同一张画面了。现在改成按 JSON 结构遍历取节点自己的
   `attributes.bounds`，并保留"找不到就报失败、绝不静默跳过"。

   一条能带走的经验：**"看起来成功了"和"真的成功了"之间的距离，
   往往就是一个 mtime 或一个哈希。**

### 10. 同一份 core，两个上游实现

这一节先说清定位，再讲接线。**crossdeck 不是"navigate 的桌面客户端"** ——
那会把它讲成又一个聊天壳，而它真正要示范的是**跨端桌面工程**：
**同一份 core，两个上游实现**。

「上游」在这里是**业务内容**，不是架构的主角：脚本上游（离线的 `ScriptedModel`）
与 navigate 上游（HTTP + SSE）可以互换，换掉它，**三个壳与 core 一行都不用改**。
下面这张表就是这句话的展开。

#### 10.1 为什么自检之外还要接真实上游

脚本上游能证明"壳会不会把事件正确转发出去"，证明不了 HTTP/SSE 这一层 ——
而端侧真正会出事的地方恰好都在那儿：

| 只在真上游下才会暴露的 | 症状 |
|---|---|
| 首字节迟迟不来 | 界面**永远转圈**（没有首帧超时的话） |
| `decode(bytes, { stream: true })` 漏了 `stream` | 偶发**乱码**（按字节边界切坏多字节字符） |
| Web 壳掉了 `credentials: 'same-origin'` | 本地 Node 测不出来，线上**每次 401** |
| 上游提前关流 / socket 被销毁 | 两种**不同**的失败路径，合成一条就漏一个 |
| `cancel()` 只"不再读"而没真断连 | 上游继续跑，账单继续烧 |

#### 10.2 三端各自的 IO 实现（这是差异，不是重复）

|  | Electron 壳 | Web 壳 | 鸿蒙壳 |
|---|---|---|---|
| 上游实现 | `main/navigate/client.ts`，主进程 `fetch` | `createWebNavigateClient`，页面内 `fetch` | `createOhosNavigateClient`，`@kit.NetworkKit` |
| 凭据 | `?token=`，**只活主进程** | **同源 httpOnly cookie** | token 进 **body** |
| 断连 | `AbortController.abort()` | 同左 | `httpRequest.destroy()` |
| 流结束信号 | `event: done` | 同左 | **`dataEnd` 回调**（`complete` 正常/异常都会发） |
| 首帧计时 | 挂在 `await fetch` **外面** | 同左 | `dataReceive` 里先 `markFirstByte()` |

共同的部位是 `core/src/net/navigateStream.ts` —— 里面的首帧超时计时器、SSE 分帧、
帧 → 事件的映射、**幂等终态**、`authoritative` 差量补吐、取消记账，三端**一份**。

**为什么 `fetch` 不能搬进 core**：core 的 `lib` 只有 ES2022，拿不到
`Response` / `AbortController` / `URL` 的类型；给它加 DOM lib 会**同时**毁掉两件事 ——
「Web 壳是试金石」（它靠 core 编不过 `node:*` 来证明 core 无平台假设）和
「contract/core 可被 ArkTS 直接消费」。所以分界线画在**已解码的文本**上：
壳负责字节 → 文本，core 负责文本 → 事件；要硬断连时 core 只喊一声
`abortUpstream()`，自己不碰网络。

同理，**core 里不能写 `console`**（它连 `console` 的类型都没有）：core 只产出
`{ level, text }`，由壳传 `createNavigateReporter(console)` 落盘。
**落日志是 IO，IO 归壳。**

#### 10.3 能力探测怎么降级

core 用 `capabilities.has('x')` 分支，**不写** `if (platform === 'electron')` ——
后者会让第三端变成一串 `else`。`Platform` 只用于日志诊断。

| 能力 | Electron | Web | 鸿蒙（phone） | 没有时的 UI 行为 |
|---|---|---|---|---|
| `fs.scope` | ✅ | ✅（OPFS；没有 `navigator.storage.getDirectory` 就没有） | ✅ | 没有就不渲染文件树 |
| `notify.system` | ✅ | ✅（`typeof Notification !== 'undefined'` 才有） | ✅ | 没有就不渲染通知开关 |
| `window.multi` | ✅ | ❌ | ❌（`deviceType = phone`；`2in1` / `tablet` 才有） | 多窗口那块显示 `—` |
| `shortcut.global` | ✅ | ❌ | ❌ | 不渲染快捷键提示 |
| `tray` | ✅ | ❌ | ❌ | 不渲染托盘入口 |
| `update.auto` | ✅ | ❌ | ❌ | 不渲染更新入口 |

⚠️ 两个能力是**运行时读出来的**，不是写死的：Web 的 `fs.scope` 取决于 OPFS 在不在，
鸿蒙的 `window.multi` 取决于 `deviceInfo.deviceType`。同一条断言在自检里写成了
`has('fs.scope') === (typeof navigator.storage.getDirectory === 'function')` ——
**把能力表和探测源绑在一起**，免得日后有人把它改成常量还能通过。

还有一点容易混：`update.auto` 在 Electron 上**恒在**（更新入口照渲染），
"没打包就不能更新"是**调用时**的失败（`UNSUPPORTED:NOT_PACKAGED`），
不是能力探测的结果。把这两件事混起来，就会出现"没打包 → 连入口都不显示 →
用户以为这功能不存在"。

关键是**假实现比没有实现更糟**：缺能力时宁可少渲染一块，也不给一个点了没反应的按钮。
所以 Web 壳自检里有一条专门断言 `window.multi` / `tray` / `update.auto` **明确不在**
（而不是"探测失败"）。同样的口径在凭据上：`safeStorage` 不可用时 Electron 壳
**如实降级成明文存储**，并把"明文"这个词写进界面上的 `note` —— 不假装加密过。

#### 10.4 离线脚本上游的定位

脚本上游（以及自检里那个假 SSE 上游）**只活在自检路径上**：
Web 壳的 `?selfcheck=1`、Electron 壳的 `--selfcheck`、鸿蒙壳的 `--ps upstreamUrl …`。
它不是产品路径的一部分，也不参与任何性能口径。

一条硬规矩：**UI 必须如实标出当前是哪个上游。**
Web 壳的角标写的是「上游：脚本（离线可跑，**不是真上游**）」，
Electron 壳报 `upstream.kind`，鸿蒙壳的自检面板打出 `upstream=<地址>`。
理由和"未打包形态必须报 error 而不是永远转圈"是同一条：
**离线能跑 ≠ 连上了真上游**，把这两件事混起来，整套自检的可信度就没了。

三个壳的假上游说**同一套场景词表**（正常 / 干净 EOF / socket 销毁 / 上游 error /
中途 abort）。Web 与鸿蒙的宿主脚本共用一份实现
（`scripts/fake-navigate-upstream.mjs`）—— 抄两份的话词表会有两个版本，
而漂移的症状是"这个场景不存在（400）"，看起来像客户端的问题。
Electron 那份仍在主进程内（它要跟着 main 一起打包），是**约定一致**而不是同一份代码。

> **一处悬案**：上游会在 `sources` 事件里给引用来源，三端都**收得到**，
> 但 `contract` 的 `AgentStreamEvent` 里没有对应的事件类型 ——
> 所以现在只能上报 + 计数（诊断里有 `sources×N`），送不到 UI。
> 要真正显示引用列表，得先给契约加一种事件类型。

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
    src/selfcheck.ts     #     61 条断言（能力降级 / scope / 内核 / 真实 UI 点击）
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
  shell-ohos/            #   鸿蒙壳（DevEco 工程，**刻意不进 pnpm workspace**，见下）
    entry/src/main/ets/
      pages/Index.ets    #     单窗口 UI（ArkUI 声明式；四节：能力 / 会话 / 流式 / spike）
      shared/ports.ets   #     CapabilityPort 的第三份实现（@ohos.file.fs 等）
      shared/probe/      #     M6-0 的五层探针（spike 的活证据）
      shared/contract/   #     ← 由 scripts/sync-shared.mjs 生成，勿手改（不进版本库）
      shared/core/       #     ← 同上（contract 与 core 的源码副本）
    scripts/sync-shared.mjs  # 把 contract/core 源码搬进工程 + 改写裸包名
    scripts/verify-ohos.mjs  # 编译 → 装 → 起 → 点 → 截图 → 归档 → 判定
    spike/ets-rejects-conditional-types.ets.txt # M6-0 的反例留档（见「决策」一节）
scripts/
  verify-type-alignment.mjs  # 11 个类型负例（三个 tsconfig 项目各覆盖到）
  verify-lint-boundaries.mjs # 17 个 lint 负例 + 5 个必须沉默的正例
  verify-core-purity.mjs     # core 铁律扫描（CI 层）
  verify-core-scope.mjs      # PathGuard / WorkspaceStore 的 72 条断言（加载 core 编译产物）
  verify-core-agent.mjs      # 事件总线 / 背压 / 工具链路的 83 条断言（假调度器，0ms 真实等待）
  archive-selfcheck.mjs      # Electron 自检证据归档
docs/evidence/               # 自检报告与截图（可核验产物）
```

`packages/shell-ohos` **刻意不是 pnpm workspace 成员**：它是 DevEco 工程，
清单文件是 `oh-package.json5`，依赖走 `ohpm` 而不是 npm。
给它补一个 `package.json` 只会制造"双清单"的歧义 ——
读者会以为它是能被 `pnpm --filter @crossdeck/shell-ohos` 操作的 JS 包。
所以根 `package.json` 直接指向它的脚本路径，而不是走 `--filter`。

`shared/contract/` 与 `shared/core/` **不进版本库**（见 `.gitignore`）：
它们是 `pnpm sync:ohos` 的产物，事实源是 `packages/contract` 与 `packages/core`。
提交副本 = 版本库里同时躺着两份源码，而漂移是静默的 ——
在 core 里修好的 bug，鸿蒙壳会继续跑旧版本。
代价是：**clone 之后第一次用 DevEco 打开工程前，先跑一次 `pnpm sync:ohos`**，
否则 IDE 会对那些 import 报找不到模块（`pnpm verify:ohos` 会自动带上这一步）。

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
`pnpm selfcheck:web` 会起一个静态服务、开一个无头 Chromium、在页面里跑 61 条断言。
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

### 为什么 ArkTS 需要一次「显式接缝」（M6-0 spike 的结论）

鸿蒙壳最大的不确定性不是文件系统 API，而是：**`@crossdeck/contract` 能被 ArkTS 消费吗？**
ArkTS 是 TypeScript 的**受限子集**（无结构化类型、无完整 `any`/`unknown` 语义、
条件类型与 `as const` 推导能力有限），而本项目的契约层恰好重度使用
映射类型推导（`IpcInvokeMap`）与判别联合收窄。计划因此要求**先做 spike**，
记录具体哪一条语法过不去，再决定「直接复用」还是「代码生成」。

结论：**可以直接复用**，但有三个前提。每一条都附了反例 ——
"能跑通"这个结论没有反面证据是不成立的。

**① 必须以 `.ts` 形态进去，不能改名 `.ets`。**
ArkTS 对后缀的待遇不同：`.ts` 走 TypeScript 的宽松规则，`.ets` 走 ArkTS 的受限规则。
同一份 `types.ts` 的内容原样改成 `.ets`，ArkTS 抛 **12 个错**
（`arkts-no-conditional-types` ×多个 + `arkts-no-aliases-by-index`）。
反例留档在 `packages/shell-ohos/spike/ets-rejects-conditional-types.ets.txt`。

**② core 里有一处判别联合的收窄写法必须改。**
`resolveInWorkspace.ts` 原本用 `if (!decision.allowed)` 收窄 `PathDecision` ——
tsc 下完全正确，ArkTS 下报 `Property 'reason' does not exist on type 'PathDecision'`。
换成反向的 `if (decision.allowed)` **同样报错**：ArkTS 不支持以**布尔字面量**
（`allowed: true` / `allowed: false`）为判别式的联合收窄，两个方向都不行。
最后改成 `if ('reason' in decision)` —— 属性存在性窄化，两边都认。
源码里留了注释，防止有人"顺手改回更自然的写法"。

**③ 需要一次构建期的接缝：把裸包名改写成相对路径。**
ArkTS 工程不进 pnpm workspace，`@crossdeck/contract` 这个 specifier 它解析不了。
`scripts/sync-shared.mjs` 在建前把 contract 与 core 的**源码**复制进
`entry/src/main/ets/shared/`，并把裸包名改写成相对路径。

用**复制**而不是手工维护第二份副本：手工副本会漂移，而漂移是**静默**的 ——
你在 core 里修好的 bug，鸿蒙壳会继续跑旧版本。脚本复制让"同一份源码"
这件事变得可执行，而不是一句声明。

还有一条**正面**证据同样重要：往 `Index.ets` 里写一个
`'not-a-real-platform'` 赋给 `Platform`，编译器报
`Type '"not-a-real-platform"' is not assignable to type 'Platform'`，
而且它**跨文件追到了** `contract/capability.ts`。没有这一步，
"五层探针全绿"只能说明 ArkTS 没报错，不能说明它真的在 type-check。

---

## 平台能力对照

这张表不是设想：**三列都是运行时探测的输出**。Web 列来自
`docs/evidence/web-selfcheck.json` 的 `detectedCapabilities`，
Electron 列来自自检报告的 `systemInfo.capabilities`，鸿蒙列来自模拟器上的实测
（见 `docs/screenshots/ohos-shell.jpg` 的 ① 节）。

| 能力 | Web 壳 | Electron 壳 | HarmonyOS 壳（phone 形态实测） |
|---|---|---|---|
| `fs.scope` 文件读写 | ✅ OPFS / File System Access API | ✅ `node:fs` + scope 授权 | ✅ `@ohos.file.fs`（沙箱 + 用户授权目录） |
| `notify.system` 系统通知 | ⚠️ 有，但先要用户授权 | ✅ `new Notification()` | ✅ `@ohos.notificationManager` |
| `window.multi` 多窗口 | ❌ 只有页面内面板 | ✅ `BrowserWindow` 多实例 | ❌ 探到 `phone`；`2in1` / `tablet` 才报 ✅ |
| `shortcut.global` 全局快捷键 | ❌ 网页不允许注册 | ✅ `globalShortcut` | ❌ 鸿蒙没有桌面级全局快捷键 |
| `update.auto` 自动更新 | ❌ 刷新即最新 | ✅ `electron-updater` | ❌ 更新走应用市场，非应用内自更新 |
| `tray` 托盘 | ❌ 不存在 | ✅ `Tray` | ❌ 没有系统托盘概念 |

鸿蒙列里只有 `window.multi` 是**真探测**（按 `deviceInfo.deviceType` 判）；
其余各项目前是无条件声明 —— 能力确实存在，但没做可用性检查。
这里如实标出来，而不是让表格看起来比实现更成熟。

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
      61 条断言 + 截图归档
- [x] **M4.5(c)** — ESLint `no-restricted-syntax` 把铁律提到编辑器即时反馈
      （`noInlineConfig` 让 disable 注释失效；17 个负例 + 5 个必须沉默的正例）
- [ ] **M1** — 从 navigate 抽取更多 core 模块（真实 LLM 适配层）
- [x] **M5(a)** — 打包分发 + 自动更新链路：NSIS 安装包 + `latest.yml`；
      更新契约（判别联合状态机）；`--update-feed-probe` 在**打包产物**上
      对着真实静态 feed 跑完 `checking → available → downloading → ready`
- [ ] **M5(b)** — mac / linux 产物（尽力）——计划里排在取舍顺序最后
- [x] **M5(c)** — 性能量化：`perf:sample` 通道 + 六项实测指标
      （冷启动 / 主进程内存 / 渲染进程内存 / 本地首帧延迟 / 流式帧率 / 安装包体积），
      报告见 `docs/perf.md`
- [x] **M6-0** — ArkTS 消费 contract 的 spike：结论是**可直接复用**，
      代价是 `.ts` 形态 + 一处 `in` 窄化 + 一次显式接缝（见「为什么 ArkTS 需要一次显式接缝」）
- [x] **M6-1** — 性能采样落地 + `docs/perf.md`：六项全有实测值，两项贴近上限并附改进项
- [x] **M6-2** — 鸿蒙壳单窗口跑通：`packages/shell-ohos`，
      编译 → 安装 → 启动 → 点击 → 截图全链路（`pnpm verify:ohos`）
- [ ] **M6-3** — 鸿蒙壳多窗口 / 自由窗口 —— **未做**，按计划退到
      「单窗口 + 能力探测降级」。这是计划里预留的退路而不是意外：
      本机只装了 `phone_all_x86` 系统镜像，2in1 需要的 `pc_all_x86` 没下载（见「已知限制」）
- [x] **M6-4** — README + case study：可复现的性能数据表 + 鸿蒙壳章节 +
      M6-0 的架构结论

---

## 已知限制

这一节存在的理由：一份只讲做成了什么的工程文档，读起来必然可疑。
下面每一条都是**当前产物**的真实状态，不是"以后会做"的清单。

### 1. 安装包没有代码签名

`pnpm pack:win` 产出的是**未签名**包。后果是具体的：Windows SmartScreen 会弹
「未知发布者」，用户得点两次「仍要运行」；系统层面无法验证发布者身份，
也就没有真正的静默升级体验。

没签的原因很直接：代码签名证书要花钱、要过实名审核。项目没有发布渠道，
为演示产物买证书不划算。但要做真实分发，这一步无法绕过。

### 2. 安装包 98.1MB，其中 99% 不是这个项目写的代码

`win-unpacked/` 逐文件实测（**21 个文件，合计 321.2 MB**）：

| 项 | 未压缩 |
|---|---|
| `crossdeck.exe`（Electron 44 运行时主体） | 234.6 MB |
| `dxcompiler.dll` / `LICENSES.chromium.html` | 24.6 / 19.5 MB |
| `icudtl.dat` / `resources.pak` | 10.4 / 11.9 MB |
| `locales/`（已裁到 `en-US` + `zh-CN` 两个） | 1.12 MB |
| **`app.asar`（本项目全部代码）** | **0.93 MB** |

321.2MB → 98.1MB（**压缩率 30.5%**）靠 `electronLanguages` 裁 locale +
`compression: maximum`。计划的验收线原本是 `< 90MB`，**实测没过，因此修订口径
而不是修订结论**：现在写 `< 100MB`。唯一能过线的做法是删掉 `dxcompiler.dll` +
`dxil.dll`（约 −19.8MB → 78MB），但那会拿掉 WebGPU / Shader Model 6 的
着色器编译路径 —— 代价不可测（本机 GPU 路径起不来，无从验证），
不拿真实用户去赌一个数字。理由与取舍见
`docs/plans/2026-10-04-m4-m6-开发计划.md` §2.3，性能口径见 `docs/perf.md` §2.6。

### 3. 只有 Windows 产物

POSIX 侧没有 CI 也没有对应工具链，本机也验不了。
计划里 mac / linux 排在取舍顺序最后 —— 与其产出两个"构建成功但没人跑过"的包，
不如只承诺一个真跑通的。

### 4. 更新源是个占位域名

包里烘死的 `app-update.yml` 指向 `https://updates.invalid/crossdeck`
（`.invalid` 是保留后缀，永远不会被解析成功）。写一个看起来能用的地址才是误导。
真跑更新链路的方式是环境变量覆盖：

```bash
CROSSDECK_UPDATE_URL=http://127.0.0.1:8080 pnpm verify:update-feed
```

### 5. 自检需要 `--no-sandbox`（仅限本机受限会话）

本机受限会话里 Chromium 的沙箱起不来 viz 层（裸 Electron 也能复现，`--disable-gpu` 不够），
所以自检要手工加 `--no-sandbox`（命令见上文「受限环境下跑自检」）。

**这条只影响自检这条路，产物本身照常带沙箱启动**（`sandbox: true` +
`contextIsolation: true` 都在）。但"要手工记着加参数"本身就是个坑：
写进脚本会让 CI 之外的人以为自检本来就该关沙箱；自动探测降级又要多一条
会静默生效的分支，而静默降级的测试最容易变成"永远走不到的那条路"。
怎么收口还没定，暂时保持手工 + 在这里写清。

### 6. 鸿蒙壳只在 phone 形态验证过，而且是单窗口

`pnpm verify:ohos` 跑通的是 **phone 模拟器**。计划文档里"4 个 HarmonyOS 7.0.0
模拟器，含 `MateBook Pro (2in1)`"是一条**过期事实**：本机
`%LOCALAPPDATA%/Huawei/Sdk/system-image/HarmonyOS-7.0.0/` 下**只有 `phone_all_x86`**,
2in1 需要的 `pc_all_x86` 与 tablet 的 `tablet_x86` 都没下载 —— 新建的 2in1
模拟器会在启动时报 `Unable to start the emulator`。

后果是具体的：`window.multi` 在鸿蒙侧**从未被验证为 ✅**。
`ports.ets` 里那条 `if (deviceType === '2in1' || deviceType === 'tablet')` 是真探测，
但对应的设备形态没跑过。M6-3（多窗口 / 自由窗口）因此按计划退到
「单窗口 + 能力探测降级」—— 这是计划里预留的退路，不是意外。

### 7. 鸿蒙壳的能力表是「设备提供」，不是「壳已实现」

`shared/ports.ets` 做的是**能力探测**（`detectCapabilities()` / `capabilityNote()` /
`deviceKind()`）—— 它回答的是"**这台设备**有没有这项能力"，
没有回答"**这个壳**把这项能力实现了没有"。

具体地：`fs.scope` 与 `notify.system` 目前是**无条件** push 进能力表的，
而 `@ohos.file.fs` 与 `@ohos.notificationManager` 的**端口实现还没有写**。
所以截图里那两个 ✅ 的准确含义是「设备提供这项能力」，
不是「这个壳已经能用它」。

写清这一点是为了不让「平台能力对照」那张表读起来比实现更成熟。
真实的缺口是：**Electron 壳有完整的 `FsPort` 实现，鸿蒙壳没有** ——
core 的 `PathGuard` / `WorkspaceStore` 在鸿蒙侧是"能编译、能跑单测、
但没有壳去调它"的状态。这是 M6 之后最该补的一项。

---

## 排查

| 现象 | 原因 |
|---|---|
| 窗口闪一下就退出 / `app` 为 undefined | 环境里有 `ELECTRON_RUN_AS_NODE=1`，Electron 退化成了普通 Node。`pnpm dev` 走 `scripts/launch.mjs`，它会主动清掉这个变量 |
| `Electron failed to install correctly` | 二进制没拉下来，跑 `pnpm setup:electron` |
| 无头 / CI 下 `GPU process isn't usable`（退出码 3） | 受限会话里 Chromium 沙箱起不来 viz 层。自检已关 GPU；若仍崩，加 `--no-sandbox`（见下方说明） |
| `pnpm selfcheck` 出完报告却不返回 | 同一原因：主进程卡在残留的 GPU/viz 子进程上，`app.exit()` 结束不掉。**这不该由应用自己救**（事件循环已停摆，兜底 `setTimeout` 不会触发）。所以 `launch.mjs` 监听应用的 `[selfcheck] DONE ok=… code=…` 哨兵，据此强杀进程树并以**判定结果**而不是"能不能退出"作为退出码 |
| `pack:win` 报 `Cannot read properties of undefined (reading 'ReadWrite')` | `app-builder-lib` 需要的 `@electron/get` 版本不对。报错里**不含任何包名**，只有读 `out/util/electronGet.js` 才看得出是依赖问题。根因是 npmmirror 对 `@electron/get@^3.0.0` 挑成 3.0.0（上游源挑 3.1.0，而 `ElectronDownloadCacheMode` 是 3.1.0 才有的）。仓库已用 `pnpm-workspace.yaml` 的 `overrides` 钉住 3.1.0；**判断解析结果是否可疑时，换 `--registry=https://registry.npmjs.org/` 对照一次最快** |
| 白屏、控制台报 CSP 拦截 | 生产 CSP 的 `script-src` 只有 `'self'`。注意 Vite 的 modulepreload polyfill 会注入行内脚本，已在 `vite.config.ts` 关掉 |
| `selfcheck:web` 报「找不到 Chromium 内核浏览器」 | 它只用系统已有的 Edge / Chrome。装在别处时用 `CROSSDECK_BROWSER=<路径>` 指定 |
| `selfcheck:web` 的 OPFS 断言失败 | OPFS 需要**安全上下文**：只认 `https://` 或 `127.0.0.1` / `localhost`。脚本起的就是 `127.0.0.1` —— 换成局域网 IP 会失效 |
| `hvigorw` 报 `Invalid value of 'DEVECO_SDK_HOME'` / `spawn java ENOENT` | 前者要设 `DEVECO_SDK_HOME=<DEVECO>/sdk`（脚本已设）；后者是 DevEco 自带的 jbr 不在 PATH 里。手工跑时：`export PATH="$DEVECO/tools/node:$DEVECO/jbr/bin:$PATH"` |
| `snapshot_display` 报 `suffix must be .jpeg` | 它只认 `.jpeg` —— 传 `.jpg` 会**什么都不产出**（不是报错退出，而是悄悄地不生成文件）。脚本因此在设备端用 `.jpeg`、本地落 `.jpg`，这个不对称是工具的脾气 |
| 模拟器报 `Unable to start the emulator` | 该形态的系统镜像没下载（本机只有 `phone_all_x86`）。启动命令还需带 `-instancePath` 与 `-imageRoot`，否则日志会报 `g_deployedPath is not empty` |
| `verify:ohos` 报「工具链」或「设备在线」失败 | **这是设计如此**，不是脚本坏了：环境不具备时如实报 `skipped` 并以非零码退出。装好 DevEco、起模拟器再跑（`DEVECO_HOME` 可覆盖默认路径） |

---

## 技术栈

TypeScript（strict，含 `exactOptionalPropertyTypes`）· pnpm workspace · Electron 44 ·
React 19 · Vite 8 · Tailwind 4 · esbuild · Node 20+ ·
ArkTS / DevEco（鸿蒙壳，`hvigor` + `hdc`，非 npm 生态）
