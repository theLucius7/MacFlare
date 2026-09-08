# 部署与验收

每个 Worker/KV 部署代表一台 Mac。以下示例中的域名和 ID 都是占位符，需替换为自己账户中的真实值。项目不会自动购买或升级 Cloudflare 套餐。

## 前提

- 本机采集需要 macOS 图形用户会话；运行时使用系统自带工具，不需要安装语言环境。
- 部署和开发需要 Node.js 22+、npm 以及锁文件中指定的 Wrangler。
- Cloudflare 账户具有部署 Workers 和创建 Workers KV 命名空间的权限。
- GitHub 账户只用于克隆或贡献项目，Mac 状态上报不需要 GitHub 凭据。

先核对用量：默认 30 秒间隔一天约 2,880 次 KV 写入。免费配额目前是 1,000 次/日，超出后写入失败；即使调为 60 秒，也无法实现免费配额内全天保持 60 秒 TTL。可以只在需要的时段运行，或接受更长推送间隔产生的离线窗口；套餐选择由部署者决定。[Cloudflare KV 定价](https://developers.cloudflare.com/kv/platform/pricing/) · [详细计算](architecture.md#配额与调度)

## 部署 Worker

### 获取代码与登录

以下使用浏览器 OAuth。已有可用 Cloudflare API Token 时，完成克隆和 `npm ci` 后，可跳过 `login`、`whoami`，改用下一节的环境变量方式，无需再次授予 OAuth。

```sh
git clone https://github.com/theLucius7/MacFlare.git
cd MacFlare
npm ci
npx wrangler login
npx wrangler whoami
```

在浏览器完成 Cloudflare OAuth。若有多个账户，确认选中的账户正确；自有配置可显式设置 `account_id`，但不要提交账户的私密凭据。Wrangler 登录命令见 [官方命令参考](https://developers.cloudflare.com/workers/wrangler/commands/general/)。

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

保持在同一终端继续下方的 KV、Secret 和部署步骤；Wrangler 自动读取环境变量，不需要 `wrangler login`。完成部署后运行 `unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID` 清除当前 shell 的变量。CI 环境应由平台 Secret 注入同名变量，本仓库 CI 只运行检查，不自动部署。

**Cloudflare API Token 只用于管理云端资源；`INGEST_TOKEN` 只用于 Mac 向 `/update` 上报。** 两者必须分别生成和保存，不要把账户凭据放入本机 Agent 的 `token` 文件、Worker 的 `INGEST_TOKEN`、`.dev.vars` 或前端。账户 ID 是资源标识，不是密码，但仍应确认它对应本次部署账户。

### 创建并绑定 KV

```sh
npx wrangler kv namespace create STATUS_KV
```

编辑 `wrangler.jsonc`，将返回的真实 ID 填入 `kv_namespaces` 中对应条目。`binding` 必须为 `STATUS_KV`；Worker 名称可按自己的需要修改。命名空间 ID 是资源标识，不是鉴权令牌；各部署应使用独立命名空间，避免相互覆盖固定键 `now`。[Wrangler KV 命令参考](https://developers.cloudflare.com/workers/wrangler/commands/kv/)

### 设置 Secret 并发布

```sh
openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN
npm run deploy
```

第一个命令生成 32 字节随机值，十六进制表示为 64 字符。将其保存到密码管理器，再粘贴到 `secret put` 的交互提示；安装 Mac Agent 时使用同一值。不要把实际令牌写入命令参数、`wrangler.jsonc` 或 Git。`INGEST_TOKEN` 与 Cloudflare 账户 API Token 是两种不同凭据。

`secret put` 本身会创建并部署 Worker 版本；首次出现“创建新 Worker”的提示时，确认名称属于本次部署。最后的 `npm run deploy` 发布仓库中的完整代码和绑定。相关行为见 [Wrangler Workers 命令参考](https://developers.cloudflare.com/workers/wrangler/commands/workers/)。

部署输出的 `https://<worker>.<subdomain>.workers.dev` 是本机配置所需的基础地址。无需在 Mac 上开放入站端口，也不需要 Cloudflare Tunnel。

## 安装与现场验收

先查看待公开的真实采集内容：

```sh
/bin/bash agent/macflare.sh --print
```

再安装用户级后台任务：

```sh
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev
```

交互输入接收令牌后，按系统弹窗处理 Music 自动化授权。私有配置与最近上传结果位于 `~/Library/Application Support/MacFlare/`；隐私设置见 [配置指南](configuration.md)。

按顺序核验：

1. `GET /health` 返回 `{"ok":true,"service":"macflare"}`。这只证明 Worker 路由可以响应，不能证明 KV 或 Mac 正常。
2. 无 Bearer 的 `POST /update` 返回 401，确保未开放匿名写入。
3. 手动执行 Agent 单次推送，确认成功；再请求 `/now`，核对电量、应用名称和快照时间。KV 跨位置传播可能延迟，不应每秒密集重试。
4. 观察至少两个后台调度周期，确认 `updated_at` 有变化；一次手动成功不能证明 LaunchAgent 有效。
5. Music 正在播放时，分别验证手动采集与后台周期中的歌名、歌手；暂停、退出和拒绝授权分别检查降级语义。后台自动化授权主体可能显示为 **bash**，需用户允许它控制 Music，不能用前台成功代替后台验证。见 [Music 授权排查](troubleshooting.md#music-状态为空或不可用)。
6. 停止后台任务，等待最后一次更新超过 60 秒，再直接请求 `/now`，应为 offline。GitHub 徽章缓存不用于此验收。
7. 按需重新安装启用后台，并记录实际验证日期、版本和未解决问题。

```sh
curl -i https://<worker>.<subdomain>.workers.dev/health
curl -i -X POST https://<worker>.<subdomain>.workers.dev/update
curl -sS https://<worker>.<subdomain>.workers.dev/now
```

不要将真实公开快照和令牌作为仓库测试夹具。当前实机验证应以实际部署记录为准，不能仅凭本文步骤判断已完成。

## 本地 Worker 开发

```sh
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 中的 INGEST_TOKEN。
npm run dev
```

默认本地入口由 Wrangler 输出，通常为 `http://localhost:8787`。本地模拟 KV 与线上资源分离。`.dev.vars` 已被 Git 忽略；不要提交它。线上配置必须使用 HTTPS，本地 HTTP 仅用于回环地址测试。

```sh
npm test
npm run check
```

Worker 单元测试覆盖协议与异常分支，`check` 包含语法及打包预检查。它们不验证账户权限、远端 KV 传播或 macOS 系统授权。

## 更新与回滚

更新前阅读版本和协议变更，保留本机私有配置、令牌及当前已部署版本信息。获取代码后运行 `npm ci`、测试和 `npm run deploy`。本机 Agent 通过再次执行安装脚本更新；检查隐私配置后核验后台调度。

Worker 的版本和部署记录可在 Cloudflare 控制台查看；回滚选择已验证的版本，并确认绑定和 Secret 与代码相容。回滚代码不会自动还原本机配置或之前的 KV 数据。不要将未验证的旧 Secret 再次投入使用。

## 停止与删除

停止本机使用仓库的卸载脚本，选项见 [配置指南](configuration.md#停止与卸载)。停止推送后，最近快照会按 TTL 过期。

永久删除部署时，先确认 Worker 与 KV 命名空间只属于本项目，再在 Cloudflare 控制台删除 Worker 和对应命名空间，并撤销不再需要的部署凭据。命名空间删除不可恢复；不应删除其他项目共享的资源。删除部署不能撤回已被第三方保存的公开状态。
