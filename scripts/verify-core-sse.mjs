#!/usr/bin/env node
/**
 * T4/T5 验收：SSE 帧解析 + navigate 事件映射。
 *
 * 做法：**零依赖、无子进程**，直接加载 core 的**编译产物**
 *   （packages/core/dist/index.js）跑纯 Node 断言 —— 与 verify-core-scope.mjs 同法。
 *
 * 为什么不用测试框架：这些断言要的是"边界不能错"，不是覆盖率。
 *   而且能这样跑本身就是「core 平台无关」的一次可执行证明。
 *
 * ══════════════════════════════════════════════════════════════════
 * 变异测试记录
 * ══════════════════════════════════════════════════════════════════
 * 变异是指"把实现改坏一个点，看有没有断言挂"。挂 0 条 = 那条断言没有鉴别力 = 重写。
 *
 * ⚠️ 做法要点（本次踩过）：变异**必须改 src 并重新编译**再跑断言。
 *    只改 src 不跑 typecheck → 加载的还是旧 dist → 得到假结果。
 *
 *  M1 残帧不吐 → 吐（findFrameBoundary 找不到空行时也产出整块）
 *      → 实测挂 **17 条**（用例 3 / 4 / 6b / 6d / 6c / 6e / 12 / 12b / 12c / 15 / 16c）
 *  M2 多行 data 从"换行拼接"改成"覆盖"
 *      → 实测挂 **1 条**（用例 7）
 *  M3 去掉 `\r\n` 处理（findLineEnd 的 `\r` 分支失效）
 *      → 实测挂 **5 条**（用例 5 / 6b / 6c / 6d / 6e-b）
 *  M4 把"只剥一个前导空格"改成 trim
 *      → 实测挂 **1 条**（用例 14c「data:  x → " x"」；比预期更准，14 用的是单空格）
 *  M5 未知 event 静默丢弃（default 返回空文本动作）
 *      → 实测挂 **2 条**（用例 20 / 20b）
 *  M6 `done` 无条件认（不再校验 `__DONE__` 字面量）
 *      → 第一次实测挂 **0 条** ❗ —— 用例 17/17b/17c 全用**合法** `__DONE__` 喂，
 *        "不是字面量就不认"这条负例缺失 → 变异存活。
 *        **补用例 17d**（`data: {"oops":1}` 必须映射成 unknown）后 → 实测挂 **1 条**（用例 17d）。
 *        这就是"变异测试捉出没有鉴别力的用例"的活例子。
 *
 * 结论：6/6 变异均被杀死。其中 M6 靠补 17d 才杀死 —— 保留此记录以免后人删掉 17d。
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

const { SseParser, mapNavigateFrame, mapNavigateFrames, dedupeSources } = core;

if (typeof SseParser !== 'function') {
  console.error('❌ core 产物里没有 SseParser —— core/src/index.ts 是否已 export ./net/sse.js ?');
  process.exit(1);
}
if (typeof mapNavigateFrame !== 'function') {
  console.error('❌ core 产物里没有 mapNavigateFrame —— 是否已 export ./net/navigate.js ?');
  process.exit(1);
}

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

/** 把一段文本整体喂进去，收全部帧 + 收尾信息 */
function parseAll(text) {
  const p = new SseParser();
  const frames = p.push(text);
  const tail = p.end();
  return { frames, tail };
}

/** 把一段文本按固定宽度切片喂进去 —— 用于"切片不改变结果"这类断言 */
function parseSliced(text, width) {
  const p = new SseParser();
  const frames = [];
  for (let i = 0; i < text.length; i += width) {
    frames.push(...p.push(text.slice(i, i + width)));
  }
  const tail = p.end();
  return { frames, tail };
}

const eqFrames = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ═════════════════════════════════════════════════════════════
console.log('\n── T4 · SSE 解析器 ──');
// ═════════════════════════════════════════════════════════════

// 用例 1：单帧完整
{
  const { frames, tail } = parseAll('event: token\ndata: "hi"\n\n');
  check('1. 单帧完整 → 恰好 1 帧', frames.length === 1, `实际 ${frames.length}`);
  check('1b. 帧内容正确', eqFrames(frames, [{ event: 'token', data: '"hi"' }]), JSON.stringify(frames));
  check('1c. 收尾无残帧', tail.hasPending === false, JSON.stringify(tail));
}

// 用例 2：一个 chunk 含 3 帧 → 按序全出
{
  const text = 'event: token\ndata: "a"\n\nevent: token\ndata: "b"\n\nevent: done\ndata: __DONE__\n\n';
  const { frames } = parseAll(text);
  check('2. 一个 chunk 含 3 帧 → 全出且有序',
    eqFrames(frames, [
      { event: 'token', data: '"a"' },
      { event: 'token', data: '"b"' },
      { event: 'done', data: '__DONE__' },
    ]),
    JSON.stringify(frames));
}

