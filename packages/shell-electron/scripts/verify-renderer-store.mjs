#!/usr/bin/env node
/**
 * 渲染层 store 的断言 + 鉴别力验证（运行 `pnpm --filter @crossdeck/shell-electron verify:store`）。
 *
 * 用 esbuild 把真 slice 源码打成 ESM 产物，交裸 Node 加载（reducer 是纯函数，无需浏览器）。
 * 每个承重断言配一个变异体：必须挂在预期断言上；再反向拿掉该断言，变异体必须杀不掉。
 * 锚点失配报失败，不静默跳过。
 *
 * 实测（2026-11-02 定稿）：正向断言 13 条全绿；承重变异 6 个全杀、归因唯一；
 * 反向 6 例均"拿掉断言后杀不掉"；预期存活 1 个（V6，无可观测差异），非预期存活 0 条。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
// 界面本体在 @crossdeck/ui（三端共用），断言直接打那份源码
const rendererDir = path.join(pkgRoot, '..', 'ui', 'src');
const tmpDir = path.join(rendererDir, '..', 'node_modules', '.store-verify');

const SOURCES = {
  sessions: path.join(rendererDir, 'store', 'slices', 'sessions.ts'),
  stream: path.join(rendererDir, 'store', 'slices', 'stream.ts'),
  store: path.join(rendererDir, 'store', 'index.ts'),
};

// ─────────────────────────────────────────────────────────────
// 断言工具
// ─────────────────────────────────────────────────────────────

const checks = [];
const check = (id, fn) => checks.push({ id, fn });

function assertEq(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${msg}｜期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
    );
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const meta = (id) => ({ id, title: id, createdAt: 0, updatedAt: 0, messageCount: 0 });
const USAGE = { promptTokens: 3, completionTokens: 7, totalMs: 12, ttftMs: 28 };
const INIT = { type: '@@INIT' };

// ─────────────────────────────────────────────────────────────
// 断言表
// ─────────────────────────────────────────────────────────────

check('sessions.initial', (m) => {
  const s = m.sessionsReducer(undefined, INIT);
  assertEq(s.items.length, 0, 'items 初值应为空数组');
  assertEq(s.activeId, null, 'activeId 初值应为 null');
});

check('sessions.ordering', (m) => {
  let s = m.sessionsReducer(undefined, INIT);
  s = m.sessionsReducer(s, m.sessionsReplaced([meta('a'), meta('b')]));
  assertEq(s.items.map((x) => x.id).join(','), 'a,b', '整表替换应保序');

  s = m.sessionsReducer(s, m.sessionPrepended(meta('c')));
  assertEq(s.items.map((x) => x.id).join(','), 'c,a,b', 'prepend 应插到队首');

  s = m.sessionsReducer(s, m.sessionActivated('a'));
  assertEq(s.activeId, 'a', 'activation 应写入 activeId');
});

/** 承重断言 ①：删**非激活**会话时 activeId 必须不动（防"一刀切清空"）。 */
check('sessions.remove-nonactive-keeps-active', (m) => {
  let s = m.sessionsReducer(undefined, INIT);
  s = m.sessionsReducer(s, m.sessionsReplaced([meta('a'), meta('b')]));
  s = m.sessionsReducer(s, m.sessionActivated('a'));
  s = m.sessionsReducer(s, m.sessionRemoved('b'));

  assertEq(s.items.map((x) => x.id).join(','), 'a', 'b 应从列表里消失');
  assertEq(s.activeId, 'a', '删的不是激活项 —— activeId 必须原样保留');
});

/** 承重断言 ②：删**激活**会话时，`activeId` 必须清空（原子性的一半）。 */
check('sessions.remove-active-clears', (m) => {
  let s = m.sessionsReducer(undefined, INIT);
  s = m.sessionsReducer(s, m.sessionsReplaced([meta('a'), meta('b')]));
  s = m.sessionsReducer(s, m.sessionActivated('a'));
  s = m.sessionsReducer(s, m.sessionRemoved('a'));

  assertEq(s.items.map((x) => x.id).join(','), 'b', 'a 应从列表里消失');
  assertEq(s.activeId, null, '删的正是激活项 —— activeId 必须清空');
});

