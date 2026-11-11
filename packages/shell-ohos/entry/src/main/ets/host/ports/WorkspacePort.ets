/** workspace 端口 —— scope 算法归 core（WorkspaceStore/PathGuard），系统调用归 @ohos.file.fs。 */
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { formatIpcError } from '../../shared/contract/index';
import type { DirEntry, EntryKind, FileStat, IpcErrorCode, PathGuard, Workspace } from '../../shared/contract/index';
import type { PathGuardDeps } from '../../shared/core/index';
import { WorkspaceStore, createPathGuard, resolveInWorkspace } from '../../shared/core/index';
import type { common } from '@kit.AbilityKit';
import type { OhosPort } from '../HostBridge';

class ScopeReq {
  workspaceId: string = '';
  path: string = '.';
}

class WriteReq {
  workspaceId: string = '';
  path: string = '';
  data: string = '';
}

class ReadFileResult {
  text: string = '';
  truncated: boolean = false;

  constructor(text: string, truncated: boolean) {
    this.text = text;
    this.truncated = truncated;
  }
}

/** 联合 → 扁平视图。`.ets` 既不支持 `in` 也不按布尔字面量收窄（P3 实测）。 */
interface ResolveView {
  readonly ok: boolean;
  readonly absolute: string;
  readonly reason: string;
}

interface GrantView {
  readonly ok: boolean;
  readonly workspace: Workspace;
  readonly reason: string;
}

const READ_LIMIT_BYTES = 512 * 1024;

/**
 * 工作空间相关的接口类
 * type: list(工作区列表) / grant(当前授权工作区) / revoke(删除授权工作区) / listDir(路径下的文件目录表) / readFile / writeFile / stat(文件信息)
 */
export class WorkspacePort implements OhosPort {
  readonly store: WorkspaceStore = new WorkspaceStore({ caseInsensitive: false });
  readonly guard: PathGuard;
  private readonly context: common.Context;

  constructor(context: common.Context) {
    this.context = context;
    const deps: PathGuardDeps = { caseInsensitive: false };
    // 沙箱内没有 symlink，缺省（跳过 realpath 校验）即可；用户授权目录接入时再注入。
    this.guard = createPathGuard(this.store, deps);
  }

