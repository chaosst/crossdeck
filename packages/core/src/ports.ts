import type {
  Capability,
  DirEntry,
  FileFilter,
  FileStat,
  Platform,
  WindowKind,
} from '@crossdeck/contract';

/**
 * CapabilityPort —— core 唯一的对外依赖面。
 *
 * 铁律：core 里出现的所有平台能力，都必须先在这里声明成接口。
 * core 本身不得 import electron / node:fs / @ohos.*。
 *
 * 每个壳提供一份实现：
 *   shell-electron → 完整实现（node:fs / BrowserWindow / clipboard / ...）
 *   shell-web      → 降级实现（OPFS / File System Access API，watch 退化为轮询）
 *   shell-ohos     → ArkTS 实现（@ohos.file.fs / 自由窗口 / pasteboard）
 */

export interface EnvPort {
  /** ⚠️ 仅用于日志与诊断。功能分支一律走 capabilities。 */
  readonly platform: Platform;
  readonly version: string;
  /** 该平台实际具备的能力集合 */
  readonly capabilities: ReadonlySet<Capability>;
}

export interface FsPort {
  /**
   * 读取文本内容。
   *
   * ⚠️ 必须带上限：Agent 读的是用户的**真实项目目录**，一个 2GB 的日志文件
   *    足以把主进程内存打满。超限时**截断并如实标记**，不要静默返回半截内容
   *    （静默截断会让调用方把半截文本当成全文，排查成本极高）。
   */
  readFile(
    path: string,
    opts?: { maxBytes?: number },
  ): Promise<{ text: string; truncated: boolean }>;
  /** 仅能访问已授权 scope 内路径；越界抛 E_SCOPE_DENIED */
  writeFile(path: string, data: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  /**
   * 订阅文件变更。
   *
   * ⚠️ 返回 Promise：越界 / 路径不存在会 **reject**。
   *    写成「同步返回一个取消函数」看着更顺手，但那样订阅失败只能静默 ——
   *    调用方会拿着一个永远不会触发的 closer，以为监听已经生效。
   *    Web 壳降级为轮询（或不支持时 reject），故取消函数仍然是统一的收口方式。
   */
  watch(path: string, onChange: () => void): Promise<() => void>;
  /**
   * 解析真实路径（解 symlink）。
   *
   * ⚠️ 这是给 **PathGuard** 用的底层原语，**不做 scope 校验** ——
   *    校验本身需要它，套一层会变成递归。其他调用方不要拿它当"读文件入口"。
   */
  realpath(path: string): Promise<string | null>;
}

export interface DialogPort {
  /** 返回 null 表示用户取消 */
  pickDirectory(): Promise<string | null>;
  pickFiles(opts: { multiple: boolean; filters?: FileFilter[] }): Promise<string[]>;
  confirm(message: string): Promise<boolean>;
}

export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface NotificationPort {
  show(opts: { title: string; body: string; silent?: boolean }): Promise<void>;
  /** 返回 false 表示当前平台不支持（Web 壳需引导用户授权） */
  isSupported(): boolean;
}

export interface WindowPort {
  open(kind: WindowKind, payload?: unknown): Promise<number>;
  close(windowId: number): Promise<void>;
  /** 仅桌面端支持；Web 壳返回 false */
  setAlwaysOnTop(windowId: number, on: boolean): Promise<boolean>;
}

/** core 构造时需要注入的全部平台能力。 */
export interface CapabilityPort {
  readonly env: EnvPort;
  readonly fs: FsPort;
  readonly dialog: DialogPort;
  readonly clipboard: ClipboardPort;
  readonly notify: NotificationPort;
  readonly window: WindowPort;
}
