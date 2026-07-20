# Personal Blog

Astro + TypeScript personal blog for travel notes, daily essays, study notes, photography, and an About page.

The selected visual direction is **B: Modern Editorial** with a unified warm paper background and quiet section accents.

## Local Development

```sh
npm install
npm run dev
```

Open the local URL shown by Astro, usually `http://localhost:4321/`.

Useful pages:

- `/` homepage
- `/journey/` travel notes
- `/food/` food notes
- `/people/` things, writers, design, and friends
- `/thoughts/` loose thoughts and reflections
- `/seasons/` seasonal letters
- `/design-preview/` three design candidates
- `/palette-preview/` color candidates and section-accent system
- `/blog/` all posts
- `/tags/` tags
- `/archive/` archive
- `/about/` about
- `/search/` static client-side search
- `/rss.xml` RSS feed
- `/sitemap-index.xml` sitemap
- `/robots.txt` robots file

## Build

```sh
npm run build
```

The static output is generated in `dist/`.

## Create a New Post

Add a Markdown or MDX file in `src/content/blog/`.

Minimum frontmatter:

```md
---
title: "文章标题"
description: "文章摘要"
publishDate: 2026-07-20
tags: ["travel", "daily"]
cover: "/assets/covers/example.jpg"
coverAlt: "图片说明"
coverLayout: "standard"
coverPosition: "50% 50%"
draft: false
unlisted: false
---
```

Optional fields:

- `updatedDate`
- `featured`
- `location`
- `language`
- `coverLayout`: `landscape`, `standard`, `portrait`, or `wide`
- `coverPosition`: CSS `object-position`, for example `50% 42%`
- `unlisted`: hide from public lists while still building the post URL

Set `draft: true` to keep a post out of production pages.

Set `unlisted: true` when a post should still build and remain accessible by full URL, but should not appear on the homepage, category pages, archive, tags, search, RSS, sitemap, related posts, previous/next navigation, or public article counts.

`unlisted` is not security or password protection. Anyone with the URL can still read the page, so sensitive content should not be deployed.

## Site URL

Update the canonical site URL in `src/config.ts`:

```ts
siteUrl: 'https://frombbs.com'
```

This value is used by Astro config, canonical URLs, Open Graph images, RSS, robots.txt, and sitemap. Do not set it to a temporary `pages.dev` URL unless that is intentionally your public site.

## Design Notes

- Visual direction: modern editorial, with serif-led titles, clear grid alignment, and restrained metadata.
- Background: unified morning paper white, with each content section carrying a quiet accent color.
- Section accents: mist blue for `在路上`, soft clay apricot for `食`, muted olive for `物与人`.
- Typography: Chinese serif stack for titles/body, English serif stack for English headings, sans-serif for navigation, tags, dates, and controls.
- Layout: homepage remains an article list, not a masonry card grid.
- JavaScript: limited to theme switching, static search, article reading progress, and article image lightbox.
- Homepage structure: hero, seasonal letter, seasonal picks, recent updates, and a quiet selected-images strip.

## Push to GitHub

```sh
git add .
git commit -m "Create Astro personal blog"
git branch -M main
git remote add origin git@github.com:YOUR_USER/YOUR_REPO.git
git push -u origin main
```

If the remote already exists, skip `git remote add origin`.

## Cloudflare Pages

Create a Cloudflare Pages project connected to the GitHub repository.

Recommended settings:

- Framework preset: Astro
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: leave empty unless the project is inside a subfolder
- Node.js version: `22.12.0` or newer
- Production site URL: configured in `src/config.ts` as `https://frombbs.com`

After every domain change, update `src/config.ts` and run `npm run build` locally before pushing.

## Custom Domain

In Cloudflare Pages:

1. Open the Pages project.
2. Go to Custom domains.
3. Add your domain, for example `frombbs.com` or `www.frombbs.com`.
4. Follow the DNS instructions Cloudflare shows.
5. Update `src/config.ts` so `siteUrl` matches the final production domain.

Then run:

```sh
npm run build
```

Confirm RSS, sitemap, canonical URLs, and Open Graph metadata use the custom domain.
