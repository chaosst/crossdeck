import type { AgentStreamEvent, Capability, DirEntry, Workspace } from '@crossdeck/contract';
import type { AgentDeps, ModelPort } from '@crossdeck/core';
import {
  AgentRuntime,
  DEFAULT_FIRST_FRAME_TIMEOUT_MS,
  ScriptedModel,
  SessionStore,
  TOOL_SCENARIO_MARKER,
  WorkspaceStore,
  createPathGuard,
  resolveInWorkspace,
} from '@crossdeck/core';
import { createWebNavigateClient } from './navigate/client.js';
import { WebNavigateModel } from './navigate/model.js';
import { createWebPorts } from './ports.js';
import { runWebSelfCheck } from './selfcheck.js';

/**
 * Web 壳 —— 项目的**试金石**。
 *
 * 它存在的唯一目的是回答一个问题：「core 里还藏着平台假设吗？」
 *
 * 判据是机器可验的，不靠自觉：
 *   · `tsconfig.json` 的 `types: []` → 这个项目拿不到任何 node 全局类型
 *   · Vite 的浏览器构建 → `node:*` 根本解析不了
 *   只要 core 有一处依赖 node，这个包就编译不过、打包不过。
 *
 * 反过来，它现在能编译、能打包、能跑 —— 那"一套 core 多端壳"就不是结论，
 * 而是**刚刚被验证过的事实**。
 *
 * 与 Electron 壳的差别（刻意保留，不做假装统一的抽象）：
 *   1. **没有 IPC**。同进程，所以 `agent:stream` 这条通道整个消失，
 *      `StreamBus.subscribe` 直接写 DOM。跨进程才需要那条通道。
 *   2. **没有 preload / 错误信封**。`contextBridge` 丢自定义属性那件事
 *      在这里不存在 —— 也就不需要 `[CODE:DETAIL]` 那套编码。
 *   3. 能力表短一截（见 ports.ts 的对照表），UI 据此少渲染几块。
 */

/** 「平台无关」在这里的落地：下面这些模块和 Electron 壳用的是**同一份**。 */
const sessions = new SessionStore();
const workspaces = new WorkspaceStore({ caseInsensitive: false });
const shell = await createWebPorts(workspaces);

const guard = createPathGuard(workspaces, {
  realpath: (p) => shell.fs.realpath(p),
});

const deps: AgentDeps = {
  now: () => Date.now(),
  every: (intervalMs, fn) => {
    const timer = setInterval(fn, intervalMs);
    return () => clearInterval(timer);
  },
  newId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`,
};

// ─────────────────────────────────────────────────────────────
// 上游选择 —— 与 Electron 壳同一条决策，差别只在"地址从哪来"：
// 页面没有 env，URL 参数是唯一天然可配的东西。
//
// `?upstream=1`（或 `?upstream=`）→ **同源**（打相对路径，cookie 自然带上）
// `?upstream=/proxy` / `?upstream=https://host` → 指定前缀；不给 → 脚本上游
//
// ⚠️ 同源是唯一被支持的部署形态（Caddy 同域反代，不动服务端）。
// ─────────────────────────────────────────────────────────────
const navigateBase = (() => {
  const params = new URLSearchParams(location.search);
  if (!params.has('upstream')) return null;
  const raw = params.get('upstream') ?? '';
  // `?upstream=1` 是"打开同源"的旗标写法，别把它当路径前缀
  return raw === '1' ? '' : raw;
})();

/** 当前上游的种类与地址。**UI 与自检必须如实显示** —— 不许"假装在连真上游"。 */
function activeUpstream(): { kind: 'scripted' | 'navigate'; baseUrl: string } {
  return navigateBase === null
    ? { kind: 'scripted', baseUrl: '' }
    : { kind: 'navigate', baseUrl: navigateBase === '' ? '（同源）' : navigateBase };
}

function createModel(): ModelPort {
  if (navigateBase === null) return new ScriptedModel({ deps });
  return new WebNavigateModel({
    deps,
    client: createWebNavigateClient({
      baseUrl: navigateBase,
      firstFrameTimeoutMs: DEFAULT_FIRST_FRAME_TIMEOUT_MS,
      deps,
    }),
  });
}

const agent = new AgentRuntime({
  deps,
  model: createModel(),
});

// ─────────────────────────────────────────────────────────────
// 极简 DOM helper —— 刻意不引框架。
// core 既然与框架无关，壳这边用最少的东西反而更能说明这一点。
// ─────────────────────────────────────────────────────────────
function h(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids) el.append(kid);
  return el;
}

