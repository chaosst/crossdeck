#!/usr/bin/env node
/**
 * PathGuard / WorkspaceStore 的负例验收 —— 全项目最不能写错的一段代码。
 *
 * 做法：**零依赖、无子进程**，直接加载 core 的**编译产物**
 *   （packages/core/dist/index.js）跑纯 Node 断言。
 *
 * 为什么能这样跑：core 对 contract 只做 `import type`，零运行时依赖 ——
 *   产物在裸 Node 里能直接 import，不需要 ts-node / vitest / 任何测试框架。
 *   这本身就是「core 平台无关」这条铁律的一次**可执行**证明。
 *
 * 为什么不用测试框架：
 *   这些断言要的是「越界必须被拒」，而不是覆盖率。一个 Assert 函数 + 计数
 *   就够了，加了框架反而要维护配置、装依赖、在 CI 里跑更慢。
 *
 * 为什么正例远少于负例：
 *   一个「永远返回 { allowed: true }」的实现能通过全部正例。
 *   安全性只能靠负例证明 —— 所以下面每一条「必须拒绝」都对应一个真实攻击面。
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
  WorkspaceStore,
  createPathGuard,
  foldCase,
  isAbsolutePath,
  isWithinPath,
  joinPath,
  normalizePath,
  parentPath,
  toPosix,
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

/** 断言路径判定结果（reason 必须**具体** —— 全压成一个码的断言是装饰）。 */
async function expectDecision(what, guard, target, opts, expected) {
  const d = await guard.check(target, opts);
  if (expected.allowed) {
    check(
      what,
      d.allowed === true && (expected.workspaceId === undefined || d.workspaceId === expected.workspaceId),
      `期望放行，实际 ${JSON.stringify(d)}`,
    );
  } else {
    check(
      what,
      d.allowed === false && d.reason === expected.reason,
      `期望 reason=${expected.reason}，实际 ${JSON.stringify(d)}`,
    );
  }
  return d;
}

console.log(`\n加载 core 产物：${CORE_DIST}`);
console.log(`导出：${Object.keys(core).join(', ')}\n`);

// ─────────────────────────────────────────────────────────────
// ① posixPath —— 纯字符串层。它的洞会直接变成 PathGuard 的洞
// ─────────────────────────────────────────────────────────────
console.log('── ① posixPath：归一化与前缀对齐 ──────────────────────');
{
  check('toPosix 把 `\\` 折成 `/`', toPosix('a\\b\\c') === 'a/b/c', toPosix('a\\b\\c'));
  check(
    '`a\\..\\b` 经归一化变成 `b`（不能当成一个普通文件名）',
    normalizePath('a\\..\\b') === 'b',
    String(normalizePath('a\\..\\b')),
  );
  check('折叠重复分隔符 `//a///b` → `/a/b`', normalizePath('//a///b') === '/a/b', String(normalizePath('//a///b')));
  check('解析 `.`', normalizePath('/a/./b') === '/a/b', String(normalizePath('/a/./b')));
  check('解析 `..`', normalizePath('/a/b/../c') === '/a/c', String(normalizePath('/a/b/../c')));

  // 非法输入必须返回 null —— 放行一条无法归一的路径等于开后门
  check('空串 → null', normalizePath('') === null);
  check('含 NUL → null', normalizePath('/a/\0b') === null);
  check('盘符相对形式 `C:foo` → null', normalizePath('C:foo') === null, String(normalizePath('C:foo')));
  check(
    '绝对路径上溯越根 `/a/../..` → null（不能退化成 `/`，那是"看起来合规"的逃逸）',
    normalizePath('/a/../..') === null,
    String(normalizePath('/a/../..')),
  );

  check('isAbsolutePath `/x`', isAbsolutePath('/x') === true);
  check('isAbsolutePath `C:/x`', isAbsolutePath('C:/x') === true);
  check('isAbsolutePath `C:x` 为 false', isAbsolutePath('C:x') === false);
  check('isAbsolutePath `x/y` 为 false', isAbsolutePath('x/y') === false);

  check('joinPath 解析 rel 里的 `..`', joinPath('/a/b', '../c') === '/a/c', String(joinPath('/a/b', '../c')));
  check('joinPath `rel` 为 `.` 时回到 base', joinPath('/a/b', '.') === '/a/b', String(joinPath('/a/b', '.')));
  check('joinPath rel 为绝对路径时直接采用', joinPath('/a/b', '/x/y') === '/x/y', String(joinPath('/a/b', '/x/y')));
  check('joinPath 带盘符', joinPath('C:/a', 'b') === 'C:/a/b', String(joinPath('C:/a', 'b')));
  check('joinPath base 非法 → null', joinPath('C:rel', 'b') === null, String(joinPath('C:rel', 'b')));

  // 这条是路径校验里最经典的洞
  check(
    'isWithinPath 前缀必须按 `/` 对齐：`/a/bc` **不在** `/a/b` 内',
    isWithinPath('/a/bc', '/a/b') === false,
  );
  check('isWithinPath 相等算在内', isWithinPath('/a/b', '/a/b') === true);
  check('isWithinPath 真子路径', isWithinPath('/a/b/c', '/a/b') === true);
  check('isWithinPath 区分大小写（默认）', isWithinPath('/A/B', '/a/b') === false);
  check('isWithinPath 大小写不敏感', isWithinPath('/A/B', '/a/b', true) === true);
  check('foldCase 不敏感时小写', foldCase('AbC', true) === 'abc');

  // 上溯必须有终止条件，否则「最近存在的祖先」循环会挂死
  check('parentPath("/") 返回自身', parentPath('/') === '/', parentPath('/'));
  check('parentPath("/a") → "/"', parentPath('/a') === '/', parentPath('/a'));
  check('parentPath("C:/") 返回自身', parentPath('C:/') === 'C:/', parentPath('C:/'));
  check('parentPath("C:/a") → "C:/"', parentPath('C:/a') === 'C:/', parentPath('C:/a'));
  check('parentPath("C:/a/b") → "C:/a"', parentPath('C:/a/b') === 'C:/a', parentPath('C:/a/b'));
  check('parentPath("/a/b") → "/a"', parentPath('/a/b') === '/a', parentPath('/a/b'));
}

