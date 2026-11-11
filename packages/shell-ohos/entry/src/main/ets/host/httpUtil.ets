/** ArkTS 侧的 HTTP 小工具 —— 只做"一次请求"，返回不抛（成败都要可断言）。 */
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

export class HttpResult {
  ok: boolean = false;
  status: number = 0;
  body: string = '';
  detail: string = '';
}

/** 凭据一律走 URL（navigate 的 `?token=` 约定），所以这里没有 auth 头这一支。 */
export async function httpRequestText(
  url: string,
  method: http.RequestMethod,
  bodyJson: string | null,
  timeoutMs: number,
): Promise<HttpResult> {
  const client = http.createHttp();
  try {
    const options: http.HttpRequestOptions = bodyJson === null
      ? {
          method: method,
          header: { 'accept': 'application/json' },
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs,
        }
      : {
          method: method,
          header: { 'accept': 'application/json', 'content-type': 'application/json' },
          extraData: bodyJson,
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs,
        };
    const res = await client.request(url, options);
    const result = new HttpResult();
    result.status = res.responseCode;
    result.ok = res.responseCode >= 200 && res.responseCode < 300;
    result.body = typeof res.result === 'string' ? res.result : '';
    if (!result.ok) result.detail = `HTTP ${res.responseCode}`;
    return result;
  } catch (e) {
    const err = e as BusinessError<void>;
    const r = new HttpResult();
    r.detail = err.message !== undefined && err.message.length > 0 ? `${err.message}（code=${err.code}）` : `code=${err.code}`;
    return r;
  } finally {
    client.destroy();
  }
}