function card(title: string, hint: string, ...body: (Node | string)[]): HTMLElement {
  return h('section', { class: 'card' }, h('h2', {}, title), hint ? h('p', { class: 'hint' }, hint) : '', ...body);
}

const app = document.getElementById('app');
if (app === null) throw new Error('缺少 #app 挂载点');

const root = h('div');
app.append(root);

// 机器可读的"当前上游"（自检/验收脚本据此断言，不必去 parse 文案）。
document.body.dataset['upstream'] = activeUpstream().kind;

root.append(
  h('h1', {}, 'crossdeck · Web 壳'),
  h(
    'p',
    { class: 'sub' },
    '同一份 core（SessionStore / WorkspaceStore / PathGuard / AgentRuntime）跑在浏览器里。' +
      '这个包能编译、能打包、能运行，就是「core 没有平台假设」的机器可验证明 —— ' +
      'tsconfig 里 types 置空、Vite 解析不了 node:*，有半点平台依赖都过不去。',
  ),
);

// ─────────────────────────────────────────────────────────────
// ① 平台能力 —— 与 Electron 壳并排看，差异是有意为之
// ─────────────────────────────────────────────────────────────
{
  const ALL: Capability[] = [
    'fs.scope',
    'window.multi',
    'shortcut.global',
    'update.auto',
    'tray',
    'notify.system',
  ];
  const where: Record<Capability, string> = {
    'fs.scope': 'OPFS / File System Access（无 symlink，故逃逸检测退化为纯字符串校验）',
    'window.multi': '❌ 浏览器没有真窗口，只有页面内面板',
    'shortcut.global': '❌ 网页不允许注册全局快捷键',
    'update.auto': '❌ 刷新即最新',
    tray: '❌ 不存在',
    'notify.system': '⚠️ 有，但先要用户授权',
  };

  const rows = ALL.map((cap) => {
    const has = shell.capabilities.has(cap);
    return h(
      'tr',
      {},
      h('td', {}, h('code', {}, cap)),
      h('td', { class: has ? 'ok' : 'no' }, has ? '✅ 具备' : '—'),
      h('td', {}, where[cap]),
    );
  });

  root.append(
    card(
      '平台能力（能力探测，不是平台判断）',
      `platform = ${shell.ports.env.platform} —— core 只用 capabilities.has(...) 做功能分支，` +
        '从不写 if (platform === "electron")。这里的差异是**降级**，不是假装统一。',
      h('table', {}, h('tr', {}, h('th', {}, '能力'), h('th', {}, '状态'), h('th', {}, 'Web 壳的实现 / 缺口')), ...rows),
    ),
  );
}

