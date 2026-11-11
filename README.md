# crossdeck

> 一个平台无关的 Agent 内核 · 多个平台壳。
> One platform-agnostic core, multiple shells.

`crossdeck` 是一个跨端 Agent 桌面客户端的架构示范：把 Agent 运行时抽成**零平台依赖**的
TypeScript 包，再用 Windows（Electron）/ Web / 鸿蒙 PC（2in1）三个壳各自注入平台能力。

它要回答的是一个工程问题，而不是一个产品问题：

> **同一个内核，怎么在浏览器、Windows 桌面端、鸿蒙 PC 端上跑，且边界清晰、降级可控、类型安全？**

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
  能编译、能打包、能跑（`pnpm selfcheck:web`，136 项断言 + 截图）⇒ 不是口号
- **类型安全 IPC**：`main` / `preload` / `renderer` 三处共享 `IpcInvokeMap`，
  改错通道名或请求形状会在**编译期**报错（16 个负例证明）
- **跨环境类型隔离**：main 项目的 `lib` 里没有 DOM、renderer 项目的 `types` 是空的、
  Web 壳两者都没有只留 DOM —— 这三条边界各有类型负例守着（`pnpm verify`）
- **能力探测优于平台判断**：core 用 `capabilities.has('shortcut.global')` 决定 UI，
  而不是 `if (platform === 'electron')`
- **工作区 scope 模型**：Agent 要读用户的真实目录，就必须有边界 ——
  `PathGuard` 做归一化 → 最长 root 匹配 → symlink 逃逸校验，越界一律**具体地**拒绝
  （`SCOPE_DENIED:OUT_OF_SCOPE`，不是笼统的 `FORBIDDEN`）
- **流式背压**：产字与推字解耦，按帧 flush，队列超限**合并中间态**而非丢尾部，
  暂停期间零推送（反向通道走 invoke 才有 ack）
- **调度器注入**：core 里没有 `setInterval` / `Date.now`，只有 `AgentDeps.every/now/newId`。
  收益不是"看起来优雅"，而是背压可以**逐帧确定性验证** —— 103 条断言、全程 0ms 真实等待
- **第二个真壳，不是"顺手也做一个"**：`shell-ohos` 是 ArkTS（DevEco）工程，
  与 Electron **非同族**，跑的是**同一份** contract/core 源码
  （构建期同步，不维护第二份副本）。界面用 **ArkWeb 承载同一份共享 UI**（`@crossdeck/ui`），
  ArkTS 只实现 9 个**端口**（system/session/agent/workspace/document/navigate/action/shell/selfcheck），
  29 条通道的映射在页面 JS 里 —— 业务编排归 JS、系统调用归 ArkTS。
  Electron 壳证明得了架构，但证明不了**可移植** ——
  除非真有一个非同族的壳编译过、装上、跑起来、并且有截图
  （旧的 ArkUI 原生页保留为 `--ps ui arkui`，是"没有 WebView 也能自证 core/RDB"的兜底）

---

## 快速开始

```bash
pnpm install

# 一次性：Electron 44 起取消了 postinstall，二进制需要显式拉取（约 240MB）
pnpm setup:electron

pnpm dev          # 开发：内嵌 Vite（HMR）+ Electron，只有一个进程
pnpm start        # 生产：跑 dist/ 里的真实产物
pnpm verify       # 全量校验：类型检查 + core 纯度 + IPC 负例 + 各内核单测 + 鸿蒙判定层
pnpm selfcheck    # 无人值守端到端自检，产出截图与 JSON 报告
pnpm selfcheck:web  # Web 壳（试金石）端到端自检：真开一个 Chromium 跑同一份 core
pnpm pack:win     # 打 Windows NSIS 安装包（约 98MB）
pnpm verify:update-feed  # 用本地真实 feed 在打包产物上跑通更新链路（须先 pack:win）
pnpm build:ohos-web      # 打鸿蒙壳要装进 rawfile 的页面 bundle（共享 UI）
pnpm verify:ohos-bundle  # 校验页面 bundle + 端口桩产物（含空壳反例）
pnpm verify:ohos  # 鸿蒙壳端到端：编译 → 安装 → 启动 → 页面自检 → 判定 → 截图（需 DevEco + 鸿蒙 PC 模拟器在线）
```

