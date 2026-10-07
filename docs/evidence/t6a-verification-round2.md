# T6-a 验证报告 · 第二轮

> 验证时间：2026-10-07 22:57 ｜ 对象：`packages/core/src/agent/model.ts`（用户第二次手写）
> 结论：**核心逻辑已修好，但仍有 2 个真问题 + 1 处遗留**，且 `typecheck` 未全绿。

---

## 一、上一轮 6 条缺陷的复验结果

用手动时钟复刻第二轮 `stream()` 原样逻辑实测（脚本见 §五），逐条复验：

| # | 上轮缺陷 | 本轮 | 证据 |
|---|---|---|---|
| 1 | vite import 误入 | ✅ **已修** | 第 1 行已删；`verify:core-purity` 绿 |
| 2 | 工具分支被覆盖 | ✅ **已修** | 工具分支实测 `工具返回：xxx —— ...` 前缀**保留**；`reply = this.#reply` 已挪到 `if` 之前当默认值 |
| 3 | 定时器永不停 | ✅ **已修** | 实测推进 200ms 后**存活定时器 = 0**、空串 chunk = 0 |
| 4 | `onEnd` 早于 `onChunk` | ✅ **已修** | 实测"调用后未推进时钟"时 `chunk=0, onEnd=0`（上轮是 `onEnd=1`）；onEnd 现在只在切完时发 |
| 5 | `tools/common.ts` 范围外新增 | ❌ **仍在** | 见 §三 |
| 6 | `deps` 可选链静默半死 | ⚠️ **改成必填了，但** | 见 §二 · 2.3（改必填是对的，可它**撞坏了 3 个壳调用点**）|

**核心流式逻辑这轮是对的**：三个分支（普通 10 字符 / 普通 12 字符 / 工具分支）拼接结果都
与期望完全一致，无空串、无泄漏。这是一次高质量的修复。

---

## 二、本轮新发现的问题

### 2.1 🔴 `cancel()` 不幂等 —— `onEnd` 会被调**两次**（真 bug）

返回的取消函数：

```ts
return () => {
  sink.onEnd();        // ← 无条件发结束
  cancelStream?.();
};
```

**问题**：文本**自然吐完**时，`every` 回调里已经 `sink.onEnd()` 过一次（并自摘了调度）。
此后若外层再调一次 `cancel()`（壳在收尾 / abort / 关窗时**很可能会再调一次**，因为
调用方无从知道"它其实已经自然结束了"），就会**第二次** `sink.onEnd()`。

**实测**（3 字符回复，先 `advance(10)` 让它自然结束，再调 `cancel()`）：

```
自然结束后 end = 1 存活定时器 = 0
再调 cancel() 后 end = 2 ← >1 就是重复终结 ❌
```

**为什么严重**：sink 契约是 **"`onEnd` 恰好一次，与 `onError` 互斥"**（文件里你自己写的注释）。
重复 `onEnd` 违反契约 → 消费端（T6-b 的 runtime）若据此收尾，会 `#settle` 两次。
虽然 `#settle` 有重复保护，但**保护不该被当成设计**（现有 84 条断言头部就如实记录了
"`#settle` 的重复终结保护不可达" —— 如果我们主动制造重复，就等于把一条本来不可达的路径
变成日常路径，收益是零、风险是新增）。

**最小修法**：加一个 `#ended` 幂等位。

```ts
let ended = false;
const finish = () => { if (ended) return; ended = true; sink.onEnd(); };
// every 回调里： if (reply === '') { cancelStream?.(); finish(); }
// 返回的 cancel： return () => { finish(); cancelStream?.(); };
```

> 顺带：自然结束时那次 `cancelStream?.()` 其实可省（回调里已自摘），但留着无害。

### 2.2 🟡 `abort` 语义被判错 —— `cancel()` 发的是 `onEnd`，不是中止

同一段代码还藏着一个语义问题：**用户点"停止"时，走的也是这个 `cancel()`**，
于是会发 `onEnd()`（"正常说完"）而不是 `onError('ABORTED')`。

但计划 T6-b 明确写：

> abort → **真的调用**上游返回的取消函数（且要能断言它被调用过）。

而 runtime 的 `abort()` 会自己发 `error(ABORTED)` 终态。所以这里的分工是：
**`cancel()` 只负责"停住上游"，发不发终态由调用方决定**。
现在 `cancel()` 自作主张发 `onEnd`，会导致：

- runtime abort 时 → 先收到 `onEnd`（可能触发一次 drained/done），再发自己的 `error` → **两个终态**。
- 加上 2.1 的幂等问题，`onEnd` 可能被记成 2 次。

**最小修法**：`cancel()` 里**只做取消**，不碰 sink。

```ts
return () => { cancelStream?.(); };   // 就这样，别发终态
```

> 理由写进注释：**"取消"与"结束"是两回事** —— 取消是"我不听了"，结束是"上游说完了"。
> 谁收尾由 runtime 决定（它才知道是 abort 还是正常流程）。

### 2.3 ⚠️ `deps` 改必填 → 撞坏 3 个壳调用点（编译红）

`deps` 从可选改成必填，方向**正确**（没有时钟就没法滴流，不该静默半死）。
但三个壳的调用点原本是 `new ScriptedModel()`（无参），现在报：

