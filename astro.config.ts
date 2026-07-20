import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { siteConfig } from './src/config';

// https://astro.build/config
export default defineConfig({
	site: siteConfig.siteUrl,
	integrations: [mdx(), sitemap()],
	markdown: {
		processor: unified({
			remarkPlugins: [remarkMath],
			rehypePlugins: [
				rehypeKatex,
				rehypeSlug,
				[
					rehypeAutolinkHeadings,
					{
						behavior: 'append',
						properties: {
							className: ['heading-anchor'],
							ariaLabel: 'Anchor link',
						},
						content: {
							type: 'text',
							value: '#',
						},
					},
				],
			],
		}),
		shikiConfig: {
			theme: 'github-light',
		},
	},
});
