import { getCollection } from 'astro:content';
import type { CollectionEntry } from 'astro:content';
import { createHash } from 'node:crypto';
import { getPostSlug, isPublishedPost, type BlogPost } from './posts';

export type EnPost = CollectionEntry<'blogEn'>;

/**
 * 中文原文的指纹。只看翻译真正读到的三样东西——标题、摘要、正文——
 * 所以改栏目、改标签、改封面不会把译文判成过期，改一个字才会。
 *
 * 写作台的 server.mjs 里有一份一模一样的实现，改这里记得改那边。
 */
export function sourceFingerprint(input: { title: string; description?: string; body: string }) {
	const text = [
		input.title.trim(),
		(input.description ?? '').trim(),
		input.body.replace(/\r\n/g, '\n').trim(),
	].join('\n\u0000\n');
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

export function fingerprintOfPost(post: BlogPost) {
	return sourceFingerprint({
		title: post.data.title,
		description: post.data.description,
		body: post.body ?? '',
	});
}

export function getEnSlug(entry: EnPost) {
	return entry.id.replace(/\/index\.(md|mdx)$/i, '').replace(/\.(md|mdx)$/i, '');
}

export function getEnUrl(slug: string) {
	return `/en/blog/${slug}/`;
}

/** 译文过期 = 有 sourceHash 而且和原文对不上。没记过 hash 的当作不过期。 */
export function isStale(entry: EnPost, post: BlogPost) {
	return Boolean(entry.data.sourceHash) && entry.data.sourceHash !== fingerprintOfPost(post);
}

/**
 * 上线的英文版：自己不是草稿，而且中文原文也已经发布。
 * 中文那篇还是草稿时，英文页跟着不生成——不然会漏出没打算公开的东西。
 */
export async function getPublishedEnEntries() {
	const [entries, posts] = await Promise.all([
		getCollection('blogEn'),
		getCollection('blog', isPublishedPost),
	]);
	const bySlug = new Map(posts.map((post) => [getPostSlug(post), post]));
	return entries
		.filter((entry) => !entry.data.draft)
		.map((entry) => ({ entry, post: bySlug.get(getEnSlug(entry)) }))
		.filter((pair): pair is { entry: EnPost; post: BlogPost } => Boolean(pair.post));
}

/** slug → 英文标题，给中文列表页用。 */
export async function getEnTitleMap() {
	const pairs = await getPublishedEnEntries();
	return new Map(pairs.map(({ entry }) => [getEnSlug(entry), entry.data.title]));
}

/** 「写于 2026 年夏季」的英文说法。 */
export function getWritingSeasonEn(date: Date) {
	const month = date.getMonth() + 1;
	const season = month <= 2 || month === 12 ? 'winter' : month <= 5 ? 'spring' : month <= 8 ? 'summer' : 'autumn';
	return `${season} ${date.getFullYear()}`;
}

/**
 * 文章页自己的词。站点导航、页脚、栏目页仍然是中文——
 * 英文版翻的是「这一篇」，不是整个站。
 */
export const ARTICLE_STRINGS = {
	zh: {
		toc: '目录',
		tagsLabel: '文章标签',
		prev: '上一篇',
		next: '下一篇',
		neighborsLabel: '上一篇和下一篇',
		related: '相关文章',
		altLink: 'English',
		altHint: '这篇有英文版',
		writtenAt: (season: string, place?: string) => `写于 ${season}${place ? ` · ${place}` : ''}`,
	},
	en: {
		toc: 'Contents',
		tagsLabel: 'Tags',
		prev: 'Previous',
		next: 'Next',
		neighborsLabel: 'Previous and next post',
		related: 'Related',
		altLink: '中文',
		altHint: 'Translated from the Chinese original',
		writtenAt: (season: string, place?: string) => `Written in ${season}${place ? ` · ${place}` : ''}`,
	},
} as const;

export type ArticleLang = keyof typeof ARTICLE_STRINGS;
