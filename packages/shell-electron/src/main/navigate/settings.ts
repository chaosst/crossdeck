/**
 * 上游地址的**本地持久化** —— Electron 壳。
 *
 * 为什么必须落盘：配置通道的整个意义是"用户填一次地址，之后一直连它"。
 * 只放内存的话每次重启都要重填 —— 那这个通道等于没做。
 *
 * 为什么不跟凭据放同一个文件：两者的敏感性完全不同。这个文件是**明文**的、
 * 可以贴进 issue 的；凭据那个必须加密、且不允许出现在任何日志里。
 * 混在一起的结果是"要么把地址也加密（没必要），要么把凭据也明文（危险）"。
 */

import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 落盘信封。带 `v` 是为了将来改格式时能识别旧文件，而不是靠猜。 */
interface Envelope {
  readonly v: 1;
  /** `null` = 用户明确清空过 → 退回脚本上游。与"从没配过"在行为上等价，但记录得下来。 */
  readonly upstreamUrl: string | null;
}

export interface NavigateSettings {
  getUpstreamUrl(): string | null;
  setUpstreamUrl(value: string | null): void;
}

const FILE_NAME = 'navigate-settings.json';

export function createNavigateSettings(): NavigateSettings {
  /** 读过盘了吗（`null` 也要缓存 —— 否则每次都打一次磁盘）。 */
  let loaded = false;
  let cached: string | null = null;

  const filePath = (): string => join(app.getPath('userData'), FILE_NAME);

  const load = (): void => {
    if (loaded) return;
    loaded = true;

    const p = filePath();
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch {
      // 文件不存在是正常的：从没配过。不该警告。
      return;
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      console.warn(`[navigate] 上游配置文件解析失败（已忽略，请重新填写地址）：${p}`);
      return;
    }

    if (envelope.v !== 1) {
      console.warn(`[navigate] 上游配置文件版本不认识（v=${String(envelope.v)}，已忽略）：${p}`);
      return;
    }
    cached = typeof envelope.upstreamUrl === 'string' ? envelope.upstreamUrl : null;
  };

  return {
    getUpstreamUrl(): string | null {
      load();
      return cached;
    },

    setUpstreamUrl(value: string | null): void {
      const p = filePath();
      mkdirSync(dirname(p), { recursive: true });
      const envelope: Envelope = { v: 1, upstreamUrl: value };
      writeFileSync(p, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
      cached = value;
      loaded = true;
    },
  };
}

/**
 * 壳内单例。惰性 —— 构造时**不碰** `app.getPath`（它要等到 ready 之后才可靠），
 * 所有磁盘访问都推迟到第一次读写（那时 IPC handler 早已可被调用）。
 */
export const navigateSettings: NavigateSettings = createNavigateSettings();