check('stream.initial', (m) => {
  const s = m.streamReducer(undefined, INIT);
  assertEq(s.stage, 'idle', 'stage 初值 idle');
  assertEq(s.text, '', 'text 初值空串');
  assertEq(s.runId, null, 'runId 初值 null');
  assertEq(s.usage, null, 'usage 初值 null');
  assertEq(s.paused, false, 'paused 初值 false');
  assertEq(s.error, null, 'error 初值 null');
  assertEq(s.sessionId, null, 'sessionId 初值 null（不知道这轮属于谁）');
});

/** 承重断言 ③：新一轮 `start` 必须把上一轮的 **text / usage / error** 一起清掉。 */
check('stream.start-clears-residue', (m) => {
  let s = m.streamReducer(undefined, INIT);
  s = m.streamReducer(s, m.streamStarted({ runId: 'r0' }));
  s = m.streamReducer(s, m.streamTokenAppended('上一轮的残留文本'));
  s = m.streamReducer(s, m.streamFinished(USAGE));
  assertEq(s.stage, 'done', '前置条件：上一轮应已结束');

  s = m.streamReducer(s, m.streamStarted({ runId: 'r1' }));
  assertEq(s.text, '', '新 run 必须清空上一轮文本');
  assertEq(s.usage, null, '新 run 必须清空上一轮 usage');
  assertEq(s.error, null, '新 run 必须清空上一轮 error');
  assertEq(s.paused, false, '新 run 应回到未暂停');
  assertEq(s.runId, 'r1', 'runId 应换成新的');
  assertEq(s.stage, 'streaming', 'stage 应推进到 streaming');
});

/** 承重断言 ④：token 是**追加**，不是替换 —— 写成 `=` 会只剩最后一个字符。 */
check('stream.token-appends', (m) => {
  let s = m.streamReducer(undefined, INIT);
  s = m.streamReducer(s, m.streamStarted({ runId: 'r1' }));
  s = m.streamReducer(s, m.streamTokenAppended('你'));
  s = m.streamReducer(s, m.streamTokenAppended('好'));
  assertEq(s.text, '你好', '增量必须是追加语义');
});

check('stream.finish', (m) => {
  let s = m.streamReducer(undefined, INIT);
  s = m.streamReducer(s, m.streamStarted({ runId: 'r1' }));
  s = m.streamReducer(s, m.streamTokenAppended('abc'));
  s = m.streamReducer(s, m.pausedSet(true));
  s = m.streamReducer(s, m.streamFinished(USAGE));

  assertEq(s.stage, 'done', 'stage 应为 done');
  assertEq(s.runId, null, '终态必须清 runId，否则界面一直显示"流式中"');
  assertEq(s.paused, false, '终态应解除暂停');
  assertEq(s.text, 'abc', '终态必须保留已产出的文本');
  assertEq(s.usage, USAGE, 'usage 应写入');
});

check('stream.fail', (m) => {
  let s = m.streamReducer(undefined, INIT);
  s = m.streamReducer(s, m.streamStarted({ runId: 'r1' }));
  s = m.streamReducer(s, m.streamTokenAppended('半截'));
  s = m.streamReducer(s, m.streamFailed('[UPSTREAM] 断了'));

  assertEq(s.stage, 'error', 'stage 应为 error');
  assertEq(s.runId, null, '异常终态同样要清 runId');
  assertEq(s.error, '[UPSTREAM] 断了', '错误文本应原样落库');
  assertEq(s.text, '半截', '失败也要保留已经吐出来的文本');
});

/** 承重断言 ⑤：runAccepted（invoke 回执）不得推进 stage —— 回执 ≠ 首帧。 */
check('stream.runAccepted-is-not-first-byte', (m) => {
  let s = m.streamReducer(undefined, INIT);
  s = m.streamReducer(s, m.runAccepted({ runId: 'r9', sessionId: 's1' }));
  assertEq(s.runId, 'r9', '回执应写入 runId');
  assertEq(s.stage, 'idle', '回执 ≠ 首帧 —— stage 必须留在 idle');
});

