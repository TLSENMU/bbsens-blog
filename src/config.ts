export const siteConfig = {
	siteTitle: 'From BBS',
	siteSubtitle: '此间春秋',
	siteDescription: '天地星空山川，峰谷雲室霧苔',
	siteUrl: 'https://frombbs.com',
	author: 'BBS',
	language: 'zh-CN',
	headerVariant: 'stacked',
	theme: 'modern-editorial',
	nav: [
		{ href: '/', label: '首页' },
		{ href: '/journey/', label: '在路上' },
		{ href: '/food/', label: '食' },
		{ href: '/people/', label: '物与人' },
		{ href: '/about/', label: '关于我' },
	],
} as const;

export type SiteConfig = typeof siteConfig;
