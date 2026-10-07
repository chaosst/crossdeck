/**
 * crossdeck · HarmonyOS 壳（单窗口）
 *
 * 这个页面要说清一件事：**同一份 contract/core，换一个壳**。
 * `../shared/contract` 与 `../shared/core` 是从 `packages/` 同步过来的**只读副本**
 * （由 scripts/sync-shared.mjs 搬运），一份源都没有重写。
 *
 * 与 Electron 壳的差别（刻意保留，不做假装统一的抽象）：
 *   1. **没有 IPC**。同一进程内，`agent:stream` 那条单向通道整个消失 ——
 *      `bus.subscribe` 直接写 @State，跨进程才需要那条通道。
 *   2. **没有 preload / 错误信封**。contextBridge 丢自定义属性那件事在这里不存在。
 *   3. 能力表短一截（见 shared/ports.ets 的对照表），UI 据此少渲染。
 */
import { SessionStore, AgentRuntime, ScriptedModel, TOOL_SCENARIO_MARKER } from '../shared/core/index';
// ⚠️ 这三者在 contract 里，不在 core —— core 对 contract 只 `import type` 自用，
//    并不再导出（那是"零运行时依赖"这条约定的另一面）。
import type { AgentStreamEvent, SessionMeta, Usage } from '../shared/contract/index';
import { ALL_CAPABILITIES, capabilityNote, detectCapabilities, deviceKind } from '../shared/ports';
import type { Capability } from '../shared/contract/capability';
import { runSpikeReport } from '../shared/probe/spikeReport';
import type { SpikeResult } from '../shared/probe/spikeReport';
// T1 spike：端口形状对照（回调式 vs 异步可迭代）—— 必须**真的调用**才有鉴别力
import { runCallbackProbe, runAsyncProbe } from '../shared/probe/portShape';
// T2 spike：模拟器 → 宿主机的可达性（结果同时写 hilog，前缀 [NETPROBE]）
import { runNetProbe } from '../shared/probe/netProbe';
import type { NetProbeResult } from '../shared/probe/netProbe';

const CARD = '#171A21';
const TEXT = '#E6E6E6';
const DIM = '#9AA0A6';
const ACCENT = '#9FE870';

function summarize(types: string[]): string {
  const parts: string[] = [];
  for (const t of types) {
    const last = parts.length > 0 ? parts[parts.length - 1] : '';
    if (last.startsWith(`${t}×`)) {
      const n = Number(last.slice(t.length + 1)) + 1;
      parts[parts.length - 1] = `${t}×${n}`;
    } else {
      parts.push(`${t}×1`);
    }
  }
  return parts.join('→');
}

@Entry
@Component
struct Index {
  @State capabilities: Capability[] = [];
  @State kind: string = '';
  @State sessions: SessionMeta[] = [];
  @State activeLabel: string = '（无）';
  @State streamText: string = '';
  @State streamMeta: string = '尚未运行';
  @State paused: boolean = false;
  @State running: boolean = false;
  @State spike: SpikeResult[] = [];
  @State portShape: string = '未运行';
  @State netProbe: string = '未运行';

  private store: SessionStore = new SessionStore();
  private agent: AgentRuntime | null = null;
  private activeSessionId: string = '';
  private runId: string = '';
  private types: string[] = [];