// 用例 3：切成 2 片 —— 切在 \n\n 前后 / data: 中间 / event: 中间
{
  const text = 'event: token\ndata: "hello"\n\nevent: done\ndata: __DONE__\n\n';
  const cuts = [
    ['\\n\\n 之前', text.indexOf('\n\n')],
    ['\\n\\n 之后', text.indexOf('\n\n') + 2],
    ['data: 中间', text.indexOf('data:') + 3],
    ['event: 中间', text.indexOf('event:') + 3],
  ];
  for (const [where, cut] of cuts) {
    const p = new SseParser();
    const frames = [...p.push(text.slice(0, cut)), ...p.push(text.slice(cut))];
    check(`3. 切在 ${where}（位置 ${cut}）→ 与整体一致`, eqFrames(frames, parseAll(text).frames),
      `${JSON.stringify(frames)}`);
  }
}

// 用例 4：切成 1 字符一片 → 必须与整体完全相同（最狠的边界）
{
  const text = 'event: token\ndata: "你好，世界"\n\nevent: sources\ndata: ["a","b"]\n\nevent: done\ndata: __DONE__\n\n';
  const one = parseSliced(text, 1);
  const whole = parseAll(text);
  check('4. 切成 1 字符一片 → 结果与整体完全相同', eqFrames(one.frames, whole.frames),
    `1字符=${JSON.stringify(one.frames)}\n       整体  =${JSON.stringify(whole.frames)}`);
  check('4b. 1 字符切片后无残帧', one.tail.hasPending === false, JSON.stringify(one.tail));
}

// 用例 5：\r\n 分隔
{
  const { frames } = parseAll('event: token\r\ndata: "x"\r\n\r\n');
  check('5. CRLF 分隔 → 1 帧', eqFrames(frames, [{ event: 'token', data: '"x"' }]), JSON.stringify(frames));
}

// 用例 6：\r\n 与 \n 混用
{
  const { frames } = parseAll('event: token\r\ndata: "x"\n\nevent: done\r\ndata: __DONE__\r\n\n');
  check('6. CRLF/LF 混用 → 2 帧', frames.length === 2, JSON.stringify(frames));
  check('6b. 混用时字段未串味', frames[0]?.data === '"x"' && frames[1]?.data === '__DONE__',
    JSON.stringify(frames));
}

// 用例 6c：裸 \r 作为行结束（规范允许）
// ⚠️ 注意这里**必须**用三处 `\r`：帧内容两行结束 + 一个空行。
//    只写两处 `\r\r` 时，末尾那个 `\r` 落在缓冲末尾，解析器**无法判定**
//    它是裸 CR 还是 CRLF 的前半 → 按"残帧不吐"原则留缓冲，这是**正确行为**。
//    另有一条专门的用例（6e）钉住这个"末尾 \r 必须等下一片"的语义。
{
  const { frames } = parseAll('event: token\rdata: "r"\r\r\r');
  check('6c. 裸 CR 行结束 → 1 帧', eqFrames(frames, [{ event: 'token', data: '"r"' }]), JSON.stringify(frames));
}

// 用例 6e：缓冲以 \r 结尾时必须等下一片（不能凭空判定行结束）
{
  const p = new SseParser();
  const first = p.push('event: token\rdata: "wait"\r');
  check('6e. 缓冲末尾的 \\r 不判定行结束（等下一片）', first.length === 0, JSON.stringify(first));
  const second = p.push('\r\r');
  check('6e-b. 补齐后正常产出 1 帧', eqFrames(second, [{ event: 'token', data: '"wait"' }]),
    JSON.stringify(second));
}

// 用例 6d：\r 恰好落在切片末尾（CRLF 被切成两半）
{
  const text = 'event: token\r\ndata: "crlf"\r\n\r\n';
  const cut = text.indexOf('\r') + 1; // 切在 \r 与 \n 之间
  const p = new SseParser();
  const frames = [...p.push(text.slice(0, cut)), ...p.push(text.slice(cut))];
  check('6d. CRLF 被从中间切开 → 1 帧（不能多出空帧）',
    eqFrames(frames, [{ event: 'token', data: '"crlf"' }]), JSON.stringify(frames));
}

// 用例 7：多行 data: → 用 \n 拼接（断言确切字符串）
{
  const { frames } = parseAll('event: token\ndata: line1\ndata: line2\ndata: line3\n\n');
  check('7. 多行 data 用 \\n 拼接（不是覆盖、不是直接相连）',
    frames[0]?.data === 'line1\nline2\nline3',
    `实际 ${JSON.stringify(frames[0]?.data)}`);
}

