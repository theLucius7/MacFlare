# 应用图标（macOSicons）

首页可以在前台应用和 GUI 应用列表旁显示 macOSicons 图标。图标来自部署前同步的有限映射；未同步、未知应用、隐私屏蔽后的 `System`、加载失败或记录过期时显示占位，不影响应用名称与设备状态。

## 数据流

维护者主动运行同步命令，使用自己的 API Key 调用官方 `POST https://api.macosicons.com/api/v1/search`。鉴权头为 `x-api-key`，`query` 来自配置中的固定应用名；页面访客不会把实时运行列表发送给搜索 API。[官方开发者入口与请求格式](https://macosicons.com/developers)

同步只生成图标 URL、匹配信息、署名和有效期记录，不下载或镜像图标文件。部署后，浏览器从 CDN 加载返回的原始 `lowResPngUrl`。Key 不进入生成文件、Git、Worker Secret 或浏览器；这一功能不增加 Cloudflare KV 操作，也不改变 `/api/now`。

## 配置固定映射

编辑 [config/app-icons.json](https://github.com/theLucius7/MacFlare/blob/main/config/app-icons.json)。默认列出 12 个常用应用，表示待匹配配置，不代表已下载或一定能够找到图标；最多配置 32 个应用。

```json
{
  "version": 1,
  "apps": [
    {
      "app": "Visual Studio Code",
      "query": "Visual Studio Code",
      "aliases": ["Code", "Visual Studio Code"],
      "matchNames": ["Visual Studio Code"]
    }
  ]
}
```

| 字段 | 要求与用途 |
| --- | --- |
| `version` | 固定为 `1` |
| `apps` | 有限的应用映射数组，最多 32 项 |
| `app` | 必填字符串，配置中的应用名称 |
| `query` | 必填字符串，发送给 macOSicons 搜索的固定词 |
| `aliases` | 必填非空字符串数组，用于识别本机上报的应用名称及别名 |
| `matchNames` | 必填非空字符串数组，列出可接受的搜索结果应用名称 |

仅添加需要在状态页展示的应用，不从实时进程列表自动生成搜索词，也不遍历整个图标目录。名称无法匹配时先核对本机预览中的应用名，再调整别名或候选名称。

## 同步并发布

从 macOSicons 开发者入口获取自己的 API Key，保存到仓库外、仅自己可读的文本文件。不要把 Key 写成命令参数或提交到仓库；它与 Cloudflare 管理凭据及 MacFlare 的 `INGEST_TOKEN` 相互独立。

```sh
chmod 600 /private/path/macosicons-api-key
npm run icons:sync -- --key-file /private/path/macosicons-api-key
npm run deploy
```

将示例路径替换为自己的 Key 文件。同步生成 `docs/.vitepress/theme/app-icons.json`，该文件被 Git 忽略；部署会把有效映射随站点发布。不要用 `git add -f` 提交缓存。只执行同步不会更新已部署页面，仍需运行 `npm run deploy`。

没有 Key 时可以直接运行 `npm run docs:build`：如果生成文件不存在，构建会创建空图标清单，不调用搜索 API。首次克隆和普通文档构建不要求获得第三方 Key。

## 有效期与请求额度

每条同步记录包含 `fetchedAt` 和 `expiresAt`，最多有效 30 天；到期后页面不再展示，需要重新同步并部署。同步会复用距离到期仍超过 2 天的有效记录，避免每次构建重复查询。普通构建和访问页面不会自动续期。

每个未复用的应用每次同步最多发起一次搜索，不自动重试。确实需要重新查询时可以显式跳过复用：

```sh
npm run icons:sync -- --key-file /private/path/macosicons-api-key --force
npm run deploy
```

`--force` 会额外消耗 macOSicons 请求额度；额度以你账户当前套餐为准，不与 Cloudflare 免费额度共用。不要用反复强制同步处理服务限流。

## 署名与使用边界

图标归原作者所有，不适用本仓库代码的 MIT 授权。保留返回的作者信息、macOSicons 来源及图标链接，不删除图标标题或链接中的署名；有作者单独许可证时同时遵循其要求。不得转售图标或将图标库重新包装为产品。

官方 API 条款限制响应缓存最多 30 天，并禁止建立图标目录的离线镜像或可搜索副本。本项目仅维护少量状态展示映射，不提供图标目录搜索，不把同步结果或图标文件提交到 Git。[macOSicons API 条款](https://macosicons.com/developers/terms)

缺失、过期或显示占位时，见 [图标排查](troubleshooting.md#应用图标显示占位)；访客请求的数据范围见 [隐私说明](privacy.md#首页应用图标)。
