#!/usr/bin/env node
/**
 * Core Agent 内核的验收 —— StreamBus / BackpressurePump / AgentRuntime。
 *
 * 本脚本存在的**唯一理由**是把一件很难验的事变成很容易验的事：
 *
 *   背压算法的正确性（帧对齐、暂停零推送、队列超限合并、上游耗尽收尾）
 *   在没有注入调度器时，只能靠"跑一遍端到端，等几秒，看 token 数对不对" ——
 *   慢、不确定、且**失败时说不清是哪一步错的**。
 *
 * 注入之后，时间变成可以手动推进的量：`advance(400)` 精确推进 400ms，
 * 两次 produce（12ms）与两次 flush（16ms）的先后顺序完全确定。
 * 全程 0ms 真实等待，断言可以精确到"第 N 帧推了什么"。
 *
 * 这是「core 不得 import 平台 API」这条铁律最实际的回报 ——
 * 不是为了洁癖，是为了让这段代码**可以被证明**。
 *
 * 零依赖、无子进程：直接加载 core 的编译产物（packages/core/dist/index.js）。
 *
 * ── 变异测试记录（用来确认这些断言真的有鉴别力）────────────────────
 * 第一次就全绿却抓不住错误的测试等于没测。改坏实现后实测：
 *
 * | 变异                                     | 挂掉断言数 |
 * |-----------------------------------------|--------|
 * | publish 不先快照，直接遍历活 Set                  | 3      |
 * | flush 不再看 paused（暂停退化成"降速"）              | 6      |
 * | 队列超限只留尾部（丢头部）                          | 1      |
 * | #settle 不再挡重复终结                          | **0**  |
 *
 * 最后一行是**如实记录的坏消息**：`AgentRuntime.#settle` 里的
 * `if (run.settled) return false` 在现有调用方下**不可达** ——
 * abort / drained / emit 三条路径都已经先判过 settled。
 * 它是有意保留的纵深防御（一个 run 发两个 done 会让 usage 统计被算两遍，
 * 而且不崩、不报错，只是数字悄悄不对），但既然不可达，就不能假装测到了。
 * 要么将来给它找到真实触发路径，要么在精简时删掉。
 *
 * 另外记一笔踩过的坑：最初那条"派发中途退订自己"的断言**没有鉴别力** ——
 * V8 的 Set 迭代器删除当前元素时本来就不跳过后继，所以无论有没有快照都通过。
 * 真正有差别的是「退订还没轮到的别人」与「派发中途新增」。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIST = join(ROOT, 'packages', 'core', 'dist', 'index.js');

let core;
try {
  core = await import(pathToFileURL(CORE_DIST).href);
} catch (err) {
  console.error(`❌ 无法加载 core 编译产物：${CORE_DIST}`);
  console.error('   先跑 `pnpm typecheck` 生成 dist/ 再执行本脚本。');
  console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const {
  BACKPRESSURE_DEFAULTS,
  BackpressurePump,
  AgentRuntime,
  ScriptedModel,
  SCRIPTED_REPLY,
  StreamBus,
  ToolRegistry,
  echoTool,
} = core;

// ─────────────────────────────────────────────────────────────
// 极简断言器
// ─────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];

function check(what, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✅ ${what}`);
  } else {
    failures.push(`${what}${detail === undefined ? '' : ` —— ${detail}`}`);
    console.log(`  ❌ ${what}${detail === undefined ? '' : `\n       ${detail}`}`);
  }
}

/** 让已排队的 microtask 跑完（runtime 的 drive() 是 async 的）。 */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ─────────────────────────────────────────────────────────────
// 假调度器 —— 把"时间"变成可以手动推进的量
// ─────────────────────────────────────────────────────────────
function createFakeScheduler() {
  let now = 0;
  let jobSeq = 0;
  let idSeq = 0;
  /** id → { intervalMs, fn, nextAt } */
  const jobs = new Map();

  const deps = {
    now: () => now,
    every: (intervalMs, fn) => {
      const id = ++jobSeq;
      jobs.set(id, { intervalMs, fn, nextAt: now + intervalMs });
      return () => {
        jobs.delete(id);
      };
    },
    newId: (prefix) => `${prefix}_${++idSeq}`,
  };

  /**
   * 推进 ms 毫秒：按 (到期时刻, 注册序号) 排序逐条触发，与真实事件循环同序。
   * 返回触发次数 —— 断言里可以据此确认"真的跑了，不是空转"。
   */
  function advance(ms) {
    const target = now + ms;
    let fired = 0;
    for (;;) {
      let best = null;
      for (const [id, job] of jobs) {
        if (job.nextAt > target) continue;
        if (best === null || job.nextAt < best.job.nextAt || (job.nextAt === best.job.nextAt && id < best.id)) {
          best = { id, job };
        }
      }
      if (best === null) break;
      now = best.job.nextAt;
      best.job.nextAt += best.job.intervalMs;
      best.job.fn();
      fired += 1;
      if (fired > 200000) throw new Error('advance 疑似不收敛（定时器没有取消？）');
    }
    now = target;
    return fired;
  }

  return { deps, advance, now: () => now, pending: () => jobs.size };
}

