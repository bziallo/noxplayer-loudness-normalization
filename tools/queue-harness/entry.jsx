/* 无头浏览器里挂载真正的播放内核（react-jinke-music-player），
 * 验证"播放列表面板顺序 == 实际播放顺序"和"重排队列不打断当前播放"。
 * 只在本机测试用，不参与扩展打包。
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import ReactJkMusicPlayer from 'react-jinke-music-player';

const caller = { load: 0, play: 0, pause: 0 };
window.__caller = caller;
const origLoad = HTMLMediaElement.prototype.load;
const origPlay = HTMLMediaElement.prototype.play;
const origPause = HTMLMediaElement.prototype.pause;
HTMLMediaElement.prototype.load = function loadMock() {
  caller.load += 1;
  return origLoad.call(this);
};
HTMLMediaElement.prototype.play = function playMock() {
  caller.play += 1;
  return Promise.resolve();
};
HTMLMediaElement.prototype.pause = function pauseMock() {
  caller.pause += 1;
  return Promise.resolve();
};

const KEY = '__PLAYER_KEY__';

const makeSongs = (n, prefix = 'a') =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}id${i}`,
    bvid: `${prefix}bv${i}`,
    name: `${prefix}song${i}`,
    singer: 'singer',
    cover: '',
    duration: 100,
    [KEY]: `${prefix}bv${i}-${prefix}id${i}`,
  }));

const baseProps = {
  mode: 'full',
  showThemeSwitch: false,
  showLyric: false,
  toggleMode: false,
  locale: 'zh_CN',
  autoPlayInitLoadPlayList: true,
  autoPlay: false,
  defaultPlayIndex: 0,
  theme: 'dark',
  showMediaSession: false,
  remove: true,
  musicSrcParser: async (song) => {
    // 真正的播放器会解析成 CDN 地址；这里用一个稳定的假地址
    return `mock://${song.id}`;
  },
  getAudioInstance: (inst) => {
    window.__audioInst = inst;
  },
};

const audio = () => document.querySelector('audio');

/** 当前这首歌在队列里的位置（不依赖 key 具体值） */
const pos = (playId = window.__mp.state.playId) =>
  (window.__mp.state.audioLists || []).findIndex(
    (a) => a[KEY] === playId,
  );

const snapshot = () => {
  const mp = window.__mp;
  const el = audio();
  return {
    order: (mp.state.audioLists || []).map((a) => a.name),
    playId: mp.state.playId,
    playIndex: mp.state.playIndex,
    musicSrc: mp.state.musicSrc,
    name: mp.state.name,
    src: el ? el.getAttribute('src') : null,
    currentTime: el ? el.currentTime : null,
    caller: { ...window.__caller },
    panelOrder: Array.from(
      document.querySelectorAll(
        '.audio-lists-panel-content .player-name',
      ),
    ).map((e) => e.getAttribute('title') || e.textContent),
  };
};

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function App() {
  const [props, setProps] = React.useState({
    ...baseProps,
    audioLists: [],
  });
  window.__setProps = (next) =>
    setProps((prev) => ({ ...prev, ...next }));
  return (
    <ReactJkMusicPlayer
      {...props}
      ref={(el) => {
        window.__mp = el;
      }}
    />
  );
}

const results = [];
const check = (name, pass, extra) =>
  results.push({ name, pass: !!pass, extra });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