### 各命令实际做了什么

| 命令 | 说明 |
|---|---|
| `pnpm dev` | esbuild 打 main/preload → Electron 主进程**内嵌启动 Vite** → 加载 dev server |
| `pnpm start` | 全量构建（含 renderer）→ 通过自称协议 `app://` 加载产物。加 `--devtools` 可对**产物**开调试器（默认不带） |
| `pnpm dev:web` | 单独的 Vite dev server（:5199）—— core 在浏览器里跑，不需要 Electron |
| `pnpm verify` | `tsc -b` → core 铁律扫描 → 16 个类型负例 → 17/17 lint 负例 → 72 条 scope / 103 条 agent / 72 条 update 断言 → 其余内核用例（SSE 73 / 迁移 40 / 装配 48 / 调度 42 / 会话仓储 38 + 端口规格 22 / openurl 23 / 上传 56+31 / navigate 131+49+124）→ 鸿蒙判定层 38 例 → 色值 12 条 |
| `pnpm selfcheck` | 启动应用 → 真实上下文探针 → 截图 → 写报告 → 归档到 `docs/evidence/` |
| `pnpm selfcheck:web` | Vite 构建 → 起静态服务 → 无头 Chromium 走 CDP → 页面内跑 136 项断言 → 截图归档 |
| `pnpm pack:win` | electron-builder → NSIS 安装包 + `latest.yml`；**不含 node_modules**，`app.asar` 0.93MB |
| `pnpm verify:update-feed` | 起本地静态 feed → 打包产物以 `CROSSDECK_UPDATE_URL` 指过去 → 跑完检查/下载/就绪 → 按哨兵判定 |
| `pnpm sync:ohos` | 把 `contract` / `core` 源码同步进鸿蒙工程并改写裸包名（`verify:ohos` 会自动带这一步） |
| `pnpm verify:ohos` | 同步源码 → `hvigorw assembleHap` → `hdc install` → 起假上游 + `hdc rport` → `aa start` → 页面自检 → 从 hilog 收割报告并判定 → 截图归档（环境不具备时**如实报 skipped 并非零退出**） |

> **受限环境下跑自检**：若本机 Chromium 沙箱起不来 viz 层（表现为
> `GPU process isn't usable. Goodbye.`，退出码 3），可以显式降级：
> `node packages/shell-electron/scripts/launch.mjs --selfcheck --no-sandbox`。
> 这条只影响自检这一次运行，`dev` / `start` 不受影响。

---

## 验证：凭什么说它是成立的

### 1. 性能量化（`pnpm selfcheck` 的 `perf` 节 → `docs/perf.md`）

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

### 2. 鸿蒙壳端到端（`pnpm verify:ohos`）

这是「同一个 core，换一个壳」这句主张的**另一半证据**。Electron 壳证明得了架构，
但证明不了**可移植** —— 除非真有一个非同族的壳跑起来。

一条命令走完全链路：同步源码 → `hvigorw assembleHap` → `hdc install` →
起假上游 + `hdc rport` → `aa start` → 页面内自检 → 从 hilog 收割报告 → 判定 → 截图归档。

下面是**真实设备（鸿蒙 PC 模拟器，2in1 形态）跑通那一次**的输出（数字每次会变，HAP 体积随页面 bundle 浮动）：

