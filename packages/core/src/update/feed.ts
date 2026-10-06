import { compareVersions, decideUpdate, parseVersion } from './version.js';
import type { UpdatePolicy, VersionParts } from './version.js';

/**
 * 从一份"可安装版本清单"里挑出该装的那一个。
 *
 * 为什么这段在 core：
 *   它是纯决策 —— 输入一串版本号 + 当前版本 + 策略，输出"装这个"或"没有"。
 *   没有网络、没有 electron、不知道 feed 是 yml 还是 HTTP JSON。
 *   而且它的失败同样是**静默**的：挑错一个不会抛异常，只会让用户装到
 *   更旧的版本、或者被推进预发布通道 —— 那就必须能被断言钉住。
 *
 * 与本文件同一目录的 version.ts 的关系：
 *   version.ts 管"这两个版本谁新"（单个判定），这里管"一串候选里选哪个"
 *   （遍历 + 取最大 + 应用策略）。策略本身仍然只有 version.ts 一份定义。
 *
 * `FeedRelease` 刻意用**结构类型**而不是 import 契约的 UpdateInfo：
 *   契约的 UpdateInfo 形状与它一致，可以直接传进来；反过来 core 也不必
 *   为了一个字段列表去依赖契约的某个具体接口（那边加字段不该让 core 编译失败）。
 */
export interface FeedRelease {
  /** 原始版本号，可能带 `v` 前缀 —— 归一化由 parseVersion 负责 */
  readonly version: string;
  readonly notes?: string;
  readonly releasedAt?: number;
}

/** 被拒的候选，带原因 —— 用于日志/诊断，不用于 UI。 */
export interface RejectedRelease {
  readonly version: string;
  readonly reason: 'invalid' | 'downgrade' | 'prerelease' | 'not-newer';
}

export interface UpgradeSelection {
  /** 该装的版本；null 表示"没有可装的" */
  readonly picked: FeedRelease | null;
  readonly rejected: readonly RejectedRelease[];
}

/**
 * 挑选时**只**接受这一个策略开关。
 *
 * 刻意不收 `UpdatePolicy` 全量：那个类型里还有 `allowDowngrade`，
 * 而 allowDowngrade 是"用户指定了某个具体版本，允许重装更旧的"这条路径的开关
 * （见 update:install），与"要不要提示用户升级"是**两个不同的问题**。
 * 让本函数拿不到它，就把"把降级当升级推给用户"这件事在类型上写不出来了 ——
 * 而不是靠注释提醒。
 */
export interface UpgradeChannel {
  /** 用户是否选择了接收预发布版本。默认 false。 */
  readonly allowPrerelease?: boolean;
}

/**
 * 挑出**最高的、被策略接受**的候选。
 *
 * 关键行为（每一条都对应一种真实坏情况）：
 *   1. 清单里有一条畸形版本（`1.2.x` / 空串）**不能**让整份清单报废 ——
 *      跳过它，继续看后面的。feed 是全自动生成的，一条脏数据不该让更新功能停摆。
 *   2. 更旧的版本不是"可装的"，即使策略开了 allowDowngrade ——
 *      这个函数回答的是"该不该提示用户升级"，答案永远不是"提示他降级"。
 *      allowDowngrade 只在**用户主动指定**某个版本的场景下用（见 update:install）。
 *   3. 预发布默认不收；但"从预发布毕业到正式版"必须收（由 version.ts 保证）。
 *   4. 从被接受的候选里取**最高**的那个，而不是清单里的第一个 ——
 *      feed 顺序不是契约，把第一个当答案会在 feed 倒序时静默装错版本。
 */
export function selectUpgrade(
  current: string,
  releases: readonly FeedRelease[],
  channel: UpgradeChannel = {},
): UpgradeSelection {
  const rejected: RejectedRelease[] = [];
  let picked: FeedRelease | null = null;
  let pickedParts: VersionParts | null = null;

  // allowDowngrade 恒为 false：本函数回答的是"该不该提示用户升级"，
  // 对这个问题来说答案永远不是"提示他降级"。即使调用方硬塞一个带
  // allowDowngrade 的对象进来（JS 侧没有类型保护），也只会被忽略。
  const policy: UpdatePolicy = { allowPrerelease: channel.allowPrerelease === true };

  for (const release of releases) {
    const parts = parseVersion(release.version);
    if (parts === null) {
      rejected.push({ version: release.version, reason: 'invalid' });
      continue;
    }

    const decision = decideUpdate(current, release.version, policy);
    if (decision.kind !== 'update') {
      rejected.push({
        version: release.version,
        reason:
          decision.kind === 'invalid'
            ? 'invalid'
            : decision.kind === 'up-to-date'
              ? 'not-newer'
              : // downgrade-refused 与"候选更旧"在决策里已被 allowDowngrade 分开了：
                // 走到这里说明候选更旧且策略没放行。对"该不该升级"这个问题，
                // 它和 not-newer 的答案是同一个，但原因不同，分开记便于诊断。
                'downgrade',
      });
      continue;
    }

    // 取最高：不能假设 feed 是按版本倒序排的
    if (pickedParts === null || compareVersions(parts, pickedParts) > 0) {
      picked = release;
      pickedParts = parts;
    }
  }

  return { picked, rejected };
}

/**
 * 把候选版本折成可展示的字符串（去掉 `v` 前缀等）。
 * feed 里的版本号是给机器比的，展示给用户时必须和 `app.getVersion()` 同一种写法 ——
 * 否则 UI 上会同时出现 `v1.10.0` 和 `1.9.0` 两种风格。
 */
export function normalizeVersionLabel(raw: string): string {
  return parseVersion(raw)?.normalized ?? raw.trim();
}
