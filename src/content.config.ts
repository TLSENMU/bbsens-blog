import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	schema: z.object({
		title: z.string(),
		description: z.string(),
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

export const collections = { blog, seasons };
