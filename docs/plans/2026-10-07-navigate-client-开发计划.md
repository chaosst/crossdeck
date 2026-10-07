# navigate 客户端接入 — 任务分解（派工单）

> **这份文档不含接口契约。** 契约由两样东西定义，而且都是可执行产物：
> ① T3 抓到的 **navigate 真实 SSE 原始帧**（`docs/evidence/navigate-sse/`）；
> ② T4 / T5 的**测试用例清单**（负例优先）。
> 谁对实现有疑问，去看这两样，不要问"接口长什么样"—— 那说明这两样没做扎实。

---

## 0. 范围

### 做
- 把 `crossdeck` 变成一个**能连真实 navigate 上游**的流式问答客户端。
- 上游只有一个端点：`POST /api/resume/chat`。
- 三个壳都接：Electron / Web / HarmonyOS。

### 不做（本期非目标，别顺手做）
- 不接 `/api/agent/plan`（要 admin key，且 `answer` 是整段非流式）。
- 不接 `/api/rag/ask`（事件形状是另一套 `ParallelEvent`）。
- 不做鸿蒙的 `FsPort`（本期不需要文件系统 —— 这条是白捡的，见 §4 T7 备注）。
- 不做"本地会话列表 ↔ navigate 服务端历史"的同步（见下方⚠️）。
- 不做账号密码 + 校验码登录（推到第二阶段 T11）。
- 不做 mac / linux 产物。

### ⚠️ 两条必须如实标注、不许装作没有的事实

1. **会话模型对不上。** navigate 侧 `Token IS the sessionId`（同一 token 共享同一段聊天历史），
   而 crossdeck 的 `SessionStore` 是**本地**的会话列表。两者不是一回事。
   本期做法：本地会话列表只当 UI 分组，**不与服务端历史同步**；
   UI 上要么不显示"会话历史"，要么明确标注"本地分组"。
   **不要**假装它们是同一份数据 —— 那会让 `session:delete` 看起来该删服务端却只删了本地。
2. **`Usage` 里的 token 不是 token。** 现有 `promptTokens = input.length`、
   `completionTokens = acceptedChars`，单位是**字符数**。而 `/api/resume/chat` 的 SSE
   **不返回任何 usage**。所以界面上的字段标签必须改成"字符数"，不能写 "tokens"。
   （又一个"看着正常的错数字"。）

---

## 1. 已定决策（不要再讨论，除非 T1 结论推翻它）

| 决策 | 结论 | 理由 |
|---|---|---|
| 上游端点 | 只接 `/api/resume/chat` | 权限最低（`requireToken`）、真逐 token 流 |
| 壳范围 | 三端全做 | 用户裁决 |
| 认证 | 应用内登录，**guest 优先** | `POST /api/login/guest` 免密、无校验码 |
| 端口形状 | **回调式**，不是 `AsyncIterable` | `contract` 已有 `FsPort.watch` / `StreamBus.subscribe` 两个同形状先例且都过了 ArkTS；`AsyncIterable` 在 contract 里**零先例** |
| 纯逻辑归属 | SSE 帧解析 + 事件映射**放 core**，IO 放壳 | 与 `posixPath.ts` / `resolveInWorkspace.ts` 同一条理由：逻辑只能有一份 |
| 离线模式 | 保留 `ScriptedModel` 作为"无上游时的确定性上游" | 自检必须能离线跑；但要**在 UI 上如实标明**当前是脚本上游 |

---

## 2. 全局规矩（照既有约定，别另起一套）

- **TDD 红绿双测**：先写断言确认它挂（红），再改实现让它过（绿）。第一次就全绿 = 没测到东西。
- **新写的断言要做变异测试**，并在脚本头部如实记录结果（含"某条变异存活 0 条"这种坏消息）。
- **零依赖、无子进程**。本机沙箱下 Node 用 pipe 派生子进程**必 EBUSY** ——
  所以任何"假上游服务器"必须在**被测进程内**用 `node:http` 起，不要 spawn。
- **不达标就如实写**，改口径必须在文档里写理由与代价（不许把标尺挪一挪）。
- **判定挂哨兵**，不挂"进程能不能退出"（`[selfcheck] DONE ok=… code=…` → `launch.mjs` 强杀进程树）。
- **断言事件序列就在真实订阅点收全量**，不要轮询采样（会漏帧，产生假阴性）。
- 每张任务卡**独立 commit**，conventional commits + 中文描述：
  `feat(core): T6 — AgentRuntime 改为回调驱动，补上游断流兜底终态`
  scope 只用 `core` / `contract` / `shell-electron` / `shell-web` / `shell-ohos` / `scripts` / `docs` / `plan`。