```
✅ 工具链                        DevEco @ D:/software/DevEco Studio
✅ 设备在线                       127.0.0.1:5555（x86_64）
✅ 同步 contract/core             （复制源码 + 改写裸包名）
✅ hvigorw assembleHap        BUILD SUCCESSFUL
✅ HAP 产物                     1042.1 KB
✅ hdc install                install bundle successfully
✅ 假上游已起                     http://127.0.0.1:64003（token 鉴权）
✅ hdc rport                  tcp:64003 → 宿主（设备侧已监听）
✅ aa start（WebView + 自检）     http://127.0.0.1:64003
✅ 桥接 · 端口投递到页面               WebMessagePort 已交付
✅ 截图 · 共享 UI                 186.1 KB → docs/screenshots/ohos-shell-web.jpg
✅ 界面 · 聊天逐字到终态（长度相等）        stage=done len=23（期望 23）
✅ 界面 · 切页签不丢帧                 切走 3 → 切回 13 → 终 23（期望 23）
✅ 界面 · 工作区树渲染出来了             entries=2
✅ 界面 · 游客上传被上游 403 拒          stage=error → FORBIDDEN
✅ 仓储 · 全过                      passed=22/22 failed=0
────────────────────────────────────────────────
✅ 全部通过
```

（中间省略了若干行；完整报告与逐条判定在 `docs/evidence/ohos-selfcheck.json`。）

**页面自检跑的是完整业务链，不是"截个图就算过"**：

1. 登录闸门出现 → 点「获取体验账号」→ 凭据只进端口，不进页面存储
2. 建会话 → 删会话（**再查一次证明真落库**）→ 重建
3. 发一句话 → 逐字到终态（**长度相等**，不是 >0）
4. 流没结束时切走页签再切回来 —— 帧一片都不能丢
5. 工作区树渲染 → 点「试读 ../」→ 界面上必须出现 `SCOPE_DENIED:OUT_OF_SCOPE`
6. 游客身份上传 → 上游必须 403 拒

报告经 `WebMessagePort` **分片**写进 hilog（单条 hilog 有长度上限，不切片会让"结论缺失"
看起来像"探针没跑"），宿主脚本按片拼接、剥掉 `hdc` 的 CRLF、再交给判定层。
仓储一致性的 22 条用例由端口在后台自跑（独立 RDB 库，`[SELFCHECK] repo` 打点）——
不挂进页面 RPC，因为建 22 个库远超一次调用的超时预算。

**两套界面，一条主链**：

- 默认 `--ps ui web`：ArkWeb 承载共享 UI，判定读页面上报的**证据字段**
  （`data-testid` 与探针值），不做坐标点击；
- `--ps ui arkui`（`pnpm verify:ohos:legacy`）：旧的 ArkUI 原生页，靠 `uitest dumpLayout`
  取控件 bounds 再点击 —— 它保留的价值是"没有 WebView 也能自证 core/RDB"。

截图证据在 `docs/screenshots/`。UI 里跑的都是**同一份** core：会话与消息走
core 的 `SessionRepository` 规格 + 本地 RDB 后端，流式来自 `core/agent/runtime` +
`core/events/streamBus`，能力表来自 `shared/ports.ets` 的运行时探测
（`deviceInfo.deviceType` 读出来是 `2in1`，所以 `window.multi` 为 ✅，
「新开一个窗口」的入口才渲染出来 —— 能力探测先于调用，是设计结果而不是降级事故）。

ArkUI 那套页面能在截图里直接读到实测的事件序列：

- 纯流式 —— `start×1 → token×N → done×1`
- 工具链路 —— `start×1 → tool×1 → tool_end×1 → token×N → done×1`

两者都带首帧延迟、总耗时与「合并 0 次」。**具体数值不写进 README** ——
它每次跑都会变，抄进来只会变成过期数字；要看精确值请读截图本身或
`docs/evidence/ohos-selfcheck.json`。

设计点：