/** 承重断言 ⑥：streamReset 必须整块清回初始态，stage 不能残留 done。 */
check('stream.reset-clears-stage', (m) => {
  let s = m.streamReducer(undefined, INIT);
  s = m.streamReducer(s, m.streamStarted({ runId: 'r1' }));
  s = m.streamReducer(s, m.streamTokenAppended('x'));
  s = m.streamReducer(s, m.streamFinished(USAGE));
  assertEq(s.stage, 'done', '前置条件：应已跑完一轮');

  const out = m.streamReducer(s, m.streamReset());
  assertEq(out.stage, 'idle', 'reset 后 stage 必须回到 idle（不能残留 done）');
  assertEq(out.text, '', 'reset 后 text 必须清空');
  assertEq(out.runId, null, 'reset 后 runId 必须清空');
  assertEq(out.usage, null, 'reset 后 usage 必须清空');
});

/** 承重断言 ⑦：切到**别的**会话时必须整块清掉上一轮的流状态。 */
check('stream.switch-session-clears', (m) => {
  let s = m.streamReducer(undefined, INIT);
  s = m.streamReducer(s, m.runAccepted({ runId: 'r1', sessionId: 's1' }));
  s = m.streamReducer(s, m.streamStarted({ runId: 'r1' }));
  s = m.streamReducer(s, m.streamTokenAppended('A 会话的正文'));
  assertEq(s.stage, 'streaming', '前置条件：A 会话正在流式');

  // 重选**当前**会话不得清 —— 否则用户在列表里点一下自己就丢了正文
  const same = m.streamReducer(s, m.sessionActivated('s1'));
  assertEq(same.text, 'A 会话的正文', '重选当前会话不得清掉正文');

  // 不知道属于谁时也要宽松（外部直连 agent:run 的场景）——"知道才清"
  let unknown = m.streamReducer(undefined, INIT);
  unknown = m.streamReducer(unknown, m.streamStarted({ runId: 'r2' }));
  unknown = m.streamReducer(unknown, m.streamTokenAppended('无主正文'));
  const unknownKept = m.streamReducer(unknown, m.sessionActivated('s9'));
  assertEq(unknownKept.text, '无主正文', 'sessionId 未知时不得清');

  const out = m.streamReducer(s, m.sessionActivated('s2'));
  assertEq(out.text, '', '切到别的会话必须清空上一轮正文（否则会长在新会话的面板里）');
  assertEq(out.stage, 'idle', '切到别的会话必须回到 idle');
  assertEq(out.sessionId, null, 'sessionId 必须一并清掉');
});

/** 断言 ⑧：真 store 集成烟雾断言 —— reset 后 subscribe 照常收到通知。 */
check('stream.reset-notifies-subscribers', (m) => {
  const store = m.store;
  store.dispatch(m.streamStarted({ runId: 'r1' }));
  store.dispatch(m.streamTokenAppended('残留'));

  let notified = 0;
  const unsub = store.subscribe(() => {
    notified += 1;
  });
  store.dispatch(m.streamReset());
  unsub();

  assertEq(notified, 1, 'streamReset 必须改变状态并通知订阅者');
});

// ─────────────────────────────────────────────────────────────
// 变异表
//
// 每项：把真源码改坏一处 → 要求恰好被 `kills` 那条断言抓住。
// 反向用例会自动生成（见下方 main）：把 `kills` 从断言表里拿掉后，同一变异必须存活。
// ─────────────────────────────────────────────────────────────

const VARIANTS = [
  {
    name: 'V1 删掉"删激活会话时清 activeId"',
    file: 'sessions',
    from: '      if (state.activeId === action.payload) state.activeId = null;\n',
    to: '\n',
    kills: 'sessions.remove-active-clears',
  },
  {
    name: 'V2 token 写成替换而非追加',
    file: 'stream',
    from: '      state.text += action.payload;',
    to: '      state.text = action.payload;',
    kills: 'stream.token-appends',
  },
  {
    name: 'V3 start 不清上一轮残留文本',
    file: 'stream',
    from: '      state.text = \'\';\n      state.usage = null;\n',
    to: '',
    kills: 'stream.start-clears-residue',
  },
  {
    name: 'V4 runAccepted 顺手推进 stage（把回执当成首帧）',
    file: 'stream',
    from: '      state.runId = action.payload.runId;\n      state.sessionId = action.payload.sessionId;',
    to: '      state.runId = action.payload.runId;\n      state.sessionId = action.payload.sessionId;\n      state.stage = \'streaming\';',
    kills: 'stream.runAccepted-is-not-first-byte',
  },
  {
    name: 'V5 streamReset 只清数据、把 stage 留在上一轮的 done',
    file: 'stream',
    // 显式构造而非 {...state}：streamReset 没声明 state 参数，写坏会 ReferenceError。
    from: '      return { ...initialState };',
    to: "      return { text: '', runId: null, usage: null, stage: 'done', paused: false, error: null };",
    kills: 'stream.reset-clears-stage',
  },
  {
    name: 'V7 切会话不清上一轮流状态（按会话判断被写掉）',
    file: 'stream',
    from: '      if (state.sessionId !== null && state.sessionId !== action.payload) {',
    to: '      if (state.sessionId !== null && false) {',
    kills: 'stream.switch-session-clears',
  },
  {
    // 预期存活（expectSurvive）：无可观测差异。若哪天被杀，说明机理判断错了。
    name: 'V6（预期存活）streamReset 返回 initialState 同一引用',
    file: 'stream',
    from: '      return { ...initialState };',
    to: '      return initialState;',
    expectSurvive: true,
    rationale: '正常使用时 store 当前状态 ≠ 初始对象，引用比较仍判为"变了"，无可观测差异',
  },
];

