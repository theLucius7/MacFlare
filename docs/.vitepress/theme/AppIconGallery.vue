<script setup>
import { computed, ref } from 'vue';
import catalog from '../../public/app-icons/index.json';

const query = ref('');
const icons = computed(() => {
  const search = query.value.normalize('NFKC').trim().toLowerCase();
  return catalog.icons.filter(icon => [icon.app, icon.id, ...icon.aliases]
    .some(name => name.normalize('NFKC').toLowerCase().includes(search)));
});
</script>

<template>
  <section class="icon-gallery" aria-label="已缓存应用图标">
    <label for="icon-filter">查找图标 · 共 {{ catalog.icons.length }} 个</label>
    <input id="icon-filter" v-model="query" type="search" placeholder="应用名称、中文名或 ID" autocomplete="off">
    <ul v-if="icons.length">
      <li v-for="icon in icons" :key="icon.id">
        <img :src="`/app-icons/${icon.id}.png`" :alt="`${icon.app} 图标`" width="48" height="48" loading="lazy" decoding="async">
        <strong>{{ icon.app }}</strong>
        <code>{{ icon.id }}</code>
        <div><a :href="`/app-icons/${icon.id}.png`" target="_blank" rel="noopener">静态图片 ↗</a><a :href="icon.imageUrl" target="_blank" rel="noopener">图片 API ↗</a></div>
      </li>
    </ul>
    <p v-else role="status">没有匹配的图标。</p>
    <p class="icon-gallery-credit">© 各软件作者。这里是已发布的图标清单，与 Mac 当前运行的应用列表无关。</p>
  </section>
</template>

<style scoped>
.icon-gallery { margin: 24px 0; }
.icon-gallery label { display: block; margin-bottom: 8px; font-weight: 600; }
.icon-gallery input { width: 100%; border: 1px solid var(--vp-c-divider); border-radius: 8px; padding: 10px 14px; background: var(--vp-c-bg-soft); color: var(--vp-c-text-1); font: inherit; }
.icon-gallery input:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 2px; }
.icon-gallery ul { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; padding: 0; margin: 16px 0; list-style: none; }
.icon-gallery li { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-width: 0; padding: 16px; margin: 0; border: 1px solid var(--vp-c-divider); border-radius: 10px; }
.icon-gallery li strong { font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
.icon-gallery li code { font-size: 11px; overflow-wrap: anywhere; }
.icon-gallery li div { display: flex; flex-wrap: wrap; gap: 10px; margin-top: auto; font-size: 12px; }
.icon-gallery-credit { font-size: 13px; color: var(--vp-c-text-2); }
</style>
