/**
 * 运行时模式 —— 由命令行开关决定，不依赖环境变量。
 *
 * 为什么不用 `NODE_ENV` / 自定义 env：
 *   npm scripts 在 Windows 下默认走 cmd.exe，`VAR=1 cmd` 这种写法不通用，
 *   得额外引 cross-env。命令行开关在所有平台上都一样，零依赖。
 */

export interface RuntimeConfig {
  /** 开发模式：渲染层由内嵌的 Vite dev server 提供（带 HMR） */
  readonly dev: boolean;
  /** 自检模式：加载 → 断言 → 截图 → 写报告 → 退出，用于可验证的端到端证据 */
  readonly selfcheck: boolean;
  /**
   * 更新 feed 探针：对着一个真实的 HTTP 静态更新源跑完
   * 「检查 → 发现新版本 → 下载 → 就绪」，然后打印哨兵退出。
   *
   * ⚠️ 只能在**打包后的产物**里跑：`isUpdateSupported()` 判的是 `app.isPackaged`，
   *    未打包形态下 updater 会直接走 UNSUPPORTED 分支，什么链路都验不到。
   *    调用方见 scripts/verify-update-feed.mjs。
   */
  readonly updateProbe: boolean;
  /**
   * 探针期望从 feed 里读到的版本号。
   *
   * 为什么由命令行传入而不是在探针里写死：版本号同时被脚本用来生成 latest.yml，
   * 写死就会出现"两份 9.9.9"，改一处忘一处时探针会拿错误的原因失败。
   */
  readonly expectVersion: string | null;
}

export function parseArgs(argv: readonly string[]): RuntimeConfig {
  const expectArg = argv.find((a) => a.startsWith('--expect-version='));
  return {
    dev: argv.includes('--dev'),
    selfcheck: argv.includes('--selfcheck'),
    updateProbe: argv.includes('--update-feed-probe'),
    expectVersion: expectArg === undefined ? null : expectArg.slice('--expect-version='.length),
  };
}

/**
 * 进程内单例。
 *
 * 用可变单例而不是到处透传：窗口创建散落在 window:open handler 和启动流程里，
 * 逐个透传 config 会让每个函数签名都被这个与业务无关的开关污染。
 * 代价是"隐式依赖"，所以只允许 runtimeConfig.ts 一处持有，读取一律走 runtimeConfig()。
 */
let current: RuntimeConfig = { dev: false, selfcheck: false, updateProbe: false, expectVersion: null };

export function setRuntimeConfig(next: RuntimeConfig): void {
  current = next;
}

export function runtimeConfig(): RuntimeConfig {
  return current;
}
