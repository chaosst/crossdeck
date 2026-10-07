# T3 · navigate `/api/resume/chat` 真实 SSE 语料 —— 结论

> 卡：`docs/plans/2026-10-07-navigate-client-开发计划.md` §4 T3
> 取证时间：2026-10-07　环境：Windows / navigate `npm run server` @ `:3001` / guest 角色
> 录制器：`scripts/capture-navigate-sse.mjs`（零依赖，`node:http` 直连）

---

## 0. 一句话结论

**帧的"名字"和源码读出来的一致；但"是不是流式"和源码给人的印象相反 ——
`event: token` 不是逐字，它只发一帧、内容是整段最终答案，且整条响应在结束时一次性到达。**

这推翻了派工单里"只接 `/api/resume/chat` 就因为它是真逐 token 流"这条理由（§2 表格第 1 行）。
**在动手做 T4/T5 之前需要 lead 重新拍板上游策略**（见 §5）。

---

## 1. 怎么复现

```bash
# 1) 起 navigate（本机 :3001；注意 docker 引擎必须先起，它要 Postgres）
cd /d/develop/navigate && npm run server

# 2) 录语料
cd /d/develop/crossdeck && node scripts/capture-navigate-sse.mjs
# 第二批对照（验证不是"这一次碰巧"）
NAV_TAG=-run2 node scripts/capture-navigate-sse.mjs
```

⚠️ **本机 shell 里有 `HTTP_PROXY=127.0.0.1:56793`。**用 `curl` 测 `127.0.0.1:3001` 必须加
`--noproxy '*'`，否则你会收到**代理**回的 `502 upstream connect failed`，
而它看起来非常像"navigate 挂了"。录制器用 `node:http` 直连，天然不受影响。

---

## 2. 样本清单

| 文件 | 内容 |
|---|---|
| `resume-chat-plain.raw.txt` / `-run2` | 普通提问（`cookie` 传 token） |
| `resume-chat-retrieval.raw.txt` / `-run2` | 触发检索的提问（`?token=` 传 token） |
| `resume-chat-*.chunks.json` | 逐 chunk 到达时间 + 响应头 + 每 chunk 前 240 字符 |
| `resume-chat-meta.json` / `-run2` | 完整元数据：命令、帧序、负例结果 |
| `repro-comparison.json` | 两批次 4 个样本的横向对照 |
| `session-model-history.json` | 同 token 的 `/api/chat/history` 响应 |

token 一律只记前 8 位与长度，明文不入库。

---

## 3. 帧格式（字节级，T4 解析器直接照这个写）

响应头（4 条样本一致）：

```
content-type: text/event-stream
cache-control: no-cache
connection: keep-alive
x-accel-buffering: no
transfer-encoding: chunked
```

**没有 `access-control-*` 头** → 再次确认跨源 Web 壳直连不通（派工单 D3 成立）。

帧语法实测：

| 项 | 实测值 |
|---|---|
| 帧分隔符 | `\n\n`，**纯 LF，0 个 CRLF** |
| 字段名后 | 一个空格（`event: ` / `data: `） |
| 结尾 | 以 `\n\n` 结束（`...NE__\n\n`） |
| `id:` / `retry:` 字段 | **不存在** |
| 单帧内多行 `data:` | 本批未出现（但 SSD 规范允许，T4 仍要实现 `\n` 拼接） |
| `data` 载荷类型 | `token` → JSON **字符串**（`"…"`）；`sources` → JSON **数组**；`done` → **裸字面量 `__DONE__`**；`error` → JSON 字符串 |
| `token` 里的换行 | 是 JSON 转义的 `\n`（字面反斜杠+n），**不是真换行** → 不会把帧劈成两半 |

> T5 那条"别一把梭 `JSON.parse`"得到确认：`done` 的 data 是 `__DONE__`，`JSON.parse` 必抛。

**chunk 与帧的关系（重要）**：本次 4 个样本都是 `1 chunk = 1 帧`、共 3 chunk
（token / sources / done 各一）。但三者到达时间相差 **≤1ms** ——
**不能把"一 chunk 一帧"当契约**，解析器两侧都要处理：一个 chunk 含多帧、一帧跨 chunk。

---

