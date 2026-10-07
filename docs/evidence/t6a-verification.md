# T6-a 验证报告

> 验证时间：2026-10-07 ｜ 验证对象：`packages/core/src/agent/model.ts`（用户手写）
> 结论：**未通过** —— 3 处编译错误（阻塞）、1 处纯度违规、4 处逻辑缺陷。
> 下面每条都给**证据**与**最小修法**，按"必修 / 建议"分级。

---

## 一、硬证据：编译与纯度

### 1.1 `pnpm typecheck` —— 3 处错误（阻塞）

```
packages/core/src/agent/model.ts(1,23): error TS2307: Cannot find module '@vitejs/plugin-react'
packages/core/src/agent/runtime.ts(6,26): error TS2305: Module './model.js' has no exported member 'ModelReply'
packages/core/src/agent/runtime.ts(184,33): error TS2339: Property 'complete' does not exist on type 'ModelPort'
```

三处其实是两件事：

- **`model.ts:1` 是一行误入的 import** —— `import { react } from '@vitejs/plugin-react';`
  这行在文件最顶部（第 1 行），在文件头注释**之前**。core 里出现 vite 是绝对禁忌。
- **后两处是"预期内的编译红"** —— T6-a 只改 `model.ts`，`runtime.ts` 还没改（T6-b 的事）。
  这正是计划里写的"先让编译器把受影响的点报出来"。**不算 bug，但要确认它们确实是这两处、没有别的。**

### 1.2 `pnpm verify:core-purity` —— 1 处铁律违规（阻塞）

```
❌ 发现 1 处铁律违规：
   packages/core/src/agent/model.ts
     import '@vitejs/plugin-react'
     → core 不得依赖任何第三方或平台模块
```

纯度脚本**正确拦住了**。这条必须先清掉，否则违反项目第一铁律。

---

## 二、逻辑缺陷（编译过了也会错）

> 下面 4 条是用**手动时钟复刻 `stream()` 原样逻辑**实测出来的，不是看代码猜的。

### 2.1 🔴 工具分支被无条件覆盖 —— `reply = this.#reply` 位置错

```ts
if (req.prompt.includes(TOOL_SCENARIO_MARKER)) {
  reply = `${this.#toolOutputPrefix}${asked} —— 然后这是我的回答。${this.#reply}`  // ← 精心拼的
  sink.onToolCall?.({ name: 'echo', args: { text: asked } })
}
reply = this.#reply   // ← 无条件覆盖！上面那个 if 白做了
```

**后果**：带 `[[tool:echo]]` 的输入，最终吐出来的**没有工具前缀、没有 `asked`**，
永远只有 `SCRIPTED_REPLY`。而"工具结果确实被用上了"正是现有断言要验的东西
（`工具返回：xxx` 前缀是断言锚点）。

**最小修法**：把 `reply = this.#reply` 挪进 `else`：

```ts
if (req.prompt.includes(TOOL_SCENARIO_MARKER)) {
  ...
} else {
  reply = this.#reply
}
```

### 2.2 🔴 定时器永不停 —— 文本切完后仍在空转、一直吐空串

**实测**（10 字符回复，推进 260ms）：

```
advance(60)  → chunks = ["ABC","DEF","GHI","J","",""]
advance(200) → 总 chunk 数 = 26 ｜ 其中空串 = 22
             存活定时器 = 1 ← 文本早吐完了，定时器还在跑
```

**根因**：`every(10, ...)` 里没有"切完就 cancel"的出口。`reply` 切成空串后
`reply.slice(0,3)` 恒为 `''`，于是**每 10ms 吐一个空串，永不停止**。

**后果**：
- 定时器泄漏 —— 直接违反项目红线（`droppedAfterTerminal` 会抓到非 0）。
- 空串会一路 `pump.push('')`（好在 pump 有 `text.length === 0` 早退），
  但**调度泄漏本身**已经足够致命：run 结束后 `deps.every` 的 handler 还活着。

**最小修法**：回调里自摘调度。

```ts
let stop: Cancel | undefined
stop = clockOrDeps.every(10, () => {
  if (reply.length === 0) { stop?.(); return }   // ← 切完就停
  const str = reply.slice(0, 3)
  reply = reply.slice(3)
  sink.onChunk(str)
})
cancelStream = stop
```

### 2.3 🔴 `onEnd()` 在同步阶段就发了 —— 早于任何 `onChunk`

**实测**：

```
── 调用 stream() 之后（尚未推进时钟）──
  onChunk 次数 = 0 ｜ onEnd = 1 ｜ 存活定时器 = 1
```

**根因**：`sink.onEnd()` 写在 `try` 块的同步流程里，而 `onChunk` 是**异步**（10ms 后）才发的。
于是"结束"比"第一段文本"还先到。

