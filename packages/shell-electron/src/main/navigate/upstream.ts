/**
 * 上游地址的**归一化与校验** —— 纯逻辑，刻意不 import electron（可被裸 Node 单独验证）。
 *
 * 为什么不能"存下用户填什么就是什么"：
 *   地址会被拼成 `${baseUrl}/api/...`。一个带尾斜杠的输入会拼出 `//api`（有的反代
 *   会 404），一个带 query 的输入会拼出 `http://h:3001?x/api/...`（纯垃圾，而且
 *   报错信息会指向"上游没有这个接口"——把用户的输入错误说成上游的问题）。
 *   所以在这里**收口**：要么给回一个干净的根地址，要么明确说哪里不对。
 *
 * ⚠️ 现在只有 Electron 壳需要它（配置通道是它独有的入口）。Web 壳的地址来自 URL 参数、
 *    鸿蒙壳来自常量 —— 等第二个壳也需要校验时再上提到 core，别提前抽。
 */

/** `value === null` 表示"清空"，语义是**退回脚本上游**（离线可跑），不是"错误"。 */
export type UpstreamInput = string | null;

export type UpstreamDecision =
  | { readonly ok: true; readonly value: string | null }
  | { readonly ok: false; readonly message: string };

/** 只允许这两种协议。白名单，不是黑名单 —— `javascript:` / `file:` 不该有被拼进 fetch 的机会。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function normalizeUpstreamUrl(input: UpstreamInput): UpstreamDecision {
  if (input === null) return { ok: true, value: null };

  const trimmed = input.trim();
  // 空串 = 清空（用户在输入框里删光了）。这与"填了个错地址"是两件事。
  if (trimmed === '') return { ok: true, value: null };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      message: `不是合法的绝对地址：${JSON.stringify(input)}（要形如 http://主机:端口）`,
    };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      message: `只支持 http / https，拿到的是 ${url.protocol}（${JSON.stringify(input)}）`,
    };
  }

  // 带凭据的 URL 会被写进诊断日志（`report({ type:'request', endpoint })`），
  // 那等于把账号密码落到日志文件里。要鉴权就走 token，不放 URL 里。
  if (url.username !== '' || url.password !== '') {
    return { ok: false, message: '地址里不许带用户名/密码 —— 鉴权走 token，不放 URL 里' };
  }

  // 拼路径时只取 origin + pathname，所以 query / hash 会被**静默丢掉**。
  // 与其丢掉，不如说清楚：写地址的人以为自己配上了，实际没有。
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, message: '地址里不许带 ?query 或 #hash —— 这里要的是一个根地址' };
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  return { ok: true, value: `${url.origin}${pathname}` };
}
