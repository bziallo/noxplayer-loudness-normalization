#!/usr/bin/env node
/* ================================================================
 * probe/loudness/check.mjs — dependency-light checks for the loudness
 * normalization engine. Run after `yarn`:
 *
 *     node probe/loudness/check.mjs
 *
 * The modules under src/utils/audio/loudness are plain TypeScript, so this
 * script transpiles them with the repo's own `typescript` devDependency into
 * os.tmpdir() and imports the result. Nothing here touches the extension, the
 * network or B站:
 *
 *   1. sidx parser        — synthetic index boxes, the `first_offset` anchor
 *   2. BS.1770            — K-weighting vs ITU-R BS.1770-4, gating, true peak
 *   3. gain planner       — clipping budget / profile caps
 *   4. sampler end to end — local Range server + stubbed decoder, verifying
 *                           that every requested byte offset really is a moof
 *                           box and that a too-short stream is rejected
 * ================================================================ */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SRC = path.join(REPO, 'src', 'utils', 'audio', 'loudness');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'nox-loudness-probe-'));

const ts = require(path.join(REPO, 'node_modules', 'typescript', 'lib', 'typescript.js'));

const MODULES = ['types.ts', 'config.ts', 'sidx.ts', 'bs1770.ts', 'gainPlanner.ts', 'sampler.ts'];

fs.writeFileSync(
  path.join(OUT, 'logger.mjs'),
  `export const logger = { debug() {}, info() {}, log() {}, notice() {}, warn() {}, error() {} };
export default logger;
`,
);

