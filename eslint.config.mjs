import tsParser from '@typescript-eslint/parser';

/**
 * 跨端边界的**编辑器内**守卫。
 *
 * 它与 `scripts/verify-core-purity.mjs` 覆盖同一批约束，但不是重复劳动 ——
 * 两者防的是不同的失败模式：
 *
 * | | 触发时机 | 防的是 |
 * |---|---|---|
 * | ESLint | 敲下 import 的下一秒，编辑器里就红 | 「我根本不知道有这条规矩」 |
 * | verify 脚本 | CI / 提交前 | 「我知道，但我先绕过去」 |
 *
 * 所以 `linterOptions.noInlineConfig` 是这份配置里最重要的一行：
 * 它让 `// eslint-disable-next-line` **本身**失效。lint 最容易的死法就是
 * 有人为了赶进度加一行 disable 注释，从此这个文件再没被检查过 ——
 * 而 CI 那层扫描恰好堵住这个口子。两层一起才闭合。
 *
 * 规则只挑「跨端边界」这一类，不加任何风格规则：风格规则的噪音会淹没真正
 * 重要的那几条，最后所有人一起把它关掉。
 *
 * ────────────────────────────────────────────────────────────
 * 为什么用 `no-restricted-syntax` 而不是 `no-restricted-imports`：
 * 实测（三个写法各跑一遍 14 个用例）之后才定的 —— 文档看不出来的三件事：
 *
 *   写法                      ./fs/posixPath.js   fs/promises   动态 import
 *   paths:[{name:'fs'}]            放行 ✅          放行 ❌       放行 ❌
 *   group:['*','!./**',...]        拦住 ❌          拦住 ✅       放行 ❌
 *   AST 正则选择器                  放行 ✅          拦住 ✅       拦住 ✅
 *
 * 关键的两条：`import 'fs/*'` 这类 pattern 会**误伤相对路径** `./fs/xxx`
 * （ESLint 会先剥掉前导 `./` 再匹配），而 `['*', '!./**']` 里的否定**根本不生效**。
 * 一个会误报的规则会被关掉，一个漏报的规则等于没有 —— 两种都不可接受。
 * 锚定正则的 AST 选择器没有这两个毛病。
 * ────────────────────────────────────────────────────────────
 */

// 携带模块说明符的四种语法形态 —— 少写一种就会漏一整个入口。
// 动态 `import('x')` 与静态 import 的失败模式完全不同：前者常被用来"绕过检查"。
const SOURCE_SHAPES = [
  ['ImportDeclaration', 'source.value'],
  ['ExportNamedDeclaration', 'source.value'],
  ['ExportAllDeclaration', 'source.value'],
  ['ImportExpression > Literal', 'value'],
];

/** 把一个「模块名正则」展开成覆盖四种语法形态的 esquery 选择器。 */
function selector(re) {
  return SOURCE_SHAPES.map(([node, attr]) => `${node}[${attr}=/${re}/]`).join(', ');
}

/** electron / node:* / @ohos.* —— 两个浏览器壳都没有它们。 */
const PLATFORM_RE = '^(node:|electron$|electron\\/|@ohos(\\.|\\/|$))';

/** Node 内置模块的裸名写法（`import 'fs'`）。必须锚定 `/` 或结尾，否则会误伤 `fs-extra`。 */
const NODE_BUILTIN_RE =
  '^(assert|async_hooks|buffer|child_process|cluster|console|constants|crypto|dgram|' +
  'diagnostics_channel|dns|domain|events|fs|http|http2|https|inspector|module|net|os|path|' +
  'perf_hooks|punycode|querystring|readline|repl|stream|string_decoder|sys|timers|tls|' +
  'trace_events|tty|url|util|v8|vm|wasi|worker_threads|zlib)(\\/|$)';

/** 非相对 import（且不是契约包）—— 即"第三方依赖"。 */
const THIRD_PARTY_SELECTORS = [
  'ImportDeclaration[source.value=/^[^.]/]:not([source.value=/^@crossdeck\\/contract$/])',
  'ExportNamedDeclaration[source.value=/^[^.]/]:not([source.value=/^@crossdeck\\/contract$/])',
  'ExportAllDeclaration[source.value=/^[^.]/]:not([source.value=/^@crossdeck\\/contract$/])',
  'ImportExpression > Literal[value=/^[^.]/]:not([value=/^@crossdeck\\/contract$/])',
].join(', ');

/** 契约层：只允许相对 import（自己人），其余一律拒。 */
const NON_RELATIVE_SELECTOR = SOURCE_SHAPES.map(
  ([node, attr]) => `${node}[${attr}=/^[^.]/]`,
).join(', ');

const BAN_PROCESS = { name: 'process', message: '宿主信息（platform / env）应当经 EnvPort 注入。核心逻辑一旦读它，Web 壳就废了。' };
const BAN_BUFFER = { name: 'Buffer', message: 'Buffer 是 Node 专有。二进制数据用 Uint8Array。' };
const BAN_DIRNAME = { name: '__dirname', message: '模块路径是打包器/宿主的事，这一层不该关心。' };
const BAN_FILENAME = { name: '__filename', message: '模块路径是打包器/宿主的事，这一层不该关心。' };
const BAN_WINDOW = { name: 'window', message: 'DOM 全局只在 renderer 存在。' };
const BAN_DOCUMENT = { name: 'document', message: 'DOM 全局只在 renderer 存在。' };
const BAN_NAVIGATOR = { name: 'navigator', message: '浏览器指纹信息应当经 EnvPort 注入。' };
const BAN_LOCALSTORAGE = { name: 'localStorage', message: '持久化应当经 Port 注入（桌面端没有 localStorage）。' };
const BAN_REQUIRE = { name: 'require', message: 'require 是 CommonJS 运行时痕迹 —— 本项目是 ESM。' };

