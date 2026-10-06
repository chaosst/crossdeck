import type { PathDenyReason, Workspace, WorkspaceMode } from '@crossdeck/contract';
import { isWithinPath, normalizePath } from './posixPath.js';

/**
 * WorkspaceStore —— 授权表 + **归属判定**。
 *
 * 它从壳（`shell-electron/src/main/handlers.ts`）下沉到 core 的原因：
 * 「路径是否落在已授权范围内」是**领域规则**，不是平台能力。
 * 留在壳里意味着每加一个壳就要重写一遍判定 —— 而这是全项目最不能写错的一段。
 *
 * 两条边界（沿用 SessionStore 的既有做法）：
 *   - 时钟与 id 生成器都从构造参数注入 → 测试可以完全确定化
 *   - 零平台 API：连 `node:path` 都不用，路径运算全在 posixPath.ts 里
 *
 * ⚠️ 这里只返回**领域结果**，不抛 IPC 异常。
 *    「BAD_PATH 该怎么告诉用户」是壳的问题（它才知道是 IPC 还是别的通道），
 *    core 也不因此需要 import contract 里任何**运行时**值 —— 保持零运行时依赖。
 */

export interface WorkspaceStoreOptions {
  /** 注入时钟，便于测试与回放。默认 Date.now */
  now?: () => number;
  /** 注入 id 生成器。默认复用与 SessionStore 同款的降级策略 */
  newId?: () => string;
  /** label 最大长度，超出截断。默认 64 */
  maxLabelLength?: number;
  /**
   * Windows / macOS 默认大小写不敏感。
   * **由壳注入平台事实** —— core 自己不去判断平台（那正是铁律要防的事）。
   */
  caseInsensitive?: boolean;
}

export interface GrantInput {
  /** 用户授权时的绝对路径（桌面端）。Web 壳传句柄 id 时同样走这里 */
  root: string;
  label?: string;
  /** 默认只读：写权限必须是用户显式升级，而不是默认给 */
  mode?: WorkspaceMode;
}

/**
 * 授权结果用判别联合而不是抛异常 —— 见文件头注释：
 * 领域层只回答「成没成、为什么不成」，把「怎么表达失败」留给壳。
 */
export type GrantResult =
  | { readonly ok: true; readonly workspace: Workspace }
  | { readonly ok: false; readonly reason: Extract<PathDenyReason, 'BAD_PATH'> };

function defaultNewId(): string {
  const holder = globalThis as { crypto?: { randomUUID?: () => string } };
  const uuid = holder.crypto?.randomUUID;
  if (typeof uuid === 'function') return holder.crypto!.randomUUID!();
  return `ws_${Date.now().toString(36)}_${Math.floor(Math.random() * 0x7fffffff).toString(36)}`;
}

export class WorkspaceStore {
  readonly #byId = new Map<string, Workspace>();
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #maxLabelLength: number;
  readonly #caseInsensitive: boolean;

  constructor(opts: WorkspaceStoreOptions = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#newId = opts.newId ?? defaultNewId;
    this.#maxLabelLength = opts.maxLabelLength ?? 64;
    this.#caseInsensitive = opts.caseInsensitive ?? false;
  }

  /**
   * 授权一个工作区。
   *
   * 同一个目录重复授权是**幂等**的（更新 mode / label，复用原 id）——
   * 否则列表里会出现两条指向同一目录的授权，用户以为"权限翻倍了"，
   * 而撤销掉其中一条时另一条还在，行为看起来是随机失败。
   */
  grant(input: GrantInput): GrantResult {
    const root = normalizePath(input.root);
    if (root === null) return { ok: false, reason: 'BAD_PATH' };

    const existing = this.#findByRoot(root);
    if (existing !== undefined) {
      const next: Workspace = {
        ...existing,
        root,
        label: this.#label(input.label, root),
        mode: input.mode ?? existing.mode,
        grantedAt: this.#now(),
      };
      this.#byId.set(next.id, next);
      return { ok: true, workspace: next };
    }

    const workspace: Workspace = {
      id: this.#newId(),
      root,
      label: this.#label(input.label, root),
      grantedAt: this.#now(),
      mode: input.mode ?? 'read',
    };
    this.#byId.set(workspace.id, workspace);
    return { ok: true, workspace };
  }

  revoke(id: string): boolean {
    return this.#byId.delete(id);
  }

  /** 显式升级 / 降级写权限 —— 只读是默认值，改动必须是一次显式调用。 */
  setMode(id: string, mode: WorkspaceMode): Workspace | undefined {
    const cur = this.#byId.get(id);
    if (cur === undefined) return undefined;
    const next: Workspace = { ...cur, mode };
    this.#byId.set(id, next);
    return next;
  }

  get(id: string): Workspace | undefined {
    return this.#byId.get(id);
  }

  list(): Workspace[] {
    // 按授权时间正序：列表顺序不随内部 Map 的插入顺序漂移
    return [...this.#byId.values()].sort((a, b) => a.grantedAt - b.grantedAt);
  }

  /**
   * 返回 root 与 target 匹配**最长**的那个工作区。
   *
   * 为什么必须「最长」而不是「第一个匹配」：
   *   `/a` 与 `/a/b` 同时授权时，`/a/b/x` 应归 `/a/b`。
   *   取第一个匹配会让归属随**授权顺序**变化 —— 授权顺序一变，行为就变了，
   *   而"行为随无关操作改变"是最难排查的一类 bug。
   *
   * @param onlyId 给定时只在该工作区内匹配。文件系统通道**必须**带上它：
   *   否则 A 工作区里的 `../` 恰好落进同样已授权的 B 工作区时会照样放行。
   */
  findOwning(target: string, onlyId?: string): Workspace | null {
    const t = normalizePath(target);
    if (t === null) return null;

    let best: Workspace | null = null;
    let bestLen = -1;
    for (const ws of this.#byId.values()) {
      if (onlyId !== undefined && ws.id !== onlyId) continue;
      if (!isWithinPath(t, ws.root, this.#caseInsensitive)) continue;
      if (ws.root.length > bestLen) {
        best = ws;
        bestLen = ws.root.length;
      }
    }
    return best;
  }

  get size(): number {
    return this.#byId.size;
  }

  #findByRoot(root: string): Workspace | undefined {
    for (const ws of this.#byId.values()) {
      if (isWithinPath(root, ws.root, this.#caseInsensitive) && isWithinPath(ws.root, root, this.#caseInsensitive)) {
        return ws;
      }
    }
    return undefined;
  }

  #label(raw: string | undefined, root: string): string {
    const trimmed = raw?.trim();
    if (trimmed !== undefined && trimmed.length > 0) return trimmed.slice(0, this.#maxLabelLength);
    // 缺省取末级目录名（`/a/b/c` → `c`；根路径退回整串，不返回空 label）
    const segments = root.split('/').filter((s) => s.length > 0);
    const last = segments[segments.length - 1];
    return (last ?? root).slice(0, this.#maxLabelLength);
  }
}
