import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		// 随笔一类的短文不强制写摘要；列表页、RSS、搜索都会优雅降级。
		description: z.string().optional(),
		publishDate: z.coerce.date(),
		updatedDate: z.coerce.date().optional(),
		tags: z.array(z.string()).default([]),
		cover: z.string().optional(),
		coverAlt: z.string().optional(),
		coverLayout: z.enum(['landscape', 'standard', 'portrait', 'wide']).default('standard'),
		coverPosition: z.string().default('50% 50%'),
		category: z.enum(['journey', 'food', 'people', 'thoughts']),
		draft: z.boolean().default(false),
		unlisted: z.boolean().default(false),
		featured: z.boolean().optional(),
		location: z.string().optional(),
		language: z.string().optional(),
	}),
});

const seasons = defineCollection({
	loader: glob({ base: './src/content/seasons', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		season: z.string(),
		year: z.number(),
		description: z.string(),
		cover: z.string().optional(),
		coverAlt: z.string().optional(),
		draft: z.boolean().default(false),
		publishDate: z.coerce.date(),
	}),
});

// 英文版。刻意只存「翻译出来的东西」：标题、摘要、正文。
// 日期、栏目、标签、封面全部从同 slug 的中文原文继承，
// 这样中文那边改了栏目或封面，英文页不会悄悄不同步。
const blogEn = defineCollection({
	loader: glob({ base: './src/content/blog-en', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		description: z.string().optional(),
		// 地点是唯一需要跟着翻的「元数据」：文章头那行写着「贵阳」，
		// 英文页上得是 Guiyang。其余栏目标签日期一律继承中文原文。
		location: z.string().optional(),
		// 默认 true：译出来先是草稿，得你在写作台上勾「发布英文版」才上线。
		draft: z.boolean().default(true),
		// 翻译时中文原文的指纹。原文改了就对不上，页面和写作台都会说「译文过期」。
		sourceHash: z.string().optional(),
		translatedAt: z.coerce.date().optional(),
		model: z.string().optional(),
	}),
});

// 关于页。就这一篇，放在集合里是为了走和文章同一套 Markdown 管线
// （remark-math、figure 处理、Shiki），而不是在 .astro 里写死 HTML。
const about = defineCollection({
	loader: glob({ base: './src/content/about', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		// 标题上面那行小字，现在是 About。
		kicker: z.string().default('About'),
		description: z.string(),
		updatedDate: z.coerce.date().optional(),
	}),
});

export const collections = { blog, seasons, blogEn, about };
