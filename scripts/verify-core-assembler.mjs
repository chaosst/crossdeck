#!/usr/bin/env node
/**
 * T3 的验收 —— 事件 → 消息状态的装配器。
 *
 * 全部是合成事件序列，零真实等待、零 IO：
 *   ① 正文累积与不落库的帧（start / plan / token / 工具开始）
 *   ② 终态幂等（重复 done、终态后迟到 token）
 *   ③ 中断与失败必须可区分，且中断保留正文
 *   ④ 工具开始/结束帧配对，孤儿结束帧不落库
 *   ⑤ 引用与动作落库、事件序号单调、id 不重复
 *   ⑥ 词表新增成员必须抛（不许静默丢帧）
 *
 * 零依赖、无子进程：直接加载 core 的编译产物。
 *
 * ══════════════════════════════════════════════════════════════
 * 变异测试记录（确认断言有鉴别力；每发都要求：退出码非 0 且挂 ≥1 条）
 * ══════════════════════════════════════════════════════════════
 * | ID | 改坏的点                                        | 挂掉条数 |
 * |----|-----------------------------------------------|--------|
 * | M1 | 去掉终态幂等早退（终态后照收事件）                    | 4      |
 * | M2 | ABORTED 也当失败（状态不可区分）                     | 1      |
 * | M3 | 孤儿 tool_end 也落库                              | 1      |
 * | M4 | 空 sources 也落库                                 | 2      |
 * | M5 | token 覆盖正文而非追加                             | 4      |
 * | M6 | 事件序号不递增                                     | 1      |
 * | M7 | 预览不截断                                        | 1      |
 * | M8 | 终态不标 terminal（不要求立刻落盘）                  | 1      |
 *
 * **8 发全杀**（每发都同时满足编译通过、退出码非 0、挂 ≥1 条）。
 *
 * ⚠️ M2 / M3 / M6 / M7 / M8 只挂 1 条 —— 那一条就是唯一守门人。
 * M2 尤其危险：只靠「ABORTED → 被中断，不是失败」这一条撑着，
 * 「中断保留正文」「中断要求落盘」两条在它变异后仍然通过（正文确实还在）。
 * 改这段测试时不要削弱它，否则"把用户主动停止显示成服务器出错"会静默回来。
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
  console.log(`\n${failures.length === 0 ? '✅' : '❌'} verify-core-assembler：${passed}/${total} 条通过`);
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
  console.error('\n❌ verify-core-assembler: 超过 30s 仍未结束，判定失败');
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

const { createDraft, foldStreamEvent, isTerminalStatus } = core;

for (const [name, value] of Object.entries({ createDraft, foldStreamEvent, isTerminalStatus })) {
  if (value === undefined) {
    console.error(`❌ core 没有导出 ${name} —— index.ts 的导出面写漏了`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// 组装环境：id 与时钟都注入，断言才能钉住具体值
// ─────────────────────────────────────────────────────────────
let idSeq = 0;
let clock = 1000;
const ctx = {
  messageId: 'm1',
  newId: (prefix) => `${prefix}_${++idSeq}`,
  now: () => clock,
};

function step(draft, event) {
  return foldStreamEvent(draft, event, ctx);
}

/** 只比较状态层面的四个字段，事件序号另测。 */
function snap(draft) {
  return `${draft.status}|${draft.content}|${draft.dropped}`;
}

const RUN = 'run_1';

// ─────────────────────────────────────────────────────────────
console.log('\n── ① 正文累积与不落库的帧 ────────────────────────');

let d = createDraft();
check(
  '初始：流式中 / 正文空 / 无用量 / 事件序号从 1 起',
  d.status === 'streaming' && d.content === '' && d.usage === null && d.nextEventSeq === 1 && d.dropped === 0,
  JSON.stringify(d),
);

let r = step(d, { type: 'start', runId: RUN, at: 1 });
check('start 不改任何状态', snap(r.draft) === snap(d) && r.append === null && r.terminal === false);

