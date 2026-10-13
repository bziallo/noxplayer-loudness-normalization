# ================================================================
# build-edge.ps1 — 一键构建「电闹播放器 + 响度归一」并打出 Edge 可用的 zip
#
# 在打了 loudness-normalization.patch 的 NoxPlayer 仓库根目录运行：
#     powershell -ExecutionPolicy Bypass -File build-edge.ps1
#
# 产物：
#     build\                 ← 直接在 edge://extensions 里「加载解压缩的扩展」
#     NoxPlayer-edge.zip     ← 上传 Microsoft Partner Center（zip 根目录是 manifest.json）
#
# 依赖：git、Node 20+、yarn（corepack 自带）、python
# ================================================================
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Need($cmd, $hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "缺少 $cmd ：$hint"
  }
}

Need git 'https://git-scm.com/downloads'
Need node '需要 Node 20 以上：https://nodejs.org'

# 0) 打补丁（如果还没打）
if (-not (Test-Path 'src\utils\audio\loudness\normalizeClient.ts')) {
  Write-Host '[0/6] 应用响度归一补丁…'
  git apply (Join-Path '..' 'loudness-normalization.patch')
} else {
  Write-Host '[0/6] 补丁已在，跳过'
}

# 1) 子模块（webpack 的 @APM 别名指向它）
Write-Host '[1/6] 拉取子模块 azusa-player-mobile…'
git submodule update --init --recursive

# 2) .env —— dotenv-webpack 配了 safe:true，缺文件直接构建失败
if (-not (Test-Path '.env')) {
  Write-Host '[2/6] 从 .env.example 生成占位 .env（只影响云同步后端）'
  Copy-Item '.env.example' '.env'
} else {
  Write-Host '[2/6] .env 已存在'
}

# 3) 依赖
Write-Host '[3/6] 安装依赖（Yarn 4）…'
if (Get-Command corepack -ErrorAction SilentlyContinue) { corepack enable | Out-Null }
yarn

# 4) 构建：webpack prod + 拷贝 ffmpeg-core
Write-Host '[4/6] 构建…'
yarn build

# 5) Windows 上 scripts 里写的 python3 常常不存在，这里兜一次
$wasm = 'build\js\ffmpeg-core.wasm'
if (-not (Test-Path $wasm)) {
  Write-Host '[5/6] build/js 里没有 ffmpeg-core，手动补齐（python3 名字问题）'
  $py = if (Get-Command python -ErrorAction SilentlyContinue) { 'python' } elseif (Get-Command py -ErrorAction SilentlyContinue) { 'py' } else { $null }
  if (-not $py) { throw '需要 python 来拷贝 ffmpeg-core（或手动把 node_modules\@ffmpeg\core\dist\umd\ffmpeg-core.* 复制到 build\js\）' }
  New-Item -ItemType Directory -Force -Path 'build\js' | Out-Null
  & $py '.\scripts\moveFFMpeg.py' --prod
}

# 6) 自检 + 打包
Write-Host '[6/6] 自检并打包…'
foreach ($f in @('build\manifest.json', 'build\serviceWorker.js', 'build\js\ffmpeg-core.wasm')) {
  if (-not (Test-Path $f)) { throw "构建不完整，缺少 $f" }
}
if (Test-Path 'NoxPlayer-edge.zip') { Remove-Item 'NoxPlayer-edge.zip' -Force }
Compress-Archive -Path '.\build\*' -DestinationPath '.\NoxPlayer-edge.zip' -Force

$manifest = Get-Content 'build\manifest.json' -Raw | ConvertFrom-Json
Write-Host ''
Write-Host "✅ 完成：$($manifest.name) v$($manifest.version)"
Write-Host '   自用：edge://extensions → 开发人员模式 → 加载解压缩的扩展 → 选 build\'
Write-Host '   上架：把 NoxPlayer-edge.zip 传到 partner.microsoft.com（Edge 加载项，免费）'
