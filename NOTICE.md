# 第三方组件与致谢

这个仓库是一个**补丁项目**：它修改 [lovegaoshi/NoxPlayer](https://github.com/lovegaoshi/NoxPlayer)
（一个第三方 B 站音频播放器扩展），并移植了另一个开源项目的响度算法。
下面是完整的来源与许可说明。

| 组件 | 来源 | 许可证 | 本仓库如何使用 |
|---|---|---|---|
| 电闹播放器 / NoxPlayer | https://github.com/lovegaoshi/NoxPlayer | **AGPL-3.0**（仓库 `LICENSE`；`package.json` 中标注为 MIT，以前者为准） | 补丁修改其源码；本仓库按 AGPL-3.0 发布 |
| Bilibili_LoudNorm（响度归一油猴脚本） | https://github.com/ADMA200/Bilibili_LoudNorm | **MIT**，(c) 2026 Moxia9527 | 响度测量算法（sidx 抽样、BS.1770 集成响度、真峰值、增益预算、Web Audio 增益图）移植为 TypeScript，见 `patch/` 中 `src/utils/audio/loudness/*`，每个文件头部保留出处声明 |
| react-jinke-music-player（播放内核 fork） | https://github.com/lovegaoshi/react-music-player | MIT | 上游依赖，未修改（自己构建时由 yarn 拉取） |
| azusa-player-mobile（解析/数据共享库） | https://github.com/lovegaoshi/azusa-player-mobile | AGPL-3.0 | 上游子模块，**本补丁未修改** |

## 关于 AGPL-3.0

MIT 代码可以并入 AGPL-3.0 工程（反向不行）。因为补丁修改了 AGPL-3.0 的 NoxPlayer 源码，
所以**整个补丁按 AGPL-3.0 分发**，同时保留 MIT 部分的版权与许可声明。
如果你要把这个补丁提交给上游，提交即可 —— 上游本来就是 AGPL-3.0 项目。

## 参考资料

- ITU-R BS.1770-4 / EBU R128（响度测量标准）
- ISO/IEC 14496-12（fMP4 `sidx` 索引盒格式）
- Web Audio API 规范中关于 `MediaElementAudioSourceNode` 与元素 `volume` 行为的说明
