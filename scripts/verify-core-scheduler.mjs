#!/usr/bin/env node
/**
 * T4 的验收 —— 流式写入的节流调度器。
 *
 * 全部走注入的假时钟：`advance(ms)` 精确推进，断言可以精确到"第几毫秒写了第几次"。
 * 零真实等待 —— 这是「不许在 core 里直接写 setTimeout」那条约束最实际的回报。
 *
 * ① 未达阈值不写、达阈值只写一次
 * ② 字符兜底：满了立刻写，不等时间
 * ③ 时间优先：静默超过窗口后的第一个增量立刻写
 * ④ 终态强制写 + 计数清零
 * ⑤ flush 幂等（不 dirty 不空写）
 * ⑥ stop 把残留写出去并停掉调度；之后 mark 只计数
 * ⑦ 非法参数必须抛
 * ⑧ 与装配器联合：一轮 30 个 token 的写入次数必须远小于 token 数
 *
 * ══════════════════════════════════════════════════════════════
 * 变异测试记录（确认断言有鉴别力；每发都要求：退出码非 0 且挂 ≥1 条）
 * ══════════════════════════════════════════════════════════════
 * | ID | 改坏的点                                        | 挂掉条数 |
 * |----|-----------------------------------------------|--------|
 * | M1 | 每次 mark 都立刻写（等于没有节流）                   | 16     |
 * | M2 | 字符阈值判定去掉（只剩时间）                        | 2      |
 * | M3 | 终态不强制 flush（等下一个周期）                    | 4      |
 * | M4 | flush 后不清零（重复写同一份）                      | 2      |
 * | M5 | stop 不写残留                                     | 4      |
 * | M6 | stop 不取消周期调度                               | 1      |
 * | M7 | 构造时不校验 intervalMs                           | 1      |
 *
 * **7 发全杀**（每发都同时满足编译通过、退出码非 0、挂 >=1 条）。
 *
 * 反向实验 R1：把「stop 后周期调度已取消」改成永真（`true`）后，
 * M6 变异**完全杀不掉**（exit=0、42/42 全绿）—— 证明那条断言确实是守门人，
 * 不是"反正别的断言会抓到"。M7 同理只挂 1 条。
 *
 * 有一类空写是**故意不断言**的：直接对调度器重复喂终态会多写一次，
 * 因为调度器只看增量字符与终态标记，判断不了"内容有没有变"。
 * 去重是装配器的职责（终态后的迟到帧返回 terminal: false），
 * 第 4 组把这条边界钉成断言，第 8 组证明两端接起来整轮只写一次终态。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_DIST = join(ROOT, 'packages', 'core', 'dist', 'index.js');

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

function checkThrows(what, fn, keyword) {
  let err;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (err === undefined) {
    check(what, false, '没有抛错');
    return;
  }
  check(what, String(err.message).includes(keyword), `错误信息不含「${keyword}」：${err.message}`);
}

function finish() {
  const total = passed + failures.length;
  console.log(`\n${failures.length === 0 ? '✅' : '❌'} verify-core-scheduler：${passed}/${total} 条通过`);
  if (failures.length > 0) {
    console.log('失败项：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

for (const evt of ['uncaughtException', 'unhandledRejection']) {
  process.on(evt, (err) => {
    check(`场景意外抛错（${evt}）—— 本不该走到这里`, false, err instanceof Error ? err.message : String(err));
    finish();
  });
}

setTimeout(() => {
  console.error('\n❌ verify-core-scheduler: 超过 30s 仍未结束，判定失败');
  process.exit(1);
}, 30_000).unref();

let core;
try {
  core = await import(pathToFileURL(CORE_DIST).href);
} catch (err) {
  console.error(`❌ 无法加载 core 编译产物：${CORE_DIST}`);
  console.error('   先跑 `pnpm typecheck` 生成 dist/ 再执行本脚本。');
  console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const { WriteScheduler, createDraft, foldStreamEvent } = core;

for (const [name, value] of Object.entries({ WriteScheduler, createDraft, foldStreamEvent })) {
  if (value === undefined) {
    console.error(`❌ core 没有导出 ${name} —— index.ts 的导出面写漏了`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// 假时钟：时间变成可以手动推进的量
// ─────────────────────────────────────────────────────────────
function createFakeClock() {
  let now = 0;
  let jobSeq = 0;
  const jobs = new Map();

  return {
    now: () => now,
    every: (intervalMs, fn) => {
      const id = ++jobSeq;
      jobs.set(id, { intervalMs, fn, nextAt: now + intervalMs });
      return () => {
        jobs.delete(id);
      };
    },
    /** 按 (到期时刻, 注册序号) 逐条触发，与真实事件循环同序。 */
    advance(ms) {
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
        if (fired > 100000) throw new Error('advance 疑似不收敛（定时器没取消？）');
      }
      now = target;
      return fired;
    },
    pending: () => jobs.size,
  };
}

