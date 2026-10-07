#!/usr/bin/env node
/**
 * ScriptedModel 流式契约验证 —— **手动时钟，真跑编译产物**。
 *
 * 为什么单独一个脚本、而不是并进 verify-core-agent.mjs：
 *   · 它验的是 **ModelPort 实现自身**的 sink 契约（恰好一个终态、取消语义、定时器不泄漏），
 *     不是 runtime 的背压算法。两者失败时的排查方向完全不同。
 *   · 它是 T6-b（runtime 改成回调驱动）的前置护栏：runtime 重写会大量改动终态归口逻辑，
 *     如果 model 这一层的"恰好一次/取消不发终态"本身不牢，T6-b 的失败会指向错误的地方。
 *
 * 关键手法：**手动时钟**。
 *   `ScriptedModel` 靠 `deps.every` 滴流，注入一个可 `advance(ms)` 的假时钟后，
 *   整个流式过程变成确定性的、0ms 真实等待的 —— 于是"定时器永不停""空串空转"
 *   "onEnd 发了两次"这类**只在时间维度上暴露的 bug** 才能被稳定抓住。
 *   实测教训：3 字符回复先自然结束、再调 cancel() → onEnd=2（不幂等）；
 *   这个用例（第 4 组）就是为它加的。
 *
 * 零依赖：只 import core 的编译产物（core 自身零运行时依赖）。
 *
 * ── 变异测试记录（2026-10-07，24 条基线；改 src 后**必须重编译**再跑）──
 *   手法：改 `packages/core/src/agent/model.ts` → `pnpm --filter @crossdeck/core typecheck`
 *         → 重跑本脚本 → 记录挂几条 → 还原。
 *   结果：
 *     M1  去掉 `finish()` 幂等位（保留「cancel 不碰 sink」）…… **存活（0 killed）**
 *         → 诚实结论：在"cancel 只停、不发终态"的语义下，`ended` 位是**防御性冗余**，
 *           不是承载逻辑。它防的是"未来有人给 cancel 加终态"这一类改动。
 *     M1b `cancel()` 也发 onEnd（round-2 真实 bug 形状）…… **杀死 3 条**
 *         （end=2 / abort 时 end=1 / 连调 3 次 end=3）
 *         → 这才是本脚本的核心鉴别力所在：**第 4、5、6 组就是为它写的**。
 *     M2  切完不自摘调度 …… **杀死 3 条**（定时器泄漏 + 空串 chunk）
 *     M3  终态提前到首个 chunk 之前 …… **杀死 4 条**（含"终态不早于首个 chunk"序断言）
 *     M4  去掉空回复快路径 …… **杀死 1 条**（"无空串 chunk"）
 *         ⚠️ 只挂 1 条说明第 3 组偏弱：空串切片仍会在首个 tick 撞上 `reply === ''` 收尾，
 *           所以"onEnd 恰好 1 次""无定时器"两条**抓不住它**。留作已知盲区。
 *     M5  「在 onChunk 后加 `if (str === '') return`」…… 存活
 *         → **无效变异体**：正常路径下压根不会产生空串，观测面没变。不是测试弱。
 *     M5b 收尾多吐一个空串 …… **杀死 1 条**（"无空串 chunk"）
 *
 * 教训：**"变异存活"要先分开两种情况** —— ①测试没鉴别力；②变异体根本没改可观测行为。
 * 把②当成①，会得出"我的测试很弱"的错误结论，然后去加一堆抓不住东西的断言。
 */
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const coreDist = path.join(repoRoot, 'packages', 'core', 'dist', 'index.js');

const core = await import(pathToFileURL(coreDist).href);

// ── 前置：编译产物必须存在且导出了我们要的东西 ──
// 缺 dist 时直接说清楚「先编译」，而不是抛一个看不懂的 import 错误。
const need = ['ScriptedModel', 'SCRIPTED_REPLY', 'TOOL_SCENARIO_MARKER'];
const missing = need.filter((k) => !(k in core));
if (missing.length > 0) {
  console.error(`❌ 编译产物缺少导出：${missing.join(', ')}`);
  console.error(`   路径：${coreDist}`);
  console.error('   先跑：pnpm --filter @crossdeck/core typecheck');
  process.exit(2);
}
const { ScriptedModel, SCRIPTED_REPLY, TOOL_SCENARIO_MARKER } = core;

