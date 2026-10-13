> 说明：本文档写于开发过程中，文中的本机路径（例如 `C:\Users\...`）与
> 「outputs/」目录名请按你自己的环境替换；与代码一起看效果最好。

# 把「电闹播放器 + 响度归一」装进 Edge

## 一句话结论

电闹播放器**本身就是 Manifest V3 扩展**（`public/manifest.json`：`manifest_version: 3` + `service_worker`），
Edge 和 Chrome 共用同一套 Chromium 扩展机制，所以**不需要任何"转换"**：

> 把补丁打上 → 构建出 `build/` → Edge 里「加载解压缩的扩展」即可用；
> 想给别人用，就把 `build/` 打包成 zip 传到 Edge 加载项商店（Microsoft Partner Center）。

---

## 1. 为什么不用改代码

| 检查项 | 现状 | 结论 |
|---|---|---|
| manifest 版本 | `manifest_version: 3` | Edge 支持 MV3 ✓ |
| 背景页 | `"background": { "service_worker": "serviceWorker.js" }` | Edge 支持 SW 背景页 ✓ |
| API 用法 | 全程 `chrome.*` | Edge 兼容同一命名空间 ✓（`browser.*` 才需要 polyfill，本项目没用） |
| 网络规则 | `declarativeNetRequest` 动态规则 | Edge 支持 ✓ |
| ffmpeg.wasm | CSP 里已有 `'wasm-unsafe-eval'` + `web_accessible_resources` | Edge 支持 ✓ |
| 响度归一改动 | 只用 Web Audio（`AudioContext`/`decodeAudioData`/`GainNode`）+ 已有的 `host_permissions` | **没有新增任何权限**，也没用 Chrome 独有 API ✓ |
| 扩展页面 | `chrome.action.onClicked` → `chrome.tabs.create(popup.html)` | Edge 行为一致 ✓ |

唯一"Chrome 味道"的地方是既有的 `permissions: ["search"]`（Chromium 的搜索服务权限，Edge 里会被忽略/提示），
这是仓库原有的，不是本次改动引入的。

---

## 2. 路线 A（推荐自用）：构建 + 加载解压缩的扩展

### 2.1 构建

```bash
git clone https://github.com/lovegaoshi/NoxPlayer.git noxplayer
cd noxplayer
git checkout dev
git apply /path/to/loudness-normalization.patch     # 应用本次改动

# ① 子模块：解析/数据共享库，缺了 webpack 直接报 @APM 找不到
git submodule update --init --recursive

# ② .env：**必需**。webpack 用 dotenv-webpack 且 safe:true，
#     没有 .env 会直接构建失败；占位值就够，只影响云同步(Dropbox/Gitee/Github/个人云)那几个后端
cp .env.example .env

# ③ 依赖（Yarn 4，Node 20+；corepack 会自动拉 yarn）
corepack enable
yarn

# ④ 构建 → 产物落在 build/
yarn build
```

`yarn build` 实际执行两步：`webpack --env prod` → `python3 ./scripts/moveFFMpeg.py --prod`
（把 `node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.{js,wasm}` 拷进 `build/js/`）。

> ⚠️ Windows 上最常见的坑：脚本里写的是 **`python3`**。如果你的机器只有 `python`（或 Microsoft Store 别名），
> 这一步会失败。两种解法：把 `package.json` 里的 `python3` 改成 `python`，或者 webpack 跑完后手动执行：
> `python ./scripts/moveFFMpeg.py --prod`。

构建完自检（`build/` 里必须有这些）：

```
build/manifest.json          ← zip 时它必须在压缩包根目录
build/serviceWorker.js
build/popup.html  + build/js/popup.js
build/js/ffmpeg-core.js / ffmpeg-core.wasm
build/icons/…
```

### 2.2 装进 Edge

1. 打开 `edge://extensions/`
2. 左下角打开 **开发人员模式**
3. 点 **加载解压缩的扩展**，选 `build/` 目录
4. 点扩展图标 → 会新开一个标签页（播放器就是在这个页面里跑的）

调试验收：在那个播放器标签页按 F12，控制台里搜 `[loudness]`，会看到：

```
loudness: AudioContext ready (48000Hz, state=running)
loudness: <audio> is now routed through the loudness gain node
loudness: 歌名: -18.7 LUFS -> target -14 LUFS, gain 4.7dB (sidx)
```

### 2.3 每次改代码后的更新

- 改完源码重跑 `yarn build` → 回到 `edge://extensions/` 点该扩展的 **重新加载** 按钮（刷新播放器标签页）。
- 开发时想快一点：`yarn watch`（webpack watch）或 `yarn start`（webpack-dev-server），
  但**热更新模式下也要手动点「重新加载」**，Edge 不会自动重载 MV3 扩展。

