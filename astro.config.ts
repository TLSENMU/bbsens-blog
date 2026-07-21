import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { unified } from '@astrojs/markdown-remark';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeSlug from 'rehype-slug';
import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import { siteConfig } from './src/config';

import cloudflare from '@astrojs/cloudflare';

const blogContentDir = join(process.cwd(), 'src/content/blog');

function walkMarkdownFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return walkMarkdownFiles(path);
        return /\.(md|mdx)$/i.test(entry) ? [path] : [];
    });
}

function slugFromContentPath(path: string) {
    return relative(blogContentDir, path)
        .replace(/\/index\.(md|mdx)$/i, '')
        .replace(/\.(md|mdx)$/i, '');
}

function frontmatterHasBoolean(source: string, key: string) {
    const match = source.match(/^---\s*([\s\S]*?)\s*---/);
    if (!match) return false;
    return new RegExp(`^${key}:\\s*true\\s*$`, 'm').test(match[1]);
}

const unlistedBlogUrls = new Set(
    walkMarkdownFiles(blogContentDir)
        .filter((path) => {
            const source = readFileSync(path, 'utf8');
            return frontmatterHasBoolean(source, 'unlisted') && !frontmatterHasBoolean(source, 'draft');
        })
        .map((path) => new URL(`/blog/${slugFromContentPath(path)}/`, siteConfig.siteUrl).toString()),
);

function rehypeFigureCaptions() {
    return (tree: any) => {
        function visit(node: any) {
            if (!node?.children) return;
            node.children = node.children.map((child: any) => {
                const meaningfulChildren = child.children?.filter(
                    (item: any) => item.type !== 'text' || item.value.trim() !== '',
                );
                const image = meaningfulChildren?.length === 1 && meaningfulChildren[0]?.tagName === 'img' ? meaningfulChildren[0] : undefined;
                if (child.type === 'element' && child.tagName === 'p' && image) {
                    image.properties = {
                        ...image.properties,
                        loading: image.properties?.loading ?? 'lazy',
                        decoding: image.properties?.decoding ?? 'async',
                    };
                    const alt = image.properties?.alt;
                    return {
                        type: 'element',
                        tagName: 'figure',
                        properties: { className: ['prose-figure'] },
                        children: [
                            image,
                            ...(alt ? [{
                                type: 'element',
                                tagName: 'figcaption',
                                properties: {},
                                children: [{ type: 'text', value: alt }],
                            }] : []),
                        ],
                    };
                }
                visit(child);
                return child;
            });
        }
        visit(tree);
    };
}

// https://astro.build/config
export default defineConfig({
  site: siteConfig.siteUrl,

  integrations: [
      mdx(),
      sitemap({
          filter: (page) => !unlistedBlogUrls.has(page),
      }),
	],

  markdown: {
      processor: unified({
          remarkPlugins: [remarkMath],
          rehypePlugins: [
              rehypeKatex,
              rehypeSlug,
              rehypeFigureCaptions,
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

  adapter: cloudflare()
});