# 贡献指南

欢迎修复、兼容性报告和文档改进。提交 Issue 时提供 macOS 版本、MacFlare 版本、执行方式（终端或 launchd）、脱敏错误和复现步骤。不要附带真实令牌、个人歌曲历史、应用列表或未经脱敏的配置。

## 本地开发

1. Fork 并克隆仓库，从默认分支创建工作分支。
2. 安装 `package.json` 要求的 Node.js 版本，运行 `npm ci`。这只用于 Worker 开发和测试，不能引入到 Mac Agent 运行路径。
3. 复制 `.dev.vars.example` 为 `.dev.vars`，使用测试令牌，运行 `npm run dev`。
4. 对改动执行 `npm test` 和 `npm run check`。原生采集、TCC 或 launchd 变动还必须在 macOS 实机验证。
5. 用无敏感内容的样例说明前后行为，同步更新 API、配置或排错文档。

macOS 原生冒烟检查使用开发环境中的 Python 3 驱动测试：`python3 agent/tests/native-smoke.py`。测试使用临时配置和回环服务器，关闭 Music，不安装 LaunchAgent；Python 不参与实际 Agent 运行。

## 实现约定

- Mac 脚本保持兼容系统 `/bin/bash`，仅使用 macOS 自带工具；不要把新 Homebrew、Node.js、Python 或 jq 依赖藏入安装流程。
- 脚本引用路径与参数，支持带空格的用户路径；不要 `eval` 或执行远程配置。
- 用系统 JSON 序列化处理字符串，不用拼接引号生成 JSON；不要将歌曲或应用名解释为 shell 代码。
- 单项采集失败应降级；网络调用必须有超时，不无限重试，不将令牌写进命令行日志。
- Worker 入站使用显式字段校验、固定 TTL 和服务端时间；不要把未经筛选的请求直接存入公共 KV。
- 新增公开字段必须解释用途、默认行为和隐私影响；避免持久标识与无关遥测。

测试围绕边界行为：鉴权、错误输入、过期、数据清理、转义和失败降级。单元测试用内存替代 KV，不能证明 Cloudflare 全球一致性；macOS 原生行为不能用 Linux 的通过结果代替。

## Pull Request

描述解决的问题、触发条件、改变后的行为和已执行验证。协议变化提供迁移说明，涉及采集范围时说明公开数据的增减。修改命名或格式的 PR 应保持范围小；不要夹带无关重构。

CI 运行后端检查及 macOS 脚本检查，不自动部署，不需要 Cloudflare 或设备访问密钥。首次部署和实际权限验收由使用者执行。

本项目采用 [MIT License](LICENSE)。提交贡献即表示你有权提交这些内容，并同意以同一许可证分发；不要提交不具备授权的代码或素材。
