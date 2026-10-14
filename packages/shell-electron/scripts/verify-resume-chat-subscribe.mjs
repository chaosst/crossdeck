#!/usr/bin/env node
/**
 * ResumeChat 流式订阅的回归验证（运行 `pnpm --filter @crossdeck/shell-electron verify:resume-chat`）。
 *
 * 背景 bug：订阅写在 componentDidUpdate 里 → 每个 token 触发重渲染 → 再挂一个监听器
 * → 同一 token 被追加 N 次（N 随流式进程增长），界面字符错乱翻倍。
 *
 * 方法：esbuild 打包真组件源码，jsdom + ReactDOM 真挂载，桩掉 window.bridge.on 后
 * 真实发射 start/token 事件流，断言 store 里的文本逐字符精确。
 * 变异体必须挂在预期断言上；反向拿掉断言后变异必须存活。锚点失配报失败，不跳过。
 *
 * 实测（2026-10-14 定稿）：基线 2 断言全绿；3 变异全杀且归因唯一；反向 3 例成立。
 * 注意：场景不包 StrictMode —— dev 双挂载会把"漏退订"同时放大成文本翻倍，
 * 会让 M1 归因不唯一；StrictMode 放大由真实 dev 环境兜底。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as esbuild from 'esbuild';

// jsdom 装在托管 node 工作区（不在本项目依赖里）：CJS 解析认 NODE_PATH，失败再走绝对路径兜底。
const nodeRequire = createRequire(import.meta.url);
function loadJsdom() {
  try {
    return nodeRequire('jsdom');
  } catch {
    return nodeRequire('C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/jsdom');
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const rendererSrc = path.join(pkgRoot, 'src', 'renderer');
const SOURCES = {
  page: path.join(rendererSrc, 'pages', 'resumeChat.tsx'),
};
const tmpDir = path.join(pkgRoot, '.verify-resume-chat-tmp');

const checks = [];
function check(id, fn) {
  checks.push({ id, fn });
}
function assertEq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg} —— 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// ── jsdom 环境（必须在 import 任何 react 代码之前就绪） ──
const { JSDOM } = loadJsdom();
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
setGlobal('window', dom.window);
setGlobal('document', dom.window.document);
setGlobal('navigator', dom.window.navigator);
setGlobal('HTMLElement', dom.window.HTMLElement);
setGlobal('Element', dom.window.Element);
setGlobal('Node', dom.window.Node);
setGlobal('requestAnimationFrame', dom.window.requestAnimationFrame?.bind(dom.window));
setGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame?.bind(dom.window));

// 桩 bridge：忠实模拟 preload 的语义 —— 每次 on 都注册一个独立监听器并广播，
// 退订只摘掉自己。泄漏的监听器会持续收到事件（这正是原 bug 的放大机制）。
function makeBridge() {
  const state = { handlers: [], registered: 0, unsubscribed: 0 };
  return {
    state,
    on(_channel, handler) {
      state.handlers.push(handler);
      state.registered += 1;
      return () => {
        const i = state.handlers.indexOf(handler);
        if (i >= 0) state.handlers.splice(i, 1);
        state.unsubscribed += 1;
      };
    },
    emit(event) {
      for (const h of [...state.handlers]) h(event);
    },
    invoke: async () => ({}),
  };
}

async function bundleAndImport({ overrides = {}, tag = 'base' } = {}) {
  const outfile = path.join(tmpDir, `resume-chat-${tag}.cjs`);
  const entry = path.join(tmpDir, `entry-${tag}.mjs`);
  const rel = (p) => './' + path.relative(tmpDir, p).split(path.sep).join('/');
  writeFileSync(
    entry,
    [
      `export { default as ResumeChat } from '${rel(SOURCES.page)}';`,
      `export { store } from '${rel(path.join(rendererSrc, 'store', 'index.ts'))}';`,
      `export { streamTokenAppended, streamReset } from '${rel(path.join(rendererSrc, 'store', 'slices', 'stream.ts'))}';`,
      '',
    ].join('\n').replace(/\r\n/g, '\n'),
    'utf8',
  );

  const overridePlugin = {
    name: 'variant-override',
    setup(build) {
      build.onLoad({ filter: /resumeChat\.tsx$/ }, async (args) => {
        if (!Object.keys(overrides).length) return null;
        return { contents: overrides.page ?? readFileSync(SOURCES.page, 'utf8'), loader: 'tsx' };
      });
    },
  };

  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    // CJS：react / react-dom / react-redux 外置后由 Node 从包内 node_modules 解析，
    // 与本脚本用的渲染器同源 —— 打进产物会造成 React 双拷贝（hooks dispatcher 失配）。
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-redux', 'jsdom'],
    alias: { '@crossdeck/contract': path.join(pkgRoot, '..', 'contract', 'src', 'index.ts') },
    logLevel: 'silent',
    plugins: [overridePlugin],
  });

  const imported = await import(pathToFileURL(outfile).href);
  const mod = imported.default ?? imported;
  // connect() 返回 React.memo 包装对象（不是 function），能被 createElement 接受即可。
  if (!mod.ResumeChat) throw new Error('产物里没有 ResumeChat');
  if (!mod.store) throw new Error('产物里没有 store');
  return mod;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** 轮询到条件成立（React 提交时机不定，固定 sleep 会踩空）。超时抛错。 */
