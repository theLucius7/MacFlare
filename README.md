# MacFlare

**用 macOS 原生能力，把此刻的 Mac 状态发布到 Cloudflare。**

MacFlare 为博客、GitHub README 和 Now Page 提供电池、前台应用、正在运行的 GUI 应用、系统负载和 Apple Music 播放状态。Mac 只主动推送；云端只保存当前快照，公开读取接口不能向 Mac 执行命令或请求本地数据。

本地运行只使用系统自带的 Bash、`osascript`、`curl`、`pmset` 等工具，通过原生 `launchd` 调度。**不需要 Node.js、Python、jq、Homebrew、pm2 或第三方音乐客户端。** Node.js 和 Wrangler 仅用于开发和部署 Cloudflare Worker。

> 当前设计采用 30 秒推送、60 秒 KV TTL。持续运行一天约写入 2,880 次，超过 Cloudflare KV 免费计划目前的 1,000 次/日。60 秒 TTL 与全天连续在线无法同时满足免费写入配额；本项目不会自动升级套餐。[配额计算与取舍](docs/architecture.md#配额与调度)

## 能力

| 能力 | 行为 |
| --- | --- |
| Apple Music | 上报播放状态、歌曲和歌手；未授权时降级 |
| 应用状态 | 前台应用和运行中的 GUI 应用名称；不采集窗口标题或进程参数 |
| 硬件状态 | 电量、充电、供电来源及系统负载平均值 |
| 隐私控制 | 内置敏感应用屏蔽，可追加屏蔽名单并单独关闭采集项 |
| 原生后台 | 用户登录后由 LaunchAgent 按间隔执行，无需 root |
| 边缘 API | Bearer 鉴权写入、公开跨域查询、SVG 徽章、健康检查 |
| 短时快照 | 固定 KV TTL 60 秒，并以服务端时间检查新鲜度 |

Cloudflare KV 是最终一致存储，跨边缘位置的更新可延迟 60 秒或更久；公开 API 可能短暂返回旧值或离线，不能当作秒级设备监控。[一致性与设计边界](docs/architecture.md#时间离线与一致性)

## 快速开始

### 1. 部署云端

准备一个 Cloudflare 账户，并在部署电脑上安装 Node.js 22 或更高版本。Mac Agent 本身不需要安装此环境。

```sh
git clone https://github.com/theLucius7/MacFlare.git
cd MacFlare
npm ci
npx wrangler login
npx wrangler kv namespace create STATUS_KV
```

将命令返回的命名空间 ID 填入 `wrangler.jsonc` 的 `kv_namespaces` 中，绑定名称保持 `STATUS_KV`。然后生成随机令牌，将其妥善保存到密码管理器，用作本机和 Worker 的同一接收凭据：

```sh
openssl rand -hex 32
npx wrangler secret put INGEST_TOKEN
npm run deploy
```

`secret put` 会交互式要求输入令牌。保留部署结果中的 `https://<worker>.<subdomain>.workers.dev` 地址；不要把令牌添加到 URL、仓库或前端。首次部署的详细步骤和验收见 [部署指南](docs/deployment.md)。

### 2. 在 Mac 预览并安装

```sh
/bin/bash agent/macflare.sh --print
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev
```

第一条命令只打印本机采集结果，不上传。安装时交互式输入同一令牌；脚本生成私有配置、复制运行文件并加载用户级 LaunchAgent。系统如弹出 Music 自动化授权，需由你手动决定是否允许；无法通过脚本静默授予。

应用、歌曲和运行程序名称会通过公开接口展示。安装前先看预览，按 [配置说明](docs/configuration.md) 缩小公开范围。未打开 Music、未播放或拒绝授权时，Music 字段按实际情况降级，其余可用指标继续工作。

### 3. 读取状态

```sh
curl -sS https://<worker>.<subdomain>.workers.dev/health
curl -sS https://<worker>.<subdomain>.workers.dev/now
```

在线时返回结构化状态；没有新鲜快照时返回：

```json
{"status":"offline"}
```

浏览器页面无需携带令牌：

```html
<pre id="macflare">加载中…</pre>
<script type="module">
  const target = document.querySelector('#macflare');
  try {
    const response = await fetch('https://<worker>.<subdomain>.workers.dev/now');
    if (!response.ok) throw new Error('Status unavailable');
    const state = await response.json();
    target.textContent = state.status === 'online'
      ? `${state.active_app ?? '应用未公开'} · 电量 ${state.battery?.percent ?? '未知'}%`
      : 'Mac 当前离线';
  } catch {
    target.textContent = '暂时无法读取状态';
  }
</script>
```

README 徽章：

```md
![MacFlare](https://<worker>.<subdomain>.workers.dev/badge.svg)
```

GitHub 的图片代理可能缓存徽章，核验最新状态请直接请求 `/now`。[完整 API](docs/api.md) · [OpenAPI 3.1](docs/openapi.yaml)

## 文档

- [部署与验收](docs/deployment.md)：Worker、KV、Secret、本地开发、更新与删除。
- [配置与后台运行](docs/configuration.md)：隐私选项、屏蔽名单、调度及卸载。
- [API 协议](docs/api.md)：字段、状态、错误和客户端接入。
- [架构与配额](docs/architecture.md)：单向数据流、TTL、最终一致性和成本取舍。
- [隐私与威胁模型](docs/privacy.md)：哪些内容公开，以及设计不能保证什么。
- [故障排查](docs/troubleshooting.md)：授权、后台、网络、离线和配额问题。
- [路线图](docs/roadmap.md)、[贡献指南](CONTRIBUTING.md)、[安全策略](SECURITY.md)。

## 开发

```sh
npm ci
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars，换成自己的本地测试令牌。
npm run dev
```

测试和部署预检查：

```sh
npm test
npm run check
```

`wrangler dev` 使用本地模拟存储，与线上 KV 分离。原生 Music 授权和 `launchd` 行为必须在 macOS 实机验证；Node 单元测试不能替代这些验收。

采用 [MIT License](LICENSE)。MacFlare 是独立开源项目，与 Apple 或 Cloudflare 无隶属关系。
