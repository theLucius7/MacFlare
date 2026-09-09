# 部署与维护

每个 Worker/KV 部署代表一台 Mac。除明确注明的维护者实例外，以下示例中的域名和 ID 都是占位符，需替换为自己账户中的真实值。项目不会自动购买或升级 Cloudflare 套餐。

首次创建 KV、设置接收令牌和安装 Agent，请按 [快速开始](getting-started.md) 操作。本页用于维护已有部署：认证、自定义域名、兼容升级、验收与回滚。以下命令在已执行 `npm ci` 的仓库根目录运行；本机选项见 [配置](configuration.md)，采集与回放参数见 [缓冲设计](buffering.md)。

## Cloudflare 认证

### 浏览器登录

使用浏览器 OAuth 时运行：

```sh
npx wrangler login
npx wrangler whoami
```

若有多个账户，确认选中的账户正确。已有可用 API Token 时，使用下一节的环境变量方式，无需再运行 `login`。[Wrangler 命令参考](https://developers.cloudflare.com/workers/wrangler/commands/general/)

### 使用已有 API Token

Wrangler 支持通过 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID` 环境变量认证。可以使用已有的用户 API Token，也可以使用账户级 API Token；Cloudflare 官方兼容表包含 Workers 和 Workers KV。[Wrangler API Token 认证](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/) · [账户级 Token](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)

将资源范围限制为目标账户。上传 Worker 需要 `Workers Scripts Write`，创建 KV 命名空间需要 `Workers KV Storage Write`（控制台可能显示为 Edit/编辑）。只为实际部署操作授予权限；如使用模板，检查并移除无关服务权限，不授予账单修改或创建其他 Token 的权限。[Worker 上传权限](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/) · [KV 创建权限](https://developers.cloudflare.com/api/resources/kv/subresources/namespaces/methods/create/)

在 **Bash 终端**中执行以下命令（macOS 默认是 zsh 时可先运行 `/bin/bash`）。令牌通过隐藏输入读取，不作为命令参数或 shell 历史中的字面量；不要启用 `set -x`、打印环境变量或录制含凭据的终端会话。

```bash
set +x
read -r -s -p "Cloudflare API token: " CLOUDFLARE_API_TOKEN
printf '\n'
read -r -p "Cloudflare account ID: " CLOUDFLARE_ACCOUNT_ID
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
```

保持在同一终端继续 [快速开始](getting-started.md) 的 KV、Secret 和部署步骤，或更新已有部署；Wrangler 自动读取环境变量，不需要 `wrangler login`。完成部署后运行 `unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID` 清除当前 shell 的变量。CI 环境应由平台 Secret 注入同名变量，本仓库 CI 检查代码、原生脚本和文档构建，不自动部署 Cloudflare。

**Cloudflare API Token 只用于管理云端资源；`INGEST_TOKEN` 只用于 Mac 向 `/api/batch` 或 `/api/update` 上报。** 两者必须分别生成和保存，不要把账户凭据放入本机 Agent 的 `token` 文件、Worker 的 `INGEST_TOKEN`、`.dev.vars` 或前端。账户 ID 是资源标识，不是密码，但仍应确认它对应本次部署账户。

部署配置中的 KV 绑定名保留 `STATUS_KV`，每台 Mac 使用独立命名空间，避免覆盖同一个 `now` 键。更新已部署代码时复用原有绑定和 `INGEST_TOKEN`；重新生成接收令牌还需要同步更新本机令牌文件。首次资源创建步骤集中在 [快速开始](getting-started.md#_1-获取项目)。

## 自定义域名

Worker 的 Custom Domain 同时服务主页、文档和 `/api/*`，无需另外部署 Pages，也不需要给静态文档创建 KV 键。

在自己的 Wrangler 配置中添加：

```json
"routes": [{ "pattern": "macflare.example.com", "custom_domain": true }]
```

域名必须属于当前 Cloudflare 账户的活动 zone，目标子域名不能已有冲突的 CNAME。运行 `npm run deploy` 后由 Cloudflare 管理 DNS 和证书。保留 `workers_dev: true` 可继续使用原 workers.dev 地址。[官方 Custom Domains 指南](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)

自建实例还应将 `docs/.vitepress/config.mjs` 中的 `sitemap.hostname` 改为自己的 HTTPS 根地址，保留 `base: '/'`，再一同构建部署，避免站点地图仍指向维护者实例。

确认 `https://macflare.example.com/api/health` 正常，再更新本机：

```sh
/bin/bash scripts/install.sh --endpoint https://macflare.example.com
```

此命令保留已有 profile、令牌和隐私设置，只更新地址及已安装代码。维护者实例为 `https://macflare.lucius7.dev`。普通使用者应部署自己的实例，不向维护者实例上传。

### 静态页面与 API 路由

`npm run deploy` 先构建 `docs/.vitepress/dist`，Wrangler 将这些静态资产与 Worker 一起发布。`/api/*` 以及旧 `/now`、`/update`、`/badge.svg`、`/health` 走 Worker；其他页面由静态资产处理。旧上传入口直接处理请求，不通过重定向传递 Bearer。

不要删除 `assets.run_worker_first` 中的 API 规则，否则文档导航请求可能误吞 API。部署后验证 `/` 是 HTML、`/api/now` 是 JSON、`/api/badge.svg` 是 SVG、未知 `/api/*` 返回 JSON 404。

## 更新与回滚

更新前阅读 [变更日志](https://github.com/xw7qwq/macflare/blob/main/CHANGELOG.md)，记录当前部署版本，并保留本机私有配置和令牌。在选定的仓库版本上先验证并部署云端，再更新当前用户的 Agent：

```sh
npm ci
npm run check
npm run deploy
/bin/bash scripts/install.sh
```

再次安装会复用 endpoint、token、profile、隐私设置和追加屏蔽名单。涉及运行代码的修改还应完成 [贡献指南](https://github.com/xw7qwq/macflare/blob/main/CONTRIBUTING.md) 要求的测试；静态构建成功不能证明后台授权、KV 传播或实际设备采集正常。

Worker 的版本和部署记录可在 Cloudflare 控制台查看。回滚时选择已验证且与当前 Agent 协议兼容的版本，确认绑定与 Secret；如需回滚 Agent，从对应仓库版本重装。回滚代码不会自动恢复本机配置或以前的 KV 数据，也不会撤回已经公开的状态。

### 升级滑动窗口模式

先按上节部署支持 v2 的 Worker，再显式迁移本机：

```sh
/bin/bash scripts/install.sh --profile buffered
```

新 Worker 同时接受 v1 快照，旧 Worker 不提供 `/api/batch`，因此必须保持云端先升级的顺序。新安装默认 buffered，已有安装保留原 profile；`STATUS_TTL_SECONDS` 只控制兼容快照，不改变窗口策略。启动后的暖机与连续上传验收见 [缓冲时序](buffering.md#一次窗口如何播放) 和下节。

回退到快照模式前，将 Worker 的 `STATUS_TTL_SECONDS` 设置为对应值并部署：eco 为 180 秒，realtime 为 60 秒。再运行 `scripts/install.sh --profile eco` 或 `--profile realtime`。buffered 配置会拒绝 `--once` 和默认单次推送，手动检查使用 [预览与诊断命令](configuration.md#调度和诊断)。

### 升级音乐封面上报

同样遵循先 Worker、后 Agent 的更新顺序。旧 Worker 严格拒绝未知 URL 字段；新 Worker 兼容不含封面 URL 的旧快照。完成升级后，通过后台周期及 `/api/music` 核验歌曲与封面；URL 为 `null` 也可能表示本机查询失败或美国商店没有可信匹配，见 [封面排查](troubleshooting.md#有歌名但首页没有封面)。

## 安装与现场验收

首次安装步骤见 [快速开始](getting-started.md#_3-检查隐私并安装)。以下清单也用于升级后复核；检查本机 `last-result.json` 的方式见 [配置与诊断](configuration.md#调度和诊断)。

按顺序核验：

1. `GET /api/health` 返回 `{"ok":true,"service":"macflare"}`。这只证明 Worker 路由可以响应，不能证明 KV 或 Mac 正常。
2. 无 Bearer 的 `POST /api/batch` 和 `POST /api/update` 均返回 401，确保新旧入口都未开放匿名写入。
3. buffered 检查 `/api/timeline` 与私有 `last-result.json` 的批次结果；快照模式才使用手动 `--once`。核对允许公开的电量、应用及时间。KV 跨位置传播可能延迟，不应每秒密集重试。
4. 观察至少两个后台上传周期，确认 `updated_at` 和 buffered 的 `batch_seq`、`window_end` 前进；首次暖机之后检查时间线中的变化顺序，并检查首页普通切换的 2 秒合并与隐私／断档立即清除。一次手动成功不能证明 LaunchAgent 有效。
5. Music 正在播放时，分别验证手动采集与后台周期中的歌名、歌手；升级 Agent 后还可检查成对封面 URL，未匹配时为空不影响其他状态；暂停、退出和拒绝授权分别检查降级语义。后台自动化授权主体可能显示为 **bash**，需用户允许它控制 Music，不能用前台成功代替后台验证。见 [Music 授权排查](troubleshooting.md#music-状态为空或不可用)。
6. 停止后台任务，等待对应响应的 `expires_at` 后直接重查，应为 offline。buffered 的 `/api/timeline` 保留截止与 `/api/now` 播放覆盖截止不同，核验时分别使用各自返回的值，见 [API 时间语义](api.md#get-api-now)。GitHub 徽章缓存不用于此验收。
7. 按需重新安装启用后台，并记录实际验证日期、版本和未解决问题。

```sh
curl -i https://<worker>.<subdomain>.workers.dev/api/health
curl -i -X POST https://<worker>.<subdomain>.workers.dev/api/batch
curl -i -X POST https://<worker>.<subdomain>.workers.dev/api/update
curl -sS https://<worker>.<subdomain>.workers.dev/api/now
```

不要将真实公开快照和令牌作为仓库测试夹具。当前实机验证应以实际部署记录为准，不能仅凭本文步骤判断已完成。

## 本地验证

文档预览、模拟 Worker/KV、`.dev.vars` 与检查命令统一见 [文档开发与发布](documentation.md)。本地检查不验证账户权限、远端 KV 传播或 macOS 系统授权，正式更新仍需上节的现场验收。

## 停止与删除

停止本机使用仓库的卸载脚本，选项见 [配置指南](configuration.md#停止与卸载)。停止推送后，最新窗口或快照按响应中的绝对截止时间过期。

永久删除部署时，先确认 Worker 与 KV 命名空间只属于本项目，再在 Cloudflare 控制台删除 Worker 和对应命名空间，并撤销不再需要的部署凭据。命名空间删除不可恢复；不应删除其他项目共享的资源。删除部署不能撤回已被第三方保存的公开状态。
