# HTTP API v1

协议版本为 `schema_version: 1`，Worker 基础地址是部署输出的 HTTPS URL。本文示例都是合成数据。机器可读契约见 [OpenAPI 3.1](openapi.yaml)。

## 路由

| 方法 | 路径 | 鉴权 | 功能 |
| --- | --- | --- | --- |
| `POST` | `/api/update` | `Authorization: Bearer <INGEST_TOKEN>` | 验证并覆盖当前快照 |
| `GET` | `/api/now` | 无 | 一次读取完整原始快照，组合页面优先使用 |
| `GET` | `/api/music` | 无 | 音乐状态、歌名、歌手及可空的 Apple 封面与歌曲链接 |
| `GET` | `/api/apps/active` | 无 | 前台应用名称及可空的原生图标地址 |
| `GET` | `/api/apps/running` | 无 | 运行应用及原生图标地址，未采集时为 `null` |
| `GET` | `/api/device` | 无 | 电池与系统负载 |
| `GET` | `/api/badge.svg` | 无 | 生成状态 SVG 徽章 |
| `GET` | `/api/health` | 无 | 检查 Worker 能否响应，不读取 KV |
| `GET`、`HEAD` | `/api/icons` | 无 | 读取部署内的原生图标清单 |
| `GET`、`HEAD` | `/api/icons/<id>.png` | 无 | 返回清单内的真实 PNG |
| `OPTIONS` | 以上已知路径 | 无 | CORS 预检，返回 204 |

没有尾斜线别名；`/api/now/` 是未知路径。只有图标接口支持 `HEAD`，包括四个分类接口在内的状态、写入、徽章与健康接口均返回 405。查询参数不改变响应。JSON 使用 `application/json; charset=utf-8`，SVG 使用 `image/svg+xml; charset=utf-8`，图标使用 `image/png`。

旧 `/update`、`/now`、`/badge.svg`、`/health` 保留兼容且不重定向，新集成使用 `/api/*`。四个新增分类接口仅提供表中的 `/api/*` 路径，没有 `/music`、`/apps/active` 等根路径别名。根路径 `/` 为状态主页，文档 API 参考页面位于 `/api`。