- 改完 `packages/core/src/index.ts` 之前，先确认没有 `verify:ipc` / `verify:lint` 在跑
  （它们会往那个文件末尾追加违规代码再还原）。

---

## 3. 依赖图与轮次

```
轮0（spike，阻塞一切）        T1 端口形状 ──┐
                             T2 鸿蒙可达性  │
                             T3 真帧语料  ──┴─▶ 全部结论 review 通过才能进轮1
轮1（core 纯逻辑，可离线）    T4 SSE 解析 ──▶ T5 事件映射
轮2（core 运行时，最大风险）  T6-a 端口 ──▶ T6-b runtime ──▶ T6-c 断言重写
轮3（壳 IO，三份）           T7 Electron ──▶ T8 Web ──▶ T9 鸿蒙
轮4（认证）                  T10 配置+guest 登录 ──▶ T11 账号+校验码（可延后）
轮5（自检 + 文档）           T12 Electron 自检 ──▶ T13 Web ──▶ T14 鸿蒙 ──▶ T15 文档
```

**可并行**：T2 与 T3 无依赖，可同时做。T8 / T9 在 T7 跑通后可以并行。

**轮次之间必须停下 review。** checkpoint 要交什么见 §5。

---

## 4. 任务卡

### T1 · ArkTS 端口形状 spike（阻塞 T6-a）

**前置**：无。这是第一件事。

**做什么**
1. 在 `packages/shell-ohos/spike/` 下加探针（沿用该目录既有的"反例留档"惯例）。
   探针里放**两组**形状，各自一个实现类：
   - A 组：回调式 —— 一个 sink 接口带三个无返回值回调（数据 / 结束 / 错误），
     加一个 `stream(req, sink)` 返回"取消函数"的方法。实现里**真的调用**三次回调。
   - B 组（对照组）：异步可迭代 —— `stream()` 返回 `AsyncIterable<string>`，
     实现用 `async function*`，外面写一个 `for await` 消费点。
2. 在 `pages/Index.ets`（或临时页）里 **import 并真的调用**这两组。
   ⚠️ 只 import 不调用，泛型可能不被实例化，**编译器不会真的检查**。
3. `pnpm verify:ohos`（或直接 `hvigorw assembleHap`）看结果。

**完成判据**
- 结论明确写出：A 组 ✅/❌、B 组 ✅/❌，**附原始编译器报错文本**（若为 ❌）。
- **反向断言（必须有）**：往探针里塞一个已知非法调用（例如给数据回调传 `number`，
  或按 M6-0 的老办法给 `Platform` 赋 `'not-a-real-platform'`），
  确认编译器**报错** —— 当面对 A 组"不报错"时，这一步才证明"它真的在被 type-check"。

**决策规则（写进结论里）**
- A ✅ → 用回调式（本轮默认，理由见 §1）。
- A ❌ / B ✅ → 改用异步可迭代，**并立刻重新评估 T4-T6**（core 侧形状要跟着换）。
- 都 ❌ → 停下来找 lead，不要自己发明第三种形状。

**坑**
- 探针文件必须是 **`.ts`**，不能是 `.ets` —— `.ets` 走 ArkTS 受限规则，会凭空多出
  `arkts-no-conditional-types` 一类报错（M6-0 已实测，反例就在同一目录）。
- 探针要放进 `entry/src/main/ets/` 下才能被 hvigor 编进去。

**交付物**：`packages/shell-ohos/spike/` 下探针 + 结论文件；结论同步给 lead。

> **✅ 已完成 2026-10-07** → 结论：`packages/shell-ohos/spike/T1-port-shape.md`
> 摘要：**A 回调式 ✅ / B AsyncIterable ✅（两者都过）**；反向断言（onChunk 传 number）
> 确实报错 → 证明编译器真在 type-check。**决策不变：用回调式**。
> 提交 `8a361cf`。

---

### T2 · 鸿蒙模拟器 → 宿主机网络可达性 spike

**前置**：无（可与 T3 并行）。

