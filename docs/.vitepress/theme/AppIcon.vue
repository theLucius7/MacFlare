<script setup>
import { computed, ref, watch } from 'vue';
import catalog from './app-icons.json';
import installedIcons from '../../public/app-icons/index.json';
import { findAppIcon } from './app-icon-catalog.js';

const props = defineProps({
  name: { type: String, default: '' },
  size: { type: Number, default: 24 },
  now: { type: Number, default: Date.now },
});
const icon = computed(() => findAppIcon(props.name, installedIcons, props.now)
  || findAppIcon(props.name, catalog, props.now));
const imageUrl = computed(() => icon.value?.assetUrl || icon.value?.imageUrl);
const failed = ref(false);
const dimension = computed(() => Number.isFinite(props.size) && props.size > 0 ? Math.max(1, Math.round(props.size)) : 24);
const dimensions = computed(() => ({ width: `${dimension.value}px`, height: `${dimension.value}px` }));
const title = computed(() => icon.value ? `${icon.value.app}${icon.value.credit ? ` · ${icon.value.credit}` : ''}` : '');

watch([() => props.name, imageUrl], () => { failed.value = false; });
function imageError(event) {
  // A removed image may report an error after the application has changed.
  if (event.currentTarget?.getAttribute('src') === imageUrl.value) failed.value = true;
}
</script>

<template>
  <a v-if="icon && !failed" class="app-icon" :style="dimensions" :href="icon.sourceUrl || icon.imageUrl"
    :title="title" :aria-label="`${title} · 图标来源`" target="_blank" rel="noopener noreferrer">
    <img :key="imageUrl" :src="imageUrl" alt="" :width="dimension" :height="dimension"
      decoding="async" referrerpolicy="no-referrer" @error="imageError">
  </a>
  <span v-else class="app-icon app-icon-placeholder" :style="dimensions" aria-hidden="true">
    <svg viewBox="0 0 24 24" :width="dimension" :height="dimension" fill="none" focusable="false">
      <rect x="3" y="4" width="18" height="16" rx="4" />
      <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
    </svg>
  </span>
</template>

<style scoped>
.app-icon { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; vertical-align: middle; border-radius: 22%; }
.app-icon img { display: block; width: 100%; height: 100%; object-fit: contain; }
.app-icon-placeholder { color: var(--vp-c-text-3); background: var(--vp-c-bg-soft); }
.app-icon-placeholder svg { stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.app-icon:focus-visible { outline: 2px solid var(--vp-c-brand-1); outline-offset: 3px; }
</style>
