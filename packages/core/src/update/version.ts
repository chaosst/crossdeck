/**
 * 版本比较与「该不该升级」的判定 —— 纯逻辑，因此可被完全确定地验证。
 *
 * 为什么这段东西值得进 core，而不是塞在壳的 updater 里：
 *
 *   它的失败方式全是**静默**的。写错不会崩，只会：
 *     · 把 1.10.0 判成比 1.9.0 旧（字符串比较的经典坑）→ 用户永远收不到更新
 *     · 把 1.0.0-beta.1 当成正式版推给已装 1.0.0 的用户 → 实际是降级
 *     · 把 1.0.0+20260101 判成比 1.0.0 新 → 每轮检查都提示"有新版本"
 *     · 允许降级 → 被劫持的 feed 可以把用户"更新"回一个含漏洞的旧版
 *   这四种一个异常都不抛，只表现为「更新功能好像有点怪」。
 *
 *   而它又完全不平台相关：没有网络、没有文件系统、没有 electron。
 *   把它留在壳里，就意味着每加一个壳就要重写一遍这段最容易写错的判定 ——
 *   和 `resolveInWorkspace` 下沉是同一个理由。
 *
 * 规范依据：SemVer 2.0.0 的 precedence 规则。
 */

export interface VersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** 预发布标识符，如 `beta.2` → `['beta', '2']`。空数组表示正式版。 */
  readonly prerelease: readonly string[];
  /** build metadata。**不参与比较**（SemVer 规定），仅在展示时保留。 */
  readonly build?: string;
  /** 归一化后的字符串形式（去掉 `v` 前缀、补全缺失段）。 */
  readonly normalized: string;
}

/** `v1.2.3-beta.2+build.99` */
const VERSION_RE = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/;

/** 数字段不允许前导零：`1.02.3` 是非法版本，不是"1.2.3 的另一种写法"。 */
function numericSegment(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (raw.length > 1 && raw.startsWith('0')) return null;
  if (raw.length > 9) return null; // 防溢出，也挡住明显的垃圾输入
  return Number(raw);
}

export function parseVersion(raw: string): VersionParts | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const m = VERSION_RE.exec(trimmed);
  if (m === null) return null;

  const major = numericSegment(m[1]);
  const minor = numericSegment(m[2]);
  const patch = numericSegment(m[3]);
  if (major === null || minor === null || patch === null) return null;

  // 预发布段：这里**刻意宽松**（允许 `01` 这类前导零）。
  // SemVer 认为它非法，但放宽只会让一个畸形版本串被接受，
  // 不会导致错误的升级决策 —— 而收紧会让某些真实 feed 直接解析失败。
  const prerelease = m[4] === undefined ? [] : m[4].split('.').filter((s) => s.length > 0);
  if (m[4] !== undefined && prerelease.length === 0) return null;

  const build = m[5];

  const base = `${major}.${minor}.${patch}`;
  const normalized =
    (prerelease.length > 0 ? `${base}-${prerelease.join('.')}` : base) +
    (build !== undefined ? `+${build}` : '');

  // exactOptionalPropertyTypes：build 可能不存在时要**省略**这个键，而不是写成 undefined
  return build === undefined
    ? { major, minor, patch, prerelease, normalized }
    : { major, minor, patch, prerelease, build, normalized };
}

function isNumericIdentifier(id: string): boolean {
  return /^\d+$/.test(id);
}

/**
 * 预发布标识符的逐个比较（SemVer §11.4）：
 *   1. 数字标识符按数值比
 *   2. 数字标识符**永远小于**字母标识符
 *   3. 都是字母时按 ASCII 序
 *   4. 前缀相同时，标识符多的那个更大
 */
function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // 没有预发布段 = 正式版，**高于**任何预发布
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    const xNum = isNumericIdentifier(x);
    const yNum = isNumericIdentifier(y);

    if (xNum && yNum) {
      const nx = Number(x);
      const ny = Number(y);
      if (nx !== ny) return nx < ny ? -1 : 1;
      continue;
    }
    // 数字 < 字母
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }

  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/** 返回 -1 / 0 / 1。build metadata **不参与**。 */
export function compareVersions(a: VersionParts, b: VersionParts): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * 升级决策。刻意用**判别联合**而不是 `{ shouldUpdate: boolean; reason?: string }`：
 * 后者会让调用方顺手只判 `shouldUpdate`，于是 `downgrade-refused` 与 `invalid`
 * 这两种"必须如实告诉用户"的情况被静默吞掉。
 */
export type UpdateDecision =
  | { readonly kind: 'up-to-date' }
  | { readonly kind: 'update'; readonly from: string; readonly to: string }
  | { readonly kind: 'downgrade-refused'; readonly from: string; readonly to: string }
  | { readonly kind: 'invalid'; readonly reason: 'current' | 'candidate' };

export interface UpdatePolicy {
  /** 允许"更新"到更旧的版本。默认 false —— 被劫持的 feed 能借此把用户推回漏洞版。 */
  readonly allowDowngrade?: boolean;
  /**
   * 允许收到预发布版本。默认 false。
   *
   * 注意它**不拦"毕业"**：已装 `1.1.0-beta.2` 的用户收到正式版 `1.1.0` 时，
   * 即使没开这个开关也必须能升 —— 否则预发布用户会被永久困在预发布通道里。
   */
  readonly allowPrerelease?: boolean;
}

export function decideUpdate(current: string, candidate: string, policy: UpdatePolicy = {}): UpdateDecision {
  const cur = parseVersion(current);
  if (cur === null) return { kind: 'invalid', reason: 'current' };
  const cand = parseVersion(candidate);
  if (cand === null) return { kind: 'invalid', reason: 'candidate' };

  const cmp = compareVersions(cand, cur);

  if (cmp === 0) return { kind: 'up-to-date' };

  if (cmp > 0) {
    const isPrerelease = cand.prerelease.length > 0;
    if (isPrerelease && policy.allowPrerelease !== true) {
      // 不是"没更新"，是"这个更新我们不收" —— 但两者对用户的呈现相同，
      // 所以归到 up-to-date，避免 UI 显示一个点不动的"发现新版本"。
      return { kind: 'up-to-date' };
    }
    return { kind: 'update', from: cur.normalized, to: cand.normalized };
  }

  // cmp < 0：候选更旧
  if (policy.allowDowngrade === true) {
    return { kind: 'update', from: cur.normalized, to: cand.normalized };
  }
  return { kind: 'downgrade-refused', from: cur.normalized, to: cand.normalized };
}
