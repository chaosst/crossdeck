import type { SessionMeta } from '@crossdeck/contract';

/**
 * SessionStore —— core 里第一个**真实**模块（不是空壳）。
 *
 * 它存在的意义不是"管会话"，而是证明分层不是口号：
 *   - 零 import：没有 node:* / electron / @ohos.*，纯 TypeScript
 *   - 时钟与 id 生成都从构造参数注入 —— 这让 core 可以在测试里被完全确定化，
 *     也让"核不依赖环境"从一句话变成构造签名上的约束
 *
 * ⚠️ 注意 `lib` 只有 ES2022（没有 DOM，也没有 @types/node）。
 *    所以这里**故意不能**写 `crypto.randomUUID()` 或 `Date.now()` 的类型依赖 ——
 *    一旦有人给 core 加了 DOM/node 类型，就说明边界已经开始被侵蚀。
 */

export interface SessionStoreOptions {
  /** 注入时钟，便于测试与回放。默认 Date.now */
  now?: () => number;
  /** 注入 id 生成器。默认取 globalThis.crypto.randomUUID，取不到则降级 */
  newId?: () => string;
  /** 标题最大长度，超出截断。默认 64 */
  maxTitleLength?: number;
}

const DEFAULT_TITLE = 'New chat';

/**
 * 结构化地取全局 crypto —— 不写 `crypto.randomUUID()` 的直接引用，
 * 因为 core 的 lib 里没有 DOM / node 类型，写了就编译不过。
 * 这个「刻意绕一下」本身就是边界的证据：core 不该知道宿主长什么样。
 */
function defaultNewId(): string {
  const holder = globalThis as {
    crypto?: { randomUUID?: () => string };
  };
  const uuid = holder.crypto?.randomUUID;
  if (typeof uuid === 'function') {
    return holder.crypto!.randomUUID!();
  }
  // 降级路径：宿主没有标准 crypto（旧 WebView / 受限沙箱）时仍可用，
  // 代价是 id 只保证进程内唯一，不保证跨进程碰撞概率为 0。
  return `s_${Date.now().toString(36)}_${Math.floor(Math.random() * 0x7fffffff).toString(36)}`;
}

export class SessionStore {
  readonly #sessions = new Map<string, SessionMeta>();
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #maxTitleLength: number;

  constructor(opts: SessionStoreOptions = {}) {
    this.#now = opts.now ?? (() => Date.now());
    this.#newId = opts.newId ?? defaultNewId;
    this.#maxTitleLength = opts.maxTitleLength ?? 64;
  }

  /**
   * 新建会话。
   * `exactOptionalPropertyTypes` 开着，所以 title 缺省时**不能**写成
   * `title: input.title ?? DEFAULT` 之后再赋 undefined —— 这里显式归一化。
   */
  create(input: { title?: string } = {}): SessionMeta {
    const now = this.#now();
    const raw = input.title?.trim();
    const title = raw && raw.length > 0 ? raw.slice(0, this.#maxTitleLength) : DEFAULT_TITLE;

    const meta: SessionMeta = {
      id: this.#newId(),
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };

    this.#sessions.set(meta.id, meta);
    return meta;
  }

  get(id: string): SessionMeta | undefined {
    return this.#sessions.get(id);
  }

  /** 按最近更新倒序 —— 列表页要的是"最近用过的在最上面"。 */
  list(): SessionMeta[] {
    return [...this.#sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): boolean {
    return this.#sessions.delete(id);
  }

  /** 消息数 +1 并刷新 updatedAt；返回更新后的元信息，会话不存在则 undefined。 */
  bumpMessageCount(id: string): SessionMeta | undefined {
    const cur = this.#sessions.get(id);
    if (!cur) return undefined;

    const next: SessionMeta = {
      ...cur,
      messageCount: cur.messageCount + 1,
      updatedAt: this.#now(),
    };
    this.#sessions.set(id, next);
    return next;
  }

  get size(): number {
    return this.#sessions.size;
  }
}
