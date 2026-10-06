/**
 * IPC 错误信封 —— 让错误跨进程后仍然**保留语义**。
 *
 * 为什么需要它：
 *   Electron 的 ipcMain.handle 抛错时，会把 Error 拍平成字符串
 *   （形如 `Error invoking remote method 'agent:run': Error: ...`），
 *   自定义属性（比如 code）**全部丢失**。
 *   结果就是 renderer 只能拿到一句没法编程处理的文本，无法分流：
 *   是"参数错了"还是"上游限流"还是"用户主动取消"？
 *
 * 做法：handler 的返回值统一包一层信封。
 *   { ok: true, value }       正常
 *   { ok: false, error }      失败，code 为字面量联合
 * preload 解包：ok 为真返回 value，否则重新抛出 AppError（带 code）。
 *
 * 对调用侧完全透明 —— `BridgeApi.invoke` 的签名仍然是 Promise<res>，
 * 只是失败时抛出的错误多了一个可判别的 code。
 */

export type IpcErrorCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  /**
   * 路径不在任何已授权工作区之内（M4 新增）。
   *
   * 为什么不复用 FORBIDDEN：UI 要区分「还没授权任何目录」（应引导去授权）
   * 与「越界了」（应报错），两者给用户的动作完全不同。
   * 压成一个码之后只能去解析 message 文本 —— 那正是本项目要消灭的东西。
   */
  | 'SCOPE_DENIED'
  /** 工作区是只读的，写操作被拒（M4 新增） */
  | 'READONLY'
  | 'ABORTED'
  | 'INTERNAL';

/** 跨进程可结构化克隆的错误载荷（纯数据，无原型）。 */
export interface SerializedError {
  readonly __crossdeckError: true;
  readonly code: IpcErrorCode;
  readonly message: string;
  /**
   * 结构化细节 —— 目前用于携带 PathDenyReason（NO_WORKSPACE / BAD_PATH /
   * OUT_OF_SCOPE / ESCAPE_ATTEMPT），让调用侧不必解析 message 就能分流。
   * 可选：缺失时不影响任何既有分支。
   */
  readonly detail?: string;
}

/** handler 的统一返回信封。 */
export type IpcEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SerializedError };

/** 带错误码的业务异常 —— core 与各壳都可抛。 */
export class AppError extends Error {
  readonly code: IpcErrorCode;
  readonly detail?: string;

  constructor(code: IpcErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    // exactOptionalPropertyTypes 开着：不能显式赋 undefined
    if (detail !== undefined) this.detail = detail;
  }
}

export function toSerializedError(err: unknown): SerializedError {
  // 幂等：preload 拿到的 raw.error 已经是序列化形态，不能再当异常重新序列化一次。
  // 少了这一行，所有业务错误码都会被压成 INTERNAL、message 变成 "[object Object]"
  // —— 实测踩过，见 selfcheck 的 errorDecodedCode 断言。
  if (isSerializedError(err)) return err;

  if (err instanceof AppError) {
    const base = { __crossdeckError: true, code: err.code, message: err.message } as const;
    return err.detail === undefined ? base : { ...base, detail: err.detail };
  }
  if (err instanceof Error) {
    return { __crossdeckError: true, code: 'INTERNAL', message: err.message };
  }
  return { __crossdeckError: true, code: 'INTERNAL', message: String(err) };
}

export function isSerializedError(value: unknown): value is SerializedError {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<SerializedError>;
  if (v.__crossdeckError !== true) return false;
  if (typeof v.code !== 'string' || typeof v.message !== 'string') return false;
  if (v.detail !== undefined && typeof v.detail !== 'string') return false;
  return true;
}

/** 反序列化回 AppError。拿到非信封载荷时也给出可诊断的兜底。 */
export function toAppError(value: unknown): AppError {
  if (isSerializedError(value)) {
    return value.detail === undefined
      ? new AppError(value.code, value.message)
      : new AppError(value.code, value.message, value.detail);
  }
  return new AppError(
    'INTERNAL',
    `IPC 响应不是合法信封：${JSON.stringify(value)?.slice(0, 200) ?? '(无法序列化)'}`,
  );
}