**为什么必须做**：这条不通，鸿蒙端的**演示**就是零。而且它决定 T9 怎么写、T14 怎么验。

**做什么**
1. 宿主机起一个最小 server（**不要用 navigate 本身**，避免上游变量干扰）：
   监听 `:3001`，任意路径返回 `pong`。
2. **先不加权限跑一次**：在鸿蒙侧用 `@ohos.net.http` 请求，**记录报错文本**。
   （这是"权限确实必需"的反向证据。）
3. 在 `entry/src/main/module.json5` 加 `requestPermissions`（`ohos.permission.INTERNET`），
   然后依次试这三种，每种都记成败 + 原始日志：
   - a. `http://127.0.0.1:3001/ping`
   - b. `http://<宿主机局域网 IP>:3001/ping`
   - c. 先做反向端口转发（`hdc rport`，具体子命令以 `hdc -h` 为准）再试 a
4. 顺带记录：明文 `http://` 有没有被平台策略拦（等价 Android cleartext 限制）。

**完成判据**
- 表格化输出：三种方式各自 ✅/❌ + 原始日志；并**明确写"演示时用哪一种"**。
- 附"不加 INTERNET 权限时的报错文本"。
- 若 b 失败，先查 Windows 防火墙入站规则再下结论（默认拦入站是最常见原因）。

**坑**
- Android 是 `10.0.2.2` 映射宿主机，**鸿蒙不一定有等价物** —— 别照搬结论。
- `module.json5` 目前**一条 `requestPermissions` 都没有**（我读过），别以为已经配好了。

**交付物**：结论小节（放 T9 任务卡前面）+ 关键日志。
**顺带产出**：`module.json5` 的权限改动可以在这张卡里就提交（单独 commit）。

> **✅ 已完成 2026-10-07** → 结论：`packages/shell-ohos/spike/T2-emulator-to-host-network.md`
> 摘要：**没有 `10.0.2.2` 等价映射** —— `127.0.0.1`/`localhost` 不通（`2300007`），
> 必须用**宿主机局域网 IP**，或先 `hdc rport` 再走 loopback（两者都实测 ✅）。
> 无权限时统一 `code=201 Permission denied`。明文 `http://` **没被拦**。
> 反向断言（关掉宿主 server）三处全 ❌ 且失败码可区分 → ✅ 非假绿。
> → **T9 的地址要可配置**，`verify-ohos.mjs` 要自动建 rport。
> 提交 `8a361cf` + `71cc867`（INTERNET 权限）。

---

### T3 · navigate 真实 SSE 语料抓取

**前置**：本地 navigate 能起来（`:3001`）。

**为什么必须做**：这是**契约的替代品**。没有真帧，T4/T5 就是对着源码猜 —— 而源码告诉你的事
比你想的少（比如你可能以为 `tool` 事件在 resume/chat 上会出现，实际不会）。

**做什么**
1. 起本地 navigate。用 `POST /api/login/guest` 拿 token（免密，返回 `{token, role, expiresIn}`）。
2. 用 `curl -N`（**`-N` 必须有**，否则会缓冲到流结束才吐）打 `/api/resume/chat`，
   把 **原始字节**存下来。至少抓两类输入：
   - 普通提问（预期只有 `token…` + `done`）
   - 会触发检索的提问（预期有 `sources`）
3. 落盘到 `docs/evidence/navigate-sse/`：
   - `resume-chat-raw.txt`（原始帧，**不要手工整理成漂亮格式** —— 要的就是原样）
   - `resume-chat-meta.json`（完整请求命令 / 响应头 / 时间 / 用的哪份 token）
4. **核对帧顺序**并记录：是否就是 `token… → sources → done`？
   有没有出现 `event:` 名不在我预期里的东西？

**完成判据**
- ≥ 2 份原始样本落盘，且**样本里能看到 `done`**。
- 帧顺序结论写出来（跟源码读出来的对照：一致 / 不一致）。
- 如果实际出现了源码里没预期的 event 名 → **立刻告诉 lead**，那会改 T5 的映射表。

**坑**
- `/api/resume/chat` 依赖 resume 索引已加载，否则 **503**（`resume.md` / `resume.docx` 缺失会这样）。
  遇到 503 先解决这个，不要以为是鉴权问题。
- 别把 token 明文写进 `docs/evidence/`（那是进版本库的）→ meta 里只记前 8 位 + 长度。