/** 建一个调度器，把所有写入记成 [{ reason, at }]。 */
function makeScheduler(clock, opts = {}) {
  const writes = [];
  const scheduler = new WriteScheduler({
    now: clock.now,
    every: clock.every,
    write: (reason) => writes.push({ reason, at: clock.now() }),
    ...opts,
  });
  return { scheduler, writes };
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ① 未达阈值不写、达阈值只写一次 ─────────────────');

{
  const clock = createFakeClock();
  const { scheduler, writes } = makeScheduler(clock);

  scheduler.mark(3, false);
  check('未达时间与字符阈值 → 不写', writes.length === 0, JSON.stringify(writes));

  clock.advance(199);
  check('199ms 仍未到窗口 → 不写', writes.length === 0, JSON.stringify(writes));

  clock.advance(1);
  check('满 200ms → 写一次', writes.length === 1, JSON.stringify(writes));
  check('这一写由时间窗口触发', writes[0].reason === 'interval', String(writes[0].reason));

  clock.advance(1000);
  check('没有新增量时后续周期不再重复写', writes.length === 1, JSON.stringify(writes));
  check('统计里写入次数与观测一致', scheduler.stats.writes === 1, String(scheduler.stats.writes));
  check('写入后积压字符清零', scheduler.stats.pendingChars === 0, String(scheduler.stats.pendingChars));
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ② 字符兜底：满了立刻写 ─────────────────────');

{
  const clock = createFakeClock();
  const { scheduler, writes } = makeScheduler(clock);

  scheduler.mark(511, false);
  check('没到字符上限（511 < 512）→ 不写', writes.length === 0, JSON.stringify(writes));

  scheduler.mark(1, false);
  check('到达字符上限 → 立刻写，不等时间', writes.length === 1 && writes[0].at === 0, JSON.stringify(writes));
  check('这一写由字符阈值触发', writes[0].reason === 'chars', String(writes[0].reason));

  scheduler.mark(600, false);
  check('单次就超上限也立刻写', writes.length === 2 && writes[1].reason === 'chars', JSON.stringify(writes));
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ③ 时间优先：静默后的第一个增量立刻写 ────────────');

{
  const clock = createFakeClock();
  const { scheduler, writes } = makeScheduler(clock);

  clock.advance(250);
  check('空转的周期不产生写（没内容可写）', writes.length === 0, JSON.stringify(writes));

  scheduler.mark(1, false);
  check('静默超过窗口后第一个增量立刻写', writes.length === 1 && writes[0].reason === 'interval', JSON.stringify(writes));
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ④ 终态强制写并清零 ──────────────────────────');

{
  const clock = createFakeClock();
  const { scheduler, writes } = makeScheduler(clock);

  scheduler.mark(1, false);
  check('先攒一个不触发写入的增量', writes.length === 0);

  scheduler.mark(0, true);
  check('终态立刻落盘（不等下一个周期）', writes.length === 1 && writes[0].reason === 'terminal', JSON.stringify(writes));
  check('终态后计数清零', scheduler.stats.pendingChars === 0, String(scheduler.stats.pendingChars));

  clock.advance(1000);
  check('终态后周期不再写', writes.length === 1, JSON.stringify(writes));

  // 调度器不知道"内容有没有变"，它只看增量字符与终态标记。
  // 重复终态的过滤在装配器那一层（终态后的迟到帧返回 terminal: false），
  // 所以这里直接把终态喂第二遍会多写一次 —— 钉住这条边界，别指望调度器去重。
  scheduler.mark(0, true);
  check('重复喂终态会再写一次 —— 去重靠装配器，不靠调度器', writes.length === 2, JSON.stringify(writes));
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑤ flush 幂等 ───────────────────────────────');

{
  const clock = createFakeClock();
  const { scheduler, writes } = makeScheduler(clock);

  check('没有未写内容时 flush 返回 false', scheduler.flush() === false);
  check('也没有产生写', writes.length === 0);

  scheduler.mark(2, false);
  check('有内容时手动 flush 返回 true', scheduler.flush() === true);
  check('手动 flush 记为 manual', writes[0].reason === 'manual', String(writes[0].reason));
  check('再 flush 一次不会重复写', scheduler.flush() === false && writes.length === 1);

  scheduler.mark(0, false);
  check('零增量且非终态不标脏（什么都没变）', scheduler.flush() === false && writes.length === 1);
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑥ stop：写残留 + 停调度 ─────────────────────');

{
  const clock = createFakeClock();
  const { scheduler, writes } = makeScheduler(clock);

  scheduler.mark(5, false);
  check('stop 前没有写', writes.length === 0);

  scheduler.stop();
  check('stop 把残留写出去', writes.length === 1 && writes[0].reason === 'stop', JSON.stringify(writes));
  check('stop 后周期调度已取消', clock.pending() === 0, String(clock.pending()));

  clock.advance(5000);
  check('stop 后推进时间不再写', writes.length === 1, JSON.stringify(writes));

  scheduler.mark(3, false);
  check('stop 后的增量被计数，不静默忽略', scheduler.stats.dropped === 1, String(scheduler.stats.dropped));
  check('stop 后的增量不产生写', writes.length === 1, JSON.stringify(writes));

  scheduler.stop();
  check('重复 stop 不产生第二次写', writes.length === 1, JSON.stringify(writes));
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑦ 非法参数必须抛 ────────────────────────────');

{
  const clock = createFakeClock();
  checkThrows(
    'intervalMs 为 0 必须抛（every(0) 会死循环）',
    () => new WriteScheduler({ now: clock.now, every: clock.every, intervalMs: 0, write: () => {} }),
    '正整数',
  );
  checkThrows(
    'maxPendingChars 为 0 必须抛',
    () => new WriteScheduler({ now: clock.now, every: clock.every, maxPendingChars: 0, write: () => {} }),
    '正整数',
  );
  checkThrows(
    '负数增量必须抛（调用方算错了不能当成 0）',
    () => {
      const { scheduler } = makeScheduler(clock);
      scheduler.mark(-1, false);
    },
    '非负整数',
  );
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑧ 与装配器联合：一轮真实的流 ───────────────────');

{
  const clock = createFakeClock();
  const written = [];
  let draft = createDraft();
  let idSeq = 0;
  const ctx = { messageId: 'm1', newId: (p) => `${p}_${++idSeq}`, now: () => clock.now() };

  const scheduler = new WriteScheduler({
    now: clock.now,
    every: clock.every,
    // 落库时刻取的正文，正是"写到磁盘上的内容"
    write: (reason) => written.push({ reason, status: draft.status, content: draft.content, at: clock.now() }),
  });

  const TOKENS = 30;
  const PER_TOKEN = 4;
  for (let i = 0; i < TOKENS; i += 1) {
    const r = foldStreamEvent(draft, { type: 'token', runId: 'r1', text: 'abcd' }, ctx);
    draft = r.draft;
    scheduler.mark(PER_TOKEN, r.terminal);
    clock.advance(20);
  }
  const doneRes = foldStreamEvent(draft, { type: 'done', runId: 'r1', usage: { promptTokens: 3, completionTokens: 120, totalMs: 600 } }, ctx);
  draft = doneRes.draft;
  scheduler.mark(0, doneRes.terminal);

  // 迟到的重复 done：装配器丢弃它，terminal 为 false，调度器不该因此再写一次
  const dup = foldStreamEvent(draft, { type: 'done', runId: 'r1', usage: { promptTokens: 3, completionTokens: 120, totalMs: 600 } }, ctx);
  draft = dup.draft;
  scheduler.mark(0, dup.terminal);
  check('重复 done 在装配器层就被丢弃（不要求再落盘）', dup.terminal === false && dup.draft.dropped === 1);

  scheduler.stop();

  check('一轮 30 个 token 的写入次数远小于 token 数', written.length <= 5, `${written.length} 次写入 / ${TOKENS} 个 token`);
  check('也不是一次都没写（真的落过盘）', written.length >= 2, `${written.length} 次`);
  check(
    '最后一次写入的正文是完整的 120 字符',
    written[written.length - 1].content === 'abcd'.repeat(TOKENS),
    `${written[written.length - 1].content.length} 字符`,
  );
  check('最后一次写入的状态是完成（终态必须落盘）', written[written.length - 1].status === 'done', written[written.length - 1].status);
  check('终态写入是最后一条', written[written.length - 1].reason === 'terminal', written[written.length - 1].reason);
  check('整轮只写了一次终态（重复 done 没有引起第二次终态写）', written.filter((w) => w.reason === 'terminal').length === 1, JSON.stringify(written.map((w) => w.reason)));
  check('过程写入都发生在 200ms 边界上', written.slice(0, -1).every((w) => w.at % 200 === 0), JSON.stringify(written.map((w) => w.at)));
}

finish();