// ─────────────────────────────────────────────────────────────
// ② Agent 流式 —— 同进程，没有 IPC
// ─────────────────────────────────────────────────────────────
{
  const out = h('pre', { 'data-testid': 'web-stream' }, '(尚未运行)');
  const meta = h('div', { class: 'hint', 'data-testid': 'web-stream-meta' }, '事件类型：（无）');
  const pauseBtn = h('button', { 'data-testid': 'web-pause' }, '暂停') as HTMLButtonElement;
  const sendBtn = h('button', { 'data-testid': 'web-send' }, '发送') as HTMLButtonElement;
  const toolBtn = h('button', { 'data-testid': 'web-tool' }, '带工具跑一次') as HTMLButtonElement;

  const st = new SessionStore();
  const session = st.create({ title: 'web-shell demo' });

  let runId: string | null = null;
  let text = '';
  let types: string[] = [];
  let paused = false;

  agent.bus.subscribe((event: AgentStreamEvent) => {
    types.push(event.type);
    if (event.type === 'token') {
      text += event.text;
      out.textContent = text;
    } else if (event.type === 'done') {
      const u = event.usage;
      meta.textContent =
        `事件序列：${summarize(types)} ｜ 首 token ${u.ttftMs ?? '?'}ms ｜ 共 ${u.totalMs}ms ｜ ` +
        `${u.completionTokens} 字符 ｜ 合并 ${u.mergedChunks ?? 0} 次`;
      runId = null;
      setPaused(false);
    } else if (event.type === 'error') {
      meta.textContent = `事件序列：${summarize(types)} ｜ 以 [${event.code}] 结束`;
      runId = null;
      setPaused(false);
    } else if (event.type === 'tool') {
      text += `\n⟳ 调用工具 ${event.name}(${JSON.stringify(event.args)})\n`;
      out.textContent = text;
    } else if (event.type === 'tool_end') {
      text += `⟳ 工具返回 ok=${event.ok}（${event.ms}ms）\n`;
      out.textContent = text;
    }
  });

  function setPaused(next: boolean): void {
    paused = next;
    pauseBtn.textContent = next ? '继续' : '暂停';
    pauseBtn.disabled = runId === null;
    sendBtn.disabled = runId !== null;
    toolBtn.disabled = runId !== null;
  }

  function start(input: string): void {
    text = '';
    types = [];
    out.textContent = '';
    meta.textContent = '事件类型：…';
    const handle = agent.startRun({ sessionId: session.id, input });
    runId = handle.runId;
    setPaused(false);
  }

  sendBtn.addEventListener('click', () => start('来自 Web 壳的一次流式请求'));
  toolBtn.addEventListener('click', () => start(`先查一下再答 ${TOOL_SCENARIO_MARKER} web-shell`));
  pauseBtn.addEventListener('click', () => {
    if (runId === null) return;
    const ok = paused ? agent.resume(runId) : agent.pause(runId);
    // 返回 false 表示 run 已经不在了 —— 这就是「静默成功」要避免的那种不一致
    if (ok) setPaused(!paused);
    else meta.textContent = `${meta.textContent} ｜ 该 run 已结束，控制指令被拒绝`;
  });

  setPaused(false);
  const up = activeUpstream();
  root.append(
    card(
      'Agent 流式（同进程，没有 IPC 通道）',
      'core 的 StreamBus 直接订阅 DOM。Electron 壳里那一条 agent:stream 单向通道在这里整个消失 —— ' +
        '跨进程才需要它。背压算法是同一份（暂停期间零推送）。' +
        '接上游：地址栏加 `?upstream=1`（同源）或 `?upstream=<前缀>`；不加则用脚本上游。',
      h(
        'div',
        { class: 'row' },
        sendBtn,
        toolBtn,
        pauseBtn,
        h('span', { class: 'badge' }, `session ${session.id.slice(0, 8)}`),
        // 如实标注当前上游：脚本上游被当成真上游，是这个项目最不该出现的诚实性缺口。
        h(
          'span',
          { class: up.kind === 'navigate' ? 'ok' : 'badge', 'data-testid': 'web-upstream' },
          up.kind === 'navigate' ? `上游：navigate ${up.baseUrl}` : '上游：脚本（离线可跑，不是真上游）',
        ),
      ),
      out,
      meta,
    ),
  );
}

function summarize(types: string[]): string {
  // [start, token, token, token, done] → start → token×3 → done
  const parts: string[] = [];
  for (const t of types) {
    const last = parts[parts.length - 1];
    if (last !== undefined && last.startsWith(`${t}×`)) {
      const n = Number(last.slice(t.length + 1)) + 1;
      parts[parts.length - 1] = `${t}×${n}`;
    } else {
      parts.push(`${t}×1`);
    }
  }
  return parts.join(' → ');
}