  aboutToAppear(): void {
    this.kind = deviceKind();
    this.capabilities = detectCapabilities();
    this.spike = runSpikeReport();

    // T1：两组端口形状各自真实调用一次（只 import 不调用 = 编译器可能不检查）
    const shapeA: string = runCallbackProbe('A组');
    runAsyncProbe('B组').then((shapeB: string): void => {
      this.portShape = `A(回调式)=${shapeA} ｜ B(async可迭代)=${shapeB}`;
    });

    // T2：网络可达性（三种 URL 各打一次）—— 同一份结果也写进 hilog（前缀 [NETPROBE]）
    runNetProbe().then((rs: NetProbeResult[]): void => {
      const lines: string[] = [];
      for (const r of rs) {
        lines.push(`${r.ok ? '✅' : '❌'} ${r.url}  ${r.detail}`);
      }
      this.netProbe = lines.join('\n');
    });

    const runtime = new AgentRuntime({
      deps: {
        now: (): number => Date.now(),
        every: (intervalMs: number, fn: () => void): (() => void) => {
          const timer: number = setInterval(fn, intervalMs);
          return (): void => {
            clearInterval(timer);
          };
        },
        newId: (prefix: string): string => `${prefix}_${Math.floor(Math.random() * 1000000000).toString(36)}`,
      },
      model: new ScriptedModel(),
    });
    runtime.bus.subscribe((event: AgentStreamEvent): void => {
      this.onEvent(event);
    });
    this.agent = runtime;

    const first: SessionMeta = this.store.create({ title: 'ohos shell' });
    this.activeSessionId = first.id;
    this.activeLabel = first.title;
    this.sessions = this.store.list();
  }

  private hasCap(cap: Capability): boolean {
    return this.capabilities.includes(cap);
  }

  private onEvent(event: AgentStreamEvent): void {
    this.types.push(event.type);
    if (event.type === 'token') {
      this.streamText = `${this.streamText}${event.text}`;
    } else if (event.type === 'tool') {
      this.streamText = `${this.streamText}\n⟳ 工具 ${event.name}\n`;
    } else if (event.type === 'tool_end') {
      this.streamText = `${this.streamText}⟳ 返回 ok=${event.ok}（${event.ms}ms）\n`;
    } else if (event.type === 'done') {
      const u: Usage = event.usage;
      const ttft: string = u.ttftMs === undefined ? '?' : `${u.ttftMs}`;
      const merged: number = u.mergedChunks === undefined ? 0 : u.mergedChunks;
      this.streamMeta =
        `事件 ${summarize(this.types)} ｜ 首token ${ttft}ms ｜ 共 ${u.totalMs}ms ｜ 合并 ${merged} 次`;
      this.running = false;
      this.paused = false;
    } else if (event.type === 'error') {
      this.streamMeta = `以 [${event.code}] 结束：${event.message}`;
      this.running = false;
      this.paused = false;
    }
  }

  private start(input: string): void {
    if (this.agent === null || this.running) return;
    this.streamText = '';
    this.streamMeta = '事件 …';
    this.types = [];
    this.running = true;
    this.paused = false;
    const handle = this.agent.startRun({ sessionId: this.activeSessionId, input });
    this.runId = handle.runId;
  }

  private togglePause(): void {
    if (this.agent === null || !this.running) return;
    const wantPause: boolean = !this.paused;
    const ok: boolean = this.agent.pauseOrResume(this.runId, wantPause ? 'pause' : 'resume');
    // 返回 false = run 已不在 —— 静默成功会让 UI 与真实状态不一致
    if (ok) this.paused = wantPause;
    else this.streamMeta = `${this.streamMeta} ｜ 该 run 已结束，控制被拒`;
  }

  private addSession(): void {
    const s: SessionMeta = this.store.create({ title: `会话 ${this.store.size + 1}` });
    this.activeSessionId = s.id;
    this.activeLabel = s.title;
    this.sessions = this.store.list();
  }

  @Builder
  sectionTitle(text: string) {
    Text(text).fontSize(15).fontWeight(FontWeight.Bold).fontColor(TEXT).margin({ top: 6 })
  }