MODULES.forEach((file) => {
  const js = ts
    .transpileModule(fs.readFileSync(path.join(SRC, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      fileName: file,
    })
    .outputText.replace(/from ['"]\.\/([\w-]+)['"]/g, "from './$1.mjs'")
    .replace(/from ['"]@utils\/Logger['"]/g, "from './logger.mjs'");
  fs.writeFileSync(path.join(OUT, file.replace(/\.ts$/, '.mjs')), js);
});

const load = (name) => import(pathToFileURL(path.join(OUT, `${name}.mjs`)).href);
const { getProfile } = await load('config');
const { findBox, parseSidx, pickCoarse, pickEvenly, startsWithBox, verifySidx } = await load('sidx');
const { highPassCoeffs, highShelfCoeffs, measureLoudness } = await load('bs1770');
const { planGain } = await load('gainPlanner');
const { sampleStreamLoudness } = await load('sampler');

let pass = 0;
let failed = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  \u2713 ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `  ${detail}` : ''}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

/* ------------------------------------------------------------ helpers */

function buildSidxBox({ version = 0, timescale = 48000, firstOffset = 0, durations, sizes }) {
  const count = durations.length;
  const total = 8 + 4 + 4 + 4 + (version === 1 ? 16 : 8) + 2 + 2 + count * 12;
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  let p = 0;
  view.setUint32(p, total);
  p += 4;
  'sidx'.split('').forEach((c) => {
    view.setUint8(p, c.charCodeAt(0));
    p += 1;
  });
  view.setUint8(p, version);
  p += 4; // version + flags
  view.setUint32(p, 1);
  p += 4; // reference_ID
  view.setUint32(p, timescale);
  p += 4;
  if (version === 1) {
    view.setUint32(p, 0);
    p += 4;
    view.setUint32(p, 0);
    p += 4;
    view.setUint32(p, 0);
    p += 4;
    view.setUint32(p, firstOffset);
    p += 4;
  } else {
    view.setUint32(p, 0);
    p += 4;
    view.setUint32(p, firstOffset);
    p += 4;
  }
  view.setUint16(p, 0);
  p += 2;
  view.setUint16(p, count);
  p += 2;
  for (let i = 0; i < count; i += 1) {
    view.setUint32(p, sizes[i] & 0x7fffffff);
    p += 4;
    view.setUint32(p, durations[i]);
    p += 4;
    view.setUint32(p, 0);
    p += 4;
  }
  return bytes;
}

const sine = (frames, fs, freq, amp) => {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs);
  return out;
};

const magnitudeDb = (c, fs, freq) => {
  const w = (2 * Math.PI * freq) / fs;
  const re = c.b0 + c.b1 * Math.cos(-w) + c.b2 * Math.cos(-2 * w);
  const im = c.b1 * Math.sin(-w) + c.b2 * Math.sin(-2 * w);
  const dre = 1 + c.a1 * Math.cos(-w) + c.a2 * Math.cos(-2 * w);
  const dim = c.a1 * Math.sin(-w) + c.a2 * Math.sin(-2 * w);
  return 20 * Math.log10(Math.hypot(re, im) / Math.hypot(dre, dim));
};

/** writes a valid fMP4: ftyp + free + sidx + N moof segments */
function craftFile({ initLength, segments, segmentSize, durations }) {
  const sidxBox = buildSidxBox({ durations, sizes: durations.map(() => segmentSize) });
  const bytes = new Uint8Array(initLength + sidxBox.length + segments * segmentSize);
  bytes.set(new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112]), 0);
  const freeSize = initLength - 32;
  bytes.set(
    new Uint8Array([
      (freeSize >>> 24) & 0xff,
      (freeSize >>> 16) & 0xff,
      (freeSize >>> 8) & 0xff,
      freeSize & 0xff,
      102,
      114,
      101,
      101,
    ]),
    32,
  );
  bytes.set(sidxBox, initLength);
  for (let i = 0; i < segments; i += 1) {
    const at = initLength + sidxBox.length + i * segmentSize;
    bytes.set(
      new Uint8Array([
        (segmentSize >>> 24) & 0xff,
        (segmentSize >>> 16) & 0xff,
        (segmentSize >>> 8) & 0xff,
        segmentSize & 0xff,
        109,
        111,
        111,
        102,
      ]),
      at,
    );
  }
  return { bytes, sidxLength: sidxBox.length, anchor: initLength + sidxBox.length };
}

function serve(fileBytes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const range = req.headers.range;
    requests.push(range);
    const [s, e] = (range || '').replace('bytes=', '').split('-');
    const start = Number(s) || 0;
    const end = e ? Math.min(Number(e), fileBytes.length - 1) : fileBytes.length - 1;
    const body = fileBytes.slice(start, end + 1);
    res.writeHead(range ? 206 : 200, {
      'Content-Range': `bytes ${start}-${end}/${fileBytes.length}`,
      'Content-Length': body.length,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(Buffer.from(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/a.m4a` }),
    );
  });
}

class FakeAudioBuffer {
  constructor(channels, sampleRate) {
    this.channels = channels;
    this.sampleRate = sampleRate;
    this.numberOfChannels = channels.length;
    this.length = channels[0].length;
  }

  getChannelData(i) {
    return this.channels[i];
  }
}

globalThis.__probeDecoder = { initLength: 0, audit: [], fail: false };
globalThis.OfflineAudioContext = class {
  decodeAudioData(bytes) {
    const cfg = globalThis.__probeDecoder;
    const view = new Uint8Array(bytes);
    cfg.audit.push({
      size: view.length,
      box:
        cfg.initLength + 8 <= view.length
          ? String.fromCharCode(
              view[cfg.initLength + 4],
              view[cfg.initLength + 5],
              view[cfg.initLength + 6],
              view[cfg.initLength + 7],
            )
          : '(too short)',
    });
    if (cfg.fail) return Promise.reject(new Error('Unable to decode audio data'));
    const fs = 48000;
    const amp = 10 ** (-23 / 20);
    return Promise.resolve(
      new FakeAudioBuffer(
        [sine(fs * 5, fs, 1000, amp), sine(fs * 5, fs, 1000, amp)],
        fs,
      ),
    );
  }
};
const installDecoder = (initLength, fail = false) => {
  globalThis.__probeDecoder = { initLength, audit: [], fail };
  return globalThis.__probeDecoder.audit;
};

/* ------------------------------------------------------------- tests */

function testSidx() {
  section('1. sidx parser');
  const durations = Array.from({ length: 43 }, () => 5 * 48000);
  const sizes = Array.from({ length: 43 }, (_, i) => 140000 + i * 137);
  const firstOffset = 1661;
  const box = buildSidxBox({ durations, sizes, firstOffset });
  const parsed = parseSidx(box, 0);

  check('43 refs parsed', parsed.refs.length === 43, `${parsed.refs.length}`);
  check('first offset honours first_offset', parsed.refs[0].offset === firstOffset);
  const sizeSum = sizes.reduce((a, b) => a + b, 0);
  check('offset closure', parsed.endOffset === firstOffset + sizeSum);
  check('verify() accepts the right length', verifySidx(parsed, firstOffset + sizeSum).ok === true);
  check('verify() rejects a wrong length', verifySidx(parsed, firstOffset + sizeSum + 7).ok !== true);

  const anchored = parseSidx(box, 1482);
  check('the first_offset anchor shifts every segment', anchored.refs[0].offset === 1482 + firstOffset);

  const picks = pickEvenly(parsed.refs, 12);
  check('pickEvenly(12) includes segment 0', picks.length === 12 && picks[0] === 0);
  const coarse = pickCoarse(picks, 6);
  check('pickCoarse(6) still covers both ends', coarse[0] === picks[0] && coarse[6 - 1] === picks[11]);
  check('null input -> null', parseSidx(null, 0) === null);
  check("startsWithBox('moof')", startsWithBox(new Uint8Array([0, 0, 7, 200, 109, 111, 111, 102]), 'moof') === true);
  check('findBox locates a box', findBox(box, 'sidx').offset === 0);
}

async function testBs1770() {
  section('2. K weighting + BS.1770 integrated loudness');
  const fs = 48000;
  const official = {
    shelf: { b0: 1.53512485958697, b1: -2.69169618940638, b2: 1.19839281085285, a1: -1.69065929318241, a2: 0.73248077421585 },
    hpf: { b0: 1.0, b1: -2.0, b2: 1.0, a1: -1.99004745483398, a2: 0.99007225036621 },
  };
  const freqs = [20, 50, 100, 500, 1000, 1681.97, 3000, 6000, 10000, 16000];
  const maxShelf = Math.max(...freqs.map((f) => Math.abs(magnitudeDb(highShelfCoeffs(fs), fs, f) - magnitudeDb(official.shelf, fs, f))));
  const maxHpf = Math.max(...freqs.map((f) => Math.abs(magnitudeDb(highPassCoeffs(fs), fs, f) - magnitudeDb(official.hpf, fs, f))));
  check('shelf response matches ITU-R BS.1770-4 (<0.02 dB)', maxShelf < 0.02, `max ${maxShelf.toFixed(4)} dB`);
  check('high pass response matches ITU-R BS.1770-4 (<0.02 dB)', maxHpf < 0.02, `max ${maxHpf.toFixed(4)} dB`);

  const amp = 10 ** (-20 / 20);
  const ch = sine(fs * 30, fs, 1000, amp);
  const kw = magnitudeDb(highShelfCoeffs(fs), fs, 1000) + magnitudeDb(highPassCoeffs(fs), fs, 1000);
  const mono = await measureLoudness({ channels: [ch], sampleRate: fs });
  const stereo = await measureLoudness({ channels: [ch, ch.slice()], sampleRate: fs });
  check('mono matches the analytic prediction', Math.abs(mono.lufs - (-0.691 + 20 * Math.log10(amp) - 3.0103 + kw)) < 0.1, `${mono.lufs}`);
  check('stereo matches the analytic prediction', Math.abs(stereo.lufs - (-0.691 + 20 * Math.log10(amp) + kw)) < 0.1, `${stereo.lufs}`);
  check('channels are summed, not averaged (+3.01 dB)', Math.abs(stereo.lufs - mono.lufs - 3.0103) < 0.02);
  check('true peak == -20 dBTP', Math.abs(stereo.truePeakDb + 20) < 0.1, `${stereo.truePeakDb}`);

  const mixed = new Float32Array(fs * 20);
  for (let i = fs * 10; i < mixed.length; i += 1) mixed[i] = amp * Math.sin((2 * Math.PI * 1000 * i) / fs);
  const gated = await measureLoudness({ channels: [mixed, mixed.slice()], sampleRate: fs });
  check('silence is dropped by the absolute gate', gated.blocksAfterAbsGate > 80 && gated.blocksAfterAbsGate < 120, `${gated.blocksAfterAbsGate}/${gated.blocks}`);
  check('level is unaffected by the added silence', Math.abs(gated.lufs - stereo.lufs) < 0.5, `${Math.abs(gated.lufs - stereo.lufs).toFixed(3)} dB`);
}

function testGainPlanner() {
  section('3. gain planner');
  const standard = getProfile('standard');
  const cases = [
    { name: 'already normalized -> trim', input: { measuredLufs: -13.5, truePeakDb: 1.1 }, gain: -0.5 },
    { name: 'source already clips -> no boost, no penalty', input: { measuredLufs: -18.69, truePeakDb: 0.79 }, gain: 0 },
    { name: 'headroom left -> clipping budget applies', input: { measuredLufs: -24, truePeakDb: -6 }, gain: 5 },
    { name: 'quiet and low peak -> profile cap applies', input: { measuredLufs: -30, truePeakDb: -20 }, gain: 12 },
    { name: 'too loud -> attenuation, peak irrelevant', input: { measuredLufs: -8, truePeakDb: -3 }, gain: -6 },
    { name: 'no measurement -> 0 dB', input: { measuredLufs: null, truePeakDb: null }, gain: 0 },
  ];
  cases.forEach((c) => {
    const { gainDb } = planGain(c.input, standard);
    check(`${c.name}: ${c.gain} dB`, gainDb === c.gain, `got ${gainDb}`);
  });
}

async function testSampler() {
  section('4. sampler end to end (local Range server, stubbed decoder)');
  const duration = 5 * 48000;
  const crafted = craftFile({
    initLength: 32600,
    segments: 100,
    segmentSize: 8000,
    durations: Array.from({ length: 100 }, () => duration),
  });
  check('sidx box is larger than the 32 KiB head window', crafted.anchor > 32768);

  /* the init fragment is everything before the sidx box */
  const audit = installDecoder(32600);
  const { server, requests, url } = await serve(crafted.bytes);
  const measured = await sampleStreamLoudness(url);

  check('12 segments measured', measured.segments === 12, `${measured.segments}`);
  check('every decoded fragment is init + one moof box', audit.every((a) => a.box === 'moof'));
  check('a second Range request fetched the rest of the sidx', requests.length === 14, `${requests.length}`);
  check('second request continues right after the head window', requests[1] === `bytes=32768-${crafted.anchor - 1}`, requests[1]);
  check('all media requests stay inside the media area', requests.slice(2).every((r) => Number(r.replace('bytes=', '').split('-')[0]) >= crafted.anchor));
  await new Promise((r) => server.close(r));

  installDecoder(32600, true);
  const tiny = craftFile({
    initLength: 32600,
    segments: 20,
    segmentSize: 8000,
    durations: Array.from({ length: 20 }, () => duration),
  });
  const shortFile = tiny.bytes.slice(0, 32600 + tiny.sidxLength + 8000 * 2);
  const partial = await serve(shortFile);
  let threw = false;
  try {
    await sampleStreamLoudness(partial.url);
  } catch (e) {
    threw = true;
  }
  check('refuses to report a level from fewer than 3 segments', threw);
  await new Promise((r) => partial.server.close(r));
}

/* -------------------------------------------------------------- main */

testSidx();
await testBs1770();
testGainPlanner();
await testSampler();
console.log(`\n${pass} passed, ${failed} failed`);
if (failed) {
  console.log('failed:', failures.join(' | '));
  process.exitCode = 1;
}
fs.rmSync(OUT, { recursive: true, force: true });