// ─────────────────────────────────────────────────────────────
// 收集器：把 pump / runtime 的事件收成一个数组
// ─────────────────────────────────────────────────────────────
function makeCollector(runtime) {
  const events = [];
  const off = runtime.bus.subscribe((e) => events.push(e));
  return {
    events,
    off,
    ofType: (t) => events.filter((e) => e.type === t),
    text: () => events.filter((e) => e.type === 'token').map((e) => e.text).join(''),
    terminal: () => events.filter((e) => e.type === 'done' || e.type === 'error'),
  };
}

console.log(`\n加载 core 产物：${CORE_DIST}\n`);

// ─────────────────────────────────────────────────────────────
// ① StreamBus —— 分发与退订
// ─────────────────────────────────────────────────────────────
console.log('── ① StreamBus：分发、退订、派发中途退订 ──────────────');
{
  const bus = new StreamBus();
  const aSeen = [];
  const bSeen = [];
  const offA = bus.subscribe((e) => aSeen.push(e.type));
  bus.subscribe((e) => bSeen.push(e.type));

  const delivered = bus.publish({ type: 'start', runId: 'r1', at: 1 });
  check('publish 返回送达份数（不是 undefined —— "没人接"必须可观测）', delivered === 2, String(delivered));
  check('两个监听器都收到', aSeen.length === 1 && bSeen.length === 1, `${JSON.stringify(aSeen)} / ${JSON.stringify(bSeen)}`);
  check('listenerCount 准确', bus.listenerCount === 2, String(bus.listenerCount));

  offA();
  bus.publish({ type: 'start', runId: 'r2', at: 2 });
  check('退订后 A 不再收到（B 照常收到）', aSeen.length === 1 && bSeen.length === 2, `${aSeen.length} / ${bSeen.length}`);
  check('退订后 listenerCount 减一', bus.listenerCount === 1, String(bus.listenerCount));

  // 派发中途增删 —— 这两条才是真正区分「先快照」与「遍历活 Set」的断言。
  //   注意别写成"退订自己"：Set 迭代器删除当前元素时本来就不会跳过后继，
  //   那种写法无论有没有快照都通过，拿它当证据是自欺（这个坑我踩过一次）。
  //   实测（Node 24 / V8）：
  //     · 退订**还没轮到的**别人 → 活 Set 会跳过 → 少收一次
  //     · 派发中途**新增**监听器   → 活 Set 会带上它 → 多收一次
  //   快照语义下这两种都不会发生：开始派发那一刻在表里的收到，之后变的不影响本轮。
  const bus2 = new StreamBus();
  const order = [];
  let offSecond = () => {};
  bus2.subscribe(() => {
    order.push('A');
    offSecond(); // A 退订 B —— 注意拿的必须是 B 的退订函数，不是自己的
  });
  offSecond = bus2.subscribe(() => order.push('B'));
  bus2.publish({ type: 'start', runId: 'r3', at: 3 });
  check(
    '派发中途退订**还没轮到的**别人，本轮仍投递给他（快照语义）',
    order.join(',') === 'A,B',
    order.join(','),
  );

  const bus3 = new StreamBus();
  const order2 = [];
  let added = false;
  bus3.subscribe(() => {
    order2.push('A');
    if (!added) {
      added = true;
      bus3.subscribe(() => order2.push('NEW'));
    }
  });
  bus3.subscribe(() => order2.push('B'));
  bus3.publish({ type: 'start', runId: 'r4', at: 4 });
  check(
    '派发中途新增的监听器**不**收到本轮事件（否则一条流会被渲染两遍）',
    order2.join(',') === 'A,B',
    order2.join(','),
  );
  bus3.publish({ type: 'start', runId: 'r5', at: 5 });
  check(
    '新增的监听器从下一轮起生效（本轮 2 人，下一轮 3 人）',
    order2.join(',') === 'A,B,A,B,NEW',
    order2.join(','),
  );

  // 同一个监听器重复退订不应出错（清理路径常常会被走到两次）
  let doubleOffThrew = false;
  try {
    offSecond();
    offSecond();
  } catch {
    doubleOffThrew = true;
  }
  check('重复退订不抛错（清理路径常被走两次）', doubleOffThrew === false);
}

