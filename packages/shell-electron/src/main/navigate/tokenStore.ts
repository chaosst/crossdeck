/**
 * navigate 凭据存储 —— Electron 壳。
 *
 * 单独一个文件是因为**凭据与流无关**。两条硬规则：
 *   ① 优先 `safeStorage`（DPAPI / Keychain）加密后落盘；
 *   ② 加密不可用时**如实降级并标注**（`status().note`），**不许静默明文**。
 *
 * ⚠️ 本文件 `import 'electron'`，只能在主进程加载；`navigate/client.ts` 刻意
 *    不 import electron（凭据外部注入），所以 client 能不带 Electron 单独验证。
 */

import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 落盘信封。带 `v` 是为了将来改格式时能识别旧文件，而不是靠猜。 */
interface Envelope {
  readonly v: 1;
  /** `true` = `data` 是 safeStorage 密文的 base64；`false` = `data` 就是明文。 */
  readonly enc: boolean;
  readonly data: string;
}

export interface TokenStoreStatus {
  readonly hasToken: boolean;
  /** 是否**真的**加密落盘。`false` = 已诚实降级（见 `note`）。 */
  readonly encrypted: boolean;
  /** 磁盘上是否真的有这份文件（内存里临时持有的 token 不算）。 */
  readonly persisted: boolean;
  /** 一句话说明，直接可给 UI 显示。 */
  readonly note: string;
}

export interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
  status(): TokenStoreStatus;
}

const FILE_NAME = 'navigate-token.json';

export function createTokenStore(): TokenStore {
  /** 读过盘了吗（`null` 也要缓存 —— 否则每次取 token 都打一次磁盘）。 */
  let loaded = false;
  let cached: string | null = null;
  let lastEncrypted = false;
  let lastNote = '尚未保存凭据';

  const filePath = (): string => join(app.getPath('userData'), FILE_NAME);

  /**
   * `isEncryptionAvailable()` 在某些会话下会抛（比如 Linux 上没有 keyring 后端）。
   * 抛了就是"不可用" —— 让它冒泡会把一次取 token 变成一次崩溃。
   */
  const encryptionAvailable = (): boolean => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  const load = (): void => {
    if (loaded) return;
    loaded = true;

    const p = filePath();
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch {
      // 文件不存在是**正常**的：从没登录过。不该警告。
      return;
    }

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      lastNote = '凭据文件解析失败（已忽略，请重新登录）';
      console.warn(`[navigate] ${lastNote}：${p}`);
      return;
    }

    if (envelope.enc) {
      try {
        cached = safeStorage.decryptString(Buffer.from(envelope.data, 'base64'));
        lastEncrypted = true;
        lastNote = '凭据已加密保存（safeStorage）';
      } catch {
        // 换了机器 / 换了系统用户 / Windows 凭据被重置 → 密文解不开。
        // 这里**不能**退化成"把密文当 token 用"，那会把 401 伪装成"token 过期"。
        lastNote = '凭据无法解密（可能换了机器或系统用户，已忽略，请重新登录）';
        console.warn(`[navigate] ${lastNote}：${p}`);
      }
      return;
    }

    cached = envelope.data;
    lastEncrypted = false;
    lastNote = '系统安全存储不可用：凭据是**明文**存在磁盘上的';
    console.warn(`[navigate] ${lastNote}：${p}`);
  };

  return {
    get(): string | null {
      load();
      return cached;
    },

    set(token: string): void {
      const p = filePath();
      mkdirSync(dirname(p), { recursive: true });

      let envelope: Envelope;
      if (encryptionAvailable()) {
        envelope = { v: 1, enc: true, data: safeStorage.encryptString(token).toString('base64') };
        lastEncrypted = true;
        lastNote = '凭据已加密保存（safeStorage）';
      } else {
        // 如实降级：**写明文但明确标注**，而不是假装加密了。
        // 若要更严，可改成"只留在内存"（代价：重启后要重新登录）——
        // 那是口径变更，得先写进文档，别悄悄改。
        envelope = { v: 1, enc: false, data: token };
        lastEncrypted = false;
        lastNote = '系统安全存储不可用：凭据是**明文**存在磁盘上的';
        console.warn(`[navigate] ${lastNote}：${p}`);
      }

      writeFileSync(p, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
      cached = token;
      loaded = true;
    },

    clear(): void {
      const p = filePath();
      rmSync(p, { force: true });
      cached = null;
      loaded = true;
      lastEncrypted = false;
      lastNote = '已登出，凭据已清除';
    },

    status(): TokenStoreStatus {
      load();
      return {
        hasToken: cached !== null && cached.length > 0,
        encrypted: lastEncrypted,
        persisted: existsSync(filePath()),
        note: lastNote,
      };
    },
  };
}

/**
 * 壳内单例。惰性 —— 构造时**不碰** `app`（`app.getPath` 必须等到 ready 之后），
 * 所有磁盘/safeStorage 访问都推迟到第一次 `get` / `set`。
 */
export const navigateTokenStore: TokenStore = createTokenStore();
