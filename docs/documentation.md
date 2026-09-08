# 文档开发与发布

文档与状态页面使用 VitePress 静态构建，和 API 一起发布到同一个 Cloudflare Worker。源码始终在当前 GitHub 仓库，不使用 GitHub Pages。

## 目录

| 位置 | 内容 |
| --- | --- |
| `docs/*.md` | 页面正文 |
| `docs/.vitepress/config.mjs` | 导航、搜索、站点地址与构建配置 |
| `docs/.vitepress/theme/` | 主题与首页状态组件 |
| `docs/openapi.yaml` | API 的机器可读契约 |
| `docs/.vitepress/dist/` | 构建产物，不进入 Git |
| `worker/index.js` | `/api/*` 接口 |

## 本地开发

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

`dev` 先构建静态文件，再启动 Wrangler 本地 Worker/KV。修改文档后重新构建并刷新。只改文档不需要在 Mac 安装任何依赖。

## 验证与发布

```sh
npm test
npm run check
npm run deploy
```

`check` 包含文档构建、静态路由和文件检查、Worker 语法与 Wrangler 部署预检查。`deploy` 先构建站点，再同时发布静态文件和 Worker。CI 只做验证，不存储生产 Cloudflare 凭据，也不会在每次 PR 后自动修改线上部署。

Cloudflare 静态资产处理页面与脚本，只有 `/api/*` 和保留的旧接口路径优先调用 Worker。不要将所有文档请求都转入 Worker，更不要让未知 API 返回 HTML。新增正文时更新侧边栏，并保持根域名部署的 `base: '/'`。

## 内容约定

- 示例使用合成数据，不包含真实设备快照、应用历史、令牌或账户凭据。
- 所有 API 示例使用 `/api/*`；接收地址只配置 origin，由 Agent 拼接路径。
- 改变模式、TTL 或协议时同步更新 README、配置、API 和 OpenAPI。
- 相对 Markdown 链接同时服务源码阅读和构建；仓库外层文件用完整 GitHub 链接。
- 搜索索引在浏览器本地运行，无外部搜索账户或分析脚本。

当前稳定 VitePress 版本的 Vite 依赖由 `overrides` 固定为兼容 Vue 插件的 Vite 6.4.3，以避开旧开发服务器已知漏洞。升级时核验构建和 `npm audit`，不要直接删除覆盖项。