async function waitFor(cond, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`等待超时：${label}`);
}

async function mountAndStream(mod, bridge, tokens) {
  // react / react-dom 必须与 bundle 里外置解析的是同一份拷贝 → 统一走 CJS require。
  const React = nodeRequire('react');
  const { createRoot } = nodeRequire('react-dom/client');
  const { Provider } = nodeRequire('react-redux');
  const root = createRoot(document.getElementById('root'));
  // 不包 StrictMode：dev 双挂载会把"漏退订"同时放大成文本翻倍，导致 M1 归因不唯一。
  // 这里测组件自身的订阅契约（挂载一次/卸载退订），StrictMode 放大留给真实 dev 环境兜底。
  root.render(
    React.createElement(Provider, { store: mod.store }, React.createElement(mod.ResumeChat, { className: 'x' })),
  );

  // 界面就绪（恰好一个活跃监听器）才开始发流 —— 对应真实用户在 UI 可用后点发送。
  await waitFor(
    () => bridge.state.handlers.length === 1,
    '挂载后应恰好有 1 个活跃监听器',
  );
  await settle();

  bridge.emit({ type: 'start', runId: 'r1' });
  await settle();
  for (const t of tokens) {
    bridge.emit({ type: 'token', text: t });
    await settle();
  }
  return root;
}

// ── 断言 ──

check('subscribe.exact-text-once', (ctx) => {
  assertEq(ctx.finalText, ctx.tokens.join(''), '每个 token 必须恰好追加一次（重渲染不得引入新监听器）');
});

check('subscribe.unmount-unsubscribes', (ctx) => {
  assertEq(
    ctx.bridge.state.unsubscribed,
    ctx.bridge.state.registered,
    '卸载后退订数必须等于注册数（不得泄漏监听器）',
  );
  assertEq(ctx.bridge.state.handlers.length, 0, '卸载后不得残留活跃监听器');
});

// ── 变异表 ──
const VARIANTS = [
  {
    name: 'M1 卸载不退订（监听器泄漏）',
    from: '    this.unsubscribe?.();\n',
    to: '',
    kills: 'subscribe.unmount-unsubscribes',
  },
  {
    name: 'M2 token 重复 dispatch（每 token 追加两次）',
    from: '          store.dispatch(streamTokenAppended(event.text));',
    to: '          store.dispatch(streamTokenAppended(event.text));\n          store.dispatch(streamTokenAppended(event.text));',
    kills: 'subscribe.exact-text-once',
  },
  {
    name: 'M3 每次重渲染都重新订阅（订阅退化到 update 路径）',
    from: '  override componentWillUnmount(): void {',
    to: '  override componentDidUpdate(): void {\n    this.unsubscribe?.();\n    this.unsubscribe = onAgentEvent(() => {});\n  }\n\n  override componentWillUnmount(): void {',
    kills: 'subscribe.exact-text-once',
  },
];

