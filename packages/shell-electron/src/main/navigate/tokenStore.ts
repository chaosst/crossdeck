/**
 * navigate 凭据存储 —— Electron 壳。
 *
 * 单独一个文件是因为**凭据与流无关**。三条硬规则：
 *   ① 优先 `safeStorage`（DPAPI / Keychain）加密后落盘；
 *   ② 加密不可用时**如实降级并标注**（`status().note`），**不许静默明文**；
 *   ③ 盘上只有一份凭据 —— 不敏感的地址在 `settings.ts`，两个文件不混。
 *
 * 存的不只是一个字符串：登录时上游会一并告知 `role` 与有效期，
 * 它们决定 UI 能说"以什么身份、还剩多久"。**token 永不跨 IPC** ——
 * `status()` 的返回类型（contract 的 `NavigateLoginStatus`）里没有这个字段。
 *
 * ⚠️ 本文件 `import 'electron'`，只能在主进程加载；`navigate/{client,auth}.ts` 刻意
 *    不 import electron（凭据外部注入），所以那两个能不带 Electron 单独验证。
 */

import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { NavigateLoginStatus, NavigateRole } from '@crossdeck/contract';
import type { NavigateSession } from '@crossdeck/core';

/**
 * 落盘信封。
 *
 * `v` 不是装饰：v1 只存了 token，v2 存了完整会话 JSON。没有版本号就只能"试着解析
 * 一下看像不像 JSON" —— 而一个以 `{` 开头的 token 会让那种猜测静默走错分支。
 */
interface Envelope {
  readonly v: 1 | 2;
  /** `true` = `data` 是 safeStorage 密文的 base64；`false` = `data` 就是明文。 */
  readonly enc: boolean;
  readonly data: string;
}

/**
 * 内存里的凭据。
 *
 * `role` / `expiresAt` 允许为 `null` —— **v1 旧文件里没存过这两样**，
 * 那就是"不知道"，不许编一个具体值出来（编成 guest 会让 UI 说一句它并不知道的话）。
 */
interface Credential {
  readonly token: string;
  readonly role: NavigateRole | null;
  readonly expiresAt: number | null;
}

/** v2 的明文形态（写盘用）。 */
interface SessionPayload {
  readonly token: string;
  readonly role: NavigateRole;
  readonly expiresAt: number;
}

export interface TokenStore {
  /** 当前 token（流式问答只要这个）。没有则 `null`。 */
  get(): string | null;
  set(session: NavigateSession): void;
  clear(): void;
  /** 给 UI 看的登录态。**不含 token**。 */
  status(): NavigateLoginStatus;
}

const FILE_NAME = 'navigate-token.json';

export function createTokenStore(): TokenStore {
  /** 读过盘了吗（`null` 也要缓存 —— 否则每次取 token 都打一次磁盘）。 */
  let loaded = false;
  let cached: Credential | null = null;
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

  /** 把 `data` 还原成明文串（`enc` 为真时先解密）。解不开返回 `null` 并写明原因。 */
  const decode = (envelope: Envelope, p: string): string | null => {
    if (!envelope.enc) return envelope.data;
    try {
      return safeStorage.decryptString(Buffer.from(envelope.data, 'base64'));
    } catch {
      // 换了机器 / 换了系统用户 / Windows 凭据被重置 → 密文解不开。
      // 这里**不能**退化成"把密文当 token 用"，那会把 401 伪装成"token 过期"。
      lastNote = '凭据无法解密（可能换了机器或系统用户，已忽略，请重新登录）';
      console.warn(`[navigate] ${lastNote}：${p}`);
      return null;
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

    if (envelope.v !== 1 && envelope.v !== 2) {
      lastNote = `凭据文件版本不认识（v=${String(envelope.v)}，已忽略，请重新登录）`;
      console.warn(`[navigate] ${lastNote}：${p}`);
      return;
    }

    const plain = decode(envelope, p);
    if (plain === null) return; // decode 已写好 note

    if (envelope.v === 1) {
      cached = { token: plain, role: null, expiresAt: null };
      lastEncrypted = envelope.enc;
      lastNote = '凭据是旧格式（只有 token，没有角色与有效期）—— 建议重新登录一次';
      return;
    }

    let payload: SessionPayload;
    try {
      payload = JSON.parse(plain) as SessionPayload;
    } catch {
      lastNote = '凭据内容解析失败（已忽略，请重新登录）';
      console.warn(`[navigate] ${lastNote}：${p}`);
      return;
    }

    // 形状不对就整份作废。凭据是最不该"尽力而为"的东西：一个认不出的 role
    // 被悄悄当成某个具体角色，等于让 UI 替上游撒一个谎。
    const role = payload.role === 'admin' || payload.role === 'guest' ? payload.role : null;
    if (typeof payload.token !== 'string' || payload.token.length === 0 || role === null) {
      lastNote = '凭据文件内容不符合契约（已忽略，请重新登录）';
      console.warn(`[navigate] ${lastNote}：${p}`);
      return;
    }

    cached = {
      token: payload.token,
      role,
      expiresAt: typeof payload.expiresAt === 'number' ? payload.expiresAt : null,
    };
    lastEncrypted = envelope.enc;
    lastNote = envelope.enc
      ? '凭据已加密保存（safeStorage）'
      : '系统安全存储不可用：凭据是**明文**存在磁盘上的';
    if (!envelope.enc) console.warn(`[navigate] ${lastNote}：${p}`);
  };

  return {
    get(): string | null {
      load();
      return cached?.token ?? null;
    },

    set(session: NavigateSession): void {
      const p = filePath();
      mkdirSync(dirname(p), { recursive: true });

      const payload: SessionPayload = {
        token: session.token,
        role: session.role,
        expiresAt: session.expiresAt,
      };
      const plain = JSON.stringify(payload);

      let envelope: Envelope;
      if (encryptionAvailable()) {
        envelope = { v: 2, enc: true, data: safeStorage.encryptString(plain).toString('base64') };
        lastEncrypted = true;
        lastNote = '凭据已加密保存（safeStorage）';
      } else {
        // 如实降级：**写明文但明确标注**，而不是假装加密了。
        // 若要更严，可改成"只留在内存"（代价：重启后要重新登录）——
        // 那是口径变更，得先写进文档，别悄悄改。
        envelope = { v: 2, enc: false, data: plain };
        lastEncrypted = false;
        lastNote = '系统安全存储不可用：凭据是**明文**存在磁盘上的';
        console.warn(`[navigate] ${lastNote}：${p}`);
      }

      writeFileSync(p, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
      cached = payload;
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

    status(): NavigateLoginStatus {
      load();
      return {
        hasToken: cached !== null && cached.token.length > 0,
        // v1 的 role/expiresAt 是"不知道"，如实给 null。
        role: cached?.role ?? null,
        expiresAt: cached?.expiresAt ?? null,
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
