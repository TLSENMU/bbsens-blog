export const siteConfig = {
	name: "BBSen's Blog",
	description: '游记、食记、生活感悟，以及喜欢的物与人。',
	author: 'BBSen',
	siteUrl: process.env.PUBLIC_SITE_URL || 'https://example.com',
	theme: 'modern-editorial',
	locale: 'zh-CN',
	nav: [
		{ href: '/', label: '首页' },
		{ href: '/journey/', label: '在路上' },
		{ href: '/food/', label: '食' },
		{ href: '/people/', label: '物与人' },
		{ href: '/thoughts/', label: '思绪' },
		{ href: '/about/', label: '关于我' },
	],
};
