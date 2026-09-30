import type { Capability, Platform } from './capability.js';

/** 会话元信息。列表页只拿这个，不携带消息体。 */
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** 平台与运行时信息。capabilities 是 core 做 UI 降级的唯一依据。 */
export interface SystemInfo {
  platform: Platform;
  appVersion: string;
  osVersion: string;
  locale: string;
  /** 该平台实际具备的能力。注意是 readonly 数组，跨 IPC 序列化友好。 */
  capabilities: readonly Capability[];
}

export type EntryKind = 'file' | 'directory' | 'symlink';

export interface DirEntry {
  name: string;
  /** 相对 workspace root 的 POSIX 风格路径（统一用 `/`，便于跨端与快照测试） */
  path: string;
  kind: EntryKind;
  /** 目录为 0 */
  size: number;
  mtimeMs: number;
}

export interface FileStat {
  kind: EntryKind;
  size: number;
  mtimeMs: number;
}

export interface FileFilter {
  /** 展示给用户的名字，如 "TypeScript" */
  name: string;
  /** 不带点的扩展名列表，如 ['ts', 'tsx'] */
  extensions: string[];
}
