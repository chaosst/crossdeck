#!/usr/bin/env node
/**
 * 鸿蒙自检**判定层**的鉴别力测试 —— 不需要真机，也不派生子进程。
 *
 * ## 为什么要有它
 *
 * `packages/shell-ohos/scripts/verify-ohos.mjs` 的第 ⑩ 步（三判断）是本卡的核心，
 * 但它要连模拟器。在**没有设备**的环境里，那条路一行都跑不到 —— 判定表写得好不好，
 * 就只能靠肉眼。这个脚本把那层判定拿出来，用**合成行**（格式逐字抄自 `Index.ets`
 * 的 `runSelfCheck`）驱动，把客户端行为逐条改坏，看它是否每条都挂。
 *
 * ## 它已经抓到过的真缺陷（如实记）
 *
 * **M0 基线就挂。** 第一版解析器把 `text=` / `frames=` 写成必需字段，而应用给
 * `unknown` 那行**不打**这两个字段 —— 于是 `unknown` 永远解析不出来，反向断言
 * 变成**恒红**：真机上"跑对了"也会报失败。改真机之前抓到的，因为真机那时够不着。
 *
 * ## 这条"挂死"不是坏事，但判定要看退出码
 *
 * 变异测试有两种失败形态，我们**只**认第一种：
 *   · 判定挂了（打 ❌）—— 期望之内
 *   · 脚本自己崩了（退出码非 0，却一条 ❌ 都没有）—— 那是我们写错了，不是变异被杀
 * 所以最终判定同时看 `code=` 与计数：`DONE code=1` 且"异常 0 例"才算过。
 *
 * ## 13 发变异 + 1 发反向（全部被杀）
 *
 * | 变异 | 改坏的是什么 | 被哪一条杀掉 |
 * |---|---|---|
 * | M0 | 不动（基线） | —— 应当 0 条 |
 * | M1 | normal 终态数 1→2 | `场景 normal · 恰好一个终态` |
 * | M2 | 两条断流合成一条（killed 说成"没收到 done 帧"） | `场景 killed · 措辞` |
 * | M3 | 断流当成功（silent-close → done） | `场景 silent-close · 终态与错误码` |
 * | M4 | abort 没被认出来（ABORTED → UPSTREAM） | `场景 abort · 终态与错误码` |
 * | M5 | normal 少收几片（逐帧不够） | `场景 normal · 逐帧` |
 * | M6 | normal 正文长度差 1（跳字 / 重复） | `场景 normal · 正文长度` |
 * | M7 | 报告里没有 unknown 那行 | `反向 · 不认识场景被拒` |
 * | M8 | 不认识场景没被拒（HTTP 200） | `反向 · 不认识场景被拒` |
 * | M9 | 上游给截断场景也发了 done | `对端 · 截断场景没发 done` |
 * | M10 | 停止没真断连（对端没看见 abort） | `对端 · 看见了 abort 断连` |
 * | M11 | 应用自报异常（超时兜底） | `场景 normal · 无异常` |
 * | M12 | 没有 DONE 行 | `自检跑完` |
 * | R1 | **反向**：判定表里 killed 的 `msgHas` 拿掉 | —— M2 那条**不再挂**（证明是它承重） |
 *
 * 每发只挂**一条**（M0/R1 挂 0 条），说明判定不是靠"一挂一大片"蒙对的。
 * R1 是必须的：只证明"改坏输入会挂"还不够 —— 得证明"挂"确实靠那条断言，
 * 否则可能只是别的断言恰好也不同意，那就等于我们并不知道自己在测什么。
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NAV_NORMAL_CHUNKS } from '../../../scripts/fake-navigate-upstream.mjs';
import { judgeSelfcheck } from './parse-ohos-selfcheck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, 'parse-ohos-selfcheck.mjs');
const EXPECT_TEXT = NAV_NORMAL_CHUNKS.join('');

// 格式逐字抄自 Index.ets 的 runSelfCheck：
//   `run <key> terminal=… count=… code=… text=… frames=…[ error=…][ msg=…]`
// ⚠️ `unknown` 那行应用**不打** text=/frames= —— 这正是当初让基线挂掉的地方，
//    所以它必须**留在**这份合成报告里（免得以后有人"顺手补齐"把那个坑盖回去）。
const GOOD = [
  '[SELFCHECK] upstream=http://127.0.0.1:41000',
  '[SELFCHECK] fixture scenarios=5',
  '[SELFCHECK] run normal terminal=done count=1 code=- text=23 frames=5',
  '[SELFCHECK] run silent-close terminal=error count=1 code=UPSTREAM text=22 frames=5 msg=上游提前关闭连接：没收到 done 帧',
  '[SELFCHECK] run killed terminal=error count=1 code=UPSTREAM text=22 frames=5 msg=读取上游流失败：terminated',
  '[SELFCHECK] run upstream-error terminal=error count=1 code=UPSTREAM text=22 frames=5 msg=上游报错：SELFCHECK：上游故意报错',
  '[SELFCHECK] run abort terminal=error count=1 code=ABORTED text=3 frames=3 msg=用户取消了这次提问',
  '[SELFCHECK] run unknown terminal=error count=1 code=- msg=HTTP 400：自检假上游不认识这个场景',
  '[SELFCHECK] peer clientGone=abort doneSent=normal logins=0',
  '[SELFCHECK] DONE runs=6',
];

const sub = (from, to) => (lines) => lines.map((l) => (l.includes(from) ? l.replace(from, to) : l));
const drop = (needle) => (lines) => lines.filter((l) => !l.includes(needle));

const cases = [
  { name: 'M0 基线：判定应全过', mutate: (l) => l, mustFail: [] },
  {
    name: 'M1 终态数=2（收尾窗口没起作用 → 会漏掉第二个终态）',
    mutate: sub('run normal terminal=done count=1', 'run normal terminal=done count=2'),
    mustFail: ['场景 normal · 恰好一个终态'],
  },
  {
    name: 'M2 两条断流被合成一条（killed 说成"没收到 done 帧"）',
    mutate: sub('msg=读取上游流失败：terminated', 'msg=上游提前关闭连接：没收到 done 帧'),
    mustFail: ['场景 killed · 措辞'],
  },
  {
    name: 'M3 断流没报错、反而当成功（silent-close → done）',
    mutate: sub('run silent-close terminal=error count=1 code=UPSTREAM', 'run silent-close terminal=done count=1 code=-'),
    mustFail: ['场景 silent-close · 终态与错误码'],
  },
  {
    name: 'M4 abort 没被认出来（ABORTED → UPSTREAM）',
    mutate: sub('run abort terminal=error count=1 code=ABORTED', 'run abort terminal=error count=1 code=UPSTREAM'),
    mustFail: ['场景 abort · 终态与错误码'],
  },
  {
    name: 'M5 normal 少收了几片（逐帧不够）',
    mutate: sub('count=1 code=- text=23 frames=5', 'count=1 code=- text=23 frames=1'),
    mustFail: ['场景 normal · 逐帧'],
  },
  {
    name: 'M6 normal 正文长度不对（跳字 / 重复）',
    mutate: sub('count=1 code=- text=23 frames=5', 'count=1 code=- text=22 frames=5'),
    mustFail: ['场景 normal · 正文长度'],
  },
  {
    name: 'M7 反向丢了：unknown 那行不在报告里',
    mutate: drop('run unknown '),
    mustFail: ['反向 · 不认识场景被拒（HTTP 400）'],
    note: '顺带盯住"解析器要求 text=/frames= 才认"这个坑 —— 应用给 unknown 那行不打这两个字段',
  },
  {
    name: 'M8 不认识场景没被拒（上游把它当正常回答，HTTP 200）',
    mutate: sub('msg=HTTP 400：自检假上游不认识这个场景', 'msg=正文：这是一个正常回答'),
    mustFail: ['反向 · 不认识场景被拒（HTTP 400）'],
  },
  {
    name: 'M9 上游把截断场景也发了 done',
    mutate: sub('peer clientGone=abort doneSent=normal', 'peer clientGone=abort doneSent=normal,killed'),
    mustFail: ['对端 · 截断场景没发 done'],
  },
  {
    name: 'M10 停止没真的断连（对端没看见 abort）',
    mutate: sub('peer clientGone=abort', 'peer clientGone='),
    mustFail: ['对端 · 看见了 abort 断连'],
  },
  {
    name: 'M11 应用自报异常（超时兜底）',
    mutate: sub('count=1 code=- text=23 frames=5', 'count=1 code=- text=23 frames=5 error=12s 内没有终态'),
    mustFail: ['场景 normal · 无异常'],
  },
  {
    name: 'M12 自检根本没跑完（没有 DONE 行）',
    mutate: drop('DONE runs='),
    mustFail: ['自检跑完'],
  },
];

let bad = 0;

for (const c of cases) {
  const lines = c.mutate([...GOOD]);
  const { verdicts } = judgeSelfcheck(lines, EXPECT_TEXT);
  const failed = verdicts.filter((v) => !v.ok).map((v) => v.name).sort();
  const ok = JSON.stringify(failed) === JSON.stringify([...c.mustFail].sort());
  if (!ok) bad += 1;
  console.log(`${ok ? '✅' : '❌'} ${c.name}`);
  console.log(`     挂了 ${failed.length} 条：${failed.length === 0 ? '（无）' : failed.join(' | ')}`);
  if (!ok) console.log(`     期望挂：${c.mustFail.length === 0 ? '（无）' : c.mustFail.join(' | ')}`);
  if (c.note !== undefined) console.log(`     ⚠️ ${c.note}`);
}

// ─────────────────────────────────────────────────────────────
// R1 · 反向：判定表里承重的那条删掉，坏输入必须**存活**。
//
// 只有这一步能证明"挂"是靠 `msgHas` 挂的 —— 否则可能只是恰好别的断言
// 也不同意（那就等于我们并不知道自己在测什么）。
// 变异体写到系统临时目录，不往仓库里丢文件。
// ─────────────────────────────────────────────────────────────
const src = readFileSync(MODULE, 'utf8');
const weakened = src.replace("msgHas: '读取上游流失败'", 'msgHas: null');
if (weakened === src) {
  console.log('❌ R1 无法在判定表里删掉 killed 的 msgHas —— 锚点失配，变异没生效（别当成通过）');
  bad += 1;
} else {
  const mutPath = join(tmpdir(), `crossdeck-ohos-judge-mutant-${process.pid}.mjs`);
  writeFileSync(mutPath, weakened, 'utf8');
  try {
    const mutant = await import(pathToFileURL(mutPath).href);
    const { verdicts } = mutant.judgeSelfcheck(cases[2].mutate([...GOOD]), EXPECT_TEXT);
    const failed = verdicts.filter((v) => !v.ok).map((v) => v.name);
    const survived = !failed.includes('场景 killed · 措辞');
    console.log(`${survived ? '✅' : '❌'} R1 反向：拿掉 killed 的 msgHas 后，M2 那条措辞断言必须不再挂`);
    console.log(`     挂了 ${failed.length} 条：${failed.length === 0 ? '（无）' : failed.join(' | ')}`);
    if (!survived) {
      console.log('     说明它被别的断言顺带覆盖了 —— 要重新想它到底测什么');
      bad += 1;
    }
  } finally {
    rmSync(mutPath, { force: true });
  }
}

console.log('────────────────────────────────────────────────');
console.log(`[ohos-judge] 共 ${cases.length + 1} 例，异常 ${bad} 例`);
console.log(`[ohos-judge] DONE code=${bad === 0 ? 0 : 1}`);
process.exit(bad === 0 ? 0 : 1);
