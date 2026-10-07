# T6-a 验证报告 · 第 3 轮（修复交付）

- **日期**：2026-10-07
- **范围**：`packages/core/src/agent/model.ts` —— `ScriptedModel` 的流式契约
- **触发**：用户裁决 `你来改吧，选A`（把 `deps` 定为必填，同步改 3 处壳调用点）
- **结论**：**核心逻辑通过**（24/24，手动时钟真跑编译产物）；`typecheck` 只剩 2 条 **T6-b 的预期错误**

---

## 1. 本轮修了什么

对照第 2 轮报告开出的清单：

| # | 问题（第 2 轮发现） | 修法 | 状态 |
|---|---|---|---|
| 1 | 🔴 `cancel()` 不幂等 → `onEnd` 发两次（实测 end=2） | 引入 `ended` 位 + `finish()` 收口；自然结束与 `cancel()` 都走 `finish()` | ✅ |
| 2 | 🔴 `cancel()` 自己发 `onEnd` → 与 runtime 的 abort 终态撞车 | `cancel()` 只 `cancelStream?.()`，**不碰 sink** | ✅ |
| 3 | ⚠️ `deps` 必填导致 3 处壳 `TS2554` | **选 A**：在壳里把内联 `deps` 提成具名 `const deps: AgentDeps = {...}`，runtime 与 model 共用 | ✅ |
| 4 | 🟡 `tools/common.ts` 越界新增 + 与 `agent/tools.ts` 命名冲突 | 删除该文件（T6-a 范围只含 model.ts） | ✅ |
| 5 | 🟡 空回复会让定时器空转 | 加空回复快路径：`finish()` 后直接 `return () => {}` | ✅ |
| 6 | 🟡 错误处理引入外部工具类 | 就地写 `err instanceof Error ? err.message : String(err)`，core 不多一个文件 | ✅ |

### 1.1 为什么 `deps` 必须必填（选 A 的理由）

`this.#deps?.every(...)` 的可选链会让**缺 deps 时静默返回空答案** —— 调用方看到
"onEnd 发了、没有报错"，但一个字都没吐。这是最坏的一类 bug：**看起来成功了**。

第 2 轮实测：5 条断言因为 `new ScriptedModel()` 未传 deps 而静默空转。
所以宁可让 3 处壳编译报错（机械提取，5 分钟），也不要留一个"静默空答案"的口子。

---

## 2. 验证手法：手动时钟，真跑编译产物

脚本已固化为 **`scripts/verify-model-stream.mjs`**（零依赖，24 条），并接入 `pnpm verify` 链。

**关键**：不是复刻一遍 `stream()` 逻辑，而是 `import` 真实的 `packages/core/dist/index.js`，
注入一个可 `advance(ms)` 的手动时钟作为 `deps.every`。
于是整个流式过程**确定性、0ms 真实等待** ——
"定时器永不停""空串空转""onEnd 发两次"这些**只在时间维度上暴露**的 bug 才能被稳定抓住。

```
$ node scripts/verify-model-stream.mjs
【1. 普通流：完整、有界、终态恰好一次、不泄漏】        7 ✅
【2. 工具分支：前缀保留 + onToolCall 触发】            4 ✅
【2b. 未实现 onToolCall 的 sink：可选回调不得崩】      1 ✅
【3. 空回复边界：直接收尾，不空转】                    3 ✅
【4. 自然结束后再 cancel()：onEnd 仍恰好 1 次（幂等）】 2 ✅
【5. 中途 abort：cancel 只停、不发终态】               3 ✅
【6. cancel() 连调三次：不重复、不终态】               2 ✅
【7. deps 必填 + 无平台 import（源码断言）】           2 ✅
────────────────────────────────────────
✅ 全部 24 条通过
```

### 2.1 第 4 组是本轮的核心用例

```js
const cancel = model.stream({ sessionId:'s', prompt:'hi' }, sink);
clock.advance(10);                 // 3 字符一个周期吐完 → 自然结束
check('自然结束后 onEnd = 1', r.end === 1);
cancel();                          // ← 第 2 轮挂在这里
check('再调 cancel() 后 onEnd 仍 = 1（幂等）', r.end === 1);
```

