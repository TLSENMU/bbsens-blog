import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import { siteConfig } from '../lib/site';
import { getPostUrl, sortPosts } from '../lib/posts';

export async function GET() {
	const posts = sortPosts(await getCollection('blog', ({ data }) => !data.draft));
	return rss({
		title: `${siteConfig.siteTitle}｜${siteConfig.siteSubtitle}`,
		description: siteConfig.siteDescription,
		site: siteConfig.siteUrl,
		items: posts.map((post) => ({
			title: post.data.title,
			description: post.data.description,
			pubDate: post.data.publishDate,
			link: getPostUrl(post),
		})),
	});
}
