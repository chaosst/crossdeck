/**
 * 页面侧的全局声明 —— `types: []` 之后唯一的类型来源。
 *
 * 与 Web 壳同一纪律：不引 vite/client（那会放开 import.meta.env），
 * 构建期注入的常量自己声明。端口相关的两个成员由 index.html 的
 * 内联 classic script 负责 park（见 docs/plans P3 §6.1）。
 */
declare global {
  /** 构建期注入的版本号（见 vite.config.ts 的 define）。 */
  const __APP_VERSION__: string;

  interface Window {
    /** 内联脚本已注册好 message 监听；rpc.ts 从这里拿端口，不许再注册第二个。 */
    __whenPort(fn: (port: MessagePort) => void): void;
    /** 内联脚本 park 端口的地方；`null` = 端口还没到。 */
    readonly __crossdeckPort: MessagePort | null;
  }
}

export {};
