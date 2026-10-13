# 电闹播放器 · 响度归一

把 B 站视频/音频的**整段响度**测出来，只施加**一个固定增益**，让连播时音量一致 ——
**不做实时压缩、不做限幅**，素材自身的动态范围原样保留。

本项目是第三方播放器 [电闹播放器 / NoxPlayer](https://github.com/lovegaoshi/NoxPlayer) 的一个功能补丁，
包含**补丁、设计与实测文档、自检脚本、以及可直接加载的预构建包**。
响度算法移植自油猴脚本 [Bilibili_LoudNorm](https://github.com/ADMA200/Bilibili_LoudNorm)（MIT）。

---

## 它解决什么问题

B 站自己的「音量均衡」**默认关闭**，而且只覆盖**带响度元数据**的视频；
第三方播放器又拿不到这些元数据，于是连播时忽大忽小：

| | 现象 |
|---|---|
| 老 MV / 投稿 | 偏响 |
| 播客 / 录屏 / 长视频 | 偏轻 |
| 已经响度压缩过的素材 | 真峰值过 0 dBTP，一提升就爆 |

NoxPlayer 原本用 ffmpeg.wasm 的 `replaygain` 处理这个问题：要把**整条音频**下载下来（110 分钟的视频 ≈ 54 MB）
再全片解码，慢；而且只能衰减（`audio.volume` 上限是 1.0），比目标响度轻的素材抬不起来。

这个补丁换成「**索引抽样 + BS.1770 + 单个常数增益**」：

| | 原 ffmpeg 路径 | 本项目（抽样路径） |
|---|---|---|
| 单曲成本 | 整条音频（长视频 54 MB） | **≈ 0.5 MB**（110 分钟视频实测占 0.91%） |
| 增益方向 | 只能衰减 | **可升可降** |
| 动态范围 | 保持 | 保持（一个常数增益，无压缩器） |
| 落位方式 | 写 `audio.volume`（会污染用户音量） | Web Audio `GainNode`，与音量滑块互不干扰 |
| 缓存 | 有（ReplayGain 口径） | 有（存「这首歌多响」，换档案不用重测） |

---

## 效果与验收

在播放器里连播两首响度差很大的视频：

- **切换瞬间不应有明显音量跳变**（命中缓存时从第一个采样就是正确音量；未命中时先原声、120 ms 斜坡落位，并会预取下一首）；
- **单个视频内部的爆炸声、音乐起伏应保留**（整首只有**一个**常数增益，`probe` 与手动 A/B 都在查这一点）。

实测数据（脚本直接跑 B 站接口与音频 CDN 得到）：

| 视频 | 时长 | sidx 索引 | 抽样 12 段的成本 | 校验 |
|---|---|---|---|---|
| `BV1GJ411x7h7` | 3.5 min | 43 段 × 5.0s，548 B | 311 KiB | 段偏移全部落在 `moof` 盒上 |
| `BV1muab6rEbA` | 110 min | 1323 段 × 5.0s，**15 916 B** | 482 KiB（**0.91%**） | `Σsize + anchor == Content-Length` |

算法口径校验：K 加权频响与 ITU-R BS.1770-4 官方 48 kHz 系数**逐点 0.0000 dB 偏差**；
1 kHz 正弦的测量值与解析预测差 < 0.01 dB；多声道按标准**求和**（同信号双声道比单声道高 3.01 dB）。

---

## 快速开始

### A. 直接用预构建包（不需要装任何工具链）

1. 到 [Releases](../../releases) 下载 `noxplayer-edge-4.5.2.0.zip` 并解压到固定目录（**之后不能移动**）；
2. Edge 打开 `edge://extensions/` → 打开左下角**开发人员模式** → **加载解压缩的扩展** → 选解压出来的目录；
3. 点扩展图标会打开播放器页面 → 顶部「我的歌单」右侧的**齿轮** → 「播放器设置」→「设置」标签 →
   找到「**响度归一（整段测量 + 固定增益）**」并勾选。

> 该预构建包是在开发机上用等效链路构建的（见 `docs/`），版本与依赖已对齐上游 `yarn.lock`；
> 但**推荐长期使用下面的「自己构建」**，尤其是要上架或继续改代码时。

### B. 自己构建（推荐）

```bash
git clone https://github.com/lovegaoshi/NoxPlayer.git noxplayer
cd noxplayer && git checkout dev
git apply /path/to/patch/loudness-normalization.patch

git submodule update --init --recursive   # ① 缺了 webpack 会找不到 @APM
cp .env.example .env                      # ② 必需：dotenv-webpack 配了 safe:true
corepack enable && yarn                   # ③ 依赖（Yarn 4）
yarn build                                # ④ 产物在 build/
```

两个必踩的坑：

1. **`.env` 必须有**：`webpack.config.js` 里 `dotenv-webpack` 开了 `safe: true`，缺文件直接构建失败
   （占位值就够，只影响云同步那几个后端）；
2. `yarn build` 第二步是 `python3 ./scripts/moveFFMpeg.py --prod`，Windows 上通常只有 `python` ——
   报错时手动跑 `python ./scripts/moveFFMpeg.py --prod` 即可（`tools/build-edge.ps1` 会自动兜这个坑并打出 zip）。

构建完在 `edge://extensions/` 里「加载解压缩的扩展」选 `build/`。

---

## 怎么用

- **入口**：播放器页面顶部「我的歌单」右侧的**齿轮** → 「播放器设置」→「设置」→「响度归一」；
- **档案（6 档）**：

  | 档案 | 目标响度 | 增益上限 | 适用 |
  |---|---|---|---|
  | 标准（默认） | −14 LUFS | +12 dB | 对齐 B 站「标准」档，已归一的内容增益≈0 |
  | 高动态 | −24 LUFS | +12 dB | 对齐 B 站「高动态」档 |
  | 耳机 | −16 LUFS | +12 dB | 夜间耳塞 |
  | 外放 | −11 LUFS | +10 dB | 手机外放 / 小音箱 |
  | 深夜 | −20 LUFS | +6 dB | 怕吵到人 |
  | 自定义 | 滑条 | 滑条 | 目标响度 / 最大提升 / 最大衰减三个滑条 |

- **`Shift+B`**：旁路开关，用来做 A/B 对比（分析照跑、结果照存，切回来是瞬时的）；
- **调试句柄**（与油猴脚本的 `__biliLoudness` 一个路子），在播放器页面 F12 控制台里：

  ```js
  noxLoudness.getLastStatus()        // 实测 LUFS / 目标 / 施加的增益 / 工作模式
  noxLoudness.engine.getGainValue()  // 当前线性增益：整首播放期间应是一个常数
  noxLoudness.engine.getMode()       // 'gain-node' | 'volume' | 'off'
  ```

---

## 原理

```
musicSrcParser(song)                        ← 播放器换 src 之前
  ├─ 命中内存缓存 → 立刻写 GainNode，曲目从第 0 个采样就是正确音量
  ├─ 未命中       → 先 0 dB（原声），异步测量后再落位
  └─ B站 CDN 源   → 顺手把 <audio> 设成 crossOrigin='anonymous'

测量（不阻塞播放）
  ① Range 取前 32KiB → 解析 fMP4 的 sidx 索引（超大索引再补一次 Range）
  ② 全片均匀抽 12 段（首段必取），限速并发 6，段超时 5s 重试 1 次
  ③ 每段拼 `init + 单个 moof` → decodeAudioData（离线上下文，不碰输出）
  ④ K 加权 → 400ms/100ms 分块 → 绝对门限(−70 LUFS) → 相对门限(−10 LU)
     → 集成响度(LUFS) + 真峰值(dBTP)
  ⑤ 首批满 4 段先落一次初值（覆盖 0–100% 时间轴），补齐 12 段后精修

定额
  gain = 档案目标 − 实测响度，然后：
     · 只限制**提升**：`真峰值 ≤ −1 dBTP`（衰减永远放行，不会造成削波）
     · 再夹档案的增益上下限

落位
  <audio> ─► MediaElementAudioSourceNode ─► GainNode(10^(dB/20)) ─► destination
                                              ▲ setTargetAtTime，τ=40ms（≈120ms 落位）
  元素自身 volume（播放器滑块）按 Web Audio 规范仍然生效，两者相乘
```

**降级链**：GainNode 接管 → 元素音量（只能衰减，且会拦住播放器把归一音量存成「用户默认音量」）→ 维持原声。
**直播**（无固定时长、无 DASH 索引）不处理。

---

## 测试与验证

仓库内自带零依赖自检（会先用仓库自己的 `typescript` 即时转译源码，不联网、不碰扩展）：

```bash
yarn                                  # 需要 devDependency typescript
node probe/loudness/check.mjs         # 期望：32 passed, 0 failed
```

覆盖：sidx 解析（含 `first_offset` 基准点这个经典坑）、K 加权与 ITU-R BS.1770-4 官方系数比对、
多声道求和、绝对/相对门限、真峰值不被加权污染、增益规划（含「素材已过峰不倒扣音量」的实测反例）、
以及采样器端到端（本地 Range 服务器 + 桩解码器：**校验每个请求到的字节偏移真的是 `moof` 盒**、
索引超过头部窗口时补第二次 Range、可用段数 < 3 段时**拒绝给结果**而不是瞎猜）。

手动验收步骤见 [`docs/02-实现说明与PR.md`](docs/02-实现说明与PR.md) 第 4 节。

---

## 与上游的关系 / 怎么合并

补丁基于 `lovegaoshi/NoxPlayer` 的 `dev` 分支（基线 commit `90e942f`），改动 25 个文件：

```bash
git apply patch/loudness-normalization.patch          # 一次应用
# 或保留提交信息：
git am patch/loudness-normalization-commits.patch     # 三个提交
```

新增文件集中在 `src/utils/audio/loudness/`（响度核心 + 采样器 + 增益图 + 编排）、
`src/utils/db/{schema/loudnessTable.ts,loudnessStorage.ts}`、`src/components/setting/LoudnessSetting.tsx`，
另有 `drizzle/` 迁移、`src/NoxTypes/loudness.d.ts` 类型合并、`probe/loudness/` 自检。
**没有改 `azusa-player-mobile` 子模块**，也没有新增任何扩展权限。

---

## 已知限制

- **纯线性增益，没有压缩器/限幅器**：只会把整体平移；已过峰（真峰值 > 0 dBTP）的素材**不提升也不倒扣**，
  所以它不会改变动态，但也修不好已经爆音的素材；
- **首播要等几百毫秒**（抽样 + 解码），期间播原声；看过的视频命中缓存瞬时落位；
- **抽样是统计估计**：极端不均匀的素材可能偏 1–2 LU（12 段均匀覆盖 0%–100% 时间轴）；
- **不支持直播**；拿不到 DASH（只有 `durl`，例如试看片段）时保持原声；
- 音频档解不出来（例如个别 FLAC/Hi-Res 源）时该次归一会被放弃 —— 可在设置里改用「ffmpeg 全片」测量。

---

## 许可与致谢

- 本仓库的补丁修改了 AGPL-3.0 的 NoxPlayer 源码，因此按 **AGPL-3.0** 发布，见 [`LICENSE`](LICENSE)；
- 响度测量算法移植自 **[Bilibili_LoudNorm](https://github.com/ADMA200/Bilibili_LoudNorm)**（MIT，(c) 2026 Moxia9527），
  移植文件的头部都保留了出处与许可声明；
- 播放内核为 **[lovegaoshi/react-music-player](https://github.com/lovegaoshi/react-music-player)**（MIT fork）；
- 详细分工与第三方清单见 [`NOTICE.md`](NOTICE.md)。

**本项目与 B 站官方无关**，仅供个人学习与自用；请遵守 B 站的使用条款，不要用它做批量下载或账号滥用。
