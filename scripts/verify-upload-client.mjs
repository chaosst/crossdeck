/**
 * verify-upload-client —— 上传客户端的 multipart 组装与错误分流（真 HTTP 服务器）。
 *
 * 这里的断言不能只写"请求成功了"：真正要钉住的是
 *   ① 服务端收到的**文件段字节**与磁盘一致（少发一段也能拿 200）
 *   ② 中文名只编码一次（多编一次就是乱码，而且服务端不会报错）
 *   ③ 403 / 422 / 5xx 给出三句不同的话
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const WORK = mkdtempSync(join(tmpdir(), 'crossdeck-upload-client-'));
const ENTRY = join(ROOT, '_tmp_verify_upload_client_entry.ts');
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
writeFileSync(
  ENTRY,
  `export * from '${rel(join('packages', 'shell-electron', 'src', 'main', 'navigate', 'upload.ts'))}';\n`,
  'utf8',
);
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

const { uploadDocument, buildMultipartFraming } = await import(pathToFileURL(OUT).href);

/** 假 upstream：把收到的 multipart 原样留下来供断言。 */
const received = [];
let mode = 'ok';
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    received.push({
      url: req.url,
      contentType: req.headers['content-type'],
      contentLength: Number(req.headers['content-length']),
      raw,
    });

    if (mode === '401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"unauthorized"}');
      return;
    }
    if (mode === '403') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"error":"forbidden"}');
      return;
    }
    if (mode === '422') {
      res.writeHead(422, { 'content-type': 'application/json' });
      res.end('{"error":"no chunks"}');
      return;
    }
    if (mode === '500') {
      res.writeHead(500);
      res.end('boom');
      return;
    }
    if (mode === 'shape') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"docId":"only-id"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ docId: 'doc_1', filename: '简历.pdf', chunks: 3 }));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const PORT = server.address().port;
const BASE = `http://127.0.0.1:${PORT}`;

/** 解析 multipart，取出文件段（头尾都要按实际字节切，不能靠字符串找）。 */
function parseMultipart(raw, boundary) {
  const headMarker = Buffer.from(`--${boundary}\r\n`, 'utf8');
  const tailMarker = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const startsAtHead = raw.subarray(0, headMarker.length).equals(headMarker);
  const endsAtTail = raw.subarray(raw.length - tailMarker.length).equals(tailMarker);
  const headerEnd = raw.indexOf('\r\n\r\n');
  const headers = raw.subarray(0, headerEnd).toString('utf8');
  const fileStart = headerEnd + 4;
  const fileEnd = raw.length - tailMarker.length;
  return {
    startsAtHead,
    endsAtTail,
    headers,
    fileBytes: raw.subarray(fileStart, fileEnd),
    headerBytes: fileStart,
    tailBytes: tailMarker.length,
  };
}

const CONTENT = 'SELFCHECK-UPLOAD-中文-OK\n'.repeat(8000); // 约 200KB：够切成多块，进度才有帧
const FILE_NAME = '我的简历 2026.pdf';
const filePath = join(WORK, 'upload.pdf');
writeFileSync(filePath, CONTENT, 'utf8');
const size = Buffer.byteLength(CONTENT, 'utf8');

console.log('\n── ① 成功路径：字节对账 + 中文名 + 进度 ────────────');
{
  const progresses = [];
  const result = await uploadDocument({
    baseUrl: BASE,
    token: 'T-O-K+E/N',
    fileName: FILE_NAME,
    absolutePath: filePath,
    sizeBytes: size,
    now: () => Date.now(),
    onProgress: (p) => progresses.push(p),
  });

  check('返回三字段文档', result.document.docId === 'doc_1' && result.document.chunks === 3);
  check('发出的文件段字节 == stat 大小', result.fileBytesSent === size, String(result.fileBytesSent));

  const got = received[received.length - 1];
  check('认证走 ?token= 且做了 URL 编码', got.url === '/api/upload?token=T-O-K%2BE%2FN', got.url);

  const boundary = /boundary=(.+)$/.exec(got.contentType ?? '')?.[1] ?? '';
  check('content-type 带 boundary', boundary.startsWith('----crossdeck'), got.contentType);
  const parsed = parseMultipart(got.raw, boundary);

  check('multipart 以边界开头', parsed.startsAtHead === true);
  check('multipart 以结束边界收尾', parsed.endsAtTail === true);
  check(
    '字段名是 file（服务端就认这一个）',
    parsed.headers.includes('name="file"'),
    parsed.headers,
  );
  check(
    '中文文件名原样出现（只编码一次，不会乱码）',
    parsed.headers.includes(FILE_NAME),
    parsed.headers,
  );
  check(
    '服务端收到的文件段与磁盘逐字节相同',
    parsed.fileBytes.length === size && parsed.fileBytes.equals(Buffer.from(CONTENT, 'utf8')),
    `${parsed.fileBytes.length} vs ${size}`,
  );
  check(
    'content-length 精确等于 头 + 文件 + 尾（不是估算）',
    got.contentLength === parsed.headerBytes + size + parsed.tailBytes,
    `${got.contentLength} vs ${parsed.headerBytes + size + parsed.tailBytes}`,
  );

  const ratios = progresses.map((p) => p.ratio);
  check('进度至少两帧（分块而不是攒齐一次发）', progresses.length >= 2, String(progresses.length));
  check(
    '进度比例单调不减',
    ratios.every((r, i) => i === 0 || r >= ratios[i - 1]),
    ratios.join(','),
  );
  check('最后一帧比例是 1', ratios[ratios.length - 1] === 1);
  check('最后一帧 sent == total', progresses[progresses.length - 1].sentBytes === size);
  check('返回体里的进度也是完成态', result.progress.ratio === 1 && result.progress.etaSec === 0);
}

