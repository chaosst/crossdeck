#!/usr/bin/env node
/**
 * 流式订阅的绑定契约验证（运行 `pnpm --filter @crossdeck/shell-electron verify:stream-binding`）。
 *
 * 被守护的三件事，各自对应一次真实事故：
 *   1. 一次绑定只追加一次 —— 曾经订阅写在 componentDidUpdate 里，每个 token 触发重渲染
 *      就再挂一个监听器，同一 token 被追加 N 次，界面字符成倍翻长。
 *   2. 退订真的摘掉 —— 退订失效是静默的：不报错，只是文本悄悄变多。
 *   3. 聊天页卸载后仍然在收帧 —— 订阅挂在页上时，切页签就把它一起摘了，
 *      流并不会停，中间那段 token 谁也没写进 store（实测 28 帧丢 17 帧）。
 *
 * 方法：esbuild 打包真源码 → jsdom 里挂真 store → 注入桩桥（`setBridge`）后
 * 真实发射 start/token/done → 断言 store 文本逐字符精确。
 *
 * ⚠️ jsdom 不是本项目的依赖（装在托管 node 工作区里），所以本脚本**不进根 verify 链**，
 *    与 verify-renderer-store 同一个处置。E2E 那一层由 `--selfcheck` 兜底。
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
// 界面本体在 @crossdeck/ui（三端共用），断言直接打那份源码
const rendererSrc = path.join(pkgRoot, '..', 'ui', 'src');
// React 现在装在被测包自己身上 —— 脚手架的 require 要从 ui 解析，否则拿到另一个实例
const uiRequire = createRequire(path.join(rendererSrc, '..', 'package.json'));
const SOURCES = {
  page: path.join(rendererSrc, 'pages', 'resumeChat.tsx'),
  binding: path.join(rendererSrc, 'streamBinding.ts'),
};
const tmpDir = path.join(rendererSrc, '..', 'node_modules', '.verify-stream-binding-tmp');

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

/**
 * 桩 bridge：忠实模拟 preload 的语义 —— 每次 on 都注册一个独立监听器并广播，
 * 退订只摘掉自己。泄漏的监听器会持续收到事件（这正是第 1 条事故的放大机制）。
 */
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
  const outfile = path.join(tmpDir, `stream-binding-${tag}.cjs`);
  const entry = path.join(tmpDir, `entry-${tag}.mjs`);
  const rel = (p) => './' + path.relative(tmpDir, p).split(path.sep).join('/');
  writeFileSync(
    entry,
    [
      `export { default as ResumeChat } from '${rel(SOURCES.page)}';`,
      `export { bindAgentStream } from '${rel(SOURCES.binding)}';`,
      `export { setBridge } from '${rel(path.join(rendererSrc, 'bridge.ts'))}';`,
      `export { store } from '${rel(path.join(rendererSrc, 'store', 'index.ts'))}';`,
      `export { streamReset } from '${rel(path.join(rendererSrc, 'store', 'slices', 'stream.ts'))}';`,
      '',
    ].join('\n').replace(/\r\n/g, '\n'),
    'utf8',
  );

  const overridePlugin = {
    name: 'variant-override',
    setup(build) {
      if (!Object.keys(overrides).length) return;
      const loaderOf = (p) => (p.endsWith('.tsx') ? 'tsx' : 'ts');
      for (const [key, source] of Object.entries(overrides)) {
        const target = SOURCES[key];
        build.onLoad({ filter: new RegExp(`${path.basename(target).replace('.', '\\.')}$`) }, async (args) => {
          if (path.resolve(args.path) !== path.resolve(target)) return null;
          return { contents: source, loader: loaderOf(target) };
        });
      }
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
  for (const k of ['ResumeChat', 'bindAgentStream', 'store', 'streamReset']) {
    if (!mod[k]) throw new Error(`产物里没有 ${k}`);
  }
  return mod;
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, label, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await flush();
  }
  throw new Error(`等待超时：${label}`);
}

const TOKENS = ['你好', '，', '我是', '简历', '问答', '助手', '你好'];
const USAGE = { ttftMs: 12, totalMs: 34, completionTokens: TOKENS.join('').length, mergedChunks: 0 };

/** 每个场景返回自己那几条断言的失败集 —— 变体的归因才可能唯一。 */
async function scenarioExactText(mod) {
  const bridge = makeBridge();
  mod.setBridge(bridge);
  mod.store.dispatch(mod.streamReset());
  const off = mod.bindAgentStream();
  bridge.emit({ type: 'start', runId: 'r1' });
  for (const t of TOKENS) bridge.emit({ type: 'token', text: t });
  const text = mod.store.getState().stream.text;
  const handlers = bridge.state.handlers.length;
  off();
  const failed = [];
  try {
    assertEq(handlers, 1, '一次绑定应恰好注册 1 个监听器');
    assertEq(text, TOKENS.join(''), '每个 token 必须恰好追加一次（重复绑定会让文本翻倍）');
  } catch (e) {
    failed.push({ id: 'binding.exact-text-once', msg: e instanceof Error ? e.message : String(e) });
  }
  return { failed, text, handlers };
}

