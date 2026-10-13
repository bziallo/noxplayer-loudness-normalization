# probe/loudness

依赖极少的自检脚本，验证 `src/utils/audio/loudness/` 这套「整段测量 + 固定增益」引擎。

```bash
yarn                                    # 需要 devDependency typescript
node probe/loudness/check.mjs
```

脚本会用仓库自带的 `typescript` 把响度模块即时转译到 `os.tmpdir()` 再 import，
**不联网、不碰扩展、也不碰 B 站**（音源要么是构造出来的 fMP4，要么是本地 HTTP 服务）。

覆盖内容：

1. **sidx 解析**：合成索引盒、`first_offset` 基准点、抽取策略（`pickEvenly` / `pickCoarse`）；
2. **BS.1770**：K 加权频响与 ITU-R BS.1770-4 官方 48kHz 系数逐点对比、多声道求和（+3.01 dB）、
   绝对/相对门限、真峰值不被加权污染；
3. **增益规划**：削波预算只限制提升、档案上下限、素材已过峰时不倒扣音量；
4. **采样器端到端**：本地 Range 服务器 + 桩解码器，校验「请求到的每个字节偏移真的是 moof 盒」、
   索引盒超过头部窗口时会补第二次 Range 请求、可用段数不足 3 段时拒绝给出结果。

真机验收（切换两首音量差很大的视频、确认动态未被压平）见提交说明。