第 2 轮这里读到 `end=2`。**这条用例就是为那个 bug 写的。**

---

## 3. 变异测试：证明断言有鉴别力

「新写的断言要证明它有鉴别力」是项目铁律。手法：改 `model.ts` → 重编译 → 重跑 → 记录挂几条 → 还原。

| 变异 | 描述 | 结果 |
|---|---|---|
| **M1** | 去掉 `finish()` 幂等位（保留「cancel 不碰 sink」） | **存活（0 killed）** |
| **M1b** | `cancel()` 也发 `onEnd`（第 2 轮真实 bug 形状） | **杀死 3 条** ✅ |
| **M2** | 切完不自摘调度 | **杀死 3 条** ✅（定时器泄漏 + 空串 chunk） |
| **M3** | 终态提前到首个 chunk 之前 | **杀死 4 条** ✅（含"终态不早于首个 chunk"序断言） |
| **M4** | 去掉空回复快路径 | **杀死 1 条** ✅（仅"无空串 chunk"） |
| **M5** | 在 `onChunk` 后加 `if (str === '') return` | 存活 |
| **M5b** | 收尾多吐一个空串 | **杀死 1 条** ✅（"无空串 chunk"） |

### 3.1 两个「存活」必须分开看（本报告最重要的方法论结论）

**M1 存活 —— 是防御性冗余，不是测试弱。**
在「cancel 只停、不发终态」的语义下，`cancel()` 根本不碰 sink，
所以即使去掉 `ended` 位，第 4 组的 `end` 依然是 1。
`ended` 位真正防的是 **M1b 那类改动**（有人给 cancel 加终态）—— M1b 杀 3 条证明了这点。
→ **要保留 `ended` 位**：它是给未来的自己上的锁，不是给当前逻辑用的。

**M5 存活 —— 是无效变异体，不是测试弱。**
我插的 `if (str === '') return` 在正常路径下**根本不触发**（`SCRIPTED_REPLY` 的切分不会产生空串），
观测面没变。把「无效变异体」误判成「测试弱」，会让人去加一堆抓不住东西的断言。
改成 **M5b**（收尾真多吐一个空串）后立刻杀掉 1 条 —— 说明「无空串 chunk」这条是有牙的。

### 3.2 已知盲区（诚实记录）

**第 3 组偏弱**：M4（去掉空回复快路径）只挂了「无空串 chunk」1 条。
原因是空串切片会在**首个 tick** 就撞上 `reply === ''` 从而 `finish()`，
所以「onEnd 恰好 1 次」「无定时器注册」**抓不住它**。
这两条断言对空回复场景没有独立鉴别力（它们真正保护的是别处）。留作已知盲区，不假装它是强断言。

---

## 4. 当前仓库状态

```
$ pnpm typecheck
packages/core/src/agent/runtime.ts(6,26):  error TS2305: '...model.js' has no exported member 'ModelReply'.
packages/core/src/agent/runtime.ts(184,33): error TS2339: Property 'complete' does not exist on type 'ModelPort'.
```

**这 2 条是 T6-b 的预期工作**，不是本轮遗留缺陷：

- `ModelReply` 已按 T6 计划删除（`ModelPort` 只剩 `stream()`）。
- `runtime.ts:184` 还在调老的 `model.complete(...)` —— **T6-b 就是把它改成回调驱动**。
- 3 处壳的 `TS2554`（`deps` 必填）已通过「选 A」消除。

```
$ pnpm verify:core-purity
扫描 18 个文件（packages/core/src）
✅ Core 层零平台依赖 —— 铁律成立
```

（18 个：删掉越界的 `tools/common.ts` 后由 19 降回 18。）

---

## 5. 下一步

- **T6-b**：重写 `AgentRuntime.#drive` 为回调驱动（计划文档 5 步表 + 时序图）；
  含「断流兜底（一半 runtime / 一半壳）」、`ActiveRun.cancel`、`abort()` 真的调 cancel。
  → 目标：消掉上面那 2 条 `runtime.ts` 错误。
- **T6-c**：重写 `scripts/verify-core-agent.mjs`（84 条 → 目标 ≥ 89），
  新增 5 条 + `ManualModel` 手动上游 + 变异测试；复用本轮的**手动时钟**手法。
