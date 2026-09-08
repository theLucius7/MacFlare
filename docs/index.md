---
outline: false
---

<script setup>
import NowStatus from './.vitepress/theme/NowStatus.vue'
</script>

# 此刻的 Mac

电池、应用和音乐的公开快照。由 Mac 主动推送，云端只保留当前状态。

<NowStatus />

## API 快速调用

| 需要什么 | GET 路径 | 返回内容 |
| --- | --- | --- |
| 完整状态，组合页面推荐 | `/api/now` | 音乐（含可选 URL）、应用、电池与负载快照 |
| 音乐小组件 | `/api/music` | 歌名、歌手、可空的封面与歌曲 URL |
| 前台应用 | `/api/apps/active` | 应用名、静态图标与图片 API 地址 |
| 运行应用 | `/api/apps/running` | 名称与图标对象数组，未采集为 `null` |
| 电池与负载 | `/api/device` | `device.battery`、`device.system` |
| 固定应用图标 | `/api/icons` | 随部署发布的原生 PNG 清单 |

需要多类数据时每轮只请求一次 `/api/now`；四个分类接口各自读取一次 KV，不要并行轮询全部入口。本页仍只获取完整快照，封面优先使用 Mac 上报的 URL，缺少有效 URL 时保留浏览器兼容查询。[curl 与图片示例](integrations.md#按需选择接口) · [浏览图标与复制地址](app-icons.md#已发布图标) · [完整 API](api.md)

## 在你自己的 Mac 上使用

MacFlare 本机只使用系统自带工具。部署一次后，由 macOS 原生 `launchd` 定时推送；无需第三方后台管理器或播放器。

| 从哪里开始 | 文档 |
| --- | --- |
| 部署自己的状态页和 API | [快速开始](getting-started.md) |
| 绑定域名、更新与回滚 | [部署指南](deployment.md) |
| 隐藏应用、选择更新模式 | [本机配置](configuration.md) |
| 延长免费额度的使用时间 | [额度与更新策略](quotas.md) |
| 接入博客或 README | [接入示例](integrations.md) |
| 查看 JSON 字段和错误码 | [API 参考](api.md) |

默认 eco 每 2 分钟更新、3 分钟过期，每日定时写入约 720 次。KV 最终一致，页面显示的是最近收到的快照，不代表设备此刻可连接或用户在场。[隐私与数据边界](privacy.md)