**交付物**：`docs/evidence/navigate-sse/` 两份文件 + 帧顺序结论。

---

### T4 · core：SSE 文本帧解析器（TDD）

**前置**：T1（形状结论）、T3（真帧语料）。

**位置**：`packages/core/src/net/sse.ts`（新目录，记得在 `core/src/index.ts` 导出）。

**关键设计决策（写进文件头注释，防止后人改回"更自然的写法"）**
- **只吃 string，不吃 `Uint8Array`。** 字节解码要用 `TextDecoder`，而 core 的 `lib` 只有 ES2022
  —— 拿不到。**解码放壳侧**，core 只做"文本 → 帧"。
  这条必须写清，否则第一个图省事的人会塞进来一个 `TextDecoder`，把 `verify:core-purity`
  搞得看起来像误报。
- **增量式**：能喂任意切片。提供"喂一块"和"收尾"两个入口。
- **末尾残帧不吐。** 没有终结分隔符的半截帧必须留在缓冲里，不能当帧发出去。
  这是防"半截 JSON 被当帧"的关键。
- 缺 `event:` 时事件名按 SSE 规范取默认值 `message`。
- 多行 `data:` 按规范用换行拼接。
- `:` 开头的行是注释（心跳常见），忽略但可以计数（用于诊断）。

**测试用例清单（照着写，≥ 20 条，写进一个新建的验证脚本）**
验证脚本：`scripts/verify-core-sse.mjs`，**加载 `packages/core/dist/index.js` 编译产物**
（与 `verify-core-scope.mjs` 同法，零依赖、无测试框架）。
在 `package.json` 加 `verify:sse`，并把它插进 `verify` 链（建议放 `verify:scope` 之后）。

| # | 用例 |
|---|---|
| 1 | 单帧完整 |
| 2 | 一个 chunk 里含 3 帧 → 按序全出 |
| 3 | 切成 2 片：切在 `\n\n` 前后 / 切在 `data:` 中间 / 切在 `event:` 中间 |
| 4 | **切成 1 字符一片** → 结果必须与用例 1 完全相同（最狠的边界） |
| 5 | `\r\n` 分隔 |
| 6 | `\r\n` 与 `\n` 混用 |
| 7 | 多行 `data:` → 用 `\n` 拼接（断言拼出来的确切字符串） |
| 8 | `event:` 写在 `data:` **之后** → 顺序无关 |
| 9 | 无 `event:` → 默认 `message` |
| 10 | 空 `data:` 行 |
| 11 | `:` 注释行 → 不产出帧 |
| 12 | 末尾残帧（无 `\n\n`）→ **不吐**；收尾时能报出"有未完成残帧" |
| 13 | 连续多个空行 |
| 14 | `data:x` 与 `data: x`（规范只剥**一个**前导空格）→ 断言两种结果 |
| 15 | 中文字符整体喂 / 被切成多片喂 → 结果一致（证明 string 层不破坏内容） |

**必须做的变异测试（先在脚本头记下"期望挂几条"，再实测）**
- 把"残帧不吐"改成"吐" → 用例 12 应挂。
- 多行 `data` 从"追加"改成"覆盖" → 用例 7 应挂。
- 去掉 `\r\n` 处理 → 用例 5/6 应挂。
如果某个变异**一条都没挂**，说明对应用例没有鉴别力 → 重写用例，别放过。

**坑**
- 别在 core 里引入任何 node/DOM 全局。跑 `pnpm verify:core-purity` + `pnpm lint` 双重确认。

**交付物**：`packages/core/src/net/sse.ts` + `scripts/verify-core-sse.mjs` + `package.json` 脚本。

---

### T5 · core：navigate 事件 → 语义动作映射

**前置**：T4。

**位置**：`packages/core/src/net/navigate.ts`。

**做什么**：把 T4 的 frame 映射成"语义动作"（文本块 / 引用来源 / 结束 / 错误 / 未知）。
**不要**在这里生成 UI 事件 —— 保持 core 与 UI 语义解耦。

**映射表（以 T3 抓到的真帧为准；下表是基线，不一致时以真帧为准并回报 lead）**

