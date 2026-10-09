/**
 * crossdeck · HarmonyOS 壳（单窗口）。
 *
 * 要说的是一件事：**同一份 contract/core，换一个壳**。
 * `../shared/contract` 与 `../shared/core` 是从 `packages/` 同步过来的**只读副本**。
 *
 * 与 Electron 壳的差别（刻意保留，不做假装统一的抽象）：没有 IPC（同进程直接订阅）、
 * 没有 preload / 错误信封、能力表短一截（见 shared/ports.ets），UI 据此少渲染。
 */
import { SessionStore, AgentRuntime, ScriptedModel, TOOL_SCENARIO_MARKER,
  DEFAULT_FIRST_FRAME_TIMEOUT_MS, errorMessage } from '../shared/core/index';
import type { AgentDeps, ModelPort, NavigateDiagnostic } from '../shared/core/index';
import { http } from '@kit.NetworkKit';
import { createOhosNavigateClient } from '../navigate/NavigateClient';
import { OhosNavigateModel } from '../navigate/NavigateModel';
// ⚠️ 这三者在 contract 里，不在 core —— core 对 contract 只 `import type` 自用，
//    并不再导出（那是"零运行时依赖"这条约定的另一面）。
import type { AgentStreamEvent, SessionMeta, Usage } from '../shared/contract/index';
import { ALL_CAPABILITIES, capabilityNote, detectCapabilities, deviceKind } from '../shared/ports';
import type { Capability } from '../shared/contract/capability';
import { runSpikeReport } from '../shared/probe/spikeReport';
import type { SpikeResult } from '../shared/probe/spikeReport';
// 端口形状对照 spike（回调式 vs 异步可迭代）—— 必须**真的调用**才有鉴别力
import { runCallbackProbe, runAsyncProbe } from '../shared/probe/portShape';
// 模拟器 → 宿主机可达性 spike（结果同时写 hilog，前缀 [NETPROBE]）
import { runNetProbe } from '../shared/probe/netProbe';
import type { NetProbeResult } from '../shared/probe/netProbe';

const CARD = '#171A21';
const TEXT = '#E6E6E6';
const DIM = '#9AA0A6';
const ACCENT = '#9FE870';

// ─────────────────────────────────────────────────────────────
// 上游选择 —— 有地址就接 navigate，否则退回脚本上游。
//
// ⚠️ 鸿蒙没有 Android 的 `10.0.2.2`：模拟器里 `127.0.0.1` 指的是**它自己**。
//    所以宿主机上跑的服务要先 `hdc rport tcp:<port> tcp:<port>` 映射进来（实测走这条路）。
//
// 地址从哪来：**命令行参数**（`aa start … --ps upstreamUrl …`）→ EntryAbility →
// AppStorage → 这里的 `@StorageLink`。参数不给就保持**脚本上游** —— 离线也能把界面
// 跑起来，这是演示形态，不该被"必须连上上游"绑住。
// ⚠️ 这条通道是 T14 为了自检才做的（用户侧的配置界面仍是后续的事）。
//    参数缺失时**不猜默认地址**：猜出来的地址会让"没配上游"看起来像"配了但连不上"。
// ─────────────────────────────────────────────────────────────
const DEFAULT_UPSTREAM_BASE = '';

/**
 * 自检要跑的五个场景。
 *
 * 这里只有 **key**：prompt 字符串由假上游下发的 fixture 提供。
 * 页面硬编码 prompt 的话，词表改了页面还认旧的 —— 而症状是"这个场景不存在（400）"，
 * 看起来像客户端的问题。
 */
const SELFCHECK_SCENARIO_KEYS: string[] = ['normal', 'silent-close', 'killed', 'upstream-error', 'abort'];

interface NavFixture {
  chatPath: string;
  auth: string;
  scenarios: Record<string, string>;
  normalChunks: string[];
  normalText: string;
  unknownPrompt: string;
}

interface NavUpstreamStats {
  logins: number;
  frames: Record<string, number>;
  ended: string[];
  doneSent: string[];
  clientGone: string[];
  unknown: string[];
}

