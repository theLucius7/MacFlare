# 本机配置与后台运行

配置为 JSON，不作为 shell 脚本执行。安装后的默认位置：

| 路径 | 内容 |
| --- | --- |
| `~/Library/Application Support/MacFlare/config.json` | Worker 基础地址和隐私设置 |
| `~/Library/Application Support/MacFlare/token` | 接收令牌原文，不是 JSON |
| `~/Library/Application Support/MacFlare/agent/` | 安装脚本复制的 Bash 与原生 JXA 运行文件 |
| `~/Library/Application Support/MacFlare/last-result.json` | 最近一次上传结果，不含快照或令牌 |
| `~/Library/LaunchAgents/com.macflare.agent.plist` | 用户级后台任务 |

安装目录权限为 `700`，配置与令牌为当前用户拥有的普通文件、权限 `600`。Agent 推送前检查配置和令牌的文件类型、所有者及权限，拒绝符号链接和过宽权限。令牌不进入 plist、curl 的进程参数或状态日志。

## 配置文件

仓库提供 [示例配置](../agent/config.example.json)。以下为保留电池、负载、前台应用和音乐、关闭运行应用列表的示例：

```json
{
  "endpoint": "https://macflare.your-subdomain.workers.dev",
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
| `endpoint` | 无 | 部署的 HTTPS origin；不要添加 `/update`、查询参数、账号或密码 |
| `privacy.active_app` | `true` | 是否采集前台应用名称；关闭时输出 `null` |
| `privacy.running_apps` | `true` | 是否采集经过过滤的 GUI 应用名称；关闭时省略 `running_apps` |
| `privacy.battery` | `true` | 是否采集电池；关闭时数值/充电状态为 `null`，来源为 `unknown` |
| `privacy.system` | `true` | 是否采集负载；关闭时三个负载字段为 `null` |
| `privacy.music` | `true` | 是否读取 Music；关闭时状态为 `unavailable`，曲目与歌手为 `null` |
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

# 使用默认已安装配置上传一次。
/bin/bash agent/macflare.sh --once
```

自定义配置路径推送时，其同级目录必须有名为 `token` 的文件。Agent 接受 32–512 个合法 Bearer 字符的令牌，推荐 `openssl rand -hex 32` 生成的 64 字符值。Worker 可接受更宽的长度范围，但自带 Agent 应使用上述兼容值。

修改已安装 `config.json` 后，下次执行直接读取新设置，无需重装。想立即让隐私变更生效，先预览，再手动推送一次。修改仓库里的运行代码后，需要重装以更新后台使用的副本；再次安装会保留隐私设置和追加屏蔽名单。

## 安装选项

```sh
# 常规安装；终端中安全提示输入令牌。
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev

# 从已有的私有令牌文件读取，适合非交互安装。
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev --token-file /private/path/token

# 只安装文件供检查，不加载后台任务。
/bin/bash scripts/install.sh --endpoint https://<worker>.<subdomain>.workers.dev --no-start

# 更新现有安装，复用 endpoint 和 token。
/bin/bash scripts/install.sh
```

不用 `sudo`。安装目标始终是当前用户，不是系统级 LaunchDaemon。`--no-start` 也会停止已有的同名后台任务，再替换安装文件；它适合先配置隐私再启动。首次安装前如果希望设置隐私，可先以 `--no-start` 安装、编辑私有配置并预览，再运行不带 `--no-start` 的安装命令。

## 调度和诊断

当前版本生成 `StartInterval: 30`、`RunAtLoad: true` 的 Aqua 用户会话 LaunchAgent。它在登录后运行；休眠和注销时不保持在线，也不主动唤醒设备。间隔目前固定 30 秒，没有 `interval` 配置键。重新安装会重新生成 plist，因此手动改 plist 不是持久的配置入口。默认所有有效快照均尝试上传，没有内置每日写入配额计数或暂停机制；使用免费 KV 时请结合 [配额约束](architecture.md#配额与调度) 控制运行时长。

```sh
launchctl print "gui/$(id -u)/com.macflare.agent"
cat "$HOME/Library/Application Support/MacFlare/last-result.json"
```

最近一次**执行到上传阶段**的结果形如：

```json
{"last_attempt":"2026-09-08T08:00:01.000Z","success":true,"curl_exit_code":0,"http_status":200}
```

配置校验或采集阶段就失败时，这个文件可能没有更新，不能仅凭旧的 `success: true` 判断后台正常。LaunchAgent 的标准输出和错误输出都指向 `/dev/null`，项目不保存应用/歌曲日志；用手动 `--once` 获取当前的简短错误。

网络连接限时 5 秒、总请求限时 12 秒；Music 自动化也有单独限时。一次采集或请求失败后由下个调度周期继续，不做无限重试。

## 停止与卸载

```sh
# 停止后台并删除安装的代码、plist，保留配置和令牌以便重装。
/bin/bash scripts/uninstall.sh

# 同时删除配置、令牌和最近上传结果。
/bin/bash scripts/uninstall.sh --purge
```

卸载不删除 Cloudflare Worker 或 KV 命名空间。最后一次接受的快照会在服务端新鲜度达到 60 秒后视为 offline；第三方缓存可能继续展示先前保存的状态。永久删除云端部署见 [部署指南](deployment.md#停止与删除)。