| SSE frame | 动作 |
|---|---|
| `event: token`，data 是 **JSON 编码的字符串** | 文本块（解 JSON 取字符串） |
| `event: sources`，data 是 JSON 数组 | 引用来源（**不拼进正文**） |
| `event: done`，data 是**裸字面量 `__DONE__``** | 结束 |
| `event: error`，data 是 JSON 字符串 | 错误 |
| 未知 `event` 名 | **上报**，不许静默丢 |

**三个必须写进任务的坑（每个配一个负例）**
1. **`token` 的 data 是 JSON，`done` 的 data 不是 JSON。**
   服务端 `token` 是 `JSON.stringify(text)`，而 `done` 写的是字面量 `__DONE__`。
   用一把梭的 `JSON.parse` 会在 `done` 上抛 → **必须按 event 名分支**。
   负例：喂一个 `done` 帧，断言映射器**不抛**且产出"结束"。
2. **`JSON.parse` 失败不能抛。** token 解不出来 → 当原文用（服务端可能改格式）。
   负例：喂一个非法 JSON 的 token 帧，断言产出原文文本块而不是异常/丢帧。
3. **未知 event 不许静默丢。** 否则服务端加新事件时前端静默失效。
   负例：喂 `event: thinking`，断言产出了"未知"动作。
   变异测试：把它改成静默丢弃 → 对应断言应挂。

**完成判据**：断言并入 `verify-core-sse.mjs`（同一个脚本，分段输出），覆盖上表 5 行 + 3 个坑；
变异测试结果写进脚本头。

**交付物**：`packages/core/src/net/navigate.ts` + 脚本增量。

---

### T6 · core：端口 + 运行时改造（**本期最大风险**）

拆三个小步，**各自独立 commit**，不要一次提交。

#### T6-a · 端口定义
- 改成**回调式**端口（形状以 T1 结论为准）：一个 sink 带三个回调（数据 / 结束 / 错误），
  `stream(req, sink)` 返回取消函数。
- **保留** `ScriptedModel` 并让它实现这个新端口 —— 这样自检在无网络时仍可跑。
  这件事要在注释里写清定位：**它不是"假实现"，是"无网络时的确定性上游"**，
  与项目"不装假实现"的原则不冲突 —— 但**必须如实标注**（UI 上显示当前是脚本上游）。

#### T6-b · 运行时改造（`AgentRuntime.#drive`）
从"等整段再 push"改成回调驱动。要点：
- 上游给数据 → **立刻**喂进背压泵。**严禁攒到最后一次性喂** —— 攒了就退回"合成流"，
  这次的活儿就白干了。这条要写进注释。
- 上游说结束 → 关闭上游。**顺序不能反**（现有代码里已有这条注释，别改反）。
- 上游报错 → **恰好一个** error 终态。
- **断流兜底（必须单独设计，不是顺手加）**：上游既没说结束也没报错就断了
  → 仍然必须收尾出一个终态。
  为什么必须有：navigate 的 `/api/rag/ask` **根本不发 done**；本期虽只接 `resume/chat`，
  但契约上要防。否则失败模式是"token 全到齐、UI 永远转圈"。
- abort → **真的调用**上游返回的取消函数（且要能断言它被调用过）。
- 终态之后上游还回调 → 计入既有的 `droppedAfterTerminal`（应当恒为 0）。

#### T6-c · 断言重写 + 新增
- **先红**：新增 4 条断言，确认它们挂：
  1. 逐帧顺序（上游分 3 次给数据 → 渲染侧按序收到，不是一次到齐）
  2. 上游中途报错 → **恰好一个** error 终态
  3. 上游**不发结束**就断 → 仍然收尾（一个终态）
  4. abort 后上游的取消函数**被调用**（用计数探针）
- **后绿**：改实现让它们过。
- **回归**：`scripts/verify-core-agent.mjs` 原 **83 条**里依赖"泵滴流"的断言
  **重写而不是删除**，重写后**总数只增不减**。这是本期最大的一块成本，别低估。
- **变异测试（必须做，至少这两条）**：
  - 去掉断流兜底 → 断言 3 应挂。
  - 把"逐块喂"改成"攒全文一次喂" → 断言 1 应挂。
    ⚠️ 这条最关键：它证明"真流式"这件事真的被测住了。
- **如实记录**：`#settle` 的重复终结保护在改造后**是否变可达**？
  变可达 → 补一条能打到它的断言；仍不可达 → 继续如实写在脚本头部（不许假装测到了）。