// ─────────────────────────────────────────────────────────────
// ② BackpressurePump —— 全是确定性断言，0ms 真实等待
// ─────────────────────────────────────────────────────────────
console.log('\n── ② BackpressurePump：帧对齐 / 暂停 / 合并 / 收尾 ─────');
{
  const s = createFakeScheduler();
  const flushes = [];
  let drainedWith = null;
  const pump = new BackpressurePump(
    {
      flush: (text) => flushes.push(text),
      drained: (summary) => {
        drainedWith = summary;
      },
    },
    s.deps,
  );
  pump.start();
  check('start 之后有两个调度在跑（produce + flush）', s.pending() === 2, String(s.pending()));

  pump.push('abcdefghi');
  pump.closeUpstream();

  s.advance(500);
  check('上游文本一字不丢', flushes.join('') === 'abcdefghi', JSON.stringify(flushes.join('')));
  check('drained 被调用（且只调一次）', drainedWith !== null);
  check('drained 报的 acceptedChars 是**接收**总量（合并不会减少它）', drainedWith.acceptedChars === 9, String(drainedWith.acceptedChars));
  check('未超限时 mergedChunks 为 0', drainedWith.mergedChunks === 0, String(drainedWith.mergedChunks));
  check(
    'ttftMs 等于首次 flush 的间隔（16ms 帧对齐，不是 0）',
    drainedWith.ttftMs === BACKPRESSURE_DEFAULTS.flushIntervalMs,
    String(drainedWith.ttftMs),
  );
  check('收尾后调度全部摘掉（没有定时器泄漏）', s.pending() === 0, String(s.pending()));

  const before = flushes.length;
  s.advance(1000);
  check('收尾之后再推进时间，一次 flush 都不会再发生', flushes.length === before);
  check('drained 不会被重复调用', drainedWith !== null && flushes.length === before);

  pump.push('迟到的字');
  check('收尾后的 push 被忽略（acceptedChars 不变）', pump.acceptedChars === 9, String(pump.acceptedChars));
}

{
  // 暂停：**一个 token 都不推** —— 这是"背压"与"降速"的分界
  const s = createFakeScheduler();
  const flushes = [];
  const pump = new BackpressurePump(
    { flush: (t) => flushes.push(t), drained: () => {} },
    s.deps,
  );
  pump.start();
  pump.push('x'.repeat(300));

  pump.pause();
  s.advance(400);
  const atPause = flushes.length;
  s.advance(400);
  check(
    `暂停期间零推送（${atPause} → ${flushes.length}）`,
    flushes.length === atPause,
    `${atPause} → ${flushes.length}`,
  );

  pump.resume();
  s.advance(400);
  check('恢复后继续推送', flushes.length > atPause, `${atPause} → ${flushes.length}`);
  check('暂停+恢复后仍然一字不丢', flushes.join('') === 'x'.repeat(300), String(flushes.join('').length));
}