/** 一次自检 run 在订阅点观察到的结果。 */
interface NavRunResult {
  key: string;
  /** 最后一个终态的类型（`done` / `error` / 空 = 没等到） */
  terminal: string;
  code: string;
  /**
   * 终态那句话。**两条断流路径靠它区分**：
   *   干净 EOF（没发 done）→ "上游提前关闭连接：没收到 done 帧"
   *   socket 被销毁        → "读取上游流失败"
   * 只比错误码的话，把两条路合成一条也照样绿 —— 而合成会漏掉另一条路径的失败模式。
   */
  message: string;
  /** 终态**个数** —— 不是 1 就是要抓的 bug */
  terminals: number;
  textLength: number;
  /** 收到的 token 事件数（背压泵的推送粒度） */
  tokenEvents: number;
  error: string;
}

/** 一次 GET 的结果。**绝不抛** —— 成败都要变成可断言的字符串。 */
interface HttpGetResult {
  ok: boolean;
  body: string;
  detail: string;
}

/**
 * 只读地拉一段文本。
 *
 * 与 `netProbe` 的 `probeUrl` 同一条约定：**绝不抛**。否则"取不到 fixture"
 * 会被报成一个看不懂的异常，而不是一句能直接照做的话。
 * （顺带对 ArkTS 的 "Function may throw exceptions" 检查交代得过去。）
 */
async function httpGetText(url: string): Promise<HttpGetResult> {
  const client = http.createHttp();
  try {
    const res = await client.request(url, {
      method: http.RequestMethod.GET,
      connectTimeout: 8000,
      readTimeout: 8000,
    });
    const body: string = typeof res.result === 'string' ? res.result : '';
    return { ok: res.responseCode === 200, body, detail: `HTTP ${res.responseCode}` };
  } catch (e) {
    return { ok: false, body: '', detail: errorMessage(e) };
  } finally {
    client.destroy();
  }
}

/**
 * 自检链路专用的 navigate 模型。
 *
 * ⚠️ **为什么不拿它替换演示链路**（③ 节那个 agent）：演示链路跑的是脚本上游，
 *    换掉之后「带工具」会去 navigate 上游要一个它不认识的场景 → 400，
 *    那张工具链路截图就废了。Electron / Web 两端也是同一取舍：
 *    **上游判定用一条专用链路**，被替换的只有"上游是谁"这一件事。
 */