async function scenarioUnsubscribeDetaches(mod) {
  const bridge = makeBridge();
  mod.setBridge(bridge);
  mod.store.dispatch(mod.streamReset());
  const off = mod.bindAgentStream();
  bridge.emit({ type: 'start', runId: 'r1' });
  bridge.emit({ type: 'token', text: TOKENS[0] });
  bridge.emit({ type: 'token', text: TOKENS[1] });
  off();
  for (const t of TOKENS.slice(2)) bridge.emit({ type: 'token', text: t });
  const text = mod.store.getState().stream.text;
  const handlers = bridge.state.handlers.length;
  const failed = [];
  try {
    assertEq(handlers, 0, '退订后不得残留活跃监听器');
    assertEq(text, TOKENS[0] + TOKENS[1], '退订之后的帧不得再进 store');
  } catch (e) {
    failed.push({ id: 'binding.unsubscribe-detaches', msg: e instanceof Error ? e.message : String(e) });
  }
  return { failed, text, handlers };
}

/**
 * 聊天页卸载（= 用户切页签）之后，流仍然要能被完整收下。
 *
 * `windowBind` 为 false 是给"把订阅挪回页面"那个变异用的：那种实现下
 * 窗口入口不再绑定，帧就只跟着页面的生死走。
 */
async function scenarioPageUnmount(mod, { windowBind = true } = {}) {
  const React = uiRequire('react');
  const { createRoot } = uiRequire('react-dom/client');
  const { Provider } = uiRequire('react-redux');

  const bridge = makeBridge();
  mod.setBridge(bridge);
  mod.store.dispatch(mod.streamReset());
  const off = windowBind ? mod.bindAgentStream() : null;

  const container = document.getElementById('root');
  const root = createRoot(container);
  root.render(
    React.createElement(Provider, { store: mod.store }, React.createElement(mod.ResumeChat, { className: 'x' })),
  );
  await settle();

  bridge.emit({ type: 'start', runId: 'r1' });
  bridge.emit({ type: 'token', text: TOKENS[0] });
  await settle();

  // 切页签 = 页面被卸载。下面这些帧到达时，聊天页已经不在 DOM 里了。
  root.unmount();
  await settle();
  for (const t of TOKENS.slice(1)) {
    bridge.emit({ type: 'token', text: t });
    await settle(5);
  }
  bridge.emit({ type: 'done', usage: USAGE });
  await settle();

  const text = mod.store.getState().stream.text;
  const stage = mod.store.getState().stream.stage;
  off?.();
  const failed = [];
  try {
    assertEq(text.length, TOKENS.join('').length, '卸载期间到达的帧不得丢失');
    assertEq(text, TOKENS.join(''), '卸载期间到达的正文必须逐字一致');
    assertEq(stage, 'done', '卸载期间的终态也必须落到 store（否则回来还在转圈）');
  } catch (e) {
    failed.push({ id: 'page.unmount-keeps-streaming', msg: e instanceof Error ? e.message : String(e) });
  }
  return { failed, text, stage };
}

const SCENARIOS = {
  A: { id: 'binding.exact-text-once', run: (mod) => scenarioExactText(mod) },
  B: { id: 'binding.unsubscribe-detaches', run: (mod) => scenarioUnsubscribeDetaches(mod) },
  C: { id: 'page.unmount-keeps-streaming', run: (mod, v) => scenarioPageUnmount(mod, v) },
};

/**
 * 变异表。每一条都必须被**指定的那一条**断言杀掉，且不牵连别的场景 ——
 * 否则反向验证（拿掉承重断言后变异必须存活）就会暴露归因不唯一。
 */
const VARIANTS = [
  {
    name: 'M1 token 重复 dispatch（每帧追加两次）',
    scenario: 'A',
    kills: 'binding.exact-text-once',
    file: 'binding',
    replacements: [
      {
        from: '        store.dispatch(streamTokenAppended(event.text));',
        to: '        store.dispatch(streamTokenAppended(event.text));\n        store.dispatch(streamTokenAppended(event.text));',
      },
    ],
  },
  {
    name: 'M2 退订是个空函数（监听器泄漏）',
    scenario: 'B',
    kills: 'binding.unsubscribe-detaches',
    file: 'binding',
    replacements: [{ from: '  return off;', to: '  void off;\n  return () => {};' }],
  },
  {
    name: 'M3 订阅退回聊天页（切页签即断流）',
    scenario: 'C',
    kills: 'page.unmount-keeps-streaming',
    file: 'page',
    windowBind: false,
    replacements: [
      {
        from: 'import { store, type RootState } from "../store";',
        to:
          'import { store, type RootState } from "../store";\n' +
          'import { bindAgentStream } from "../streamBinding";\n' +
          'let __mutationOff: (() => void) | null = null;',
      },
      {
        from: '  override componentDidMount(): void {',
        to: '  override componentDidMount(): void {\n    __mutationOff = bindAgentStream();',
      },
      {
        from: '  override componentWillUnmount(): void {',
        to: '  override componentWillUnmount(): void {\n    __mutationOff?.();',
      },
    ],
  },
];