  build() {
    Scroll() {
      Column({ space: 8 }) {
        Text('crossdeck · HarmonyOS 壳').fontSize(22).fontWeight(FontWeight.Bold).fontColor(TEXT)
        Text('同一份 contract / core（packages/ 下的源），换一个壳。')
          .fontSize(12).fontColor(DIM)

        // ① 能力探测
        this.sectionTitle('① 平台能力（真实探测，不是写死）')
        Text(`deviceInfo.deviceType = ${this.kind}`).fontSize(11).fontColor(DIM)
        ForEach(ALL_CAPABILITIES, (cap: Capability) => {
          Row({ space: 4 }) {
            Text(cap).fontSize(12).fontColor(TEXT).width(120)
            Text(this.hasCap(cap) ? '✅' : '—').fontSize(12).width(28)
            Text(capabilityNote(cap)).fontSize(11).fontColor(DIM).layoutWeight(1)
          }
          .width('100%')
          .padding({ top: 3, bottom: 3 })
        }, (cap: Capability) => cap)

        // ② 会话
        this.sectionTitle('② 会话（core 的 SessionStore）')
        Row({ space: 8 }) {
          Button('新建会话').fontSize(13).height(34).onClick(() => {
            this.addSession();
          })
          Text(`当前：${this.activeLabel}`).fontSize(12).fontColor(DIM)
        }
        ForEach(this.sessions, (s: SessionMeta) => {
          Row({ space: 6 }) {
            Text(s.title).fontSize(12).fontColor(s.id === this.activeSessionId ? ACCENT : TEXT)
            Text(`${s.messageCount} 条`).fontSize(11).fontColor(DIM)
          }.width('100%')
        }, (s: SessionMeta) => s.id)

        // ③ Agent 流式
        this.sectionTitle('③ Agent 流式（core 的 AgentRuntime + StreamBus）')
        Row({ space: 8 }) {
          Button('发送').fontSize(13).height(34).enabled(!this.running).onClick(() => {
            this.start('来自鸿蒙壳的一次流式请求');
          })
          Button('带工具').fontSize(13).height(34).enabled(!this.running).onClick(() => {
            this.start(`先查再答 ${TOOL_SCENARIO_MARKER} ohos-shell`);
          })
          Button(this.paused ? '继续' : '暂停').fontSize(13).height(34).enabled(this.running).onClick(() => {
            this.togglePause();
          })
        }
        Text(this.streamText.length === 0 ? '(尚未运行)' : this.streamText)
          .fontSize(12).fontColor(TEXT).width('100%')
          .padding(10).backgroundColor(CARD).borderRadius(6)
        Text(this.streamMeta).fontSize(11).fontColor(DIM).width('100%')

        // ④ M6-0 spike 证据
        this.sectionTitle('④ M6-0 spike：contract 能被 ArkTS 消费吗')
        Text('同样的类型体操放进 .ets 会被 ArkTS 拒绝（arkts-no-conditional-types）；.ts 可以。')
          .fontSize(11).fontColor(DIM)
        ForEach(this.spike, (r: SpikeResult) => {
          Row({ space: 4 }) {
            Text(r.layer).fontSize(11).fontColor(TEXT).width(92)
            Text(r.ok ? '✅' : '❌').fontSize(11).width(24)
            Text(r.detail).fontSize(10).fontColor(DIM).layoutWeight(1)
          }.width('100%')
        }, (r: SpikeResult) => r.layer)

        // ⑤ T1 spike 证据：端口形状（回调式 vs 异步可迭代）
        this.sectionTitle('⑤ T1 spike：端口形状，ArkTS 吃得下哪个')
        Text('A=回调式（sink 三回调 + 返回取消函数）｜ B=AsyncIterable + for await')
          .fontSize(11).fontColor(DIM)
        Text(this.portShape).fontSize(11).fontColor(ACCENT).width('100%')
        Text('两者都编译过 → 结论以编译器实测为准；本行能显示 = 运行时也真的跑通了。')
          .fontSize(10).fontColor(DIM)

        // ⑥ T2 spike 证据：模拟器 → 宿主机可达性
        this.sectionTitle('⑥ T2 spike：模拟器 → 宿主机 可达性')
        Text('宿主机 node 服务器 @ :3901（/ping → pong-from-host）')
          .fontSize(11).fontColor(DIM)
        Text(this.netProbe).fontSize(11).fontColor(TEXT).width('100%')
      }
      .width('100%')
      .padding(18)
      .alignItems(HorizontalAlign.Start)
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#0F1115')
  }
}
