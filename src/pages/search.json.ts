import { getCollection } from 'astro:content';
import { estimateReadingTime, getPostUrl, sortPosts } from '../lib/posts';

export async function GET() {
	const posts = sortPosts(await getCollection('blog', ({ data }) => !data.draft));
	return new Response(
		JSON.stringify(
			posts.map((post) => ({
				title: post.data.title,
				description: post.data.description,
				url: getPostUrl(post),
				tags: post.data.tags,
				category: post.data.category,
				publishDate: post.data.publishDate.toISOString(),
				readingTime: estimateReadingTime(post.body),
				body: post.body.slice(0, 1200),
			})),
		),
		{
			headers: {
				'content-type': 'application/json; charset=utf-8',
			},
		},
	);
}
