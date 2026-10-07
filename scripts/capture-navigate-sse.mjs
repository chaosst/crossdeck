#!/usr/bin/env node
/**
 * capture-navigate-sse.mjs —— navigate `/api/resume/chat` 真实 SSE 语料录制器（T3 交付物）
 *
 * 为什么要有它：T4/T5 是 SSE 解析器与事件映射，它们的"契约"不是一份手写文档，
 * 而是**真实字节流**。手写契约会随 navigate 漂移，录下来的字节不会。
 *
 * 设计要点（每条都对应一个已知的踩坑）：
 *  1. **零依赖**，只用 `node:http`。不走 undici/fetch，因为本机 shell 里有
 *     HTTP_PROXY=127.0.0.1:56793（沙箱代理）。用 node:http 直连 127.0.0.1 可以
 *     完全绕开它 —— 否则会拿到代理回的 502，而那个 502 看起来"像是 navigate 挂了"。
 *  2. **逐 chunk 记录到达时间戳**。SSE 的价值在于"什么时候到"，不只是"到了什么"。
 *     后续 backpressure/终态断言都依赖这个顺序信息。
 *  3. **raw 文件写原始 Buffer**，不做任何整理。要的就是"原样"——
 *     一旦人肉美化，就再也无法回答"上游到底有没有发 \r\n"这类问题。
 *  4. **token 只记前 8 位 + 长度**。语料进版本库，明文 token 等于泄一个会话。
 *  5. **同时跑负例**（无 token / Bearer / 假 token）。没有负例，"能连上"可能只是因为
 *     服务没开鉴权 —— 这正是本项目其它 verify 脚本的同一套要求。
 *
 * 用法：
 *   node scripts/capture-navigate-sse.mjs
 *   NAV_BASE=http://127.0.0.1:3001 node scripts/capture-navigate-sse.mjs
 *
 * 前置：本地 navigate 已起（`cd ../navigate && npm run server`），且能访问 :3001。
 */

import http from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "docs", "evidence", "navigate-sse");
const BASE = new URL(process.env.NAV_BASE ?? "http://127.0.0.1:3001");
/**
 * 输出文件名后缀。用它跑第二轮即可得到"同形状、不同批次"的对照样本
 * —— 单批次 n=2 只能说明"这一次长这样"，两批次才能说明"它本来就这样"。
 * 例：`NAV_TAG=-run2 node scripts/capture-navigate-sse.mjs`
 */
const TAG = process.env.NAV_TAG ?? "";

mkdirSync(OUT_DIR, { recursive: true });