// 用例 8：event: 写在 data: 之后 → 顺序无关
{
  const { frames } = parseAll('data: "after"\nevent: token\n\n');
  check('8. event 在 data 之后 → 仍正确', eqFrames(frames, [{ event: 'token', data: '"after"' }]),
    JSON.stringify(frames));
}

// 用例 9：无 event: → 默认 message
{
  const { frames } = parseAll('data: "naked"\n\n');
  check('9. 无 event → 默认 "message"', frames[0]?.event === 'message', JSON.stringify(frames));
}

// 用例 10：空 data: 行
{
  const { frames } = parseAll('event: token\ndata:\n\n');
  check('10. 空 data 行 → data 是空串', frames[0]?.data === '', JSON.stringify(frames));
}

// 用例 11：: 注释行 → 不产出帧
{
  const { frames, tail } = parseAll(': heartbeat\n\n');
  check('11. 注释行不产出帧', frames.length === 0, JSON.stringify(frames));
  check('11b. 注释行被计数（可诊断"心跳在跳但没数据"）', tail.commentLines === 1,
    JSON.stringify(tail));
  // 注释与真帧混排：注释不影响真帧
  const mixed = parseAll(': ping\nevent: token\ndata: "x"\n\n');
  check('11c. 注释与真帧混排 → 只出真帧', eqFrames(mixed.frames, [{ event: 'token', data: '"x"' }]),
    JSON.stringify(mixed.frames));
}

// 用例 12：末尾残帧（无 \n\n）→ 不吐；收尾时能报出有残帧
{
  const { frames, tail } = parseAll('event: token\ndata: "partial"');
  check('12. 末尾残帧不吐（半截 JSON 不能被当帧）', frames.length === 0, JSON.stringify(frames));
  check('12b. 收尾能报出有未完成残帧', tail.hasPending === true && tail.pendingChars > 0,
    JSON.stringify(tail));

  // 12c：残帧 + 后续补全 → 只出 1 帧
  const p = new SseParser();
  const first = p.push('event: token\ndata: "comp');
  const second = p.push('lete"\n\n');
  check('12c. 残帧补全后只出 1 帧（不是 2 帧）',
    first.length === 0 && eqFrames(second, [{ event: 'token', data: '"complete"' }]),
    `first=${JSON.stringify(first)} second=${JSON.stringify(second)}`);
}

// 用例 13：连续多个空行
{
  const { frames } = parseAll('event: token\ndata: "x"\n\n\n\nevent: done\ndata: __DONE__\n\n');
  check('13. 连续空行 → 帧数不变（不产出空帧）', frames.length === 2, JSON.stringify(frames));
}

// 用例 14：data:x 与 data: x（只剥一个前导空格）
{
  const noSpace = parseAll('event: token\ndata:x\n\n');
  const oneSpace = parseAll('event: token\ndata: x\n\n');
  const twoSpace = parseAll('event: token\ndata:  x\n\n');
  check('14. data:x → "x"', noSpace.frames[0]?.data === 'x', JSON.stringify(noSpace.frames));
  check('14b. data: x → "x"（剥一个空格，不是 trim）', oneSpace.frames[0]?.data === 'x',
    JSON.stringify(oneSpace.frames));
  check('14c. data:  x（两个空格）→ " x"（只剥一个）', twoSpace.frames[0]?.data === ' x',
    `实际 ${JSON.stringify(twoSpace.frames[0]?.data)}`);
}

// 用例 15：中文字符整体喂 / 切成多片喂 → 一致
{
  const text = 'event: token\ndata: "谭泳超，12 年经验"\n\nevent: done\ndata: __DONE__\n\n';
  const whole = parseAll(text);
  for (const w of [1, 2, 3, 5, 17]) {
    const sliced = parseSliced(text, w);
    check(`15. 中文按 ${w} 字符切片 → 与整体一致`, eqFrames(sliced.frames, whole.frames),
      JSON.stringify(sliced.frames));
  }
}