**交付物**：`core/src/agent/{model,runtime}.ts` + `scripts/verify-core-agent.mjs`。

---

### T7 · Electron 壳：navigate IO 实现（先做，最快见效）

**前置**：T6-c 绿。

**位置**：`packages/shell-electron/src/main/navigate/`（客户端 + token 存储）。

**做什么**
1. 在 **main** 进程发请求（不是 renderer）。
   - 主进程是 Node 环境，通常有全局 `fetch`；**若发现没有**，改用 Electron 的 `net` 模块。
   - 读响应体是流式读 → **在这里**用 `TextDecoder` 解码 → 喂 T4 解析器 → T5 映射 → sink。
     `TextDecoder` 出现在这一层是**正确的**（core 不许有），别往下挪。
2. token 存储：用 `safeStorage` 加密后落盘到 userData。
   ⚠️ `safeStorage.isEncryptionAvailable()` 在受限会话下可能是 `false`
   → 必须有**如实的降级路径**，并在 UI 上标明"凭据未加密存储"。
   **不许**静默退化成明文还装作正常。
3. 超时 / 重连策略（要定，不接受"没想过"）：
   - 首帧超时（建议 15s）→ 报错，**不要**无限等。
   - **不做自动重试**：问答场景自动重试会产生重复内容且用户无从察觉。
     连接断掉就是断掉，如实报错。

**完成判据**
- `pnpm dev` 连本地 navigate，发一句 → 肉眼看到**逐帧到达**（不是一次性到齐）。
  这里要留证据：把每帧到达的时间戳记进日志或自检报告。
- 把 navigate 关掉再发一句 → **一个 error 终态**，不是永远转圈。
- 点"停止" → 日志里能看到上游取消函数被调用。
- `pnpm verify` 全绿。

**坑**
- 环境里可能有 `ELECTRON_RUN_AS_NODE=1` → 别绕过 `scripts/launch.mjs`。
- 别把 token 传给 renderer —— renderer 是 sandbox，它只需要知道"已登录/未登录"。

**交付物**：`shell-electron/src/main/navigate/*` + 接线改动。

---

### T8 · Web 壳：navigate IO 实现

**前置**：T7 跑通；**且先定同源部署方式**（见下）。

**前置决策（必须先定，否则做不了）**
浏览器直连 navigate 会同时撞两关：CORS（navigate 未设 CORS 头）+ cookie
（`SameSite=Lax` + 线上 `secure=true`，跨站不会带）。
两条路：
- **A（建议）同源部署**：把 Web 壳产物放进 navigate 的 `public/`，或由 Caddy 同域反代。
  代价：**不动服务端**。
- B 跨域：要给 navigate 加 CORS + `Access-Control-Allow-Credentials`，
  cookie 改 `SameSite=None; Secure`。代价：**改服务端配置**，且 `None` 必须 `Secure`。

选 A 就先做部署验证（能拿到 index.html 且登录 cookie 生效），再写代码。

**做什么**：浏览器 `fetch` + `ReadableStream` + `TextDecoder` → 喂 core 解析器 → sink。
`shell-web/tsconfig.json` 的 lib 已经是 `DOM + DOM.AsyncIterable`，`ReadableStream` 在 DOM lib 里，可用。

**完成判据**：`pnpm selfcheck:web` 增量断言全绿；真连 navigate 可见逐帧。

**坑**
- 认证：**走同源 httpOnly cookie**，**不要**自己存 localStorage（那是给 XSS 送礼）。
- 如果选 A，注意 `selfcheck:web` 起的是 `127.0.0.1` 静态服务 ——
  同源需要它和 navigate 同 host:port，得用反代把两者拼到一起。

---

### T9 · 鸿蒙壳：navigate IO 实现

**前置**：T2 结论。

**做什么**
1. `module.json5` 加 `ohos.permission.INTERNET`（T2 会证明必需）。
2. 用 `@ohos.net.http` 的 `requestInStream` + `dataReceive` 事件收增量数据
   → 喂 core 解析器。**这里正好验证回调式端口的价值**：`dataReceive` 本来就是回调，
   不需要异步迭代。
   （API 细节以你本地 SDK 文档为准，API 版本间有差异。）
3. token 存 `@ohos.data.preferences`。
4. 明文策略按 T2 结论处理（配 `network_config` 白名单 / 或让 navigate 走 Caddy https）。

