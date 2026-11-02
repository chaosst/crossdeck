/**
 * verify-core-upload —— 上传的本地体检 / 进度归一 / 失败话术。
 *
 * 全是纯函数：不碰网络也不碰 electron，直接对源码打包后断言。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const WORK = mkdtempSync(join(tmpdir(), 'crossdeck-upload-'));
const ENTRY = join(ROOT, '_tmp_verify_upload_entry.ts');
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
writeFileSync(ENTRY, `export * from '${rel(join('packages', 'core', 'src', 'net', 'upload.ts'))}';\n`, 'utf8');
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

const {
  DEFAULT_UPLOAD_POLICY,
  UPLOAD_FIELD,
  advanceUploadProgress,
  beginUploadProgress,
  checkUploadCandidate,
  decodeUploadedDocument,
  describeUploadStatus,
  extensionOf,
  readUploadProgress,
  uploadEndpoint,
} = await import(pathToFileURL(OUT).href);

console.log('\n── ① 扩展名解析（中文名 / 路径 / 大小写）────────────');
check('普通扩展名', extensionOf('resume.pdf') === 'pdf');
check('大写统一成小写', extensionOf('RESUME.PDF') === 'pdf');
check('中文文件名不受影响', extensionOf('我的简历.pdf') === 'pdf');
check('取最后一个点', extensionOf('a.b.docx') === 'docx');
check('带目录的路径只看文件名', extensionOf('/tmp/x.y/resume.md') === 'md');
check('Windows 路径分隔符也认', extensionOf('C:\\简历\\a.pdf') === 'pdf');
check('没有扩展名 → 空串', extensionOf('README') === '');
check('点开头（.gitignore）不算扩展名', extensionOf('.gitignore') === '');

console.log('\n── ② 本地体检：这里判失败就不该发请求 ──────────────');
const policy = { maxBytes: 1024 * 1024, allowedExt: ['pdf', 'md'] };
check('合法文件通过', checkUploadCandidate({ fileName: 'a.pdf', sizeBytes: 10 }, policy).ok === true);
check(
  '空文件被拦',
  checkUploadCandidate({ fileName: 'a.pdf', sizeBytes: 0 }, policy).reason === 'empty-file',
);
check(
  '负数大小（stat 异常）也拦',
  checkUploadCandidate({ fileName: 'a.pdf', sizeBytes: -1 }, policy).reason === 'empty-file',
);
check(
  '超限被拦',
  checkUploadCandidate({ fileName: 'a.pdf', sizeBytes: policy.maxBytes + 1 }, policy).reason ===
    'too-large',
);
check(
  '正好等于上限放行（边界不是"小于"）',
  checkUploadCandidate({ fileName: 'a.pdf', sizeBytes: policy.maxBytes }, policy).ok === true,
);
check(
  '后缀不在白名单被拦',
  checkUploadCandidate({ fileName: 'a.exe', sizeBytes: 10 }, policy).reason === 'bad-extension',
);
check(
  '无扩展名被拦，且文案说清楚',
  (() => {
    const r = checkUploadCandidate({ fileName: 'README', sizeBytes: 10 }, policy);
    return r.ok === false && r.message.includes('无扩展名');
  })(),
);
check(
  '拒绝文案带上限数字（用户才知道该压到多小）',
  (() => {
    const r = checkUploadCandidate({ fileName: 'a.pdf', sizeBytes: 2 * 1024 * 1024 }, policy);
    return r.ok === false && r.message.includes('1.0MB');
  })(),
);
check('默认策略拦 docx 之外的二进制', DEFAULT_UPLOAD_POLICY.allowedExt.includes('docx') === true);
check('默认策略上限是 20MB', DEFAULT_UPLOAD_POLICY.maxBytes === 20 * 1024 * 1024);
check('multipart 字段名与服务端对齐', UPLOAD_FIELD === 'file');

console.log('\n── ③ 进度归一：乱序 / 重复 / 跳号 ──────────────────');
const TOTAL = 1000;
let state = beginUploadProgress(TOTAL, 0);
const sequence = [100, 300, 200, 300, 700, 500, 1000];
const ratios = [];
for (const sent of sequence) {
  const step = advanceUploadProgress(state, sent, 100);
  state = step.state;
  ratios.push(step.progress.ratio);
}
check(
  '比例单调不减（乱序 + 回退都喂过了）',
  ratios.every((r, i) => i === 0 || r >= ratios[i - 1]),
  ratios.join(','),
);
check('比例不会超过 1（跳号超总量被夹紧）', Math.max(...ratios) <= 1, String(Math.max(...ratios)));
check('最后一次到达 1', ratios[ratios.length - 1] === 1);
check(
  'sentBytes 不会倒退',
  state.sentBytes === TOTAL,
  String(state.sentBytes),
);
// 反向：喂进来的原始序列确实是乱序的 —— 否则上面那条"单调"是白测的
check(
  '[反向] 原始序列本身非单调，说明夹紧是承重的',
  sequence.some((v, i) => i > 0 && v < sequence[i - 1]) === true,
);
{
  const naive = beginUploadProgress(TOTAL, 0);
  const naiveRatios = [];
  let s = naive;
  for (const sent of sequence) {
    s = { ...s, sentBytes: Math.min(sent, TOTAL) };
    naiveRatios.push(readUploadProgress(s, 100).ratio);
  }
  check(
    '[反向] 去掉 max(上次, 本次) 后比例会倒退（该断言能杀掉"没夹紧"的实现）',
    naiveRatios.some((r, i) => i > 0 && r < naiveRatios[i - 1]) === true,
    naiveRatios.join(','),
  );
}

console.log('\n── ④ 进度：速率与剩余时间不许编 ───────────────────');
{
  const s = beginUploadProgress(TOTAL, 1000);
  const early = advanceUploadProgress(s, 10, 1050).progress;
  check('样本不足（50ms）时速率是 null 而不是 0', early.bytesPerSec === null, String(early.bytesPerSec));
  check('样本不足时剩余时间也是 null', early.etaSec === null, String(early.etaSec));
  check('样本不足时比例照常推进', early.ratio === 0.01, String(early.ratio));

  const later = advanceUploadProgress(s, 500, 2000).progress;
  check('样本足够后算出速率（500B / 1s）', later.bytesPerSec === 500, String(later.bytesPerSec));
  check('剩余时间按速率推（还剩 500B / 500Bps = 1s）', later.etaSec === 1, String(later.etaSec));

  const done = advanceUploadProgress(s, TOTAL, 2000).progress;
  check('完成时剩余时间是 0（不是 null）', done.etaSec === 0, String(done.etaSec));
  check('完成时比例是 1', done.ratio === 1);
}
{
  const s = beginUploadProgress(0, 0);
  const p = readUploadProgress(s, 500);
  check('总量为 0 时比例按 1 算（空文件在体检那一步就该被拦）', p.ratio === 1);
  check('总量为 0 时不会算出 NaN', Number.isFinite(p.ratio) === true);
}

console.log('\n── ⑤ 失败分流：三种话术不能都写成"上传失败" ────────');
const forbidden = describeUploadStatus(403);
check('403 → forbidden', forbidden.reason === 'forbidden');
check('403 不可重试（换个账号才行，重试只是再撞一次）', forbidden.retryable === false);
check('403 文案点明"体验账号不行"', forbidden.message.includes('体验账号'));
check('401 → unauthorized', describeUploadStatus(401).reason === 'unauthorized');
const unparsable = describeUploadStatus(422);
check('422 → unparsable', unparsable.reason === 'unparsable');
check('422 文案说的是"解析不出内容"而不是"上传失败"', unparsable.message.includes('解析'));
check('413 → too-large', describeUploadStatus(413).reason === 'too-large');
const upstream = describeUploadStatus(500);
check('500 → upstream 且可重试', upstream.reason === 'upstream' && upstream.retryable === true);
check('502 也归到上游那一类', describeUploadStatus(502).reason === 'upstream');
check(
  '五种状态给出五种不同文案（压成一句就失去意义）',
  new Set([401, 403, 422, 413, 500].map((s) => describeUploadStatus(s).message)).size === 5,
);

console.log('\n── ⑥ 响应形状 ─────────────────────────────────────');
check(
  '正常响应解出三字段',
  (() => {
    const d = decodeUploadedDocument({ docId: 'd1', filename: '简历.pdf', chunks: 7 });
    return d !== null && d.docId === 'd1' && d.filename === '简历.pdf' && d.chunks === 7;
  })(),
);
check('缺 docId → null', decodeUploadedDocument({ filename: 'a', chunks: 1 }) === null);
check('docId 是空串 → null', decodeUploadedDocument({ docId: '', filename: 'a', chunks: 1 }) === null);
check('chunks 不是数字 → null', decodeUploadedDocument({ docId: 'd', filename: 'a', chunks: '1' }) === null);
check('chunks 是 NaN → null', decodeUploadedDocument({ docId: 'd', filename: 'a', chunks: NaN }) === null);
check('不是对象 → null', decodeUploadedDocument('nope') === null);
check('null → null', decodeUploadedDocument(null) === null);
check(
  '多余字段不往上传（契约就是三个字段）',
  (() => {
    const d = decodeUploadedDocument({ docId: 'd', filename: 'a', chunks: 1, secret: 'x' });
    return d !== null && Object.keys(d).sort().join(',') === 'chunks,docId,filename';
  })(),
);

console.log('\n── ⑦ 上传地址 ─────────────────────────────────────');
check(
  '拼上 /api/upload 与 ?token=',
  uploadEndpoint('http://127.0.0.1:3001', 'ABC') === 'http://127.0.0.1:3001/api/upload?token=ABC',
);
check(
  '尾斜杠不会拼出 //api',
  uploadEndpoint('http://h:3001/', 'T') === 'http://h:3001/api/upload?token=T',
);
check(
  '多个尾斜杠也归一',
  uploadEndpoint('http://h:3001///', 'T') === 'http://h:3001/api/upload?token=T',
);
check(
  'token 里的特殊字符要转义（否则参数被截断）',
  uploadEndpoint('http://h', 'a+b/c=d').endsWith('token=a%2Bb%2Fc%3Dd'),
  uploadEndpoint('http://h', 'a+b/c=d'),
);

const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✅' : '❌'} verify-core-upload：${passed}/${total} 条通过`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