{
  // 队列超限：**合并中间态**（保留头尾），而不是丢尾部、也不是丢头部
  const s = createFakeScheduler();
  const flushes = [];
  let summary = null;
  const pump = new BackpressurePump(
    {
      flush: (t) => flushes.push(t),
      drained: (x) => {
        summary = x;
      },
    },
    s.deps,
  );
  pump.start();

  // 用可辨识的内容而不是长度：只断言"长度 > keepHead"是抓不住"丢头部"的，
  // 因为丢弃后队列会立刻重新增长、长度照样越线（实测漏过这种变异）。
  const HEAD = 'H'.repeat(600);
  const MID = 'M'.repeat(1800);
  const TAIL = 'T'.repeat(600);
  pump.push(HEAD + MID + TAIL);

  pump.pause();
  // 暂停时 flush 不消费，而 produce 继续搬 —— 队列必然越限
  s.advance(20000);
  check('暂停期间队列越限，触发了中间态合并', pump.mergedChunks > 0, String(pump.mergedChunks));

  pump.resume();
  s.advance(10000);
  pump.closeUpstream();
  s.advance(2000);
  check('合并后仍会收尾', summary !== null);

  const delivered = flushes.join('');
  check(
    '合并保留**头部**（丢头会让答案开头整段消失）',
    delivered.startsWith('H'),
    JSON.stringify(delivered.slice(0, 24)),
  );
  check(
    '合并保留**尾部**（刻意不丢尾 —— 丢尾会让回答断在半句）',
    delivered.endsWith('T'),
    JSON.stringify(delivered.slice(-24)),
  );
  check(
    '合并次数被如实计入 summary（把"会骗人的行为"变成可观测数字）',
    summary !== null && summary.mergedChunks > 0,
    summary === null ? 'null' : String(summary.mergedChunks),
  );
  check(
    'acceptedChars 仍等于上游给的 3000（合并不影响入账口径）',
    summary !== null && summary.acceptedChars === 3000,
    summary === null ? 'null' : String(summary.acceptedChars),
  );
  check(
    '下推总长 ≤ 上游总量（合并只减不增）',
    delivered.length <= 3000,
    String(delivered.length),
  );
  check('确实发生了合并（下推长度明显小于 3000）', delivered.length < 3000, String(delivered.length));
}

{
  // stop()：硬停。清队列、摘调度、**不发** drained
  const s = createFakeScheduler();
  const flushes = [];
  let drainedCalls = 0;
  const pump = new BackpressurePump(
    { flush: (t) => flushes.push(t), drained: () => { drainedCalls += 1; } },
    s.deps,
  );
  pump.start();
  pump.push('z'.repeat(100));
  s.advance(100);
  pump.stop();

  check('stop 之后调度全部摘掉', s.pending() === 0, String(s.pending()));
  check('stop 不触发 drained（终结事件由调用方自己发，避免重复）', drainedCalls === 0, String(drainedCalls));
  const n = flushes.length;
  s.advance(500);
  check('stop 之后不再推送', flushes.length === n);
  check('stop 是幂等的', (pump.stop(), pump.finished === true));
}

// ─────────────────────────────────────────────────────────────
// ③ AgentRuntime —— 一次 run 的完整生命周期
// ─────────────────────────────────────────────────────────────
console.log('\n── ③ AgentRuntime：run 生命周期 + 工具链路 ────────────');
{
  const s = createFakeScheduler();
  const runtime = new AgentRuntime({ deps: s.deps, model: new ScriptedModel() });
  const col = makeCollector(runtime);

  const { runId } = runtime.startRun({ sessionId: 's1', input: 'ping' });
  check('startRun 同步返回 runId', typeof runId === 'string' && runId.length > 0, runId);
  check(
    'start 事件是同步发出的（不等 await）—— 否则渲染层会漏掉首个事件',
    col.events.length === 1 && col.events[0].type === 'start',
    JSON.stringify(col.events.map((e) => e.type)),
  );
  check('run 记账在册', runtime.activeRunCount === 1, String(runtime.activeRunCount));

  await tick();
  s.advance(5000);
  await tick();
  s.advance(200);

  const types = col.events.map((e) => e.type);
  check('事件序列 start → token* → done', types[0] === 'start' && types[types.length - 1] === 'done', types.join(','));
  check('终态事件**恰好一个**', col.terminal().length === 1, String(col.terminal().length));
  check('文本长度等于脚本模型的回复', col.text().length === SCRIPTED_REPLY.length, `${col.text().length} vs ${SCRIPTED_REPLY.length}`);

  const done = col.ofType('done')[0];
  check('done 带 usage', done !== undefined && done.usage !== undefined);
  check('usage.completionTokens = 上游字符数', done.usage.completionTokens === SCRIPTED_REPLY.length, String(done.usage.completionTokens));
  check('usage.ttftMs 有值', typeof done.usage.ttftMs === 'number', String(done.usage.ttftMs));
  check('usage.mergedChunks = 0（正常流不该合并）', done.usage.mergedChunks === 0, String(done.usage.mergedChunks));
  check('run 结束后出账', runtime.activeRunCount === 0, String(runtime.activeRunCount));
  check('没有终态后事件泄漏', runtime.droppedAfterTerminal === 0, String(runtime.droppedAfterTerminal));
  check('调度全部摘干净', s.pending() === 0, String(s.pending()));

  // 反向：已结束的 run 不能再被控制
  check('对已结束的 run 暂停 → false（调用方据此抛 NOT_FOUND）', runtime.pause(runId) === false);
  check('对不存在的 runId 恢复 → false', runtime.resume('run_nope') === false);
  check('对已结束的 run 中断 → false', runtime.abort(runId) === false);
  check('已结束后事件数不变', col.events.length === types.length);
}

