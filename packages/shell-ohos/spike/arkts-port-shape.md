# ArkTS 端口形状 spike 结论

> 状态：**已完成**。两组都通过。**决策不变**：用回调式。
> 实测日期：2026-10-07 ｜ 工具链：DevEco Studio 26.0 + hdc 3.2.0f

## 要回答的问题

把 `ModelPort` 从 `Promise<ModelReply>`（一次性）改成流式，用哪种形状？
- **A 组 · 回调式** —— sink 带三个无返回值回调，`stream()` 返回取消函数
- **B 组 · 异步可迭代** —— `stream()` 返回 `AsyncIterable<string>`，外面 `for await`

## 探针位置

- 探针源码：`entry/src/main/ets/shared/probe/portShape.ts`（**必须是 `.ts`**）
- 调用点：`entry/src/main/ets/pages/Index.ets` 的 `aboutToAppear`（**真的调用**，
  不是只 import —— 只 import 泛型可能不被实例化，编译器就不检查）

## 结果

| 组 | 形状 | 编译 | 运行时 |
|---|---|---|---|
| **A** | 回调式（`ModelSink` 三回调 + `Cancel`） | ✅ 通过 | ✅ 真的调到了三次回调 |
| **B** | `AsyncIterable<string>` + `async function*` + `for await` | ✅ **通过** | ✅ `for await` 跑通 |

`hvigorw assembleHap` → `BUILD SUCCESSFUL`；`CompileArkTS` 实际执行（非 UP-TO-DATE），
说明两个探针文件真的进了编译。

## 反向断言（证明编译器真在 type-check）

往探针里临时塞一处已知非法调用（`ModelSink.onChunk` 要求 `string`，给 `number`）：

```
ERROR: 10505001 ArkTS Compiler Error
Error Message: Type '(count: number) => void' is not assignable to type '(text: string) => void'.
COMPILE RESULT:FAIL {ERROR:2}
```

报错后立刻删除反例、重新编译恢复 `BUILD SUCCESSFUL`。
**这一步是 A/B "通过"有效的前提** —— 否则"不报错"可能只是因为压根没检查。

## 结论与决策

**A ✅ / B ✅ —— 两者都能用，但选 A（回调式）。**

理由（不是"保守"，是同形状先例的成本差）：
- `contract` 里已有**两个同形状且已过 ArkTS 的**先例：`FsPort.watch(): Promise<() => void>`、
  `StreamBus.subscribe()`。用已被证明的形状，比引入 contract 里**零先例**的
  `AsyncIterable` / `for await` 便宜。
- 回调式与背压语义天然同构（泵本来就是回调解锁的）。

## ⚠️ 这条结论**没有**证明的事

- B 组虽然编译+运行都通过，但**没有**验证 `Symbol.asyncIterator` 在
  ArkTS 更复杂的场景（如跨模块传递、与 `Promise` 组合）下是否稳定。
  它只是"这个简单形状能过"，不是"异步迭代在 ArkTS 上完全可用"。
  → 所以它不构成"改用 B"的理由，但也不必写进已知限制（我们不用它）。
- 探针只覆盖 `string` 负载。若将来 `ModelChunk` 变成结构体，要重跑一次。

## 复现方式

```bash
cd packages/shell-ohos
export DEVECO_SDK_HOME="D:/software/DevEco Studio/sdk"
export PATH="/d/software/DevEco Studio/tools/node:/d/software/DevEco Studio/jbr/bin:$PATH"
"/d/software/DevEco Studio/tools/hvigor/bin/hvigorw.bat" assembleHap --no-daemon
```

⚠️ **PATH 必须用 POSIX 风格写法**。写成 Windows 风格（`D:/.../node:D:/.../jbr/bin`）
时 Git Bash 的路径转换会出错，症状是 `spawn java ENOENT` —— 而它报在
`PackageHap` 阶段，看起来像"java 没装"，实际是 PATH 传给 `.bat` 时被转坏了。
（加 `JAVA_HOME` 没用，别在那上面浪费时间。）
