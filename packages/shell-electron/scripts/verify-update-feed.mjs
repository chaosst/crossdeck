#!/usr/bin/env node
/**
 * 更新链路端到端验证 —— 对着一个**真实的 HTTP 更新源**跑完整条路。
 *
 * 与 `pnpm selfcheck` 的分工：
 *   selfcheck 跑在未打包形态，验证的是「不具备条件时会如实报错」
 *   （无签名 / 未打包必须报 error，而不是永远转圈）；
 *   这里跑在**打包产物**上，验证的是另一半：
 *   「真的有新版本时，检查 → 发现 → 下载 → 就绪」这条路是不是通的。
 *   两半都验过，自动更新这件事才算被证明过 —— 只验一半的话，
 *   未打包报错正确 ≠ 打包后能升级。
 *
 * 做法：
 *   1. 起一个本地静态 HTTP 服务，目录里放 latest.yml 与一个假的安装包；
 *   2. 用 CROSSDECK_UPDATE_URL 把产物的更新源指过去（不碰包里烘死的地址）；
 *   3. 产物跑 --update-feed-probe，把阶段轨迹与断言打成哨兵；
 *   4. 本脚本按哨兵判定成败，然后强杀进程树。
 *
 * ⚠️ 为什么收尾要强杀：受限会话里 Chromium 可能无法干净退出，
 *    `app.exit()` 会卡在残留的 GPU/viz 子进程上（与自检同一个坑）。
 *    所以校验链挂在**哨兵里的判定**上，不挂在"进程能不能退出"上。
 *
 * 用法（需先有产物，脚本不会替你打包）：
 *   pnpm pack:win
 *   node packages/shell-electron/scripts/verify-update-feed.mjs
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 喂给 feed 的假版本号。必须大于产物自己的版本（package.json 里的 1.0.0），否则 core 会拒收。 */
const FEED_VERSION = '9.9.9';
const INSTALLER_NAME = `crossdeck-Setup-${FEED_VERSION}.exe`;

/** 假安装包大小。取 8MB 而不是 1KB：要让 electron-updater 至少发几帧进度，
 *  否则"进度如实上报"这条实际上是没被执行的。 */
const INSTALLER_BYTES = 8 * 1024 * 1024;

const HARD_LIMIT_MS = 180_000;
const DONE_RE = /\[updatefeed\] DONE ok=(true|false) code=(\d+)/;
const DATA_RE = /\[updatefeed\] DATA (\{.*\})/;

function findPackagedExe() {
  const packDir = join(PKG_ROOT, 'dist', 'pack');
  const unpacked = join(packDir, 'win-unpacked');
  if (!existsSync(unpacked)) {
    console.error('✗ 找不到打包产物：', unpacked);
    console.error('  先跑 `pnpm pack:win`。本脚本只验证产物，不负责打包 ——');
    console.error('  验证对象必须是被打包的那份代码，而不是源码。');
    process.exit(2);
  }
  const candidate = readdirSync(unpacked).find((f) => f.endsWith('.exe') && f !== 'elevate.exe');
  if (candidate === undefined) {
    console.error('✗ win-unpacked 里没有找到可执行文件');
    process.exit(2);
  }
  return join(unpacked, candidate);
}

/**
 * 本地 feed。
 *
 * 必须支持 Range：electron-updater 的下载器会带 `Range: bytes=0-` 发请求，
 * 一个只会整文件返回的服务端会让它拿到内容长度对不上的响应而报错 ——
 * 那种失败看起来像"下载链路坏了"，其实是夹具不像真的。
 */
function startFeedServer(dir, log) {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').replace(/^\/+/, '').split('?')[0]);
    const file = join(dir, name);
    log.push(`${req.method ?? 'GET'} /${name}`);

    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }

    const size = statSync(file).size;
    const range = req.headers.range;
    if (typeof range === 'string') {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m !== null) {
        const start = m[1] === '' ? 0 : Number(m[1]);
        const end = m[2] === '' ? size - 1 : Number(m[2]);
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        res.end(readFileSlice(file, start, end));
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    res.end(readFileSlice(file, 0, size - 1));
  });

  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolveServer({ server, port: typeof addr === 'object' && addr !== null ? addr.port : 0 });
    });
  });
}

function readFileSlice(file, start, end) {
  // 夹具只有 8MB，直接整读再切片 —— 不为一个夹具引入流式读取。
  return readFileSync(file).subarray(start, end + 1);
}

