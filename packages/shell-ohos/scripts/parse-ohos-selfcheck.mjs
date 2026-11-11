/**
 * 鸿蒙自检报告的**解析 + 判定**（纯函数，零依赖）。
 *
 * ## 为什么单独一个文件（而不是内联在 verify-ohos.mjs 里）
 *
 * 判定层是这张卡的核心价值，但它被夹在 `verify-ohos.mjs` 的第 ⑩ 步里 ——
 * 而那一步在**没有真机**的时候一行都走不到（脚本卡在 ② 的设备探测）。
 * 留成内联代码，「判定表到底有没有鉴别力」就只剩肉眼保证这一条路。
 *
 * 抽成纯函数之后，手工链路可以用**合成行**驱动它做变异测试（见 `verify-ohos.mjs`
 * 头部「鉴别力」一节）：把期望表改坏一条，判定必须挂 —— 挂不出来就说明
 * 那一条是装饰。同一个理由，见 `shared/fake-navigate-upstream.mjs` 的说明。
 *
 * ⚠️ 这里刻意**不做**任何 IO：输入是应用打印的原始字符串行，输出是待 record 的
 *    判定表。谁去打日志、谁去退非零退出码，是调用方的事。
 */

/**
 * 解析 `[SELFCHECK]` 前缀行。
 *
 * 应用侧的格式（`Index.ets` 的 `runSelfCheck`）：
 *   `run <key> terminal=<t> count=<n> code=<c> text=<n> frames=<n> [error=…] [msg=…]`
 *   `peer clientGone=… doneSent=… logins=…`
 *   `DONE runs=<n>`
 *
 * ⚠️ **`text=` / `frames=` 必须是可选的。** 应用给 `unknown` 那行**不打**这两个
 *    字段（它没有正文、也不算"帧"）—— 第一版把它们写成必需，于是 `unknown`
 *    永远解析不出来，反向断言变成**恒红**：真机上"跑对了"也会报失败。
 *    这个坑是 `_tmp_*` 里的合成行 harness 抓到的（真机那时还够不着），
 *    也正是"判定层抽成纯函数"的收益。
 */
export function parseSelfcheck(lines) {
  const runs = new Map();
  let peer = null;
  let done = null;
  for (const raw of lines) {
    const line = raw.replace(/^\[SELFCHECK\]\s*/, '');
    if (line.startsWith('run ')) {
      const m =
        /^run (\S+) terminal=(\S+) count=(\d+) code=(\S+)(?: text=(\d+))?(?: frames=(\d+))?(?: error=(.*?))?(?: msg=(.*))?$/.exec(
          line,
        );
      if (m !== null) {
        runs.set(m[1], {
          terminal: m[2],
          count: Number(m[3]),
          code: m[4],
          text: Number(m[5] ?? 0),
          frames: Number(m[6] ?? 0),
          error: m[7] ?? '',
          msg: m[8] ?? '',
        });
      }
    } else if (line.startsWith('peer ')) {
      peer = line.slice(5);
    } else if (line.startsWith('DONE ')) {
      done = line.slice(5);
    }
  }
  return { runs, peer, done };
}

/**
 * 期望表 —— 与 Electron / Web 两侧同一口径。
 *
 * `msgHas` **不是装饰**：两条断流路径（干净 EOF / socket 被销毁）**必须**能被区分。
 * 只比错误码的话，把它们合成一条也照样绿 —— 而合成会漏掉一条路径的失败模式。
 * 这一条是实测发现的：把 `killed` 场景改成干净 EOF，只断"都是 error/UPSTREAM"
 * 仍然全绿（变异存活），加了措辞断言才杀掉。
 */
const EXPECT = [
  { key: 'normal', terminal: 'done', code: '-', minFrames: 2, msgHas: null, textEq: true },
  { key: 'silent-close', terminal: 'error', code: 'UPSTREAM', minFrames: 1, msgHas: '没收到 done 帧', textEq: false },
  // killed = 连接层失败（socket 被销毁），措辞与"干净 EOF"必须可区分：
  // 一个是"没收到 done 帧"（流被截断），一个是"上游请求失败"（连接层抛错）。
  { key: 'killed', terminal: 'error', code: 'UPSTREAM', minFrames: 1, msgHas: '上游请求失败', textEq: false },
  { key: 'upstream-error', terminal: 'error', code: 'UPSTREAM', minFrames: 1, msgHas: '上游报错', textEq: false },
  { key: 'abort', terminal: 'error', code: 'ABORTED', minFrames: 1, msgHas: null, textEq: false },
];

