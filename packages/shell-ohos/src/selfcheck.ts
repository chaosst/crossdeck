/**
 * 页面内自检 —— 驱动共享 UI 的 `data-testid` 走完一条业务链路。
 *
 * **为什么必须搬进页面**：ArkWeb 在 `uitest dumpLayout` 里是一个 `Web` 节点，
 * 点不到 DOM 子控件（P3 文档 §1.1 第 2 条）。设备脚本只做三件事：
 * 装 → 起（`--ps selfcheck 1`）→ `hdc hilog` grep + 判定。
 *
 * 驱动器（`runUiProbe`）在 `@crossdeck/ui`，与 Web 壳共用 —— 断言名一个字不差，
 * 判定表（`parse-ohos-selfcheck.mjs`）才敢按名字取数。这里只提供鸿蒙专属前置：
 * 词表经 selfcheck 端口从 ArkTS 侧拉（页面 origin 是自建域，跨源 fetch 会被 CORS 拦），
 * 登录态以端口里的 token 为准。
 */

import { runUiProbe } from '@crossdeck/ui';
import type { UiFixture } from '@crossdeck/ui';
import type { PortCaller } from './rpc';
import { fail } from './errors';

/**
 * 回传报告：`crossdeckHost.report(json)` 是 ArkTS 注册的**同步** proxy
 * （invoke 不走 proxy —— asyncMethodList 不返回 Promise，探针已证），
 * ArkTS 侧按 700 字符分片打 `[SELFCHECK]` 行（hilog 单条有长度上限）。
 */
function report(json: string): void {
  const host = (window as unknown as { crossdeckHost?: { report(json: string): void } }).crossdeckHost;
  if (host === undefined) {
    console.error('[selfcheck] crossdeckHost proxy 不存在（非设备形态？）—— 报告只进 console');
    console.log(json);
    return;
  }
  host.report(json);
}

export async function runOhosSelfCheck(rpc: PortCaller): Promise<void> {
  const failures: string[] = [];
  const probe: Record<string, unknown> = {};
  const check = (name: string, condition: boolean, detail?: unknown): void => {
    if (!condition) failures.push(name);
    probe[name] = detail === undefined ? condition : detail;
  };

  // 桥接本身先验一发：端口 RTT 内 system:info 应答即"通道活着"
  try {
    const info = await rpc.call<{ platform: string; capabilities: string[] }>('system', 'info', null);
    check('bridge.systemInfoReachable', info.platform === 'ohos', info);
  } catch (err) {
    check('bridge.systemInfoReachable', false, err instanceof Error ? err.message : String(err));
  }

  await runUiProbe(check, probe, {
    fixture: async () => {
      try {
        return await rpc.call<UiFixture>('selfcheck', 'fixture', null);
      } catch (err) {
        fail('UPSTREAM', `取不到场景词表：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    loginPersisted: async () => {
      try {
        const status = await rpc.call<{ login: { hasToken: boolean } }>('navigate', 'status', null);
        return status.login.hasToken;
      } catch {
        return false;
      }
    },
  });

  report(
    JSON.stringify({
      shell: 'ohos-web',
      ok: failures.length === 0,
      failures,
      probe,
    }),
  );

  // 哨兵：判定以它为准（设备上经 onConsole 进 hilog；浏览器桩里进 CDP console）。
  console.log(`[selfcheck] DONE ok=${failures.length === 0} code=${failures.length === 0 ? 0 : 1}`);
}
