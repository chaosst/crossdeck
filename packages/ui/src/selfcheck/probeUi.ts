/**
 * UI 自检探针 —— 驱动**真实共享界面**走完一条业务链路。
 *
 * 算法断言再密，也证明不了"界面上接得上"。这里每一跳都过 bridge：
 * 登录闸门 → 建会话 → 发一问（流式落到 DOM）→ 流式中切页签 → 授权目录
 * → 越界被拒 → 上传被拒。界面本体在 `@crossdeck/ui`（三端共用），
 * 所以断言名与点击顺序在 Web / 鸿蒙两壳完全一致 —— 换壳只换 `Deps`。
 *
 * 断言名是**三端契约**：`parse-ohos-selfcheck.mjs`（设备侧判定）与
 * `web-selfcheck.mjs`（浏览器侧判定）都按名字取数。改名 = 两处一起改。
 */

/** 单次探针的断言出口 —— 失败记名，细节进 probe。 */
export type UiCheck = (name: string, condition: boolean, detail?: unknown) => void;

/** 场景词表（假上游下发）。页面硬编码 prompt 的话，词表一改自检就静默失效。 */
export interface UiFixture {
  readonly scenarios: Record<string, string>;
  readonly normalText: string;
}

export interface ProbeUiDeps {
  /** 取场景词表 + 完整答案（Web: 同源假上游；鸿蒙: selfcheck 端口经 ArkTS 拉取）。 */
  fixture(): Promise<UiFixture>;
  /**
   * 登录是否**真的落到了凭据通道**上（Web: cookie 认 /api/me；鸿蒙: 端口里真有 token）。
   * 少了这条，"登录成功"只说明响应体是 200。
   */
  loginPersisted(): Promise<boolean>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询直到条件成立 —— 不引测试框架，页面里这十行就够了。 */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(25);
  }
  return false;
}

export function probeUiHarness() {
  const ui = {
    find<T extends Element>(testId: string): T | null {
      return document.querySelector<T>(`[data-testid="${testId}"]`);
    },
    /**
     * 点一个锚点。`click()` 只有 `HTMLElement` 有 —— 图标按钮的锚点常挂在 SVG 上
     * （lucide 会把 `data-*` 透传给 `<svg>`），所以非 HTML 元素走派发冒泡事件，
     * React 收到的是同一条合成事件路径，行为一致。
     */
    click(testId: string): boolean {
      const el = ui.find<Element>(testId);
      if (el === null) return false;
      if (el instanceof HTMLElement) {
        el.click();
        return true;
      }
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    },
    attr(testId: string, name: string): string | null {
      return ui.find(testId)?.getAttribute(name) ?? null;
    },
    text(testId: string): string {
      return ui.find(testId)?.textContent ?? '';
    },
    /**
     * 切页签到 `anchor` 出现为止。
     *
     * `el.click()` 返回时 React 还没把新分支刷进 DOM（同步 lane 走的是微任务），
     * 所以点完立刻 `querySelector` 会看到旧页签 —— 必须等锚点，不能等一个固定时长：
     * 页面本体在 `packages/ui`，渲染时机归它，自检没有立场猜它多久画完。
     */
    async switchTab(tabTestId: string, anchor: string): Promise<boolean> {
      if (!ui.click(tabTestId)) return false;
      return waitFor(() => ui.find(anchor) !== null, 8000);
    },
  };
  return ui;
}

