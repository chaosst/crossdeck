#!/usr/bin/env node
/**
 * 类型安全 IPC 的负例验收 —— 证明它不是口号。
 *
 * 做法：对每个负例，
 *   ① 备份原文件
 *   ② 往文件末尾追加一段**故意写错**的代码
 *   ③ 用 TypeScript Compiler API 在**进程内**对该文件所属的项目做类型检查
 *   ④ 断言：必须报错，且错误信息命中预期模式
 *   ⑤ 还原文件
 *
 * 为什么只看正例通过不够：
 *   一个把类型写成 any 的项目同样能通过正例。
 *   必须证明「写错会被挡住」，类型约束才算真的存在。
 *
 * 为什么按项目分开检查：
 *   shell-electron 现在有两个互斥的编译环境 ——
 *     main 项目  lib=ES2022、types=[node]，**拿不到 DOM**
 *     renderer 项目 lib=ES2022+DOM、types=[]，**拿不到 node 全局**
 *   负例必须落在它所属的项目里检查，否则可能被另一个项目的宽松 lib 掩盖。
 *   这本身就构成第三类验证：**跨环境的越界引用应该失败**（见 F / G）。
 *
 * 为什么不用 `tsc -b` 子进程：
 *   本环境下 Node 派生 piped 子进程会 EBUSY，
 *   改用 Compiler API 在进程内检查 —— 零子进程、跨平台、还能直接拿诊断对象。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = join(ROOT, 'packages', 'shell-electron');

const PROJECTS = {
  main: join(SHELL, 'tsconfig.main.json'),
  renderer: join(SHELL, 'tsconfig.renderer.json'),
};

const RENDERER_API = 'packages/shell-electron/src/renderer/api.ts';
const HANDLERS = 'packages/shell-electron/src/main/handlers.ts';
const PRELOAD = 'packages/shell-electron/src/preload/bridge.ts';

const CASES = [
  {
    id: 'A',
    project: 'renderer',
    what: 'renderer 调用未登记进 IpcInvokeMap 的通道（agentStream 是单向推送，不走 invoke）',
    file: RENDERER_API,
    append: `
export function __caseA() {
  return window.bridge.invoke(IPC.agentStream);
}
`,
    expect: /agent:stream/,
  },
  {
    id: 'B',
    project: 'renderer',
    what: 'renderer 给 agentRun 少传了 req.input（请求形状不符）',
    file: RENDERER_API,
    append: `
export function __caseB() {
  return window.bridge.invoke(IPC.agentRun, { sessionId: 's1' });
}
`,
    expect: /input/i,
  },
  {
    id: 'C',
    project: 'main',
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
    project: 'renderer',
    what: 'renderer 在 token 分支访问了不存在的字段（discriminated union 应收窄）',
    file: RENDERER_API,
    append: `
export function __caseD() {
  return window.bridge.onStream((e) => (e.type === 'token' ? e.name : ''));
}
`,
    expect: /name/i,
  },
  {
    id: 'E',
    project: 'main',
    what: 'main 侧把通道名写成拼错的字面量（绕过 IPC 常量表）',
    file: HANDLERS,
    append: `
export function __caseE() {
  defineInvoke('agent:runn', async () => ({ runId: 'x' }));
}
`,
    expect: /agent:runn/,
  },
  {
    id: 'F',
    project: 'renderer',
    what: '渲染层试图 import node 内置模块（它的 lib/types 里根本没有 node）',
    file: RENDERER_API,
    append: `
export async function __caseF() {
  const fs = await import('node:fs');
  return fs.readFileSync('x', 'utf8');
}
`,
    expect: /node:fs|readFileSync|Cannot find module/i,
  },
  {
    id: 'G',
    project: 'main',
    what: '主进程试图使用 DOM 全局 document（main 项目的 lib 里没有 DOM）',
    file: PRELOAD,
    append: `
export function __caseG() {
  return document.body.innerHTML;
}
`,
    expect: /document|Cannot find name/i,
  },
  {
    id: 'H',
    project: 'renderer',
    what: 'renderer 调 fs 通道时少传 workspaceId（fs 通道的 req 契约强制要求归属，不许"默认当前工作区"）',
    file: RENDERER_API,
    append: `
export function __caseH() {
  return window.bridge.invoke(IPC.fsListDir, { path: '.' });
}
`,
    expect: /workspaceId/,
  },
  {
    id: 'I',
    project: 'renderer',
    what: 'fsStat 的 res 是完整 FileStat（res 存**最终值**而非 Promise；缺字段或误包一层都会在这里被拦住）',
    file: RENDERER_API,
    append: `
export async function __caseI() {
  const stat = await window.bridge.invoke(IPC.fsStat, { workspaceId: 'w', path: '.' });
  const numeric: number = stat.size;
  const badShape: typeof stat = { kind: 'file' };
  return [numeric, badShape];
}
`,
    expect: /size|mtimeMs/,
  },
];

/** 在进程内对指定项目做一次全量类型检查（连带检查 contract / core 源码）。 */
function checkProject(projectPath) {
  const cfg = ts.readConfigFile(projectPath, ts.sys.readFile);
  if (cfg.error) {
    return { ok: false, count: 1, text: ts.flattenDiagnosticMessageText(cfg.error.messageText, '\n') };
  }

  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, dirname(projectPath));

  // ⚠️ 必须显式带上 configFilePath：
  //    tsconfig 里有 `types: ["node"]` / `types: []`，而 TS 解析 typeRoots 时的
  //    起点是 options.configFilePath，缺省则退化成 process.cwd() ——
  //    结果就是在仓库根目录下找不到 packages/shell-electron/node_modules/@types，
  //    报 "Cannot find type definition file for 'node'"。
  //    这个坑只在程序化建 Program 时出现，用 tsc CLI 是碰不到的。
  const options = { ...parsed.options, configFilePath: projectPath };

  const program = ts.createProgram(parsed.fileNames, options);
  const diags = ts.getPreEmitDiagnostics(program);

  const text = ts.formatDiagnostics(diags, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => '\n',
  });

  return { ok: diags.length === 0, count: diags.length, text };
}

