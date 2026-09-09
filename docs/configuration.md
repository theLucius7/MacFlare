# 本机配置与后台运行

本页说明安装后的文件、隐私开关、更新和诊断命令。首次部署见 [快速开始](getting-started.md)；buffered 的采样、保存和播放策略集中在 [缓冲设计](buffering.md)。配置为 JSON，不作为 shell 脚本执行。安装后的默认位置：

| 路径 | 内容 |
| --- | --- |
| `~/Library/Application Support/MacFlare/config.json` | Worker 基础地址和隐私设置 |
| `~/Library/Application Support/MacFlare/token` | 接收令牌原文，不是 JSON |
| `~/Library/Application Support/MacFlare/agent/` | 安装脚本复制的 Bash 与原生 JXA 运行文件 |
| `~/Library/Application Support/MacFlare/last-result.json` | 最近一次上传结果，不含快照或令牌 |
| `~/Library/Application Support/MacFlare/artwork-cache.json` | v1 快照模式的当前单曲封面匹配缓存 |
| `~/Library/Application Support/MacFlare/window-cache.json` | buffered 时间跨度最多 900 秒的私有窗口检查点，可能落后当前内存窗口 |
| `~/Library/Application Support/MacFlare/window-lock` | buffered 单实例的内核文件锁 |
| `~/Library/LaunchAgents/com.macflare.agent.plist` | 用户级后台任务 |

安装目录权限为 `700`，配置与令牌为当前用户拥有的普通文件、权限 `600`。Agent 推送前检查配置和令牌的文件类型、所有者及权限，拒绝符号链接和过宽权限。令牌不进入 plist、curl 的进程参数或状态日志。

## 配置文件