// ─────────────────────────────────────────────────────────────
// 打包 + 加载
// ─────────────────────────────────────────────────────────────

const ENTRY_FILE = 'entry.ts';

async function bundleAndImport({ overrides = {}, tag = 'base' } = {}) {
  const outfile = path.join(tmpDir, `store-${tag}.mjs`);
  const entry = path.join(tmpDir, ENTRY_FILE);

  // ⚠️ 用相对路径引用源码：Windows 盘符绝对路径在 import specifier 里不可靠。
  const rel = (p) => './' + path.relative(tmpDir, p).split(path.sep).join('/');
  // ⚠️ 同步写：异步写会让 esbuild 读到半截（或空的）entry 文件。
  //    行尾统一成 LF —— 仓库 eol=lf，且行尾漂移会让后面的文本变异锚点静默失配。
  writeFileSync(
    entry,
    [
      `export { default as sessionsReducer, sessionsReplaced, sessionPrepended, sessionRemoved, sessionActivated } from '${rel(SOURCES.sessions)}';`,
      `export { default as streamReducer, streamStarted, streamTokenAppended, streamFinished, streamFailed, runAccepted, pausedSet, streamReset } from '${rel(SOURCES.stream)}';`,
      `export { store } from '${rel(SOURCES.store)}';`,
      '',
    ].join('\n').replace(/\r\n/g, '\n'),
    'utf8',
  );

  const overridePlugin = {
    name: 'variant-override',
    setup(build) {
      build.onLoad({ filter: /\.ts$/ }, async (args) => {
        const hit = Object.entries(overrides).find(([file]) =>
          path.resolve(args.path) === path.resolve(SOURCES[file]),
        );
        if (!hit) return null;
        return { contents: hit[1], loader: 'ts' };
      });
    },
  };

  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    // 只留这一个外部依赖（真依赖，不是替身）；其余全打进产物，
    // 这样裸 Node 一加载就能跑，不依赖任何解析规则。
    external: ['@reduxjs/toolkit'],
    logLevel: 'silent',
    plugins: [overridePlugin],
  });

  const mod = await import(pathToFileURL(outfile).href);
  // 防呆：确认加载到的确实是真实现，而不是某个空壳。
  assert(typeof mod.sessionsReducer === 'function', '产物里没有 sessionsReducer');
  assert(typeof mod.streamReducer === 'function', '产物里没有 streamReducer');
  assert(mod.store !== undefined, '产物里没有 store');
  return mod;
}

function runChecks(mod, disabled = new Set()) {
  const failed = [];
  let ran = 0;
  for (const c of checks) {
    if (disabled.has(c.id)) continue;
    ran += 1;
    try {
      c.fn(mod);
    } catch (e) {
      failed.push({ id: c.id, msg: e instanceof Error ? e.message : String(e) });
    }
  }
  return { failed, ran };
}

