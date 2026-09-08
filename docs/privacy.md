# 隐私与威胁模型

MacFlare 把选择的设备状态发布到公网。知道部署地址的任何人都可以读取 `/api/now` 和 `/api/badge.svg`，包括搜索服务、监测机器人以及可能长期记录状态的第三方。随机部署域名和 CORS 都不是访问控制。

## 数据范围

| 数据 | 用途 | 边界 |
| --- | --- | --- |
| 前台应用名称 | 显示当前正在使用的应用 | 不读取窗口标题、文档名、路径或网页 URL |
| 正在运行的 GUI 应用名称 | 展示已打开的应用 | 不上传完整进程表、命令行或 PID；可关闭 |
| Music 播放状态、歌名、歌手 | 显示正在听的内容 | 仅 Music.app；可关闭；不上传音频 |
| 电量、充电、供电来源 | 展示设备电池状态 | 不上传序列号或电池历史 |
| 系统负载 | 展示当前负载概况 | 负载平均值不是 CPU 使用率百分比 |
| 快照时间 | 判断新鲜度 | 公开时间可能被用于推断作息 |

敏感应用过滤在本机执行。屏蔽名单匹配到前台应用时使用通用名称 `System`，运行应用列表也过滤敏感条目。名称屏蔽可能受应用改名、本地化和未列出的敏感软件影响，应结合 [配置](configuration.md) 检查实际预览；对隐私要求较高时关闭应用列表或整个应用采集。

## 信任边界

| 边界 | 采取的措施 | 仍然存在的风险 |
| --- | --- | --- |
| Mac → Worker | HTTPS 与独立 Bearer 令牌；本机过滤 | Mac 被入侵、配置文件泄漏或令牌被窃取时可伪造状态 |
| 公网 → Worker | 接收鉴权、字段校验、体积限制、服务器控制的 TTL | 无专用配额保护；公开读取可能消耗平台配额 |
| Worker → KV | 只覆盖当前键并设置 TTL | 平台缓存、一致性与平台自身数据处理受 Cloudflare 控制 |
| Worker → 页面 | 固定 JSON/SVG 类型、SVG 文本转义 | 网站自身若用 `innerHTML` 插入字段仍可引入漏洞；应使用 `textContent` |
| 公网 → Mac | 没有入站监听、远程命令或回连能力 | 单向架构减少攻击面，不等于消除所有安全风险 |

`INGEST_TOKEN` 是发送状态的凭据，不是 Cloudflare 账户 API Token。前端、GitHub README、Issue、截图和 Git 历史都不应包含它。读取设备状态时，前端调用公开的 `GET /api/now`，不要把 `/api/update` 的令牌打包进浏览器代码。

## 首页歌曲封面

快照仍新鲜、Music 为 `playing` 或 `paused`，且歌名与歌手齐全时，访客浏览器直接向 Apple iTunes Search API 发起 GET：`term=歌名+歌手`、`entity=song`、`country=us`、`limit=5`。Apple 会收到这些公开曲目信息及访客的网络请求，包括连接 IP；查询不发送电池、应用、负载等其他设备指标或任何令牌。[Apple 搜索参数说明](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/Searching.html)

页面仅为可信匹配显示返回的 `artworkUrl100`，图片由访客浏览器向 Apple 图片 CDN 请求；点击封面会打开 Apple 的歌曲页面。美国商店无可信匹配时不盲选其他歌曲，搜索或图片失败只显示占位，不影响文字状态。收到 `stopped` 或快照过期时立即撤掉封面。[Apple 搜索结果字段](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/UnderstandingSearchResults.html)

查询缓存仅在当前浏览器页面的内存中：成功结果保留 1 小时，普通查询失败或无可信匹配保留 5 分钟，最多 50 条；取消的请求不缓存。MacFlare 不将其写入本地持久存储或 Cloudflare KV；浏览器及 Apple 自身的缓存遵循各自策略。此功能不改变 `/api/now` 协议，也不把封面字段写入设备快照。

## 保留与删除

服务只保留一个当前快照，写入时指定服务端过期时间（eco 默认 180 秒，realtime 60 秒）；本项目不建立历史表。停止 Agent 后，新鲜度检查会将过期状态视为离线。TTL 不代表已经抹除请求经过的所有系统日志、备份或第三方缓存，更不能撤回别人已下载的数据。Cloudflare 的账户级日志、观测和保留策略应由部署者另行核对。

减少公开范围时，先调整本机配置，再推送一次让新快照覆盖旧快照；仅关闭采集程序会等到既有状态过期。遇到泄漏先停止采集并轮换 Secret，具体步骤见 [安全策略](https://github.com/theLucius7/MacFlare/blob/main/SECURITY.md)。

## macOS 授权

Music 自动化可能需要用户在 macOS 的系统弹窗中允许。可在“系统设置 → 隐私与安全性 → 自动化”检查运行脚本的终端或宿主是否获准控制 Music。脚本不能代替用户授予系统权限；不要通过关闭系统保护来解决。终端手动运行成功也不自动证明 `launchd` 执行上下文获准，应分别核验。[Apple 自动化权限说明](https://support.apple.com/en-gb/guide/mac-help/mchl108e1718/mac)

项目不要求屏幕录制、读取浏览器历史或完整磁盘访问权限。权限被拒绝时应保持该采集项不可用，其他独立指标仍可以继续上报。
