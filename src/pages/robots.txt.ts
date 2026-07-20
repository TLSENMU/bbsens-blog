import { siteConfig } from '../lib/site';

export function GET() {
	return new Response(
		[
			'User-agent: *',
			'Allow: /',
			`Sitemap: ${new URL('/sitemap-index.xml', siteConfig.siteUrl).toString()}`,
			'',
		].join('\n'),
		{
			headers: {
				'content-type': 'text/plain; charset=utf-8',
			},
		},
	);
}