1. **六种"跑不了"被严格区分，且都返回非零**：工具链缺失（`toolchain-missing`）/
   派生子进程被拒（`spawn-blocked`）/ 设备不在线（`no-device`）/ core 产物缺失
   （`core-dist-missing`）/ 端口映射失败（`rport-failed`）/ 页面 bundle 缺失
   （`ohos-bundle-missing`）—— 报告里落成 `skipped` 而不是 `ok`。这和 Electron 侧
   "未打包形态必须报 `error` 而不是永远转圈"是同一条原则：
   **环境不具备时如实说，不假装成功**。失去鸿蒙环境的机器上跑它也不会给出假绿。

   ⚠️ **中间那两条必须分开**：受限会话里 `hdc list targets` 自己也会 `EBUSY`，
   不区分就会把**环境问题**报成**设备问题** —— 排查方向当场就错。
   （本仓库的受限会话里跑它：停在设备探测那一步，exit 2、`skipped: 'spawn-blocked'`。）

2. **判定必须落在脚本里，不能由被测应用自己宣布。** 应用只上报**证据字段**
   （页面报告的 JSON 分片 + `[SELFCHECK] repo` 数字行），成败由宿主脚本判。
   判定逻辑抽成纯函数（`parse-ohos-selfcheck.mjs` 的三个入口：
   `judgeSelfcheck` / `judgeRepo` / `judgeUiPage`），因为真机上够不着它的时候
   还得能验它 —— `pnpm verify:ohos-judge` 用**合成行**驱动它做变异测试，
   不需要设备、不派生进程：

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

   上表是判定层最早的 13 发变异；接入页面报告后又加了 U0–U14 与 Q1–Q8，
   现在共 **38 例**（含 3 条**反向**：把承重断言拿掉后，对应的坏输入必须变得
   **杀不掉**）—— 全部符合预期。反向那几条是必要的：只证明"改坏输入会挂"还不够，
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

4. **（ArkUI 兜底链）点击坐标也错过，而且错得更隐蔽。** 第一版按截图像素估坐标，点空；
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

### 3. 同一份 core，两个上游实现

这一节先说清定位，再讲接线。**crossdeck 不是"navigate 的桌面客户端"** ——
那会把它讲成又一个聊天壳，而它真正要示范的是**跨端桌面工程**：
**同一份 core，两个上游实现**。

「上游」在这里是**业务内容**，不是架构的主角：脚本上游（离线的 `ScriptedModel`）
与 navigate 上游（HTTP + SSE）可以互换，换掉它，**三个壳与 core 一行都不用改**。
下面这张表就是这句话的展开。

#### 3.1 为什么自检之外还要接真实上游

脚本上游能证明"壳会不会把事件正确转发出去"，证明不了 HTTP/SSE 这一层 ——
而端侧真正会出事的地方恰好都在那儿：

| 只在真上游下才会暴露的 | 症状 |
|---|---|
| 首字节迟迟不来 | 界面**永远转圈**（没有首帧超时的话） |
| `decode(bytes, { stream: true })` 漏了 `stream` | 偶发**乱码**（按字节边界切坏多字节字符） |
| Web 壳掉了 `credentials: 'same-origin'` | 本地 Node 测不出来，线上**每次 401** |
| 上游提前关流 / socket 被销毁 | 两种**不同**的失败路径，合成一条就漏一个 |
| `cancel()` 只"不再读"而没真断连 | 上游继续跑，账单继续烧 |

#### 3.2 三端各自的 IO 实现（这是差异，不是重复）

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

#### 3.3 能力探测怎么降级

core 用 `capabilities.has('x')` 分支，**不写** `if (platform === 'electron')` ——
后者会让第三端变成一串 `else`。`Platform` 只用于日志诊断。

| 能力 | Electron | Web | 鸿蒙 PC（2in1） | 没有时的 UI 行为 |
|---|---|---|---|---|
| `fs.scope` | ✅ | ✅（OPFS；没有 `navigator.storage.getDirectory` 就没有） | ✅ | 没有就不渲染文件树 |
| `notify.system` | ✅ | ✅（`typeof Notification !== 'undefined'` 才有） | ✅ | 没有就不渲染通知开关 |
| `window.multi` | ✅ | ❌ | ✅（`deviceType = 2in1` 才有；phone / tablet 形态会如实缺席） | 多窗口那块显示 `—` |
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