## 4. 🔴 推翻性发现：`event: token` 不是逐字，整条流不是流式

### 证据（n=4，两个批次）

| 批次 | 场景 | 总耗时 | chunk 数 | 首字节 | 末字节 | `token` 帧数 | 帧序 |
|---|---|---|---|---|---|---|---|
| run1 | plain | 2113ms | 3 | 2113ms | 2113ms | **1** | token→sources→done |
| run1 | retrieval | 2832ms | 3 | 2832ms | 2832ms | **1** | token→sources→done |
| run2 | plain | 1645ms | 3 | 1644ms | 1645ms | **1** | token→sources→done |
| run2 | retrieval | 2470ms | 3 | 2469ms | 2469ms | **1** | token→sources→done |

- **`token` 帧恒为 1 帧**，且该帧 data 里是**整段 ~200 字的答案**（见 raw 文件第 1 帧）。
- **首字节 ≈ 末字节** → 整条流在前 1.6–2.8s **一个字节都不发**，最后一次性到达。
  客户端观感 = "转圈两秒 → 唰一下全文出现"。

### 根因（源码，已定位到行）

`src/agent/graph-agent-executor.ts:606-663`：

```
streamMode: ["updates", "messages"]           // 606-609
  ├─ messages 模式：agent 节点的 token 增量
  │    → yield { outputPreview: token }       // 625  ← 只喂 TUI 预览，**故意不进最终回答**
  └─ updates 模式：finalize / fallback 节点
       → yield { output: finalText }          // 658-661 ← 整段，**只此一次**
```

`src/server/index.ts:561-570` 的循环**只处理 `chunk.output`**：

```
if (chunk.output !== undefined && chunk.output !== null) {
  res.write(`event: token\ndata: ${JSON.stringify(text)}\n\n`);   // 567
}
```

`outputPreview`（真逐字的那一份）**被服务端丢弃**；`intermediateSteps` 只用来抽 `sources`。
⇒ **`event: token` 这个命名是误导性的：它不是 token 流，是"最终答案一次写完"。**

### 这改变了什么

| 原计划依据 | 现状 |
|---|---|
| 派工单 §2：「只接 `/api/resume/chat` —— 权限最低、**真逐 token 流**」 | ❌ **不成立**。接上去得到的是"一帧到底" |
| 派工单 §5/T6-b「严禁攒全文再一次 push」 | ⚠️ 仍然要禁（那是 core 侧纪律），但**上游本来就是一整段**，core 若不重新切分，界面不会有逐字效果 |
| 派工单 §6 验收「三端都能连真实 navigate 并**逐字显示**」 | ❌ 按现状做不到，必须二选一（见下） |
| `docs/perf.md`「流式首 token 27–28ms」 | 那条本来就是"泵的首帧延迟"；现在**更要拆**，因为上游根本没有"首 token"这个时刻 |

### 三个选项（需要 lead 拍板）

| 选项 | 做法 | 代价 | 叙事效果 |
|---|---|---|---|
| **A · 改 navigate 一行，把真 token 放出来** | `graph-agent-executor.ts` 里让 `finalize`/`fallback` 节点的 message 增量（或把 `outputPreview`）经服务端写成 `event: token`；或在服务端额外发 `event: preview`（**保留 `token` 语义不变**，向后兼容 H5） | 改的是 navigate（面试主项目），要单独提交 + 回归；约 10–20 行 | ✅ 最好：跨端项目拿到**真**逐字流 |
| **B · 客户端本地重切分** | core 保持"上游一帧 → 本地泵按 12ms/3 字符滴出"（即现状） | 0 改动 | ⚠️ 诚实但弱：得明说"逐字是本地重切分，不是上有的" |
| **C · 换端点** | 改接 `/api/rag/ask` 或 `/api/agent/plan` | `plan` 要 admin key 且 `answer` 同样非流式；`rag/ask` **不发 done** | ❌ 都不解决 |

> 我的建议：**A + B 都做**。B 是无上游时的诚实降级（现有 `ScriptedModel` 思路的延长线），
> A 才是"接真实上游"这件事的意义所在。但 A 会动 navigate，必须你同意。

---

## 5. 认证传输矩阵（实测，含反向断言）