function createNavModel(
  deps: AgentDeps,
  baseUrl: string,
  getToken: () => string | null,
  onDiagnostic: (d: NavigateDiagnostic) => void,
): ModelPort {
  return new OhosNavigateModel({
    deps,
    client: createOhosNavigateClient({
      baseUrl,
      getToken,
      firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
      deps,
      onDiagnostic,
    }),
  });
}

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
  // 自检配置（由 EntryAbility 从 `--ps` 参数注入 AppStorage；缺省空 = 不出现自检面板）
  @StorageLink('upstreamUrl') cfgUpstream: string = '';
  @StorageLink('ohosToken') cfgToken: string = '';
  @State navLines: string[] = [];
  @State navRunning: boolean = false;
  /** 自检链路的实时逐字流（与演示链路分开 —— 两条链路互不干扰） */
  @State navStreamText: string = '';
  @State navMeta: string = '（自检链路尚未运行）';

  private store: SessionStore = new SessionStore();
  private agent: AgentRuntime | null = null;
  /** 自检链路（navigate 上游）；没配上游时为 null */
  private navAgent: AgentRuntime | null = null;
  private navFrames: number = 0;
  /** 「慢流」那一次 run 的 id（停止按钮用它） */
  private navRunId: string = '';
  private activeSessionId: string = '';
  private runId: string = '';
  private types: string[] = [];

  private upstreamBase(): string {
    return this.cfgUpstream.length > 0 ? this.cfgUpstream : DEFAULT_UPSTREAM_BASE;
  }

  /** 配了上游 = 自检模式：把可观测的那块提到首屏（截图只拍得到首屏）。 */
  private selfcheckMode(): boolean {
    return this.cfgUpstream.length > 0;
  }

  /** 自检链路上有 run 在跑（慢流或判定）时，按钮该锁住。 */
  private selfcheckBusy(): boolean {
    return this.navRunning || this.navRunId.length > 0;
  }

  aboutToAppear(): void {
    this.kind = deviceKind();
    this.capabilities = detectCapabilities();
    this.spike = runSpikeReport();

    // 端口形状：两组各自真实调用一次（只 import 不调用 = 编译器可能不检查）
    const shapeA: string = runCallbackProbe('A组');
    runAsyncProbe('B组').then((shapeB: string): void => {
      this.portShape = `A(回调式)=${shapeA} ｜ B(async可迭代)=${shapeB}`;
    });

    // 网络可达性：三种 URL 各打一次—— 同一份结果也写进 hilog（前缀 [NETPROBE]）
    runNetProbe().then((rs: NetProbeResult[]): void => {
      const lines: string[] = [];
      for (const r of rs) {
        lines.push(`${r.ok ? '✅' : '❌'} ${r.url}  ${r.detail}`);
      }
      this.netProbe = lines.join('\n');
    });

    const deps: AgentDeps = {
      now: (): number => Date.now(),
      every: (intervalMs: number, fn: () => void): (() => void) => {
        const timer: number = setInterval(fn, intervalMs);
        return (): void => {
          clearInterval(timer);
        };
      },
      newId: (prefix: string): string => `${prefix}_${Math.floor(Math.random() * 1000000000).toString(36)}`,
    };
    const runtime = new AgentRuntime({ deps, model: new ScriptedModel({ deps }) });
    runtime.bus.subscribe((event: AgentStreamEvent): void => {
      this.onEvent(event);
    });
    this.agent = runtime;

    // 自检链路（只在配了上游时建）—— 与演示链路**互不干扰**。
    if (this.selfcheckMode()) {
      const navRuntime = new AgentRuntime({
        deps,
        model: createNavModel(
          deps,
          this.upstreamBase(),
          (): string | null => (this.cfgToken.length > 0 ? this.cfgToken : null),
          (d: NavigateDiagnostic): void => {
            // 只数 `chunk`：那是**真的收到一片字节**的次数（"逐帧到达"的判据）。
            if (d.type === 'chunk') this.navFrames += 1;
          },
        ),
      });
      navRuntime.bus.subscribe((event: AgentStreamEvent): void => {
        this.onNavEvent(event);
      });
      this.navAgent = navRuntime;
    }

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

  /** 自检链路的事件 —— 只关心"逐字流"和终态，工具调用不会出现在这条链路上。 */
  private onNavEvent(event: AgentStreamEvent): void {
    if (event.type === 'token') {
      this.navStreamText = `${this.navStreamText}${event.text}`;
    } else if (event.type === 'done') {
      const u: Usage = event.usage;
      this.navMeta = `done ｜ 字符 ${u.completionTokens} ｜ 共 ${u.totalMs}ms ｜ 帧 ${this.navFrames}`;
      this.navRunId = '';
    } else if (event.type === 'error') {
      this.navMeta = `error ｜ [${event.code}] ${event.message}`;
      this.navRunId = '';
    }
  }

  /** 发一条**慢流**（自检链路）—— 纯为抓拍：20ms 那档 300ms 就完了，拍不到中间帧。 */
  private startSlowStream(): void {
    const base = this.upstreamBase();
    httpGetText(`${base}/__selfcheck/nav-fixture`).then((fx: HttpGetResult): void => {
      if (!fx.ok || fx.body.length === 0) {
        this.navLines = [`[SELFCHECK] error 取不到 fixture（${fx.detail}）`];
        return;
      }
      const fixture = JSON.parse(fx.body) as NavFixture;
      this.navLines = [`[SELFCHECK] 慢流已发出 prompt=${fixture.scenarios['slow']}`];
      this.startNav(fixture.scenarios['slow']);
    });
  }

  private startNav(input: string): void {
    const nav = this.navAgent;
    if (nav === null) return;
    this.navStreamText = '';
    this.navMeta = '事件 …';
    this.navFrames = 0;
    this.navRunId = nav.startRun({ sessionId: this.activeSessionId, input }).runId;
  }

  /** 停止自检链路 —— 走 `abort()`，最终落到 `httpRequest.destroy()`（真断连接）。 */
  private stopNav(): void {
    const nav = this.navAgent;
    if (nav === null || this.navRunId.length === 0) return;
    const ok: boolean = nav.abort(this.navRunId);
    if (!ok) this.navMeta = `${this.navMeta} ｜ 该 run 已结束，控制被拒`;
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

  /**
   * 停止 = **真断连接**（`http.destroy()`），不是"不再读"。
   *
   * 判据在**对端**：假上游会记录"客户端在写完之前断开了吗"（`clientGone`）。
   * 客户端自己说"我停了"不算证据。
   */
  private stop(): void {
    if (this.agent === null || !this.running) return;
    const ok: boolean = this.agent.abort(this.runId);
    if (!ok) this.streamMeta = `${this.streamMeta} ｜ 该 run 已结束，控制被拒`;
  }

  /**
   * 跑一次真实链路并收全量事件（自检用）。
   *
   * ⚠️ 收到终态后**不立刻退订** —— 一收到就摘，第二个终态永远没人听，
   *    "终态恰好一个"这条断言就恒真了。留一个短窗口再收。
   */
  private navPromise(prompt: string, abortAfterMs: number): Promise<NavRunResult> {
    return new Promise<NavRunResult>((resolve: (r: NavRunResult) => void): void => {
      const empty: NavRunResult = {
        key: prompt, terminal: '', code: '', message: '', terminals: 0, textLength: 0, tokenEvents: 0,
        error: 'agent 未就绪',
      };
      const agent = this.navAgent;
      if (agent === null) {
        resolve(empty);
        return;
      }
      let settled = false;
      let terminals = 0;
      let lastTerminal = '';
      let code = '';
      let message = '';
      let textLength = 0;
      let tokenEvents = 0;
      let runId = '';

      const off = agent.bus.subscribe((e: AgentStreamEvent): void => {
        if (e.type === 'token') {
          textLength += e.text.length;
          tokenEvents += 1;
        } else if (e.type === 'done') {
          terminals += 1;
          lastTerminal = 'done';
        } else if (e.type === 'error') {
          terminals += 1;
          lastTerminal = 'error';
          code = e.code;
          message = e.message;
        }
        if ((e.type === 'done' || e.type === 'error') && !settled) {
          settled = true;
          setTimeout((): void => {
            off();
            resolve({ key: prompt, terminal: lastTerminal, code, message, terminals, textLength, tokenEvents, error: '' });
          }, 250);
        }
      });

      runId = agent.startRun({ sessionId: this.activeSessionId, input: prompt }).runId;
      if (abortAfterMs > 0) {
        // 等它真的滴了几帧再停 —— 停得太早测的是"还没开始就取消"，不是"中途中断"。
        setTimeout((): void => {
          agent.abort(runId);
        }, abortAfterMs);
      }
      setTimeout((): void => {
        if (settled) return;
        settled = true;
        off();
        resolve({ key: prompt, terminal: lastTerminal, code, message, terminals, textLength, tokenEvents, error: '12s 内没有终态' });
      }, 12000);
    });
  }

  /**
   * 自检：跑同一套判定（真的连上了 / 终态恰好一个 / abort 有效）。
   *
   * ⚠️ 这里**不判成功失败**，只把观察到的原始数字打出来（`[SELFCHECK]` 前缀）。
   *    判定归 `scripts/verify-ohos.mjs` —— 应用自己宣布"我通过了"不是证据。
   */
  private async runSelfCheck(): Promise<void> {
    const base = this.upstreamBase();
    const lines: string[] = [];
    let runs = 0;
    const push = (s: string): void => {
      lines.push(`[SELFCHECK] ${s}`);
    };
    push(`upstream=${base.length > 0 ? base : '(未配置)'}`);

    if (base.length > 0) {
      const fx = await httpGetText(`${base}/__selfcheck/nav-fixture`);
      if (!fx.ok || fx.body.length === 0) {
        push(`error 取不到 fixture（${fx.detail}）—— 上游没起，或没经 hdc rport 映射进来`);
      } else {
        const fixture = JSON.parse(fx.body) as NavFixture;
        push(`fixture scenarios=${SELFCHECK_SCENARIO_KEYS.length}`);
        for (const key of SELFCHECK_SCENARIO_KEYS) {
          const r = await this.navPromise(fixture.scenarios[key], key === 'abort' ? 260 : 0);
          runs += 1;
          push(
            `run ${key} terminal=${r.terminal.length > 0 ? r.terminal : 'none'} count=${r.terminals} ` +
              `code=${r.code.length > 0 ? r.code : '-'} text=${r.textLength} frames=${r.tokenEvents}` +
              (r.error.length > 0 ? ` error=${r.error}` : '') +
              (r.message.length > 0 ? ` msg=${r.message}` : ''),
          );
        }
        // 反向：不认识的场景必须被上游拒掉（证明前面那些是**被词表认出来**的）
        const bad = await this.navPromise(fixture.unknownPrompt, 0);
        runs += 1;
        push(
          `run unknown terminal=${bad.terminal.length > 0 ? bad.terminal : 'none'} count=${bad.terminals} ` +
            `code=${bad.code.length > 0 ? bad.code : '-'}` +
            (bad.message.length > 0 ? ` msg=${bad.message}` : ''),
        );
        const st = await httpGetText(`${base}/__selfcheck/nav-stats`);
        if (!st.ok || st.body.length === 0) {
          push(`error 取不到上游统计（${st.detail}）`);
        } else {
          const stats = JSON.parse(st.body) as NavUpstreamStats;
          push(
            `peer clientGone=${stats.clientGone.join(',')} doneSent=${stats.doneSent.join(',')} logins=${stats.logins}`,
          );
        }
      }
    }
    push(`DONE runs=${runs}`);
    this.navLines = lines;
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

        // ─────────────────────────────────────────────────────
        // ⓪ 自检面板 —— **只在配了上游时出现**，且刻意放在最前面。
        //
        // 为什么要在最前面：`snapshot_display` 只拍得到**首屏**，而这张任务卡的判据是
        // 「截图要能看到逐字流」。放在第 ③ 节（能力表 + 会话表之后）时，流式卡片
        // 早就滚出屏幕了 —— 截图上只会看到能力表。
        // 后面几节是常规演示，自检不该改动它们的排布。
        // ─────────────────────────────────────────────────────
        if (this.selfcheckMode()) {
          this.sectionTitle('⓪ 自检（`--ps upstreamUrl` 才会出现）')
          Text(`上游：${this.cfgUpstream}（${this.cfgToken.length > 0 ? '带凭据' : '无凭据'}）`)
            .fontSize(11).fontColor(ACCENT)
          Row({ space: 8 }) {
            Button('自检·慢流').fontSize(13).height(34).enabled(!this.selfcheckBusy()).onClick(() => {
              this.startSlowStream();
            })
            Button('自检·停止').fontSize(13).height(34).enabled(this.navRunId.length > 0).onClick(() => {
              this.stopNav();
            })
            Button('自检·跑判定').fontSize(13).height(34).enabled(!this.selfcheckBusy()).onClick(() => {
              this.navRunning = true;
              this.runSelfCheck().then((): void => {
                this.navRunning = false;
              });
            })
          }
          // 逐字流就画在这里 —— 抓拍时应当看到**半截**文本，那才是"逐字"
          Text(this.navStreamText.length === 0 ? '(尚未运行)' : this.navStreamText)
            .fontSize(12).fontColor(TEXT).width('100%')
            .padding(10).backgroundColor(CARD).borderRadius(6)
          Text(this.navMeta).fontSize(11).fontColor(DIM).width('100%')
          ForEach(this.navLines, (line: string, index: number) => {
            Text(line).fontSize(10).fontColor(ACCENT).width('100%')
          }, (line: string, index: number) => `${index}:${line}`)
        }

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
          Button('停止').fontSize(13).height(34).enabled(this.running).onClick(() => {
            this.stop();
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

        // ⑤ 端口形状 spike 证据（回调式 vs 异步可迭代）
        this.sectionTitle('⑤ 端口形状 spike：ArkTS 吃得下哪个')
        Text('A=回调式（sink 三回调 + 返回取消函数）｜ B=AsyncIterable + for await')
          .fontSize(11).fontColor(DIM)
        Text(this.portShape).fontSize(11).fontColor(ACCENT).width('100%')
        Text('两者都编译过 → 结论以编译器实测为准；本行能显示 = 运行时也真的跑通了。')
          .fontSize(10).fontColor(DIM)

        // ⑥ 模拟器 → 宿主机可达性 spike 证据
        this.sectionTitle('⑥ 模拟器 → 宿主机 可达性 spike')
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
