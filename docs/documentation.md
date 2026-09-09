# 文档开发与发布

本页面向维护文档的贡献者；使用者从 [文档导航](guide.md) 选择阅读路径。文档与状态页面使用 VitePress 静态构建，和 API 一起发布到同一个 Cloudflare Worker。源码始终在当前 GitHub 仓库，不使用 GitHub Pages。分支、提交和 PR 约定见 [贡献指南](https://github.com/xw7qwq/macflare/blob/main/CONTRIBUTING.md)。

## 内容放在哪里

| 页面 | 负责的内容 |
| --- | --- |
| [快速开始](getting-started.md) | 从零部署和安装的完整操作顺序 |
| [部署与维护](deployment.md) | 云端认证、域名、升级、回滚和现场验收 |
| [本机配置](configuration.md) | 配置键、隐私开关、本机文件与诊断命令 |
| [缓冲设计](buffering.md) | 固定策略参数、时间窗口、保存和播放边界 |
| [API](api.md)、[OpenAPI](openapi.yaml) | 人类可读与机器可读的协议契约 |
| [接入示例](integrations.md) | 客户端消费、图片和博客示例 |
| [文档导航](guide.md) | 阅读路径和页面入口 |

正文位于 `docs/*.md`，导航和站点地址位于 `docs/.vitepress/config.mjs`，首页组件位于 `docs/.vitepress/theme/`。`docs/.vitepress/dist/` 是构建产物，不进入 Git。其他目录职责见 [仓库导航](guide.md#仓库职责)。

## 本地开发

使用 Node.js 22+ 和仓库锁文件安装开发依赖，在仓库根目录运行：

```sh
npm ci
npm run docs:dev
```

纯文档开发服务器没有 Worker API，首页会显示暂时无法读取；这不会尝试连接维护者实例。核验同域完整行为：

```sh
cp .dev.vars.example .dev.vars
# 编辑其中的本地测试 INGEST_TOKEN。
npm run dev
```

`dev` 先构建静态文件，再启动 Wrangler 本地 Worker/KV；本地入口以命令输出为准。修改正文后重新构建并刷新。`.dev.vars` 仅保留本地测试令牌，不提交到 Git。只改文档不需要重装 Mac Agent，也不需要读取真实设备活动。

## 修改与验证

1. 将内容放入上表对应页面；其他页面用链接引用，避免复制部署步骤或完整策略参数表。
2. 新增页面时更新 `docs/.vitepress/config.mjs` 的侧边栏，并从 [文档导航](guide.md) 或关联页面添加入口。
3. 修改标题时检查指向该锚点的链接；已公开的 API 与升级入口尽量保留锚点。
4. 运行文档检查，并预览改动的页面、导航、代码块和搜索结果。

```sh
npm run check
```

| 命令 | 验证范围 |
| --- | --- |
| `npm run check:repo` | 必需文件、package 与锁文件元数据、误跟踪的本地凭据或构建缓存路径、Markdown 本地文件链接；只用 Node.js 与 Git，不构建、不联网、不采集设备 |
| `npm run check` | 先运行仓库检查，再构建文档、检查生成页面／资源／锚点、核验 Worker 语法并执行部署 dry run；不发布到线上 |
| `npm run docs:preview` | 预览已有构建产物，供人工检查页面 |

仓库检查不验证公网外链可用性、全部 Markdown 语法或 OpenAPI 的所有 schema 约束；构建检查也不能证明云端权限、真实 KV 传播和后台授权。纯正文或导航修改不必重复原生采集测试；涉及 Worker、共享状态机或 Agent 时，按 [贡献指南](https://github.com/xw7qwq/macflare/blob/main/CONTRIBUTING.md) 补相应验证。

## 发布

通过仓库审查、具备目标部署权限后运行：

```sh
npm run deploy
```

`deploy` 先构建站点，再同时发布静态文件和 Worker。CI 只做验证，不存储生产 Cloudflare 凭据，也不会在每次 PR 后自动修改线上部署。域名设置、版本回退和公开端点验收见 [部署与维护](deployment.md)。

Cloudflare 静态资产处理页面与脚本，只有 `/api/*` 和保留的旧接口路径优先调用 Worker。不要将所有文档请求都转入 Worker，更不要让未知 API 返回 HTML。新增正文时更新侧边栏，并保持根域名部署的 `base: '/'`。

## 内容约定

- 示例使用合成数据，不包含真实设备快照、应用历史、令牌或账户凭据。
- 所有 API 示例使用 `/api/*`；接收地址只配置 origin，由 Agent 拼接路径。
- 改变模式、窗口参数、TTL 或协议时先更新对应的策略页或 API 契约，再核对 README、配置和接入示例的摘要；区分云端物理保留与实际播放覆盖。
- 相对 Markdown 链接同时服务源码阅读和构建；仓库外层文件用完整 GitHub 链接。
- 搜索索引在浏览器本地运行，无外部搜索账户或分析脚本。

依赖版本以 `package.json` 和锁文件为准，包括 Vite 的 `overrides`。升级依赖时核验构建、兼容性和 `npm audit`，不要在正文中将仓库固定版本称作“当前最新版”。