#### 3.4 离线脚本上游的定位

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
│  │  Web 壳   │  │ Electron 壳   │  │ 鸿蒙 PC 壳       │  │
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
      session.ts         #   会话 / 消息 / 事件实体（排序只认 seq）
      portFrame.ts       #   跨壳端口帧（版本号 + 错误信封），页面与 ArkTS 两侧对偶
  core/                  # 平台无关内核（铁律：不得 import 任何平台 API）
    src/
      ports.ts           #   CapabilityPort 接口定义（含 FsPort）
      session/store.ts   #   SessionStore（时钟与 id 均注入）
      session/repository.ts # 会话仓储端口（Awaitable：SQLite 同步 / IndexedDB 异步）
      session/repositoryConformance.ts # 22 条可执行规格（端侧各实现都跑同一份）
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
      net/               #   SSE 解析 / navigate 鉴权 / 上传 / 外链白名单（字节→文本以下的判据）
  ui/                    # ★ 三端共用的渲染层（React 19 + Tailwind + Redux Toolkit）
    src/index.ts         #   对外唯一出口：mountApp({ bridge })
    src/mount.tsx        #   注入桥 → 取登录态 → 接流 → 挂载到 #root
    src/bridge.ts        #   桥的注入点（setBridge / requireBridge）—— 它不认 window.bridge
    src/api.ts           #   全部通道调用都经这里，返回类型由 IpcInvokeMap 推导
    src/App.tsx          #   主界面（会话列表 / 聊天 / 工作区文件树 / 更新卡片）
    src/pages/           #   登录 / 简历问答 / 输出 / markdown 渲染
    src/store/           #   Redux 切片：只放客户端 UI 状态
    src/styles.css       #   @theme static 里是色值唯一真源
    src/selfcheck/probeUi.ts # 页面内自检探针（三端共用；壳只提供端口桩与驱动）
    tsconfig.json        #   lib=ES2022+DOM + types=[] —— 铁律的机制本身
  shell-web/             #   ★ 试金石：同一份 core 跑在浏览器里
    src/ports.ts         #     OPFS 实现（无 symlink → 逃逸检测退化为纯字符串）
    src/selfcheck.ts     #     页面自检的驱动壳（探针在 @crossdeck/ui，136 项断言）
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
    src/renderer/        #   只剩入口：main.tsx 把 window.bridge 交给 @crossdeck/ui
    scripts/launch.mjs   #   启动器：清 ELECTRON_RUN_AS_NODE + 自检收尾（强杀进程树）
    tsconfig.main.json   #   lib=ES2022 + types=[node]（没有 DOM）
    tsconfig.renderer.json #  lib=ES2022+DOM + types=[]（没有 node）；只覆盖入口与 window 声明
  shell-ohos/            #   鸿蒙壳（DevEco 工程 + 页面 bundle，见下「两份清单，一个目录」）
    entry/src/main/ets/
      pages/WebShell.ets #     ArkWeb 容器页（默认）：注册 proxy → 投递端口 → 回 rawfile
      pages/Index.ets    #     旧 ArkUI 原生页（--ps ui arkui）：没有 WebView 时的兜底
      host/AppHost.ets   #     9 个端口的装配 + 推送广播到全部窗口
      host/HostBridge.ets#     帧编解码 + 端口派发（与页面 rpc.ts 对偶）
      host/ports/        #     session / agent / navigate / workspace / document / shell / 三个小端口
      navigate/          #     createOhosNavigateClient（http 模块 + SSE 解码）
      session/           #     RdbSessionRepo（关系型存储）+ 一致性自跑 harness
      shared/ports.ets   #     CapabilityPort 的第三份实现（@ohos.* 探测）
      shared/probe/      #     M6-0 的五层探针（spike 的活证据）
      shared/contract/   #     ← 由 scripts/sync-shared.mjs 生成，勿手改（不进版本库）
      shared/core/       #     ← 同上（contract 与 core 的源码副本）
    src/                 #   页面侧：bridge / rpc / 自检入口（Vite 打包进 rawfile）
    src-stub/            #   端口桩：浏览器里跑同一份页面代码（selfcheck:ohos-bundle）
    scripts/sync-shared.mjs  # 把 contract/core 源码搬进工程 + 改写裸包名
    scripts/verify-ohos.mjs  # 同步 → 编译 → 装 → 起假上游 → 自检 → 收割 → 判定 → 截图
    scripts/verify-ohos-bundle.mjs # 页面 bundle 与桩产物的证伪（含空壳反例）
    scripts/verify-ohos-judge.mjs  # 判定层的变异测试（38 例，不需设备）
    spike/ets-rejects-conditional-types.ets.txt # M6-0 的反例留档