// ─────────────────────────────────────────────────────────────
// ② WorkspaceStore —— 授权表与归属判定
// ─────────────────────────────────────────────────────────────
console.log('\n── ② WorkspaceStore：授权表与归属判定 ────────────────');
{
  let n = 0;
  const store = new WorkspaceStore({
    now: () => 1000 + n,
    newId: () => `ws${++n}`,
    caseInsensitive: false,
  });

  const a = store.grant({ root: '/a' });
  const b = store.grant({ root: '/a/b' });
  check('grant 成功返回 ok', a.ok === true && b.ok === true);
  check('grant 默认 mode=read（写权限必须显式升级）', a.ok && a.workspace.mode === 'read');
  check('label 缺省取末级目录名', a.ok && a.workspace.label === 'a', a.ok ? a.workspace.label : '');

  const again = store.grant({ root: '/a' });
  check(
    '同一目录重复授权幂等（复用 id，不同时存在两条指向同一目录的授权）',
    again.ok === true && again.workspace.id === (a.ok ? a.workspace.id : '') && store.size === 2,
    `size=${store.size}`,
  );
  const upgraded = store.grant({ root: '/a', mode: 'readwrite' });
  check(
    '重复授权可升级 mode，且 id 不变',
    upgraded.ok === true && upgraded.workspace.mode === 'readwrite' && upgraded.workspace.id === (a.ok ? a.workspace.id : ''),
    upgraded.ok ? `${upgraded.workspace.mode}/${upgraded.workspace.id}` : '',
  );

  check('grant 非法 root 返回 BAD_PATH 而不是抛异常', store.grant({ root: 'C:rel' }).ok === false);

  // 最长 root 匹配 —— 否则归属会随授权顺序漂移
  const owner1 = store.findOwning('/a/b/c');
  check(
    'findOwning 取**最长** root（/a/b 赢过 /a）',
    owner1 !== null && owner1.root === '/a/b',
    owner1 === null ? 'null' : owner1.root,
  );

  let m = 0;
  const reversed = new WorkspaceStore({ newId: () => `r${++m}`, caseInsensitive: false });
  reversed.grant({ root: '/a/b' });
  reversed.grant({ root: '/a' });
  const owner2 = reversed.findOwning('/a/b/c');
  check(
    '授权顺序反过来，归属不变（这正是「取最长」而不是「取第一个」的理由）',
    owner2 !== null && owner2.root === '/a/b',
    owner2 === null ? 'null' : owner2.root,
  );

  check('findOwning 越界返回 null', store.findOwning('/zzz') === null);
  check(
    'findOwning 前缀陷阱：/a/bc 不归 /a/b',
    store.findOwning('/a/bc') === null || store.findOwning('/a/bc').root === '/a',
    store.findOwning('/a/bc') === null ? 'null' : store.findOwning('/a/bc').root,
  );

  const ci = new WorkspaceStore({ newId: () => 'ci1', caseInsensitive: true });
  ci.grant({ root: 'C:/Work' });
  check(
    '大小写不敏感（Windows 语义）：c:/work/x 归 C:/Work',
    ci.findOwning('c:/work/x') !== null,
    String(ci.findOwning('c:/work/x')),
  );
  const cs = new WorkspaceStore({ newId: () => 'cs1', caseInsensitive: false });
  cs.grant({ root: 'C:/Work' });
  check('大小写敏感（Linux 语义）：c:/work/x 不归 C:/Work', cs.findOwning('c:/work/x') === null);

  check('list 按授权时间正序', store.list()[0]?.root === '/a');
  const id = a.ok ? a.workspace.id : '';
  check('setMode 可降级回只读', store.setMode(id, 'read')?.mode === 'read');
  check('revoke 生效', store.revoke(id) === true && store.get(id) === undefined);
  check('revoke 不存在的 id 返回 false（不是静默成功）', store.revoke('nope') === false);
}

