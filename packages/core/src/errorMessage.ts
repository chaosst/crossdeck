/**
 * 从任意抛出物里取出**人类可读的消息**。
 *
 * ## 为什么要有这个文件
 *
 * `err instanceof Error ? err.message : String(err)` 是本仓库里出现频率最高的
 * 一小段逻辑：core 的 model / runtime / tools，壳的 fs / updater / selfcheck /
 * updateProbe / main …… 十几处一模一样地写着它。
 *
 * 它就是**纯逻辑**：无 IO、无平台 API、三端语义完全一致。
 * 于是按本仓库的既定做法（同 `resolveInWorkspace` 被下沉到 core），
 * **同一份逻辑只留一份** —— 就地手写等于复制十几份，将来要改（补 cause 链、
 * 认识 `{ message }` 结构体）就得改十几处，且必然漏掉几处。
 *
 * ## 为什么放 core，而不是 contract
 *
 * 直觉上 contract 才是"三端共同祖先"，放那儿更省。但 core 有一条被文档写死的
 * 不变量：**对 contract 只做 `import type`、零运行时依赖**（见 `src/index.ts`
 * 与 `verify-core-scope.mjs` 开头的说明）。理由是 core 的**编译产物必须能被裸
 * Node 直接加载**做单测 —— 而 contract 的 `exports` 指向 `.ts` 源，裸 Node
 * 解析不了（实测：`ERR_MODULE_NOT_FOUND contract/src/capability.js`）。
 *
 * 所以放 core：core 自己用相对路径引（无运行时依赖问题），
 * 三端壳用 `@crossdeck/core` 引（壳本来就依赖 core，且走 Vite 编译，无此问题）。
 *
 * ## 怎么用
 *
 * 具名导入**单个函数**，不引入整个模块：
 * ```ts
 * import { errorMessage } from '@crossdeck/core';   // 壳里
 * import { errorMessage } from '../errorMessage.js'; // core 内部
 * ```
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