function mutate(file, replacements) {
  // 编辑器可能写出 CRLF：锚点统一按 LF 匹配（仓库 eol=lf）。
  let src = readFileSync(SOURCES[file], 'utf8').replace(/\r\n/g, '\n');
  for (const r of replacements) {
    if (!src.includes(r.from)) {
      throw new Error(`变异锚点在 ${path.basename(SOURCES[file])} 里找不到：${JSON.stringify(r.from.slice(0, 60))}`);
    }
    src = src.replace(r.from, r.to);
  }
  return src;
}

async function main() {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  const problems = [];
  const ok = (msg) => console.log(`  ✅ ${msg}`);
  const bad = (msg) => {
    console.log(`  ❌ ${msg}`);
    problems.push(msg);
  };

  try {
    console.log('\n[1/3] 基线（真实现）');
    const baseMod = await bundleAndImport({ tag: 'base' });
    const baseResults = {};
    for (const [key, s] of Object.entries(SCENARIOS)) {
      const res = await s.run(baseMod, {});
      baseResults[key] = res;
      for (const f of res.failed) bad(`基线不该挂：${f.id} —— ${f.msg}`);
    }
    if (problems.length === 0) ok(`${Object.keys(SCENARIOS).length} 个场景、${Object.keys(SCENARIOS).length} 条断言全绿`);
    console.log(`      最终文本 = ${JSON.stringify(String(baseResults.A.text).slice(0, 30))}…`);

    console.log('\n[2/3] 变异鉴别力');
    const survivors = [];
    let killed = 0;
    for (const v of VARIANTS) {
      let mutated;
      try {
        mutated = mutate(v.file, v.replacements);
      } catch (e) {
        bad(`${v.name}｜${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const mod = await bundleAndImport({ overrides: { [v.file]: mutated }, tag: `m-${VARIANTS.indexOf(v)}` });
      const res = await SCENARIOS[v.scenario].run(mod, { windowBind: v.windowBind !== false });
      const hit = res.failed.find((f) => f.id === v.kills);
      if (hit) {
        killed += 1;
        ok(`${v.name} → 被杀（${v.kills}）`);
        survivors.push({ variant: v, mod, res });
      } else {
        bad(`${v.name} → 存活！预期被 ${v.kills} 杀掉，实际失败集 = [${res.failed.map((f) => f.id).join(', ') || '空'}]`);
      }
    }

    console.log('\n[3/3] 反向验证（拿掉承重断言 → 同一变异必须存活）');
    for (const { variant, mod, res } of survivors) {
      // 承重断言被拿掉之后，这一条变异不该再被同一个场景抓到别的毛病。
      if (res.failed.length === 1 && res.failed[0].id === variant.kills) {
        ok(`${variant.name}｜唯一失败项就是 ${variant.kills} ✔ 归因成立`);
      } else {
        bad(`${variant.name}｜失败集不止承重那一条：[${res.failed.map((f) => f.id).join(', ')}] —— 归因不唯一`);
      }
    }

    console.log('\n─── 汇总 ───');
    console.log(`  场景 ${Object.keys(SCENARIOS).length} 个 · 变异 ${VARIANTS.length} 个（被杀 ${killed}）`);
    console.log(problems.length === 0 ? '  结论：全部通过。' : `  结论：${problems.length} 项问题 —— 见上方 ❌。`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    /**
     * 必须显式关掉 jsdom 的窗口。
     *
     * 场景 A 只发 start + token、不发终态，帧率探针的 rAF 循环就一直挂着；
     * jsdom（pretendToBeVisual）会替它保活事件循环 —— 于是脚本**所有断言都绿、
     * 进程却永不退出**。在 CI 里这表现为超时被杀，而不是一条失败，
     * 恰恰是最容易被当成"通过"的那种假绿。
     */
    try {
      dom.window.close();
    } catch {
      /* 关不掉就交给下面的显式退出兜底 */
    }
  }

  process.exit(problems.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('verify-agent-stream-binding 崩了：', e);
  process.exitCode = 1;
});