仓库提供 [示例配置](https://github.com/xw7qwq/macflare/blob/main/agent/config.example.json)。以下为保留电池、负载、前台应用和音乐、关闭运行应用列表的示例：

```json
{
  "endpoint": "https://macflare.your-subdomain.workers.dev",
  "profile": "buffered",
  "privacy": {
    "active_app": true,
    "running_apps": false,
    "battery": true,
    "system": true,
    "music": true
  },
  "blocked_apps": ["Example Private App"]
}
```

| 配置 | 默认值 | 行为 |
| --- | --- | --- |
| `endpoint` | 无 | 部署的 HTTPS origin；不要添加 `/api` 或 `/api/update`、查询参数、账号或密码 |
| `profile` | 新安装 `buffered`；旧配置未声明时 `realtime` | buffered 每 300 秒发送窗口；eco 每 120 秒、realtime 每 30 秒发送快照；修改后重装以更新调度 |
| `privacy.active_app` | `true` | 是否采集前台应用名称；关闭时输出 `null` |
| `privacy.running_apps` | `true` | 是否采集经过过滤的 GUI 应用名称；关闭时省略 `running_apps` |
| `privacy.battery` | `true` | 是否采集电池；关闭时数值/充电状态为 `null`，来源为 `unknown` |
| `privacy.system` | `true` | 是否采集负载；关闭时三个负载字段为 `null` |
| `privacy.music` | `true` | 是否读取 Music 并查询歌曲封面；关闭时状态为 `unavailable`，曲目与歌手为 `null`，本轮清理封面缓存 |
| `blocked_apps` | `[]` | 追加敏感应用名称，最多 128 个；单项非空、长度最多 200 |

未提供的隐私开关使用默认 `true`；要关闭某项必须显式写 `false`。开关值必须是 JSON 布尔值，不能写成 `"false"` 字符串。拒绝未知配置键，防止拼写错误悄悄失效。

仅回环地址 `localhost`、`127.0.0.1` 和 `[::1]` 允许 HTTP，供 Wrangler 本地开发。生产地址必须 HTTPS；Agent 不跟随重定向，也不禁用 TLS 校验。

## 敏感应用屏蔽

内置屏蔽 1Password、Bitwarden、Dashlane、KeePassXC、LastPass、Keychain Access、Passwords、SecurityAgent、System Settings、System Preferences 等敏感应用。常见内置软件同时按 Bundle ID 匹配，以减少本地化名称的影响。

`blocked_apps` 是追加名单，不能移除内置屏蔽。名称去除首尾空格后进行不区分大小写的完整匹配，不是子串或正则匹配。敏感前台应用替换为 `System`，运行列表中的敏感应用直接移除。新软件或改名软件可能不在名单内，安装前务必预览。

应用读取通过 macOS AppKit 的 `NSWorkspace` 完成，由系统 `osascript` 执行 JXA。它不读取窗口标题，也无需为这个功能控制 System Events。`running_apps` 只列可见 GUI 应用类别，按名称排序、去重，最多 64 个；为满足上传正文限制，极长列表还可能截短。

## 预览、推送与更新

```sh
# 使用默认已安装配置；配置不存在时以默认隐私设置只做预览。
/bin/bash agent/macflare.sh --print

# 使用指定配置预览，不读取令牌、不上传。
/bin/bash agent/macflare.sh --print --config /absolute/path/to/config.json

# 仅 eco／realtime：手动发送一次 v1 快照；buffered 配置会拒绝此命令。
/bin/bash agent/macflare.sh --once
```

自定义配置路径推送时，其同级目录必须有名为 `token` 的文件。Agent 接受 32–512 个合法 Bearer 字符的令牌，推荐 `openssl rand -hex 32` 生成的 64 字符值。Worker 可接受更宽的长度范围，但自带 Agent 应使用上述兼容值。

buffered 每 2 秒重新读取配置；endpoint、隐私或屏蔽名单变更会清空旧队列并建立新会话，立即安排新窗口上传，但不保证绕过 KV 传播立即撤回旧数据。快照模式在下次执行读取配置。修改 `profile` 必须重新运行安装脚本，以更新常驻／定时调度；仅快照模式需要匹配 Worker TTL。buffered 配置下 `--once` 和默认单次推送会直接拒绝，避免误用 v1 覆盖窗口；手动预览使用 `--print`，临时观察使用 `--observe`，常驻运行由安装后的 `--watch` 管理。修改仓库里的运行代码后，需要重装以更新后台使用的副本；再次安装会保留隐私设置和追加屏蔽名单。

## 音乐封面与本机缓存

buffered 为窗口内近期曲目维护有界内存封面缓存，容量和有效期见 [默认参数](buffering.md#默认参数)。匹配后补充对应音乐事件的 URL，不改变观测时刻、序号或播放状态；写入窗口检查点的 URL 随窗口一起裁剪。以下单曲 `artwork-cache.json` 规则用于 v1 快照与 `--print`。

播放／暂停且歌名、歌手齐全时，Agent 使用系统 `curl` 查询 Apple iTunes Search API：`term=歌名+歌手`、`entity=song`、`country=us`、`limit=5`，由 JXA 严格匹配标题、艺人与安全 HTTPS URL。单次 Apple 查询最多 5 秒，不重试、不跟随重定向，响应最多 128 KiB；不携带 `INGEST_TOKEN`，无需额外运行环境或新的系统授权。搜索失败时继续上传已有歌曲文字与其他指标。

有效私有配置所在目录为 `700`、缓存文件安全时，使用同目录权限 `600` 的 `artwork-cache.json`；否则使用本次临时缓存。缓存仅保存当前一首的规范化歌名／歌手、缓存写入与截止时间，以及 URL 对或失败结果。成功复用 1 小时，失败或无匹配复用 5 分钟；换歌替换旧项。检测到停止、不可读、元数据不全或关闭 `privacy.music` 时清理；缓存到期后由后续采集周期按需查询，不保存历史列表。

只有获得安全匹配时才附带成对的 `music.artwork_url` 与 `music.track_url`，随现有快照一次上传，不增加定时推送或 KV 写入次数。`--print` 也可能向 Apple 查询公开曲目，但不上传 Worker、不读取接收令牌；没有有效私有配置时使用临时缓存。查看日志或提交问题前，留意预览与缓存中可能包含当前歌曲信息。

先 [升级 Worker](deployment.md#升级音乐封面上报) 再重新安装 Agent。旧 Agent 没有 URL 字段时仍可正常上报，`/api/music` 返回双 `null`；旧 Worker 不支持新字段，会返回 `400 invalid_payload`。

## 安装选项

```sh
# 常规安装；终端中安全提示输入令牌。
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev

# 从已有的私有令牌文件读取，适合非交互安装。
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev --token-file /private/path/token

# 只安装文件供检查，不加载后台任务。
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev --no-start

# 切换为滑动窗口；先部署支持 /api/batch 的 Worker。
/bin/bash scripts/install.sh --profile buffered

# 更新现有安装，复用 endpoint、token 和已有 profile。
/bin/bash scripts/install.sh
```

不用 `sudo`。安装目标始终是当前用户，不是系统级 LaunchDaemon。`--no-start` 也会停止已有的同名后台任务，再替换安装文件；它适合先配置隐私再启动。首次安装前如果希望设置隐私，可先以 `--no-start` 安装、编辑私有配置并预览，再运行不带 `--no-start` 的安装命令。

## 调度和诊断

所有模式都生成用户图形会话的 `RunAtLoad: true` LaunchAgent。buffered 使用 `--watch`、`KeepAlive` 与 15 秒 `ThrottleInterval` 管理常驻 JXA；内核文件锁避免多个采集器同时运行。eco／realtime 使用 `StartInterval` 定时执行单次快照。

buffered 的应用／Music 语义变化先进入有序内存窗口，按策略合并私有检查点；设备休眠、程序崩溃或观察缺失不补造数据。检查点、硬件阈值、恢复和重试规则统一见 [滑动窗口与延时播放](buffering.md#变化记录、落盘与展示)。这些值是固定策略，没有对应的 `interval` 或新配置键；手动编辑 plist 会在重装时被覆盖。休眠或注销不会为了维持上传主动唤醒机器。

可在独立临时目录中观察原生采集器，不上传实际活动；只输出统计，结束删除临时窗口：

```sh
/bin/bash agent/macflare.sh --observe 30
```

`--observe` 支持 1–300 秒，启用音乐时仍可能向 Apple 查询歌曲封面，不适合当成完全无网络的检查。`--print` 仍输出 v1 快照供隐私预览；两者都不替代已安装后台周期的验收。

```sh
launchctl print "gui/$(id -u)/com.macflare.agent"
cat "$HOME/Library/Application Support/MacFlare/last-result.json"
```

最近一次**执行到上传阶段**的结果形如：

```json
{"last_attempt":"2026-09-08T08:00:01.000Z","success":true,"curl_exit_code":0,"http_status":200}
```

配置校验或采集阶段就失败时，这个文件可能没有更新，不能仅凭旧的 `success: true` 判断后台正常。LaunchAgent 标准输出与错误输出指向 `/dev/null`。结果日志不保存应用/歌曲或令牌，但 buffered 的窗口检查点有短期活动数据；不要将检查点提交到 Issue。buffered 的结果还包含 `mode`、`batch_seq`、`event_count`、`next_attempt` 等调度统计。

上传连接限时 5 秒、上传总请求限时 12 秒；Apple 封面查询另有单次 5 秒上限，Music 自动化也有单独限时。buffered 的上传失败由 [窗口重试策略](buffering.md#缓存、故障与恢复) 处理；快照模式在下一调度周期继续。

## 停止与卸载

```sh
# 停止后台，删除代码、plist 和窗口／封面缓存，保留配置与令牌。
/bin/bash scripts/uninstall.sh

# 同时删除配置、令牌和最近上传结果。
/bin/bash scripts/uninstall.sh --purge
```

卸载不删除 Cloudflare Worker 或 KV 命名空间。buffered 最后窗口在 `window_end + 600 秒` 截止；快照模式通常为 eco 180 秒、realtime 60 秒。停止后仍可能播放已经上传且覆盖播放头的延时数据，到期或覆盖耗尽后停止；第三方缓存可能继续展示先前保存的状态。永久删除云端部署见 [部署指南](deployment.md#停止与删除)。
