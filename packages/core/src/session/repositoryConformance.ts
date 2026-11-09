/**
 * 仓储端口的**可执行规格** —— 同一份用例，跑在两种后端上。
 *
 * 「一份 SQL、一份对象仓库」如果只是嘴上说，那它只是一句话：两个实现各自
 * 长成什么样，没有任何东西会发现。所以把不变式写成代码，Electron 壳在
 * Node 里对真 SQLite 跑一遍，Web 壳在真浏览器里对真 IndexedDB 跑一遍 ——
 * 通过的用例集合一致，才叫"同一套语义"。
 *
 * 这里**不碰 IO**：库从 harness 拿，时钟从 harness 推进。core 依旧零平台依赖。
 *
 * ⚠️ 用例只断言**端口语义**，不断言实现细节（表名、索引名、事务隔离级别）。
 *    凡是"只有一种后端做得到"的东西都不该进来 —— 那会把 SQL 的形状
 *    偷偷变成端口的形状。
 *
 * ⚠️ 端口**看不见**的东西，这里一概验不到，必须由各壳自己的实现断言兜住：
 *    · 孤儿行（删会话时漏删了事件 —— 消息没了，那些事件就再没人引用，读路径也读不到）
 *    · 索引/表建没建、迁移版本号、坏数据怎么降级
 *    Electron 侧这些在 `scripts/verify-session-repo.mjs`，不要去这里补 ——
 *    补进来的话，用例就不再是"两个后端共有的语义"了。
 */

import type {
  SessionActionEvent,
  SessionEvent,
  SessionMessageDetail,
  SessionSourcesEvent,
  SessionToolEvent,
} from '@crossdeck/contract';
import type { Awaitable, SessionRepository } from './repository.js';

export interface SessionRepositoryHarness {
  /** 进失败消息的前缀（`sqlite` / `indexeddb`），跨后端时能分辨谁挂了。 */
  readonly label: string;
  /** 造一个**空**仓储。时钟由 harness 持有，`advance` 影响之后所有仓储。 */
  create(): Awaitable<SessionRepository>;
  /** 把注入的时钟往前推。 */
  advance(ms: number): void;
  /** 同一个库再开一次 —— 有它才谈得上"持久化"。 */
  reopen?(): Awaitable<SessionRepository>;
  /** 清理（删库 / 关连接）。 */
  dispose?(): Awaitable<void>;
}

/** 断言失败的最小形态：一条消息，不引异常类。 */
class ConformanceError extends Error {}

function ok(cond: boolean, message: string): void {
  if (!cond) throw new ConformanceError(message);
}

function eq<T>(actual: T, expected: T, what: string): void {
  if (actual !== expected) {
    throw new ConformanceError(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

/** 取第 n 项，缺了直接判失败 —— `noUncheckedIndexedAccess` 下这样最省事。 */
function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) {
    throw new ConformanceError(`期望至少有 ${index + 1} 项，实际只有 ${list.length} 项`);
  }
  return value;
}

async function expectThrows(what: string, run: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await run();
  } catch {
    threw = true;
  }
  if (!threw) throw new ConformanceError(`${what} —— 没有抛错（静默成功比报错更难查）`);
}

function toolEvent(messageId: string, seq: number, eventId: string): SessionEvent {
  return {
    kind: 'tool',
    eventId,
    messageId,
    seq,
    createdAt: 1,
    callId: 'c1',
    name: 'echo',
    argsPreview: '{"a":1}',
    resultPreview: 'ok',
    ok: true,
    ms: 12,
  };
}

function actionEvent(messageId: string, seq: number, eventId: string): SessionEvent {
  return { kind: 'action', eventId, messageId, seq, createdAt: 1, actionId: 'a1', label: '查看简历原文', url: 'http://x/resume' };
}

function sourcesEvent(messageId: string, seq: number, eventId: string): SessionEvent {
  return { kind: 'sources', eventId, messageId, seq, createdAt: 1, sources: ['a.md', 'b.md'] };
}