// ─────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────

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
    // ── ① 基线：真源码 + 全断言，必须全绿 ──
    console.log('\n[1/3] 基线（真实现，全部断言）');
    const baseMod = await bundleAndImport({ tag: 'base' });
    const base = runChecks(baseMod);
    if (base.failed.length === 0) {
      ok(`${base.ran} 条断言全绿`);
    } else {
      for (const f of base.failed) bad(`基线不该挂：${f.id} —— ${f.msg}`);
    }
    console.log(`      断言总数 = ${checks.length}（本次执行 ${base.ran}）`);

    // ── ② 变异：每个变异体必须被杀，且挂在预期断言上 ──
    console.log('\n[2/3] 变异鉴别力（改坏真源码，要求被杀）');
    const reverseCases = [];
    let killed = 0;
    let expectedSurvivors = 0;

    for (const v of VARIANTS) {
      const src = readFileSync(SOURCES[v.file], 'utf8');
      if (!src.includes(v.from)) {
        // 锚点失配 = 变异根本没生效。报失败，不跳过。
        bad(`${v.name}｜变异锚点在源码里找不到 —— 鉴别力证明失效，请更新锚点`);
        continue;
      }
      const mutated = src.replace(v.from, v.to);
      if (mutated === src) {
        bad(`${v.name}｜替换后源码无变化 —— 变异体与真实现相同`);
        continue;
      }

      let mod;
      try {
        mod = await bundleAndImport({
          overrides: { [v.file]: mutated },
          tag: `v-${VARIANTS.indexOf(v)}`,
        });
      } catch (e) {
        bad(`${v.name}｜变异体打包/加载失败：${e.message}`);
        continue;
      }

      const res = runChecks(mod);

      // 预期存活的变异（无罪）：要求它**必须**存活 ——
      // 一旦被杀，说明我们对其机理的判断错了，比"漏判"更值得报警。
      if (v.expectSurvive === true) {
        if (res.failed.length === 0) {
          expectedSurvivors += 1;
          ok(`${v.name} → 存活（预期如此：${v.rationale}）`);
        } else {
          bad(
            `${v.name} → 本应无可观测差异，却挂了 [${res.failed.map((f) => f.id).join(', ')}] —— ` +
              `对 Immer/Redux 行为的假设有误，请重新核实并更新脚本注释`,
          );
        }
        continue;
      }

      const expectedHit = res.failed.some((f) => f.id === v.kills);
      const others = res.failed.filter((f) => f.id !== v.kills).map((f) => f.id);

      if (expectedHit) {
        killed += 1;
        ok(`${v.name} → 被杀（${v.kills}）`);
        if (others.length > 0) {
          // 打印消息：能一眼分辨"变异体自己崩了"（ReferenceError 之类）
          // 与"真的被另一条断言抓到" —— 两者处理方式完全不同。
          const detail = res.failed
            .filter((f) => f.id !== v.kills)
            .map((f) => `${f.id}〔${f.msg.slice(0, 70)}〕`)
            .join(' · ');
          console.log(`      ↳ 另被覆盖：${detail}`);
        }
      } else {
        bad(`${v.name} → 存活！预期应被 ${v.kills} 杀掉，实际失败集 = [${res.failed.map((f) => f.id).join(', ') || '空'}]`);
      }

      reverseCases.push({ variant: v, mod, disabledId: v.kills });
    }

    // ── ③ 反向：拿掉承重断言后，同一变异必须变得杀不掉 ──
    console.log('\n[3/3] 反向验证（拿掉承重断言 → 同一变异必须存活）');
    for (const rc of reverseCases) {
      const res = runChecks(rc.mod, new Set([rc.disabledId]));
      if (res.failed.length === 0) {
        ok(`${rc.variant.name}｜移除 ${rc.disabledId} 后已无法被杀 ✔ 归因成立`);
      } else {
        bad(
          `${rc.variant.name}｜移除 ${rc.disabledId} 后仍被 ${res.failed.map((f) => f.id).join(', ')} 杀掉 —— ` +
            `说明该变异被多条断言覆盖，"${rc.disabledId} 在承重"这个结论不成立`,
        );
      }
    }

    console.log('\n─── 汇总 ───');
    const loadBearing = VARIANTS.filter((v) => v.expectSurvive !== true).length;
    console.log(
      `  断言 ${checks.length} 条 · 承重变异 ${loadBearing} 个（被杀 ${killed}）· 预期存活 ${expectedSurvivors} 个（无罪，见脚本注释）`,
    );
    if (problems.length === 0) {
      console.log('  结论：全部通过（无非预期存活，无锚点失配）。');
    } else {
      console.log(`  结论：${problems.length} 项问题 —— 见上方 ❌。`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  process.exitCode = problems.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('verify-renderer-store 崩了：', e);
  process.exitCode = 1;
});