// ─────────────────────────────────────────────────────────────
// ③ 工作区 scope —— 与 Electron 壳共用同一个 PathGuard
// ─────────────────────────────────────────────────────────────
{
  const treeBox = h('ul', { 'data-testid': 'web-tree' });
  const errBox = h('div', { class: 'err', 'data-testid': 'web-error' });
  const pathLine = h('div', { class: 'hint' }, '路径：—');
  const wsLine = h('div', { class: 'hint' }, '工作区：—');

  const grantBtn = h('button', { 'data-testid': 'web-grant' }, '授权 OPFS 演示目录') as HTMLButtonElement;
  const escapeBtn = h('button', { 'data-testid': 'web-escape' }, '试读 ../') as HTMLButtonElement;

  const DEMO_ROOT = '/ws/demo';
  let activeId: string | null = null;

  function showError(message: string): void {
    errBox.textContent = message;
  }

  function renderTree(entries: DirEntry[]): void {
    treeBox.replaceChildren();
    if (entries.length === 0) {
      treeBox.append(h('li', {}, h('span', { class: 'kind' }, ''), '（空目录）'));
      return;
    }
    for (const e of entries) {
      const name = h('span', {}, e.name);
      treeBox.append(h('li', {}, h('span', { class: 'kind' }, e.kind), name, h('span', { class: 'hint' }, `${e.size}`)));
    }
  }

  async function browse(rel: string): Promise<void> {
    if (activeId === null) return;
    errBox.textContent = '';
    const resolved = await resolveInWorkspace(workspaces, guard, activeId, rel);
    if (!resolved.ok) {
      showError(`[SCOPE_DENIED:${resolved.reason}] 目标路径未通过校验`);
      return;
    }
    pathLine.textContent = `路径：${resolved.absolute}`;
    try {
      renderTree(await shell.fs.listDir(resolved.absolute));
    } catch (err) {
      showError(`读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  grantBtn.addEventListener('click', () => {
    // 走与 Electron 壳**完全相同**的授权路径，只是不需要系统对话框
    const granted = workspaces.grant({ root: DEMO_ROOT, mode: 'readwrite' });
    if (!granted.ok) {
      showError(`授权失败：${granted.reason}`);
      return;
    }
    activeId = granted.workspace.id;
    const ws: Workspace = granted.workspace;
    wsLine.textContent = `工作区：${ws.label} → ${ws.root}（${ws.mode}）`;
    escapeBtn.disabled = false;
    void browse('.');
  });

  escapeBtn.addEventListener('click', () => {
    // 一个**必然失败**的操作 —— 它的价值就是让"越界被拒"肉眼可见
    void browse('..');
  });

  escapeBtn.disabled = true;
  root.append(
    card(
      '工作区 scope（同一个 PathGuard，换了个文件系统）',
      'core 的 WorkspaceStore 与 PathGuard 一行没改，只是 realpath 换成了 OPFS 实现（它没有 symlink，' +
        '所以逃逸检测自然退化为纯字符串校验 —— 这正是 core 里那条降级分支覆盖的形态）。',
      h('div', { class: 'row' }, grantBtn, escapeBtn),
      wsLine,
      pathLine,
      treeBox,
      errBox,
    ),
  );
}

// ─────────────────────────────────────────────────────────────
// 自检模式 —— `?selfcheck=1`
//
// 浏览器里没有"进程退出码"，所以判定走两路：
//   · 控制台哨兵 `[selfcheck] DONE ok=… code=…`，由 scripts/web-selfcheck.mjs
//     通过 CDP 收走并**以它为准**决定退出码（与 Electron 壳同一套思路：
//     校验链不挂在"进程能不能退出"上）
//   · 报告 JSON 写进 DOM，人肉核对时不用打开 DevTools
// ─────────────────────────────────────────────────────────────
if (new URLSearchParams(location.search).has('selfcheck')) {
  const banner = h('div', { class: 'banner' }, '自检运行中…');
  const reportBox = h('pre', { id: 'selfcheck-report', style: 'display:none' }, '');
  root.prepend(banner);
  root.append(reportBox);

  try {
    const report = await runWebSelfCheck();
    reportBox.textContent = JSON.stringify(report, null, 2);
    const assertions = Object.keys(report.probe).length;
    banner.textContent = report.ok
      ? `✅ Web 壳自检通过 · ${assertions} 项断言 · ${report.coreBindingsImported.length} 个 core 绑定取自同一份产物`
      : `❌ Web 壳自检失败 · ${report.failures.length} 项：${report.failures.join(' / ')}`;
    banner.className = `banner ${report.ok ? 'is-ok' : 'is-bad'}`;
    console.log(`[selfcheck] DONE ok=${report.ok} code=${report.ok ? 0 : 1}`);
    if (!report.ok) console.log(`[selfcheck] 失败项：${report.failures.join(' | ')}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    reportBox.textContent = JSON.stringify({ ok: false, thrown: message }, null, 2);
    banner.textContent = `❌ 自检自身抛错：${message}`;
    banner.className = 'banner is-bad';
    console.log('[selfcheck] DONE ok=false code=1');
    console.error(err);
  }
}