// ── 手动时钟：deps.every 的最小可用实现 ──
// 语义刻意与真实 setInterval 对齐：重复注册、单次取消、按到期时间顺序触发。
// 不实现 setInterval 的"回调用例里再注册新定时器"以外的花活。
function makeClock() {
  let t = 0;
  const timers = [];
  let guard = 0;
  return {
    every(intervalMs, fn) {
      const h = { next: t + intervalMs, intervalMs, fn, alive: true };
      timers.push(h);
      return () => {
        h.alive = false;
      };
    },
    advance(ms) {
      // 反复挑"最早到期且还活着"的定时器推进，直到越过 target。
      // guard 是防止被测实现写出"每次回调都重新注册、永不到期"的死循环。
      const target = t + ms;
      while (true) {
        if (++guard > 1_000_000) {
          throw new Error('手动时钟步进超过 1e6 次 —— 被测实现可能在不推时钟地自旋');
        }
        let sel = null;
        for (const h of timers) {
          if (h.alive && h.next <= target && (sel === null || h.next < sel.next)) sel = h;
        }
        if (sel === null) break;
        t = sel.next;
        sel.next += sel.intervalMs;
        sel.fn();
      }
      t = target;
    },
    /** 还活着的定时器数 —— 泄漏检测就靠它 */
    alive() {
      return timers.filter((h) => h.alive).length;
    },
    now() {
      return t;
    },
  };
}

