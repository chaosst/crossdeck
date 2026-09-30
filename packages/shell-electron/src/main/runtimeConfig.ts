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
}

export function parseArgs(argv: readonly string[]): RuntimeConfig {
  return {
    dev: argv.includes('--dev'),
    selfcheck: argv.includes('--selfcheck'),
  };
}

/**
 * 进程内单例。
 *
 * 用可变单例而不是到处透传：窗口创建散落在 window:open handler 和启动流程里，
 * 逐个透传 config 会让每个函数签名都被这个与业务无关的开关污染。
 * 代价是"隐式依赖"，所以只允许 runtimeConfig.ts 一处持有，读取一律走 runtimeConfig()。
 */
let current: RuntimeConfig = { dev: false, selfcheck: false };

export function setRuntimeConfig(next: RuntimeConfig): void {
  current = next;
}

export function runtimeConfig(): RuntimeConfig {
  return current;
}