**完成判据**：`pnpm verify:ohos` 全链路通过，截图里能看到**逐字流**
（照现有 `ohos-shell-stream.jpg` 的做法，不要只截静态首屏）。

**备注（范围红利，值得写进 README）**
本期不需要 `fs.scope` → 文件树整块用能力探测隐藏 → **鸿蒙壳那个"有能力探测、
没有 `FsPort` 实现"的缺口本次不会暴露**。所以鸿蒙侧先做网络端口、后做文件端口，
顺序是合理的。

**坑**
- 鸿蒙壳不是 pnpm workspace 成员，别走 `--filter`。
- clone 后第一次开 DevEco 前要先 `pnpm sync:ohos`。

---

### T10 · 配置通道 + guest 登录

**前置**：T7。

**这一张卡是唯一需要新增 IPC 通道的地方。** 粗略需要：
设置上游地址 / guest 登录 / 查询登录状态 / 登出。
（通道名自己定，但必须走 `contract/src/ipc.ts` 的唯一事实源 —— 三处都从那里取，写错字要编译报错。）

**做什么**
1. 新增通道 + `IpcInvokeMap` 条目 + main handler。preload **不用改**（它是泛型白名单）。
2. guest 登录打 `POST /api/login/guest` → 拿 `{token, role, expiresIn}`。
   若顺带接 `GET /api/chat/history` 恢复上次会话，**只读展示、不写入本地 SessionStore**
   （两套模型别混，见 §0⚠️）。
3. **错误必须能区分**（项目既有做法）：
   - `503` = 服务端没配 guest 账号 → 文案是"服务端未启用体验账号"，不是"登录失败"。
   - `429` = 限流，带 `Retry-After` → UI 显示"稍后重试"，别显示"密码错误"。
4. 前端 API 层加对应函数（`renderer/api.ts`），照现有风格不做类型断言。

**完成判据**
- 自检断言：`503` 与 `429` 能被**区分**出来（不是笼统压成 `INTERNAL`）。
- 登出后 token 不再可用（反向断言）。
- `pnpm verify` 全绿（含 13 条 IPC 负例；新增通道后要确认负例仍然全挂得住）。

**坑**
- 改 `packages/core/src/index.ts` 时别和 `verify:ipc` / `verify:lint` 撞车（它们会临时改那个文件）。
- 别在 renderer 里出现 token。

---

### T11 · 账号密码 + 校验码（第二阶段，可延后）

**前置**：T10。

**做什么**：`POST /api/login` 在可疑流量下会返回 `needChallenge: true` →
需要拉挑战、把**图片**渲染出来、让用户填、再带挑战 id + 验证码重试。
这是"图片 + 一次重试状态机"，属于本轮里性价比最低的一块 —— 所以排最后。

**完成判据**：**故意输错 2 次触发校验码**，确认客户端能走完整条路径。
（这是反向断言：只测顺利登录，永远测不到这条分支。）

---

### T12 · Electron 自检：本地假 SSE 上游

**前置**：T7。

**做法**：照 `verify:update-feed` 的路子 —— 在**被测进程内**用 `node:http` 起一个假 SSE 服务器
（**不要 spawn 子进程**，本机沙箱必 EBUSY），可配置场景：

| 场景 | 期望 |
|---|---|
| `token×N → done` | 正常收尾，`completionTokens` 与文本长度一致 |
| `token×N` 后**直接断开、不发 done** | 仍然**恰好一个**终态，UI 不停在转圈 |
| `token×N → error` | 恰好一个 error 终态 |
| 中途 abort | 服务端能观察到连接被关闭 |

**完成判据**
- 判定走哨兵（`[selfcheck] DONE ok=… code=…`），不挂"进程能不能退出"。
- 事件序列在**渲染层订阅点**收全量，不轮询采样。
- 断言"三处一致"：主进程状态 / 渲染层最后一帧 / DOM 上的 `data-stage`。
- 真 navigate 作为**可选**集成：环境不具备时如实落 `skipped` 并**非零退出**，不许假装通过。

---

### T13 / T14 · Web / 鸿蒙 自检增量

**前置**：T12。

**分工原则（避免三套断言各自漂移）**
- **帧解析 / 映射的细粒度断言只在 `verify-core-sse.mjs` 里**（T4/T5 已做）。
- 三端自检**只验三件事**：真的连上了 / 终态恰好一个（含断流场景）/ abort 有效。