function checkAll() {
  const results = Object.entries(PROJECTS).map(([name, path]) => [name, checkProject(path)]);
  const bad = results.filter(([, r]) => !r.ok);
  return {
    ok: bad.length === 0,
    text: bad.map(([name, r]) => `# ${name}\n${r.text}`).join('\n'),
    count: results.reduce((n, [, r]) => n + r.count, 0),
  };
}

console.log('── 正例：全量类型检查应通过 ──────────────────────');
const baseline = checkAll();
if (!baseline.ok) {
  console.error(`❌ 基线不干净（${baseline.count} 个诊断），先修好再跑负例：\n`);
  console.error(
    baseline.text
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 20)
      .join('\n'),
  );
  process.exit(1);
}
console.log('✅ main / renderer 两个项目均 0 诊断\n');

console.log('── 负例：故意写错，必须被拦住 ──────────────────────');

let caught = 0;
for (const c of CASES) {
  const abs = join(ROOT, c.file);
  const original = readFileSync(abs, 'utf8');

  let result;
  try {
    writeFileSync(abs, original + c.append);
    result = checkProject(PROJECTS[c.project]);
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
const final = checkAll();
if (!final.ok) {
  console.error(`❌ 还原后仍有 ${final.count} 个诊断，工作区被污染：\n`);
  console.error(
    final.text
      .split('\n')
      .filter((l) => l.trim())
      .slice(0, 20)
      .join('\n'),
  );
  process.exit(1);
}
console.log('✅ 文件已还原，两个项目重新 0 诊断');

console.log(
  `\n结果：${caught}/${CASES.length} 个负例被类型系统拦住` +
    (caught === CASES.length
      ? ' — 类型安全 IPC + 跨环境边界成立 🎉'
      : ' — 存在漏网，需检查约束定义'),
);
process.exit(caught === CASES.length ? 0 : 1);
