/**
 * M6-0 spike 的可复现证据 —— 合并成一个入口，由主页调用并显示。
 *
 * 四层的含义见 docs/plans 的 M6-0：
 *   L1 leaf    capability.ts（零依赖、纯字面量联合）
 *   L2 data    entities / stream / workspace / update（索引访问类型、Record、判别联合）
 *   L3 ipc     ipc / error / invoke-map / push-map / types（as const、计算属性键、条件类型）
 *   L4 index   contract/index.ts 的 `export *` 再导出
 *   B  后缀    contract 内部的 `.js` 扩展名 import 说明符能否被解析
 *
 * 它是**活证据**：只要 contract 改动导致 ArkTS 消费不了，这个页面就会在运行时报错，
 * 而不是躺在文档里等腐烂。
 */
import { IPC } from '../contract/ipc';
import type { Capability, Platform, WindowKind } from '../contract/capability';
import type { SessionMeta, SystemInfo } from '../contract/entities';
import type { AgentStreamEvent, PlanStepStatus, Usage, ErrorCode } from '../contract/stream';
import { assertNever } from '../contract/stream';
import type { Workspace, PathGuard, PathDenyReason } from '../contract/workspace';
import { PATH_DENY_REASONS, PATH_DENY_MESSAGES, isPathDenyReason } from '../contract/workspace';
import type { UpdateInfo, UpdateStatus, UpdateStage } from '../contract/update';
import { isTerminalStage } from '../contract/update';
import { AppError, encodeBridgeError, parseIpcError } from '../contract/error';
import type { IpcInvokeMap, InvokeChannel, Req, Res } from '../contract/invoke-map';
import type { IpcPushMap, PushChannel, PushPayload } from '../contract/push-map';
import type { BridgeApi, InvokeHandler, InvokeArgs, HandlerCtx } from '../contract/types';

/** L1 —— 判别联合事件收窄（renderer 侧 switch 的地基）。 */
function summarizeEvent(event: AgentStreamEvent): string {
  switch (event.type) {
    case 'start':
      return `start`;
    case 'token':
      return `token`;
    case 'tool':
      return `tool:${event.name}`;
    case 'tool_end':
      return `tool_end:${event.ok ? 'ok' : 'fail'}`;
    case 'plan':
      return `plan:${event.steps.length}`;
    case 'done':
      return `done`;
    case 'error':
      return `error:${event.code}`;
    default:
      return assertNever(event);
  }
}

export interface SpikeResult {
  readonly layer: string;
  readonly ok: boolean;
  readonly detail: string;
}

export function runSpikeReport(): SpikeResult[] {
  const out: SpikeResult[] = [];
  const step = (layer: string, fn: () => string): void => {
    try {
      out.push({ layer, ok: true, detail: fn() });
    } catch (e) {
      out.push({ layer, ok: false, detail: String(e) });
    }
  };

  // L1 leaf
  step('L1 leaf', () => {
    const platform: Platform = 'ohos';
    const caps: Capability[] = ['fs.scope', 'window.multi', 'shortcut.global', 'update.auto', 'tray', 'notify.system'];
    const kinds: WindowKind[] = ['main', 'session', 'settings', 'inspector'];
    return `${platform} caps=${caps.length} kinds=${kinds.length}`;
  });

  // L2 data
  step('L2 data', () => {
    const status: UpdateStatus = { stage: 'downloading', info: { version: '9.9.9' }, percent: 42 };
    const reasons: PathDenyReason[] = [...PATH_DENY_REASONS];
    const denyMsg: string = PATH_DENY_MESSAGES.ESCAPE_ATTEMPT;
    const meta: SessionMeta = { id: 's1', title: 't', createdAt: 0, updatedAt: 0, messageCount: 0 };
    const info: SystemInfo = {
      platform: 'ohos',
      appVersion: '1.0.0',
      osVersion: 'HarmonyOS',
      locale: 'zh-CN',
      capabilities: ['fs.scope'],
    };
    const statusStages: UpdateStage = status.stage;
    const usage: Usage = { promptTokens: 1, completionTokens: 2, totalMs: 3 };
    const errCode: ErrorCode = 'ABORTED';
    const ev: AgentStreamEvent = { type: 'done', runId: 'r', usage };
    const planStatus: PlanStepStatus = 'running';
    const sum: string = summarizeEvent(ev);
    const evSum2: string = summarizeEvent({ type: 'tool', runId: 'r', callId: 'c', name: 'echo', args: 1 });
    return `reasons=${reasons.length} status=${statusStages} hasInfo=${status.stage === 'downloading' ? String(status.percent) : '-'} ` +
      `deny=${denyMsg.length} meta=${meta.id} locale=${info.locale} ev=${sum} ev2=${evSum2} ` +
      `terminal=${String(isTerminalStage('ready'))} code=${errCode} plan=${planStatus}`;
  });

  // L3 ipc
  step('L3 ipc', () => {
    const channel: string = IPC.sessionList;
    const push: string = IPC.updateStatus;
    const appErr = new AppError('SCOPE_DENIED', '越界', 'OUT_OF_SCOPE');
    const parsed = parseIpcError(new Error(encodeBridgeError(appErr).message));
    return `ch=${channel} push=${push} parsed=${parsed.code}/${parsed.detail} ` +
      `known=${String(isPathDenyReason('BAD_PATH'))}`;
  });

  // L4 index（走 index.ts 的 export * 再导出）
  step('L4 index', () => {
    const cap: Capability = 'fs.scope';
    const channel: string = IPC.systemInfo;
    return `${cap} ${channel}`;
  });

  // B 后缀：contract 内部 `from './capability.js'` 的解析
  step('B  .js 后缀', () => {
    const ws: Workspace = { id: 'w', root: '/x', label: 'l', grantedAt: 0, mode: 'read' };
    const chk: string = IPC.fsListDir;
    return `workspace=${ws.mode} ch=${chk} denyMsgs=${PATH_DENY_MESSAGES.NO_WORKSPACE.length}`;
  });

  return out;
}

/** 类型体操的引用点 —— 只存在于类型层，保证编译器必须解析这些别名。 */
export type SpikeTypeRefs = [
  IpcInvokeMap,
  InvokeChannel,
  Req<'session:list'>,
  Res<'session:list'>,
  IpcPushMap,
  PushChannel,
  PushPayload<'agent:stream'>,
  BridgeApi,
  InvokeHandler<'session:list'>,
  InvokeArgs<'session:list'>,
  HandlerCtx,
  PathGuard,
  UpdateInfo,
];
