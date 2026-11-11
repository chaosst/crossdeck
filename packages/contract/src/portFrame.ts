export const PORT_FRAME_VERSION = 1;

export type ShellPortName =
  | 'system' | 'session' | 'agent' | 'workspace'
  | 'document' | 'navigate' | 'action' | 'shell' | 'selfcheck';

export interface CallFrame {
  readonly v: number;
  readonly kind: 'call';
  readonly id: number;
  readonly port: ShellPortName;
  readonly method: string;
  /** JSON 字符串：ArkTS 侧只解一层取顶层标量（见 P3 文档 §11 S-A） */
  readonly args: string;
}

export interface ResFrame {
  readonly v: number;
  readonly kind: 'res';
  readonly id: number;
  /** JSON 字符串；无返回值用 `null` */
  readonly res: string | null;
  /** `[CODE:DETAIL] message` 原文；成功为 `null` */
  readonly err: string | null;
}

export interface PushFrame {
  readonly v: number;
  readonly kind: 'push';
  /** 直接复用 `PushChannel` 的字面量 */
  readonly channel: string;
  /** JSON 字符串（与 args/res 同一约定） */
  readonly payload: string;
}
