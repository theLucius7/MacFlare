# 博客与 README 接入

每个部署公开自己的当前快照。下面的 `YOUR_HOST` 应替换为你的域名，不包含 `https://`、路径或结尾斜杠。

## 读取 JSON

```sh
curl -sS https://YOUR_HOST/api/now
```

没有新鲜快照时返回 `{"status":"offline"}`。请求失败和设备离线是不同状态；展示层应分别处理，不能一直保留最后一次成功结果。

## 网页示例

下面在页面可见时最多每 120 秒读取一次，页面隐藏时停止轮询，并按服务器的 `expires_at` 清除过期展示。写入令牌不应出现在前端。

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
      output.textContent = '暂时无法读取状态';
    } finally { busy = false; }
  }
  const timer = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', tick);
  tick();
</script>
```

每秒执行的是本地截止时间检查，网络请求仍受 120 秒间隔限制。请使用 `textContent`，不要用 `innerHTML` 拼入应用名或歌曲名。大量访问者会累加读取次数，详见 [免费额度](quotas.md)。

## GitHub README 徽章

```md
![MacFlare](https://YOUR_HOST/api/badge.svg)
```

播放歌曲时显示歌名与歌手；否则显示前台应用或在线状态。GitHub 图片代理可能缓存 SVG，直接查询 `/api/now` 才适合核验快照的新鲜度。

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