  handle(method: string, argsJson: string): Promise<string | null> {
    if (method === 'list') {
      return Promise.resolve(JSON.stringify(this.store.list()));
    }
    if (method === 'grant') {
      return Promise.resolve(JSON.stringify(this.grant()));
    }
    if (method === 'revoke') {
      const req = JSON.parse(argsJson) as ScopeReq;
      this.store.revoke(req.workspaceId);
      return Promise.resolve(null);
    }
    if (method === 'listDir') {
      return this.listDir(argsJson).then((entries): string => JSON.stringify(entries));
    }
    if (method === 'readFile') {
      return this.readFile(argsJson).then((out): string => JSON.stringify(out));
    }
    if (method === 'writeFile') {
      return this.writeFile(argsJson).then((): string | null => null);
    }
    if (method === 'stat') {
      return this.stat(argsJson).then((out): string => JSON.stringify(out));
    }
    return Promise.reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `workspace 端口没有方法 ${method}`, 'METHOD')));
  }

  /**
   * 授权目录。模拟器上 `DocumentViewPicker` 未必弹得出来（P3 风险清单第 2 条），
   * 退化成"预置沙箱演示目录"，root 显示真实沙箱路径 —— 如实，不假装是用户选的。
   */
  private grant(): Workspace | null {
    const root = `${this.context.filesDir}/demo`;
    this.ensureDemoFixture(root);
    const view = this.store.grant({ root, mode: 'readwrite' }) as Object as GrantView;
    if (!view.ok) {
      throw new Error(formatIpcError('BAD_REQUEST' as IpcErrorCode, `授权失败：${view.reason}`));
    }
    return view.workspace;
  }

  private ensureDemoFixture(root: string): void {
    try {
      if (!fs.accessSync(root)) {
        fs.mkdirSync(root, true);
      }
      const hello = `${root}/hello.txt`;
      if (!fs.accessSync(hello)) {
        const file = fs.openSync(hello, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
        fs.writeSync(file.fd, 'hello from ohos sandbox workspace\n');
        fs.closeSync(file);
      }
      const notes = `${root}/notes`;
      if (!fs.accessSync(notes)) {
        fs.mkdirSync(notes, true);
      }
      const todo = `${notes}/todo.md`;
      if (!fs.accessSync(todo)) {
        const file = fs.openSync(todo, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE);
        fs.writeSync(file.fd, '- 装进 rawfile\n');
        fs.closeSync(file);
      }
    } catch (e) {
      const err = e as BusinessError<void>;
      throw new Error(formatIpcError('INTERNAL' as IpcErrorCode, `准备演示目录失败：${err.message}（code=${err.code}）`));
    }
  }

  private resolve(argsJson: string, what: string): Promise<string> {
    const req = JSON.parse(argsJson) as ScopeReq;
    return resolveInWorkspace(this.store, this.guard, req.workspaceId, req.path).then((resolved): string => {
      const view = resolved as Object as ResolveView;
      if (!view.ok) {
        throw new Error(formatIpcError('SCOPE_DENIED' as IpcErrorCode, '路径不在任何已授权工作区之内', view.reason));
      }
      return view.absolute;
    }).catch((e: Object): string => {
      if (e instanceof Error && e.message.startsWith('[')) throw e;
      throw new Error(formatIpcError('INTERNAL' as IpcErrorCode, `${what}失败：${String(e)}`));
    });
  }

  private listDir(argsJson: string): Promise<DirEntry[]> {
    return this.resolve(argsJson, '列目录').then((abs): DirEntry[] => {
      const names: string[] = fs.listFileSync(abs);
      const out: DirEntry[] = [];
      for (const name of names) {
        const childPath = `${abs}/${name}`;
        const st = fs.statSync(childPath);
        const kind: EntryKind = st.isDirectory() ? 'directory' : 'file';
        const entry: DirEntry = {
          name,
          path: name,
          kind,
          size: st.isDirectory() ? 0 : Number(st.size),
          mtimeMs: Number(st.mtime),
        };
        out.push(entry);
      }
      return out.sort((a, b): number => {
        if (a.kind === b.kind) return a.name.localeCompare(b.name);
        return a.kind === 'directory' ? -1 : 1;
      });
    });
  }

  private readFile(argsJson: string): Promise<ReadFileResult> {
    return this.resolve(argsJson, '读文件').then((abs): ReadFileResult => {
      const st = fs.statSync(abs);
      if (st.isDirectory()) {
        throw new Error(formatIpcError('BAD_REQUEST' as IpcErrorCode, '读文件失败：这是一个目录'));
      }
      const size = Number(st.size);
      const limit = Math.min(size, READ_LIMIT_BYTES);
      const file = fs.openSync(abs, fs.OpenMode.READ_ONLY);
      try {
        const buf = new ArrayBuffer(limit);
        const read = fs.readSync(file.fd, buf);
        const decoder = util.TextDecoder.create('utf-8', { fatal: false, ignoreBOM: true });
        const text = decoder.decodeToString(new Uint8Array(buf, 0, read), { stream: false });
        return new ReadFileResult(text, read < size);
      } finally {
        fs.closeSync(file);
      }
    });
  }

  private writeFile(argsJson: string): Promise<null> {
    const req = JSON.parse(argsJson) as WriteReq;
    return resolveInWorkspace(this.store, this.guard, req.workspaceId, req.path).then((resolved): null => {
      const view = resolved as Object as ResolveView;
      if (!view.ok) {
        throw new Error(formatIpcError('SCOPE_DENIED' as IpcErrorCode, '路径不在任何已授权工作区之内', view.reason));
      }
      const ws = this.store.get(req.workspaceId);
      if (ws !== undefined && ws.mode === 'read') {
        throw new Error(formatIpcError('READONLY' as IpcErrorCode, '工作区是只读的，写操作被拒'));
      }
      const file = fs.openSync(view.absolute, fs.OpenMode.READ_WRITE | fs.OpenMode.CREATE | fs.OpenMode.TRUNC);
      try {
        fs.writeSync(file.fd, req.data);
      } finally {
        fs.closeSync(file);
      }
      return null;
    });
  }

  private stat(argsJson: string): Promise<FileStat> {
    return this.resolve(argsJson, '取文件信息').then((abs): FileStat => {
      const st = fs.statSync(abs);
      const out: FileStat = {
        kind: st.isDirectory() ? 'directory' : 'file',
        size: Number(st.size),
        mtimeMs: Number(st.mtime),
      };
      return out;
    });
  }
}