// 用例 16：真实语料驱动 —— 直接读 T3 录下来的原始字节
{
  const { readFileSync } = await import('node:fs');
  const corpora = [
    'resume-chat-plain-revA.raw.txt',
    'resume-chat-retrieval-revA.raw.txt',
  ];
  let anyLoaded = false;
  for (const name of corpora) {
    const file = join(ROOT, 'docs', 'evidence', 'navigate-sse', name);
    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue; // 语料可能被归档/改名，不该让本脚本失败
    }
    anyLoaded = true;
    const whole = parseAll(raw);
    const oneChar = parseSliced(raw, 1);
    const kinds = [...new Set(whole.frames.map((f) => f.event))];
    check(`16. 真实语料 ${name}：能解析出帧`, whole.frames.length > 0,
      `${whole.frames.length} 帧`);
    check(`16b. 真实语料 ${name}：最后一个是 done`, whole.frames.at(-1)?.event === 'done',
      JSON.stringify(whole.frames.at(-1)));
    check(`16c. 真实语料 ${name}：1 字符切片结果一致`, eqFrames(oneChar.frames, whole.frames),
      `整体 ${whole.frames.length} 帧 vs 切片 ${oneChar.frames.length} 帧`);
    check(`16d. 真实语料 ${name}：收尾无残帧`, whole.tail.hasPending === false,
      JSON.stringify(whole.tail));
    check(`16e. 真实语料 ${name}：事件名在预期集合内`,
      kinds.every((k) => ['token', 'sources', 'done', 'error', 'answer'].includes(k)),
      `实际 ${kinds.join(',')}`);
  }
  if (!anyLoaded) {
    check('16. 真实语料（跳过：docs/evidence/navigate-sse/ 下没有 -revA 语料）', true);
  }
}

// ═════════════════════════════════════════════════════════════
console.log('\n── T5 · navigate 事件映射 ──');
// ═════════════════════════════════════════════════════════════

/** 便捷：给定 event/data 直接映射 */
const map = (event, data) => mapNavigateFrame({ event, data });

// 用例 17：done 的 data 不是 JSON —— 一把梭 JSON.parse 会抛（坑 ①）
{
  let threw = null;
  let action = null;
  try {
    action = map('done', '__DONE__');
  } catch (err) {
    threw = err;
  }
  check('17. done 帧不抛异常', threw === null, threw ? String(threw) : '');
  check('17b. done 帧映射为 { kind: "done" }', action?.kind === 'done', JSON.stringify(action));
  // 宽容形态：万一上游写成带引号的
  check('17c. done 写成 "__DONE__"（带引号）也认', map('done', '"__DONE__"').kind === 'done',
    JSON.stringify(map('done', '"__DONE__"')));
  // 🔴 17d（变异 M6 实测补的用例）：done 的 data **不是**该字面量时，
  //   绝不能无条件认成 done。这条是"M6 无条件认 done"唯一的鉴别点 ——
  //   在此之前 17/17b/17c 全用合法 `__DONE__` 喂，所以 M6 变异一条都不挂（已实测）。
  check('17d. done 的 data 不是 __DONE__ → 不认成 done（报 unknown）',
    map('done', '{"oops":1}').kind === 'unknown',
    JSON.stringify(map('done', '{"oops":1}')));
}

// 用例 18：token 是 JSON 字符串
{
  const a = map('token', '"你好"');
  check('18. token 解 JSON 取字符串', a.kind === 'text' && a.text === '你好', JSON.stringify(a));
  // 转义字符要被正确还原
  const b = map('token', '"line1\\nline2"');
  check('18b. token 里的 \\n 被还原成真换行', b.text === 'line1\nline2', JSON.stringify(b));
}

// 用例 19：非法 JSON 的 token → 原文，不抛不丢（坑 ②）
{
  let threw = null;
  let a = null;
  try {
    a = map('token', '这不是 JSON');
  } catch (err) {
    threw = err;
  }
  check('19. 非法 JSON 的 token 不抛', threw === null, threw ? String(threw) : '');
  check('19b. 非法 JSON 的 token 降级为原文（不丢帧）', a?.kind === 'text' && a.text === '这不是 JSON',
    JSON.stringify(a));
  // JSON 能解但不是 string（例如裸数字）→ 也当原文
  const n = map('token', '123');
  check('19c. 解出来不是 string → 当原文（不丢引号来源）', n.kind === 'text' && n.text === '123',
    JSON.stringify(n));
}

// 用例 20：未知 event 必须上报（坑 ③）
{
  const a = map('thinking', '{"step":1}');
  check('20. 未知 event → 产出 unknown 动作（不静默丢）', a?.kind === 'unknown', JSON.stringify(a));
  check('20b. unknown 带上事件名与原始 data', a?.event === 'thinking' && a?.raw === '{"step":1}',
    JSON.stringify(a));
}

// 用例 21：sources 是 JSON 数组
{
  const a = map('sources', '["简历 / summary / 核心亮点","简历 / skills"]');
  check('21. sources 解成字符串数组', a.kind === 'sources' && a.sources.length === 2,
    JSON.stringify(a));
  check('21b. sources 不拼进正文（独立 kind）', a.kind === 'sources', a.kind);
}

