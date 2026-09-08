# 免费额度与更新策略

**默认 buffered 每 5 分钟发送最近 15 分钟的变化，正常延时 7 分钟播放。** 每个集合包只写一次 KV，应用切换和换歌的数量不会增加该包的写入次数。[窗口设计](buffering.md)

## 先算写入

每次成功的 `/api/batch` 或 `/api/update` 都覆盖同一个 KV 键，重复内容也计数。

| 策略 | 每日定时写入 | 占免费写入额度 | 取舍 |
| --- | --- | --- | --- |
| buffered：300 秒一包，900 秒窗口 | 288 | 28.8% | 新安装默认；正常延时 420 秒播放，包含已观测变化 |
| eco：120 秒快照，180 秒 TTL | 720 | 72% | 兼容模式；两次快照之间的切换不会保留 |
| realtime：30 秒快照，60 秒 TTL | 2,880 | 288% | 兼容模式；需控制时长或自行选择套餐 |

计算为 `86,400 ÷ 上传间隔秒数`。buffered 比 eco 少写 60%，比 realtime 少写 90%。Cloudflare KV 免费计划当前每天 1,000 次键写入、100,000 次键读取，UTC 00:00 重置，额度由同账户共享；拆分命名空间不会增加额度。[官方配额](https://developers.cloudflare.com/kv/platform/pricing/)

288 次是全天定时估算，不是强制上限。启动、手动发送、重试、测试和其他项目额外计数。三台设备全天 buffered 约 864 次，余量已很小；四台约 1,152 次会超过免费写入额度。没有账户级硬额度保护，也不会自动购买套餐。

一包使用一个 KV 值，应用上限为 512 KiB、2048 个事件与 128 个缺口，低于 KV 单值 25 MiB 限制。KV 同键写入上限为每秒一次；把事件拆成许多键既增加写入也破坏当前单包契约。[官方限制](https://developers.cloudflare.com/kv/platform/limits/)

## 切换模式

### 切换到 buffered

先部署支持窗口协议的 Worker，再迁移当前用户的安装：

```sh
npm run deploy
/bin/bash scripts/install.sh --profile buffered
```

安装复用 endpoint、token 和隐私选项，改为由 `launchd` 管理常驻原生 JXA 采集器。旧安装保留已有 profile；未声明 profile 的旧配置仍按 realtime 解释，不会在升级时悄悄扩大状态采集保留范围。

v2 过期时间固定为 `window_end + 600 秒`，不受 `STATUS_TTL_SECONDS` 影响。首次正常暖机约 7 分钟；网络或 KV 传播异常时可能更久，不能只因一时 `/api/now` 离线判断安装失败。[迁移与验收](deployment.md#升级滑动窗口模式)

### 保留或回退快照模式

eco 使用 `STATUS_TTL_SECONDS: "180"`，realtime 使用 `"60"`；先部署对应配置再切换 Agent：

```sh
# Worker 已设为180秒时。
/bin/bash scripts/install.sh --profile eco

# Worker 已设为60秒时。
/bin/bash scripts/install.sh --profile realtime
```

Worker 接受 60–3600 秒整数快照 TTL；未设置时兼容旧部署，使用 60 秒，无效值返回 503。每条 v1 快照保留写入时的截止时间，读取采用该时间与当前策略截止时间的较早值；提高配置不会让旧记录超出原期限。改 TTL 不会改变 Agent 的上传间隔。

## 为什么变化去重仍需要定时包

buffered 只把实际发生变化的字段加入事件队列；状态不变时不添加重复事件。不过窗口仍需向前移动，让访问者知道已经观测到哪一刻。完全停止上传会让云端过期，也无法区分静止状态与设备失联。因此变化去重减少包体，固定上传间隔减少 KV 写入；二者各有用途。

## 读取也有额度

`GET /api/timeline`、`/api/now`、`/api/music`、`/api/apps/active`、`/api/apps/running`、`/api/device` 与 `/api/badge.svg` 每次都读取一次 KV，不写入 KV。不要因 KV 内部有缓存就假定不计费；HTTP 响应仍使用 `no-store`，避免缓存超过状态截止时间。[KV 读取规则](https://developers.cloudflare.com/kv/api/read-key-value-pairs/)

动态页面每轮只读一次 `/api/timeline`，在内存播放；简单状态页面每轮只读一次 `/api/now`。如果每 60 秒分别调用四个分类接口，单页约读 5,760 次/日；调用一次时间线接口约读 1,440 次/日。分类接口只是方便独立小组件，不会共享一次 KV 操作；并行调用还可能读到不同的快照。

首页在 buffered 下每 60 秒读取一次窗口，兼容 v1 时恢复 120 秒间隔，页面隐藏时暂停；其他文档页面不自动加载状态。一个持续打开的主页约读 1,440 次/日，多个访问者会累加，重新打开页面另计。事件播放与画面变化不发起 KV 请求。静态文档、样式和本地搜索不访问 KV。

`/api/health` 不读 KV，但仍会消耗 Worker 请求配额。公开接口无法阻止第三方大量请求；本项目没有账户级硬额度保证。[Workers 免费限制](https://developers.cloudflare.com/workers/platform/limits/)

## 封面查询的请求与缓存

Mac Agent 在本机向 Apple 查询当前曲目，成功 URL 随原有快照一次推送，不单独触发上传。buffered 仍每 300 秒上传一包、全天约 288 次定时写入；封面可选字段只增加少量正文大小，不增加 KV 写入次数。

buffered 在内存缓存最近最多 64 首：成功 900 秒、失败／无匹配 300 秒；v1 仅缓存当前一首，成功 1 小时、失败 5 分钟，换歌替换；检测到停止、状态不可用、元数据不全或关闭音乐采集时清理。Apple 查询单次最多 5 秒，不重试、不跟随重定向；缓存到期后在后续采集周期按需查询。不同歌曲仍会产生独立 Apple 请求，不能承诺固定搜索次数。[本机缓存](configuration.md#音乐封面与本机缓存)

`/api/music` 每次只读取一次 KV，直接返回快照中的封面与歌曲 URL；不查询 Apple、不额外写 KV，也不使用服务端封面缓存。重复刷新该接口不会重新搜索曲目。

首页优先使用有效上报 URL，由浏览器加载 Apple 图片 CDN。缺少有效 URL 时保留浏览器兼容查询：页面内存最多 50 条，成功 1 小时、普通失败或无匹配 5 分钟，取消请求不缓存；失败重试间隔至少 5 分钟，页面隐藏或快照失效时不重试。首页只轮询 `/api/timeline`，不会额外轮询音乐接口。Apple 服务与图片请求不属于 Cloudflare KV 配额。[数据流与隐私](privacy.md#首页歌曲封面)

## 应用图标的请求与额度

原生图标由 `npm run icons:export` 在开发用 Mac 上一次导出，不调用 macOSicons，不消耗其额度；普通构建直接使用仓库中的 PNG 与清单。

| 图标读取方式 | Worker 执行 | KV | 第三方图标搜索 |
| --- | --- | --- | --- |
| `/app-icons/<id>.png`、`/app-icons/index.json` 静态资源 | 无 | 无 | 无 |
| `/api/icons`、`/api/icons/<id>.png` API | 有，计 Worker 请求 | 无 | 无 |
| 可选 macOSicons 补充图片 | 浏览器直连 CDN | 无 | 页面访问不搜索 |

首页使用静态图片路径；只需嵌入图标时也推荐该路径。API 成功响应允许缓存 1 小时并支持 ETag 条件请求，但实际进入 API 的请求仍计 Worker 请求，不能视为无限免费接口。[Cloudflare 静态资源计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)

可选 macOSicons 搜索只在维护者运行 `npm run icons:sync` 时发生。已有原生图标的配置项直接跳过，`--force` 也不会查询它们，因此当前仓库原生图标集不消耗搜索额度。只对缺少原生图标的配置项匹配；剩余有效期超过 2 天的补充记录会复用，每个需要查询的应用最多搜索一次且不自动重试。补充记录最多有效 30 天，过期后需重新同步并部署；`--force` 仅对这些补充项跳过复用，额外消耗额度。

macOSicons 的 `GET /api/v1/usage` 只读返回当前 Key 的月度 `used`、`limit`、`remaining` 和 UTC 重置时间，不消耗查询额度；以自己的返回值为准。例如搜索限额为 50 次/月时，只新增 3 个缺少原生图标的配置项，一次同步最多使用 3 次；反复强制同步仍可能耗尽额度。本项目不会自动升级套餐。[官方用量接口](https://macosicons.com/developers.md) · [图标配置与同步](app-icons.md)

## 如果还需要更低消耗

- 缩短需要公开在线状态的时段，Mac 休眠、注销后自然停止推送。
- 减少网站轮询和不必要的手动上报；关闭采集字段能减少公开内容，但不减少每次推送的 KV 操作次数。
- 多设备或必须更快更新时，另行评估存储模型或套餐。Durable Objects 需要重新设计与核算，不能直接视为“无限免费 KV”。

KV 最终一致；延时缓冲能吸收部分抖动，不能保证传播延迟上限或跨地区连续播放。[一致性边界](architecture.md#时间离线与一致性)