/** 一条已进终态的消息的完整写入，用例里反复要。 */
async function writeAssistant(
  repo: SessionRepository,
  sessionId: string,
  content: string,
  events: (messageId: string) => SessionEvent[],
  usage: { promptTokens: number; completionTokens: number; totalMs: number; mergedChunks: number } | null = null,
): Promise<SessionMessageDetail> {
  const msg = await repo.insertMessage({ sessionId, role: 'assistant', content: '', status: 'streaming', runId: null });
  await repo.flushMessage({
    messageId: msg.messageId,
    content,
    status: 'done',
    usage,
    error: null,
    events: events(msg.messageId),
    terminal: true,
  });
  const all = await repo.listMessages(sessionId);
  const found = all.find((m) => m.messageId === msg.messageId);
  if (found === undefined) throw new ConformanceError('写完立刻读不回来');
  return found;
}

/** 用例能拿到的上下文：只有时钟推进，够用且不泄漏 harness 的其它能力。 */
interface CaseContext {
  advance(ms: number): void;
}

interface Case {
  readonly name: string;
  run(repo: SessionRepository, ctx: CaseContext): Promise<void>;
}

const CASES: readonly Case[] = [
  {
    name: '空库：listSessions 是空数组，getSession 未知 id 返回 null',
    async run(repo) {
      eq((await repo.listSessions()).length, 0, '空库列表长度');
      eq(await repo.getSession('nope'), null, '未知会话');
    },
  },
  {
    name: 'createSession：标题两端空白被裁掉，messageCount 从 0 起',
    async run(repo) {
      const s = await repo.createSession('  第一个会话  ');
      eq(s.title, '第一个会话', '标题');
      eq(s.messageCount, 0, 'messageCount');
      ok(s.id.length > 0, 'id 不能是空串');
    },
  },
  {
    name: 'createSession：空白标题与不传标题都落到同一个默认值',
    async run(repo) {
      const blank = await repo.createSession('   ');
      const missing = await repo.createSession();
      eq(blank.title, 'New chat', '空白标题');
      eq(missing.title, 'New chat', '不传标题');
    },
  },
  {
    name: 'createSession：超长标题截断到 64 字符（不是原样存进去）',
    async run(repo) {
      const s = await repo.createSession('x'.repeat(200));
      eq(s.title.length, 64, '标题长度');
    },
  },
  {
    name: 'listSessions：按 updatedAt 倒序',
    async run(repo, ctx) {
      const first = await repo.createSession('先建的');
      ctx.advance(1);
      const second = await repo.createSession('后建的');
      const list = await repo.listSessions();
      eq(list.length, 2, '条数');
      eq(at(list, 0).id, second.id, '第一条应是最新');
      eq(at(list, 1).id, first.id, '第二条应是更早的');
    },
  },
  {
    name: 'insertMessage：seq 在会话内从 1 起严格递增',
    async run(repo) {
      const s = await repo.createSession('序号');
      const seqs: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const m = await repo.insertMessage({
          sessionId: s.id,
          role: i % 2 === 0 ? 'user' : 'assistant',
          content: `m${i}`,
          status: 'done',
          runId: null,
        });
        seqs.push(m.seq);
      }
      eq(seqs.join(','), '1,2,3,4,5', 'seq 序列');
    },
  },
  {
    name: 'insertMessage：到不存在的会话必须抛错',
    async run(repo) {
      await expectThrows('往不存在的会话里写消息', () =>
        Promise.resolve(
          repo.insertMessage({ sessionId: 'ghost', role: 'user', content: 'x', status: 'done', runId: null }),
        ),
      );
      // 抛完还得能继续用：一个字都不许落盘，也不许把仓储弄成半死状态
      const s = await repo.createSession('抛错之后');
      const m = await repo.insertMessage({ sessionId: s.id, role: 'user', content: 'y', status: 'done', runId: null });
      eq(m.seq, 1, '抛错之后新会话的 seq');
    },
  },
  {
    name: 'insertMessage：推进 messageCount 与 updatedAt',
    async run(repo, ctx) {
      const s = await repo.createSession('计数');
      const before = await repo.getSession(s.id);
      if (before === null) throw new ConformanceError('刚建的会话查不到');
      ctx.advance(1);
      await repo.insertMessage({ sessionId: s.id, role: 'user', content: 'x', status: 'done', runId: null });
      const after = await repo.getSession(s.id);
      if (after === null) throw new ConformanceError('写入后会话查不到');
      eq(after.messageCount, 1, 'messageCount');
      ok(after.updatedAt > before.updatedAt, 'updatedAt 必须前进');
    },
  },
  {
    name: 'flushMessage：覆盖写（写三次只会得到最后一次的内容）',
    async run(repo) {
      const s = await repo.createSession('覆盖');
      const m = await repo.insertMessage({
        sessionId: s.id,
        role: 'assistant',
        content: '',
        status: 'streaming',
        runId: null,
      });
      for (const text of ['第一段', '第一段第二段', '第一段第二段第三段']) {
        await repo.flushMessage({
          messageId: m.messageId,
          content: text,
          status: 'streaming',
          usage: null,
          error: null,
          events: [],
          terminal: false,
        });
      }
      const row = at(await repo.listMessages(s.id), 0);
      eq(row.content, '第一段第二段第三段', '正文');
      eq(row.status, 'streaming', '状态（脏数据要能被识别出来）');
    },
  },
  {
    name: 'flushMessage：重放同一批事件不产生重复',
    async run(repo) {
      const s = await repo.createSession('幂等');
      const msg = await repo.insertMessage({
        sessionId: s.id,
        role: 'assistant',
        content: '',
        status: 'streaming',
        runId: null,
      });
      const ev = toolEvent(msg.messageId, 1, 'ev_dup');
      for (let i = 0; i < 3; i += 1) {
        await repo.flushMessage({
          messageId: msg.messageId,
          content: 'x',
          status: 'done',
          usage: null,
          error: null,
          events: [ev],
          terminal: i === 0,
        });
      }
      const row = at(await repo.listMessages(s.id), 0);
      eq(row.events.length, 1, '事件条数');
      eq(at(row.events, 0).eventId, 'ev_dup', '留下来的那条');
    },
  },
  {
    name: 'flushMessage：到不存在的消息必须抛错',
    async run(repo) {
      await expectThrows('覆盖写一条不存在的消息', () =>
        Promise.resolve(
          repo.flushMessage({
            messageId: 'ghost',
            content: 'x',
            status: 'done',
            usage: null,
            error: null,
            events: [],
            terminal: false,
          }),
        ),
      );
    },
  },
  {
    name: 'listMessages：一次取全，消息按 seq，事件挂在各自的消息下',
    async run(repo) {
      const s = await repo.createSession('分组');
      await repo.insertMessage({ sessionId: s.id, role: 'user', content: '问', status: 'done', runId: null });
      const a = await repo.insertMessage({
        sessionId: s.id,
        role: 'assistant',
        content: '',
        status: 'streaming',
        runId: null,
      });
      await repo.flushMessage({
        messageId: a.messageId,
        content: '答',
        status: 'done',
        usage: null,
        error: null,
        events: [toolEvent(a.messageId, 1, 'ev_a1'), sourcesEvent(a.messageId, 2, 'ev_a2')],
        terminal: true,
      });
      const b = await repo.insertMessage({
        sessionId: s.id,
        role: 'assistant',
        content: '',
        status: 'streaming',
        runId: null,
      });
      await repo.flushMessage({
        messageId: b.messageId,
        content: '再答',
        status: 'done',
        usage: null,
        error: null,
        events: [actionEvent(b.messageId, 1, 'ev_b1')],
        terminal: true,
      });

      const rows = await repo.listMessages(s.id);
      eq(rows.map((r) => r.content).join('|'), '问|答|再答', '消息顺序');
      eq(rows.map((r) => r.seq).join(','), '1,2,3', '消息 seq');
      eq(at(rows, 1).events.length, 2, '第二条消息的事件数');
      eq(at(rows, 2).events.length, 1, '第三条消息的事件数');
      ok(
        at(rows, 2).events.every((e) => e.messageId === b.messageId),
        '事件不能串到别的消息下',
      );
    },
  },
  {
    name: 'listMessages：未知会话返回空数组（不是抛错）',
    async run(repo) {
      eq((await repo.listMessages('ghost')).length, 0, '未知会话');
    },
  },
  {
    name: '事件三种 kind 都能原样往返（含布尔与数组）',
    async run(repo) {
      const s = await repo.createSession('事件往返');
      const row = await writeAssistant(repo, s.id, '正文', (messageId) => [
        toolEvent(messageId, 1, 'ev_t'),
        actionEvent(messageId, 2, 'ev_a'),
        sourcesEvent(messageId, 3, 'ev_s'),
      ]);
      const tool = row.events.find((e): e is SessionToolEvent => e.kind === 'tool');
      const action = row.events.find((e): e is SessionActionEvent => e.kind === 'action');
      const sources = row.events.find((e): e is SessionSourcesEvent => e.kind === 'sources');
      if (tool === undefined || action === undefined || sources === undefined) {
        throw new ConformanceError(`三种事件没都读回来：${row.events.map((e) => e.kind).join(',')}`);
      }
      ok(tool.ok === true, 'tool.ok 必须还是布尔 true（不能被写成 1）');
      eq(tool.ms, 12, 'tool.ms');
      eq(action.url, 'http://x/resume', 'action.url');
      eq(sources.sources.join(','), 'a.md,b.md', 'sources 数组');
    },
  },
  {
    name: 'terminal 的 flush 推进会话 updatedAt，非 terminal 不推进',
    async run(repo, ctx) {
      const s = await repo.createSession('终态时间');
      const m = await repo.insertMessage({
        sessionId: s.id,
        role: 'assistant',
        content: '',
        status: 'streaming',
        runId: null,
      });
      const base = await repo.getSession(s.id);
      if (base === null) throw new ConformanceError('会话查不到');
      ctx.advance(1);
      await repo.flushMessage({
        messageId: m.messageId,
        content: 'a',
        status: 'streaming',
        usage: null,
        error: null,
        events: [],
        terminal: false,
      });
      const mid = await repo.getSession(s.id);
      if (mid === null) throw new ConformanceError('会话查不到');
      eq(mid.updatedAt, base.updatedAt, '非终态不该动 updatedAt');

      ctx.advance(1);
      await repo.flushMessage({
        messageId: m.messageId,
        content: 'ab',
        status: 'done',
        usage: null,
        error: null,
        events: [],
        terminal: true,
      });
      const end = await repo.getSession(s.id);
      if (end === null) throw new ConformanceError('会话查不到');
      ok(end.updatedAt > mid.updatedAt, '终态必须推进 updatedAt');
    },
  },
  {
    name: 'usage：null 与有值都能往返',
    async run(repo) {
      const s = await repo.createSession('用量');
      const withUsage = await writeAssistant(repo, s.id, 'a', () => [], {
        promptTokens: 3,
        completionTokens: 9,
        totalMs: 100,
        mergedChunks: 2,
      });
      const withoutUsage = await writeAssistant(repo, s.id, 'b', () => [], null);
      eq(withUsage.usage?.completionTokens, 9, '有值的那条');
      eq(withoutUsage.usage, null, 'null 的那条');
    },
  },
  {
    name: 'runId：首个 flush 补上，之后没传也不许被清空',
    async run(repo) {
      const s = await repo.createSession('runId');
      const m = await repo.insertMessage({
        sessionId: s.id,
        role: 'assistant',
        content: '',
        status: 'streaming',
        runId: null,
      });
      await repo.flushMessage({
        messageId: m.messageId,
        content: 'a',
        status: 'streaming',
        usage: null,
        error: null,
        events: [],
        terminal: false,
        runId: 'run_1',
      });
      // 后续几拍不带 runId（主进程的写入路径就是这样：只有第一拍知道 runId）
      await repo.flushMessage({
        messageId: m.messageId,
        content: 'ab',
        status: 'done',
        usage: null,
        error: null,
        events: [],
        terminal: true,
      });
      const row = at(await repo.listMessages(s.id), 0);
      eq(row.runId, 'run_1', 'runId 被后来的 flush 清掉了');
    },
  },
  {
    name: 'deleteSession：连带清掉消息与事件，之后再读是空的',
    async run(repo) {
      const keep = await repo.createSession('留着');
      await repo.insertMessage({ sessionId: keep.id, role: 'user', content: 'k', status: 'done', runId: null });

      const doomed = await repo.createSession('要删的');
      await writeAssistant(repo, doomed.id, 'x', (messageId) => [sourcesEvent(messageId, 1, 'ev_gone')]);

      eq(await repo.deleteSession(doomed.id), true, '删除返回值');
      eq(await repo.getSession(doomed.id), null, '会话还在');
      eq((await repo.listMessages(doomed.id)).length, 0, '删后还能读到消息');

      // 另一条会话必须毫发无伤 —— "删干净"最容易顺手删过头
      const survivors = await repo.listMessages(keep.id);
      eq(survivors.length, 1, '剩下那条会话的消息数');
    },
  },
  {
    name: 'deleteSession：不存在的会话返回 false（幂等删除不炸）',
    async run(repo) {
      eq(await repo.deleteSession('ghost'), false, '返回值');
    },
  },
  {
    name: '跨会话隔离：A 的消息不会出现在 B 的列表里',
    async run(repo) {
      const a = await repo.createSession('A');
      const b = await repo.createSession('B');
      await repo.insertMessage({ sessionId: a.id, role: 'user', content: 'A 的话', status: 'done', runId: null });
      await repo.insertMessage({ sessionId: b.id, role: 'user', content: 'B 的话', status: 'done', runId: null });
      const rowsA = await repo.listMessages(a.id);
      const rowsB = await repo.listMessages(b.id);
      eq(rowsA.length, 1, 'A 的条数');
      eq(at(rowsA, 0).content, 'A 的话', 'A 的内容');
      eq(at(rowsB, 0).content, 'B 的话', 'B 的内容');
    },
  },
  {
    name: '同一会话的 seq 不会因为别的会话插了消息而跳号',
    async run(repo) {
      const a = await repo.createSession('A');
      const b = await repo.createSession('B');
      const a1 = await repo.insertMessage({ sessionId: a.id, role: 'user', content: 'a1', status: 'done', runId: null });
      for (let i = 0; i < 3; i += 1) {
        await repo.insertMessage({ sessionId: b.id, role: 'user', content: `b${i}`, status: 'done', runId: null });
      }
      const a2 = await repo.insertMessage({ sessionId: a.id, role: 'user', content: 'a2', status: 'done', runId: null });
      eq(a1.seq, 1, 'a1.seq');
      eq(a2.seq, 2, 'a2.seq（不该被 B 的三条挤到 5）');
    },
  },
];

