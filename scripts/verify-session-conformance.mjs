/**
 * verify-session-conformance —— 拿**同一份**仓储用例跑 SQLite 后端。
 *
 * 这个脚本的存在本身就是论点：`checkSessionRepository` 住在 core 里、不碰 IO，
 * 所以同一份断言可以在这里（Node + 真 SQLite 文件）和 Web 壳的自检里
 * （真浏览器 + 真 IndexedDB）各跑一遍。两边通过的用例集合一致，
 * 「一份 SQL、一份对象仓库，同一套语义」才是被验证过的事实，而不是一句话。
 *
 * 与 `verify-session-repo.mjs` 的分工：
 *   · 那边测**实现细节**（表建出来了没有、唯一索引真的拦不拦、坏 JSON 怎么降级）
 *   · 这边测**端口语义**（两个后端都必须满足的那部分）
 * 重叠是有意的：实现细节的断言换后端就得重写，端口语义的不该。
 *
 * 反证：把某一个用例在 core 里删掉，两个后端会**同时**少一条 ——
 * 也就是说这条用例从来没在验实现，它在验规格。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const WORK = mkdtempSync(join(tmpdir(), 'crossdeck-conformance-'));
const ENTRY = join(ROOT, '_tmp_verify_conformance_entry.ts');
const OUT = join(WORK, 'bundle.mjs');

const rel = (p) => './' + p.split('\\').join('/');
writeFileSync(
  ENTRY,
  [
    `export { checkSessionRepository } from '${rel(join('packages', 'core', 'src', 'session', 'repositoryConformance.ts'))}';`,
    `export { openSessionDb } from '${rel(join('packages', 'shell-electron', 'src', 'main', 'sessionDb', 'open.ts'))}';`,
    `export { SessionRepo } from '${rel(join('packages', 'shell-electron', 'src', 'main', 'sessionDb', 'repo.ts'))}';`,
    '',
  ].join('\n'),
  'utf8',
);

process.on('exit', () => {
  rmSync(ENTRY, { force: true });
  rmSync(WORK, { recursive: true, force: true });
});

const require = createRequire(import.meta.url);
let esbuild;
try {
  const mod = await import(
    pathToFileURL(require.resolve('esbuild', { paths: [join(ROOT, 'packages', 'shell-electron')] })).href
  );
  esbuild = mod.build === undefined ? mod.default : mod;
} catch (err) {
  console.error('❌ 找不到 esbuild（shell-electron 的 devDependency）。先跑 `pnpm install`。');
  console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

try {
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUT,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'warning',
  });
} catch (err) {
  console.error('❌ 打包失败：');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const { checkSessionRepository, openSessionDb, SessionRepo } = await import(pathToFileURL(OUT).href);
for (const [name, value] of Object.entries({ checkSessionRepository, openSessionDb, SessionRepo })) {
  if (value === undefined) {
    console.error(`❌ 模块没有导出 ${name} —— 断言无法进行`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
// harness：每个用例一个全新的库文件，时钟与 id 都由这里控制
// ─────────────────────────────────────────────────────────────
const BASE_TIME = 1_700_000_000_000;
let clock = BASE_TIME;
let idSeq = 0;
let caseSeq = 0;

/** 用例建出来的连接都要在最后关掉，否则 Windows 上删不掉临时目录。 */
const opened = [];
/** 最近一个用例的库路径 —— `reopen` 要用它。 */
let lastPath = null;

const deps = {
  now: () => clock,
  newId: (prefix) => `${prefix}_${(idSeq += 1)}`,
};

const harness = {
  label: 'sqlite',
  create() {
    caseSeq += 1;
    const dir = join(WORK, `case-${caseSeq}`);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, 'sessions.db');
    const db = openSessionDb(filePath);
    opened.push(db);
    lastPath = filePath;
    return new SessionRepo(db.db, deps);
  },
  advance(ms) {
    clock += ms;
  },
  /** 新开一个**连接**读同一个文件 —— 这才叫"数据落到盘上了"。 */
  reopen() {
    if (lastPath === null) throw new Error('reopen 之前必须先 create');
    const again = openSessionDb(lastPath);
    opened.push(again);
    return new SessionRepo(again.db, deps);
  },
  dispose() {
    for (const db of opened.splice(0)) {
      try {
        db.close();
      } catch {
        // 已经关过了
      }
    }
  },
};

const result = await checkSessionRepository(harness);

console.log(`\n── 端口语义（SQLite 后端）──`);
console.log(`  ${result.passed}/${result.total} 条通过`);
if (result.skipped.length > 0) {
  console.log(`  跳过 ${result.skipped.length} 条：${result.skipped.join('、')}`);
}
for (const f of result.failures) console.log(`  ❌ ${f}`);

// 单独再钉一条：用例集不能是空的（空集会让"全绿"变成一句空话）
if (result.total < 15) {
  console.log(`  ❌ 用例数只有 ${result.total} 条 —— 少于 15 条说明规格被删空了，全绿不可信`);
  result.failures.push('用例数不足');
}

const failed = result.failures.length;
console.log(`\n${failed === 0 ? '✅' : '❌'} verify-session-conformance：${result.passed}/${result.total} 条通过`);
process.exit(failed === 0 ? 0 : 1);