// 用例 22：坏 sources 降级为空数组（宁少不炸）
{
  const bad = map('sources', 'not-json');
  check('22. 坏 sources → 空数组（不抛）', bad.kind === 'sources' && bad.sources.length === 0,
    JSON.stringify(bad));
  const wrongShape = map('sources', '{"a":1}');
  check('22b. sources 不是数组 → 空数组', wrongShape.kind === 'sources' && wrongShape.sources.length === 0,
    JSON.stringify(wrongShape));
  const withNonString = map('sources', '["ok",123,null]');
  check('22c. 非字符串元素被剔除', JSON.stringify(withNonString.sources) === '["ok"]',
    JSON.stringify(withNonString));
}

// 用例 23：error 帧
{
  const a = map('error', '"boom"');
  check('23. error 解成可读消息', a.kind === 'error' && a.message === 'boom', JSON.stringify(a));
  const raw = map('error', 'raw failure');
  check('23b. error 非 JSON → 原文当消息', raw.kind === 'error' && raw.message === 'raw failure',
    JSON.stringify(raw));
}

// 用例 24：answer 权威帧 → 独立 kind（不能被当成增量）
{
  const a = map('answer', '"完整答案"');
  check('24. answer → authoritative（与 text 分开）', a.kind === 'authoritative',
    JSON.stringify(a));
  check('24b. authoritative 的正文正确', a.text === '完整答案', JSON.stringify(a));
}

// 用例 25：sources 去重（上游实测有重复）
{
  const dup = ['a', 'b', 'a', 'c', 'b'];
  check('25. dedupeSources 去重保序', JSON.stringify(dedupeSources(dup)) === '["a","b","c"]',
    JSON.stringify(dedupeSources(dup)));
}

// 用例 26：真实语料端到端 —— 帧 → 动作，且能拼出完整答案
{
  const { readFileSync } = await import('node:fs');
  const file = join(ROOT, 'docs', 'evidence', 'navigate-sse', 'resume-chat-plain-revA.raw.txt');
  let raw = null;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    /* 语料缺失时跳过，不判失败 */
  }
  if (raw === null) {
    check('26. 真实语料端到端（跳过：语料不存在）', true);
  } else {
    const frames = parseAll(raw).frames;
    const actions = mapNavigateFrames(frames);
    const text = actions.filter((a) => a.kind === 'text').map((a) => a.text).join('');
    const doneCount = actions.filter((a) => a.kind === 'done').length;
    const unknowns = actions.filter((a) => a.kind === 'unknown');

    check('26. 端到端：拼接增量得到非空答案', text.length > 0, `${text.length} 字`);
    check('26b. 端到端：恰好一个 done', doneCount === 1, `实际 ${doneCount}`);
    check('26c. 端到端：没有未知事件（映射表覆盖了上游实际发的事件）', unknowns.length === 0,
      JSON.stringify(unknowns));
    // 帧序：token… → (sources)? → (answer)? → done
    const kinds = actions.map((a) => a.kind);
    const lastDone = kinds.lastIndexOf('done');
    check('26d. 端到端：done 是最后一个动作', lastDone === kinds.length - 1,
      kinds.join('>'));
    check('26e. 端到端：所有 token 都在 done 之前',
      kinds.indexOf('done') === -1 || kinds.slice(0, lastDone).every((k) => k !== 'done'),
      kinds.join('>'));
    // 若存在权威帧，它必须在 done 之前、且与增量拼接等值（互证）
    const authoritative = actions.find((a) => a.kind === 'authoritative');
    if (authoritative) {
      check('26f. 端到端：权威帧在 done 之前', kinds.indexOf('authoritative') < lastDone,
        kinds.join('>'));
      check('26g. 端到端：权威全文 = 增量拼接（自洽）', authoritative.text === text,
        `权威 ${authoritative.text.length} 字 vs 拼接 ${text.length} 字`);
    } else {
      check('26f. 端到端：无权威帧（= 增量与权威一致，服务端未补发）', true);
    }
  }
}

// ═════════════════════════════════════════════════════════════
const total = passed + failures.length;
console.log('\n──────────────────────────────────────────');
if (failures.length === 0) {
  console.log(`✅ verify-core-sse: ${passed}/${total} 通过`);
} else {
  console.log(`❌ verify-core-sse: ${passed}/${total} 通过，${failures.length} 条失败`);
  for (const f of failures) console.log(`   - ${f}`);
}
console.log('──────────────────────────────────────────\n');

process.exit(failures.length === 0 ? 0 : 1);
