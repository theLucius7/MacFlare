# Changelog

本文件从当前实现建立基线。`Unreleased` 表示尚未归入正式发布记录，不代表已经发布版本；发布时由维护者补充真实版本、日期和迁移说明。

## Unreleased

### Added

- 同域状态主页与静态文档，规范 `/api/*` 接口，旧入口保持无重定向兼容。
- eco（120 秒上报 / 180 秒过期）与 realtime（30 / 60）模式；旧本机配置保留原行为。
- 可配置服务端 TTL，保存原始截止时间，兼容旧记录并覆盖模式迁移测试。

- macOS 原生 Bash/JXA 状态采集、用户级 LaunchAgent 安装与卸载，以及可配置的采集隐私开关。
- Cloudflare Worker 鉴权上报、公开状态查询、SVG 徽章和健康检查；KV 当前快照与服务端过期检查。
- Worker、HTTP 边界和 macOS 原生测试，以及部署、API、配置和隐私文档。
- 贡献与安全报告流程、行为规范、Issue/PR 模板和 Dependabot 更新配置。

### Fixed

- Music 当前曲目或单个元数据字段不可读时，保留已知的播放/暂停状态，缺失字段独立返回 `null`。

计划功能见 [路线图](docs/roadmap.md)，已发生的代码变更见 [提交记录](https://github.com/theLucius7/MacFlare/commits/main/)。