function buildFeed(dir) {
  mkdirSync(dir, { recursive: true });

  const payload = randomBytes(INSTALLER_BYTES);
  const installerPath = join(dir, INSTALLER_NAME);
  writeFileSync(installerPath, payload);

  // sha512 用 base64 —— 与 electron-builder 生成的 latest.yml 保持一致。
  // 写错编码的后果很隐蔽：electron-updater 会下载成功然后校验失败，
  // 表现成"下载完了但没进 ready"。
  const sha512 = createHash('sha512').update(payload).digest('base64');

  const latest = [
    `version: ${FEED_VERSION}`,
    'files:',
    `  - url: ${INSTALLER_NAME}`,
    `    sha512: ${sha512}`,
    `    size: ${payload.length}`,
    `path: ${INSTALLER_NAME}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    '',
  ].join('\n');

  writeFileSync(join(dir, 'latest.yml'), latest, 'utf8');
  return { sha512, size: payload.length, latestYml: join(dir, 'latest.yml') };
}

function killTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 已经退了 */
    }
  }
}

async function main() {
  const exe = findPackagedExe();
  const feedDir = join(tmpdir(), `crossdeck-update-feed-${process.pid}`);
  const requests = [];
  const feed = buildFeed(feedDir);
  const { server, port } = await startFeedServer(feedDir, requests);
  const feedUrl = `http://127.0.0.1:${port}`;

  console.log('── 更新链路端到端验证 ─────────────────────────────');
  console.log(`  产物      ${exe}`);
  console.log(`  feed      ${feedUrl}`);
  console.log(`  假安装包  ${INSTALLER_NAME}（${(feed.size / 1048576).toFixed(2)} MB，sha512 已写入 latest.yml）`);
  console.log('');

  const env = { ...process.env, CROSSDECK_UPDATE_URL: feedUrl };
  // 与 launch.mjs 同一个理由：这个变量会让 electron.exe 退化成普通 Node，
  // 打包产物被它污染时表现是"应用起不来"，与更新毫无关系。
  delete env['ELECTRON_RUN_AS_NODE'];

  const child = spawn(exe, ['--no-sandbox', '--update-feed-probe', `--expect-version=${FEED_VERSION}`], {
    cwd: dirname(exe),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let buffered = '';
  let report = null;
  let verdict = null;

  const finish = (code, why) => {
    if (verdict !== null) return;
    verdict = code;
    if (why) console.error(`[verify] ${why}`);
    killTree(child.pid);
    server.close();
    writeArtifact({ report, requests, feed, exe, feedUrl, verdict: code });
    summarize({ report, requests, feed, exe, feedUrl });
    try {
      rmSync(feedDir, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不影响判定 */
    }
    process.exit(code);
  };

  const hardLimit = setTimeout(
    () => finish(1, `${HARD_LIMIT_MS / 1000}s 内没有收到探针哨兵 —— 判失败并强制结束`),
    HARD_LIMIT_MS,
  );

  const onChunk = (chunk, echo) => {
    const text = chunk.toString('utf8');
    if (echo) process.stdout.write(text);
    buffered += text;

    const data = DATA_RE.exec(buffered);
    if (data !== null && report === null) {
      try {
        report = JSON.parse(data[1]);
      } catch (err) {
        console.error('[verify] 探针 DATA 解析失败：', err);
      }
    }

    const done = DONE_RE.exec(buffered);
    if (done === null) return;
    clearTimeout(hardLimit);
    // 判定以哨兵里的 ok 为准；进程退出码只作参考 —— 受限会话里
    // app.exit 未必真的结束进程，退出码可能永远不来。
    finish(done[1] === 'true' ? 0 : 1);
  };

  child.stdout.on('data', (c) => onChunk(c, true));
  child.stderr.on('data', (c) => onChunk(c, false));

  child.on('exit', (code, signal) => {
    if (verdict !== null) return;
    clearTimeout(hardLimit);
    console.error(`[verify] 产物在哨兵之前退出（code=${String(code)} signal=${String(signal)}）`);
    finish(1, '没有拿到判定');
  });

  child.on('error', (err) => {
    clearTimeout(hardLimit);
    console.error('[verify] 启动产物失败：', err);
    finish(1);
  });
}

function formatFrame(f) {
  if (f.stage === 'downloading') return `downloading(${String(f.percent)}%)`;
  if (f.version !== null) return `${f.stage}(${f.version})`;
  return f.stage;
}

function writeArtifact(payload) {
  const outDir = join(PKG_ROOT, 'dist', 'selfcheck');
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, 'update-feed.json');
  writeFileSync(
    out,
    `${JSON.stringify({ ranAt: new Date().toISOString(), ...payload }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\n[verify] 证据：${out}`);
}

function summarize({ report, requests, feed, exe, feedUrl }) {
  console.log('\n── 汇总 ───────────────────────────────────────────');
  if (report === null) {
    console.log('  未拿到探针报告 —— 见上方产物输出');
    return;
  }
  console.log(`  产物版本        ${report.appVersion}（packaged=${String(report.packaged)}）`);
  console.log(`  更新源          ${String(report.feedUrl ?? feedUrl)}`);
  console.log(`  检查更新返回    ${String(report.checkReturnedVersion)}`);
  console.log(`  渲染层轨迹      ${(report.frames ?? []).map(formatFrame).join(' → ') || '(空)'}`);
  console.log(`  主进程终态      ${report.mainFinalStage}`);
  console.log(`  界面渲染阶段    ${String(report.rendererFinalStageAttr)}`);
  console.log(`  渲染层更新卡片  ${String(report.rendererHasUpdateCard)}`);
  console.log('  服务端收到的请求：');
  for (const r of requests) console.log(`    ${r}`);
  if (report.failures.length > 0) {
    console.log('  失败项：');
    for (const f of report.failures) console.log(`    - ${f}`);
  }
  console.log(`  假安装包 sha512（前 16 位）${feed.sha512.slice(0, 16)}…`);
  console.log(`  exe ${exe}`);
  console.log(report.ok ? '\n✅ 更新链路端到端通过' : '\n❌ 更新链路端到端失败');
}

await main();
