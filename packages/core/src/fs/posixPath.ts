/**
 * POSIX 风格的纯字符串路径运算 —— core 的路径地基层。
 *
 * 为什么不用 `node:path`：
 *   ① core 的铁律不允许（Web 壳里根本没有 `node:path`）；
 *   ② `node:path` 的行为**跟着宿主平台变**（win32 / posix 两套实现），
 *      而 core 需要的是「同一份输入在任何壳里得到同一个结论」。
 *
 * 所以这里只认 `/` 分隔的 POSIX 形态，`\` 的归一化也放在这一层：
 * 各壳在边界处（FsPort 实现里）负责把结果翻译回本机形式，
 * 而判定逻辑永远只跑在这一种形态上 —— 只有一种形态才不会有"两套正则在两处漂移"。
 */

/** `\` → `/`。这一步**必须**在所有比较之前做，否则 `a\..\b` 会被当成一个普通文件名。 */
export function toPosix(input: string): string {
  return input.replace(/\\/g, '/');
}

const DRIVE_ABSOLUTE = /^[A-Za-z]:\//;
/** 盘符相对形式（`C:foo`）—— 语义是「C 盘当前目录下的 foo」，纯字符串层面无法确定 */
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;

/** 是否绝对路径：`/x`（POSIX）或 `C:/x`（Windows）。 */
export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || DRIVE_ABSOLUTE.test(p);
}

/**
 * 归一化：折叠重复分隔符、解析 `.` 与 `..`。
 *
 * @returns 归一化后的路径；**非法输入返回 `null`**（调用方一律映射成 BAD_PATH，
 *   不要为"方便"放行 —— 放行一条无法归一的路径等于给逃逸开一个后门）：
 *   - 空串、含 NUL
 *   - 盘符相对形式 `C:foo`
 *   - 绝对路径上溯越出根（`/a/../..`）—— 不能退化成 `/`，那是"看起来合规"的逃逸
 */
export function normalizePath(input: string): string | null {
  if (input.length === 0) return null;
  if (input.includes('\0')) return null;
  if (DRIVE_RELATIVE.test(input)) return null;

  const p = toPosix(input);
  let prefix = '';
  let body = p;
  if (DRIVE_ABSOLUTE.test(p)) {
    prefix = p.slice(0, 2); // `C:`
    body = p.slice(2);
  }
  const absolute = prefix !== '' || body.startsWith('/');

  const out: string[] = [];
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) {
        out.pop();
        continue;
      }
      // 已经到顶还往上走
      if (absolute) return null;
      out.push('..'); // 相对路径：保留，交由调用方先拼成绝对路径
      continue;
    }
    out.push(seg);
  }

  const joined = out.join('/');
  if (prefix !== '') return joined === '' ? `${prefix}/` : `${prefix}/${joined}`;
  return absolute ? `/${joined}` : joined;
}

/**
 * 拼接。`base` 必须是绝对路径（否则 `..` 无处可解析）。
 * `rel` 为绝对路径时**直接采用**（是否放行由 PathGuard 决定，这里不做策略）。
 */
export function joinPath(base: string, rel: string): string | null {
  const b = normalizePath(base);
  if (b === null) return null;

  const r = toPosix(rel);
  if (isAbsolutePath(r)) return normalizePath(r);

  const trimmed = b.endsWith('/') ? b : `${b}/`;
  return normalizePath(`${trimmed}${r}`);
}

/** 大小写折叠（Windows / macOS 默认大小写不敏感）。 */
export function foldCase(p: string, caseInsensitive: boolean): string {
  return caseInsensitive ? p.toLowerCase() : p;
}

/**
 * `child` 是否落在 `parent` 之内（含相等）。
 *
 * ⚠️ 前缀必须按 `/` 对齐。少了这一步，`/a/bc` 会被 `/a/b` 的授权放行 ——
 *    这是路径校验里最经典的一个洞（"前缀匹配"看着对，其实是在匹配字符串）。
 */
export function isWithinPath(child: string, parent: string, caseInsensitive = false): boolean {
  const c = foldCase(child, caseInsensitive);
  const p = foldCase(parent, caseInsensitive);
  if (c === p) return true;
  const withSep = p.endsWith('/') ? p : `${p}/`;
  return c.startsWith(withSep);
}

/**
 * 上级目录。
 *
 * ⚠️ 已到根时**返回自身** —— 调用方靠它做「最近存在的祖先」上溯，
 *    返回空串或抛错都会让上溯循环失去终止条件。
 */
export function parentPath(p: string): string {
  const n = normalizePath(p);
  if (n === null) return p;

  const idx = n.lastIndexOf('/');
  if (idx < 0) return n; // 相对路径（单个段）
  if (idx === 0) return '/';

  const head = n.slice(0, idx);
  return /^[A-Za-z]:$/.test(head) ? `${head}/` : head;
}
