<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const snapshot = ref(null);
const loading = ref(true);
const failed = ref(false);
const clock = ref(Date.now());
const nextRequest = ref(0);
let timer;
let controller;
let disposed = false;
const online = computed(() => snapshot.value?.status === 'online'
  && Number.isFinite(Date.parse(snapshot.value.expires_at))
  && clock.value < Date.parse(snapshot.value.expires_at));
const data = computed(() => online.value ? snapshot.value : null);
const statusText = computed(() => loading.value && !snapshot.value ? '正在读取'
  : failed.value ? '暂时无法读取' : online.value ? '在线快照' : '当前离线');
const age = computed(() => data.value ? Math.max(0, Math.floor((clock.value - Date.parse(data.value.updated_at)) / 1000)) : 0);
const countdown = computed(() => Math.max(0, Math.ceil((nextRequest.value - clock.value) / 1000)));
const battery = computed(() => data.value?.battery?.percent == null ? '未公开' : `${data.value.battery.percent}%`);
const power = computed(() => !data.value ? '等待新快照' : data.value.battery.charging ? '正在充电'
  : data.value.battery.power_source === 'ac' ? '已连接电源' : data.value.battery.power_source === 'battery' ? '使用电池' : '供电状态未知');
const musicLabel = computed(() => ({ playing: '正在播放', paused: '已暂停', stopped: '未播放', unavailable: '未公开或未授权' }[data.value?.music?.state] || '等待新快照'));
const song = computed(() => ['playing', 'paused'].includes(data.value?.music?.state) ? data.value.music.track || '曲目信息不可用' : '—');

async function refresh() {
  if (disposed || document.hidden || controller || Date.now() < nextRequest.value) return;
  nextRequest.value = Date.now() + 120000;
  loading.value = true;
  controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 12000);
  try {
    const response = await fetch('/api/now', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Status request failed');
    const body = await response.json();
    if (!['online', 'offline'].includes(body?.status)
      || (body.status === 'online' && (!Number.isFinite(Date.parse(body.expires_at)) || !body.battery || !body.music || !body.system))) {
      throw new Error('Invalid status response');
    }
    if (!disposed) { snapshot.value = body; failed.value = false; }
  } catch {
    if (!disposed) { snapshot.value = null; failed.value = true; }
  } finally {
    clearTimeout(timeout);
    controller = null;
    if (!disposed) { loading.value = false; clock.value = Date.now(); }
  }
}
function tick() { clock.value = Date.now(); void refresh(); }
onMounted(() => {
  disposed = false;
  tick();
  timer = setInterval(tick, 1000);
  document.addEventListener('visibilitychange', tick);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  controller?.abort();
  document.removeEventListener('visibilitychange', tick);
});
</script>

<template>
  <section class="now-panel" aria-label="Mac 当前状态">
    <div class="now-heading">
      <span class="now-status" :class="{ online }" role="status"><i aria-hidden="true" />{{ statusText }}</span>
      <a href="/api/now" target="_blank" rel="noopener">查看 JSON ↗</a>
    </div>
    <p v-if="failed" class="now-notice">状态接口暂时不可用，稍后将自动重试。</p>
    <p v-else-if="!online && !loading" class="now-notice">没有新鲜快照。Mac 可能已休眠、停止上报，或更新尚未传播。</p>
    <div class="now-grid">
      <div class="now-metric"><span class="now-label">电池</span><strong>{{ battery }}</strong><span>{{ power }}</span></div>
      <div class="now-metric"><span class="now-label">前台应用</span><strong class="now-title">{{ data?.active_app || '未公开' }}</strong><span>{{ data?.active_app === 'System' ? '敏感应用已隐藏' : '仅公开应用名称' }}</span></div>
      <div class="now-metric now-music"><span class="now-label">Apple Music · {{ musicLabel }}</span><strong class="now-title">{{ song }}</strong><span>{{ data?.music?.artist || '—' }}</span></div>
      <div class="now-metric"><span class="now-label">系统负载 · 1 分钟</span><strong>{{ data?.system?.load_1m == null ? '—' : data.system.load_1m.toFixed(2) }}</strong><span>5 分钟 {{ data?.system?.load_5m ?? '—' }} · 15 分钟 {{ data?.system?.load_15m ?? '—' }}</span></div>
    </div>
    <div class="now-apps">
      <span class="now-label">运行中的 GUI 应用</span>
      <ul v-if="data?.running_apps?.length"><li v-for="app in data.running_apps" :key="app">{{ app }}</li></ul>
      <p v-else>{{ data && Array.isArray(data.running_apps) ? '当前没有可公开的应用' : '未公开' }}</p>
    </div>
    <div class="now-footnote">
      <span>{{ online ? `${age} 秒前收到快照` : '只显示有效期内的数据' }} · {{ loading ? '读取中' : `${countdown} 秒后可刷新` }}</span>
      <button type="button" :disabled="loading || countdown > 0" @click="refresh">刷新</button>
    </div>
  </section>
</template>

<style scoped>
.now-panel { margin: 28px 0 36px; border: 1px solid var(--vp-c-divider); border-radius: 16px; overflow: hidden; background: var(--vp-c-bg); }
.now-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 22px; background: var(--vp-c-bg-soft); font-size: 14px; }
.now-status { display: inline-flex; align-items: center; gap: 8px; font-weight: 650; }
.now-status i { width: 8px; height: 8px; border-radius: 50%; background: var(--vp-c-text-3); }
.now-status.online i { background: #299960; }
.now-notice { margin: 0; padding: 14px 22px; background: var(--vp-c-brand-soft); font-size: 14px; }
.now-grid { display: grid; grid-template-columns: 1fr 1fr; }
.now-metric { min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 22px; border-bottom: 1px solid var(--vp-c-divider); }
.now-metric:nth-child(odd) { border-right: 1px solid var(--vp-c-divider); }
.now-label { font-size: 14px; font-weight: 600; color: var(--vp-c-text-2); }
.now-metric strong { font-size: 34px; line-height: 1.3; font-weight: 650; letter-spacing: -.035em; }
.now-metric strong.now-title { font-size: 23px; letter-spacing: -.025em; overflow-wrap: anywhere; }
.now-metric > span:last-child { font-size: 14px; color: var(--vp-c-text-2); overflow-wrap: anywhere; }
.now-apps { padding: 20px 22px; }
.now-apps ul { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
.now-apps li { margin: 0; padding: 4px 10px; border: 1px solid var(--vp-c-divider); border-radius: 6px; font-size: 14px; overflow-wrap: anywhere; }
.now-apps p { font-size: 14px; margin-bottom: 0; color: var(--vp-c-text-2); }
.now-footnote { padding: 14px 22px; border-top: 1px solid var(--vp-c-divider); display: flex; gap: 12px; justify-content: space-between; align-items: center; font-size: 14px; color: var(--vp-c-text-2); }
.now-footnote button { flex: 0 0 auto; border: 1px solid var(--vp-c-divider); padding: 4px 12px; border-radius: 6px; font: inherit; color: var(--vp-c-brand-1); }
.now-footnote button:disabled { color: var(--vp-c-text-3); cursor: not-allowed; }
.now-footnote button:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 3px; }
@media (max-width: 540px) {
  .now-grid { grid-template-columns: 1fr; }
  .now-metric:nth-child(odd) { border-right: 0; }
  .now-heading, .now-metric, .now-apps, .now-footnote { padding-left: 18px; padding-right: 18px; }
}
</style>
