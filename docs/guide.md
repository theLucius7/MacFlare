# 文档导航

MacFlare 的文档按部署者、接口使用者和贡献者的任务组织。首页展示这个部署的公开状态；如果要上报自己的 Mac，请部署独立的 Worker 与 KV。

## 部署自己的状态页

1. [快速开始](getting-started.md)：获取项目、创建 KV、部署 Worker，再安装 Mac Agent 并核验后台上传。
2. [本机配置](configuration.md)：选择公开字段、屏蔽应用、修改调度模式以及停止或卸载。
3. [滑动窗口与延时播放](buffering.md)：理解首次暖机、采集与保存节奏、缺口和恢复；固定策略参数集中在这一页。
4. [部署与维护](deployment.md)：配置 Cloudflare 认证、自定义域名，升级或回滚已有部署。

遇到问题先查 [故障排查](troubleshooting.md)；估算访问和上报成本看 [免费额度](quotas.md)。

## 接入现有 API

1. [接入示例](integrations.md)：按需选择完整窗口、单个切片、音乐、应用、设备或图标接口。
2. [API 参考](api.md)：核对字段、空值、鉴权、过期时间和错误码；机器可读契约为 [OpenAPI](openapi.yaml)。
3. [应用图标](app-icons.md)：浏览已发布图标、复制图片地址或维护图标集合。

只读展示无需接收令牌，也不需要安装 Mac Agent。需要连续播放已观察的变化时使用时间线；只显示一次状态时使用切片接口。两者的时间语义见 [播放过程](buffering.md#一次窗口如何播放)。

## 维护和贡献

1. 阅读 [贡献指南](https://github.com/xw7qwq/macflare/blob/main/CONTRIBUTING.md)，确定修改范围与所需检查。
2. 查阅 [架构](architecture.md) 和 [隐私边界](privacy.md)，保持单向上报、有界保存与字段过滤。
3. 按 [文档开发与发布](documentation.md) 更新正文、导航和关联契约，运行对应检查。
4. 用 [路线图与验收标准](roadmap.md) 区分代码验证与实际部署验收。

## 仓库职责

| 目录 | 负责什么 |
| --- | --- |
| `agent/` | macOS 原生采集、私有窗口和本机回归测试 |
| `worker/` | 接收鉴权、KV 存储及公开 HTTP 接口 |
| `shared/` | 窗口协议辅助逻辑、精确回放与页面展示节奏 |
| `docs/` | 状态主页、使用文档、OpenAPI 和公开静态资源 |
| `scripts/` | 安装卸载、图标维护以及仓库和站点检查 |
| `test/`、`.github/` | 跨平台测试、持续集成与贡献模板 |

页面正文解决使用任务；协议细节归 [API 参考](api.md)，固定策略归 [缓冲设计](buffering.md)，维护步骤归 [文档开发](documentation.md)。新增内容先放入对应页面，再从相关入口链接，避免在多处复制同一套步骤或参数。
