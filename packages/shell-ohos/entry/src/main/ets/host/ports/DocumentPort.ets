/** document 端口 —— multipart 上传经 @ohos.net.http；进度经 PushFrame 回页面。 */
import { http } from '@kit.NetworkKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { formatIpcError } from '../../shared/contract/index';
import type { IpcErrorCode, PathGuard, UploadedDocument, UploadProgress } from '../../shared/contract/index';
import type { WorkspaceStore } from '../../shared/core/index';
import {
  DEFAULT_UPLOAD_POLICY,
  checkUploadCandidate,
  decodeUploadedDocument,
  resolveInWorkspace,
  uploadEndpoint,
} from '../../shared/core/index';
import type { OhosPort } from '../HostBridge';

class UploadReq {
  workspaceId: string = '';
  path: string = '';
}

export interface DocumentPortEnv {
  readonly baseUrl: () => string | null;
  readonly getToken: () => string | null;
  readonly store: WorkspaceStore;
  readonly guard: PathGuard;
  readonly pushProgress: (progress: UploadProgress) => void;
}

/** 联合 → 扁平视图。`.ets` 既不支持 `in` 也不按布尔字面量收窄（P3 实测）。 */
interface ResolveView {
  readonly ok: boolean;
  readonly absolute: string;
  readonly reason: string;
}

interface UploadCheckView {
  readonly ok: boolean;
  readonly reason: string;
  readonly message: string;
}

function mimeOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
  if (ext === 'txt' || ext === 'md') return 'text/plain';
  if (ext === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

/**
 * 文件相关的操作接口类
 * type: upload
 */
export class DocumentPort implements OhosPort {
  private readonly env: DocumentPortEnv;

  constructor(env: DocumentPortEnv) {
    this.env = env;
  }

  handle(method: string, argsJson: string): Promise<string | null> {
    if (method !== 'upload') {
      return Promise.reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, `document 端口没有方法 ${method}`, 'METHOD')));
    }
    const req = JSON.parse(argsJson) as UploadReq;
    return this.upload(req.workspaceId, req.path).then((doc): string => JSON.stringify(doc));
  }

  private upload(workspaceId: string, relPath: string): Promise<UploadedDocument> {
    const base = this.env.baseUrl();
    if (base === null) {
      return Promise.reject(new Error(formatIpcError('UNSUPPORTED' as IpcErrorCode, '当前是离线脚本上游，没有上传接口')));
    }
    const token = this.env.getToken();
    if (token === null) {
      return Promise.reject(new Error(formatIpcError('FORBIDDEN' as IpcErrorCode, '未登录：没有可用凭据，请先获取体验账号')));
    }

    return resolveInWorkspace(this.env.store, this.env.guard, workspaceId, relPath).then((resolved): Promise<UploadedDocument> => {
      const view = resolved as Object as ResolveView;
      if (!view.ok) {
        throw new Error(formatIpcError('SCOPE_DENIED' as IpcErrorCode, '路径不在任何已授权工作区之内', view.reason));
      }
      const abs = view.absolute;
      const slash = abs.lastIndexOf('/');
      const fileName = slash < 0 ? abs : abs.slice(slash + 1);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        throw new Error(formatIpcError('BAD_REQUEST' as IpcErrorCode, '只能上传文件，不能上传目录'));
      }
      const size = Number(stat.size);
      const hit = checkUploadCandidate({ fileName, sizeBytes: size }, DEFAULT_UPLOAD_POLICY) as Object as UploadCheckView;
      if (!hit.ok) {
        throw new Error(formatIpcError('BAD_REQUEST' as IpcErrorCode, hit.message, hit.reason));
      }
      return this.doUpload(base, token, abs, fileName, size);
    });
  }

  private doUpload(base: string, token: string, abs: string, fileName: string, size: number): Promise<UploadedDocument> {
    // 进度只有"起 / 止"两档：`@ohos.net.http` 的 multipart 不给逐块回调，
    // 编一个中间值就是在骗 UI。
    const start: UploadProgress = { sentBytes: 0, totalBytes: size, ratio: 0, bytesPerSec: null, etaSec: null };
    this.env.pushProgress(start);

    const client = http.createHttp();
    return fsReadAll(abs).then((bytes: ArrayBuffer): Promise<UploadedDocument> => {
      const form: http.MultiFormData = {
        name: 'file',
        contentType: mimeOf(fileName),
        remoteFileName: fileName,
        data: bytes,
      };
      const options: http.HttpRequestOptions = {
        method: http.RequestMethod.POST,
        multiFormDataList: [form],
        connectTimeout: 30000,
        readTimeout: 600000,
      };
      // 凭据走 `?token=`（与桌面壳同一条约定：没有 cookie 就只能这么带）。
      return client.request(uploadEndpoint(base, token), options).then((res): UploadedDocument => {
        const done: UploadProgress = { sentBytes: size, totalBytes: size, ratio: 1, bytesPerSec: null, etaSec: null };
        this.env.pushProgress(done);
        if (res.responseCode === 401) {
          throw new Error(formatIpcError('FORBIDDEN' as IpcErrorCode, '登录已失效，请重新登录'));
        }
        if (res.responseCode === 403) {
          throw new Error(formatIpcError('FORBIDDEN' as IpcErrorCode, '当前身份没有上传权限（游客不能上传文档）'));
        }
        if (res.responseCode < 200 || res.responseCode >= 300) {
          throw new Error(formatIpcError('UPSTREAM' as IpcErrorCode, `上传失败：HTTP ${res.responseCode}`));
        }
        const body: string = typeof res.result === 'string' ? res.result : '';
        let raw: Object | null = null;
        try {
          raw = body.length > 0 ? JSON.parse(body) as Object : null;
        } catch (e) {
          throw new Error(formatIpcError('UPSTREAM' as IpcErrorCode, '上传响应不是合法 JSON'));
        }
        const doc: UploadedDocument | null = decodeUploadedDocument(raw);
        if (doc === null) {
          throw new Error(formatIpcError('UPSTREAM' as IpcErrorCode, `上传响应不符合契约：${body.slice(0, 120)}`));
        }
        return doc;
      });
    }).finally((): void => {
      client.destroy();
    });
  }
}

/** 整文件读进内存（上传本来就是整发；上限由 checkUploadCandidate 挡在前面）。 */
function fsReadAll(abs: string): Promise<ArrayBuffer> {
  return new Promise<ArrayBuffer>((resolve, reject): void => {
    try {
      const stat = fs.statSync(abs);
      const size = Number(stat.size);
      const file = fs.openSync(abs, fs.OpenMode.READ_ONLY);
      try {
        const buf = new ArrayBuffer(size);
        fs.readSync(file.fd, buf);
        resolve(buf);
      } finally {
        fs.closeSync(file);
      }
    } catch (e) {
      const err = e as BusinessError<void>;
      if (err.code === 13900002) {
        reject(new Error(formatIpcError('NOT_FOUND' as IpcErrorCode, '读文件失败：文件不存在')));
      } else {
        reject(new Error(formatIpcError('INTERNAL' as IpcErrorCode, `读文件失败：${err.message}（code=${err.code}）`)));
      }
    }
  });
}
