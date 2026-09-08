# MacFlare

**用 macOS 原生工具，将此刻的 Mac 状态推送到 Cloudflare。**

[![CI](https://github.com/theLucius7/MacFlare/actions/workflows/ci.yml/badge.svg)](https://github.com/theLucius7/MacFlare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[状态与文档](https://macflare.lucius7.dev/) · [快速开始](https://macflare.lucius7.dev/getting-started) · [API](https://macflare.lucius7.dev/api) · [变更记录](CHANGELOG.md) · [安全报告](SECURITY.md)

MacFlare 为个人博客、Now Page 和 GitHub README 提供 Apple Music 歌曲、前台应用、运行中的 GUI 应用、电池和系统负载。Mac 只主动推送，公网没有向 Mac 执行命令或拉取本地数据的通道。

本机运行仅使用系统自带的 Bash、`osascript`、`curl`、`pmset` 和 `launchd`，**无需 Node.js、Python、jq、Homebrew、pm2 或第三方播放器**。Node.js 22+ 仅用于开发、云端部署和构建文档。

## 能力

| 功能 | 行为 |
| --- | --- |
| Apple Music | 播放／暂停／停止、歌名和歌手；未授权时独立降级 |
| 首页歌曲封面 | 访客浏览器查询 Apple，仅显示可信匹配的封面并链接歌曲页面；无匹配时保留文字状态 |
| 应用状态 | 前台应用和 GUI 应用列表；不采集窗口标题、路径或进程参数 |
| 应用图标 | 仓库内原生 PNG、公开图片 API 与静态直链；可选 macOSicons 补充，未知应用使用占位 |
| 硬件状态 | 电量、充电、供电来源和系统负载平均值 |
| 隐私控制 | 敏感应用屏蔽、追加名单、各采集项独立开关 |
| 原生后台 | 用户登录后运行的 LaunchAgent，可安装、更新和卸载 |
| 边缘接口 | Bearer 写入、公开 CORS 查询、SVG 徽章、自动过期 |
| 同站点文档 | 首页展示实时快照，文档静态托管，API 使用 `/api/*` |

封面查询仅使用公开歌名和歌手，直接请求 Apple 搜索服务与图片 CDN；不增加 Cloudflare KV 操作，也不改变 `/api/now` 字段。美国商店无可信匹配时显示占位，收到停止状态或快照过期后撤掉封面。[封面隐私与缓存](docs/privacy.md#首页歌曲封面)

应用图标优先使用从已安装应用导出的 PNG，随有限清单提交到仓库并发布。`GET /api/icons` 返回清单，`/api/icons/<id>.png` 可直接作为图片地址；首页使用无需执行 Worker 的 `/app-icons/<id>.png` 静态路径。原生图标无需第三方 Key、没有 30 天到期限制，也不依赖 Mac 在线或 KV。macOSicons 仍可作为部署前同步的可选补充，其响应缓存单独遵守 30 天限制。[导出、接入与版权说明](docs/app-icons.md)

## 更新模式与免费额度

| 模式 | 上报间隔 | Worker TTL | 全天定时写入 |
| --- | --- | --- | --- |
| **eco（新安装默认）** | 120 秒 | 180 秒 | 约 720 次 |
| realtime | 30 秒 | 60 秒 | 约 2,880 次 |

eco 比 realtime 少写 **75%**，在免费 KV 每日 1,000 次写入中留出约 280 次余量。手动推送、登录启动、测试及同账户其他项目另计；这不是强制配额保护。旧配置未声明 `profile` 时保留 realtime，升级时须显式切换。[额度与切换方法](docs/quotas.md)

状态新鲜度与省额度需要取舍：eco 最长约 3 分钟才判离线；KV 最终一致，跨边缘读取仍可能短暂看到旧值或离线。[架构边界](docs/architecture.md)

## 快速开始

### 1. 部署自己的 Worker

```sh
git clone https://github.com/theLucius7/MacFlare.git
cd MacFlare
npm ci
npx wrangler login
npx wrangler kv namespace create STATUS_KV
```

把返回的命名空间 ID 填入 `wrangler.jsonc` 的 `kv_namespaces`，保留默认 `STATUS_TTL_SECONDS: "180"`。生成独立接收令牌，保存到密码管理器，再设置 Secret 并发布：

```sh
openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN
npm run deploy
```

`secret put` 交互式要求输入令牌，`deploy` 构建并一起发布站点和 API。已有 Cloudflare API Token、自定义域名及权限见 [部署指南](docs/deployment.md)。Cloudflare 管理凭据和 `INGEST_TOKEN` 必须分开。

### 2. 预览并安装到 Mac

```sh
/bin/bash agent/macflare.sh --print
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev --profile eco
```

将地址替换为**你自己的部署根域名**，不加 `/api`，交互输入同一接收令牌。Music 自动化授权需在 macOS 中允许；后台宿主可能显示为 **bash**。预览成功后，仍须核验后台周期。[配置与授权](docs/configuration.md)

### 3. 读取状态

```sh
curl -sS https://<worker>.<subdomain>.workers.dev/api/now
```

在线时返回结构化状态；没有新鲜快照时返回 `{"status":"offline"}`。读取无需令牌，网站不能持有接收 Secret。[博客和 README 接入示例](docs/integrations.md)

## 已部署实例

维护者实例：[状态与文档](https://macflare.lucius7.dev/) · [JSON](https://macflare.lucius7.dev/api/now) · [SVG 徽章](https://macflare.lucius7.dev/api/badge.svg)。这些地址展示维护者的公开状态，不是其他设备的共享写入服务。

## 文档与贡献

- [快速开始](docs/getting-started.md)、[部署和域名](docs/deployment.md)、[本机配置](docs/configuration.md)
- [HTTP API](docs/api.md)、[OpenAPI 3.1](docs/openapi.yaml)、[接入示例](docs/integrations.md)、[应用图标](docs/app-icons.md)
- [免费额度](docs/quotas.md)、[架构](docs/architecture.md)、[隐私](docs/privacy.md)、[排错](docs/troubleshooting.md)
- [贡献指南](CONTRIBUTING.md)、[行为规范](CODE_OF_CONDUCT.md)、[路线图](docs/roadmap.md)

```sh
npm ci
npm test
npm run check
```

CI 验证 Worker、macOS 原生脚本、文档构建与部署预检查。文档与 API 一起由 Cloudflare Worker 发布，无需 GitHub Pages。[文档维护](docs/documentation.md)

代码采用 [MIT License](LICENSE)；应用图标归各自软件作者所有，不包含在 MIT 授权中。MacFlare 是独立开源项目，与 Apple 或 Cloudflare 无隶属关系。
