# 博客与 README 接入

每个部署公开自己的有界窗口或兼容快照。下面的 `YOUR_HOST` 应替换为你的域名，不包含 `https://`、路径或结尾斜杠。

## 按需选择接口

| 需要的数据 | 调用 | 主要字段 | 每次 GET 的 KV 读取 |
| --- | --- | --- | --- |
| 连续延时播放 | `/api/timeline` | `window.baseline`、`events`、`gaps`、`policy` | 1 |
| 单个完整切片 | `/api/now` | `music`（含可选 URL）、应用名称、`battery`、`system` | 1 |
| 音乐小组件 | `/api/music` | `music.track`、`artist`、`artwork_url`、`track_url` | 1 |
| 前台应用 | `/api/apps/active` | `active_app.name`、`icon_url`、`icon_api_url` | 1 |
| 运行应用列表 | `/api/apps/running` | `running_apps[]`，每项含名称与图标地址 | 1 |
| 电池与负载 | `/api/device` | `device.battery`、`device.system` | 1 |
| 固定图标清单／PNG | `/api/icons`、`/api/icons/<id>.png` | 有限静态图标资源 | 0 |

下面是相互独立的调用示例，按需要选择。动态页面每 60 秒读取一次 `/api/timeline` 并在内存播放，简单页面只取一次 `/api/now`；不要并行轮询所有分类接口，它们不会合并 KV 读取。首页使用时间线，优先使用 Mac 上报的封面 URL，缺少有效 URL 时保留浏览器兼容查询。

```sh
# 音乐：歌名、歌手，以及可能为 null 的封面／歌曲链接。
curl -sS https://YOUR_HOST/api/music

# 前台应用：未知图标时仍保留应用名。
curl -sS https://YOUR_HOST/api/apps/active

# 运行应用：null 表示未采集，[] 表示已采集但没有条目。
curl -sS https://YOUR_HOST/api/apps/running

# 电池：读取 device.battery.percent、charging、power_source。
curl -sS https://YOUR_HOST/api/device
```

buffered 下四个分类接口显示服务器时间减 420 秒的切片，在线响应附 `playback`；首次暖机、缺口或窗口不覆盖目标时刻时为 offline。它们适合只需单次状态的小组件，不能靠低频轮询分类接口重现中间每次变化。

