# queue-harness：把真播放内核挂进无头浏览器验证

改播放队列的逻辑肉眼很难确认（面板顺序 / 当前歌 / 进度），所以这套脚本把**真的**
`react-jinke-music-player`（打了 `patch/rjkm-fork-queue-sync.patch` 的那份）挂进无头 Edge，
模拟宿主（电闹播放器）改 `audioLists` 并逐条断言。

```bash
node drive.mjs /path/to/NoxPlayer          # 需要有 node_modules（yarn install 过）
```

它会：

1. 把 `entry.jsx`、`index.html` 复制到 `<NoxPlayer>/_harness/`（临时文件，测试完可删）；
2. 用仓库里的 `esbuild` 打包（入口放在仓库内，`react` 等依赖才能解析）；
3. 起 headless Edge（`--headless=new`）→ 通过 CDP 调 `window.__run()` → 打印断言结果。

断言覆盖：

- 随机模式（`shuffleAlongAudioLists`）：面板顺序 = 播放顺序、"下一首"按队列走、一轮回到第一首；
- 默认行为没被破坏：不传这个开关时仍是内核自己的随机；
- 只重排（`keepCurrentAudioInList`）：`playId` 不变、`currentTime` 不清零、不重新加载音频、
  `playIndex` 跟着这首歌走、"下一首"走新队列；
- 换歌单：面板换新列表、加载指定的那首、`playIndex` 指向它。

> 需要 Edge（`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`），
> 路径不同就改 `drive.mjs` 顶部的 `EDGE`。
