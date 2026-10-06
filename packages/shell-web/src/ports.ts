/**
 * Web 壳的能力端口实现 —— 一份**主动降级**的实现。
 *
 * 「降级」不是"少写点代码"，而是明确知道哪些能力在浏览器里根本不存在，
 * 并且**如实报告**它们不存在（而不是提供一个永远返回空值的假实现）。
 *
 * | 能力              | Electron 壳        | Web 壳（这里）                    |
 * |-----------------|-------------------|-------------------------------|
 * | `fs.scope`      | node:fs + symlink | OPFS / File System Access（无 symlink） |
 * | `window.multi`  | 多 BrowserWindow   | ❌ 页面内面板，不是真窗口                 |
 * | `shortcut.global`| globalShortcut    | ❌ 浏览器不让注册全局快捷键             |
 * | `update.auto`   | electron-updater  | ❌ 刷新即最新                        |
 * | `tray`          | Tray              | ❌ 不存在                          |
 * | `notify.system` | Notification      | ⚠️ 有，但要用户授权                   |
 *
 * 差异**文档化**，不做"假装统一的抽象" —— 那会让每一端都变得更糟。
 */

import type { Capability, DirEntry, FileStat, FileFilter, Platform } from '@crossdeck/contract';
import type { CapabilityPort, FsPort, WorkspaceStore } from '@crossdeck/core';

/** OPFS 的根 handle 与"挂载点"（前缀 → handle）。 */
interface Mount {
  readonly prefix: string;
  readonly handle: FileSystemDirectoryHandle;
}

const WRITE_UNSUPPORTED = 'Web 壳暂不支持 fs.watch —— 浏览器没有文件系统变更通知，只能轮询';

export function detectCapabilities(): ReadonlySet<Capability> {
  const caps = new Set<Capability>();
  // OPFS（Origin Private File System）：没有它就没有 fs.scope。
  // 这时候 UI 会如实少掉一整块，而不是假装能读文件。
  if (typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function') {
    caps.add('fs.scope');
  }
  if (typeof Notification !== 'undefined') {
    caps.add('notify.system');
  }
  return caps;
}

class WebFsPort implements FsPort {
  readonly #workspaces: WorkspaceStore;
  readonly #mounts: Mount[] = [];

  constructor(workspaces: WorkspaceStore) {
    this.#workspaces = workspaces;
  }

  mount(prefix: string, handle: FileSystemDirectoryHandle): void {
    // 长前缀优先，与 PathGuard 的「最长 root 匹配」保持同一套直觉
    this.#mounts.push({ prefix, handle });
    this.#mounts.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  /** 找到一个覆盖该绝对路径的挂载点，返回「从哪个 handle 走 + 走哪几段」。 */
  #locate(abs: string): { handle: FileSystemDirectoryHandle; segments: string[] } | null {
    for (const mount of this.#mounts) {
      if (abs === mount.prefix || abs.startsWith(`${mount.prefix}/`)) {
        const rest = abs.slice(mount.prefix.length).replace(/^\/+/, '');
        return { handle: mount.handle, segments: rest.length === 0 ? [] : rest.split('/') };
      }
    }
    return null;
  }

  async #fileAt(abs: string, create: boolean): Promise<FileSystemFileHandle | null> {
    const located = this.#locate(abs);
    if (located === null) return null;
    const { segments } = located;
    if (segments.length === 0) return null;

