#!/usr/bin/env node
/**
 * T2 的验收 —— schema 常量与迁移规划。
 *
 * 两半：
 *   ① 纯逻辑：`planMigration(from, to)` 的判定表（不碰数据库）
 *   ② 真 SQLite：`node:sqlite` 内存库跑一遍，证明 SQL 合法、约束真的生效
 *
 * 为什么要真库那一半：只看长度和 includes 抓不住「table 建到错的名字上」——
 * 那种错误在 `IF NOT EXISTS` 下会静默通过（第二次建同名表直接跳过），
 * 直到第一次写数据才报 no such table。所以必须查 sqlite_master。
 *
 * 零依赖（除 node 内置）、无子进程。
 *
 * ══════════════════════════════════════════════════════════════
 * 变异测试记录（确认断言有鉴别力；每发都要求：退出码非 0 且挂 ≥1 条）
 * ══════════════════════════════════════════════════════════════
 * | ID | 改坏的点                                        | 挂掉条数 |
 * |----|-----------------------------------------------|--------|
 * | M1 | events 表名写成 messages（复制粘贴错误）              | 2      |
 * | M2 | 主键不再强制 NOT NULL                             | 1      |
 * | M3 | planMigration 去掉「不支持降级」分支                | 1      |
 * | M4 | planMigration 末尾不写 PRAGMA user_version        | 3      |
 *
 * **4 发全杀**（每发都同时满足退出码非 0 与挂 ≥1 条）。
 *
 * ⚠️ M1 第一次跑时是「uncaughtException: no such table: main.events」——
 * 表名写错导致**索引**指向不存在的表，直接崩在 `db.exec`，一条 ❌ 都没有。
 * 虽然也算"被发现"，但报告里看不出是建表的问题。所以给建表那段单独加了 try/catch：
 * 现在 M1 会明确报「建表语句能执行 —— no such table: main.events」。
 * （这就是"失败有两种形态，判定必须同时看退出码"的又一个实例。）
 *
 * ⚠️ 恢复实现后**必须重编译**再跑：只 `cp` 回源码而 dist 还是变异版本，
 * 会看到"源码已修好但断言仍失败"的假结果（本轮踩到过一次）。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// node:sqlite 会发 ExperimentalWarning —— 必须在动态 import 之前注册才拦得住
process.on('warning', (w) => {
  if (!/SQLite/i.test(w.message)) console.warn(`${w.name}: ${w.message}`);
});

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

/** 断言"必须抛错"，并校验错误信息里的关键词（防止抛错原因不对却算通过）。 */
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
  console.log(`\n${failures.length === 0 ? '✅' : '❌'} verify-core-migrate：${passed}/${total} 条通过`);
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
  console.error('\n❌ verify-core-migrate: 超过 30s 仍未结束，判定失败');
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

const { planMigration, SCHEMA_VERSION, SCHEMA_SQL, toSqlBool, fromSqlBool } = core;

