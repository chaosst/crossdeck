/**
 * Web 壳 · 登录界面（**只有界面，不接任何登录逻辑**）。
 *
 * 入口是独立页面 `login.html` —— `index.html` 与 `src/main.ts` 一行没改。
 * 这么做而不是 `?login=1`：main.ts 是顶层一路挂到底的模块，加条件分支就得把
 * 300 行整体缩进进 else，那是把一个界面稿变成对"试金石包"的结构性改动。
 *
 * ⚠️ 这里的 `h()` 与 `main.ts` 里那个是**同一段代码的第二份**，这是刻意的：
 *    DOM 是平台 API，core 里不许出现（`pnpm verify:core-purity` 会拦），
 *    所以它只能活在壳里；而壳里为了 9 行 helper 去开一个新模块，
 *    引入的间接层比重复本身更贵。（第三条重复出现时再上提到壳内共享文件。）
 *
 * 视觉与 `shell-electron` 的 `pages/Login.tsx`、`shell-ohos` 的 `pages/Login.ets`
 * 是同一套数值。改一处请同步另外两处。
 */

function h(tag: string, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids) el.append(kid);
  return el;
}

const app = document.getElementById('app');
if (app === null) throw new Error('缺少 #app 挂载点');

// 机器可读的路由标记 —— 截图脚本/自检据此确认"拍到的是登录页"，
// 而不是靠 parse 中文文案。
document.body.dataset['route'] = 'login';

/** 品牌 lockup：色块字标 + 一句话定位。 */
const brand = h(
  'div',
  { class: 'brand' },
  h('div', { class: 'mark' }, 'c'),
  h(
    'div',
    {},
    h('div', { class: 'wordmark' }, 'crossdeck'),
    h('div', { class: 'tagline' }, '跨端桌面工程 · 流式问答'),
  ),
);

/** 一个带标签的输入行。密码那行因为要托一个眼睛按钮，单独手写（见下方 `control`）。 */
function field(id: string, label: string, input: HTMLInputElement): HTMLElement {
  return h('div', { class: 'field' }, h('label', { for: id }, label), input);
}

const account = h('input', {
  id: 'account',
  name: 'account',
  type: 'text',
  autocomplete: 'username',
  placeholder: '请输入账号',
}) as HTMLInputElement;

const password = h('input', {
  id: 'password',
  name: 'password',
  type: 'password',
  autocomplete: 'current-password',
  placeholder: '请输入密码',
}) as HTMLInputElement;

/**
 * 眼睛图标 —— 用 SVG 命名空间手搓，不引图标库、也不走 innerHTML。
 *
 * 不引库：Web 壳的依赖表里只有 contract/core，为两个图标拉一个包不划算。
 * 不走 innerHTML：那要么带一段无意义的 eslint 豁免，要么在改文案时变成注入面；
 * `createElementNS` 多几行，但它一次就把这两件事都说清楚了。
 * 尺寸/线宽对齐 Electron 端 lucide 的 `size-4`（stroke-width 2）。
 */
function svgIcon(paths: string[]): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(k, v);
  }
  for (const d of paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const EYE = ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z', 'M9 12a3 3 0 1 1 6 0 3 3 0 0 1-6 0Z'];
const EYE_OFF = [
  'm3 3 18 18',
  'M10.6 5.2A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a18 18 0 0 1-3.2 4.2',
  'M6.2 6.2A18 18 0 0 0 2 12s3.6 7 10 7a10.5 10.5 0 0 0 4.3-.9',
  'M9.9 9.9a3 3 0 0 0 4.2 4.2',
];

/** 纯表现：只改 input 的 type，不做任何校验。 */
const reveal = h('button', { class: 'reveal', type: 'button', id: 'reveal' }) as HTMLButtonElement;
reveal.setAttribute('aria-label', '显示密码');
reveal.setAttribute('aria-pressed', 'false');
reveal.append(svgIcon(EYE));
reveal.addEventListener('click', () => {
  const shown = password.type === 'text';
  password.type = shown ? 'password' : 'text';
  reveal.replaceChildren(svgIcon(shown ? EYE : EYE_OFF));
  reveal.setAttribute('aria-label', shown ? '显示密码' : '隐藏密码');
  reveal.setAttribute('aria-pressed', String(!shown));
});

const control = h('div', { class: 'control' }, password, reveal);

// 两个按钮都**不挂任何 handler** —— 登录/取体验账号的逻辑不在这张界面稿的范围内。
const submit = h('button', { class: 'primary', type: 'button', id: 'submit' }, '登录') as HTMLButtonElement;
const guest = h(
  'button',
  { class: 'secondary', type: 'button', id: 'guest' },
  '获取体验账号',
) as HTMLButtonElement;

const card = h(
  'section',
  { class: 'card' },
  h('h1', {}, '登录'),
  h('p', { class: 'lead' }, '使用 navigate 账号登录；没有账号可以先拿一个体验账号。'),
  field('account', '账号', account),
  h('div', { class: 'field' }, h('label', { for: 'password' }, '密码'), control),
  submit,
  h('div', { class: 'split' }, '或'),
  guest,
  h('p', { class: 'guest-hint' }, '以 guest 身份进入，无需密码 · 有效期由部署方决定'),
);

/**
 * 环境状态条。
 *
 * UI **必须**如实报上游是哪一种（README 的口径）—— 这里是界面稿，所以是写死的
 * 演示值；真接线时换成 `activeUpstream()`（main.ts 里那个）的真实结果。
 */
const status = h(
  'div',
  { class: 'status', 'data-testid': 'login-upstream' },
  h('i', { 'aria-hidden': 'true' }),
  '上游：脚本（离线可跑，不是真上游）',
  h('span', { class: 'ver' }, 'v1.0.0'),
);

app.append(h('main', { class: 'shell' }, brand, card, status));