// ─────────────────────────────────────────────────────────────
// ③ PathGuard —— 负例为主。每一条「必须拒绝」都是一个真实攻击面
// ─────────────────────────────────────────────────────────────
console.log('\n── ③ PathGuard：越界必须被拒（负例为主）──────────────');

// 一个可控的假 realpath —— symlink 逃逸无法在无特权 Windows 上真实构造，
// 所以在这里注入。这比"跳过 symlink 测试"诚实得多。
const fakeFs = (map) => async (p) => map[p] ?? null;

{
  const empty = new WorkspaceStore({ caseInsensitive: false });
  const guardEmpty = createPathGuard(empty, { caseInsensitive: false });

  // No realpath injected at all → 纯字符串校验路径（Web 壳的降级形态）
  await expectDecision(
    '未授权任何工作区 → NO_WORKSPACE（与"越界"区分开，UI 要引导用户去授权）',
    guardEmpty,
    '/any/thing',
    undefined,
    { allowed: false, reason: 'NO_WORKSPACE' },
  );
}

{
  const store = new WorkspaceStore({ newId: (() => { let i = 0; return () => `w${++i}`; })(), caseInsensitive: false });
  store.grant({ root: '/ws' });
  const guard = createPathGuard(store, { caseInsensitive: false });

  await expectDecision('授权根自身放行', guard, '/ws', undefined, { allowed: true });
  await expectDecision('授权根之下放行', guard, '/ws/a/b.txt', undefined, { allowed: true });
  await expectDecision(
    '归一化后仍在根内放行（/ws/x/../y）',
    guard,
    '/ws/x/../y',
    undefined,
    { allowed: true },
  );

  await expectDecision(
    '`..` 逃出授权根 → OUT_OF_SCOPE',
    guard,
    '/ws/../etc/passwd',
    undefined,
    { allowed: false, reason: 'OUT_OF_SCOPE' },
  );
  await expectDecision(
    '前缀陷阱：/ws-evil 不得被 /ws 放行',
    guard,
    '/ws-evil/x',
    undefined,
    { allowed: false, reason: 'OUT_OF_SCOPE' },
  );
  await expectDecision(
    '相对路径 → BAD_PATH（它无从判断归属哪个工作区）',
    guard,
    'foo/bar',
    undefined,
    { allowed: false, reason: 'BAD_PATH' },
  );
  await expectDecision(
    '盘符相对形式 C:foo → BAD_PATH',
    guard,
    'C:foo',
    undefined,
    { allowed: false, reason: 'BAD_PATH' },
  );
  await expectDecision(
    '绝对路径上溯越根 /ws/../.. → BAD_PATH（不是退化成 / 再判越界）',
    guard,
    '/ws/../..',
    undefined,
    { allowed: false, reason: 'BAD_PATH' },
  );
  await expectDecision('空路径 → BAD_PATH', guard, '', undefined, { allowed: false, reason: 'BAD_PATH' });
  await expectDecision('含 NUL → BAD_PATH', guard, '/ws/a\0b', undefined, { allowed: false, reason: 'BAD_PATH' });
  await expectDecision(
    '大小写敏感时 /WS 不归 /ws',
    guard,
    '/WS/x',
    undefined,
    { allowed: false, reason: 'OUT_OF_SCOPE' },
  );
}

{
  // 大小写不敏感（Windows 语义）
  const store = new WorkspaceStore({ newId: () => 'win', caseInsensitive: true });
  store.grant({ root: 'C:/Work' });
  const guard = createPathGuard(store, { caseInsensitive: true });
  await expectDecision('Windows：c:/work/x 归 C:/Work', guard, 'c:/work/x', undefined, { allowed: true });
  await expectDecision(
    'Windows：C:/Workshop 不被 C:/Work 放行（前缀陷阱 + 大小写折叠一起验）',
    guard,
    'C:/Workshop/x',
    undefined,
    { allowed: false, reason: 'OUT_OF_SCOPE' },
  );
}