完整页面需要多类状态时，**每轮只请求一次 `/api/now`**。四个分类接口供独立小组件按需选用，各自一次 GET 都读取一次 KV；并行请求不会合并读取，也不能保证读到同一个快照。分类接口只整理同一设备快照，不写 KV。[调用示例](integrations.md#按需选择接口) · [读取额度](quotas.md#读取也有额度)

## POST /api/update

请求必须为未压缩 UTF-8 JSON，`Content-Type: application/json`（可带 charset），正文最大 **16,384 字节**。除下述可选 `running_apps` 外字段均必需；所有层级拒绝未知字段。未启用或不可用的指标必须按字段约定提供空值，不用虚假数值代替。

```json
{
  "schema_version": 1,
  "collected_at": "2026-09-08T08:00:00.000Z",
  "active_app": "Visual Studio Code",
  "running_apps": ["Finder", "Music", "Visual Studio Code"],
  "battery": {"percent": 78, "charging": false, "power_source": "battery"},
  "system": {"load_1m": 1.5, "load_5m": 1.8, "load_15m": 1.6},
  "music": {"state": "playing", "track": "Example Song", "artist": "Example Artist"}
}
```

示例时间不能直接用于长期重放。`collected_at` 必须是 UTC ISO 8601 时间，以 `Z` 结尾，可无小数或包含 1–3 位小数，且与 Worker 接收时间相差不超过 120 秒。Mac 应启用系统自动设置时间。

| 字段 | 类型与限制 | 含义 |
| --- | --- | --- |
| `schema_version` | 整数，固定为 `1` | 协议版本 |
| `collected_at` | UTC 日期时间字符串 | 本机快照采集时间；不控制过期 |
| `active_app` | `string` 或 `null`；1–200 字符 | 前台应用名称；敏感应用为 `System`，不可用或关闭为 `null` |
| `running_apps` | 可选 `string[]`；最多 64 个，不重复；每项 1–200 字符 | 经过过滤的 GUI 应用名称；关闭时省略 |
| `battery.percent` | `number` 或 `null`，0–100 | 电量百分比 |
| `battery.charging` | `boolean` 或 `null` | 当前是否充电；接通电源不一定正在充电 |
| `battery.power_source` | `ac`、`battery`、`unknown` | 供电来源 |
| `system.load_1m` | `number` 或 `null`，0–100000 | 1 分钟负载平均值，不是 CPU 使用率 |
| `system.load_5m` | 同上 | 5 分钟负载平均值 |
| `system.load_15m` | 同上 | 15 分钟负载平均值 |
| `music.state` | `playing`、`paused`、`stopped`、`unavailable` | 播放中、暂停、停止（含 Music 未运行）、状态不可读或采集已禁用 |
| `music.track` | `string` 或 `null`；1–500 字符 | 当前曲目名称 |
| `music.artist` | `string` 或 `null`；1–500 字符 | 当前歌手 |

长度按 Unicode 码点计算。文本不允许 ASCII 控制字符 `U+0000`–`U+001F` 和 `U+007F`；数字必须有限。Music 状态与元数据独立：已读取到 `playing` 或 `paused` 时，即使当前曲目对象不存在，仍保留该状态并将 `track`、`artist` 设为 `null`；单个元数据字段读取失败时，仅该字段为 `null`。权限不足或播放器状态本身不可读时返回 `unavailable`。暂停时也可保留当前曲目，消费端应依据 `state` 判断是否正在播放，不应仅依据 `track` 非空。

成功返回 HTTP 200：

```json
{
  "ok": true,
  "updated_at": "2026-09-08T08:00:01.000Z",
  "expires_at": "2026-09-08T08:03:01.000Z"
}
```

`updated_at` 是服务器接收时间；`expires_at` 为该记录的服务端截止时间，eco 通常为接收时间加 180 秒、realtime 为加 60 秒；读取时也受当前服务器策略限制。写入完成后才返回成功，每次成功请求覆盖 KV 的 `now` 键并刷新 TTL，不追加历史。不要发送客户端 `updated_at`、`expires_at` 或 TTL 字段。建议由自带 Agent 处理安全读令牌和上传，避免手写含 Secret 的 shell 命令。

## GET /api/now

新鲜快照返回 HTTP 200，顶层增加 `status`、`updated_at` 和 `expires_at`：

```json
{
  "status": "online",
  "updated_at": "2026-09-08T08:00:01.000Z",
  "expires_at": "2026-09-08T08:03:01.000Z",
  "schema_version": 1,
  "collected_at": "2026-09-08T08:00:00.000Z",
  "active_app": "Visual Studio Code",
  "running_apps": ["Finder", "Music", "Visual Studio Code"],
  "battery": {"percent": 78, "charging": false, "power_source": "battery"},
  "system": {"load_1m": 1.5, "load_5m": 1.8, "load_15m": 1.6},
  "music": {"state": "playing", "track": "Example Song", "artist": "Example Artist"}
}
```

没有快照、记录损坏或已到服务端截止时间时，仍返回 HTTP 200：

```json
{"status":"offline"}
```

KV 不可用与没有记录不同：存储访问失败返回 503。客户端应区分“离线”和“读取失败”，并处理 `null`、缺失的可选字段以及未来协议新增字段。

`online` 只说明服务器最近收到数据；不表示设备此刻可连、用户在场或所有指标均授权。不同边缘读取有传播延迟，详见 [一致性边界](architecture.md#时间离线与一致性)。

## 分类状态接口

以下四个接口在线时共有 `status: "online"`、`updated_at`、`expires_at`、`collected_at`，时间含义与 `/api/now` 相同。没有新鲜快照时，HTTP 200 正文精确为 `{"status":"offline"}`，不附带对应数据字段。KV 访问失败返回 503；不要把失败当成离线。

全部公开、无需 Bearer，支持 GET 和 OPTIONS 204，HEAD 返回 405；状态响应使用 `no-store` 与 CORS `*`。每次 GET 只读取一次 KV，不写入或刷新快照。`/api/now` 的原有字段、类型与缺省行为完全保留，下面的图标和封面字段只出现在对应分类接口中。

### GET /api/music

```json
{
  "status": "online",
  "updated_at": "2026-09-08T08:00:01.000Z",
  "expires_at": "2026-09-08T08:03:01.000Z",
  "collected_at": "2026-09-08T08:00:00.000Z",
  "music": {
    "state": "playing",
    "track": "Example Song",
    "artist": "Example Artist",
    "artwork_url": null,
    "track_url": null
  }
}
```

`state`、`track`、`artist` 保留采集值与原有空值语义。在线快照新鲜、`playing` 或 `paused` 且歌名歌手齐全时，Worker 使用公开曲名向 Apple iTunes Search API 查询，参数固定为 `country=us`、`entity=song`、`limit=5`。标题和艺人经过严格规范化匹配后，才返回经检查的 HTTPS `artwork_url` 与 `track_url`；没有可信匹配、搜索失败或 URL 不安全时为 `null`，不会清空已有曲名。美国商店没有结果时不盲选其他歌曲。[Apple 查询参数](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html)

服务器只缓存公开目录的匹配结果，不缓存设备状态或写入 KV。成功结果最多复用 1 小时，未匹配或失败结果最多复用 5 分钟；边缘节点可提前淘汰，不能保证不同节点命中同一缓存。Apple 查询阶段限时 4.5 秒，接口总耗时还包括 KV 与缓存访问；返回前会再次检查快照截止时间。缓存有效不表示 Mac 在线，响应仍以当前快照的新鲜度为准。[隐私与缓存](privacy.md#音乐-api-封面查询)

### GET /api/apps/active

```json
{
  "status": "online",
  "updated_at": "2026-09-08T08:00:01.000Z",
  "expires_at": "2026-09-08T08:03:01.000Z",
  "collected_at": "2026-09-08T08:00:00.000Z",
  "active_app": {
    "name": "Visual Studio Code",
    "icon_url": "/app-icons/visual-studio-code.png",
    "icon_api_url": "/api/icons/visual-studio-code.png"
  }
}
```

前台应用不可用或未采集时 `active_app` 为 `null`。否则 `name` 是公开应用名；已知原生图标的 `icon_url` 为静态路径，`icon_api_url` 为图片 API 路径，两者都相对于部署根域名。未知应用或屏蔽后的 `System` 保留名称，两个图片字段均为 `null`。静态路径更适合网页 `<img>`，不执行 Worker。

### GET /api/apps/running

```json
{
  "status": "online",
  "updated_at": "2026-09-08T08:00:01.000Z",
  "expires_at": "2026-09-08T08:03:01.000Z",
  "collected_at": "2026-09-08T08:00:00.000Z",
  "running_apps": [
    {"name":"Finder","icon_url":"/app-icons/finder.png","icon_api_url":"/api/icons/finder.png"},
    {"name":"Example App","icon_url":null,"icon_api_url":null}
  ]
}
```

每项结构与前台应用对象相同。原快照未包含 `running_apps` 时，这里明确返回 `null`；已采集但没有应用时返回 `[]`。列表最多 64 项，敏感应用已在本机过滤；分类接口不会重新扫描设备或向第三方搜索应用名。

### GET /api/device

```json
{
  "status": "online",
  "updated_at": "2026-09-08T08:00:01.000Z",
  "expires_at": "2026-09-08T08:03:01.000Z",
  "collected_at": "2026-09-08T08:00:00.000Z",
  "device": {
    "battery": {"percent":78,"charging":false,"power_source":"battery"},
    "system": {"load_1m":1.5,"load_5m":1.8,"load_15m":1.6}
  }
}
```

`device.battery` 与 `device.system` 使用 `/api/now` 相同结构，包括不可用时的 `null`；负载平均值不是 CPU 使用率。读取电池无需同时查询音乐或应用接口。

## GET /api/badge.svg

从同一新鲜度规则读取快照。在线并且 Music 正在播放且有曲目时显示歌曲与歌手，否则显示前台应用，或通用 `online`；离线显示 `offline`。长文本会截短，并按 XML 语境转义。存储错误返回 JSON 503，消费端应能显示图片加载失败的替代文本。

## GET /api/health

返回 `{"ok":true,"service":"macflare"}`。不读取 KV，不检查 Secret，不检查 Mac 是否更新；适用于路由存活探测，不能用来证明整个链路健康。

## `GET /api/icons` 与 `GET /api/icons/<id>.png`

图标清单来自部署内的 `docs/public/app-icons/index.json`，不是实时运行列表，不提供搜索或分页。示例：

```json
{
  "version": 1,
  "icons": [
    {
      "id": "visual-studio-code",
      "app": "Visual Studio Code",
      "aliases": ["Code", "Visual Studio Code"],
      "imageUrl": "/api/icons/visual-studio-code.png",
      "source": "installed-app",
      "credit": "应用图标版权归原作者",
      "sourceUrl": null
    }
  ]
}
```

`imageUrl` 是相对于部署根域名的图片路径；使用返回的 `id`，其格式为小写字母或数字，以单个连字符分段。`source` 表示从已安装应用导出，`sourceUrl` 可为官方 HTTPS 来源地址或 `null`；清单可能附带可选 `sha256`。图片及署名不包含在代码的 MIT 授权中。

`GET /api/icons/visual-studio-code.png` 直接返回 PNG 字节，可用于 `<img src>`。这两个路径均支持 `HEAD`（与 GET 相同状态及响应头，无正文）和 `OPTIONS`。未知图标返回 `404 {"error":"not_found"}`；站点资源绑定缺失或不可用时返回通用 503。`HEAD` 的错误也不含正文。

接口不读取 KV、不调用第三方、不要求令牌，也不依赖 Mac 在线或上报成功；成功响应设置 `Cache-Control: public, max-age=3600`。资源存在 ETag 或 Last-Modified 时予以保留，并向静态资源层传递 `If-None-Match`、`If-Modified-Since`；未修改可返回 304，无正文。

图片 API 的请求会执行 Worker。仅需图片展示时推荐相同资源的静态路径 `/app-icons/<id>.png`，无需执行 Worker；静态清单位于 `/app-icons/index.json`。首页使用静态路径，而清单的 `imageUrl` 保留统一 API 地址。[导出与发布](app-icons.md) · [接入示例](integrations.md#应用图标直链)

## 错误格式

```json
{"error":"unauthorized"}
```

| HTTP | `error` | 说明 |
| --- | --- | --- |
| 400 | `invalid_json` | 正文为空、UTF-8 或 JSON 无效 |
| 400 | `invalid_payload` | 协议字段、类型、额外字段或时间不合法 |
| 401 | `unauthorized` | Bearer 缺失或不正确；附带 `WWW-Authenticate: Bearer` |
| 404 | `not_found` | 未知路径或不存在的图标资源 |
| 405 | `method_not_allowed` | 已知路径使用错误方法；附带 `Allow` |
| 413 | `payload_too_large` | 正文过大或 Content-Length 非法 |
| 415 | `unsupported_media_type` | 内容类型错误，或使用非 identity Content-Encoding |
| 503 | `service_unavailable` | 所需绑定/Secret/TTL 配置缺失或无效，存储访问失败，或图标站点资源不可用 |

鉴权先于请求正文解析；所需绑定配置检查先于接收鉴权。错误正文不暴露令牌、原始请求或平台内部详情。接口没有专门的每日配额控制；平台写入配额错误经通用 503 表达。

## CORS 与缓存

响应允许 `Access-Control-Allow-Origin: *`。状态接口预检允许 `GET, POST, OPTIONS` 和 `Authorization, Content-Type`；图标接口允许 `GET, HEAD, OPTIONS` 和 `If-None-Match, If-Modified-Since`，并公开 ETag、Last-Modified 响应头。不启用凭据式 Cookie 请求。公开页面不应持有接收令牌。

状态、写入、徽章和健康响应设置 `Cache-Control: no-store, max-age=0` 以及 CDN no-store 头；图标 API 的成功响应单独使用 1 小时公开缓存。Worker 的 KV 读取另有 30 秒 `cacheTtl`；HTTP 缓存头不会消除 KV 的最终一致传播，也不能约束第三方保存公开信息。CORS 仅控制浏览器读取行为，不保护公开状态不被抓取。
