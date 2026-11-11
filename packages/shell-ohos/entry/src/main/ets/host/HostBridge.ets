/**
 * 帧编解码 + 端口派发 —— ArkTS 侧的桥（与页面 `src/rpc.ts` 对偶）。
 *
 * 帧协议在 contract（`PORT_FRAME_VERSION` / CallFrame / ResFrame / PushFrame），
 * args/res/payload 一律 JSON 字符串：这里只解一层取顶层标量（spike S-A 结论），
 * 各端口自己把 args 解成自己的 DTO。
 */
import { hilog } from '@kit.PerformanceAnalysisKit';
import { PORT_FRAME_VERSION, formatIpcError } from '../shared/contract/index';
import type { IpcErrorCode } from '../shared/contract/index';

export class CallFrame {
  v: number = 0;
  kind: string = '';
  id: number = 0;
  port: string = '';
  method: string = '';
  args: string = 'null';
}

export class ResFrame {
  v: number = PORT_FRAME_VERSION;
  kind: string = 'res';
  id: number = 0;
  res: string | null = null;
  err: string | null = null;
}

export class PushFrame {
  v: number = PORT_FRAME_VERSION;
  kind: string = 'push';
  channel: string = '';
  payload: string = '';
}

/** 端口的统一形状：method → JSON 字符串进出；失败抛 `[CODE:DETAIL] message` 的 Error。 */
export interface OhosPort {
  handle(method: string, argsJson: string): Promise<string | null>;
}

/** 发帧出口 —— WebShell 用端口实现它。 */
export type FrameSink = (frameJson: string) => void;
export interface  HostBridgeOption {
  sink: FrameSink
}

export class HostBridge {
  private readonly ports: Map<string, OhosPort> = new Map<string, OhosPort>();
  private readonly sink: FrameSink;

  constructor(opt: HostBridgeOption) {
    this.sink = opt.sink;
  }

  registerPort(name: string, port: OhosPort): void {
    this.ports.set(name, port);
  }

  /** 页面 → 宿主的一条 CallFrame。失败也回 ResFrame（err 字段），不让页面挂起。 */
  onMessage(raw: string): void {
    let frame: CallFrame;
    try {
      frame = JSON.parse(raw) as CallFrame;
    } catch (e) {
      hilog.error(0x3200, 'HostBridge', '帧解析失败：%{public}s', raw.slice(0, 80));
      return;
    }
    if (frame.kind !== 'call') return;
    if (frame.v !== PORT_FRAME_VERSION) {
      this.reply(frame.id, null, formatIpcError('BAD_REQUEST' as IpcErrorCode, `帧版本不匹配：${frame.v}`, 'FRAME_VERSION'));
      return;
    }

    const port = this.ports.get(frame.port);
    if (port === undefined) {
      this.reply(frame.id, null, formatIpcError('NOT_FOUND' as IpcErrorCode, `端口未注册：${frame.port}`, 'PORT'));
      return;
    }

    port.handle(frame.method, frame.args).then((res: string | null): void => {
      this.reply(frame.id, res, null);
    }).catch((e: Object): void => {
      const err = e instanceof Error ? e : new Error(String(e));
      this.reply(frame.id, null, err.message);
    });
  }

  /** 端口 → 页面的单向推送。 */
  push(channel: string, payload: Object): void {
    const frame = new PushFrame();
    frame.channel = channel;
    frame.payload = JSON.stringify(payload);
    this.sink(JSON.stringify(frame));
  }

  private reply(id: number, res: string | null, err: string | null): void {
    const frame = new ResFrame();
    frame.id = id;
    frame.res = res;
    frame.err = err;
    this.sink(JSON.stringify(frame));
  }
}