function mkDeps(clock) {
  return { now: () => clock.now(), every: clock.every, newId: (p) => `${p}_1` };
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ❌ ${name}${detail !== undefined ? ' —— ' + detail : ''}`);
  }
}

/** 造一个把每次回调都记录下来的 sink，便于事后断言"调用次数/顺序" */
function recorder(extra = {}) {
  const chunks = [];
  const events = []; // 有序列：用于断言终态不早于首个 chunk
  let end = 0;
  let err = 0;
  const sink = {
    onChunk(text) {
      chunks.push(text);
      events.push({ type: 'chunk', text });
    },
    onEnd() {
      end++;
      events.push({ type: 'end' });
    },
    onError(message) {
      err++;
      events.push({ type: 'error', message });
    },
    ...extra,
  };
  return {
    sink,
    chunks,
    events,
    get end() {
      return end;
    },
    get err() {
      return err;
    },
  };
}

// ══════════════════════════════════════════════════════════════
console.log('\n【1. 普通流：完整、有界、终态恰好一次、不泄漏】');
{
  const clock = makeClock();
  const r = recorder();
  const model = new ScriptedModel({ deps: mkDeps(clock) });
  model.stream({ sessionId: 's', prompt: 'hi' }, r.sink);

  // 不推进时钟：什么都不该发生（证明没有同步吐字）
  check(
    '调用后未推进时钟 → 无 chunk 无终态',
    r.chunks.length === 0 && r.end === 0,
    `chunks=${r.chunks.length} end=${r.end}`,
  );

  clock.advance(5000);
  check('拼接结果 === SCRIPTED_REPLY', r.chunks.join('') === SCRIPTED_REPLY, `len=${r.chunks.join('').length}`);
  check('onEnd 恰好 1 次', r.end === 1, `end=${r.end}`);
  check('onError 0 次', r.err === 0, `err=${r.err}`);
  check('定时器已停（无泄漏）', clock.alive() === 0, `alive=${clock.alive()}`);
  check('无空串 chunk', r.chunks.filter((c) => c === '').length === 0, JSON.stringify(r.chunks.slice(-3)));
  check('终态不早于首个 chunk', r.events.indexOf(r.events.find((e) => e.type === 'end')) > 0, JSON.stringify(r.events.slice(0, 2)));
}

// ══════════════════════════════════════════════════════════════
console.log('\n【2. 工具分支：前缀保留 + onToolCall 触发】');
{
  const clock = makeClock();
  const r = recorder({ onToolCall: () => {}, });
  let toolCalls = 0;
  const sink = { ...r.sink, onToolCall: () => { toolCalls++; } };
  const model = new ScriptedModel({ deps: mkDeps(clock) });
  model.stream({ sessionId: 's', prompt: `帮我 ${TOOL_SCENARIO_MARKER} 查一下` }, sink);
  clock.advance(5000);
  const joined = r.chunks.join('');
  check('工具前缀保留', joined.includes('工具返回：') && joined.includes('查一下'), joined.slice(0, 40));
  check('onToolCall 恰好 1 次', toolCalls === 1, `toolCalls=${toolCalls}`);
  check('onEnd 恰好 1 次', r.end === 1, `end=${r.end}`);
  check('定时器已停', clock.alive() === 0);
}

// ══════════════════════════════════════════════════════════════
console.log('\n【2b. 未实现 onToolCall 的 sink：可选回调不得崩】');
{
  const clock = makeClock();
  const r = recorder(); // 故意没有 onToolCall
  const model = new ScriptedModel({ deps: mkDeps(clock) });
  model.stream({ sessionId: 's', prompt: `走 ${TOOL_SCENARIO_MARKER} 分支` }, r.sink);
  clock.advance(5000);
  check('无 onToolCall 的 sink 不抛错，正常收尾', r.end === 1 && r.err === 0, `end=${r.end} err=${r.err}`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n【3. 空回复边界：直接收尾，不空转】');
{
  const clock = makeClock();
  const r = recorder();
  const model = new ScriptedModel({ deps: mkDeps(clock), reply: '' });
  model.stream({ sessionId: 's', prompt: 'hi' }, r.sink);
  clock.advance(100);
  check('空回复 → onEnd 恰好 1 次', r.end === 1, `end=${r.end}`);
  check('空回复 → 无 chunk', r.chunks.length === 0, JSON.stringify(r.chunks));
  check('空回复 → 无定时器注册', clock.alive() === 0);
}

// ══════════════════════════════════════════════════════════════
console.log('\n【4. 自然结束后再 cancel()：onEnd 仍恰好 1 次（幂等）】');
{
  const clock = makeClock();
  const r = recorder();
  const model = new ScriptedModel({ deps: mkDeps(clock), reply: 'ABC' });
  const cancel = model.stream({ sessionId: 's', prompt: 'hi' }, r.sink);
  clock.advance(10); // 3 字符一个周期吐完 → 自然结束
  check('自然结束后 onEnd = 1', r.end === 1, `end=${r.end}`);
  cancel();
  check('再调 cancel() 后 onEnd 仍 = 1（幂等）', r.end === 1, `end=${r.end} ← 不幂等时这里会是 2`);
}

// ══════════════════════════════════════════════════════════════
console.log('\n【5. 中途 abort：cancel 只停、不发终态】');
{
  const clock = makeClock();
  const r = recorder();
  const model = new ScriptedModel({ deps: mkDeps(clock) });
  const cancel = model.stream({ sessionId: 's', prompt: 'hi' }, r.sink);
  clock.advance(20); // 吐 2 片
  const before = r.chunks.length;
  cancel();
  clock.advance(5000);
  check('取消后不再吐字', r.chunks.length === before, `before=${before} after=${r.chunks.length}`);
  check('取消不发 onEnd（终态由 runtime 决定）', r.end === 0, `end=${r.end}`);
  check('取消后定时器已停', clock.alive() === 0);
}

// ══════════════════════════════════════════════════════════════
console.log('\n【6. cancel() 连调三次：不重复、不终态】');
{
  const clock = makeClock();
  const r = recorder();
  const model = new ScriptedModel({ deps: mkDeps(clock), reply: 'ABCDEF' });
  const cancel = model.stream({ sessionId: 's', prompt: 'hi' }, r.sink);
  clock.advance(5);
  cancel();
  cancel();
  cancel();
  clock.advance(5000);
  check('连调 3 次 cancel()：onEnd 仍 = 0', r.end === 0, `end=${r.end}`);
  check('定时器已停', clock.alive() === 0);
}

// ══════════════════════════════════════════════════════════════
console.log('\n【7. deps 必填：缺 deps 是**编译期**错误，不是运行期静默空转】');
{
  // 这一条不是测"能跑"，是测"设计意图被类型系统挡住"。
  // 历史：曾经 deps 可选 + `this.#deps?.every(...)` → 5 个调用点静默返回空答案，
  // 却"看起来成功了"。这里以源码断言固化"不许再写成可选"。
  const src = await import('node:fs').then((fs) =>
    fs.readFileSync(path.join(repoRoot, 'packages', 'core', 'src', 'agent', 'model.ts'), 'utf8'),
  );
  check('模型源码里 deps 为必填（无 `deps?` / 无 `#deps?.`）', !/deps\s*\?/.test(src) && !/#deps\?\./.test(src));
  check('模型源码不 import 平台模块 / 第三方包', !/from ['"](electron|node:|@ohos)/.test(src));
}

console.log(`\n${'─'.repeat(52)}`);
if (fail === 0) {
  console.log(`✅ 全部 ${pass} 条通过`);
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败：`);
  for (const f of failures) console.log(`   · ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