{
  // withinWorkspaceId —— 防"A 工作区里的 ../ 恰好落进 B 工作区"
  let i = 0;
  const store = new WorkspaceStore({ newId: () => `m${++i}`, caseInsensitive: false });
  const wa = store.grant({ root: '/a' });
  const wb = store.grant({ root: '/b' });
  const guard = createPathGuard(store, { caseInsensitive: false });
  const idA = wa.ok ? wa.workspace.id : '';
  const idB = wb.ok ? wb.workspace.id : '';

  await expectDecision('不限定工作区时 /b/x 放行（归属 /b）', guard, '/b/x', undefined, { allowed: true });
  await expectDecision(
    '限定 A 之后 /b/x 必须被拒 —— 这正是「A 的 ../ 落进 B」那个洞',
    guard,
    '/b/x',
    { withinWorkspaceId: idA },
    { allowed: false, reason: 'OUT_OF_SCOPE' },
  );
  await expectDecision(
    '限定 B 之后 /b/x 放行',
    guard,
    '/b/x',
    { withinWorkspaceId: idB },
    { allowed: true, workspaceId: idB },
  );
  await expectDecision(
    '限定不存在的 id → OUT_OF_SCOPE（不是 NO_WORKSPACE —— 表里是有授权的）',
    guard,
    '/a/x',
    { withinWorkspaceId: 'nope' },
    { allowed: false, reason: 'OUT_OF_SCOPE' },
  );
}

// ── symlink 逃逸（注入假 realpath）──────────────────────────
{
  let i = 0;
  const store = new WorkspaceStore({ newId: () => `s${++i}`, caseInsensitive: false });
  store.grant({ root: '/ws' });

  const reals = {
    '/ws': '/ws',
    '/ws/notes': '/ws/notes',
    '/outside': '/outside',
    '/ws/link-out': '/outside/secret.txt',
    '/ws/link-in': '/ws/notes',
    '/ws/esc': '/outside',
  };
  const guard = createPathGuard(store, { realpath: fakeFs(reals), caseInsensitive: false });

  await expectDecision(
    'symlink 指向 scope 外 → ESCAPE_ATTEMPT（纯字符串校验看不出这一层）',
    guard,
    '/ws/link-out',
    undefined,
    { allowed: false, reason: 'ESCAPE_ATTEMPT' },
  );
  await expectDecision(
    'symlink 指向 scope 内 → 放行',
    guard,
    '/ws/link-in',
    undefined,
    { allowed: true },
  );

  // 这条是核心设计决策之一：resolved 必须保持**逻辑路径**
  const d = await guard.check('/ws/link-in');
  check(
    'resolved 不回写 realpath —— 否则 lstat 永远看不到 kind: "symlink"',
    d.allowed === true && d.resolved === '/ws/link-in',
    d.allowed ? d.resolved : JSON.stringify(d),
  );

  // 「最近存在的祖先」兜底：写新文件时目标还不存在
  await expectDecision(
    '目标不存在但祖先在 scope 内 → 放行（写新文件的合法场景）',
    guard,
    '/ws/notes/new-file.md',
    undefined,
    { allowed: true },
  );
  await expectDecision(
    '目标不存在且祖先是逃逸 symlink 目录 → ESCAPE_ATTEMPT（不能因"文件不存在"就免检整条路径）',
    guard,
    '/ws/esc/new-file.txt',
    undefined,
    { allowed: false, reason: 'ESCAPE_ATTEMPT' },
  );

  // 授权根本身解析不出来 → 拒绝，而不是把判定权交给文件系统
  const broken = createPathGuard(store, { realpath: async () => null, caseInsensitive: false });
  await expectDecision(
    'realpath 完全不可用 → BAD_PATH（宁可拒绝，也不放行）',
    broken,
    '/ws/x',
    undefined,
    { allowed: false, reason: 'BAD_PATH' },
  );

  // 不注入 realpath → 跳过 symlink 校验但前缀判定仍然成立（Web 壳的降级形态）
  const lenient = createPathGuard(store, { caseInsensitive: false });
  await expectDecision('无 realpath 时纯字符串放行（Web 壳降级形态）', lenient, '/ws/x', undefined, {
    allowed: true,
  });
  await expectDecision(
    '无 realpath 时越界仍被拒（降级不等于失效）',
    lenient,
    '/outside/secret.txt',
    undefined,
    { allowed: false, reason: 'OUT_OF_SCOPE' },
  );
}

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────');
if (failures.length > 0) {
  console.log(`❌ ${failures.length} 条断言失败：`);
  for (const f of failures) console.log(`   - ${f}`);
} else {
  console.log(`✅ 全部 ${passed} 条断言通过 — core 的 scope 边界成立 🎉`);
}
process.exit(failures.length === 0 ? 0 : 1);