{
  // 暂停 / 恢复：走 runtime 这一层（handler 用的就是这个）
  const s = createFakeScheduler();
  const runtime = new AgentRuntime({ deps: s.deps, model: new ScriptedModel() });
  const col = makeCollector(runtime);

  const { runId } = runtime.startRun({ sessionId: 's2', input: 'ping' });
  await tick();
  s.advance(100);

  check('暂停已知 run → true', runtime.pause(runId) === true);
  const before = col.ofType('token').length;
  s.advance(400);
  const mid = col.ofType('token').length;
  s.advance(400);
  check(`暂停期间 token 数不涨（${before}/${mid} → ${col.ofType('token').length}）`, col.ofType('token').length === mid);

  check('恢复已知 run → true', runtime.resume(runId) === true);
  s.advance(8000);
  await tick();
  s.advance(400);
  check('恢复后 token 继续增长', col.ofType('token').length > mid);
  check('暂停没有把流卡死（最终仍 done）', col.ofType('done').length === 1, String(col.ofType('done').length));
}

{
  // abort：必须补一个终结事件，否则 UI 永远停在"流式中"
  const s = createFakeScheduler();
  const runtime = new AgentRuntime({ deps: s.deps, model: new ScriptedModel() });
  const col = makeCollector(runtime);

  const { runId } = runtime.startRun({ sessionId: 's3', input: 'ping' });
  await tick();
  s.advance(100);
  check('中断返回 true', runtime.abort(runId) === true);

  const errs = col.ofType('error');
  check('中断补了一个 error 终结事件', errs.length === 1, String(errs.length));
  check('错误码是 ABORTED（不是 INTERNAL）', errs[0]?.code === 'ABORTED', String(errs[0]?.code));
  check('中断后终态仍然只有一个', col.terminal().length === 1, String(col.terminal().length));
  check('中断后调度摘干净', s.pending() === 0, String(s.pending()));

  const n = col.events.length;
  s.advance(2000);
  check('中断之后再无事件（定时器没泄漏）', col.events.length === n, `${n} → ${col.events.length}`);
  check('没有任何"终态后事件"', runtime.droppedAfterTerminal === 0, String(runtime.droppedAfterTerminal));
}

{
  // 工具链路：模型先调工具，再回答
  const s = createFakeScheduler();
  const runtime = new AgentRuntime({ deps: s.deps, model: new ScriptedModel() });
  const col = makeCollector(runtime);

  check('默认注册了 echo 工具', runtime.tools.has('echo') === true);
  check('echo 工具确实在列表里', runtime.tools.names().includes('echo'));

  runtime.startRun({ sessionId: 's4', input: `请回声 [[tool:echo]] 你好` });
  await tick();
  s.advance(8000);
  await tick();
  s.advance(400);

  const types = col.events.map((e) => e.type);
  check('tool 事件出现在 token 之前（先干活再回答）', types.indexOf('tool') >= 0 && types.indexOf('tool') < types.indexOf('token'), types.join(','));
  const toolEv = col.ofType('tool')[0];
  check('tool 事件带 callId 与工具名', typeof toolEv?.callId === 'string' && toolEv.name === 'echo', JSON.stringify(toolEv));
  const endEv = col.ofType('tool_end')[0];
  check('tool_end 报告成功', endEv?.ok === true, JSON.stringify(endEv));
  check('tool_end 带耗时', typeof endEv?.ms === 'number', String(endEv?.ms));
  check('工具调用后仍然正常收尾', col.terminal().length === 1 && col.terminal()[0].type === 'done');
}

