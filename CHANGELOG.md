# Changelog

本文件从当前实现建立基线。`Unreleased` 表示尚未归入正式发布记录，不代表已经发布版本；发布时由维护者补充真实版本、日期和迁移说明。

## Unreleased

### Added

- 新增 `/api/music`、`/api/apps/active`、`/api/apps/running` 与 `/api/device` 分类接口，保留 `/api/now` 协议；音乐接口返回曲名、歌手与可信 Apple 封面地址，公共目录匹配结果通过有界内存和边缘缓存复用，不写入 KV。
- 原生应用图标扩充至 45 个，补充本地化名称与进程别名，文档提供可搜索图标目录及静态/API 图片地址；导出器支持 128 项和用户应用目录，第三方同步自动跳过已被原生图标覆盖的应用。

- 从已安装应用导出有限原生 PNG 集并随仓库发布，首页优先使用静态图标；新增 `/api/icons` 清单与 `/api/icons/<id>.png` 图片接口，支持 GET/HEAD/OPTIONS、1 小时缓存及条件请求，不访问 KV 或第三方搜索。图标版权不包含在代码 MIT 授权中。
- 可选 macOSicons 应用图标：部署前同步有限固定映射，Key 与生成缓存不入 Git，保留来源和作者；记录最多有效 30 天，缺失或过期时使用占位，不新增 KV 操作。
- 首页歌曲封面：浏览器直连 Apple iTunes Search API，仅显示美国商店的可信匹配并链接歌曲页面；提供有界内存缓存和占位降级，不新增 KV 操作或 API 字段。
- 同域状态主页与静态文档，规范 `/api/*` 接口，旧入口保持无重定向兼容。
- eco（120 秒上报 / 180 秒过期）与 realtime（30 / 60）模式；旧本机配置保留原行为。
- 可配置服务端 TTL，保存原始截止时间，兼容旧记录并覆盖模式迁移测试。

- macOS 原生 Bash/JXA 状态采集、用户级 LaunchAgent 安装与卸载，以及可配置的采集隐私开关。
- Cloudflare Worker 鉴权上报、公开状态查询、SVG 徽章和健康检查；KV 当前快照与服务端过期检查。
- Worker、HTTP 边界和 macOS 原生测试，以及部署、API、配置和隐私文档。
- 贡献与安全报告流程、行为规范、Issue/PR 模板和 Dependabot 更新配置。

### Fixed

- 仓库迁移后，CI 徽章、克隆示例、文档编辑和安全报告入口统一指向 `xw7qwq/macflare`。
- Music 当前曲目或单个元数据字段不可读时，保留已知的播放/暂停状态，缺失字段独立返回 `null`。

计划功能见 [路线图](docs/roadmap.md)，已发生的代码变更见 [提交记录](https://github.com/xw7qwq/macflare/commits/main/)。