r = step(d, { type: 'token', runId: RUN, text: '你' });
r = step(r.draft, { type: 'token', runId: RUN, text: '好' });
check('两个 token 拼成正文（追加不是覆盖）', r.draft.content === '你好', r.draft.content);
check('token 不产生落库事件', r.append === null);
const afterTokens = r.draft;

r = step(afterTokens, { type: 'plan', runId: RUN, steps: [{ id: 's1', title: '查资料', status: 'running' }] });
check(
  'plan 不落库（run 内瞬时步骤，不进事件表）',
  r.append === null && snap(r.draft) === snap(afterTokens) && r.draft.nextEventSeq === afterTokens.nextEventSeq,
);

// ─────────────────────────────────────────────────────────────
console.log('\n── ② 终态幂等 ────────────────────────────────');

const usageA = { promptTokens: 2, completionTokens: 2, totalMs: 5 };
const done = step(afterTokens, { type: 'done', runId: RUN, usage: usageA });
check('done 推到完成态', done.draft.status === 'done', done.draft.status);
check('done 记下用量', done.draft.usage !== null && done.draft.usage.totalMs === 5);
check('done 要求立刻落盘', done.terminal === true);
check('isTerminalStatus 认完成态', isTerminalStatus('done') === true);

const lateToken = step(done.draft, { type: 'token', runId: RUN, text: '迟到' });
check('终态后的 token 被丢弃，正文不变', lateToken.draft.content === '你好', lateToken.draft.content);
check('被丢弃的帧要计数，不许静默', lateToken.draft.dropped === 1, String(lateToken.draft.dropped));
check('丢弃帧不触发落盘、不产生事件', lateToken.terminal === false && lateToken.append === null);

const dupDone = step(done.draft, { type: 'done', runId: RUN, usage: { promptTokens: 9, completionTokens: 9, totalMs: 999 } });
check('重复 done 不许把终态改回去', dupDone.draft.status === 'done', dupDone.draft.status);
check('重复 done 不许覆盖已记的用量', dupDone.draft.usage.totalMs === 5, String(dupDone.draft.usage.totalMs));
check('重复 done 也计入丢弃数', dupDone.draft.dropped === 1, String(dupDone.draft.dropped));

// ─────────────────────────────────────────────────────────────
console.log('\n── ③ 中断与失败必须可区分 ──────────────────────');

const aborted = step(afterTokens, { type: 'error', runId: RUN, code: 'ABORTED', message: '已被用户中断' });
check('ABORTED → 被中断，不是失败', aborted.draft.status === 'aborted', aborted.draft.status);
check('中断保留已收到的正文（不是清空）', aborted.draft.content === '你好', aborted.draft.content);
check('中断记下原因', aborted.draft.error === '已被用户中断', String(aborted.draft.error));
check('中断同样要求立刻落盘', aborted.terminal === true);

const failed = step(afterTokens, { type: 'error', runId: RUN, code: 'UPSTREAM', message: '上游 500' });
check('其它错误码 → 失败态（与中断可区分）', failed.draft.status === 'failed', failed.draft.status);
check('失败也保留正文', failed.draft.content === '你好');
check('四种状态的终态判定只有三种为真', isTerminalStatus('streaming') === false && isTerminalStatus('aborted') === true && isTerminalStatus('failed') === true);

// ─────────────────────────────────────────────────────────────
console.log('\n── ④ 工具帧配对 ──────────────────────────────');

let t = step(afterTokens, { type: 'tool', runId: RUN, callId: 'c1', name: 'search_resume', args: { q: '鸿蒙' } });
check('工具开始帧不落库（只有开始没有结果）', t.append === null);
check('开始帧进入待配表', t.draft.pendingTools.length === 1, JSON.stringify(t.draft.pendingTools));
check('开始帧不动事件序号', t.draft.nextEventSeq === 1);

const te = step(t.draft, { type: 'tool_end', runId: RUN, callId: 'c1', ok: true, ms: 12 });
check('结束帧配对后落一条完整事件', te.append !== null && te.append.kind === 'tool', JSON.stringify(te.append));
check('工具事件带上名称与参数预览', te.append.name === 'search_resume' && te.append.argsPreview.includes('鸿蒙'), String(te.append.argsPreview));
check('工具事件带成功位与耗时', te.append.ok === true && te.append.ms === 12);
check('配对后待配表清空', te.draft.pendingTools.length === 0);