T13 在 `shell-web/src/selfcheck.ts` 增量；T14 在 `verify-ohos.mjs` + 鸿蒙 UI 里增量
（截图要能看到逐字流，不只是首屏）。

---

### T15 · 文档与口径订正

**前置**：全部。

**必须做的三件事**
1. README 新增一节：为什么接真实上游 / 三端各自的 IO 实现 / 能力探测如何降级 /
   离线脚本上游的定位。
2. **口径订正（不许跳过）**：README §8 与 `docs/perf.md` 里
   **「流式首 token 27–28ms」实际是"泵的首帧延迟"，与上游无关**。
   改造后要么重测并改名为"本地首帧延迟"，要么拆成两项（本地首帧 / 上游首 token）。
   改口径必须在文档里写**理由与代价**（项目既有约定）。
3. `Usage` 字段标签订正：`promptTokens` / `completionTokens` 是**字符数**，不是 token
   （上游不给 usage）→ UI 与文档同步改，不许留"tokens"字样。

**叙事定位（重要）**：写「**同一份 core，两个上游实现**」，
**不要**写成"navigate 的桌面客户端"。后者会把"跨端架构示范"这个立论讲没。

---

## 5. 每轮 checkpoint（要交给 lead review 什么）

| 轮 | 交付 |
|---|---|
| 轮0 | T1 形状结论（含反例）· T2 三种可达方式表 · T3 真帧语料 + 帧顺序结论 |
| 轮1 | `verify:sse` 断言数 + 变异测试结果（含"哪条变异存活 0"） |
| 轮2 | `verify:agent` 重写前后的**断言条数对照** + 4 条新断言 + 变异结果 + `#settle` 可达性结论 |
| 轮3 | 每条链路"逐帧到达"的证据（时间戳）+ 断流兜底实测 + abort 实测 |
| 轮4 | 503 / 429 可区分的断言证据 |
| 轮5 | 自检报告（`docs/evidence/`）+ 口径订正 dif |

---

## 6. 验收总表

| 项 | 判据 |
|---|---|
| 三端都能连真实 navigate 并逐字显示 | 三份截图/报告，且**能看到逐字过程**（不是只有最终态） |
| 上游断流不会卡住 | 假 SSE 场景 2 通过 |
| abort 真的停住 | 上游观察到连接关闭 |
| 没有"看起来正常的错数字" | `Usage` 标签改对；perf 口径订正 |
| 三端逻辑不漂移 | 解析/映射只有一份，三端自检只验连通性 |
| 离线仍可自检 | `ScriptedModel` 仍在，UI 如实标明 |
| 诚实性 | 不具备的环境如实报 `skipped` 非零退出；不达标项写进已知限制 |

---

## 7. 已知的坑（照抄，别重踩）

- 本 shell 有 `ELECTRON_RUN_AS_NODE=1` → 走 `launch.mjs`，别绕过。
- 本机 Chromium 沙箱起不来 viz 层 → 自检加 `--no-sandbox`（只影响自检）。
- `app.exit()` 在受限会话结束不掉进程 → 收尾靠哨兵 + 强杀进程树。
- 必须用一个 `.jpeg` 后缀那个坑属于鸿蒙截图工具（`snapshot_display`）。
- `hdc file recv` **失败时退出码仍是 0**，唯一信号是 stdout 的 `[Fail]`。
- `uitest dumpLayout` 取控件坐标必须**遍历 JSON**，字符串切片会拿到下一个节点。
- 仓库根会不断出现 `_tmp_<pid>_<hash>` 空文件 → 已被 gitignore，**别 `git add -A`**。
- `verify:ipc` / `verify:lint` 会临时改 `packages/core/src/index.ts` 再还原 —— 别同时改它。

## 8. 悬案（做完再议，别在本期顺手解决）

- navigate 侧 `AbortController` **不向上游传播** → "停止"只能停渲染，
  服务端生成会在后台跑完。UI 文案只能是"已停止接收"，不能是"已取消生成"。
- 本地会话列表 ↔ 服务端历史的同步模型（见 §0⚠️）。
- 鸿蒙 `FsPort` 缺口。
- `contract/src/ipc.ts` 里 `fsWatch` 的去留。
- `--no-sandbox` 策略收口。
