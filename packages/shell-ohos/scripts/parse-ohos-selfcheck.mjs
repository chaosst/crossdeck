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
  { key: 'killed', terminal: 'error', code: 'UPSTREAM', minFrames: 1, msgHas: '读取上游流失败', textEq: false },
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
