# 故障排查

先判断故障位于采集、上传还是公开读取。`/api/health` 正常只表示 Worker 可响应；`/api/now` 离线既可能表示设备未更新，也可能是 KV 传播延迟或平台写入配额耗尽。

## 快速定位

```sh
# 只检查本地采集，不上传。
/bin/bash agent/macflare.sh --print

# 使用已安装配置推送一次。
/bin/bash agent/macflare.sh --once

# 检查用户级后台任务。
launchctl print "gui/$(id -u)/com.macflare.agent"

# 检查公开服务。
curl -i https://<worker>.<subdomain>.workers.dev/api/health
curl -i https://<worker>.<subdomain>.workers.dev/api/now
```

命令输出可能包含当前应用和歌曲；提交 Issue 前先脱敏。不要输出或上传私有 token 文件。

## Music 状态为空或不可用

- 确认使用的是 Apple 的 `Music.app`，并且正在播放可提供曲目元数据的歌曲。网页播放器和其他音乐软件不属于当前采集范围。
- 本地配置若关闭 `privacy.music`，不读取 Music。
- 首次在终端执行 `--print` 时处理 macOS 自动化弹窗。进入“系统设置 → 隐私与安全性 → 自动化”检查对应终端或脚本宿主的 Music 权限。[Apple 授权说明](https://support.apple.com/en-gb/guide/mac-help/mchl108e1718/mac)
- 后台由 `/bin/bash` 启动 `osascript`，macOS 的自动化弹窗或权限列表可能将授权主体显示为 **bash**。要启用后台音乐采集，需用户允许 **bash 控制 Music**；仅允许终端控制 Music 或手动采集成功，不能替代这项后台授权。授权后保持 Music 播放，等待后续后台周期，再检查 `/api/now` 中的音乐状态。不要用全盘访问或关闭系统保护替代自动化权限。
- `state` 为 `playing` 或 `paused` 而 `track` / `artist` 为 `null`，表示播放状态可读，但相应元数据不可读。例如 Music 暂停时，当前曲目对象可能不存在并报 `-1728`；这不代表自动化权限被拒绝，已知状态会保留，歌名与歌手分别降级。
- 拒绝授权或播放器状态不可读时返回 `unavailable`；Music 未运行时返回 `stopped`。这些情况不应阻止电池和应用等独立指标上传。

## 有歌名但首页没有封面

- 封面只在快照新鲜、Music 为 `playing` 或 `paused`，且 `track`、`artist` 都非空时查询。收到 `stopped` 或快照过期会撤掉封面，这是正常行为。
- 搜索范围固定为美国商店（`country=us`），最多取 5 个歌曲结果并检查匹配。本地导入、其他商店独有曲目或名称差异可能没有可信结果；页面会显示占位，不自动选用不相关封面，也不保证跨商店匹配。
- 查询和图片由访客浏览器直连 Apple。浏览器网络限制、内容拦截、Apple 搜索或图片 CDN 失败都可能导致占位；不应因此改动 Mac 的自动化权限或上报令牌。
- 普通查询失败或无可信匹配在当前页面内存中缓存 5 分钟，成功结果缓存 1 小时，最多 50 条；取消请求（包括 8 秒超时）不缓存。查询、超时或图片加载失败后，页面可见且曲目状态仍有效时，每隔至少 5 分钟重试；重新加载页面也可重新查询。封面失败不影响已有歌名、歌手或 `/api/now`，也不增加 KV 操作。[封面数据流](privacy.md#首页歌曲封面)

## 应用图标显示占位

- 先读取 `/api/icons`，用返回的 `id` 请求 `/api/icons/<id>.png` 或 `/app-icons/<id>.png`。清单是部署时的有限图标集，不随运行列表增加，也不受 Mac 离线影响；图片 API 对未知图标返回 JSON 404。
- 缺少原生图标时，在装有目标应用的 Mac 上按 [导出说明](app-icons.md#原生图标导出与发布) 运行 `npm run icons:export`，检查并提交生成的 PNG 与清单，再 `npm run deploy`。原生导出无需 macOSicons Key，普通构建不会自动扫描本机应用。
- 未配置应用、别名不匹配或隐私屏蔽后的 `System` 使用占位。核对 `config/app-icons.json` 中的 `aliases`，不要绕过隐私处理。已发布图标变更可能受 HTTP 缓存影响；图片 API 缓存 1 小时，可用条件请求检查是否更新。
- 图标 API 的 503 应检查站点 `ASSETS` 绑定、构建产物与发布；它不使用 `STATUS_KV` 或 `INGEST_TOKEN`。PNG 加载失败不影响应用名称或 `/api/now`。
- 仅对可选 macOSicons 来源：无 Key、未同步、`matchNames` 不匹配、服务限流、CDN 失败或到达 `expiresAt` 都可能显示占位。按 [同步说明](app-icons.md#同步并发布) 更新后重新部署；剩余有效期超过 2 天的记录会复用，确需重查才使用额外消耗额度的 `--force`。原生 PNG 不受这项 30 天有效期限制。

## 看不到前台或运行中的应用

检查 `privacy.active_app`、`privacy.running_apps` 与追加屏蔽名单。敏感前台应用会显示为 `System`；运行应用列表会移除敏感条目。GUI 应用列表不等于 `ps` 完整进程表，后台守护进程和终端内子进程不会全部出现。

应用名称受语言、应用版本和改名影响。用 `--print` 查看当前系统返回的名字，再按 [配置说明](configuration.md) 添加对应名称。没有图形登录会话时，应用数据可能不可用；不要改用 root 运行用户会话 Agent。

## 401：接收鉴权失败

本机 token 文件中的值必须与 Cloudflare Secret `INGEST_TOKEN` 完全一致。确认配置指向正确部署，没有误用 Cloudflare 账户 API Token。只更新一侧会导致 401；轮换时同步更新两侧并核验旧令牌已失效。

匿名 `POST /api/update` 返回 401 是预期行为。公开 `GET /api/now` 不需要、也不应携带该令牌。

## 400、413、415：请求未通过校验

`400` 常见于 JSON 格式、字段类型或 `collected_at` 时间与服务器偏差过大。保持 macOS 自动设置日期与时间，不能用一份过期的静态样例长期重放。`413` 表示超过请求体限制；`415` 表示不是 `application/json`。外部接入方应按 [API 文档](api.md) 构造请求，不加入窗口标题、未知字段或任意长文本。

## 503 或持续离线

1. 核对 `STATUS_KV` 绑定和 `INGEST_TOKEN` Secret 是否存在，是否部署到了预期 Worker。
2. 查看 Cloudflare 控制台的调用和 KV 用量。30 秒推送的写入速率会在免费计划持续运行约 8 小时 20 分钟后用完一天 1,000 次额度，其他写入会使时间更短。配额每天 UTC 零点重置。[Cloudflare KV 配额](https://developers.cloudflare.com/kv/platform/pricing/)
3. 检查本机能否访问部署域名；VPN、代理、DNS、公司网络和 TLS 错误都可能影响上传。不要用 `curl -k` 跳过证书验证来“修复”。
4. 上传成功后仍读到旧值或离线时，等待传播再观察。KV 是最终一致系统，包括“不存在”的读取也会缓存；密集轮询不能消除该延迟。[KV 一致性说明](https://developers.cloudflare.com/kv/concepts/how-kv-works/)
5. 将 `/api/now` 的 `expires_at` 与当前时间比较；停止上传或写入失败后，达到服务端截止时间进入离线是预期行为。

不要通过增大重试次数解决每日配额问题。新安装默认 eco，约 720 次定时写入/日；旧配置不会自动切换。按 [模式切换](quotas.md#切换模式) 同步设置本机 profile 与 Worker TTL。只改其中一侧不能保证节省额度并保持连续在线。

## 手动成功，后台不更新

查看 `launchctl print "gui/$(id -u)/com.macflare.agent"` 的状态和上次退出码，以及 `~/Library/Application Support/MacFlare/last-result.json` 的最近上传时间和结果。配置或采集在上传前失败时，这个文件可能仍是旧结果；用手动 `--once` 查看当前错误。确认安装在当前已登录用户下，配置可读且 endpoint 正确。

`launchd` 的环境不同于交互式 shell；不要依赖 `.zshrc`、Homebrew 路径或临时导出的令牌。重新运行安装脚本更新复制的 Agent；只编辑仓库代码不会自动更新已安装副本。

休眠、注销和未登录 GUI 会话时不保证推送。默认调度不是精确计时服务，不会唤醒机器以维持在线状态。[Apple launchd 说明](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

## README 徽章没有马上变化

先直接请求 `/api/now`。GitHub 图片代理或嵌入站点可能缓存 SVG，浏览器显示的徽章不能用于判断精确更新时间。API 字段会降级到 offline 或空值，消费端也必须处理请求失败，不能永久显示最后一次成功状态。

## 报告问题

提供系统版本、MacFlare 版本、问题发生在手动还是后台、HTTP 状态码和脱敏错误。应用隐私、令牌泄漏或漏洞请遵循 [安全报告流程](https://github.com/theLucius7/MacFlare/blob/main/SECURITY.md)，不要直接公开真实快照。