/**
 * 判定。`expectedText` = normal 场景应当逐字收到的完整正文（由调用方从
 * 共享假上游的 `NAV_NORMAL_CHUNKS` 取，不在这里另抄一份）。
 *
 * @returns {{ verdicts: {name:string, ok:boolean, detail:string}[], peer: string, parsed: object }}
 */
export function judgeSelfcheck(lines, expectedText) {
  const parsed = parseSelfcheck(lines);
  const verdicts = [];
  const push = (name, ok, detail) => verdicts.push({ name, ok, detail });

  if (parsed.done === null) {
    push('自检跑完', false, '没看到 DONE 行（界面没刷出来，或判定卡住了）');
  } else {
    push('自检跑完', true, parsed.done);
  }

  for (const want of EXPECT) {
    const r = parsed.runs.get(want.key);
    if (r === undefined) {
      push(`场景 ${want.key}`, false, '报告里没有这一行 —— 判定没跑到它');
      continue;
    }
    // "恰好一个终态"。第二个终态没人听的话这条断言会恒真，所以应用侧刻意留了收尾窗口。
    push(`场景 ${want.key} · 恰好一个终态`, r.count === 1, `count=${r.count} terminal=${r.terminal}`);
    push(
      `场景 ${want.key} · 终态与错误码`,
      r.terminal === want.terminal && r.code === want.code,
      `${r.terminal}/${r.code}（期望 ${want.terminal}/${want.code}）`,
    );
    push(`场景 ${want.key} · 逐帧`, r.frames >= want.minFrames, `frames=${r.frames}`);
    if (want.msgHas !== null) {
      push(`场景 ${want.key} · 措辞`, r.msg.includes(want.msgHas), JSON.stringify(r.msg).slice(0, 140));
    }
    if (want.textEq) {
      push(`场景 ${want.key} · 正文长度`, r.text === expectedText.length, `${r.text}（期望 ${expectedText.length}）`);
    }
    // 应用侧把异常也打出来（而不是吞掉）：有异常就是失败，别让它藏在 detail 里。
    if (r.error.length > 0) push(`场景 ${want.key} · 无异常`, false, r.error);
  }

  // 反向：不认识的场景必须被上游拒掉 —— 它同时证明前面那些是**被词表认出来**的，
  // 而不是"假上游对什么 prompt 都吐同一套"。
  const unknown = parsed.runs.get('unknown');
  push(
    '反向 · 不认识场景被拒（HTTP 400）',
    unknown !== undefined && unknown.terminal === 'error' && unknown.msg.includes('HTTP 400'),
    unknown === undefined ? '没有 unknown 那一行' : `${unknown.terminal} ${JSON.stringify(unknown.msg).slice(0, 140)}`,
  );

  // 对端观察 —— "停止真的断了连接"唯一能拿到证据的地方。
  // 客户端自己说"我 abort 了"不算，得看**上游**有没有看见连接被关。
  const peer = parsed.peer ?? '';
  push('对端 · 看见了 abort 断连', /clientGone=[^\s]*abort/.test(peer), peer || '没有 peer 行');
  const badDone = /doneSent=[^\s]*silent-close/.test(peer) || /doneSent=[^\s]*killed/.test(peer);
  push('对端 · 截断场景没发 done', !badDone, peer);

  return { verdicts, peer, parsed };
}

// ─────────────────────────────────────────────────────────────
// 会话仓储一致性（同一份 core 用例跑在 relationalStore 上）
//
// 应用侧格式（`Index.ets` 的 `runRepoCheck`）：
//   `repo total=<n> passed=<n> failed=<n> skipped=<n>`
//   `repoFail <用例名> —— <detail>`（每条失败一行）
//   `repoError <异常>`（整个 harness 崩了才会有，此时连汇总行都没有）
// ─────────────────────────────────────────────────────────────

/** 解析仓储一致性报告。返回 `{ summary, failures, errors }`，summary 缺失 = 没跑起来。 */
export function parseRepoReport(lines) {
  let summary = null;
  const failures = [];
  const errors = [];
  for (const raw of lines) {
    const line = String(raw).replace(/^\[SELFCHECK\]\s*/, '');
    if (line.startsWith('repo ')) {
      const m = /^repo total=(\d+) passed=(\d+) failed=(\d+) skipped=(\d+)$/.exec(line);
      if (m !== null) {
        summary = {
          total: Number(m[1]),
          passed: Number(m[2]),
          failed: Number(m[3]),
          skipped: Number(m[4]),
        };
      }
    } else if (line.startsWith('repoFail ')) {
      failures.push(line.slice('repoFail '.length));
    } else if (line.startsWith('repoError ')) {
      errors.push(line.slice('repoError '.length));
    }
  }
  return { summary, failures, errors };
}

