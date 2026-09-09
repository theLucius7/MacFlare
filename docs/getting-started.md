# 快速开始

完成这份指南后，你会得到自己的状态主页、文档和公开 API，以及登录后自动推送的 Mac Agent。默认采用 **buffered：5 分钟上传、15 分钟窗口、正常延时 7 分钟播放**。

这份指南用于从零部署。已有实例的升级和域名变更见 [部署与维护](deployment.md)；只需要读取接口时，从 [接入示例](integrations.md) 开始。

## 准备

- 一台已登录图形桌面的 Mac。
- 一个 Cloudflare 账户；每台 Mac 使用独立 Worker 和 KV。
- 部署电脑安装 Node.js 22+ 与 npm。Mac 的日常采集不需要 Node.js。

## 1. 获取项目

```sh
git clone https://github.com/xw7qwq/macflare.git
cd macflare
npm ci
npx wrangler login
npx wrangler kv namespace create STATUS_KV
```

将命令返回的命名空间 ID 填入 `wrangler.jsonc`，绑定名保留 `STATUS_KV`。`STATUS_TTL_SECONDS` 仅用于兼容快照，首次使用 buffered 可保留仓库默认值；窗口的独立截止规则见 [默认参数](buffering.md#默认参数)。已有 API Token 时可使用 [非 OAuth 部署方式](deployment.md#使用已有-api-token)。

## 2. 设置接收令牌并部署

```sh
openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN
npm run deploy
```

保存第一条命令生成的随机值，在 `secret put` 的交互提示中输入；稍后安装本机时也使用它。不要用 Cloudflare 管理凭据代替接收令牌，不要把令牌放入 Git 或 URL。

保存部署输出的 HTTPS 地址，例如 `https://<worker>.<subdomain>.workers.dev`。也可先 [绑定自己的域名](deployment.md#自定义域名)。根路径是状态主页与文档，API 位于 `/api/*`。

## 3. 检查隐私并安装

```sh
/bin/bash agent/macflare.sh --print
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev --profile buffered
```

第一条命令打印真实本机状态，不向 Worker 上传；启用 Music 时仍可能向 Apple 查询封面。确认这些内容适合公开后再安装，并交互输入相同接收令牌。需要先调整隐私时，在安装命令加 `--no-start`，编辑安装后的 `config.json` 并预览，再运行安装命令启动。

Music 自动化授权可能显示为 **bash 想要控制 Music**。请在系统弹窗或「系统设置 → 隐私与安全性 → 自动化」处理授权；前台终端和后台脚本可能分别需要授权。未允许时，其他指标仍可更新。

## 4. 核验

```sh
curl -sS https://<worker>.<subdomain>.workers.dev/api/health
curl -sS https://<worker>.<subdomain>.workers.dev/api/timeline
launchctl print "gui/$(id -u)/com.macflare.agent"
```

确认 `/api/timeline` 返回 `mode: "window"`、`window.baseline` 与 `window.events` 包含允许公开的状态；跨过两个 5 分钟上传周期检查 `batch_seq` 和 `window_end` 前进。首次正常约在启动 7 分钟后开始播放；首包到达前可能显示离线，取得窗口后才显示暖机倒计时。首页按时间回放，再将短时间普通应用／歌曲切换按约 2 秒节奏合并显示；时间线中的已记录事件不因此删除。原有 `/api/music` 等接口显示对应延时切片。KV 可能有传播延迟，不需要每秒重试。[时序、缺口与验收边界](buffering.md)

下一步：[嵌入博客或 README](integrations.md) · [节省免费额度](quotas.md) · [停止和卸载](configuration.md#停止与卸载)
