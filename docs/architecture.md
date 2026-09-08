# 架构与设计约束

MacFlare 是单台 Mac 的公开状态发布器。Mac 负责采集并主动推送；Cloudflare Worker 验证和整理数据，Workers KV 仅保存当前滑动窗口或兼容快照，博客或 README 读取公开接口。

![Mac 主动推送到 Worker，网页仅查询 Worker；Worker 读写 KV](assets/flow.svg)

## 数据路径

1. 用户级 LaunchAgent 在图形会话登录后运行。buffered 管理常驻原生 JXA：系统通知优先观察应用和 Music，Music 以 2 秒异步采样兜底，硬件每 30 秒采集。
2. 采集只读取用户启用的字段，先隐私过滤再入队；只有变化才记录事件。Music 可使用本机 Apple 搜索补充匹配的封面和歌曲 URL。
3. 最近最多 900 秒保留为一份基线、字段替换事件和明确的采集缺口，存放在受限本机缓存。隐私设置变更清空队列并建立新会话。
4. 每 300 秒通过 HTTPS 将完整窗口发送到 `/api/batch`，一次请求一次 KV 写入。接收令牌保存在本机受限文件和 Cloudflare Secret，不进入事件内容。
5. Worker 验证 Bearer、512 KiB 上限、结构、时间和序号，覆盖固定键 `now`，设置 `window_end + 600 秒` 的绝对过期时间。旧包晚到不能延长它自己的期限。
6. 首页每 60 秒 GET `/api/timeline`，在页面内存中按事件时间播放，正常目标为延时 420 秒。缺少覆盖、休眠或采集间断时明确缓冲或缺口，不伪造连续状态。
7. `/api/now`、音乐、应用、设备和徽章接口将 v2 投影为服务器时间减 420 秒的切片；没有覆盖或落在缺口时为 offline。eco／realtime 仍通过 `/api/update` 提交 v1 快照，沿用旧读取语义。

应用分类接口使用随部署发布的原生图标清单，不向第三方搜索实时应用名。音乐封面由 Mac 原生查询，buffered 缓存窗口近期曲目、v1 缓存当前一首，URL 随窗口或快照推送；Worker 只验证和返回，不请求 Apple 或创建服务端匹配缓存。首页优先使用上报 URL，缺少有效 URL 时保留浏览器兼容查询。本机封面缓存不延长窗口或快照的有效期限。[API 契约](api.md) · [封面数据流](privacy.md#音乐-api-与封面上报)

部署开发工具使用 Node.js 和 Wrangler。Mac 上的常驻采集流程不依赖 Node.js、Python、jq、Homebrew 或第三方播放器；JavaScript for Automation（JXA）由系统的 `/usr/bin/osascript` 执行，不是 Node.js。

## 时间、离线与一致性

“在线”表示接口持有有效数据；buffered 分类接口展示的是延时切片，不是对 Mac 当前联网、解锁或用户在场的证明。设备休眠、注销、网络中断、令牌错误、权限失败和平台配额耗尽都可能造成停止更新。

Worker 使用服务端时间验证时间戳与过期。v2 按窗口末尾加 600 秒绝对过期，窗口最长 900 秒，因此最早事件可能被云端当前窗口保留约 25 分钟。v1 TTL 由服务器部署配置决定；每条记录保留原始截止时间。客户端不能任意指定保留期限。Cloudflare KV 支持的最短过期 TTL 是 60 秒，过期优先于其读取缓存。[Cloudflare KV 写入与过期规则](https://developers.cloudflare.com/kv/api/write-key-value-pairs/)

KV 是最终一致存储。不同边缘位置可能在 60 秒或更久之后才看见更新，不存在记录的结果也会被缓存。因此，某个读者可能暂时看到旧快照或 `offline`；不能承诺全球读者秒级同步。服务端新鲜度检查能拒绝读到的过期快照，不能让尚未传播的新快照立即可见。[Cloudflare KV 一致性说明](https://developers.cloudflare.com/kv/concepts/how-kv-works/)

API 禁止普通 HTTP 缓存状态，但 GitHub 图片代理、嵌入网站和第三方消费者仍可能自行缓存。SVG 徽章是展示入口，不适合用来验证精确的新鲜度。

## 配额与调度

一次成功推送写入一个键。buffered 每 300 秒约 288 次／日，比 eco 120 秒的 720 次少 60%；realtime 30 秒约 2880 次。变化条数影响包体大小，不增加每包写入次数。启动、手动发送、重试和同账户其他项目另计。[免费额度与更新策略](quotas.md)

网页每分钟读取窗口，在内存回放已经得到的变化；读到旧 KV 不回退播放头，断网时继续消耗有效覆盖，耗尽后停播。7 分钟是正常播放目标，传播异常或恢复期间延迟可能更长，超过保留范围的内容无法恢复。[完整恢复时序](buffering.md)

`launchd` 不是严格实时调度器。睡眠和任务执行耗时都会影响时间；同一任务不会并行无限堆积。系统调度的背景见 [Apple Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)。

## 有意保留的边界

- 单设备、单键；两台设备共享同一部署会互相覆盖，应分别部署。
- 有限期活动窗口，不建立长期历史数据库；没有用户系统、远程命令、端口监听或从 Worker 回连 Mac 的通道。
- 不承诺防止第三方保存公开快照；KV 的 TTL 不会删除第三方副本。
- 不把请求错误正文或令牌写入公开响应，不把歌曲或应用名称用于执行代码。
- 强一致、多设备仲裁、私有读取和持久历史属于后续独立设计，见 [路线图](roadmap.md)。
