#!/usr/bin/env node
/**
 * M0 验收脚本 —— 证明「类型安全 IPC」不是口号。
 *
 * 做法：对每个负例，
 *   ① 备份原文件
 *   ② 往文件末尾追加一段**故意写错**的代码
 *   ③ 用 TypeScript Compiler API 在**进程内**重新做一次全量类型检查
 *   ④ 断言：必须报错，且错误信息命中预期模式
 *   ⑤ 还原文件
 *
 * 为什么只看正例通过不够：
 *   一个把类型写成 any 的项目同样能通过正例。
 *   必须证明「写错会被挡住」，类型约束才算真的存在。
 *
 * 为什么不用 `tsc -b` 子进程：
 *   本机（Windows）环境下 child_process 派生一律 EBUSY，
 *   改用 Compiler API 在进程内检查 —— 零子进程、跨平台、还能直接拿到诊断对象。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = join(ROOT, 'packages', 'shell-electron', 'tsconfig.json');

const RENDERER = 'packages/shell-electron/src/renderer/api.ts';
const HANDLERS = 'packages/shell-electron/src/main/handlers.ts';

const CASES = [
  {
    id: 'A',
    what: 'renderer 调用未登记进 IpcInvokeMap 的通道（agentStream 是单向推送，不走 invoke）',
    file: RENDERER,
    append: `
export function __caseA() {
  return window.bridge.invoke(IPC.agentStream);
}
`,
    expect: /agent:stream/,
  },
  {
    id: 'B',
    what: 'renderer 给 agentRun 少传了 req.input（请求形状不符）',
    file: RENDERER,
    append: `
export function __caseB() {
  return window.bridge.invoke(IPC.agentRun, { sessionId: 's1' });
}
`,
    expect: /input/i,
  },
  {
    id: 'C',
    what: 'main handler 给 agentRun 返回错类型（runId 写成 number）',
    file: HANDLERS,
    append: `
export function __caseC() {
  defineInvoke(IPC.agentRun, async () => ({ runId: 123 }));
}
`,
    expect: /runId|number/i,
  },
  {
    id: 'D',
    what: 'renderer 在 token 分支访问了不存在的字段（discriminated union 应收窄）',
    file: RENDERER,
    append: `
export function __caseD() {
  return window.bridge.onStream((e) => (e.type === 'token' ? e.name : ''));
}
`,
    expect: /name/i,
  },
  {
    id: 'E',
    what: 'main 侧把通道名写成拼错的字面量（绕过 IPC 常量表）',
    file: HANDLERS,
    append: `
export function __caseE() {
  defineInvoke('agent:runn', async () => ({ runId: 'x' }));
}
`,
    expect: /agent:runn/,
  },
];

/** 在进程内对 shell-electron 项目做一次全量类型检查（连带检查 contract / core 源码）。 */
function checkProject() {
  const cfg = ts.readConfigFile(PROJECT, ts.sys.readFile);
  if (cfg.error) {
    throw new Error(ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n'));
  }

  const parsed = ts.parseJsonConfigFileContent(
    cfg.config,
    ts.sys,
    dirname(PROJECT),
  );

  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diags = ts.getPreEmitDiagnostics(program);

  const text = ts.formatDiagnostics(diags, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => '\n',
  });

  return { ok: diags.length === 0, count: diags.length, text };
}

console.log('── 正例：全量类型检查应通过 ──────────────────────');
const baseline = checkProject();
if (!baseline.ok) {
  console.error(`❌ 基线不干净（${baseline.count} 个诊断），先修好再跑负例：\n`);
  console.error(
    baseline.text
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 15)
      .join('\n'),
  );
  process.exit(1);
}
console.log('✅ 全项目 0 诊断\n');

console.log('── 负例：故意写错，必须被拦住 ──────────────────────');

let caught = 0;
for (const c of CASES) {
  const abs = join(ROOT, c.file);
  const original = readFileSync(abs, 'utf8');

  let result;
  try {
    writeFileSync(abs, original + c.append);
    result = checkProject();
  } finally {
    writeFileSync(abs, original);
  }

  const blocked = !result.ok;
  const matched = c.expect.test(result.text);
  const ok = blocked && matched;
  if (ok) caught += 1;

  console.log(
    `${ok ? '✅' : '❌'} [${c.id}] ${blocked ? '编译失败（被拦住）' : '编译通过 ← 类型约束失效！'}` +
      `${blocked && !matched ? ' · 报错内容与预期不符' : ''}\n     ${c.what}`,
  );

  if (!ok) {
    console.log('     ── 实际诊断 ──');
    console.log(
      (result.text || '(无诊断输出)')
        .split('\n')
        .filter((l) => l.trim())
        .slice(0, 6)
        .map((l) => '     ' + l)
        .join('\n'),
    );
  }
}

console.log('\n── 还原校验 ──────────────────────────────────────');
const final = checkProject();
if (!final.ok) {
  console.error(`❌ 还原后仍有 ${final.count} 个诊断，工作区被污染：\n`);
  console.error(
    final.text
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 15)
      .join('\n'),
  );
  process.exit(1);
}
console.log('✅ 文件已还原，全项目重新 0 诊断');

console.log(
  `\n结果：${caught}/${CASES.length} 个负例被类型系统拦住` +
    (caught === CASES.length
      ? ' — 类型安全 IPC 成立 🎉'
      : ' — 存在漏网，需检查约束定义'),
);
process.exit(caught === CASES.length ? 0 : 1);