四个分类接口只接受规范 `/api/*` 路径，支持 GET／OPTIONS，不支持 HEAD；离线时统一返回 `{"status":"offline"}`，没有对应数据对象。完整结构见 [API 参考](api.md#分类状态接口)。

## 连续延时播放

```sh
curl -sS https://YOUR_HOST/api/timeline
```

v2 一次返回完整窗口，包含基线、变化和缺口。不要只取 `events` 的最后一项显示：窗口有意提前送达，让页面按各事件原来的时间间隔回放。以响应的 `server_time` 校准时钟，正常目标是该时间减 420 秒；顺序应用目标时刻之前的事件，遇到缺口或尚未覆盖的时间则显示缓冲／采集中断。

仓库提供可复用的 [WindowPlayback 状态机](https://github.com/xw7qwq/macflare/blob/main/shared/playback.js)，以及 [首页组件集成](https://github.com/xw7qwq/macflare/blob/main/docs/.vitepress/theme/NowStatus.vue)。先从同一仓库版本复制 `shared/playback.js` 与它直接依赖的 [shared/timeline.js](https://github.com/xw7qwq/macflare/blob/main/shared/timeline.js)，放入你自己前端入口旁的 `shared/` 目录，再由自己的构建工具打包或作为 ES modules 发布。下面的相对 import 指向你自己项目中的副本；本项目没有发布 npm 包，线上站点也不提供 `/shared/playback.js` 静态入口。最小调用顺序：

```js
import { WindowPlayback } from './shared/playback.js';
const player = new WindowPlayback();

// 每60秒获取一次，页面隐藏时暂停；网络错误时保留已有player。
const response = await fetch('https://YOUR_HOST/api/timeline', { cache: 'no-store' });
if (!response.ok) throw new Error('读取失败');
player.accept(await response.json(), performance.now());

// 每250毫秒在本地调用，不发网络请求。
const view = player.view(performance.now());
// view.state为playing时使用view.snapshot；否则呈现buffering/gap/offline。
```

持续使用同一个实例，避免每轮重新建立播放头。状态机处理旧窗口不倒退、短暂网络错误继续消费覆盖、窗口耗尽停播、新会话清旧状态及不可恢复缺口提示；它只保存内存数据。播放延迟在恢复时可超过 420 秒，不能为了追到固定延迟而跳过已缓存变化。[时序与恢复规则](buffering.md)

## 读取 JSON

```sh
curl -sS https://YOUR_HOST/api/now
```

没有新鲜快照时返回 `{"status":"offline"}`。请求失败和设备离线是不同状态；展示层应分别处理，不能一直保留最后一次成功结果。

## 简单切片网页示例

下面的简化示例只显示定时取得的一个切片，不连续回放中间变化；需要逐个展示变化时使用上一节的时间线。它在页面可见时最多每 120 秒读取一次，页面隐藏时停止轮询，并按服务器的 `expires_at` 清除过期展示。写入令牌不应出现在前端。

```html
<p id="macflare" aria-live="polite">加载中…</p>
<script type="module">
  const output = document.querySelector('#macflare');
  const origin = 'https://YOUR_HOST';
  let nextRequest = 0;
  let busy = false;
  let state = null;
  function render() {
    if (!state) return;
    if (state.status !== 'online' || Date.now() >= Date.parse(state.expires_at)) {
      output.textContent = 'Mac 当前离线';
      return;
    }
    output.textContent = `${state.active_app ?? '应用未公开'} · 电量 ${state.battery?.percent ?? '未知'}%`;
  }
  async function tick() {
    render();
    if (document.hidden || busy || Date.now() < nextRequest) return;
    busy = true;
    nextRequest = Date.now() + 120000;
    try {
      const response = await fetch(origin + '/api/now', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('Request failed');
      state = await response.json();
      render();
    } catch {
      state = null;
      render();
      output.textContent = '暂时无法读取状态';
    } finally { busy = false; }
  }
  const timer = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', tick);
  tick();
</script>
```

每秒执行的是本地截止时间检查，网络请求仍受 120 秒间隔限制。请使用 `textContent`，不要用 `innerHTML` 拼入应用名或歌曲名。大量访问者会累加读取次数，详见 [免费额度](quotas.md)。

## 音乐图片与应用图标

`/api/music` 返回 JSON，不能直接写成 `<img src="…/api/music">`。音乐小组件可将上方轮询代码的请求路径改为 `/api/music`，增加以下图片元素，并用下面的 `render` 替换原展示函数；保留原有 120 秒请求间隔、错误处理与本地过期检查。

```html
<img id="music-cover" alt="当前曲目封面" width="100" height="100" hidden>
```

```js
function render() {
  const fresh = state?.status === 'online' && Date.now() < Date.parse(state.expires_at);
  const music = fresh ? state.music : null;
  output.textContent = music
    ? `${music.track ?? '暂无曲目'} · ${music.artist ?? '未知歌手'} · ${music.state}`
    : 'Mac 当前离线';
  const cover = document.querySelector('#music-cover');
  const url = music?.artwork_url ?? null;
  cover.hidden = !url;
  if (url && cover.getAttribute('src') !== url) cover.src = url;
  if (!url) cover.removeAttribute('src');
}
```

使用非空 `music.track_url` 可另加歌曲链接。`/api/music` 不进行搜索，旧 Agent 未上报 URL 时两个字段均为 `null`；先升级 Worker 再更新 Agent 才能上报新字段。封面匹配失败时保留文字；不要自行挑选其他歌曲，也不要用封面缓存延长设备状态有效期。

前台应用的 `active_app.icon_url` 与运行列表每项的 `icon_url` 是相对部署根域名的静态图片路径；跨站嵌入时用 `new URL(icon_url, 'https://YOUR_HOST').href` 补全。非空时可作为图片地址，例如：

```html
<img src="https://YOUR_HOST/app-icons/visual-studio-code.png"
     alt="Visual Studio Code" width="48" height="48"
     title="应用图标版权归原作者">
```

`active_app` 为 `null` 时不渲染应用，`running_apps: null` 显示未采集、`[]` 显示无条目；图标地址为 `null` 时保留名称并显示占位。`icon_api_url` 指向同一 PNG 的统一 API 地址，适用于需要该入口的集成；静态 `icon_url` 不执行 Worker。

## GitHub README 徽章

```md
![MacFlare](https://YOUR_HOST/api/badge.svg)
```

播放歌曲时显示歌名与歌手；否则显示前台应用或在线状态。buffered 徽章使用同样的延时切片。GitHub 图片代理可能缓存 SVG，直接查询 `/api/timeline`／`/api/now` 才适合核验窗口／切片。

## 应用图标直链

先读取有限的公开图标清单，使用实际存在的 `id` 或返回的 `imageUrl`：

```sh
curl -sS https://YOUR_HOST/api/icons
```

图片 API 返回真实 PNG，可直接嵌入；以下 `visual-studio-code` 须存在于你的部署清单：

```html
<img src="https://YOUR_HOST/api/icons/visual-studio-code.png"
     alt="Visual Studio Code" width="48" height="48"
     title="应用图标版权归原作者">
```

仅需图片展示时，推荐将地址改为 `https://YOUR_HOST/app-icons/visual-studio-code.png`。它与 API 使用相同 PNG，但通过静态资源服务，无需执行 Worker；首页使用此方式。静态清单也可从 `/app-icons/index.json` 读取。

图标 API 支持 GET、HEAD、OPTIONS，成功缓存 1 小时并保留 ETag 条件请求；不读取 KV 或第三方服务，但计 Worker 请求。图标随部署保留，与 Mac 在线状态无关，不会从未知应用名即时生成图标。保留版权说明，图标不属于代码 MIT 授权范围。[图标维护](app-icons.md) · [API 契约](api.md)

## 客户端约定

- 只读请求无需 Bearer，不携带 Cookie 或接收 Secret。
- 处理 `null`、缺失的可选字段和 `offline`，容忍未来新增字段。
- 根据 `music.state` 判断是否播放，暂停时也可能有歌名。
- 使用 `expires_at` 判过期，不将 60 秒写死在客户端。
- 旧 `/now`、`/update`、`/badge.svg`、`/health` 暂保留兼容，新集成使用 `/api/*`。