/** 单次请求：返回 { status, headers, chunks:[{atMs,len,text}], body:Buffer, totalMs } */
function request(pathWithQuery, { method = "POST", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const req = http.request(
      {
        host: BASE.hostname,
        port: BASE.port,
        path: pathWithQuery,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": String(payload.length) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (buf) => {
          chunks.push({ atMs: Date.now() - startedAt, len: buf.length, buf, text: buf.toString("utf8") });
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            chunks,
            body: Buffer.concat(chunks.map((c) => c.buf)),
            totalMs: Date.now() - startedAt,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(120_000, () => req.destroy(new Error("timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 从原始文本里抽出 `event:` / `data:` 帧序列（**仅用于元数据里的顺序摘要**）。
 * 注意：这是"事后解析"，raw 文件里仍然保留原始字节 —— 两者互不替代。
 * 这里刻意写得"笨"（按 \n\n 切），因为 T4 才负责处理跨 chunk 半帧；
 * 本函数拿到的是已拼好的全量文本。
 */
function summarizeFrames(rawText) {
  const frames = [];
  for (const block of rawText.split(/\n\n/)) {
    if (!block.trim()) continue;
    let event = null;
    const dataLines = [];
    for (const line of block.split(/\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    const data = dataLines.join("\n");
    frames.push({ event, data, dataLen: data.length, dataIsJsonLiteral: data !== "__DONE__" });
  }
  return frames;
}

function maskToken(t) {
  if (!t) return null;
  return { prefix8: t.slice(0, 8), length: t.length };
}

async function main() {
  const meta = {
    ranAt: new Date().toISOString(),
    baseUrl: BASE.origin,
    node: process.version,
    note:
      "本文件由 scripts/capture-navigate-sse.mjs 生成。raw 文件是原始字节，未做任何整理；" +
      "token 只记录前 8 位与长度。",
    scenarios: [],
    negativeAssertions: [],
  };

  // ── 0. 取 guest token ────────────────────────────────────────────────
  const login = await request("/api/login/guest", { body: {} });
  const loginJson = JSON.parse(login.chunks.map((c) => c.text).join(""));
  if (login.status !== 200 || !loginJson.token) {
    console.error(`[FATAL] guest 登录失败 status=${login.status} body=${JSON.stringify(loginJson)}`);
    process.exit(1);
  }
  const token = loginJson.token;
  meta.guestLogin = {
    status: login.status,
    role: loginJson.role,
    expiresIn: loginJson.expiresIn,
    setCookie: (login.headers["set-cookie"] ?? []).map((c) => c.replace(/navigate_token=[^;]+/, "navigate_token=<TOKEN>")),
    token: maskToken(token),
  };
  console.log(`[ok] guest 登录：role=${loginJson.role} token=${token.slice(0, 8)}…(${token.length})`);

  // ── 1. 负例：证明鉴权真的在生效（否则"能连上"毫无意义）─────────────
  const negative = [
    { name: "无 token", headers: {}, path: "/api/resume/chat", expect: 401 },
    { name: "Authorization: Bearer（真 token）", headers: { Authorization: `Bearer ${token}` }, path: "/api/resume/chat", expect: 401 },
    { name: "Bearer 假 token（对照）", headers: { Authorization: "Bearer sk-bogus" }, path: "/api/resume/chat", expect: 401 },
    { name: "Cookie 假 token（对照）", headers: { Cookie: "navigate_token=sk-bogus" }, path: "/api/resume/chat", expect: 401 },
    { name: "缺 question 字段（真 token）", headers: { Cookie: `navigate_token=${token}` }, path: "/api/resume/chat", expect: 400, body: { nope: 1 } },
  ];
  for (const n of negative) {
    const r = await request(n.path, { headers: n.headers, body: n.body ?? { question: "x" } });
    const pass = r.status === n.expect;
    meta.negativeAssertions.push({
      name: n.name,
      expectedStatus: n.expect,
      actualStatus: r.status,
      pass,
      body: r.chunks.map((c) => c.text).join("").slice(0, 200),
    });
    console.log(`[${pass ? "ok" : "FAIL"}] 负例「${n.name}」→ ${r.status}（期望 ${n.expect}）`);
  }

  // ── 2. 正向样本 ─────────────────────────────────────────────────────
  const scenarios = [
    {
      name: "plain",
      desc: "普通提问（预期无 sources）",
      question: "你好，请用一句话自我介绍。",
      transport: "cookie",
      curl: `curl -N --noproxy '*' -X POST -H 'Content-Type: application/json' -b "navigate_token=$TOK" -d '{"question":"…"}' ${BASE.origin}/api/resume/chat`,
    },
    {
      name: "retrieval",
      desc: "触发检索的提问（预期有 sources）",
      question: "他的工作经历有哪些？请列出公司名称和在职时间。",
      transport: "query",
      curl: `curl -N --noproxy '*' -X POST -H 'Content-Type: application/json' -d '{"question":"…"}' "${BASE.origin}/api/resume/chat?token=$TOK"`,
    },
  ];

  for (const s of scenarios) {
    const headers =
      s.transport === "cookie"
        ? { Cookie: `navigate_token=${token}` }
        : {};
    const path =
      s.transport === "query"
        ? `/api/resume/chat?token=${encodeURIComponent(token)}`
        : "/api/resume/chat";

    const r = await request(path, { headers, body: { question: s.question } });
    const rawText = r.chunks.map((c) => c.text).join("");
    const frames = summarizeFrames(rawText);

    // raw 文件直接写原始字节（不经任何编码转换），保证"原样"
    writeFileSync(join(OUT_DIR, `resume-chat-${s.name}${TAG}.raw.txt`), r.body);
    writeFileSync(
      join(OUT_DIR, `resume-chat-${s.name}${TAG}.chunks.json`),
      JSON.stringify(
        {
          scenario: s.name,
          totalMs: r.totalMs,
          status: r.status,
          headers: r.headers,
          chunkCount: r.chunks.length,
          chunks: r.chunks.map((c, i) => ({
            i,
            atMs: c.atMs,
            len: c.len,
            escaped: JSON.stringify(c.text).slice(0, 240),
          })),
        },
        null,
        2,
      ),
      "utf8",
    );

    const tokenFrameCount = frames.filter((f) => f.event === "token").length;
    const sourcesFrame = frames.find((f) => f.event === "sources");
    const answerFrame = frames.find((f) => f.event === "answer");

    // ── 流式鉴别（本录制器的核心判据）────────────────────────────────
    // ⚠️ 只断言「token 帧数 > 1」是**弱判据**：一帧整段 + 一帧空串也能凑到 2。
    // 更强的判据是**时间上的铺开**：真流式必然有「首帧到末帧」的持续时长，
    // 而一次性到达的流全挤在同一个毫秒里。两条一起断言，才既防「非流式」
    // 也防「用无意义空帧刷数量」。
    const tokenChunks = (() => {
      // 取 token 事件所属 chunk 的到达时刻（按 chunk 文本里是否出现 `event: token` 归属）
      const stamps = [];
      for (const c of r.chunks) if (c.text.includes("event: token")) stamps.push(c.atMs);
      return stamps;
    })();
    const streamSpanMs = tokenChunks.length > 1 ? tokenChunks[tokenChunks.length - 1] - tokenChunks[0] : 0;
    const isEmptyPayload = frames.some((f) => f.event === "token" && f.data === '""');
    const isEmptyOnlyPayload = frames.filter((f) => f.event === "token").every((f) => f.data === '""');

    // 增量校验：把所有 token 帧的 JSON 解码后拼接，看是否等于权威 answer
    // （两者都由 navigate 侧生成，能对齐说明"增量帧 + 权威帧"这套设计自洽）
    const tokenText = frames
      .filter((f) => f.event === "token")
      .map((f) => {
        try {
          const v = JSON.parse(f.data);
          return typeof v === "string" ? v : "";
        } catch {
          return "";
        }
      })
      .join("");
    const answerText = answerFrame ? (() => { try { return JSON.parse(answerFrame.data); } catch { return null; } })() : null;
    // 权威帧只在"增量拼接 ≠ 权威全文"时才发；没发 = 两者一致（这才是正常情况）
    const incrementalMatchesAuthoritative = answerText === null ? true : answerText === tokenText;

    meta.scenarios.push({
      name: s.name,
      desc: s.desc,
      question: s.question,
      transport: s.transport,
      reproducibleCurl: s.curl,
      status: r.status,
      totalMs: r.totalMs,
      chunkCount: r.chunks.length,
      // 帧序只记「去重后的种类顺序」，否则 300 个 token 会把 meta 撑爆
      frameOrderKinds: [...new Set(frames.map((f) => f.event))],
      frameCount: frames.length,
      tokenFrameCount,
      tokenChunkCount: tokenChunks.length,
      streamSpanMs,
      isEmptyPayload,
      isEmptyOnlyPayload,
      incrementalMatchesAuthoritative,
      hasAuthoritativeAnswer: Boolean(answerFrame),
      hasSources: Boolean(sourcesFrame),
      sourcesCount: sourcesFrame
        ? (() => {
            try {
              const parsed = JSON.parse(sourcesFrame.data);
              return Array.isArray(parsed) ? parsed.length : null;
            } catch {
              return null;
            }
          })()
        : 0,
      // 关键时序：第 1 个 token 帧何时到达（= 与 core 无关的真实上游首字延迟）
      firstTokenAtMs: (() => {
        let acc = "";
        for (const c of r.chunks) {
          acc += c.text;
          if (/event: token\n/.test(acc)) return c.atMs;
        }
        return null;
      })(),
      doneFrameAtMs: (() => {
        let acc = "";
        for (const c of r.chunks) {
          acc += c.text;
          if (/event: done\n/.test(acc)) return c.atMs;
        }
        return null;
      })(),
      rawFile: `docs/evidence/navigate-sse/resume-chat-${s.name}${TAG}.raw.txt`,
      chunksFile: `docs/evidence/navigate-sse/resume-chat-${s.name}${TAG}.chunks.json`,
    });

    console.log(
      `[ok] ${s.name}: status=${r.status} ${r.totalMs}ms chunk×${r.chunks.length} ` +
        `frames=${frames.length}（${meta.scenarios[meta.scenarios.length - 1].frameOrderKinds.join("→")}）` +
        ` token帧=${tokenFrameCount} 铺开=${streamSpanMs}ms`,
    );
  }

  writeFileSync(join(OUT_DIR, `resume-chat-meta${TAG}.json`), JSON.stringify(meta, null, 2), "utf8");
  console.log(`[done] 语料已落盘 → ${OUT_DIR}`);

  // ── 断言 1：负例 ───────────────────────────────────────────────────
  const failed = meta.negativeAssertions.filter((n) => !n.pass);
  if (failed.length > 0) {
    console.error(`[FAIL] ${failed.length} 条负例未达预期`);
    process.exit(2);
  }

  // ── 断言 2：流式判别力 ─────────────────────────────────────────────
  // 这组断言的价值在于**能反过来抓到"退回非流式"**：
  // 若有人把 generateExecutor 的 finalStreamText 改回不发（或 server 只认 output），
  // token 帧会掉到 1、铺开会变成 0ms → 这里必须挂。
  // 换掉旧口径：原来断言的是「tokenFrameCount === 1」（那时上游非流式），
  // 该断言在 rev-token-stream 之后**方向相反**，留着会误导。
  const MIN_TOKEN_FRAMES = 20; // 太低的阈值挡不住"一帧整段 + 几帧空串"
  const MIN_STREAM_SPAN_MS = 100; // 一次 LLM 输出至少持续 100ms 才叫"流"
  const streamFailures = [];
  for (const s of meta.scenarios) {
    if (s.status !== 200) {
      streamFailures.push(`${s.name}: status=${s.status}（非 200，说明 resume 索引或鉴权有问题）`);
      continue;
    }
    if (!s.firstTokenAtMs === null) streamFailures.push(`${s.name}: 没有 token 帧`);
    if (s.tokenFrameCount < MIN_TOKEN_FRAMES)
      streamFailures.push(`${s.name}: token 帧 ${s.tokenFrameCount} < ${MIN_TOKEN_FRAMES}（疑似退回非流式）`);
    if (s.streamSpanMs < MIN_STREAM_SPAN_MS)
      streamFailures.push(`${s.name}: 铺开 ${s.streamSpanMs}ms < ${MIN_STREAM_SPAN_MS}ms（疑似一次性到达）`);
    if (!s.frameOrderKinds.includes("done"))
      streamFailures.push(`${s.name}: 缺 done 帧`);
    if (s.isEmptyOnlyPayload) streamFailures.push(`${s.name}: token 帧全是空串（刷数量）`);
  }
  if (streamFailures.length > 0) {
    console.error(`[FAIL] 流式断言未通过（${streamFailures.length} 条）：`);
    for (const f of streamFailures) console.error(`  - ${f}`);
    console.error(
      `\n提示：若 navigate 侧刚改过 executor/server，检查 finalStreamText 是否仍在 yield、\n` +
        `      server 是否仍把它写成 event: token（见 rev-token-stream 提交）。`,
    );
    process.exit(3);
  }

  // ── 断言 3：增量与权威一致（自洽性）────────────────────────────────
  const mismatch = meta.scenarios.filter((s) => !s.incrementalMatchesAuthoritative);
  if (mismatch.length > 0) {
    console.error(`[FAIL] 增量拼接与权威 answer 帧不一致：${mismatch.map((s) => s.name).join(", ")}`);
    process.exit(4);
  }

  console.log(
    `[PASS] 流式判别通过：${meta.scenarios.map((s) => `${s.name}=${s.tokenFrameCount}帧/${s.streamSpanMs}ms`).join("  ")}`,
  );
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
