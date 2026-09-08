# HTTP API v1

协议版本为 `schema_version: 1`，Worker 基础地址是部署输出的 HTTPS URL。本文示例都是合成数据。机器可读契约见 [OpenAPI 3.1](openapi.yaml)。

## 路由

| 方法 | 路径 | 鉴权 | 功能 |
| --- | --- | --- | --- |
| `POST` | `/api/update` | `Authorization: Bearer <INGEST_TOKEN>` | 验证并覆盖当前快照 |
| `GET` | `/api/now` | 无 | 读取在线快照或离线状态 |
| `GET` | `/api/badge.svg` | 无 | 生成状态 SVG 徽章 |
| `GET` | `/api/health` | 无 | 检查 Worker 能否响应，不读取 KV |
| `OPTIONS` | 以上已知路径 | 无 | CORS 预检，返回 204 |

没有尾斜线别名；`/api/now/` 是未知路径。`HEAD` 未实现，返回 405。查询参数不改变响应。JSON 使用 `application/json; charset=utf-8`，SVG 使用 `image/svg+xml; charset=utf-8`。

旧 `/update`、`/now`、`/badge.svg`、`/health` 保留兼容且不重定向，新集成使用 `/api/*`。根路径 `/` 为状态主页，文档 API 参考页面位于 `/api`。

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

## GET /api/badge.svg

从同一新鲜度规则读取快照。在线并且 Music 正在播放且有曲目时显示歌曲与歌手，否则显示前台应用，或通用 `online`；离线显示 `offline`。长文本会截短，并按 XML 语境转义。存储错误返回 JSON 503，消费端应能显示图片加载失败的替代文本。

## GET /api/health

返回 `{"ok":true,"service":"macflare"}`。不读取 KV，不检查 Secret，不检查 Mac 是否更新；适用于路由存活探测，不能用来证明整个链路健康。

## 错误格式

```json
{"error":"unauthorized"}
```

| HTTP | `error` | 说明 |
| --- | --- | --- |
| 400 | `invalid_json` | 正文为空、UTF-8 或 JSON 无效 |
| 400 | `invalid_payload` | 协议字段、类型、额外字段或时间不合法 |
| 401 | `unauthorized` | Bearer 缺失或不正确；附带 `WWW-Authenticate: Bearer` |
| 404 | `not_found` | 未知路径 |
| 405 | `method_not_allowed` | 已知路径使用错误方法；附带 `Allow` |
| 413 | `payload_too_large` | 正文过大或 Content-Length 非法 |
| 415 | `unsupported_media_type` | 内容类型错误，或使用非 identity Content-Encoding |
| 503 | `service_unavailable` | 所需绑定/Secret/TTL 配置缺失或无效，或存储访问失败 |

鉴权先于请求正文解析；所需绑定配置检查先于接收鉴权。错误正文不暴露令牌、原始请求或平台内部详情。接口没有专门的每日配额控制；平台写入配额错误经通用 503 表达。

## CORS 与缓存

响应允许 `Access-Control-Allow-Origin: *`；预检允许 `GET, POST, OPTIONS` 和 `Authorization, Content-Type`。不启用凭据式 Cookie 请求。公开页面只做 GET，不应持有接收令牌。

响应设置 `Cache-Control: no-store, max-age=0` 以及 CDN no-store 头。Worker 的 KV 读取另有 30 秒 `cacheTtl`；HTTP 缓存头不会消除 KV 的最终一致传播，也不能约束第三方保存公开信息。CORS 仅控制浏览器读取行为，不保护公开状态不被抓取。