/**
 * 判定。
 *
 * `minCases` 必须由调用方从 core 的 `CONFORMANCE_CASE_COUNT` 取 —— 在这里写死一个
 * 数字，加用例时它不会跟着长，而"用例被删空还全绿"正是这张卡要防的事。
 */
export function judgeRepo(lines, minCases) {
  const verdicts = [];
  const push = (name, ok, detail) => verdicts.push({ name, ok, detail });
  const report = parseRepoReport(lines);
  const s = report.summary;

  if (s === null) {
    push('仓储 · 报告存在', false, '没有 repo 汇总行 —— 用例没跑起来，或整体崩了');
    return { verdicts, parsed: report };
  }

  push('仓储 · 报告存在', true, `total=${s.total} passed=${s.passed}`);
  push('仓储 · 用例数没被删空', s.total >= minCases, `total=${s.total}（至少 ${minCases}）`);
  push('仓储 · 全过', s.passed === s.total && s.failed === 0, `passed=${s.passed}/${s.total} failed=${s.failed}`);
  push(
    '仓储 · 失败行如实列出',
    report.failures.length === s.failed,
    `列出 ${report.failures.length} 行，计数 ${s.failed}`,
  );
  push('仓储 · 没有跳过的用例', s.skipped === 0, `skipped=${s.skipped}`);
  push('仓储 · 无异常', report.errors.length === 0, report.errors.join(' | ') || '—');

  return { verdicts, parsed: report };
}

// ─────────────────────────────────────────────────────────────
// 页面内自检报告（P3：界面搬进 ArkWeb 之后的主判定）
//
// 为什么另起一套：`dumpLayout` 在 ArkWeb 里只能看到**一个 Web 节点**，
// 点不到 DOM 子控件 —— 点击与断言都必须在页面里做（`@crossdeck/ui` 的 `runUiProbe`）。
// 应用侧于是只负责把结果**原样**打出来，判定仍在这里：
//   `[SELFCHECKPAGE] <i>/<n> <chunk>`   ← `AppHost.report()` 按 700 字符分片
//   `[selfcheck] DONE ok=<b> code=<n>`  ← 页面哨兵行（经 onConsole 进 hilog）
//
// ⚠️ 分片必须带序号：hilog 对单条有长度上限，超长会被截断；按序号拼回原文，
//    截断就会表现为「拼不齐 → 判红」，而不是「JSON 恰好还能解析 → 假绿」。
// ─────────────────────────────────────────────────────────────

/** 页面报告里**必须出现**的断言键 —— 少一个就说明驱动器根本没走到那一步。 */
const UI_REQUIRED_PROBES = [
  'uiLoginGate',
  'uiBootState',
  'uiLoginPersisted',
  'uiSessionCount',
  'uiSessionDelete',
  'uiSessionRecreated',
  'uiStream',
  'uiTabSwitch',
  'uiEntryCount',
  'uiEscapeMessage',
  'uiUpload',
];

/**
 * 把 `[SELFCHECKPAGE] i/n` 分片拼回 JSON 文本。
 * 返回 `{ text, chunks, total, complete, error }`。
 */
export function parsePageChunks(lines) {
  const parts = new Map();
  let total = 0;
  for (const raw of lines) {
    const line = String(raw);
    const at = line.indexOf('[SELFCHECKPAGE]');
    if (at < 0) continue;
    const m = /^\[SELFCHECKPAGE\]\s*(\d+)\/(\d+)\s([\s\S]*)$/.exec(line.slice(at));
    if (m === null) continue;
    const idx = Number(m[1]);
    total = Number(m[2]);
    // 同一序号可能被重复打印（hilog 缓冲区里有旧行）—— 以第一份为准。
    if (!parts.has(idx)) parts.set(idx, m[3]);
  }
  const chunks = [...parts.entries()].sort((a, b) => a[0] - b[0]);
  const missing = [];
  for (let i = 1; i <= total; i += 1) if (!parts.has(i)) missing.push(i);
  const text = chunks.map(([, v]) => v).join('');
  if (total === 0) return { text: '', chunks: 0, total: 0, complete: false, error: '没有 SELFCHECKPAGE 分片' };
  if (missing.length > 0) {
    return { text, chunks: parts.size, total, complete: false, error: `缺分片 ${missing.join(',')}` };
  }
  return { text, chunks: parts.size, total, complete: true, error: null };
}

/** 从 hilog 行里找页面哨兵。返回 `{ ok, code, raw }` 或 `null`。 */
export function parsePageSentinel(lines) {
  for (const raw of lines) {
    const m = /\[selfcheck\] DONE ok=(true|false) code=(\d+)/.exec(String(raw));
    if (m !== null) return { ok: m[1] === 'true', code: Number(m[2]), raw: m[0] };
  }
  return null;
}