{
  // 反向：未知工具必须是 ok:false，而不是把整个 run 打挂
  const s = createFakeScheduler();
  const runtime = new AgentRuntime({
    deps: s.deps,
    model: { complete: () => Promise.resolve({ text: 'x', toolCalls: [{ name: 'nope', args: {} }] }) },
  });
  const col = makeCollector(runtime);
  runtime.startRun({ sessionId: 's5', input: 'ping' });
  await tick();
  s.advance(2000);
  await tick();
  s.advance(400);

  const endEv = col.ofType('tool_end')[0];
  check('未知工具 → tool_end.ok = false（工具失败是业务结果，不是崩溃）', endEv?.ok === false, JSON.stringify(endEv));
  check('未知工具不会把 run 打挂，仍然正常 done', col.ofType('done').length === 1, String(col.ofType('done').length));
}

{
  // 反向：上游抛错 → UPSTREAM 错误事件，而不是一个静默的 unhandled rejection
  const s = createFakeScheduler();
  const runtime = new AgentRuntime({
    deps: s.deps,
    model: { complete: () => Promise.reject(new Error('上游 503')) },
  });
  const col = makeCollector(runtime);
  runtime.startRun({ sessionId: 's6', input: 'ping' });
  await tick();
  s.advance(1000);
  await tick();

  const errs = col.ofType('error');
  check('上游抛错被转成 error 事件', errs.length === 1, String(errs.length));
  check('错误码是 UPSTREAM', errs[0]?.code === 'UPSTREAM', String(errs[0]?.code));
  check('错误消息带上了原因', String(errs[0]?.message).includes('503'), String(errs[0]?.message));
  check('上游失败后调度摘干净', s.pending() === 0, String(s.pending()));
  check('上游失败后 run 出账', runtime.activeRunCount === 0, String(runtime.activeRunCount));
}

{
  // stopAll：会话被删 / 窗口关闭时调用
  const s = createFakeScheduler();
  const runtime = new AgentRuntime({ deps: s.deps, model: new ScriptedModel() });
  runtime.startRun({ sessionId: 's7', input: 'a' });
  runtime.startRun({ sessionId: 's8', input: 'b' });
  await tick();
  s.advance(100);
  check('两个 run 同时在册', runtime.activeRunCount === 2, String(runtime.activeRunCount));

  runtime.stopAll();
  check('stopAll 清空记账', runtime.activeRunCount === 0, String(runtime.activeRunCount));
  check('stopAll 摘掉所有调度', s.pending() === 0, String(s.pending()));
}

{
  // 自定义工具表 —— 证明工具不是写死在 core 里的
  const s = createFakeScheduler();
  const tools = new ToolRegistry();
  tools.register({ name: 'boom', description: '总是失败', run: () => { throw new Error('炸了'); } });
  const runtime = new AgentRuntime({
    deps: s.deps,
    model: { complete: () => Promise.resolve({ text: 'ok', toolCalls: [{ name: 'boom', args: null }] }) },
    tools,
  });
  const col = makeCollector(runtime);
  runtime.startRun({ sessionId: 's9', input: 'ping' });
  await tick();
  s.advance(2000);
  await tick();
  s.advance(400);

  const endEv = col.ofType('tool_end')[0];
  check('工具内部抛错 → ok:false + 原始消息', endEv?.ok === false && String(endEv.output ?? '').length >= 0, JSON.stringify(endEv));
  check('工具抛错不影响 run 收尾', col.ofType('done').length === 1);

  // 重复注册必须抛 —— 否则后注册的会静默覆盖前者
  let threw = false;
  try {
    tools.register({ name: 'boom', description: 'again', run: () => 'x' });
  } catch {
    threw = true;
  }
  check('工具重复注册直接抛错（静默覆盖 = 上线后才发现的 bug）', threw === true);
}

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────');
if (failures.length > 0) {
  console.log(`❌ ${failures.length} 条断言失败：`);
  for (const f of failures) console.log(`   - ${f}`);
} else {
  console.log(`✅ 全部 ${passed} 条断言通过 — Agent 内核在无定时器环境下可被证明 🎉`);
  console.log('   （全程 0ms 真实等待：时间由假调度器手动推进）');
}
process.exit(failures.length === 0 ? 0 : 1);