/**
 * 判断一个载荷是不是合法信封。
 *
 * preload 用它来区分「main 明确告知的失败」和「main 根本没答上来」——
 * 后者（进程 crash、通道未注册）Electron 会直接 reject，不会走到这里。
 * 但如果 main 的返回值被中间层改写过，信封检查能立刻暴露，而不是让
 * renderer 拿着一个形状不对的对象继续往下跑。
 */
export function isIpcEnvelope(value: unknown): value is IpcEnvelope<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { ok?: unknown; value?: unknown; error?: unknown };
  if (v.ok === true) return 'value' in v;
  if (v.ok === false) return isSerializedError(v.error);
  return false;
}

// ─────────────────────────────────────────────────────────────
// 跨 contextBridge 的错误码保真
// ─────────────────────────────────────────────────────────────

/**
 * 为什么需要这一层：**实测**（selfcheck 探针，非推测）
 *
 *   preload 里 `throw new AppError('NOT_FOUND', msg)` 之后，renderer 侧 catch 到的是：
 *     name       → 'Error'      （自定义 name 丢失）
 *     code       → undefined    （自定义属性全部丢失）
 *     ownProps   → []           （连 own key 都没有）
 *     message    → '会话不存在…' （**只有 message 活了下来**）
 *
 *   contextBridge 的跨上下文代理只搬运 message/stack，不搬运自定义属性。
 *   所以「错误信封」只解决了 main → preload 这一段；
 *   preload → renderer 这一段必须换一种编码方式：把 code 塞进 message。
 *
 * 于是约定一个前缀格式：`[CODE] 原始信息`，带 detail 时是 `[CODE:DETAIL] 原始信息`。
 * 好处是降级友好 —— 就算调用方完全不做解析，人在 DevTools 里也能一眼看出类别。
 */

/** 只允许常量表里的 code 被解析出来，避免消息里恰好出现 `[FOO]` 被误判。 */
const KNOWN_CODES: readonly IpcErrorCode[] = [
  'BAD_REQUEST',
  'NOT_FOUND',
  'FORBIDDEN',
  'SCOPE_DENIED',
  'READONLY',
  'ABORTED',
  'INTERNAL',
];

export function isIpcErrorCode(value: string): value is IpcErrorCode {
  return (KNOWN_CODES as readonly string[]).includes(value);
}

/** 把任意错误编码成可穿过 contextBridge 的 Error。 */
export function encodeBridgeError(err: unknown): Error {
  const serialized = toSerializedError(err);
  const tag =
    serialized.detail === undefined
      ? serialized.code
      : `${serialized.code}:${serialized.detail}`;
  return new Error(`[${tag}] ${serialized.message}`);
}

export interface ParsedIpcError {
  /** 解析不出已知 code 时返回 'UNKNOWN' —— 典型场景是通道未注册这类传输层失败。 */
  code: IpcErrorCode | 'UNKNOWN';
  message: string;
  /**
   * 结构化细节，取自 `[CODE:DETAIL]` 前缀。
   * 调用侧要用 `isPathDenyReason` 之类的守卫做窄化，不要直接当业务值用。
   */
  detail?: string;
}

/**
 * 解析 renderer 侧 catch 到的错误。
 *
 * 'UNKNOWN' 与业务错误码的区分是有意义的：
 *   UNKNOWN 表示「没走完业务逻辑就失败了」（通道未注册 / 进程崩溃），
 *   这类问题不该提示用户"重试"，而应该记日志并在开发期修掉。
 */
export function parseIpcError(value: unknown): ParsedIpcError {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  // detail 只允许大写字母与下划线（枚举形态），避免把 message 里恰好出现的
  // `[FOO: bar]` 误当成 detail。
  const matched = /^\[([A-Z_]+)(?::([A-Z_]+))?\]\s?([\s\S]*)$/.exec(raw);
  const code = matched?.[1];
  if (code !== undefined && isIpcErrorCode(code)) {
    const detail = matched?.[2];
    const message = matched?.[3] ?? '';
    return detail === undefined ? { code, message } : { code, message, detail };
  }
  return { code: 'UNKNOWN', message: raw };
}