window.__run = async () => {
  results.length = 0;
  // 追踪 playIndex 是谁改的（调试用）
  const mp = window.__mp;
  window.__trace = [];
  if (!mp.__traced) {
    const orig = mp.setState.bind(mp);
    mp.setState = (partial, cb) => {
      const p = typeof partial === 'function' ? partial(mp.state, mp.props) : partial;
      if (p && 'playIndex' in p) {
        window.__trace.push({
          playIndex: p.playIndex,
          musicSrc: String(p.musicSrc ?? '').slice(0, 24),
        });
      }
      return orig(partial, cb);
    };
    mp.__traced = true;
  }
  const q6a = makeSongs(6, 'a');
  const q6b = makeSongs(6, 'b');
  const q6c = makeSongs(6, 'c');
  const q4d = makeSongs(4, 'd');

  // ---------- A. 随机模式：播放顺序必须等于面板顺序 ----------
  window.__setProps({
    audioLists: q6a,
    playMode: 'shufflePlay',
    shuffleAlongAudioLists: true,
    clearPriorAudioLists: true,
    quietUpdate: true,
    newAudioListPlayIndex: 0,
  });
  await tick(150);
  const a0 = snapshot();
  const seqA = [];
  for (let i = 0; i < 5; i += 1) {
    window.__audioInst.playNext();
    // eslint-disable-next-line no-await-in-loop
    await tick(60);
    seqA.push(pos());
  }
  const expectA = [1, 2, 3, 4, 5];
  check('A1 随机模式：下一首按队列顺序（面板=播放顺序）', same(seqA, expectA), {
    got: seqA,
    want: expectA,
  });
  window.__audioInst.playNext();
  await tick(80);
  check('A2 随机模式：一轮播完后回到队列第一首', pos() === 0, {
    pos: pos(),
  });

  // ---------- A'. 关掉"预定随机"时保持内核原来的随机（默认行为没被破坏） ----------
  window.__setProps({
    audioLists: q6b,
    playMode: 'shufflePlay',
    shuffleAlongAudioLists: false,
    clearPriorAudioLists: true,
    quietUpdate: true,
    newAudioListPlayIndex: 0,
  });
  await tick(150);
  const seqA2 = [];
  for (let i = 0; i < 4; i += 1) {
    window.__audioInst.playNext();
    // eslint-disable-next-line no-await-in-loop
    await tick(60);
    seqA2.push(pos());
  }
  check(
    "A' 关掉预定随机后仍是内核自己的随机（不影响默认行为）",
    !same(seqA2, [1, 2, 3, 4]),
    { got: seqA2 },
  );

  // ---------- B. 只重排队列：当前这首不能被打断 ----------
  window.__setProps({
    audioLists: q6c,
    playMode: 'shufflePlay',
    shuffleAlongAudioLists: true,
    clearPriorAudioLists: true,
    quietUpdate: true,
    newAudioListPlayIndex: 2,
  });
  await tick(200);
  const el = audio();
  el.currentTime = 42;
  const before = snapshot();
  const beforeCaller = { ...before.caller };

  // 重排成 [3, 0, 2, 5, 4, 1]：当前这首（index 2）挪到新顺序的 index 2
  const reordered = [q6c[3], q6c[0], q6c[2], q6c[5], q6c[4], q6c[1]];
  window.__setProps({
    audioLists: reordered,
    clearPriorAudioLists: true,
    quietUpdate: true,
    newAudioListPlayIndex: 2,
    keepCurrentAudioInList: true,
  });
  await tick(250);
  const after = snapshot();

  check(
    'B1 重排后：面板顺序 = 新队列顺序',
    same(after.order, reordered.map((s) => s.name)),
    { got: after.order, want: reordered.map((s) => s.name) },
  );
  check(
    'B2 重排后：面板上高亮/显示的顺序与队列一致',
    same(after.panelOrder, after.order),
    { panel: after.panelOrder, order: after.order },
  );
  check(
    'B3 重排后：还是这首在播（playId 不变）',
    after.playId === before.playId,
    { before: before.playId, after: after.playId },
  );
  check(
    'B4 重排后：播放位置（进度）没被清零',
    after.currentTime === before.currentTime && after.currentTime === 42,
    { before: before.currentTime, after: after.currentTime },
  );
  check(
    'B5 重排后：没有重新加载音频（src 不变、没调用 load/play）',
    after.src === before.src &&
      after.caller.load === beforeCaller.load &&
      after.caller.play === beforeCaller.play,
    { before: before.src, after: after.src, caller: after.caller },
  );
  check(
    'B6 重排后：播放索引跟着这首歌走（能继续"下一首"）',
    after.playIndex === 2,
    { got: after.playIndex },
  );
  window.__audioInst.playNext();
  await tick(80);
  check(
    'B7 重排后"下一首"走的是新队列的下一首',
    pos() === 3 && window.__mp.state.name === q6c[5].name,
    { pos: pos(), name: window.__mp.state.name, want: q6c[5].name },
  );

  // ---------- C. 换成另一张歌单（真正的切歌）还是要正常换 ----------
  window.__setProps({
    audioLists: q4d,
    clearPriorAudioLists: true,
    quietUpdate: true,
    newAudioListPlayIndex: 3,
    keepCurrentAudioInList: false,
  });
  await tick(250);
  const afterC = snapshot();
  check(
    'C1 换歌单：面板顺序 = 新歌单顺序',
    same(afterC.order, q4d.map((s) => s.name)),
    { got: afterC.order },
  );
  check(
    'C2 换歌单：加载的是指定的那一首',
    afterC.musicSrc === `mock://${q4d[3].id}` && afterC.name === q4d[3].name,
    { got: afterC.musicSrc, want: `mock://${q4d[3].id}` },
  );
  check(
    'C3 换歌单：playIndex 指向这首歌',
    afterC.playIndex === 3 && pos(afterC.playId) === 3,
    {
      playIndex: afterC.playIndex,
      pos: pos(afterC.playId),
      trace: window.__trace,
    },
  );

  // ---------- D. 随机开关切换（只重排，不切断当前播放） ----------
  const q6e = makeSongs(6, 'e');
  window.__setProps({
    audioLists: q6e,
    playMode: 'order',
    shuffleAlongAudioLists: false,
    clearPriorAudioLists: true,
    quietUpdate: true,
    newAudioListPlayIndex: 0,
    keepCurrentAudioInList: false,
  });
  await tick(200);
  const elD = audio();
  elD.currentTime = 17;
  const beforeD = snapshot();
  const shuffledE = [q6e[4], q6e[1], q6e[5], q6e[0], q6e[3], q6e[2]];
  // 宿主切到随机：队列换成预排好的随机顺序，当前这首继续播
  window.__setProps({
    audioLists: shuffledE,
    playMode: 'shufflePlay',
    shuffleAlongAudioLists: true,
    clearPriorAudioLists: true,
    quietUpdate: true,
    newAudioListPlayIndex: 3,
    keepCurrentAudioInList: true,
  });
  await tick(250);
  const afterD = snapshot();
  check(
    'D1 切到随机：面板立刻变成随机顺序',
    same(afterD.order, shuffledE.map((s) => s.name)),
    { got: afterD.order },
  );
  check(
    'D2 切到随机：当前这首没被打断（进度/歌曲不变）',
    afterD.playId === beforeD.playId &&
      afterD.currentTime === 17 &&
      afterD.caller.load === beforeD.caller.load,
    { before: beforeD.playId, after: afterD.playId, t: afterD.currentTime },
  );
  window.__audioInst.playNext();
  await tick(80);
  check(
    'D3 切到随机后：接着播的是随机顺序里的下一首',
    pos() === 4 && window.__mp.state.name === q6e[3].name,
    { pos: pos(), name: window.__mp.state.name, want: q6e[3].name },
  );

  return results;
};

createRoot(document.getElementById('root')).render(<App />);