| 传法 | 状态码 | 判定 |
|---|---|---|
| 无 token | `401` | 拒绝 |
| `Authorization: Bearer <真会话 token>` | **`401`** | **不支持 Bearer**（`getToken` 不读该头） |
| `Cookie: navigate_token=<真 token>` | `200` | ✅ 可用 |
| `?token=<真 token>`（query） | `200` | ✅ 可用 |
| `body.token`（源码支持，`express.json` 在中间件之前注册） | 未单独跑 | 源码成立 |
| 缺 `question` 字段（带真 token） | **`400`** | **鉴权已通过**，是参数错误 |

**`400` 与 `401` 的区分本身就是一条可用的负例判据** ——
以后写断言时，"有前缀就算过"那种弱断言会把这两者混为一谈。

⚠️ `getToken()` 的取值顺序是 **`?token=` → `body.token` → cookie**，
**没有 `Authorization` 分支**（`src/server/auth-helpers.ts:57-62`）。
⇒ **Electron/鸿蒙不需要伪造 cookie**，直接把会话 token 放进 body 或 query 即可；
Web 壳仍然躲不开同源（因为 `HttpOnly` cookie + 无 CORS 头）。

另：`Set-Cookie` 实测为 `navigate_token=…; Path=/; Max-Age=1800; HttpOnly; SameSite=Lax`
—— **本地无 `Secure`**，线上 `H5_COOKIE_SECURE=true` 才有。

---

## 6. 会话模型取证（派工单 §0 那条诚实边界）

`GET /api/chat/history`（同 token）→ `{ messages: [...] }`：

```
[0] user      len=15  "他最近一份工作的公司名是什么？"
[1] assistant len=273 "根据最近一份工作是：…"
```

⇒ **token 就是 sessionId**，历史在**服务端**按 token 累积，`system` 角色被过滤掉。
与 crossdeck 的 `SessionStore`（本地列表）**不是一回事**：
界面上必须标注清楚，否则 `session:delete` 会看起来"该删服务端却只删了本地"。

---

## 7. 与源码不一致的一处小契约

`sources` 的注释写"去重保序"，**实测有重复**：

| 样本 | 条目数 | 去重后 |
|---|---|---|
| plain (run1) | 11 | **9** ⚠️ |
| retrieval (run1) | 3 | 3 |

⇒ 客户端要**自己再去一次重**，别信上游已去重。

---

## 8. 未覆盖 / 未验证（别当成已验证）

1. **`event: error` 没有样本** —— 没构造出稳定触发路径。T4 仍须实现该分支。
2. **429 限流未测** —— `POST /api/login/guest` 有 IP 维度限流（`checkLoginRate`），
   但连打会锁住自己、影响后续取证，本轮刻意跳过。T10 做登录时应显式测。
3. **`resume` 索引缺失时的 503** 未复现（本机 `resume.md` / `resume.docx` 都在）。
4. **跨源行为未测**（同源下测不出来），只能靠"无 CORS 头"这个静态证据推断。
5. 本批全部是 **guest 角色 + `H5_PLAN_AGENT=on`** 的默认装配，未测 admin 角色差异。

---

## 9. 给 T4 / T5 的直接输入

**T4（解析器）必须处理的**：
- `\n\n` 分帧；**纯 LF**（顺手容忍 CRLF 即可，成本为零）
- **一个 chunk 含多帧** 与 **一帧跨 chunk** 双侧；buffer 残留不可丢
- 字段行 `event:` / `data:`；一个前导空格要剥
- 一条帧内**多行 `data:` 要按 `\n` 拼接**（本批未出现，规范允许）
- 未知 `event` 名**不得抛错**（要能容忍上游加新事件）

**T5（映射）必须处理的**：
- `done` 的 data 是**裸 `__DONE__`**，不能 `JSON.parse`
- `token` / `error` 的 data 是 JSON 字符串；`sources` 是 JSON 数组
- `sources` **可能重复**，客户端自行去重
- **`token` 帧数不保证 > 1** —— 映射层不能假设"会来很多帧"，
  更不能把 `token` 当作"上游在逐字"的证据
- 上游**不发 `tool` / `plan` 事件**（已确认），界面上工具链路那栏本期无数据