scripts/
  verify-type-alignment.mjs  # 16 个类型负例（main / ui / web 三个 tsconfig 项目各覆盖到）
  verify-lint-boundaries.mjs # 17 个 lint 负例 + 5 个必须沉默的正例
  verify-core-purity.mjs     # core 铁律扫描（CI 层）
  verify-core-scope.mjs      # PathGuard / WorkspaceStore 的 72 条断言（加载 core 编译产物）
  verify-core-agent.mjs      # 事件总线 / 背压 / 工具链路的 103 条断言（假调度器，0ms 真实等待）
  archive-selfcheck.mjs      # Electron 自检证据归档
docs/evidence/               # 自检报告与截图（可核验产物）
```

`packages/shell-ohos` **两份清单，一个目录**：

- `oh-package.json5` —— DevEco 工程的清单，依赖走 `ohpm`，出的是 HAP；
- `package.json` —— 页面 bundle 的清单（Vite + React），依赖走 npm，产物是
  `entry/src/main/resources/rawfile/app/`（**不入库**，见 `.gitignore`）。

第二份是 P3 才加的：共享 UI 要装进 ArkWeb，就得有一个能被 Vite 打的入口。
它同时让 `shell-ohos` 成为 pnpm workspace 成员（`pnpm --filter @crossdeck/shell-ohos build:web`），
但**只负责页面 bundle**，不参与 HAP 构建 —— HAP 仍然只认 `hvigorw`。

由此产生**两份产物、一份源码**：`shared/core` 是给 ArkTS VM 编译的 `.ts` 副本，
`rawfile/app/*.js` 是 core 被 Vite 打进 WebView 的第二份编译结果。
`verify:shared-fresh` 只管前者的漂移；后者由 `verify:ohos-bundle` 用
"必须含有 UI 锚点/协议字面量"来证伪 —— 否则 `emptyOutDir` 产出一个空壳也算"构建成功"。

`shared/contract/` 与 `shared/core/` **不进版本库**（见 `.gitignore`）：
它们是 `pnpm sync:ohos` 的产物，事实源是 `packages/contract` 与 `packages/core`。
提交副本 = 版本库里同时躺着两份源码，而漂移是静默的 ——
在 core 里修好的 bug，鸿蒙壳会继续跑旧版本。
代价是：**clone 之后第一次用 DevEco 打开工程前，先跑一次 `pnpm sync:ohos`**，
否则 IDE 会对那些 import 报找不到模块（`pnpm verify:ohos` 会自动带上这一步）。

---

## 技术栈

TypeScript（strict，含 `exactOptionalPropertyTypes`）· pnpm workspace · Electron 44 ·
React 19 · Vite 8 · Tailwind 4 · esbuild · Node 20+ ·
ArkTS / DevEco（鸿蒙壳，`hvigor` + `hdc`，非 npm 生态）
