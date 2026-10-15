/* 在无头 Edge 里挂载真播放内核，验证"队列顺序 = 播放顺序、重排不打断当前歌"。
 *
 *   node drive.mjs <打了补丁的 NoxPlayer 目录>
 *
 * 需要该目录已经 yarn/npm install 过（有 node_modules/esbuild、node_modules/react）。
 * 会把 entry.jsx / index.html 复制到 <nox>/_harness/，跑完可以删。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EDGE =
  process.env.EDGE_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.HARNESS_PORT ?? 9333);
const NOX = path.resolve(process.argv[2] ?? '.');
if (!fs.existsSync(path.join(NOX, 'node_modules'))) {
  console.error(`在 ${NOX} 里找不到 node_modules，先 yarn install`);
  process.exit(2);
}

// 1. 把测试入口放进仓库内，这样 esbuild 能解析到原来的 react/esbuild
const HARNESS = path.join(NOX, '_harness');
fs.mkdirSync(HARNESS, { recursive: true });
for (const f of ['entry.jsx', 'index.html']) {
  fs.copyFileSync(path.join(HERE, f), path.join(HARNESS, f));
}
execFileSync(
  process.execPath,
  [
    path.join(NOX, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(HARNESS, 'entry.jsx'),
    '--bundle',
    '--format=iife',
    '--jsx=automatic',
    `--outfile=${path.join(HARNESS, 'dist', 'app.js')}`,
    '--define:process.env.NODE_ENV="production"',
    '--log-level=warning',
  ],
  { stdio: 'inherit' },
);

// 2. headless Edge
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-harness-'));
const url = `file:///${path.join(HARNESS, 'index.html').replace(/\\/g, '/')}`;
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    url,
  ],
  { stdio: 'ignore' },
);
const sleep = ms => new Promise(r => setTimeout(r, ms));

try {
  let page = null;
  for (let i = 0; i < 60 && !page; i += 1) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`)
      ).json();
      page = list.find(
        t => t.type === 'page' && t.url.includes('_harness'),
      );
    } catch {
      /* 还没起来 */
    }
    // eslint-disable-next-line no-await-in-loop
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('headless edge 没打开测试页');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise(res => {
      const id = (seq += 1);
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable');
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const ready = await send('Runtime.evaluate', {
      expression: 'typeof window.__run === "function"',
      returnByValue: true,
    });
    if (ready?.result?.result?.value === true) break;
    // eslint-disable-next-line no-await-in-loop
    await sleep(250);
  }
  const out = await send('Runtime.evaluate', {
    expression: 'window.__run()',
    awaitPromise: true,
    returnByValue: true,
  });
  const results = out?.result?.result?.value;
  if (!Array.isArray(results)) {
    console.error('测试脚本没返回结果：', JSON.stringify(out).slice(0, 2000));
    process.exitCode = 1;
  } else {
    let failed = 0;
    results.forEach(r => {
      if (!r.pass) failed += 1;
      console.log(
        `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`,
        r.pass ? '' : JSON.stringify(r.extra),
      );
    });
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exitCode = failed ? 1 : 0;
  }
  ws.close();
} finally {
  try {
    edge.kill();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Windows 里偶尔被占用，忽略 */
  }
}
