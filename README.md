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

## Local Editor (推荐的写作方式)

```sh
npm run editor
```

在 `http://127.0.0.1:4380/` 打开本地写作台，或者直接双击项目根目录的 **写作台.command**（不用先开终端）。

- 按 `N` 速记一条随笔：一个屏幕写完，slug 按日期自动生成（`/blog/2026-09-18-late-night/`），⌘↩ 发布、⌘S 存草稿。
- 「追加到…」把一段新内容接到已有文章末尾，加一个 `## 9 月 18 日` 小标题，并把 `updatedDate` 改成今天。
- `⌘E` 切到分屏，左写右看，滚动按段落对齐。
- 菜谱小卡走表单，把光标放在已有的卡里能读回来改。
- 图片拖进正文即上传到 `public/assets/posts/<slug>/`，上传前在浏览器里按最长边压好（jpg→jpg，png→webp）。
- 季笺（`src/content/seasons/`）也能在里面改，左栏筛选条最后一个就是。
- `⌘K` 跳到任意一篇文章或季笺；停下打字约 1 秒自动保存；文件被 Obsidian 或 git 改过时会拦下保存并让你选择。

- 左栏最下面是同步栏：分支、待拉取 / 待推送 / 未提交改动，以及「拉取」和「提交并推送…」两个**手动**按钮（服务自己不会 commit，更不会 push）。

只在本机运行，不会被部署。**另一台电脑**上 `git clone` 这个仓库、`npm install`、`npm run editor` 就是同一套东西（需要 Node ≥ 22.12）；内容靠 git 同步，开写前先拉取，写完提交并推送。详见 `tools/blog-editor/README.md`。

## Create a New Post

Add a Markdown or MDX file in `src/content/blog/`.

Minimum frontmatter (随笔一类的短文只要这些就够了)：

```md
---
title: "文章标题"
publishDate: 2026-07-20
tags: ["思绪"]
category: "thoughts"
draft: false
unlisted: false
---
```

Optional fields:

- `description` — 摘要。留空就不写这一行：列表页只显示标题，RSS 的 description 退回标题，搜索仍然搜正文。
- `cover` / `coverAlt` / `coverLayout` / `coverPosition` — 封面。没有 `cover` 时后三个都不必写。
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
- Homepage structure: hero, three section entrances, seasonal letter (its three notes are pulled from the latest `src/content/seasons/*.md` `##` sections), seasonal picks, recent updates with small cover thumbnails, and a quiet selected-images strip built from real post covers.
- Recipe cards (`.recipe-card`): the dish name (first `dd` in `.recipe-card__meta`) is the visual title; `菜谱小卡` renders as a small label; `.recipe-card__annotation` sits as a note in the top-right corner and never overlaps the meta.
- Dark mode uses a warm charcoal palette (`#1e1c19`) rather than blue-gray, with slightly dimmed images and a dual Shiki theme for code.

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
