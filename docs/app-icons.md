<script setup>
import AppIconGallery from './.vitepress/theme/AppIconGallery.vue'
</script>

# 应用图标

首页在前台应用和 GUI 应用列表旁优先展示仓库中的原生 PNG，并提供可直接引用的图片 API。图标清单是维护者配置的有限集合，不是全量图标库，也不随实时运行列表自动扩充。未知应用、隐私屏蔽后的 `System` 或图片加载失败时显示占位，不影响应用名称与设备状态。

## 已发布图标

<AppIconGallery />

清单与图片随站点发布，无需等待设备在线。可复制静态地址用于图片展示，或使用统一的图片 API。

## 两种来源

| 来源 | 获取与发布 | 有效期与请求 |
| --- | --- | --- |
| 原生图标，默认优先 | 从开发用 Mac 的已安装应用导出 PNG，与清单一起提交到仓库 | 随部署保留，无第三方搜索、无 30 天到期限制 |
| macOSicons，可选补充 | 部署前搜索固定应用名，生成不入 Git 的 URL 与署名缓存 | 响应最多缓存 30 天；访客向原始 CDN 请求图片 |

两种来源都不读写 Cloudflare KV，不改变 `/api/now`。原生 PNG 并非 macOSicons API 响应，不适用其响应缓存期限；两种来源的图标版权均归各自作者，见下方 [使用边界](#署名与使用边界)。

## 配置固定映射

编辑 [config/app-icons.json](https://github.com/xw7qwq/macflare/blob/main/config/app-icons.json)。当前固定配置包含 108 个已安装应用映射，最多配置 128 项；实际发布的条目以上方图标目录或 `GET /api/icons` 返回的清单为准，不代表这些应用当前正在运行。

```json
{
  "version": 1,
  "apps": [
    {
      "app": "Visual Studio Code",
      "id": "visual-studio-code",
      "bundleId": "com.microsoft.VSCode",
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
| `apps` | 有限的应用映射数组，1–128 项 |
| `app` | 必填字符串，配置中的应用名称 |
| `id` | 原生导出必填；唯一的小写字母、数字与单连字符标识，决定 PNG 文件名和 API 路径 |
| `bundleId` | 原生导出必填；用于核对目标应用的真实 bundle identifier，包装应用使用内部应用身份 |
| `query` | 必填字符串，可选 macOSicons 搜索使用的固定词 |
| `aliases` | 必填非空字符串数组，用于识别应用名称及别名 |
| `matchNames` | 必填非空字符串数组，可选 macOSicons 搜索可接受的结果名称 |

仅添加需要公开展示的应用。不要从实时进程列表生成搜索词或遍历整个第三方图标目录；名称无法匹配时先核对本机预览，再调整配置。显示名称、进程名称与应用包名称可能不同，应通过 `aliases` 关联，保持已有 `id` 和图片地址稳定。缺少可核验 bundle identifier 的条目先跳过，不根据名字伪造身份。

| 显示名称与别名 | 稳定 `id` | 静态图片路径 |
| --- | --- | --- |
| Typora | `typora` | `/app-icons/typora.png` |
| TV、Apple TV | `tv` | `/app-icons/tv.png` |
| VidHub、MediaCenter | `vidhub` | `/app-icons/vidhub.png` |

Typora 与 TV 沿用原有图标；Apple TV 的显示名通过别名匹配。VidHub 的公开显示名与其 `MediaCenter` 应用包名称不同，两者映射到同一图标。对应图片 API 将上述 `/app-icons/` 前缀换为 `/api/icons/`。

## 原生图标导出与发布

在已安装目标应用的 macOS 开发环境执行：

```sh
npm run icons:export -- --dry-run
npm run icons:export
```

[导出脚本](https://github.com/xw7qwq/macflare/blob/main/scripts/export-app-icons.py) 使用开发阶段的 Python 3 与系统 JXA、`sips` 工具，不使用 macOSicons Key，也不增加生产 Agent 的运行依赖。普通站点构建不会扫描已安装应用。导出也支持用户的 `~/Applications` 安装目录。`--dry-run` 只检查配置中的应用是否存在，不导出或修改文件；应用缺失时导出停止并保留现有输出，先调整配置或安装目标应用。

导出器支持标准的 `Contents/Info.plist`、应用根目录的 `Info.plist`，以及使用 `Wrapper` 的已安装 iOS 应用。对于包装应用，仅核验 `Wrapper` 目录下直接 `.app` 子包的真实身份，不递归搜集辅助程序。优先读取该已核验子包明确声明的 PNG 图标资源，使用 macOS 原生 `sips` 转换；无法取得声明资源时，才通过 `NSWorkspace` 从外层已安装应用取图作为兜底。此兼容处理不调用网络服务，也不读取应用文档或使用记录。

全透明的资源不会作为成功图片写入：导出器会改用系统渲染的应用图标；如果仍不可见，则停止导出并保留既有文件。

生成文件位于 `docs/public/app-icons/<id>.png` 和 `docs/public/app-icons/index.json`。检查图标、应用名称、别名与版权后，将需要公开的 PNG 和清单一同提交，再运行 `npm run deploy`。首次克隆可直接构建已有的仓库图标，无需重新导出或第三方 Key。应用图标更新后，重新导出并发布即可。

导出清单只记录公开映射，不含本机安装路径或凭据。图标随站点发布，即使 Mac 离线或状态上报失败也可访问；它不受设备快照 TTL 控制。

## 图片 API 与静态直链

```sh
curl -sS https://YOUR_HOST/api/icons
curl -I https://YOUR_HOST/api/icons/visual-studio-code.png
```

`YOUR_HOST` 替换为自己的域名，不包含协议或路径。清单返回 `version: 1` 和 `icons` 数组；每项含 `id`、`app`、`aliases`、`imageUrl`、`source: "installed-app"`、`credit` 与可空的 `sourceUrl`。使用清单中实际存在的 `id`，无需令牌，不提供搜索或分页。

`/api/icons` 与 `/api/icons/<id>.png` 均支持 GET、HEAD、OPTIONS，成功响应为公开 1 小时 HTTP 缓存，并保留资源 ETag 条件请求。图片接口返回真实 `image/png`，可直接放入 `<img src>`；未知图标返回 JSON 404。API 不访问 KV 或第三方服务，但进入接口会计 Worker 请求。

只需展示图片时，推荐使用对应静态地址 `/app-icons/<id>.png`；首页也使用此地址，不执行 Worker 脚本。静态清单位于 `/app-icons/index.json`。`imageUrl` 保留 `/api/icons/...` 形式，便于统一 API 集成。[完整契约](api.md) · [嵌入示例](integrations.md#应用图标直链) · [额度区别](quotas.md#应用图标的请求与额度)

## 同步并发布

以下步骤仅用于可选 macOSicons 补充来源。维护者使用自己的 Key 调用官方 `POST https://api.macosicons.com/api/v1/search`，鉴权头为 `x-api-key`，`query` 来自固定配置；访客不会逐次发送实时应用列表。[官方请求格式](https://macosicons.com/developers.md)

将 Key 保存到仓库外、仅自己可读的文本文件，不把 Key 写成命令参数或提交到仓库。它与 Cloudflare 管理凭据及 `INGEST_TOKEN` 相互独立。

```sh
chmod 600 /private/path/macosicons-api-key
npm run icons:sync -- --key-file /private/path/macosicons-api-key
npm run deploy
```

替换示例文件路径。同步生成 Git 忽略的 `docs/.vitepress/theme/app-icons.json`，仅含 URL、匹配、署名与有效期，不下载或镜像图片。不要强制提交这份缓存；部署后浏览器使用返回的原始 `lowResPngUrl`。Key 不进入生成文件、Git、Worker Secret 或浏览器。

普通 `npm run docs:build` 不调用搜索 API；补充缓存不存在时会生成空清单，已有原生 PNG 仍可展示。只同步不会更新已部署页面，仍需发布。

同步会跳过已有原生图标的配置项，`--force` 也不会搜索这些应用，避免为首页不会使用的补充图标消耗额度。只有尚未被原生图标覆盖的配置项需要第三方匹配。

每条补充记录含 `fetchedAt` 和 `expiresAt`，最多有效 30 天；到期不再展示，需要重新同步并部署。同步会复用剩余有效期超过 2 天的补充记录，每个未复用、未被原生图标覆盖的应用最多搜索一次，不自动重试。确需重新查询补充项时可追加 `--force`，这会额外消耗额度；不要反复强制同步处理限流。[请求与用量](quotas.md#应用图标的请求与额度)

## 署名与使用边界

原生应用图标归各自软件作者所有，不包含在本仓库代码的 MIT 授权中；使用和再分发应遵循对应软件的图标许可与商标要求。导出清单保留 `source: "installed-app"` 与版权说明，不将其标为 macOSicons 来源。

macOSicons 补充图标须保留作者、macOSicons 来源与图标链接，不删除页面标题或链接中的署名；有作者单独许可证时同时遵循其要求。不得转售图标。官方 API 条款要求响应缓存最多 30 天，并禁止建立目录的离线镜像或可搜索副本；本项目仅使用少量状态展示映射，不将该来源的响应或图片提交到 Git。[macOSicons API 条款](https://macosicons.com/developers/terms)

缺失或占位见 [图标排查](troubleshooting.md#应用图标显示占位)，请求与公开范围见 [隐私说明](privacy.md#首页应用图标)。
