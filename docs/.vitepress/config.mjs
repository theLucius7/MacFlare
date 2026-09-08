import { defineConfig } from 'vitepress';
import { copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  lang: 'zh-CN',
  title: 'MacFlare',
  description: 'macOS 原生状态采集、Cloudflare 部署与公开 API 文档。',
  base: '/',
  cleanUrls: true,
  lastUpdated: true,
  sitemap: { hostname: 'https://macflare.lucius7.dev/' },
  head: [['meta', { name: 'theme-color', content: '#18334d' }]],
  themeConfig: {
    siteTitle: 'MacFlare',
    nav: [
      { text: '快速开始', link: '/getting-started' },
      { text: 'API', link: '/api' },
      { text: '免费额度', link: '/quotas' },
      { text: 'GitHub', link: 'https://github.com/theLucius7/MacFlare' },
    ],
    sidebar: [
      { text: '开始使用', items: [
        { text: '当前状态与概览', link: '/' },
        { text: '快速开始', link: '/getting-started' },
        { text: '部署与自定义域名', link: '/deployment' },
        { text: '本机配置与调度', link: '/configuration' },
      ] },
      { text: '接入与运行', items: [
        { text: 'HTTP API v1', link: '/api' },
        { text: '博客与 README 接入', link: '/integrations' },
        { text: '应用图标配置', link: '/app-icons' },
        { text: '免费额度与更新策略', link: '/quotas' },
        { text: '故障排查', link: '/troubleshooting' },
      ] },
      { text: '理解与贡献', items: [
        { text: '架构与一致性', link: '/architecture' },
        { text: '隐私与威胁模型', link: '/privacy' },
        { text: '文档开发与发布', link: '/documentation' },
        { text: '路线图', link: '/roadmap' },
      ] },
    ],
    search: { provider: 'local', options: { translations: { button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' }, modal: { noResultsText: '没有找到结果', resetButtonTitle: '清除搜索', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } } } } },
    outline: { level: [2, 3], label: '本页内容' },
    sidebarMenuLabel: '目录', returnToTopLabel: '返回顶部',
    darkModeSwitchLabel: '外观',
    docFooter: { prev: '上一页', next: '下一页' },
    lastUpdated: { text: '最后更新' },
    editLink: { pattern: 'https://github.com/theLucius7/MacFlare/edit/main/docs/:path', text: '在 GitHub 编辑此页' },
    footer: { message: 'MIT License · 文档使用本地搜索，无第三方分析脚本。', copyright: 'MacFlare contributors' },
  },
  async buildEnd(siteConfig) {
    await copyFile(fileURLToPath(new URL('../openapi.yaml', import.meta.url)), `${siteConfig.outDir}/openapi.yaml`);
  },
});