/**
 * 判定页面自检报告。
 *
 * `expectedLen` = 上游完整答案的字符数（`NAV_NORMAL_CHUNKS.join('')` 的长度）。
 * 正文长度必须**相等**而不是 >0：少一片也算通的话，这条断言就测不出漏帧。
 */
export function judgeUiPage(lines, expectedLen) {
  const verdicts = [];
  const push = (name, ok, detail) => verdicts.push({ name, ok, detail });

  const sentinel = parsePageSentinel(lines);
  push('界面 · 哨兵行', sentinel !== null && sentinel.code === 0, sentinel === null ? '没看到 [selfcheck] DONE' : sentinel.raw);

  const chunks = parsePageChunks(lines);
  if (!chunks.complete) {
    push('界面 · 报告完整', false, chunks.error ?? '分片不全');
    return { verdicts, report: null, sentinel };
  }
  push('界面 · 报告完整', true, `${chunks.chunks}/${chunks.total} 片，${chunks.text.length} 字符`);

  let report = null;
  try {
    report = JSON.parse(chunks.text);
  } catch (err) {
    push('界面 · 报告是合法 JSON', false, `${String(err.message).slice(0, 160)}｜头部 ${JSON.stringify(chunks.text.slice(0, 80))}`);
    return { verdicts, report: null, sentinel };
  }
  push('界面 · 报告是合法 JSON', true, `${Object.keys(report ?? {}).join(',')}`);

  push('界面 · 是鸿蒙 WebView 壳报的', report.shell === 'ohos-web', String(report.shell));
  const failures = Array.isArray(report.failures) ? report.failures : null;
  push('界面 · 断言无失败项', failures !== null && failures.length === 0, failures === null ? 'failures 字段缺失' : failures.join(' | ') || '—');
  push('界面 · 应用自评通过', report.ok === true, String(report.ok));

  const probe = report.probe ?? {};
  const missing = UI_REQUIRED_PROBES.filter((k) => !(k in probe));
  push('界面 · 断言项没被删空', missing.length === 0, missing.length === 0 ? `${Object.keys(probe).length} 项` : `缺 ${missing.join(',')}`);

  // 以下每一条都是"某一步真的发生了什么"的具体证据 —— 只信 ok 字段等于只信应用的自述。
  push('界面 · 登录闸门出现过', probe.uiLoginGate === true, JSON.stringify(probe.uiLoginGate));
  push('界面 · 体验账号登录后到 ready', probe.uiBootState === 'ready', JSON.stringify(probe.uiBootState));
  push('界面 · 凭据真的进了端口', probe.uiLoginPersisted === true, JSON.stringify(probe.uiLoginPersisted));

  const del = probe.uiSessionDelete ?? {};
  push(
    '界面 · 删除证明会话真落库',
    del.gone === true && del.error === '',
    JSON.stringify(del),
  );

  const stream = probe.uiStream ?? {};
  push(
    '界面 · 聊天逐字到终态（长度相等）',
    stream.streaming === true && stream.stage === 'done' && stream.textLength === expectedLen,
    `stage=${stream.stage} len=${stream.textLength}（期望 ${expectedLen}）`,
  );

  const tab = probe.uiTabSwitch ?? {};
  push(
    '界面 · 切页签不丢帧',
    tab.finished === true &&
      tab.stage === 'done' &&
      tab.lengthBeforeSwitch > 0 &&
      tab.lengthBeforeSwitch < expectedLen &&
      tab.lengthAfterSwitch > tab.lengthBeforeSwitch &&
      tab.finalLen === expectedLen,
    `切走 ${tab.lengthBeforeSwitch} → 切回 ${tab.lengthAfterSwitch} → 终 ${tab.finalLen}（期望 ${expectedLen}）`,
  );

  push('界面 · 工作区树渲染出来了', Number(probe.uiEntryCount) > 0, `entries=${probe.uiEntryCount}`);
  push(
    '界面 · 越界被拒（SCOPE_DENIED 可见）',
    String(probe.uiEscapeMessage ?? '').includes('SCOPE_DENIED'),
    JSON.stringify(String(probe.uiEscapeMessage ?? '').slice(0, 120)),
  );

  const up = probe.uiUpload ?? {};
  push(
    '界面 · 游客上传被上游 403 拒',
    up.stage === 'error' && String(up.error ?? '').includes('没有上传权限'),
    `stage=${up.stage} error=${JSON.stringify(String(up.error ?? '').slice(0, 120))}`,
  );

  return { verdicts, report, sentinel };
}