console.log('\n── ② 失败分流：三种话术不一样 ─────────────────────');
async function expectFailure(nextMode, expectCode, expectDetail) {
  mode = nextMode;
  let err = null;
  try {
    await uploadDocument({
      baseUrl: BASE,
      token: 'T',
      fileName: 'a.pdf',
      absolutePath: filePath,
      sizeBytes: size,
    });
  } catch (e) {
    err = e;
  }
  check(`${nextMode} → ${expectCode}${expectDetail === undefined ? '' : `/${expectDetail}`}`, err?.code === expectCode && (expectDetail === undefined || err.detail === expectDetail), `${String(err?.code)} ${String(err?.detail)} ${String(err?.message)}`);
  return err;
}

const forbidden = await expectFailure('403', 'FORBIDDEN', 'ROLE');
check('403 的话术点明"只对登录账号开放"', forbidden?.message.includes('体验账号') === true, forbidden?.message);
const unparsable = await expectFailure('422', 'BAD_REQUEST', 'UNPARSABLE');
check('422 的话术说的是"解析不出内容"', unparsable?.message.includes('解析') === true, unparsable?.message);
const authExpired = await expectFailure('401', 'FORBIDDEN', 'AUTH_EXPIRED');
check('401 的话术提示重新登录', authExpired?.message.includes('登录') === true, authExpired?.message);
await expectFailure('500', 'UPSTREAM', 'HTTP');
await expectFailure('shape', 'UPSTREAM', 'SHAPE');
mode = 'ok';

console.log('\n── ③ 对账失败必须中止，不能"传一半也算成功" ──────');
{
  let err = null;
  try {
    await uploadDocument({
      baseUrl: BASE,
      token: 'T',
      fileName: 'a.pdf',
      absolutePath: filePath,
      // 声明比磁盘小：只传前面一段同样能拿 200，索引里却少了半篇
      sizeBytes: size - 10,
    });
  } catch (e) {
    err = e;
  }
  check('声明大小与磁盘不符 → INTERNAL/SIZE_MISMATCH', err?.code === 'INTERNAL' && err.detail === 'SIZE_MISMATCH', `${String(err?.code)}/${String(err?.detail)}`);

  const before = received.length;
  err = null;
  try {
    await uploadDocument({
      baseUrl: BASE,
      token: 'T',
      fileName: 'a.pdf',
      absolutePath: filePath,
      sizeBytes: size + 10,
    });
  } catch (e) {
    err = e;
  }
  check('声明比磁盘大 → 也中止（不会发出一个头重脚轻的请求）', err !== null && err.code === 'INTERNAL', String(err?.code));
  check('上面的失败都没往上游发请求', received.length === before, String(received.length - before));
}

console.log('\n── ④ 连不上上游 ───────────────────────────────────');
{
  let err = null;
  try {
    await uploadDocument({
      baseUrl: 'http://127.0.0.1:1',
      token: 'T',
      fileName: 'a.pdf',
      absolutePath: filePath,
      sizeBytes: size,
    });
  } catch (e) {
    err = e;
  }
  check('连不上 → UPSTREAM 且说"无法连接"', err?.code === 'UPSTREAM' && err.message.includes('无法连接'), err?.message);
}

console.log('\n── ⑤ 纯函数：framing 的字节账 ─────────────────────');
{
  const framing = buildMultipartFraming('a.pdf', 100, 'BOUND');
  check('content-length = 头 + 文件 + 尾', framing.contentLength === framing.head.length + 100 + framing.tail.length);
  check('头里有字段名与文件名', framing.head.toString('utf8').includes('name="file"; filename="a.pdf"'));
  check('头尾都用 CRLF（LF 会让服务端解析失败）', framing.head.toString('utf8').endsWith('\r\n\r\n') && framing.tail.toString('utf8').startsWith('\r\n'));
  const quoted = buildMultipartFraming('he"llo\r\n.pdf', 1, 'B');
  check(
    '文件名里的引号与换行被替换（否则头部被注入）',
    quoted.head.toString('utf8').includes('filename="he_llo__.pdf"'),
    quoted.head.toString('utf8'),
  );
}

server.close();
const total = passed + failures.length;
console.log(`\n${failures.length === 0 ? '✅' : '❌'} verify-upload-client：${passed}/${total} 条通过`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  · ${f}`);
}
process.exit(failures.length === 0 ? 0 : 1);