for (const [name, value] of Object.entries({ planMigration, SCHEMA_SQL, toSqlBool, fromSqlBool })) {
  if (value === undefined) {
    console.error(`❌ core 没有导出 ${name} —— index.ts 的导出面写漏了`);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────
console.log('\n── ① 迁移判定表（纯逻辑）─────────────────────────');

check('SCHEMA_VERSION 是正整数', Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1, String(SCHEMA_VERSION));

const fresh = planMigration(0, SCHEMA_VERSION);
check('0 → 当前版本：产出两条（建表批 + 版本提交点）', fresh.length === 2, JSON.stringify(fresh.map((s) => s.slice(0, 24))));
check('建表批里有 sessions', fresh[0].includes('CREATE TABLE IF NOT EXISTS sessions'));
check('建表批里有 messages', fresh[0].includes('CREATE TABLE IF NOT EXISTS messages'));
check('建表批里有 events', fresh[0].includes('CREATE TABLE IF NOT EXISTS events'));
check('最后一条是版本提交点', fresh[fresh.length - 1] === `PRAGMA user_version = ${SCHEMA_VERSION}`, fresh[fresh.length - 1]);

check('新库建表与迁移用同一份 SQL（防两套真源漂移）', SCHEMA_SQL === fresh[0]);

check('同版本 → 空数组（不写版本、不建表）', planMigration(SCHEMA_VERSION, SCHEMA_VERSION).length === 0);

checkThrows('降级（1 → 0）必须抛', () => planMigration(1, 0), '不支持降级');
checkThrows('目标超过程序认识（1 → 99）必须抛', () => planMigration(1, 99), '超过');
checkThrows('库比程序新（99 → 1）必须抛', () => planMigration(99, 1), '比程序认识');
checkThrows('负数版本必须抛', () => planMigration(-1, 1), '非负整数');
checkThrows('小数版本必须抛', () => planMigration(1.5, 2), '非负整数');

// ─────────────────────────────────────────────────────────────
console.log('\n── ② 真 SQLite：建表与约束 ──────────────────────');

const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(':memory:');

// 建表这一步必须单独兜住：语句里若有索引指向不存在的表（比如表名写错），
// 会在 exec 阶段抛错，那时的失败原因比后面任何断言都更准确。
let schemaErr;
try {
  for (const stmt of planMigration(0, SCHEMA_VERSION)) db.exec(stmt);
} catch (e) {
  schemaErr = e;
}
if (schemaErr !== undefined) {
  check('建表语句能执行（索引指向不存在的表会在这里现形）', false, String(schemaErr?.message));
  finish();
}
check('建表语句能执行', true);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .map((r) => r.name);
check('sessions 表真的建出来了', tables.includes('sessions'), tables.join(','));
check('messages 表真的建出来了', tables.includes('messages'), tables.join(','));
check('events 表真的建出来了（表名写错会在这里现形）', tables.includes('events'), tables.join(','));

const indexes = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name);
check('消息的会话内唯一序索引存在', indexes.includes('ux_messages_session_seq'), indexes.join(','));
check('事件的会话内唯一序索引存在', indexes.includes('ux_events_message_seq'), indexes.join(','));
check('列表倒序索引存在', indexes.includes('idx_sessions_updated'), indexes.join(','));

check('版本号写进去了', db.prepare('PRAGMA user_version').get().user_version === SCHEMA_VERSION);

const messageColumns = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
check(
  'messages 的列与契约字段一一对应（漏字段/改列名会挂）',
  JSON.stringify(messageColumns) ===
    JSON.stringify([
      'messageId',
      'sessionId',
      'seq',
      'role',
      'content',
      'status',
      'runId',
      'usage',
      'error',
      'createdAt',
      'updatedAt',
    ]),
  messageColumns.join(','),
);

// 时间列必须是 INTEGER：存 TEXT 会让 ORDER BY 退化成字符串比较（"10" < "9"）
const messageTypes = Object.fromEntries(db.prepare('PRAGMA table_info(messages)').all().map((c) => [c.name, c.type]));
check('createdAt 是 INTEGER（TEXT 会让按时间排序失效）', messageTypes.createdAt === 'INTEGER', messageTypes.createdAt);
check('updatedAt 是 INTEGER', messageTypes.updatedAt === 'INTEGER', messageTypes.updatedAt);
check('usage 是 TEXT（JSON 文本）', messageTypes.usage === 'TEXT', messageTypes.usage);

// ─────────────────────────────────────────────────────────────
console.log('\n── ③ 负例：约束必须真的拦得住 ────────────────────');

const insertSession = db.prepare('INSERT INTO sessions (id, title, createdAt, updatedAt) VALUES (?, ?, ?, ?)');
insertSession.run('s1', '第一个会话', 1, 1);

checkThrows(
  '主键插 NULL 必须失败（SQLite 的 TEXT 主键本身允许 NULL）',
  () => insertSession.run(null, 'x', 1, 1),
  'NOT NULL',
);
checkThrows(
  '标题插 NULL 必须失败',
  () => insertSession.run('s2', null, 1, 1),
  'NOT NULL',
);

const insertMessage = db.prepare(
  'INSERT INTO messages (messageId, sessionId, seq, role, content, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
);
insertMessage.run('m1', 's1', 1, 'user', '你好', 'done', 1, 1);
checkThrows(
  '同一会话里的 seq 不许重复',
  () => insertMessage.run('m2', 's1', 1, 'assistant', '重复', 'done', 1, 1),
  'UNIQUE',
);
insertMessage.run('m2', 's1', 2, 'assistant', '第二条', 'done', 1, 1);
check('不同 seq 可以插入', db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 2);

const insertEvent = db.prepare(
  'INSERT INTO events (eventId, messageId, seq, kind, payload, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
);
insertEvent.run('e1', 'm2', 1, 'tool', '{"callId":"t1"}', 1);
checkThrows(
  '同一消息里的 seq 不许重复',
  () => insertEvent.run('e2', 'm2', 1, 'sources', '{"sources":[]}', 1),
  'UNIQUE',
);

// ─────────────────────────────────────────────────────────────
console.log('\n── ④ 布尔：node:sqlite 不接受 boolean 绑定 ────────');

const flagDb = new DatabaseSync(':memory:');
flagDb.exec('CREATE TABLE flags (v INTEGER NOT NULL)');
let boolBindErr;
try {
  flagDb.prepare('INSERT INTO flags (v) VALUES (?)').run(true);
} catch (e) {
  boolBindErr = e;
}
check('直接绑 boolean 会抛（所以必须有 toSqlBool）', boolBindErr !== undefined, String(boolBindErr?.message));

flagDb.prepare('INSERT INTO flags (v) VALUES (?)').run(toSqlBool(true));
flagDb.prepare('INSERT INTO flags (v) VALUES (?)').run(toSqlBool(false));
const flags = flagDb.prepare('SELECT v FROM flags ORDER BY rowid').all().map((r) => r.v);
check('toSqlBool(true) 存成 1、false 存成 0', flags[0] === 1 && flags[1] === 0, flags.join(','));
check('fromSqlBool 能还原', fromSqlBool(flags[0]) === true && fromSqlBool(flags[1]) === false);

// ─────────────────────────────────────────────────────────────
console.log('\n── ⑤ 可重入：同一批语句跑两遍不出错 ──────────────');

let secondRunErr;
try {
  for (const stmt of planMigration(0, SCHEMA_VERSION)) db.exec(stmt);
} catch (e) {
  secondRunErr = e;
}
check('第二遍执行不报错（崩溃后重跑必须安全）', secondRunErr === undefined, String(secondRunErr?.message));
check('第二遍之后数据仍在（没有被建表语句清掉）', db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 2);

db.close();
flagDb.close();
finish();