    let dir = located.handle;
    for (const seg of segments.slice(0, -1)) {
      try {
        dir = await dir.getDirectoryHandle(seg, { create });
      } catch {
        return null;
      }
    }
    const last = segments[segments.length - 1];
    if (last === undefined) return null;
    try {
      return await dir.getFileHandle(last, { create });
    } catch {
      return null;
    }
  }

  async #dirAt(abs: string): Promise<FileSystemDirectoryHandle | null> {
    const located = this.#locate(abs);
    if (located === null) return null;
    let dir = located.handle;
    for (const seg of located.segments) {
      try {
        dir = await dir.getDirectoryHandle(seg);
      } catch {
        return null;
      }
    }
    return dir;
  }

  /** 折成相对 workspace root 的 POSIX 路径 —— 与 Electron 壳的 toWorkspaceRelative 同义。 */
  #relative(abs: string): string {
    const owner = this.#workspaces.findOwning(abs);
    if (owner === null) return abs;
    if (abs === owner.root) return '.';
    return abs.slice(owner.root.length).replace(/^\/+/, '');
  }

  async readFile(abs: string, opts?: { maxBytes?: number }): Promise<{ text: string; truncated: boolean }> {
    const file = await this.#fileAt(abs, false);
    if (file === null) throw new Error(`ENOENT: ${abs}`);
    const blob = await file.getFile();
    const max = opts?.maxBytes ?? 1024 * 1024;
    if (blob.size > max) {
      return { text: await blob.slice(0, max).text(), truncated: true };
    }
    return { text: await blob.text(), truncated: false };
  }

  async writeFile(abs: string, data: string): Promise<void> {
    const file = await this.#fileAt(abs, true);
    if (file === null) throw new Error(`EACCES: ${abs}`);
    const writable = await file.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async listDir(abs: string): Promise<DirEntry[]> {
    const dir = await this.#dirAt(abs);
    if (dir === null) throw new Error(`ENOENT: ${abs}`);
    const out: DirEntry[] = [];
    for await (const [name, handle] of dir.entries()) {
      const childAbs = abs === '/' ? `/${name}` : `${abs}/${name}`;
      if (handle.kind === 'directory') {
        out.push({ name, path: this.#relative(childAbs), kind: 'directory', size: 0, mtimeMs: 0 });
      } else {
        const blob = await (handle as FileSystemFileHandle).getFile();
        out.push({
          name,
          path: this.#relative(childAbs),
          kind: 'file',
          size: blob.size,
          mtimeMs: blob.lastModified,
        });
      }
    }
    // 目录优先，再按名字 —— 与 Electron 壳保持一致的呈现顺序
    out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1));
    return out;
  }

  async stat(abs: string): Promise<FileStat> {
    const dir = await this.#dirAt(abs);
    if (dir !== null) return { kind: 'directory', size: 0, mtimeMs: 0 };
    const file = await this.#fileAt(abs, false);
    if (file === null) throw new Error(`ENOENT: ${abs}`);
    const blob = await file.getFile();
    return { kind: 'file', size: blob.size, mtimeMs: blob.lastModified };
  }

  /**
   * OPFS 没有 symlink，所以"解析真实路径"退化成"确认存在并归一化"。
   *
   * 注意它仍然**不能**直接返回入参：
   *   不存在的路径必须返回 null —— PathGuard 依赖这个语义去校验
   *   「最近存在的祖先目录」。返回入参会让写新文件时跳过整段校验。
   */
  async realpath(abs: string): Promise<string | null> {
    if ((await this.#dirAt(abs)) !== null) return abs;
    if ((await this.#fileAt(abs, false)) !== null) return abs;
    return null;
  }

  async watch(_abs: string, _onChange: () => void): Promise<() => void> {
    // 明确 reject 而不是返回一个永远不会触发的 closer ——
    // 后者会让调用方以为监听已经生效（见 core/src/ports.ts 的注释）。
    return Promise.reject(new Error(WRITE_UNSUPPORTED));
  }
}

export interface WebShell {
  readonly ports: CapabilityPort;
  readonly fs: WebFsPort;
  readonly platform: Platform;
  readonly capabilities: ReadonlySet<Capability>;
}

export async function createWebPorts(workspaces: WorkspaceStore): Promise<WebShell> {
  const capabilities = detectCapabilities();
  const fsPort = new WebFsPort(workspaces);

  // OPFS 根作为 `/` 的挂载点。没有 OPFS 时 fs.scope 不在能力表里，
  // 下面的调用也就不会被走到 —— 能力探测先于调用，不是先调用再兜底。
  if (capabilities.has('fs.scope')) {
    const root = await navigator.storage.getDirectory();
    fsPort.mount('/', root);
    // 演示目录：先把夹具建出来，让「越界被拒」有一个真实可读的目标
    const demo = await root.getDirectoryHandle('demo', { create: true });
    fsPort.mount('/ws/demo', demo);
    const greeting = await demo.getFileHandle('hello.txt', { create: true });
    const w = await greeting.createWritable();
    await w.write('crossdeck web shell —— OPFS 里的一个文件\n');
    await w.close();
    const sub = await demo.getDirectoryHandle('notes', { create: true });
    const rm = await sub.getFileHandle('readme.md', { create: true });
    const w2 = await rm.createWritable();
    await w2.write('# 夹具目录\n\n与 Electron 壳共用同一套 PathGuard。\n');
    await w2.close();
  }

  const ports: CapabilityPort = {
    env: {
      platform: 'web',
      version: navigator.userAgent,
      capabilities,
    },
    fs: fsPort,
    dialog: {
      async pickDirectory(): Promise<string | null> {
        // File System Access API 是 Chromium 专有且不在标准 lib.dom 里，见 global.d.ts
        if (typeof window.showDirectoryPicker !== 'function') return null;
        try {
          const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
          // 用户选中的真实目录挂到一个虚拟前缀下。
          // 为什么是虚拟路径而不是把 handle 直接当"路径"：PathGuard 是纯字符串算法，
          // 它必须能对路径做前缀比较 —— handle 没法参与字符串运算。
          // 挂载表承担了「虚拟路径 → 真实 handle」的翻译，两者职责不混。
          const prefix = `/picked/${handle.name}`;
          fsPort.mount(prefix, handle);
          return prefix;
        } catch {
          // 用户在系统对话框里点了取消 —— 这是 null，不是错误
          return null;
        }
      },
      async pickFiles(): Promise<string[]> {
        return [];
      },
      async confirm(message: string): Promise<boolean> {
        return window.confirm(message);
      },
    },
    clipboard: {
      async readText(): Promise<string> {
        return navigator.clipboard.readText();
      },
      async writeText(text: string): Promise<void> {
        await navigator.clipboard.writeText(text);
      },
    },
    notify: {
      async show(opts): Promise<void> {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission === 'default') await Notification.requestPermission();
        if (Notification.permission !== 'granted') return;
        new Notification(opts.title, { body: opts.body });
      },
      isSupported(): boolean {
        return typeof Notification !== 'undefined';
      },
    },
    window: {
      async open(): Promise<number> {
        // Web 壳没有"多窗口"这个概念 —— 返回一个面板 id，UI 用它渲染页面内面板。
        // ⚠️ 这里刻意不抛错也不装成真窗口：`window.multi` 不在能力表里，
        //    调用方本来就该先探测再决定要不要显示"新建窗口"。
        return 0;
      },
      async close(): Promise<void> {},
      async setAlwaysOnTop(): Promise<boolean> {
        return false;
      },
    },
  };

  return { ports, fs: fsPort, platform: 'web', capabilities };
}

export type { FileFilter };
