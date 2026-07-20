import rss from '@astrojs/rss';
import { siteConfig } from '../lib/site';
import { getPostUrl, getPublicPosts } from '../lib/posts';

export async function GET() {
	const posts = await getPublicPosts();
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
