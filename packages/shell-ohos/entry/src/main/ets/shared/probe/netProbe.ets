/**
 * T2 spike · 鸿蒙模拟器 → 宿主机 的网络可达性
 *
 * ## 要回答的三个问题
 *
 * 1. `ohos.permission.INTERNET` 到底是不是**必需**的？（先不加权限跑一次，记录报错）
 * 2. 模拟器访问宿主机 `:3901`，三种方式哪种通：
 *      a. `http://127.0.0.1:3901`（模拟器自己 → 显然不通？要实测）
 *      b. `http://192.168.1.6:3901`（宿主机局域网 IP）
 *      c. `hdc rport` 反向端口转发后再走 a
 * 3. 明文 `http://` 会不会被平台策略拦（等价 Android 的 cleartext 限制）？
 *
 * ## 为什么端口是 3901 而不是计划里写的 3001
 *
 * 计划 T2 原文写的是 `:3001`，但本机 3001 已经被一个反向代理占着
 * （访问它返回 `502 upstream connect failed`）。T2 的意图是"证实有宿主机的可达通路"，
 * 用一个**确定空闲**的端口更干净、也排除了"代理在中间捣鬼"这个变量。
 *
 * ## 为什么结果要 console.error 打印
 *
 * 探针跑在模拟器里，唯一能把证据带出来的通道是 hilog。
 * 统一前缀 `[NETPROBE]` 是为了 `hdc shell hilog | grep NETPROBE` 能一网打尽。
 */

import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';

export interface NetProbeResult {
  readonly url: string;
  readonly ok: boolean;
  readonly detail: string;
}

const HOST_LAN_IP = '192.168.1.6';
const HOST_PORT = 3901;

/** 打一条请求，**绝不抛** —— 成败都变成可断言的字符串。 */
export async function probeUrl(url: string): Promise<NetProbeResult> {
  const client = http.createHttp();
  try {
    const res = await client.request(url, {
      method: http.RequestMethod.GET,
      connectTimeout: 4000,
      readTimeout: 4000,
    });
    let body = '';
    if (typeof res.result === 'string') {
      body = res.result;
    }
    const ok: boolean = res.responseCode === 200 && body.indexOf('pong') >= 0;
    return { url, ok, detail: `code=${res.responseCode} body=${body.slice(0, 32)}` };
  } catch (err) {
    // 把 BusinessError 的 code 单独拎出来 —— 「权限被拒(201)」与「连不上(2300007)」
    // 必须能区分，否则整张 T2 结论就只剩一句"失败了"。
    const e: BusinessError = err as BusinessError;
    return { url, ok: false, detail: `throw code=${e.code} msg=${e.message}` };
  } finally {
    client.destroy();
  }
}

/** 三种方式各打一次，结果既返回给 UI、也写进 hilog。 */
export async function runNetProbe(): Promise<NetProbeResult[]> {
  const targets: string[] = [
    `http://127.0.0.1:${HOST_PORT}/ping`,
    `http://${HOST_LAN_IP}:${HOST_PORT}/ping`,
    `http://localhost:${HOST_PORT}/ping`,
  ];
  console.error(`[NETPROBE] BEGIN targets=${targets.length}`);
  const out: NetProbeResult[] = [];
  for (const url of targets) {
    const r = await probeUrl(url);
    console.error(`[NETPROBE] url=${r.url} ok=${r.ok} ${r.detail}`);
    out.push(r);
  }
  console.error('[NETPROBE] END');
  return out;
}