**后果**：这是语义错误。消费端（runtime）若按"onEnd 即收尾"处理，会在**一个字都没收到时**
就 `closeUpstream()` → 泵看到"上游已关 + 队列空" → 立刻 `drained()` → 用户看到**空答案 + done**。

**最小修法**：`onEnd()` 必须移到"切完"那一刻（即 2.2 里那个 `stop?.()` 的位置）：

```ts
stop = deps.every(10, () => {
  if (reply.length === 0) { stop?.(); sink.onEnd(); return }
  ...
})
```

### 2.4 🟡 `CommonUtils` 是多余的一层 —— 且落在 core 里

`import { CommonUtils } from '../tools/common'` 引入了一个新文件
`packages/core/src/tools/common.ts`，只为包一个 3 行的 `getErrorMsg`。

**问题**：
- 计划 T6-a 的动作清单里**没有这个文件**，属于范围外新增。
- `catch` 里的 `sink.onError(...)` 本身也需要考虑"是否该吞异常"（见下）。
- 目录名 `tools/` 与既有的 `agent/tools.ts`（工具注册表）**重名冲突**，后人会困惑。

**最小修法**：两选一 ——
① 若确实要多处复用，放到 `core/src/agent/` 下并与 `agent/tools.ts` 区分命名；
② 更简单：就地内联一行，不新建文件。

```ts
} catch (err) {
  sink.onError(err instanceof Error ? err.message : String(err))
}
```

---

## 三、与计划的符合度

| 计划要求（T6-a） | 实现 | 判定 |
|---|---|---|
| 删 `ModelPort.complete` | 已删 | ✅ |
| 新增 `interface ModelSink`（含可选 `onToolCall`）| 已加，形状正确 | ✅ |
| 新增 `ModelPort.stream(req, sink): Cancel` | 已加 | ✅ |
| `ScriptedModel` 实现 `stream` | 已改，但 4 处逻辑缺陷 | ⚠️ |
| 删 `ModelReply` | 已删 | ✅ |
| `ModelToolCall` 保留 | 保留 | ✅ |
| 用注入的 `deps.every` 推进，不用真实定时器 | 用了 `deps.every` ✅，但可选链 `?.` 埋雷（见下）| ⚠️ |
| `model.ts` 不出现 `setTimeout`/`setInterval` | 满足 | ✅ |
| 取消函数摘掉 `every` 调度 | 返回了 `cancelStream?.()` | ✅（但 2.2 的空转要一并解决）|

### 3.1 🟡 额外隐患：`this.#deps?.every(...)` 用了可选链

```ts
constructor(opts) { this.#deps = opts.deps }   // deps 可选 → undefined
...
cancelStream = this.#deps?.every(10, ...)      // deps 为 undefined 时整句变 undefined
sink.onEnd()                                    // 仍会执行
```

若调用方 `new ScriptedModel()` 不传 `deps`（现有 5 处断言就这么用的），
则 **`onChunk` 永远不发、只发 `onEnd`** —— 静默产出一个空答案，**不报错**。

**建议**：`deps` 应是**必填**（没有时钟就没法"滴流"）。缺省时应当**抛错**或退化成
"一次性把所有文本 onChunk 出去"，而不是静默半死。写清在注释里。

---

## 四、修复清单（按优先级）

| # | 缺陷 | 级别 | 修法摘要 |
|---|---|---|---|
| 1 | 第 1 行 `import { react } from '@vitejs/plugin-react'` | 🔴 阻塞 | 删掉整行 |
| 2 | 工具分支被 `reply = this.#reply` 覆盖 | 🔴 | 挪进 `else` |
| 3 | 定时器永不停、空转吐空串 | 🔴 | 切完 `stop()` |
| 4 | `onEnd()` 早于 `onChunk` | 🔴 | 移到"切完"处 |
| 5 | `tools/common.ts` 范围外新增 + 命名冲突 | 🟡 | 内联 / 换位置 |
| 6 | `deps` 可选链静默半死 | 🟡 | 必填或显式降级 + 注释 |

> 修完 1–4 后应能重新 `pnpm typecheck` 通过（`runtime.ts` 两处**仍会红** —— 那是 T6-b 的活，
> 属预期）。届时再进 T6-b。

---

## 五、这次验证**没有**覆盖的（不许当已验证）

- **未跑** `verify-core-agent.mjs`（**84 条**）—— 它 import 了 `ScriptedModel` 且依赖
  "泵滴流"，在 T6-b 完成前跑不出有意义的结果。T6-c 才重写它。
- **未验证** ArkTS 侧能否消费新形状 —— 属 T7/T9。
- 本次结论全部基于**手动时钟复刻**与**编译器**，未起真实 Electron 壳。
