import type { PathDenyReason, PathGuard, Workspace } from '@crossdeck/contract';
import { joinPath } from './posixPath.js';

/**
 * 「把 `{ workspaceId, relPath }` 变成一条**已授权的绝对路径**」。
 *
 * 为什么要下沉到 core：Electron 壳先写了这段，Web 壳要用的那一刻就到了
 * 二选一的关口 —— 抄一份，或者下沉。抄一份的代价不是多写 15 行，
 * 而是**两端的授权语义从此可能走散**：某天有人在 Electron 那份里加了
 * 「只读工作区不许写」，Web 那份不会跟着变，而这是安全代码。
 *
 * 它天然是平台无关的：拼接、限定工作区、判定，全是纯字符串 + 纯逻辑。
 * 两个跨进程壳（Electron / 鸿蒙）需要它；同进程的 Web 壳也需要它。
 *
 * ⚠️ 这里只返回**领域结果**，不抛异常 —— 与 WorkspaceStore 同一条边界：
 *    「怎么把失败表达出去」是壳的问题（IPC 错误信封 / 页面提示）。
 */
export interface WorkspaceResolver {
  get(id: string): Workspace | undefined;
}

export type ResolveInWorkspaceResult =
  | { readonly ok: true; readonly absolute: string; readonly workspace: Workspace }
  | { readonly ok: false; readonly reason: PathDenyReason };

/**
 * @param store   授权表（WorkspaceStore 即可满足）
 * @param guard   PathGuard（core 的 createPathGuard 产物）
 * @param workspaceId 目标工作区。**必须显式传**，不接受"当前工作区"这类隐式上下文 ——
 *   多工作区并存时"当前"是个必然出错的隐式上下文（见 ipc.ts 的通道设计注释）。
 * @param relPath 相对 root 的路径
 */
export async function resolveInWorkspace(
  store: WorkspaceResolver,
  guard: PathGuard,
  workspaceId: string,
  relPath: string,
): Promise<ResolveInWorkspaceResult> {
  const workspace = store.get(workspaceId);
  if (workspace === undefined) {
    // 与"越界"区分开：撤销授权之后点了刷新，应当是"去授权"而不是"越界报错"。
    return { ok: false, reason: 'NO_WORKSPACE' };
  }

  const joined = joinPath(workspace.root, relPath);
  if (joined === null) return { ok: false, reason: 'BAD_PATH' };

  // withinWorkspaceId 是这里**唯一**能做对的地方：core 的 PathGuard 不知道
  // "当前工作区"是什么。不传的话，A 工作区里的 `../` 恰好落进同样已授权的
  // B 工作区时会被放行 —— 边界在用户眼里就消失了。
  const decision = await guard.check(joined, { withinWorkspaceId: workspaceId });
  if (!decision.allowed) return { ok: false, reason: decision.reason };

  return { ok: true, absolute: decision.resolved, workspace };
}