export interface ConformanceResult {
  readonly total: number;
  readonly passed: number;
  /** 每条都带用例名，空数组 = 全部通过。 */
  readonly failures: readonly string[];
  /** 跳过的用例名（harness 没提供能力时）。 */
  readonly skipped: readonly string[];
}

/**
 * 必备用例数（**不含**可选的"持久化"那条）。
 *
 * 三端的报告拿它对账：用例集被删空时"全过"会退化成一句空话，而这个数字
 * 是从 CASES 长度算出来的 —— 删用例的人必须先改这里，改不动就说明规格还在。
 */
export const CONFORMANCE_CASE_COUNT = CASES.length;

/** 跑全套。内部串行 —— 用例之间有共享的时钟，并发跑会互相干扰。 */
export async function checkSessionRepository(harness: SessionRepositoryHarness): Promise<ConformanceResult> {
  const failures: string[] = [];
  const skipped: string[] = [];
  let passed = 0;

  const cases: Case[] = [...CASES];
  const reopenCase: Case = {
    name: '持久化：同一个库再开一次，数据还在（这是"存住了"的唯一证据）',
    async run(repo) {
      const s = await repo.createSession('要活过重启的');
      await writeAssistant(repo, s.id, '重启前的正文', (messageId) => [sourcesEvent(messageId, 1, 'ev_keep')]);
      if (harness.reopen === undefined) throw new ConformanceError('harness 没有提供 reopen');

      // ⚠️ 必须留在 harness 上调用。把方法摘下来直接 `reopen()` 会丢 `this`：
      // 闭包式 harness 侥幸能过，class 式 harness 直接崩 —— 鸿蒙那份就是这么揪出来的。
      const again = await harness.reopen();
      const sessions = await again.listSessions();
      eq(sessions.length, 1, '重开后的会话数');
      eq(at(sessions, 0).title, '要活过重启的', '标题');
      const rows = await again.listMessages(s.id);
      eq(rows.length, 1, '重开后的消息数');
      eq(at(rows, 0).content, '重启前的正文', '正文');
      eq(at(rows, 0).events.length, 1, '重开后的事件数');
    },
  };
  if (harness.reopen === undefined) skipped.push(reopenCase.name);
  else cases.push(reopenCase);

  for (const item of cases) {
    try {
      const repo = await harness.create();
      await item.run(repo, { advance: (ms) => harness.advance(ms) });
      passed += 1;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      failures.push(`[${harness.label}] ${item.name} —— ${detail}`);
    }
  }

  try {
    await harness.dispose?.();
  } catch {
    // 清理失败不该改变判定；库是临时的，进程退出时自然没了
  }

  return { total: cases.length, passed, failures, skipped };
}