```
packages/shell-electron/src/main/agentRuntime.ts(31,10): error TS2554: Expected 1 arguments, but got 0.
packages/shell-web/src/main.ts(53,10): error TS2554: Expected 1 arguments, but got 0.
packages/shell-web/src/selfcheck.ts(292,12): error TS2554: Expected 1 arguments, but got 0.
```

麻烦点：这三个壳把 `deps` **内联写在 `new AgentRuntime({ deps: {...} })` 里**，
没有一个可复用的 `deps` 变量能直接传给 `ScriptedModel`。要修就得把 `deps` 提成变量：

```ts
const deps: AgentDeps = { now: ..., every: ..., newId: ... };
const runtime = new AgentRuntime({ deps, model: new ScriptedModel({ deps }) });
```

**但这里有个归属问题**：T6-a 的**范围只是 `model.ts`**。壳的调用点属于 T7/T8/T9。
现在改必填，等于把壳编译搞红、却要等到 T7 才修 —— **跨步骤污染**。

**建议（二选一）**：
- **A（推荐）**：`deps` 保持**必填**，但**这一步就顺手把 3 处壳调用点改成传 deps**
  （提取内联 deps 成变量，三处各一行）。改动小、方向对，且让 `typecheck` 立刻全绿。
  *代价*：T6-a 的 commit 里带了 3 个壳文件 —— 可以在 commit message 里说清"为保持编译绿"。
- **B**：`deps` 暂时保留可选 + 显式降级（`deps` 缺省时**一次性 `onChunk(reply)` 然后 `onEnd`**，
  并在注释里写"没有时钟 = 不退化成滴流，而是一次性给完"）。壳就不动。
  *代价*：留了个"可选"的口子，与"必填"的初衷相反。

> 我倾向 **A**。理由：`deps` 必填是**对的**语义；3 处壳改动是纯机械的提取，
> 且 T6-b 反正要再动 runtime 与壳，不如现在就把"deps 从哪来"这件事一次说清。

---

## 三、遗留：`tools/common.ts`

仍未被处理。`import { CommonUtils } from '../tools/common'` 引入了一个**计划外的新文件**，
只为包一个 3 行的 `getErrorMsg`。两个问题：

1. **范围外**：T6-a 动作清单里没有它。
2. **命名冲突**：`core/src/tools/`（新目录）与既有 `core/src/agent/tools.ts`（工具注册表，含 `echoTool`）
   **名字撞车**，后人很容易搞混"tools 到底是哪个"。

**最小修法**：就地内联，删掉整个 `tools/` 目录。

```ts
} catch (err) {
  sink.onError(err instanceof Error ? err.message : String(err));
}
```

---

## 四、当前 `typecheck` 全景

```
packages/core/src/agent/runtime.ts(6,26):   TS2305 ModelReply  ← 预期（T6-b 的活）
packages/core/src/agent/runtime.ts(184,33): TS2339 complete    ← 预期（T6-b 的活）
packages/shell-electron/src/main/agentRuntime.ts(31,10): TS2554 ← 本轮新增（见 2.3）
packages/shell-web/src/main.ts(53,10):                   TS2554 ← 本轮新增（见 2.3）
packages/shell-web/src/selfcheck.ts(292,12):             TS2554 ← 本轮新增（见 2.3）
```

- `runtime.ts` 两条：**预期**，T6-b 修。
- 三条 TS2554：**本轮引入**，需按 §2.3 处理（A 或 B）。

`verify:core-purity` **✅ 绿**（19 文件，零平台依赖）。

---

## 五、修复清单（按优先级）

| # | 问题 | 级别 | 修法 |
|---|---|---|---|
| 1 | `cancel()` 不幂等 → `onEnd` 可能两次 | 🔴 | 加 `ended` 幂等位，`onEnd` 走 `finish()` |
| 2 | `cancel()` 发 `onEnd`（应为纯取消）| 🔴 | `return () => { cancelStream?.(); }` |
| 3 | 3 个壳调用点编译红 | ⚠️ | 提 `deps` 成变量并传入（方案 A）|
| 4 | `tools/common.ts` 范围外 + 命名冲突 | 🟡 | 内联 `getErrorMsg`，删目录 |

> 修 1–2 是 `model.ts` 内的事；修 3 涉及壳（需拍板 A/B）；修 4 是清理。

---

## 六、验证手法说明（可复用）

本轮的逻辑结论全部来自**手动时钟复刻 `stream()` 逐字逻辑**后跑出来的，
不是读代码推测。复刻要点：

- 一个 `every(intervalMs, fn)` 手动时钟，`advance(ms)` 按到期顺序触发、可查存活定时器数。
- 记录 `onChunk` 列表 + `onEnd`/`onError` 计数。
- 覆盖：普通文本（3 的倍数 / 非倍数）、工具分支、abort 中途取消、**自然结束后再 cancel**（捉到 2.1）。

**这次正是"自然结束后再 cancel"这个用例捉到了 `onEnd` 两次** ——
上轮报告没覆盖它，因为当时 `cancel()` 里还没有 `onEnd`。

---

## 七、本轮未覆盖（不许当已验证）

- **未跑** `verify-core-agent.mjs`（84 条）：它 import `ScriptedModel` 且依赖旧滴流语义，
  T6-c 才重写。
- **未验证**真实 Electron / Web 壳里 `deps.every` 用 `setInterval` 时的行为差异（手动时钟与真实定时器
  在"同刻多定时器"的先后顺序上可能不同，但那不影响本轮的幂等性结论）。
- ArkTS 侧未验（T7/T9）。
