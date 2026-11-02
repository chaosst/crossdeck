/**
 * verify-core-openurl —— 动作卡片外链的三道校验（协议 / 凭据 / host 白名单）。
 *
 * 纯函数，不碰网络也不碰 electron：断言直接对源码跑（esbuild 打包 core 的那两个文件）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const WORK = mkdtempSync(join(tmpdir(), 'crossdeck-openurl-'));
const ENTRY = join(ROOT, '_tmp_verify_openurl_entry.ts');
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

const rel = (p) => './' + p.split('\\').join('/');
writeFileSync(ENTRY, `export * from '${rel(join('packages', 'core', 'src', 'net', 'openUrl.ts'))}';\n`, 'utf8');
process.on('exit', () => {
  rmSync(ENTRY, { force: true });
  rmSync(WORK, { recursive: true, force: true });
});

const require = createRequire(import.meta.url);
const mod = await import(
  pathToFileURL(require.resolve('esbuild', { paths: [join(ROOT, 'packages', 'shell-electron')] })).href
);
const esbuild = mod.build === undefined ? mod.default : mod;
await esbuild.build({
  entryPoints: [ENTRY],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
});

const { checkOpenUrl, hostOfUrl, describeOpenUrlReason } = await import(pathToFileURL(OUT).href);
const ALLOWED = ['wiki.example.com'];

console.log('\n── 放行 ──');
check('同源 http 通过', checkOpenUrl('http://wiki.example.com/a', ALLOWED).ok === true);
check('https 通过', checkOpenUrl('https://wiki.example.com/a?b=1#c', ALLOWED).ok === true);
check('host 大小写不敏感', checkOpenUrl('https://WIKI.Example.com/a', ALLOWED).ok === true);
check('带端口仍按 host 判定', checkOpenUrl('https://wiki.example.com:8443/a', ALLOWED).ok === true);
check('两端空白被忽略', checkOpenUrl('  https://wiki.example.com/a  ', ALLOWED).ok === true);

console.log('\n── 拒绝 ──');
check('javascript: 必须拒', checkOpenUrl('javascript:alert(1)', ALLOWED).ok === false);
check('file:// 必须拒', checkOpenUrl('file:///etc/passwd', ALLOWED).ok === false);
check('data: 必须拒', checkOpenUrl('data:text/html,<script>x</script>', ALLOWED).ok === false);
check('别的 host 必须拒', checkOpenUrl('https://evil.com/a', ALLOWED).ok === false);
check('带凭据必须拒', checkOpenUrl('https://u:p@wiki.example.com/a', ALLOWED).ok === false);
check('空串必须拒', checkOpenUrl('', ALLOWED).ok === false);
check('白名单为空时一律拒', checkOpenUrl('https://wiki.example.com/a', []).ok === false);
check('子域名不算同 host', checkOpenUrl('https://a.wiki.example.com/x', ALLOWED).ok === false);

console.log('\n── 原因可区分（UI 要给不同的下一步） ──');
const reasons = [
  ['javascript:alert(1)', 'bad-scheme'],
  ['https://evil.com/x', 'bad-host'],
  ['https://u:p@wiki.example.com/x', 'has-credentials'],
  ['not a url', 'unparsable'],
];
for (const [url, expected] of reasons) {
  const decision = checkOpenUrl(url, ALLOWED);
  check(`${url} → ${expected}`, decision.ok === false && decision.reason === expected, decision.ok ? '被放行' : decision.reason);
  check(`${expected} 有可读文案`, typeof describeOpenUrlReason(expected) === 'string');
}

console.log('\n── hostOfUrl（拼白名单用） ──');
check('取 host 不带端口', hostOfUrl('http://127.0.0.1:3001') === '127.0.0.1', String(hostOfUrl('http://127.0.0.1:3001')));
check('取不到返回 null', hostOfUrl('nonsense') === null);

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✅' : '❌'} verify-core-openurl：${passed}/${total} 条通过`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
