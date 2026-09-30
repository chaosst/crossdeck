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
  /** 仅能访问已授权 scope 内路径；越界抛 E_SCOPE_DENIED */
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  stat(path: string): Promise<FileStat>;
  /**
   * 订阅文件变更。Web 壳降级为 no-op + 轮询，故返回类型统一为取消订阅函数。
   * Web 端调用方需自行按 capabilities.has('fs.scope') 决定是否信任实时性。
   */
  watch(path: string, onChange: () => void): () => void;
  /** 解析真实路径（解 symlink）。PathGuard 靠它做逃逸检测。 */
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