export async function runUiProbe(
  check: UiCheck,
  probe: Record<string, unknown>,
  deps: ProbeUiDeps,
): Promise<void> {
  const ui = probeUiHarness();

  try {
    // ① 登录闸门：未登录时停在 #/login，点「获取体验账号」才进主界面。
    //    这条同时验了三件事：navigate:status 的探测、登录通道、凭据真的被壳收下。
    const gate = await waitFor(() => ui.find('login-guest') !== null, 10000);
    probe.uiLoginGate = gate;
    check('ui.loginGateShown', gate, location.hash);

    check('ui.guestLoginClicked', ui.click('login-guest'));
    const booted = await waitFor(() => ui.attr('boot-status', 'data-state') === 'ready', 15000);
    probe.uiBootState = ui.attr('boot-status', 'data-state');
    check('ui.bootReadyAfterGuestLogin', booted, probe.uiBootState);

    // 登录真的落到了凭据通道上（cookie / 端口里的 token）
    const persisted = await deps.loginPersisted();
    probe.uiLoginPersisted = persisted;
    check('ui.loginCookiePersisted', persisted, persisted);

    // ② 会话：真点一次「新建会话」，列表里要多出一行。
    //    「新建会话」在「应用能力」页签里，所以先切页签并等它出现 —— 见 `switchTab`。
    const onAbility = await ui.switchTab('tab-ability', 'session-create');
    const itemCount = (): number => document.querySelectorAll('[data-testid="session-item"]').length;
    const sessionsBefore = itemCount();
    check('ui.sessionCreateClicked', onAbility && ui.click('session-create'), onAbility);
    const created = await waitFor(() => itemCount() === sessionsBefore + 1, 8000);
    probe.uiSessionCount = { before: sessionsBefore, after: itemCount() };
    check('ui.sessionCreatedThroughUi', created, probe.uiSessionCount);

    /**
     * ②b 「列表多一行」只证明界面收下了回执 —— `handleCreate` 拿到 meta 就本地
     * append 了，库里有没有那一行它并不知道。
     *
     * 真伪用**删除**来证：删一个库里不存在的 id，仓储返回 false、壳抛 NOT_FOUND、
     * 行留在原地并弹出错误卡片。所以"删掉了 + 没有任何错误"才是这一行真落过库的
     * 证据。删完再建一个，供后面聊天用 —— 顺带说明这条链能在同一个会话表上反复走。
     */
    const deleteRow = async (): Promise<{ gone: boolean; error: string }> => {
      ui.click('session-delete');
      const gone = await waitFor(() => itemCount() === sessionsBefore, 8000);
      return { gone, error: ui.text('action-error') };
    };
    const deleted = created ? await deleteRow() : { gone: false, error: '未执行：会话没建成' };
    probe.uiSessionDelete = deleted;
    check('ui.sessionDeletedThroughUi', deleted.gone && deleted.error === '', deleted);

    // 聊天要在有会话的前提下点发送，所以这里补建一个 —— 建不起来后面会明确判红
    if (created) ui.click('session-create');
    const recreated = await waitFor(() => itemCount() === sessionsBefore + 1, 8000);
    probe.uiSessionRecreated = recreated;

    // ③ 聊天：真打一行字、真点发送 —— 流式正文必须出现在 DOM 里
    const fixture = await deps.fixture();
    check('ui.navFixtureReachable', fixture !== null, fixture === null ? '取不到场景词表' : Object.keys(fixture.scenarios).length);
    const promptNormal = fixture.scenarios['normal'] ?? '';
    /** 慢流**必须用会收尾的那一档** —— `slow` 永不 done，断言终态会永远等不到。 */
    const promptSlow = fixture.scenarios['slow-done'] ?? '';
    /** 上游对所有正常收尾的场景吐同一份文本，切片是它自己的事 —— 所以长度可以精确比。 */
    const expectedLen = fixture.normalText.length;

    const onChat = await ui.switchTab('tab-chat', 'chat-input');
    const input = ui.find<HTMLTextAreaElement>('chat-input');
    if (input === null) {
      check('ui.chatInputPresent', false, {
        onChat,
        hash: location.hash,
        anchors: [...document.querySelectorAll('[data-testid]')].map((n) => n.getAttribute('data-testid')),
      });
    } else if (!recreated) {
      /**
       * 会话没建成 → 后面每一次发送都会走到 `[NOT_FOUND] 会话不存在`。
       *
       * 这里**明确判红而不是跳过**：跳过的断言和通过的那条在报告里长得一模一样，
       * 于是"链条断在前一步"会被读成"聊天功能正常"。同时也不真发消息 ——
       * 发出去只会把每个 `waitFor` 都等满超时，一轮下来能把哨兵预算烧光，
       * 报告落不了地，一条诊断都剩不下。
       */
      check('ui.streamReachedDone', false, '未执行：会话没建成（见 ui.sessionRecreated）');
      check('ui.tokensSurviveTabSwitch', false, '未执行：会话没建成（见 ui.sessionRecreated）');
    } else {
      check('ui.chatInputPresent', true);
      const typeInto = (text: string): void => {
        // React 的受控/非受控都靠原生 setter + input 事件这条正路，别去改 value 了事
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        setter?.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };

      typeInto(promptNormal);
      check('ui.sendClicked', ui.click('chat-send'));

      const streaming = await waitFor(() => ui.attr('stream-stage', 'data-stage') === 'streaming', 8000);
      const done = await waitFor(() => ui.attr('stream-stage', 'data-stage') === 'done', 20000);
      const textLength = Number(ui.attr('stream-text', 'data-len') ?? '0');
      probe.uiStream = { streaming, stage: ui.attr('stream-stage', 'data-stage'), textLength, expectedLen };
      // 比**长度相等**而不是 >0：少一片也算通的话，这条断言就测不出"漏帧"
      check('ui.streamReachedDone', streaming && done && textLength === expectedLen, probe.uiStream);

      // ④ 流式中切页签：订阅挂在窗口入口（`streamBinding`），不随页面卸载而摘掉 ——
      //    所以切走期间到达的帧必须仍然进 store，切回来后的正文只会更长。
      //    素材用 `slow-done`（5 片、每片 700ms，走完正常 done）：20ms 那一档在切页签
      //    之前就结束了，测不到东西；基线也要等第一片落地再取 —— 刚点发送时正文还是空的，
      //    拿 0 当基线等于没有基线。
      typeInto(promptSlow);
      check('ui.slowSendClicked', ui.click('chat-send'));
      const restarted = await waitFor(() => ui.attr('stream-stage', 'data-stage') === 'streaming', 8000);
      const firstChunk = await waitFor(() => Number(ui.attr('stream-text', 'data-len') ?? '0') > 0, 8000);
      const lengthBeforeSwitch = Number(ui.attr('stream-text', 'data-len') ?? '0');
      ui.click('tab-ability');
      await sleep(1500);
      const backOnChat = await ui.switchTab('tab-chat', 'stream-stage');
      const lengthAfterSwitch = Number(ui.attr('stream-text', 'data-len') ?? '0');
      const finished = await waitFor(() => ui.attr('stream-stage', 'data-stage') === 'done', 20000);
      const finalLen = Number(ui.attr('stream-text', 'data-len') ?? '0');
      probe.uiTabSwitch = {
        restarted,
        firstChunk,
        backOnChat,
        lengthBeforeSwitch,
        lengthAfterSwitch,
        finalLen,
        expectedLen,
        finished,
        stage: ui.attr('stream-stage', 'data-stage'),
      };
      // 三件事一起判，缺一条就退化：
      //   ① 切走那一刻正文**没写完**（否则这条断言在"流早就结束"的情况下空转通过）；
      //   ② 切回来时比切走时更长（期间确实有帧进来）；
      //   ③ 最终长度**等于完整答案** —— 只判"更长"的话，
      //      "页签卸载时退订、重新挂载时再订阅"也能通过（丢的那几片之后再补不上就对不上长度）。
      check(
        'ui.tokensSurviveTabSwitch',
        finished &&
          lengthBeforeSwitch > 0 &&
          lengthBeforeSwitch < expectedLen &&
          lengthAfterSwitch > lengthBeforeSwitch &&
          finalLen === expectedLen,
        probe.uiTabSwitch,
      );
    }

    // ⑤ 工作区：授权演示目录 → 列目录 → 试读 `../` 必须被拒
    await ui.switchTab('tab-ability', 'ws-grant');
    check('ui.grantClicked', ui.click('ws-grant'));
    const treeRendered = await waitFor(() => document.querySelectorAll('[data-testid="ws-entry"]').length > 0, 8000);
    probe.uiEntryCount = document.querySelectorAll('[data-testid="ws-entry"]').length;
    check('ui.treeRendered', treeRendered, probe.uiEntryCount);

    check('ui.escapeClicked', ui.click('ws-probe-escape'));
    const denied = await waitFor(() => ui.text('fs-error').includes('SCOPE_DENIED'), 8000);
    probe.uiEscapeMessage = ui.text('fs-error');
    check('ui.escapeDenialVisible', denied, probe.uiEscapeMessage);

    // ⑥ 上传：点开一个真文件 → 点上传 → 游客必须被上游 403 拒掉，且界面如实显示原因
    const fileEntry = document.querySelector<HTMLElement>('[data-testid="ws-entry"][data-kind="file"]');
    if (fileEntry === null) {
      check('ui.fileEntryPresent', false, '工作区里没有可点的文件');
    } else {
      check('ui.fileEntryPresent', true);
      fileEntry.click();
      const panel = await waitFor(() => ui.find('upload-panel') !== null, 8000);
      check('ui.uploadClicked', ui.click('upload-button'));
      const failed = await waitFor(() => ui.attr('upload-stage', 'data-stage') === 'error', 20000);
      probe.uiUpload = {
        panel,
        stage: ui.attr('upload-stage', 'data-stage'),
        ratio: ui.attr('upload-stage', 'data-ratio'),
        error: ui.text('upload-error'),
      };
      check(
        'ui.uploadDeniedForGuest',
        panel && failed && ui.text('upload-error').includes('没有上传权限'),
        probe.uiUpload,
      );
    }
  } catch (err) {
    check('ui.driverThrew', false, err instanceof Error ? err.message : String(err));
  }
}