const orphan = step(afterTokens, { type: 'tool_end', runId: RUN, callId: 'c_missing', ok: true, ms: 1 });
check('孤儿结束帧不落库（找不到开始帧）', orphan.append === null);
check('孤儿帧不抛错，只静默跳过', snap(orphan.draft) === snap(afterTokens));

const shortArgs = step(afterTokens, { type: 'tool', runId: RUN, callId: 'c2', name: 'x', args: 'plain-string' });
check('字符串参数原样保留', shortArgs.draft.pendingTools[0].argsPreview === 'plain-string', shortArgs.draft.pendingTools[0].argsPreview);

let longArgs = step(afterTokens, { type: 'tool', runId: RUN, callId: 'c3', name: 'x', args: { s: 'x'.repeat(500) } });
check('超长参数被截断（不许把整坨 JSON 塞进事件表）', longArgs.draft.pendingTools[0].argsPreview.length <= 201, String(longArgs.draft.pendingTools[0].argsPreview.length));

let circularArgs = step(afterTokens, { type: 'tool', runId: RUN, callId: 'c4', name: 'x', args: null });
check('null 参数也能预览', circularArgs.draft.pendingTools[0].argsPreview === 'null', circularArgs.draft.pendingTools[0].argsPreview);

const cyclic = {};
cyclic.self = cyclic;
const cyclicRes = step(afterTokens, { type: 'tool', runId: RUN, callId: 'c5', name: 'x', args: cyclic });
check(
  '循环引用参数不许把这一轮打挂',
  cyclicRes.draft.pendingTools[0].argsPreview === '<无法序列化>',
  cyclicRes.draft.pendingTools[0].argsPreview,
);

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑤ 引用 / 动作落库与序号单调 ─────────────────');

const emptySources = step(afterTokens, { type: 'sources', runId: RUN, sources: [] });
check('空引用不落库（没有信息量）', emptySources.append === null);
check('空引用不动事件序号', emptySources.draft.nextEventSeq === 1);

const srcRes = step(afterTokens, { type: 'sources', runId: RUN, sources: ['a.md', 'b.md'] });
check('引用落库', srcRes.append !== null && srcRes.append.kind === 'sources');
check('引用保序', JSON.stringify(srcRes.append.sources) === '["a.md","b.md"]', JSON.stringify(srcRes.append.sources));

const actRes = step(srcRes.draft, { type: 'action', runId: RUN, actionId: 'a1', label: '打开 wiki', url: 'https://wiki.example/doc' });
check('动作落库', actRes.append !== null && actRes.append.kind === 'action');
check('动作 URL 原样记录（校验留给打开时）', actRes.append.url === 'https://wiki.example/doc', actRes.append.url);

check('事件序号严格递增', srcRes.append.seq === 1 && actRes.append.seq === 2, `${srcRes.append.seq},${actRes.append.seq}`);
check('事件都挂在当前消息上', srcRes.append.messageId === 'm1' && actRes.append.messageId === 'm1');
check('每个事件拿到不同 id', srcRes.append.eventId !== actRes.append.eventId, `${srcRes.append.eventId} / ${actRes.append.eventId}`);
check('事件带注入时钟的时间戳', srcRes.append.createdAt === 1000 && actRes.append.createdAt === 1000);

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑥ 词表新增成员必须抛 ────────────────────────');

checkThrows(
  '未知事件类型必须抛（新增词表成员不许静默丢帧）',
  () => step(afterTokens, { type: 'brand_new', runId: RUN }),
  '未处理',
);

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑦ 草稿不可变 ─────────────────────────────');

const before = createDraft();
const frozen = step(before, { type: 'token', runId: RUN, text: 'a' });
check('折叠不修改传入的草稿（旧值仍是空）', before.content === '' && before.status === 'streaming');
check('返回的是新对象', frozen.draft !== before);

finish();