---

## 3. 路线 B：上传到 Edge 加载项商店（给别人用）

Edge 的商店叫 **Microsoft Edge Add-ons**，后台是 **Microsoft Partner Center**。

| 步骤 | 说明 |
|---|---|
| 1. 注册 | [partner.microsoft.com](https://partner.microsoft.com) → 免费账号（个人可用，无需付费，需实名/邮箱验证） |
| 2. 打包 | 把 `build/` 里的**内容**（不是 build 目录本身）压成 zip：根目录必须是 `manifest.json` |
| 3. 新建加载项 | Partner Center → Edge → 「新建加载项」→ 上传 zip |
| 4. 填资料 | 名称「电闹播放器」、简介、分类、隐私政策 URL、支持链接、截图 |
| 5. 权限说明 | 审核会问 `cookies` / `host_permissions`（B站、YouTube 等）为什么需要；照实写「访问 B 站接口解析音频直链、读取登录态以调用点赞/收藏等站内 API」即可 |
| 6. 提交审核 | 一般 1–7 个工作日 |

打包命令（Windows / macOS / Linux 都一样，**只压 build 的内容**）：

```powershell
# PowerShell（Windows）
Compress-Archive -Path .\build\* -DestinationPath .\NoxPlayer-edge.zip -Force
```

```bash
# bash
cd build && zip -r ../NoxPlayer-edge.zip . && cd ..
```

后续更新：**同一个加载项**里提交新版本，`manifest.json` 的 `version` 必须递增（现在是 `4.5.2.0`）。
Edge 和 Chrome 的 zip 可以复用同一份（Chrome Web Store 另需一次性注册费 $5，Edge 免费）。

### 关于"能不能直接发个 crx 让朋友双击安装"

不行 —— Edge 会拦掉商店外安装的 crx（只有企业策略能例外）。给朋友用只有两条路：
① 教他开开发人员模式「加载解压缩的扩展」；② 上架商店。

---

## 4. 路线 C（临时试玩）：不改源码直接试

如果你只想**先感受一下效果**、还不想构建，可以：

1. 先按原样（不打包）在 Edge 里装官方版 → 你会发现**没有响度归一设置项**，因为官方版不含本次改动；
2. 所以这条路只能用来对照"改之前"，真正的效果还是要走 §2 的构建。

（`--load-extension=` 启动参数也能加载未打包扩展，但需要关掉所有 Edge 实例再用命令行启动，日常不如 `edge://extensions` 方便。）

---

## 5. 我在沙箱里已经验证到哪一步

为了给你一个"确实能构建"的结论，我在本机跑了一遍**替代链路**（沙箱里没有 yarn、git-over-https 也被拦）：

- 用 **pnpm** 代替 yarn 装了整套依赖（1197 个包，含 `@ffmpeg/core`、MUI、webpack 5.111）；
- 两个 `github:` 依赖（`libmuse`、`react-jinke-music-player` fork）用同 commit 的源码副本代替；
- 补掉 yarn 会"提升"但 pnpm 不提升的 `lodash`；
- **webpack 成功跑起来了**（1 次 prod 构建，约 21 秒，2 errors / 53 warnings）。

停在最后的 2 个 error：`react-jinke-music-player` 这个 fork 的**仓库里没有构建产物**
（`main` 指向它自己 `prepare` 出来的文件，yarn 装 git 依赖时会自动跑 prepare，我用源码副本就绕过了）。
这属于沙箱替代方案的副作用，**跟你用 yarn 正常构建无关** —— 你在自己机器上按 §2.1 四步走，这一步是自动完成的。

沙箱里撞到的两个**真实**坑（已写进 §2.1，你大概率也会遇到第一个）：

1. **`.env` 必须有**：`dotenv-webpack` 配了 `safe: true`，缺文件直接构建失败（CI 是注入 secret 解决的）；
2. `python3` vs `python` 的名字问题。

---

## 6. 上架前建议先自查（Edge 审核 + 用户体验）

- [ ] `edge://extensions` 里加载 `build/` 后，播放器能正常出声音（说明 ffmpeg-core 与 CSP 都没问题）
- [ ] 响度归一开关默认关闭（本次实现如此），打开后控制台有 `[loudness]` 日志
- [ ] 权限列表与你填的说明一致（本次改动**没有新增权限**，可以直说）
- [ ] `manifest.json` 的 `version` 比上一版大
- [ ] zip 根目录就是 `manifest.json`（不要多一层 `build/` 目录，这是最常见的被拒原因）
