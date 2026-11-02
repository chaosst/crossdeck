/**
 * 打开外链前的**三道校验** —— 纯字符串解析，不用 `URL`（core 的 lib 里没有它）。
 *
 * 为什么不能直接把上游给的 URL 丢给 `shell.openExternal`：
 * 那等于把「打开任意网址」的能力交给上游。协议与 host 必须白名单。
 */

export type OpenUrlReason = 'unparsable' | 'bad-scheme' | 'bad-host' | 'has-credentials';

export type OpenUrlDecision =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: OpenUrlReason };

/** `scheme://authority/rest` —— 只认这一段形状，别的一律当作不可解析。 */
const SHAPE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(.*)$/;

const ALLOWED_SCHEMES = new Set(['http', 'https']);

/** 只取协议头：`javascript:...` 没有 `//`，也要能被判成「协议不对」而不是「解析不了」。 */
const SCHEME_ONLY = /^([A-Za-z][A-Za-z0-9+.-]*):/;

/** 取 host（去掉端口，小写）。IPv6 字面量允许方括号。 */
function hostOf(authority: string): string {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return end === -1 ? '' : authority.slice(0, end + 1).toLowerCase();
  }
  const colon = authority.indexOf(':');
  return (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
}

/**
 * 校验一个待打开的外链。
 *
 * @param allowedHosts 白名单 host（小写、不带端口）。空数组 = 一律拒绝。
 */
export function checkOpenUrl(raw: string, allowedHosts: readonly string[]): OpenUrlDecision {
  const text = raw.trim();
  const schemeOnly = SCHEME_ONLY.exec(text);
  if (schemeOnly === null) return { ok: false, reason: 'unparsable' };
  const scheme = (schemeOnly[1] ?? '').toLowerCase();
  if (!ALLOWED_SCHEMES.has(scheme)) return { ok: false, reason: 'bad-scheme' };

  const matched = SHAPE.exec(text);
  if (matched === null) return { ok: false, reason: 'unparsable' };

  const authority = matched[2] ?? '';
  const rest = matched[3] ?? '';
  // `https://user:pass@host` 一律拒：凭据不该出现在能点开的链接里。
  if (authority.includes('@')) return { ok: false, reason: 'has-credentials' };

  const host = hostOf(authority);
  if (host.length === 0) return { ok: false, reason: 'bad-host' };
  if (!allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
    return { ok: false, reason: 'bad-host' };
  }

  return { ok: true, url: `${scheme}://${authority}${rest}` };
}

/** 从 `scheme://host:port/...` 里取 host，供调用方拼白名单。取不到返回 null。 */
export function hostOfUrl(raw: string): string | null {
  const matched = SHAPE.exec(raw.trim());
  if (matched === null) return null;
  const host = hostOf(matched[2] ?? '');
  return host.length === 0 ? null : host;
}

/** 给用户看的一句话。 */
export function describeOpenUrlReason(reason: OpenUrlReason): string {
  switch (reason) {
    case 'unparsable':
      return '链接格式无法解析，已拒绝打开';
    case 'bad-scheme':
      return '只允许 http / https 链接';
    case 'has-credentials':
      return '链接里带凭据，已拒绝打开';
    case 'bad-host':
      return '链接指向不受信任的站点，已拒绝打开';
  }
}