/**
 * 平台全局。
 *
 * ⚠️ `no-restricted-globals` 只在**该名字被声明为全局**时才生效 ——
 * 不声明的话规则看不到它，然后你会误以为"配好了"。
 * 一个静默不生效的检查，比没有检查更危险。
 */
const PLATFORM_GLOBALS = {
  process: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  require: 'readonly',
  module: 'readonly',
  exports: 'readonly',
  setImmediate: 'readonly',
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  localStorage: 'readonly',
  indexedDB: 'readonly',
  Notification: 'readonly',
  WebSocket: 'readonly',
};

const tsLanguage = (extra = {}) => ({
  parser: tsParser,
  parserOptions: { sourceType: 'module', ecmaFeatures: { jsx: false }, ...extra },
  globals: PLATFORM_GLOBALS,
});

/** 每一层都要的那一行：让 lint 不能被一行注释关掉。 */
const linterOptions = { noInlineConfig: true, reportUnusedDisableDirectives: 'error' };

export default [
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts', 'docs/**', '**/.trash/**'],
  },

  // ── 基础层 ────────────────────────────────────────────────
  // 这一层不加任何规则，只有一个作用：让 `eslint .` 能**解析**仓库里所有
  // TS / JS 文件。不加的话，没被下面任何 files 命中的文件会落到默认解析器
  // （espree）上，于是在 `packages/shell-electron/src/main/*.ts` 上直接
  // 报语法错误 —— 一个"解析不了"的 lint 输出会把真正的问题埋掉。
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { sourceType: 'module', ecmaFeatures: { jsx: true } },
    },
    linterOptions,
  },
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    linterOptions,
  },

  // ── core：最严。铁律的落点 ─────────────────────────────
  {
    files: ['packages/core/src/**/*.ts'],
    languageOptions: tsLanguage(),
    linterOptions,
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: selector(PLATFORM_RE), message: '平台模块不得进入 core —— 换成 Port 注入（见 packages/core/src/ports.ts）。' },
        { selector: selector(NODE_BUILTIN_RE), message: 'Node 内置模块在 Web 壳里根本不存在。' },
        { selector: THIRD_PARTY_SELECTORS, message: 'core 是零运行时依赖的：除了 @crossdeck/contract 与相对路径，什么都不许 import。' },
        { selector: "CallExpression[callee.name='require']", message: BAN_REQUIRE.message },
        { selector: 'TSImportEqualsDeclaration', message: 'import = require 同理。' },
      ],
      'no-restricted-globals': [
        'error',
        BAN_PROCESS,
        BAN_BUFFER,
        BAN_DIRNAME,
        BAN_FILENAME,
        BAN_WINDOW,
        BAN_DOCUMENT,
        BAN_NAVIGATOR,
        BAN_LOCALSTORAGE,
        BAN_REQUIRE,
      ],
    },
  },

  // ── contract：只有类型与常量，零运行时依赖 ────────────────
  {
    files: ['packages/contract/src/**/*.ts'],
    languageOptions: tsLanguage(),
    linterOptions,
    rules: {
      // 契约层最容易被"顺手加一个 helper"污染成有运行时依赖的包。
      // 一旦它有运行时依赖，Web 壳 / 鸿蒙壳的加载语义就各不相同了 ——
      // 而这份契约存在的全部意义就是"只有一份定义"。
      'no-restricted-syntax': [
        'error',
        { selector: NON_RELATIVE_SELECTOR, message: '契约层只允许相对 import —— 它必须是零依赖的（类型 + 常量而已）。' },
        { selector: "CallExpression[callee.name='require']", message: BAN_REQUIRE.message },
      ],
      'no-restricted-globals': [
        'error',
        BAN_PROCESS,
        BAN_BUFFER,
        BAN_WINDOW,
        BAN_DOCUMENT,
        BAN_NAVIGATOR,
        BAN_LOCALSTORAGE,
        BAN_REQUIRE,
      ],
    },
  },

  // ── 两个浏览器侧：不得碰 node / electron ─────────────────
  //    注意 `shell-web/scripts/` 不在这里 —— 那是 Node 侧的自检运行器，
  //    它本来就该用 node:http / node:child_process。
  {
    files: [
      'packages/shell-web/src/**/*.ts',
      'packages/shell-electron/src/renderer/**/*.ts',
      'packages/shell-electron/src/renderer/**/*.tsx',
    ],
    languageOptions: tsLanguage({ ecmaFeatures: { jsx: true } }),
    linterOptions,
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: selector(PLATFORM_RE), message: '这一层拿不到 electron / node / @ohos —— 它只有 window 上的白名单桥。' },
        { selector: selector(NODE_BUILTIN_RE), message: '浏览器里没有 Node 内置模块。' },
      ],
      'no-restricted-globals': [
        'error',
        BAN_PROCESS,
        BAN_BUFFER,
        BAN_REQUIRE,
        BAN_DIRNAME,
        BAN_FILENAME,
      ],
    },
  },
];
