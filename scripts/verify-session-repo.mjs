/**
 * verify-session-repo —— Electron 会话库（open + repo）的**真库**断言。
 *
 * 不用 mock、不用 `:memory:`：验的是「文件真的建出来了、迁移真的可重入、
 * 序号真的不撞、删会话真的不留孤儿」。用 esbuild 把 src 打成 bundle 再跑，
 * 所以断言的是**源码**，不是 dist。
 *
 * 变异记录（每发都要求：退出码非 0 且挂 ≥1 条）
 * | ID | 改坏的点                                | 挂掉条数 |
 * |----|---------------------------------------|--------|
 * | M1 | 删会话时不删 events                      | 1      |
 * | M2 | 覆盖写改成 `content = content || ?`       | 1      |
 * | M3 | 取号挪出事务（先 SELECT 再单独 INSERT）     | 1（唯一索引报错） |
 * | M4 | 迁移不校验执行后的版本号                    | 1      |
 *
 * 反向：把「删会话后 events 为 0」这条断言拿掉，M1 必须**杀不掉** —— 那条是守门人。
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const WORK = mkdtempSync(join(tmpdir(), 'crossdeck-repo-'));
const ENTRY = join(ROOT, `_tmp_verify_repo_entry.ts`);
const OUT = join(WORK, 'bundle.mjs');

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

function checkThrows(what, fn, expectPart) {
  try {
    fn();
    check(what, false, '没有抛错');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(what, expectPart === undefined || msg.includes(expectPart), msg);
  }
}

const rel = (p) => './' + p.split('\\').join('/');
writeFileSync(
  ENTRY,
  [
    `export * from '${rel(join('packages', 'shell-electron', 'src', 'main', 'sessionDb', 'open.ts'))}';`,
    `export * from '${rel(join('packages', 'shell-electron', 'src', 'main', 'sessionDb', 'repo.ts'))}';`,
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

const { openSessionDb, SessionRepo, readUserVersion } = await import(pathToFileURL(OUT).href);

for (const [name, value] of Object.entries({ openSessionDb, SessionRepo, readUserVersion })) {
  if (value === undefined) {
    console.error(`❌ 模块没有导出 ${name} —— 断言无法进行`);
    process.exit(1);
  }
}

let seqCounter = 0;
const deps = {
  now: () => 1_700_000_000_000 + seqCounter++,
  newId: (prefix) => `${prefix}_${(seqCounter += 1)}`,
};

// ═════════════════════════════════════════════════════════════
console.log('\n── ① 打开与迁移 ──');
{
  const filePath = join(WORK, 'basic', 'sessions.db');
  const opened = openSessionDb(filePath);
  check('新库的 user_version = 1', opened.version === 1, String(opened.version));

  const tables = opened.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  check('三张表都建出来了', ['events', 'messages', 'sessions'].every((t) => tables.includes(t)), tables.join(','));
  check('events 是独立表（不是被复制粘贴成 messages）', tables.includes('events'));
  opened.close();

  const again = openSessionDb(filePath);
  check('同一个库再开一次不报错（迁移可重入）', again.version === 1);
  check('重开后版本不涨', readUserVersion(again.db) === 1, String(readUserVersion(again.db)));
  again.close();

  const future = join(WORK, 'future.db');
  mkdirSync(WORK, { recursive: true });
  {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(future);
    db.exec('PRAGMA user_version = 99');
    db.close();
  }
  checkThrows('库版本比程序新 → 打开必须抛（不许当旧库写）', () => openSessionDb(future), '版本不兼容');

  const junk = join(WORK, 'junk.db');
  writeFileSync(junk, 'this is not a sqlite file', 'utf8');
  checkThrows('坏文件 → 打开必须抛', () => openSessionDb(junk));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ② 会话 CRUD ──');
const repoFile = join(WORK, 'crud', 'sessions.db');
const opened = openSessionDb(repoFile);
const repo = new SessionRepo(opened.db, deps);
{
  const created = repo.createSession('  第一个会话  ');
  check('标题两端空白被裁掉', created.title === '第一个会话', created.title);
  check('messageCount 从 0 开始', created.messageCount === 0);

  const blank = repo.createSession('   ');
  check('空白标题回落到默认值', blank.title === 'New chat', blank.title);

  const list = repo.listSessions();
  check('列表能取回两条', list.length === 2, String(list.length));
  check('列表按 updatedAt 倒序（最近建的在前）', list[0].id === blank.id, list.map((s) => s.id).join(','));
  check('getSession 取到同一个', repo.getSession(created.id)?.title === '第一个会话');
  check('不存在的会话返回 null（不是抛错）', repo.getSession('nope') === null);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ③ 消息序号 ──');
const session = repo.createSession('序号');
{
  const seqs = [];
  for (let i = 0; i < 5; i += 1) {
    const msg = repo.insertMessage({ sessionId: session.id, role: 'user', content: `m${i}`, status: 'done', runId: null });
    seqs.push(msg.seq);
  }
  check('seq 严格递增且从 1 起', seqs.join(',') === '1,2,3,4,5', seqs.join(','));
  check('会话 messageCount 跟着涨', repo.getSession(session.id)?.messageCount === 5);

  checkThrows(
    '同一 (sessionId, seq) 插两次 → 唯一索引必须拦住',
    () => {
      const now = 1;
      opened.db
        .prepare(
          'INSERT INTO messages (messageId, sessionId, seq, role, content, status, runId, usage, error, createdAt, updatedAt) ' +
            "VALUES ('dup', ?, 1, 'user', '', 'done', NULL, NULL, NULL, ?, ?)",
        )
        .run(session.id, now, now);
    },
    'UNIQUE',
  );

  const round = repo.listMessages(session.id);
  check('读回来 5 条，顺序与写入一致', round.map((m) => m.content).join(',') === 'm0,m1,m2,m3,m4', round.map((m) => m.content).join(','));
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ④ 覆盖写与事件 ──');
{
  const msg = repo.insertMessage({ sessionId: session.id, role: 'assistant', content: '', status: 'streaming', runId: null });
  for (const text of ['第一段', '第一段第二段', '第一段第二段第三段']) {
    repo.flushMessage({
      messageId: msg.messageId,
      content: text,
      status: 'streaming',
      usage: null,
      error: null,
      events: [],
      terminal: false,
    });
  }
  const [row] = repo.listMessages(session.id).filter((m) => m.messageId === msg.messageId);
  check(
    '覆盖写：正文 = 最后一次的内容（不是三段拼接）',
    row.content === '第一段第二段第三段',
    row.content,
  );
  check('仍是流式中（脏数据可识别）', row.status === 'streaming', row.status);

  const event = {
    kind: 'tool',
    eventId: 'ev_1',
    messageId: msg.messageId,
    seq: 1,
    createdAt: 1,
    callId: 'c1',
    name: 'echo',
    argsPreview: '{"a":1}',
    resultPreview: 'ok',
    ok: true,
    ms: 12,
  };
  repo.flushMessage({
    messageId: msg.messageId,
    content: '第一段第二段第三段',
    status: 'done',
    usage: { promptTokens: 3, completionTokens: 9, totalMs: 100, mergedChunks: 2 },
    error: null,
    events: [event],
    terminal: true,
    runId: 'run_1',
  });
  // 同一事件再写一次（用量照旧传：这里验的是事件幂等，不是用量清空）
  repo.flushMessage({
    messageId: msg.messageId,
    content: '第一段第二段第三段',
    status: 'done',
    usage: { promptTokens: 3, completionTokens: 9, totalMs: 100, mergedChunks: 2 },
    error: null,
    events: [event],
    terminal: false,
  });

  const [after] = repo.listMessages(session.id).filter((m) => m.messageId === msg.messageId);
  check('事件只留一行（重放不产生重复卡片）', after.events.length === 1, String(after.events.length));
  check('事件载荷往返保真（ok 布尔没被写成 1/0）', after.events[0].ok === true);
  check('事件与消息内序一致', after.events[0].seq === 1);
  check('终态写入了用量', after.usage?.completionTokens === 9, JSON.stringify(after.usage));
  check('终态写入了 runId', after.runId === 'run_1', String(after.runId));

  const broken = opened.db.prepare('UPDATE messages SET usage = ? WHERE messageId = ?');
  broken.run('{not json', msg.messageId);
  const [degraded] = repo.listMessages(session.id).filter((m) => m.messageId === msg.messageId);
  check('用量是坏 JSON → 降级为 null，正文照常读出来', degraded.usage === null && degraded.content.length > 0);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑤ 删会话 ──');
{
  const doomeed = repo.createSession('要删的');
  const m = repo.insertMessage({ sessionId: doomeed.id, role: 'assistant', content: 'x', status: 'done', runId: null });
  repo.flushMessage({
    messageId: m.messageId,
    content: 'x',
    status: 'done',
    usage: null,
    error: null,
    events: [
      {
        kind: 'sources',
        eventId: 'ev_2',
        messageId: m.messageId,
        seq: 1,
        createdAt: 1,
        sources: ['a.md'],
      },
    ],
    terminal: true,
  });

  const before = opened.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  check('删之前事件表里有行', before > 0, String(before));

  const ok = repo.deleteSession(doomeed.id);
  check('删除返回 true', ok === true);
  check('会话没了', repo.getSession(doomeed.id) === null);
  check('消息全清', opened.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sessionId = ?').get(doomeed.id).n === 0);
  const orphans = opened.db
    .prepare(
      'SELECT COUNT(*) AS n FROM events e LEFT JOIN messages m ON m.messageId = e.messageId WHERE m.messageId IS NULL',
    )
    .get().n;
  check('事件表零孤儿（这条是反向实验的守门断言）', orphans === 0, String(orphans));
  check('删不存在的会话返回 false（不是抛错）', repo.deleteSession('nope') === false);
}

// ═════════════════════════════════════════════════════════════
console.log('\n── ⑥ 关闭后再写 ──');
{
  opened.close();
  checkThrows('关库后再写必须抛（不许静默成功）', () =>
    repo.createSession('关了还写'), undefined);
}

// ═════════════════════════════════════════════════════════════
const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✅' : '❌'} verify-session-repo：${passed}/${total} 条通过`);
if (failures.length > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
