import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';

export type BlogPost = CollectionEntry<'blog'>;
export type CoverLayout = NonNullable<BlogPost['data']['coverLayout']>;

export const categoryMap = {
	journey: {
		label: '在路上',
		href: '/journey/',
		description: '把路途、城市、车窗、旅馆和抵达之前的心情写下来。',
		tone: '雾霭蓝',
		note: '给远处、清晨和路上的风。',
	},
	food: {
		label: '食',
		href: '/food/',
		description: '记录餐桌、味道、小店、菜单，以及一次饭里藏着的生活。',
		tone: '浅陶杏',
		note: '给热汤、炉火和靠窗的桌子。',
	},
	people: {
		label: '物与人',
		href: '/people/',
		description: '写喜欢的设计、装修、作家、物件，也写朋友和那些值得反复想起的人。',
		tone: '灰橄榄',
		note: '给房间、书页和人与人之间的细节。',
	},
	thoughts: {
		label: '思绪',
		href: '/thoughts/',
		description: '放一些不急着归类的念头、感受、疑问和慢慢想明白的事。',
		tone: '鸢尾灰',
		note: '给散步时冒出来、后来又留下来的想法。',
	},
} as const;

export function getPostSlug(post: BlogPost) {
	return post.id.replace(/\/index\.(md|mdx)$/i, '').replace(/\.(md|mdx)$/i, '');
}

export function getPostUrl(post: BlogPost) {
	return `/blog/${getPostSlug(post)}/`;
}

export function sortPostsByDate(posts: BlogPost[]) {
	return [...posts].sort(
		(a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime(),
	);
}

export const sortPosts = sortPostsByDate;

export function isPublishedPost(post: BlogPost) {
	return !post.data.draft;
}

export function isPublicPost(post: BlogPost) {
	return isPublishedPost(post) && !post.data.unlisted;
}

export async function getPublishedPosts() {
	return sortPostsByDate(await getCollection('blog', isPublishedPost));
}

export async function getPublicPosts() {
	return sortPostsByDate(await getCollection('blog', isPublicPost));
}

export async function getUnlistedPostBySlug(slug: string) {
	const posts = await getCollection('blog', (post) => isPublishedPost(post) && post.data.unlisted);
	return posts.find((post) => getPostSlug(post) === slug);
}

export function formatDate(date: Date, locale = 'zh-CN') {
	return new Intl.DateTimeFormat(locale, {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	}).format(date);
}

export function getWritingSeason(date: Date) {
	const month = date.getMonth() + 1;
	const season = month <= 2 || month === 12 ? '冬' : month <= 5 ? '春' : month <= 8 ? '夏' : '秋';
	return `${date.getFullYear()} 年${season}季`;
}

export function estimateReadingTime(text = '') {
	const latinWords = text.match(/[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*/g)?.length ?? 0;
	const cjkChars = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
	const minutes = Math.max(1, Math.ceil((latinWords + cjkChars / 2) / 220));
	return `${minutes} min read`;
}

export function slugifyTag(tag: string) {
	return tag.trim().toLowerCase().replace(/\s+/g, '-');
}

export function unslugifyTag(slug: string) {
	return slug.replace(/-/g, ' ');
}

export function getAllTags(posts: BlogPost[]) {
	const counts = new Map<string, number>();
	for (const post of posts) {
		for (const tag of post.data.tags) {
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
	}
	return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'));
}

export function getPostsByCategory(posts: BlogPost[], category: keyof typeof categoryMap) {
	return sortPostsByDate(posts).filter((post) => post.data.category === category);
}

export function getAdjacentPosts(posts: BlogPost[], post: BlogPost) {
	const sorted = sortPostsByDate(posts).filter((item) => isPublicPost(item));
	const index = sorted.findIndex((item) => item.id === post.id);
	return {
		next: index > 0 ? sorted[index - 1] : undefined,
		prev: index >= 0 && index < sorted.length - 1 ? sorted[index + 1] : undefined,
	};
}

export function getRelatedPosts(posts: BlogPost[], post: BlogPost) {
	const tags = new Set(post.data.tags);
	return sortPostsByDate(posts)
		.filter((item) => item.id !== post.id && isPublicPost(item))
		.map((item) => ({
			post: item,
			score: item.data.tags.filter((tag) => tags.has(tag)).length,
		}))
		.filter((item) => item.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, 2)
		.map((item) => item.post);
}

export function getCoverLayout(post: BlogPost): CoverLayout {
	return post.data.coverLayout ?? 'standard';
}