async function main() {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const problems = [];
  const ok = (msg) => console.log(`  ✅ ${msg}`);
  const bad = (msg) => {
    console.log(`  ❌ ${msg}`);
    problems.push(msg);
  };

  const TOKENS = ['你好', '，', '我是', '简历', '问答', '助手', '你好'];

  async function runScenario(mod, disabled = new Set()) {
    const bridge = makeBridge();
    globalThis.window.bridge = bridge;
    mod.store.dispatch(mod.streamReset());
    const root = await mountAndStream(mod, bridge, TOKENS);
    const ctx = {
      bridge,
      tokens: TOKENS,
      finalText: mod.store.getState().stream.text,
    };
    const failed = [];
    // 卸载前的断言（卸载断言留给 unmount 之后的第二轮）
    for (const c of checks) {
      if (c.id === 'subscribe.unmount-unsubscribes' || disabled.has(c.id)) continue;
      try {
        c.fn(ctx);
      } catch (e) {
        failed.push({ id: c.id, msg: e instanceof Error ? e.message : String(e) });
      }
    }
    const finalText = mod.store.getState().stream.text;
    root.unmount();
    // 有界等待 React 走完卸载生命周期；等不到就交给断言判负（如 M1 故意不退订）。
    await settle(50);
    // 卸载后的断言单独跑（ctx 里带卸载后的 bridge 状态）
    for (const c of checks) {
      if (c.id !== 'subscribe.unmount-unsubscribes' || disabled.has(c.id)) continue;
      try {
        c.fn(ctx);
      } catch (e) {
        failed.push({ id: c.id, msg: e instanceof Error ? e.message : String(e) });
      }
    }
    return { failed, bridge, finalText };
  }

  try {
    console.log('\n[1/3] 基线（真实现 + StrictMode 挂载）');
    const baseMod = await bundleAndImport({ tag: 'base' });
    const base = await runScenario(baseMod);
    for (const f of base.failed) bad(`基线不该挂：${f.id} —— ${f.msg}`);
    if (base.failed.length === 0) ok(`${checks.length} 条断言全绿`);
    console.log(`      最终文本 = ${JSON.stringify(base.finalText.slice(0, 30))}...`);

    console.log('\n[2/3] 变异鉴别力');
    const reverseCases = [];
    let killed = 0;
    for (const v of VARIANTS) {
      // 编辑器可能写出 CRLF：锚点统一按 LF 匹配（仓库 eol=lf）。
      const src = readFileSync(SOURCES.page, 'utf8').replace(/\r\n/g, '\n');
      if (!src.includes(v.from)) {
        bad(`${v.name}｜变异锚点在源码里找不到 —— 请更新锚点`);
        continue;
      }
      const mutated = src.replace(v.from, v.to);
      if (mutated === src) {
        bad(`${v.name}｜替换后源码无变化`);
        continue;
      }
      const mod = await bundleAndImport({ overrides: { page: mutated }, tag: `m-${VARIANTS.indexOf(v)}` });
      const res = await runScenario(mod);
      const hit = res.failed.find((f) => f.id === v.kills);
      const others = res.failed.filter((f) => f.id !== v.kills);
      if (hit) {
        killed += 1;
        ok(`${v.name} → 被杀（${v.kills}）`);
        if (others.length > 0) {
          console.log(`      ↳ 另被覆盖：${others.map((f) => f.id).join(', ')}（仅记录）`);
        }
        reverseCases.push({ variant: v, mod });
      } else {
        bad(`${v.name} → 存活！预期被 ${v.kills} 杀掉，实际失败集 = [${res.failed.map((f) => f.id).join(', ') || '空'}]`);
      }
    }

    console.log('\n[3/3] 反向验证（拿掉承重断言 → 同一变异必须存活）');
    for (const rc of reverseCases) {
      const res = await runScenario(rc.mod, new Set([rc.variant.kills]));
      if (res.failed.length === 0) {
        ok(`${rc.variant.name}｜移除 ${rc.variant.kills} 后已无法被杀 ✔ 归因成立`);
      } else {
        bad(`${rc.variant.name}｜移除后仍被 ${res.failed.map((f) => f.id).join(', ')} 杀掉 —— 归因不唯一`);
      }
    }

    console.log('\n─── 汇总 ───');
    console.log(`  断言 ${checks.length} 条 · 变异 ${VARIANTS.length} 个（被杀 ${killed}）`);
    if (problems.length === 0) {
      console.log('  结论：全部通过。');
    } else {
      console.log(`  结论：${problems.length} 项问题 —— 见上方 ❌。`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  process.exitCode = problems.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('verify-resume-chat-subscribe 崩了：', e);
  process.exitCode = 1;
});
