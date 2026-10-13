#!/usr/bin/env node
/**
 * From BBS · 本地写作台
 *
 * 一个只在本机运行的小型 HTTP 服务：
 *   - 读取 / 新建 / 保存 src/content/blog/*.md
 *   - 速记：一个屏幕写完一条随笔，slug 按日期自动生成
 *   - 追加：把一条新条目接到已有文章末尾，并自动更新 updatedDate
 *   - 把图片放进 public/assets/posts/[slug]/
 *   - 用项目自己的 Markdown 管线渲染预览
 *
 * 没有数据库、没有登录、不会 push、不会碰 Cloudflare 配置。
 * 只监听 127.0.0.1。
 *
 * 用法：npm run editor   （或 node tools/blog-editor/server.mjs --port 4380 --no-open）
 */

import http from 'node:http';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import os from 'node:os';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const CONTENT_DIR = path.join(ROOT, 'src', 'content', 'blog');
const SEASONS_DIR = path.join(ROOT, 'src', 'content', 'seasons');
const ASSETS_DIR = path.join(ROOT, 'public', 'assets', 'posts');
const PUBLIC_DIR = path.join(ROOT, 'public');
const EN_DIR = path.join(ROOT, 'src', 'content', 'blog-en');
const ABOUT_FILE = path.join(ROOT, 'src', 'content', 'about', 'about.md');
const TRASH_DIR = path.join(here, '.trash');
const UI_FILE = path.join(here, 'index.html');

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const PORT = Number(process.env.EDITOR_PORT || (portArg >= 0 ? args[portArg + 1] : 4380));
const SHOULD_OPEN = !args.includes('--no-open');
const ASTRO_DEV_URL = process.env.ASTRO_DEV_URL || 'http://localhost:4321';

// ---------------------------------------------------------------------------
// YAML：优先用 astro 已经带进来的 js-yaml；拿不到就退回一个极简实现
// ---------------------------------------------------------------------------

let yaml;
try {
	yaml = await import('js-yaml');
} catch {
	yaml = null;
	console.warn('[editor] 未找到 js-yaml，使用内置的极简 YAML 解析器。');
}

function parseYaml(text) {
	if (yaml) return yaml.load(text, { schema: yaml.CORE_SCHEMA }) ?? {};
	return miniParseYaml(text);
}

function dumpYaml(obj) {
	if (yaml) {
		return yaml.dump(obj, {
			schema: yaml.CORE_SCHEMA,
			lineWidth: -1,
			noRefs: true,
			quotingType: '"',
			forceQuotes: false,
		});
	}
	return miniDumpYaml(obj);
}

function miniParseYaml(text) {
	const out = {};
	let currentKey = null;
	for (const raw of text.split(/\r?\n/)) {
		if (!raw.trim() || raw.trim().startsWith('#')) continue;
		const listItem = raw.match(/^\s+-\s*(.*)$/);
		if (listItem && currentKey) {
			if (!Array.isArray(out[currentKey])) out[currentKey] = [];
			out[currentKey].push(miniScalar(listItem[1]));
			continue;
		}
		const kv = raw.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (!kv) continue;
		currentKey = kv[1];
		const value = kv[2].trim();
		if (value === '') out[currentKey] = [];
		else if (value.startsWith('[') && value.endsWith(']')) {
			out[currentKey] = value
				.slice(1, -1)
				.split(',')
				.map((item) => item.trim())
				.filter(Boolean)
				.map(miniScalar);
		} else out[currentKey] = miniScalar(value);
	}
	return out;
}

function miniScalar(value) {
	const trimmed = value.trim();
	if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return trimmed.slice(1, -1);
	if (trimmed === 'true') return true;
	if (trimmed === 'false') return false;
	if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
	return trimmed;
}

function miniDumpYaml(obj) {
	const lines = [];
	for (const [key, value] of Object.entries(obj)) {
		if (Array.isArray(value)) {
			lines.push(`${key}:`);
			for (const item of value) lines.push(`  - ${miniQuote(item)}`);
		} else {
			lines.push(`${key}: ${miniQuote(value)}`);
		}
	}
	return lines.join('\n') + '\n';
}

function miniQuote(value) {
	if (typeof value === 'boolean' || typeof value === 'number') return String(value);
	const s = String(value);
	if (s === '' || /[:#\[\]{}&*!|>'"%@`,]|^\s|\s$|^(true|false|null|~)$|^-?\d/.test(s)) {
		return JSON.stringify(s);
	}
	return s;
}

// ---------------------------------------------------------------------------
// Frontmatter 读写
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitFrontmatter(source) {
	const match = source.match(FRONTMATTER_RE);
	if (!match) return { data: {}, body: source, raw: '' };
	let data = {};
	try {
		data = parseYaml(match[1]) ?? {};
	} catch (error) {
		data = { __yamlError: String(error.message || error) };
	}
	return { data, body: source.slice(match[0].length), raw: match[1] };
}

/** 字段顺序：和 README / 现有文章保持一致，读起来舒服。 */
const FIELD_ORDER = [
	'title',
	'description',
	'publishDate',
	'updatedDate',
	'tags',
	'cover',
	'coverAlt',
	'coverLayout',
	'coverPosition',
	'category',
	'draft',
	'unlisted',
	'featured',
	'location',
	'language',
];

/** 季笺（src/content/seasons）用另一套字段。 */
const SEASON_FIELD_ORDER = ['title', 'season', 'year', 'description', 'cover', 'coverAlt', 'draft', 'publishDate'];
const SEASON_NAMES = ['春', '夏', '秋', '冬'];

/** 关于页（src/content/about/about.md）。就这一篇，没有列表也没有 slug。 */
const ABOUT_FIELD_ORDER = ['title', 'kicker', 'description', 'updatedDate'];

const CATEGORIES = ['journey', 'food', 'people', 'thoughts'];
const CATEGORY_LABELS = { journey: '在路上', food: '食', people: '物与人', thoughts: '思绪' };
const COVER_LAYOUTS = ['landscape', 'standard', 'portrait', 'wide'];
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayString() {
	const now = new Date();
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function toDateString(value) {
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	if (typeof value === 'string') return value.trim();
	return value == null ? '' : String(value);
}

/** 只留 ASCII 的 slug 片段；中文字符会被丢掉（没有拼音库，也不装）。 */
function slugifyAscii(text) {
	return String(text ?? '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48);
}

/**
 * 把编辑器发来的表单数据整理成干净的 frontmatter 对象：
 * 去掉空字段，按固定顺序排列，布尔值只在有意义时写入。
 */
function normalizeFrontmatter(input) {
	const fm = {};
	const str = (key) => (typeof input[key] === 'string' ? input[key].trim() : '');

	fm.title = str('title');
	// description 是可选的：随笔一类的短文不写摘要，就不要这一行。
	if (str('description')) fm.description = str('description');
	fm.publishDate = toDateString(input.publishDate);
	const updated = toDateString(input.updatedDate);
	if (updated) fm.updatedDate = updated;

	const tags = Array.isArray(input.tags)
		? input.tags
		: String(input.tags ?? '')
				.split(/[,，\n]/)
				.map((tag) => tag.trim());
	fm.tags = [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))];

	if (str('cover')) {
		fm.cover = str('cover');
		if (str('coverAlt')) fm.coverAlt = str('coverAlt');
		fm.coverLayout = str('coverLayout') || 'standard';
		fm.coverPosition = str('coverPosition') || '50% 50%';
	}
	fm.category = str('category');
	fm.draft = Boolean(input.draft);
	fm.unlisted = Boolean(input.unlisted);
	if (input.featured === true) fm.featured = true;
	if (str('location')) fm.location = str('location');
	if (str('language')) fm.language = str('language');

	// 保留 schema 之外、但原文件里已有的字段，放在末尾。
	if (input.__extra && typeof input.__extra === 'object') {
		for (const [key, value] of Object.entries(input.__extra)) {
			if (!(key in fm) && !FIELD_ORDER.includes(key) && !key.startsWith('__')) fm[key] = value;
		}
	}

	const ordered = {};
	for (const key of FIELD_ORDER) if (key in fm) ordered[key] = fm[key];
	for (const key of Object.keys(fm)) if (!(key in ordered)) ordered[key] = fm[key];
	return ordered;
}

/**
 * 对照 src/content.config.ts 里的 zod schema 做校验。
 * 这里是手写的镜像；如果 schema 改了，记得同步。
 */
function validateFrontmatter(fm, { slug, checkFiles = true } = {}) {
	const errors = [];
	const warnings = [];

	if (!fm.title) errors.push({ field: 'title', message: '标题不能为空。' });
	if (!fm.publishDate) errors.push({ field: 'publishDate', message: '发布日期不能为空。' });
	else if (!DATE_RE.test(fm.publishDate) || Number.isNaN(Date.parse(fm.publishDate))) {
		errors.push({ field: 'publishDate', message: `发布日期格式应为 YYYY-MM-DD，现在是 "${fm.publishDate}"。` });
	}
	if (fm.updatedDate) {
		if (!DATE_RE.test(fm.updatedDate) || Number.isNaN(Date.parse(fm.updatedDate))) {
			errors.push({ field: 'updatedDate', message: '更新日期格式应为 YYYY-MM-DD。' });
		} else if (fm.publishDate && Date.parse(fm.updatedDate) < Date.parse(fm.publishDate)) {
			warnings.push({ field: 'updatedDate', message: '更新日期早于发布日期，确认一下？' });
		}
	}
	if (!CATEGORIES.includes(fm.category)) {
		errors.push({ field: 'category', message: `栏目必须是 ${CATEGORIES.join(' / ')} 之一。` });
	}
	if (!Array.isArray(fm.tags) || fm.tags.some((tag) => typeof tag !== 'string')) {
		errors.push({ field: 'tags', message: 'tags 必须是字符串数组。' });
	}
	if (fm.cover) {
		if (!COVER_LAYOUTS.includes(fm.coverLayout)) {
			errors.push({ field: 'coverLayout', message: `封面版式必须是 ${COVER_LAYOUTS.join(' / ')} 之一。` });
		}
		if (!fm.cover.startsWith('/')) warnings.push({ field: 'cover', message: '封面路径建议以 / 开头（例如 /assets/posts/slug/cover.jpg）。' });
		if (checkFiles && fm.cover.startsWith('/') && !existsSync(path.join(PUBLIC_DIR, fm.cover))) {
			errors.push({ field: 'cover', message: `public${fm.cover} 不存在。` });
		}
		if (!fm.coverAlt) warnings.push({ field: 'coverAlt', message: '有封面但没有 coverAlt，图注和无障碍文字会是空的。' });
		if (fm.coverPosition && !/^-?\d+(\.\d+)?%?\s+-?\d+(\.\d+)?%?$|^(left|center|right|top|bottom)(\s+(left|center|right|top|bottom))?$/.test(fm.coverPosition)) {
			warnings.push({ field: 'coverPosition', message: 'coverPosition 看起来不是常见的 object-position 写法（例如 50% 42%）。' });
		}
	}
	if (slug !== undefined && !SLUG_RE.test(slug)) {
		errors.push({ field: 'slug', message: 'slug 只能用小写字母、数字和连字符，例如 2026-09-18-late-night。' });
	}
	if (fm.draft && fm.unlisted) warnings.push({ field: 'unlisted', message: 'draft 为 true 时文章根本不会构建，unlisted 没有意义。' });
	if (fm.featured && (fm.draft || fm.unlisted)) warnings.push({ field: 'featured', message: '草稿或 unlisted 的文章即使 featured 也不会出现在首页精选。' });
	if (fm.description && fm.description.length > 120) warnings.push({ field: 'description', message: '摘要超过 120 字，列表页可能显得拥挤。' });

	return { ok: errors.length === 0, errors, warnings };
}

function normalizeSeason(input) {
	const fm = {};
	const str = (key) => (typeof input[key] === 'string' ? input[key].trim() : '');
	fm.title = str('title');
	fm.season = str('season');
	fm.year = Number(input.year) || new Date().getFullYear();
	fm.description = str('description');
	if (str('cover')) {
		fm.cover = str('cover');
		if (str('coverAlt')) fm.coverAlt = str('coverAlt');
	}
	fm.draft = Boolean(input.draft);
	fm.publishDate = toDateString(input.publishDate);
	if (input.__extra && typeof input.__extra === 'object') {
		for (const [key, value] of Object.entries(input.__extra)) {
			if (!(key in fm) && !SEASON_FIELD_ORDER.includes(key) && !key.startsWith('__')) fm[key] = value;
		}
	}
	const ordered = {};
	for (const key of SEASON_FIELD_ORDER) if (key in fm) ordered[key] = fm[key];
	for (const key of Object.keys(fm)) if (!(key in ordered)) ordered[key] = fm[key];
	return ordered;
}

function validateSeason(fm, { slug } = {}) {
	const errors = [];
	const warnings = [];
	if (!fm.title) errors.push({ field: 'title', message: '标题不能为空。' });
	if (!fm.season) errors.push({ field: 'season', message: '季节不能为空（春 / 夏 / 秋 / 冬）。' });
	if (!Number.isFinite(fm.year)) errors.push({ field: 'year', message: '年份必须是数字。' });
	if (!fm.description) errors.push({ field: 'description', message: '季笺的摘要是必填的（schema 里没设 optional）。' });
	if (!fm.publishDate) errors.push({ field: 'publishDate', message: '发布日期不能为空。' });
	else if (!DATE_RE.test(fm.publishDate) || Number.isNaN(Date.parse(fm.publishDate))) {
		errors.push({ field: 'publishDate', message: '发布日期格式应为 YYYY-MM-DD。' });
	}
	if (fm.cover) {
		if (fm.cover.startsWith('/') && !existsSync(path.join(PUBLIC_DIR, fm.cover))) {
			errors.push({ field: 'cover', message: `public${fm.cover} 不存在。` });
		}
		if (!fm.coverAlt) warnings.push({ field: 'coverAlt', message: '有封面但没有 coverAlt。' });
	}
	if (slug !== undefined && !SLUG_RE.test(slug)) {
		errors.push({ field: 'slug', message: 'slug 只能用小写字母、数字和连字符，例如 2026-autumn。' });
	}
	return { ok: errors.length === 0, errors, warnings };
}

function buildMarkdown(fm, body) {
	const trimmedBody = body.replace(/^\s*\n/, '').replace(/\s+$/, '');
	return `---\n${dumpYaml(fm)}---\n\n${trimmedBody}\n`;
}

// ---------------------------------------------------------------------------
// 文章列表
// ---------------------------------------------------------------------------

async function walk(dir) {
	if (!existsSync(dir)) return [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...(await walk(full)));
		else if (/\.(md|mdx)$/i.test(entry.name)) files.push(full);
	}
	return files;
}

function slugFromFile(file) {
	return path
		.relative(CONTENT_DIR, file)
		.split(path.sep)
		.join('/')
		.replace(/\/index\.(md|mdx)$/i, '')
		.replace(/\.(md|mdx)$/i, '');
}

async function findPostFile(slug) {
	const candidates = [
		path.join(CONTENT_DIR, `${slug}.md`),
		path.join(CONTENT_DIR, `${slug}.mdx`),
		path.join(CONTENT_DIR, slug, 'index.md'),
		path.join(CONTENT_DIR, slug, 'index.mdx'),
	];
	for (const file of candidates) if (existsSync(file)) return file;
	return null;
}

function countWords(body = '') {
	return (body.match(/[一-鿿]/g) ?? []).length + (body.match(/[A-Za-z0-9]+/g) ?? []).length;
}

async function listPosts() {
	const files = await walk(CONTENT_DIR);
	const posts = [];
	for (const file of files) {
		const source = await fs.readFile(file, 'utf8');
		const { data, body } = splitFrontmatter(source);
		const stat = await fs.stat(file);
		const slug = slugFromFile(file);
		const en = await readEn(slug);
		posts.push({
			slug,
			// 左栏那个 EN 角标：none / draft / published / stale
			en: !en
				? 'none'
				: en.frontmatter.sourceHash &&
					  en.frontmatter.sourceHash !==
							sourceFingerprint({ title: data.title, description: data.description, body })
					? 'stale'
					: en.frontmatter.draft
						? 'draft'
						: 'published',
			file: path.relative(ROOT, file),
			title: data.title ?? '(无标题)',
			description: data.description ?? '',
			publishDate: toDateString(data.publishDate),
			updatedDate: toDateString(data.updatedDate),
			category: data.category ?? '',
			tags: Array.isArray(data.tags) ? data.tags : [],
			cover: data.cover ?? '',
			draft: Boolean(data.draft),
			unlisted: Boolean(data.unlisted),
			featured: Boolean(data.featured),
			words: countWords(body),
			modifiedAt: stat.mtime.toISOString(),
			mtimeMs: stat.mtimeMs,
			yamlError: data.__yamlError ?? null,
		});
	}
	posts.sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || '') || b.modifiedAt.localeCompare(a.modifiedAt));
	return posts;
}

async function readPost(slug) {
	const file = await findPostFile(slug);
	if (!file) return null;
	const source = await fs.readFile(file, 'utf8');
	const stat = await fs.stat(file);
	const { data, body } = splitFrontmatter(source);
	const known = {};
	const extra = {};
	for (const [key, value] of Object.entries(data)) {
		if (FIELD_ORDER.includes(key)) known[key] = value;
		else if (!key.startsWith('__')) extra[key] = value;
	}
	known.publishDate = toDateString(known.publishDate);
	known.updatedDate = toDateString(known.updatedDate);
	const assets = await listAssets(slug);
	return {
		kind: 'post',
		slug,
		file: path.relative(ROOT, file),
		frontmatter: known,
		extra,
		body,
		assets,
		mtimeMs: stat.mtimeMs,
		yamlError: data.__yamlError ?? null,
		validation: validateFrontmatter(normalizeFrontmatter({ ...known, __extra: extra }), { slug }),
	};
}

async function findSeasonFile(slug) {
	for (const file of [path.join(SEASONS_DIR, `${slug}.md`), path.join(SEASONS_DIR, `${slug}.mdx`)]) {
		if (existsSync(file)) return file;
	}
	return null;
}

async function listSeasons() {
	const files = await walk(SEASONS_DIR);
	const items = [];
	for (const file of files) {
		const source = await fs.readFile(file, 'utf8');
		const { data, body } = splitFrontmatter(source);
		const stat = await fs.stat(file);
		items.push({
			slug: path.basename(file).replace(/\.(md|mdx)$/i, ''),
			file: path.relative(ROOT, file),
			title: data.title ?? '(无标题)',
			season: data.season ?? '',
			year: data.year ?? '',
			description: data.description ?? '',
			publishDate: toDateString(data.publishDate),
			draft: Boolean(data.draft),
			words: countWords(body),
			mtimeMs: stat.mtimeMs,
			yamlError: data.__yamlError ?? null,
		});
	}
	items.sort((a, b) => (b.publishDate || '').localeCompare(a.publishDate || ''));
	return items;
}

async function readSeason(slug) {
	const file = await findSeasonFile(slug);
	if (!file) return null;
	const source = await fs.readFile(file, 'utf8');
	const stat = await fs.stat(file);
	const { data, body } = splitFrontmatter(source);
	const known = {};
	const extra = {};
	for (const [key, value] of Object.entries(data)) {
		if (SEASON_FIELD_ORDER.includes(key)) known[key] = value;
		else if (!key.startsWith('__')) extra[key] = value;
	}
	known.publishDate = toDateString(known.publishDate);
	return {
		kind: 'season',
		slug,
		file: path.relative(ROOT, file),
		frontmatter: known,
		extra,
		body,
		assets: [],
		mtimeMs: stat.mtimeMs,
		yamlError: data.__yamlError ?? null,
		validation: validateSeason(normalizeSeason({ ...known, __extra: extra }), { slug }),
	};
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg']);

async function listAssets(slug) {
	const dir = path.join(ASSETS_DIR, slug);
	if (!existsSync(dir)) return [];
	const entries = await fs.readdir(dir, { withFileTypes: true });
	const items = [];
	for (const entry of entries) {
		if (!entry.isFile() || entry.name.startsWith('.')) continue;
		if (!IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) continue;
		const stat = await fs.stat(path.join(dir, entry.name));
		items.push({
			name: entry.name,
			url: `/assets/posts/${slug}/${entry.name}`,
			size: stat.size,
			modifiedAt: stat.mtime.toISOString(),
		});
	}
	items.sort((a, b) => a.name.localeCompare(b.name));
	return items;
}

function safeFileName(name) {
	const ext = path.extname(name).toLowerCase();
	const base = path
		.basename(name, path.extname(name))
		.normalize('NFKD')
		.replace(/[^\w一-鿿-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '')
		.toLowerCase();
	return `${base || 'image'}${ext}`;
}

async function uniquePath(dir, name) {
	let candidate = path.join(dir, name);
	const ext = path.extname(name);
	const base = path.basename(name, ext);
	let n = 2;
	while (existsSync(candidate)) {
		candidate = path.join(dir, `${base}-${n}${ext}`);
		n += 1;
	}
	return candidate;
}

// ---------------------------------------------------------------------------
// Markdown 预览：用项目自己的管线（remark-math + katex + figure 处理）
// ---------------------------------------------------------------------------

let processorPromise = null;

function getProcessor() {
	if (processorPromise) return processorPromise;
	processorPromise = (async () => {
		try {
			const [{ createMarkdownProcessor }, remarkMath, rehypeKatex, rehypeSlug] = await Promise.all([
				import('@astrojs/markdown-remark'),
				import('remark-math').then((m) => m.default),
				import('rehype-katex').then((m) => m.default),
				import('rehype-slug').then((m) => m.default),
			]);
			return createMarkdownProcessor({
				remarkPlugins: [remarkMath],
				rehypePlugins: [rehypeKatex, rehypeSlug, rehypeFigureCaptions],
				shikiConfig: { theme: 'github-light' },
			});
		} catch (error) {
			console.warn('[editor] 无法加载 Markdown 管线，预览将退化为纯文本。', error.message);
			return null;
		}
	})();
	return processorPromise;
}

/** 与 astro.config.ts 中的实现保持一致：单独成段的图片包成 figure。 */
function rehypeFigureCaptions() {
	return (tree) => {
		function visit(node) {
			if (!node?.children) return;
			node.children = node.children.map((child) => {
				const meaningful = child.children?.filter((item) => item.type !== 'text' || item.value.trim() !== '');
				const image = meaningful?.length === 1 && meaningful[0]?.tagName === 'img' ? meaningful[0] : undefined;
				if (child.type === 'element' && child.tagName === 'p' && image) {
					const alt = image.properties?.alt;
					return {
						type: 'element',
						tagName: 'figure',
						properties: { className: ['prose-figure'] },
						children: [
							image,
							...(alt ? [{ type: 'element', tagName: 'figcaption', properties: {}, children: [{ type: 'text', value: alt }] }] : []),
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

async function renderPreview(markdown) {
	const processor = await getProcessor();
	if (!processor) {
		return `<pre style="white-space:pre-wrap">${escapeHtml(markdown)}</pre>`;
	}
	const result = await processor.render(markdown);
	return result.code;
}

function escapeHtml(text) {
	return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------------------------------------------------------------------------
// 导出长图：拼一页专门排版的 HTML，再用系统里已经装着的浏览器截一张图
// ---------------------------------------------------------------------------

/** 常见的 Chrome / Edge / Brave / Chromium 位置，找到哪个用哪个。不装任何新依赖。 */
const BROWSER_CANDIDATES = [
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
	'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
	'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	process.env.CHROME_PATH,
	// Windows：Edge 是系统自带的，所以这台机器上几乎总能出图。
	...(process.platform === 'win32'
		? [
				process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
				process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
				process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
				process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
				process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
				process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
			]
		: []),
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/snap/bin/chromium',
].filter(Boolean);

/** Playwright 装的 chromium 版本号会变，扫一下目录。 */
function findBundledChromium() {
	const base = '/opt/pw-browsers';
	if (!existsSync(base)) return null;
	try {
		for (const entry of readdirSyncSafe(base)) {
			for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
				const candidate = path.join(base, entry, rel);
				if (existsSync(candidate)) return candidate;
			}
		}
	} catch {}
	return null;
}

function readdirSyncSafe(dir) {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function findBrowser() {
	for (const candidate of BROWSER_CANDIDATES) if (existsSync(candidate)) return candidate;
	return findBundledChromium();
}

function escapeAttr(text) {
	return escapeHtml(String(text ?? ''));
}

/** 按空行把正文切块，用来做「只要开头」。 */
function firstBlocks(body, count) {
	if (!count) return body;
	const blocks = body.split(/\n[ \t]*\n/).filter((b) => b.trim());
	// count 数的是「正文段落」。标题、引用、图片、分隔线照样跟着走，但不占名额：
	// 否则文章开头一个 ## 小标题就吃掉四分之一的篇幅，卡片上只剩一句话。
	const isProse = (b) => !/^(#{1,6}\s|>|!\[|<|-{3,}\s*$|\*{3,}\s*$)/.test(b.trim());
	const out = [];
	let taken = 0;
	for (const b of blocks) {
		if (taken >= count) break;
		if (isProse(b)) taken += 1;
		out.push(b);
	}
	// 别让卡片以一个孤零零的小标题或一张图收尾。
	while (out.length && !isProse(out[out.length - 1])) out.pop();
	return out.join('\n\n');
}

/**
 * 长图的一页 HTML。宽度是写死的像素，所有尺寸按宽度比例换算，
 * 这样 750 / 1080 / 1242 出来的观感一致。
 */
async function buildExportPage({ post, width, theme, footer, limit }) {
	const fm = post.frontmatter;
	const body = firstBlocks(post.body, limit);
	// 懒加载会让「视口越高、加载的图越多、页面越长」，量出来的高度和截图时对不上。
	// 长图要的是一次性全部渲染，所以这里强制 eager。
	const html = (await renderPreview(body)).replace(/\sloading=["']lazy["']/g, ' loading="eager"');
	const truncated = limit && body.length < post.body.length;
	const k = width / 1080; // 以 1080 为基准缩放
	const px = (n) => `${Math.round(n * k)}px`;
	const dark = theme === 'dark';
	const date = fm.publishDate
		? (() => { const [y, m, d] = fm.publishDate.split('-'); return `${y} 年 ${Number(m)} 月 ${Number(d)} 日`; })()
		: '';
	const label = CATEGORY_LABELS[fm.category] ?? '';
	const site = siteConfigCache();

	return `<!doctype html>
<html lang="zh-CN" data-theme="${dark ? 'dark' : 'light'}">
<head>
<meta charset="utf-8">
<title>${escapeAttr(fm.title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;600;700&family=Noto+Sans+SC:wght@400;500&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap">
<link rel="stylesheet" href="/site.css">
<link rel="stylesheet" href="/katex.css">
<style>
	html, body { margin: 0; padding: 0; background: var(--color-bg); }
	body { width: ${width}px; }
	.sheet {
		width: ${width}px;
		padding: ${px(96)} ${px(80)} ${px(72)};
		background: var(--color-bg);
		color: var(--color-text);
		font-family: var(--font-serif-cn);
		box-sizing: border-box;
	}
	.sheet__kicker {
		display: flex; align-items: center; gap: ${px(20)};
		color: var(--color-muted);
		font-family: var(--font-sans);
		font-size: ${px(26)};
		letter-spacing: 0.1em;
	}
	.sheet__kicker::before {
		content: ""; width: ${px(54)}; height: ${px(4)}; border-radius: 999px;
		background: var(--category-color, var(--color-accent));
	}
	.sheet h1 {
		margin: ${px(34)} 0 ${px(26)};
		font-size: ${px(74)};
		font-weight: 600;
		line-height: 1.28;
		letter-spacing: 0.01em;
	}
	.sheet__meta { color: var(--color-faint); font-family: var(--font-sans); font-size: ${px(26)}; }
	.sheet__rule { height: 1px; margin: ${px(46)} 0 ${px(52)}; background: var(--color-line); }
	.sheet .prose {
		max-width: none;
		font-size: ${px(36)};
		line-height: 2.05;
	}
	.sheet .prose p { margin: ${px(38)} 0; }
	.sheet .prose h2 { font-size: ${px(50)}; margin: ${px(70)} 0 ${px(30)}; }
	.sheet .prose h3 { font-size: ${px(42)}; margin: ${px(56)} 0 ${px(26)}; }
	.sheet .prose img { border-radius: ${px(10)}; }
	.sheet .prose figure { margin: ${px(52)} 0; }
	.sheet .prose figcaption { font-size: ${px(24)}; margin-top: ${px(18)}; }
	.sheet .prose blockquote { padding-left: ${px(30)}; border-left-width: ${px(5)}; }
	.sheet .prose :where(h2, h3) .heading-anchor { display: none; }

	/* 站点上那些「出血」元素靠 margin-left:50% + transform 撑出正文宽度，
	   放进固定宽度的长图里会溢出被裁掉。这里一律收回内容宽度。 */
	.sheet .prose figure.image-wide,
	.sheet .prose figure.image-full,
	.sheet .prose figure.image-pair,
	.sheet .prose .recipe-card,
	.sheet .prose .recipe-card-grid,
	.sheet .prose .pepper-table-card {
		width: 100%;
		margin-left: 0;
		transform: none;
	}
	.sheet .prose figure.image-pair { gap: ${px(20)}; }
	.sheet .prose figure.image-pair img { max-height: ${px(760)}; }

	/* 站点用 vh 限制图片高度，但长图的「视口」就是整张图的高度，
	   量出来的高度和截图时的高度会对不上，底部就被切掉。全部换成按宽度换算的定值。 */
	.sheet .prose img { max-height: ${px(1500)}; }
	.sheet .prose figure.image-portrait { width: 68%; }
	.sheet .prose .recipe-card-grid { grid-template-columns: minmax(0, 1fr); gap: ${px(28)}; }

	/* 菜谱小卡：把里面按 rem 定的字号按长图比例放大 */
	.sheet .prose .recipe-card { padding: ${px(44)}; border-radius: ${px(12)}; }
	.sheet .prose .recipe-card__header h3 { font-size: ${px(22)}; }
	.sheet .prose .recipe-card__meta { font-size: ${px(26)}; }
	.sheet .prose .recipe-card__meta div:first-child dd { font-size: ${px(52)}; }
	.sheet .prose .recipe-card__annotation { font-size: ${px(28)}; max-width: ${px(300)}; padding: ${px(14)} ${px(22)}; }
	.sheet .prose .recipe-card h4 { font-size: ${px(34)}; margin-bottom: ${px(20)}; }
	.sheet .prose .recipe-ingredients { font-size: ${px(28)}; gap: ${px(14)}; }
	.sheet .prose .recipe-ingredients li { padding-bottom: ${px(12)}; grid-template-columns: minmax(${px(190)}, 0.5fr) minmax(0, 1fr); gap: ${px(16)}; }
	.sheet .prose .recipe-steps { font-size: ${px(30)}; gap: ${px(20)}; }
	.sheet .prose .recipe-steps li { padding-left: ${px(62)}; line-height: 1.9; }
	.sheet .prose .recipe-steps li::before { width: ${px(42)}; height: ${px(42)}; font-size: ${px(22)}; top: ${px(8)}; }
	.sheet .prose .pepper-table-card { padding: ${px(30)}; }
	.sheet .prose .pepper-table-card table { min-width: 0; font-size: ${px(24)}; }
	.sheet .prose .pepper-table-card h3 { font-size: ${px(40)}; }
	.sheet__more {
		margin: ${px(46)} 0 0;
		color: var(--color-muted);
		font-family: var(--font-sans);
		font-size: ${px(28)};
		text-align: center;
	}
	.sheet__foot {
		display: flex; align-items: baseline; justify-content: space-between; gap: ${px(24)};
		margin-top: ${px(76)};
		padding-top: ${px(34)};
		border-top: 1px solid var(--color-line);
		color: var(--color-muted);
		font-family: var(--font-sans);
		font-size: ${px(26)};
	}
	.sheet__foot b {
		font-family: var(--font-serif-en);
		font-size: ${px(34)};
		font-weight: 600;
		color: var(--color-text);
	}
	.sheet__foot span { color: var(--color-faint); }
</style>
</head>
<body>
<article class="sheet" data-category="${escapeAttr(fm.category ?? '')}">
	<div class="sheet__kicker">${escapeHtml(label)}</div>
	<h1>${escapeHtml(fm.title ?? '')}</h1>
	<div class="sheet__meta">${escapeHtml([date, fm.location].filter(Boolean).join(' · '))}</div>
	<div class="sheet__rule"></div>
	<div class="prose">${html}</div>
	${truncated ? '<p class="sheet__more">……全文见博客</p>' : ''}
	${footer ? `<div class="sheet__foot"><b>${escapeHtml(site.siteTitle)}</b><span>${escapeHtml(site.siteSubtitle)} · ${escapeHtml(site.host)}</span></div>` : ''}
</article>
</body>
</html>`;
}

let siteConfigMemo = null;
/** 从 src/config.ts 里捞站名和域名，不用解析 TS。 */
function siteConfigCache() {
	if (siteConfigMemo) return siteConfigMemo;
	let siteTitle = 'From BBS';
	let siteSubtitle = '此间春秋';
	let host = '';
	try {
		const source = readFileSyncSafe(path.join(ROOT, 'src', 'config.ts'));
		siteTitle = source.match(/siteTitle:\s*'([^']*)'/)?.[1] ?? siteTitle;
		siteSubtitle = source.match(/siteSubtitle:\s*'([^']*)'/)?.[1] ?? siteSubtitle;
		const url = source.match(/siteUrl:\s*'([^']*)'/)?.[1] ?? '';
		host = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
	} catch {}
	siteConfigMemo = { siteTitle, siteSubtitle, host };
	return siteConfigMemo;
}

function readFileSyncSafe(file) {
	try {
		return readFileSync(file, 'utf8');
	} catch {
		return '';
	}
}

/** 用无头浏览器把一个本地 URL 截成 PNG。 */
function screenshot({ url, width, height, scale, out }) {
	const browser = findBrowser();
	if (!browser) throw Object.assign(new Error('没找到可用的浏览器'), { status: 501, noBrowser: true });
	return new Promise((resolve, reject) => {
		const args = [
			'--headless=new',
			'--disable-gpu',
			'--hide-scrollbars',
			'--no-sandbox',
			'--force-color-profile=srgb',
			`--force-device-scale-factor=${scale}`,
			`--window-size=${width},${height}`,
			'--virtual-time-budget=6000',
			`--screenshot=${out}`,
			url,
		];
		execFile(browser, args, { timeout: 120000 }, (error) => {
			if (existsSync(out)) resolve(out);
			else reject(new Error(`截图失败：${error?.message ?? '浏览器没有产出文件'}`));
		});
	});
}

// ---------------------------------------------------------------------------
// git：只做「看状态 / 拉 / 提交并推送」三件事，全部由你按按钮触发
// ---------------------------------------------------------------------------

/**
 * 用 execFile 而不是 shell：提交信息是用户输入，作为独立的 argv 传进去，
 * 不经过任何命令行解析，省掉一整类注入问题。
 */
function git(args, { timeout = 20000 } = {}) {
	return new Promise((resolve, reject) => {
		execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd: ROOT, timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(new Error(String(stderr || stdout || error.message).trim()), { git: true }));
			// 只去掉结尾的空白：status --porcelain 的第一列就是空格，trim() 会把第一行的路径削掉一个字。
			else resolve(String(stdout).replace(/\s+$/, ''));
		});
	});
}

async function gitStatus() {
	try {
		await git(['rev-parse', '--is-inside-work-tree']);
	} catch {
		return { available: false };
	}
	const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '');
	const remote = await git(['remote', 'get-url', 'origin']).catch(() => '');
	const porcelain = await git(['status', '--porcelain']).catch(() => '');
	const files = porcelain
		.split('\n')
		.filter(Boolean)
		.map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }));
	let ahead = 0;
	let behind = 0;
	let upstream = '';
	try {
		upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
		const [b, a] = (await git(['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).split(/\s+/).map(Number);
		behind = b || 0;
		ahead = a || 0;
	} catch {}
	return { available: true, branch, remote, upstream, ahead, behind, files };
}

/** 默认的提交信息：数一下动了哪些东西，比 "update" 有用一点。 */
function suggestCommitMessage(files) {
	const posts = new Set();
	let assets = 0;
	let other = 0;
	for (const f of files) {
		const m = f.path.match(/^src\/content\/(blog|seasons)\/(.+?)\.(md|mdx)$/);
		if (m) posts.add(m[2]);
		else if (f.path.startsWith('public/assets/')) assets += 1;
		else other += 1;
	}
	const parts = [];
	if (posts.size === 1) parts.push(`更新 ${[...posts][0]}`);
	else if (posts.size > 1) parts.push(`更新 ${posts.size} 篇`);
	if (assets) parts.push(`${assets} 张图`);
	if (other && !parts.length) parts.push(`更新 ${other} 个文件`);
	else if (other) parts.push(`其他 ${other} 项`);
	return parts.join(' · ') || '更新';
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
};

function json(res, status, payload) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(payload));
}

function readBody(req, limit = 60 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > limit) {
				reject(new Error('请求体过大'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}

async function readJson(req) {
	const buffer = await readBody(req, 8 * 1024 * 1024);
	if (!buffer.length) return {};
	return JSON.parse(buffer.toString('utf8'));
}

function assertInside(base, target) {
	const resolved = path.resolve(target);
	if (resolved !== base && !resolved.startsWith(base + path.sep)) {
		throw Object.assign(new Error('路径越界'), { status: 400 });
	}
	return resolved;
}

async function serveFile(res, file, { cache = 'no-store' } = {}) {
	try {
		const data = await fs.readFile(file);
		res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': cache });
		res.end(data);
	} catch {
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('Not found');
	}
}

// ---------------------------------------------------------------------------
// 新建 / 追加
// ---------------------------------------------------------------------------

async function uniqueSlug(base) {
	if (!(await findPostFile(base))) return base;
	for (let n = 2; n < 200; n += 1) {
		const candidate = `${base}-${n}`;
		if (!(await findPostFile(candidate))) return candidate;
	}
	throw Object.assign(new Error('找不到可用的 slug'), { status: 409 });
}

/** 速记：日期 + 可选后缀，重名自动加 -2。 */
async function quickSlug(dateStr, suffix) {
	const date = DATE_RE.test(dateStr) ? dateStr : todayString();
	const tail = slugifyAscii(suffix);
	return uniqueSlug(tail ? `${date}-${tail}` : date);
}

function chineseDateHeading(dateStr) {
	const [, m, d] = (DATE_RE.test(dateStr) ? dateStr : todayString()).split('-');
	return `${Number(m)} 月 ${Number(d)} 日`;
}

async function writePost(file, fm, body) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, buildMarkdown(fm, body), 'utf8');
	return (await fs.stat(file)).mtimeMs;
}

// ---------------------------------------------------------------------------
// 关于页：src/content/about/about.md
//
// 站点上只有这一篇，所以没有列表、没有 slug、也不能删——接口就两个动作。
// ---------------------------------------------------------------------------

function normalizeAbout(input) {
	const fm = {};
	fm.title = String(input.title ?? '').trim();
	fm.kicker = String(input.kicker ?? '').trim() || 'About';
	fm.description = String(input.description ?? '').trim();
	const updated = toDateString(input.updatedDate);
	if (updated) fm.updatedDate = updated;
	const ordered = {};
	for (const key of ABOUT_FIELD_ORDER) if (fm[key] !== undefined) ordered[key] = fm[key];
	return ordered;
}

function validateAbout(fm) {
	const errors = [];
	const warnings = [];
	if (!fm.title) errors.push({ field: 'title', message: '标题不能为空。' });
	if (!fm.description) {
		errors.push({ field: 'description', message: '关于页的摘要是必填的（schema 里没设 optional），它会进 <meta description>。' });
	}
	if (fm.updatedDate && (!DATE_RE.test(fm.updatedDate) || Number.isNaN(Date.parse(fm.updatedDate)))) {
		errors.push({ field: 'updatedDate', message: '更新日期格式应为 YYYY-MM-DD。' });
	}
	if (!fm.kicker) warnings.push({ field: 'kicker', message: '小标题空着，页面上标题前面那行会是空的。' });
	return { ok: errors.length === 0, errors, warnings };
}

async function readAbout() {
	let source;
	try {
		source = await fs.readFile(ABOUT_FILE, 'utf8');
	} catch {
		return null;
	}
	const stat = await fs.stat(ABOUT_FILE);
	const { data, body } = splitFrontmatter(source);
	const known = {};
	const extra = {};
	for (const [key, value] of Object.entries(data)) {
		if (ABOUT_FIELD_ORDER.includes(key)) known[key] = value;
		else if (!key.startsWith('__')) extra[key] = value;
	}
	known.updatedDate = toDateString(known.updatedDate);
	return {
		kind: 'about',
		slug: 'about',
		file: path.relative(ROOT, ABOUT_FILE),
		frontmatter: known,
		extra,
		body,
		assets: [],
		mtimeMs: stat.mtimeMs,
		yamlError: data.__yamlError ?? null,
		validation: validateAbout(normalizeAbout(known)),
	};
}

// ---------------------------------------------------------------------------
// 英文版：src/content/blog-en/<slug>.md
//
// 这里只存翻译出来的东西——标题、摘要、正文。日期、栏目、标签、封面
// 一律由同 slug 的中文原文提供（见 src/lib/en.ts），所以中文那边改了
// 栏目或封面，英文页不会悄悄对不上。
// ---------------------------------------------------------------------------

const EN_FIELD_ORDER = ['title', 'description', 'location', 'draft', 'sourceHash', 'translatedAt', 'model'];

/**
 * 中文原文的指纹。只看翻译真正读到的三样东西，所以改标签、改封面
 * 不会把译文判成过期，改一个字才会。
 *
 * src/lib/en.ts 里有一份一模一样的实现，改这里记得改那边。
 */
function sourceFingerprint({ title = '', description = '', body = '' }) {
	const text = [
		String(title).trim(),
		String(description ?? '').trim(),
		String(body).replace(/\r\n/g, '\n').trim(),
	].join('\n\u0000\n');
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function enFile(slug) {
	return path.join(EN_DIR, `${slug}.md`);
}

async function readEn(slug) {
	const file = enFile(slug);
	let source;
	try {
		source = await fs.readFile(file, 'utf8');
	} catch {
		return null;
	}
	const stat = await fs.stat(file);
	const { data, body } = splitFrontmatter(source);
	return {
		slug,
		file: path.relative(ROOT, file),
		frontmatter: {
			title: data.title ?? '',
			description: data.description ?? '',
			location: data.location ?? '',
			draft: data.draft === undefined ? true : Boolean(data.draft),
			sourceHash: data.sourceHash ?? '',
			translatedAt: toDateString(data.translatedAt),
			model: data.model ?? '',
		},
		body,
		mtimeMs: stat.mtimeMs,
		yamlError: data.__yamlError ?? null,
	};
}

function normalizeEn(input) {
	const fm = {};
	fm.title = String(input.title ?? '').trim();
	const description = String(input.description ?? '').trim();
	if (description) fm.description = description;
	const location = String(input.location ?? '').trim();
	if (location) fm.location = location;
	fm.draft = Boolean(input.draft);
	if (input.sourceHash) fm.sourceHash = String(input.sourceHash);
	if (input.translatedAt) fm.translatedAt = toDateString(input.translatedAt);
	if (input.model) fm.model = String(input.model);
	const ordered = {};
	for (const key of EN_FIELD_ORDER) if (fm[key] !== undefined) ordered[key] = fm[key];
	return ordered;
}

async function writeEn(slug, fm, body) {
	const file = enFile(slug);
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, buildMarkdown(fm, body), 'utf8');
	return (await fs.stat(file)).mtimeMs;
}

// --------------------------------------------------------------- claude CLI

/**
 * 本机的 claude 命令行。GUI 双击起的 node 拿到的 PATH 往往很窄，
 * 所以除了 PATH 之外还把几个常见安装位置挨个试一遍。
 */
const EXE = process.platform === 'win32' ? '.exe' : '';
const CLAUDE_CANDIDATES = [
	process.env.CLAUDE_BIN,
	...(process.platform === 'win32' ? [path.join(os.homedir(), '.local', 'bin', 'claude.exe')] : []),
	path.join(os.homedir(), '.claude', 'local', 'claude'),
	path.join(os.homedir(), '.local', 'bin', 'claude'),
	path.join(os.homedir(), '.bun', 'bin', 'claude'),
	path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
	'/opt/homebrew/bin/claude',
	'/usr/local/bin/claude',
	'/usr/bin/claude',
].filter(Boolean);

let claudeCache;
function findClaude() {
	if (claudeCache !== undefined) return claudeCache;
	for (const candidate of CLAUDE_CANDIDATES) {
		try {
			if (existsSync(candidate)) return (claudeCache = candidate);
		} catch {
			/* 继续找 */
		}
	}
	// PATH 里有就用 PATH 里的，execFile 会自己解析。
	for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, `claude${EXE}`);
		try {
			if (existsSync(candidate)) return (claudeCache = candidate);
		} catch {
			/* 继续找 */
		}
	}
	return (claudeCache = null);
}

const TRANSLATE_SYSTEM = `You are a literary translator. You translate a Chinese personal-blog essay into English.

Rules, in order of importance:
1. Preserve the Markdown source structure EXACTLY. Same number of blocks, same order, same heading levels, same list markers, same blockquote markers, same blank lines between blocks. Do not merge or split paragraphs. Do not add a title heading.
2. Raw HTML blocks stay byte-identical in their tags, attributes, class names, ids and nesting. Translate ONLY the human-readable text between tags, and the values of alt=, title= and aria-label=. Never translate a class name or an id, never change an src= or href= path.
3. Image paths, links, LaTeX math ($...$ and $$...$$), and anything inside backticks stay unchanged.
4. Proper nouns: use the standard English form for well-known places (贵阳 -> Guiyang). For personal names written in Chinese, use pinyin without tone marks. Keep a name the author already writes in Latin letters exactly as it is.
5. Voice: this is a personal essay, not a news report. Keep the author's register — unhurried, concrete, a little wry. Do not inflate the prose, do not explain what the Chinese leaves unsaid, do not add a moral at the end of a paragraph. Where a Chinese sentence is a fragment, an English fragment is fine.
6. No translator's notes, no footnotes, no parentheses explaining Chinese culture.

Output format — output nothing else, no preamble, no code fence:
<<<TITLE>>>
(the English title, one line)
<<<DESCRIPTION>>>
(the English one-sentence description, one line; the single word NONE if the source has none)
<<<LOCATION>>>
(the English form of the place name given to you as LOCATION, one line; the single word NONE if none was given)
<<<BODY>>>
(the translated Markdown body)`;

function parseTranslation(text) {
	const out = String(text ?? '');
	const title = out.match(/<<<TITLE>>>\s*\n([\s\S]*?)\n\s*<<<DESCRIPTION>>>/);
	const description = out.match(/<<<DESCRIPTION>>>\s*\n([\s\S]*?)\n\s*<<<(?:LOCATION|BODY)>>>/);
	const location = out.match(/<<<LOCATION>>>\s*\n([\s\S]*?)\n\s*<<<BODY>>>/);
	const body = out.match(/<<<BODY>>>\s*\n([\s\S]*)$/);
	if (!title || !body) {
		const error = new Error('claude 的输出不是约定的格式，没法拆成标题 / 摘要 / 正文。');
		error.status = 502;
		error.raw = out.slice(0, 2000);
		throw error;
	}
	const blank = (value) => {
		const text = (value ?? '').trim();
		return text === 'NONE' || text === '(none)' ? '' : text;
	};
	return {
		title: title[1].trim(),
		description: blank(description?.[1]),
		location: blank(location?.[1]),
		body: body[1].replace(/\s+$/, '') + '\n',
	};
}

/**
 * 调本机的 claude 命令行翻一篇。
 *
 * - 提示词走 stdin，不进 argv：正文可能上万字，而且不必操心引号。
 * - cwd 设成临时目录，免得 Claude Code 把这个仓库的 CLAUDE.md / AGENTS.md
 *   也读进去当上下文——那是给写代码用的，会干扰翻译。
 * - --restricted 去掉会跑命令的工具，--strict-mcp-config 不加载任何 MCP。
 */
function translateWithClaude({ title, description, location, body, model }, { timeout = 900000 } = {}) {
	const bin = findClaude();
	if (!bin) {
		const error = new Error('没找到 claude 命令行。');
		error.status = 503;
		error.noClaude = true;
		throw error;
	}
	const argv = [
		'-p',
		'--output-format', 'text',
		'--system-prompt', TRANSLATE_SYSTEM,
		'--strict-mcp-config',
		'--no-session-persistence',
		'--restricted',
	];
	if (model) argv.push('--model', String(model));

	const prompt = `TITLE: ${title}\nDESCRIPTION: ${description || '(none)'}\nLOCATION: ${location || '(none)'}\n\n--- BODY STARTS ---\n${body}`;

	return new Promise((resolve, reject) => {
		const child = execFile(
			bin,
			argv,
			{ cwd: os.tmpdir(), timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } },
			(error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr || stdout || error.message).trim().slice(0, 600);
					const wrapped = new Error(
						error.killed ? `翻译超时了（${Math.round(timeout / 1000)} 秒）。文章很长的话可以先拆开译。` : `claude 退出异常：${detail}`,
					);
					wrapped.status = 502;
					return reject(wrapped);
				}
				try {
					resolve(parseTranslation(stdout));
				} catch (parseError) {
					reject(parseError);
				}
			},
		);
		child.stdin.on('error', () => {});
		child.stdin.end(prompt);
	});
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
	const segments = url.pathname.split('/').filter(Boolean); // ['api', ...]
	const [, resource, ...rest] = segments;
	const method = req.method ?? 'GET';

	// GET /api/meta
	if (resource === 'meta' && method === 'GET') {
		return json(res, 200, {
			root: ROOT,
			projectName: path.basename(ROOT),
			contentDir: path.relative(ROOT, CONTENT_DIR),
			assetsDir: path.relative(ROOT, ASSETS_DIR),
			categories: CATEGORIES,
			categoryLabels: CATEGORY_LABELS,
			coverLayouts: COVER_LAYOUTS,
			astroDevUrl: ASTRO_DEV_URL,
			today: todayString(),
			quickDefaults: { category: 'thoughts', tags: ['思绪'], language: 'zh' },
			seasonNames: SEASON_NAMES,
			// 界面是从磁盘现读的，服务是进程启动时载入的。两边版本对不上时
			// （改完代码忘了重启），界面会拿这个列表判断，好过让人对着 404 发呆。
			features: ['export', 'git', 'seasons', 'en', 'about'],
		});
	}

	// GET /api/posts
	if (resource === 'posts' && rest.length === 0 && method === 'GET') {
		return json(res, 200, await listPosts());
	}

	// POST /api/posts  → 新建（完整表单）
	if (resource === 'posts' && rest.length === 0 && method === 'POST') {
		const payload = await readJson(req);
		const slug = String(payload.slug ?? '').trim();
		if (!SLUG_RE.test(slug)) return json(res, 400, { error: 'slug 只能用小写字母、数字和连字符。' });
		if (await findPostFile(slug)) return json(res, 409, { error: `已经有一篇 slug 为 ${slug} 的文章了。` });
		const fm = normalizeFrontmatter({
			title: payload.title ?? '',
			publishDate: payload.publishDate || todayString(),
			tags: payload.tags ?? [],
			category: payload.category ?? 'journey',
			draft: true,
			unlisted: false,
			language: 'zh',
		});
		await writePost(path.join(CONTENT_DIR, `${slug}.md`), fm, payload.body ?? '');
		await fs.mkdir(path.join(ASSETS_DIR, slug), { recursive: true });
		return json(res, 201, await readPost(slug));
	}

	// POST /api/quick  → 速记：一屏写完一条随笔
	if (resource === 'quick' && method === 'POST') {
		const payload = await readJson(req);
		const title = String(payload.title ?? '').trim();
		const body = String(payload.body ?? '');
		if (!title) return json(res, 400, { error: '标题不能为空。' });
		const publishDate = DATE_RE.test(String(payload.publishDate ?? '')) ? payload.publishDate : todayString();
		const slug = await quickSlug(publishDate, payload.slugSuffix);
		const fm = normalizeFrontmatter({
			title,
			publishDate,
			tags: payload.tags ?? [],
			category: CATEGORIES.includes(payload.category) ? payload.category : 'thoughts',
			draft: payload.draft !== false,
			unlisted: Boolean(payload.unlisted),
			location: payload.location ?? '',
			language: payload.language ?? 'zh',
		});
		const validation = validateFrontmatter(fm, { slug });
		if (!validation.ok) return json(res, 422, { error: 'frontmatter 有错误，未保存。', validation });
		await writePost(path.join(CONTENT_DIR, `${slug}.md`), fm, body);
		return json(res, 201, await readPost(slug));
	}

	// POST /api/append  → 把一条新条目接到已有文章末尾
	if (resource === 'append' && method === 'POST') {
		const payload = await readJson(req);
		const slug = String(payload.slug ?? '').trim();
		const body = String(payload.body ?? '').trim();
		if (!body) return json(res, 400, { error: '内容是空的。' });
		const file = await findPostFile(slug);
		if (!file) return json(res, 404, { error: '文章不存在' });
		const source = await fs.readFile(file, 'utf8');
		const { data, body: existing } = splitFrontmatter(source);
		const known = {};
		const extra = {};
		for (const [key, value] of Object.entries(data)) {
			if (FIELD_ORDER.includes(key)) known[key] = value;
			else if (!key.startsWith('__')) extra[key] = value;
		}
		known.publishDate = toDateString(known.publishDate);
		const date = DATE_RE.test(String(payload.date ?? '')) ? payload.date : todayString();
		const heading = payload.heading === false ? '' : `## ${chineseDateHeading(date)}\n\n`;
		const separator = payload.separator ? '---\n\n' : '';
		const nextBody = `${existing.replace(/\s+$/, '')}\n\n${separator}${heading}${body}\n`;
		// 追加就是一次更新：同步 updatedDate（发布日期保持原样）。
		known.updatedDate = date;
		const fm = normalizeFrontmatter({ ...known, __extra: extra });
		await fs.writeFile(file, buildMarkdown(fm, nextBody), 'utf8');
		return json(res, 200, await readPost(slug));
	}

	// GET /api/slug-check?date=&suffix=
	if (resource === 'slug-check' && method === 'GET') {
		const date = url.searchParams.get('date') ?? todayString();
		const suffix = url.searchParams.get('suffix') ?? '';
		const base = slugifyAscii(suffix) ? `${date}-${slugifyAscii(suffix)}` : date;
		const taken = Boolean(await findPostFile(base));
		return json(res, 200, { base, taken, slug: await quickSlug(date, suffix) });
	}

	// /api/posts/:slug
	if (resource === 'posts' && rest.length === 1) {
		const slug = decodeURIComponent(rest[0]);
		if (!SLUG_RE.test(slug) && !/^[\w./-]+$/.test(slug)) return json(res, 400, { error: '非法 slug' });

		if (method === 'GET') {
			const post = await readPost(slug);
			return post ? json(res, 200, post) : json(res, 404, { error: '文章不存在' });
		}

		if (method === 'PUT') {
			const payload = await readJson(req);
			const file = await findPostFile(slug);
			if (!file) return json(res, 404, { error: '文章不存在' });

			// 磁盘守卫：文件在别处（Obsidian、编辑器、git）被改过就不要盲写。
			if (payload.mtimeMs && !payload.overwrite) {
				const stat = await fs.stat(file);
				if (Math.abs(stat.mtimeMs - Number(payload.mtimeMs)) > 1) {
					return json(res, 409, { code: 'stale', error: '这个文件在磁盘上被改过了。', mtimeMs: stat.mtimeMs });
				}
			}

			const fm = normalizeFrontmatter({ ...payload.frontmatter, __extra: payload.extra });
			const body = String(payload.body ?? '');
			const newSlug = String(payload.newSlug ?? slug).trim();
			const validation = validateFrontmatter(fm, { slug: newSlug });
			if (!validation.ok && !payload.force) {
				return json(res, 422, { error: 'frontmatter 有错误，未保存。', validation });
			}

			let targetFile = file;
			let finalBody = body;
			if (newSlug !== slug) {
				if (!SLUG_RE.test(newSlug)) return json(res, 400, { error: 'slug 只能用小写字母、数字和连字符。' });
				if (await findPostFile(newSlug)) return json(res, 409, { error: `已经有一篇 slug 为 ${newSlug} 的文章了。` });
				// 移动图片目录 + 改写路径
				const oldAssets = path.join(ASSETS_DIR, slug);
				const newAssets = path.join(ASSETS_DIR, newSlug);
				if (existsSync(oldAssets)) {
					await fs.mkdir(path.dirname(newAssets), { recursive: true });
					await fs.rename(oldAssets, newAssets);
				}
				const oldPrefix = `/assets/posts/${slug}/`;
				const newPrefix = `/assets/posts/${newSlug}/`;
				finalBody = body.split(oldPrefix).join(newPrefix);
				if (typeof fm.cover === 'string' && fm.cover.startsWith(oldPrefix)) fm.cover = newPrefix + fm.cover.slice(oldPrefix.length);
				// 目标文件：始终写成 src/content/blog/[slug].md
				targetFile = path.join(CONTENT_DIR, `${newSlug}${path.extname(file).toLowerCase() === '.mdx' ? '.mdx' : '.md'}`);
				await fs.mkdir(path.dirname(targetFile), { recursive: true });
				await fs.rename(file, targetFile);
				await fs.writeFile(targetFile, buildMarkdown(fm, finalBody), 'utf8');
				// 若原来是 slug/index.md，顺手清掉空目录
				const oldDir = path.dirname(file);
				if (oldDir !== CONTENT_DIR) {
					try {
						const left = await fs.readdir(oldDir);
						if (left.length === 0) await fs.rmdir(oldDir);
					} catch {}
				}
			} else {
				await fs.writeFile(targetFile, buildMarkdown(fm, finalBody), 'utf8');
			}
			const saved = await readPost(newSlug);
			return json(res, 200, { ...saved, validation: validateFrontmatter(fm, { slug: newSlug }) });
		}

		if (method === 'DELETE') {
			const file = await findPostFile(slug);
			if (!file) return json(res, 404, { error: '文章不存在' });
			await fs.mkdir(TRASH_DIR, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const trashName = `${slug.replace(/\//g, '__')}--${stamp}`;
			await fs.rename(file, path.join(TRASH_DIR, `${trashName}${path.extname(file)}`));
			const assets = path.join(ASSETS_DIR, slug);
			if (existsSync(assets)) await fs.rename(assets, path.join(TRASH_DIR, `${trashName}-assets`));
			return json(res, 200, { ok: true, trash: path.relative(ROOT, TRASH_DIR) });
		}
	}

	// POST /api/validate  → 只校验不保存
	if (resource === 'validate' && method === 'POST') {
		const payload = await readJson(req);
		const fm = normalizeFrontmatter({ ...payload.frontmatter, __extra: payload.extra });
		return json(res, 200, {
			frontmatter: fm,
			yaml: dumpYaml(fm),
			validation: validateFrontmatter(fm, { slug: payload.slug }),
		});
	}

	// POST /api/preview  → Markdown → HTML
	if (resource === 'preview' && method === 'POST') {
		const payload = await readJson(req);
		try {
			const html = await renderPreview(String(payload.body ?? ''));
			return json(res, 200, { html });
		} catch (error) {
			return json(res, 200, { html: `<p class="preview-error">预览失败：${escapeHtml(String(error.message || error))}</p>` });
		}
	}

	// /api/assets/:slug
	if (resource === 'assets' && rest.length >= 1) {
		const slug = decodeURIComponent(rest[0]);
		if (!SLUG_RE.test(slug)) return json(res, 400, { error: '非法 slug' });
		const dir = assertInside(ASSETS_DIR, path.join(ASSETS_DIR, slug));

		if (method === 'GET' && rest.length === 1) return json(res, 200, await listAssets(slug));

		if (method === 'POST' && rest.length === 1) {
			// 上传：原始二进制 body + x-filename 头（URL 编码）
			const rawName = decodeURIComponent(req.headers['x-filename'] ?? 'image');
			const preferred = req.headers['x-rename'] ? decodeURIComponent(String(req.headers['x-rename'])) : '';
			const name = safeFileName(preferred ? preferred + (path.extname(preferred) ? '' : path.extname(rawName)) : rawName);
			if (!IMAGE_EXT.has(path.extname(name).toLowerCase())) return json(res, 400, { error: '只接受图片文件（jpg/png/webp/gif/avif/svg）。' });
			const buffer = await readBody(req);
			if (!buffer.length) return json(res, 400, { error: '空文件' });
			await fs.mkdir(dir, { recursive: true });
			const target = await uniquePath(dir, name);
			await fs.writeFile(target, buffer);
			const stat = await fs.stat(target);
			return json(res, 201, {
				name: path.basename(target),
				url: `/assets/posts/${slug}/${path.basename(target)}`,
				size: stat.size,
				modifiedAt: stat.mtime.toISOString(),
			});
		}

		if (method === 'DELETE' && rest.length === 2) {
			const name = decodeURIComponent(rest[1]);
			const target = assertInside(dir, path.join(dir, name));
			if (!existsSync(target)) return json(res, 404, { error: '文件不存在' });
			await fs.mkdir(TRASH_DIR, { recursive: true });
			await fs.rename(target, path.join(TRASH_DIR, `${slug}--${Date.now()}--${name}`));
			return json(res, 200, { ok: true });
		}

		if (method === 'PATCH' && rest.length === 2) {
			// 重命名图片
			const name = decodeURIComponent(rest[1]);
			const payload = await readJson(req);
			const newName = safeFileName(String(payload.name ?? ''));
			const from = assertInside(dir, path.join(dir, name));
			const to = assertInside(dir, path.join(dir, newName));
			if (!existsSync(from)) return json(res, 404, { error: '文件不存在' });
			if (existsSync(to)) return json(res, 409, { error: '已有同名文件' });
			await fs.rename(from, to);
			return json(res, 200, { name: newName, url: `/assets/posts/${slug}/${newName}`, oldUrl: `/assets/posts/${slug}/${name}` });
		}
	}

	// GET /api/public-images  → public/assets/covers 下可选的通用封面
	if (resource === 'public-images' && method === 'GET') {
		const coversDir = path.join(PUBLIC_DIR, 'assets', 'covers');
		if (!existsSync(coversDir)) return json(res, 200, []);
		const entries = await fs.readdir(coversDir);
		return json(
			res,
			200,
			entries
				.filter((name) => IMAGE_EXT.has(path.extname(name).toLowerCase()))
				.map((name) => ({ name, url: `/assets/covers/${name}` })),
		);
	}

	// /api/seasons —— 季笺
	if (resource === 'seasons') {
		if (method === 'GET' && rest.length === 0) return json(res, 200, await listSeasons());

		if (method === 'POST' && rest.length === 0) {
			const payload = await readJson(req);
			const slug = String(payload.slug ?? '').trim();
			if (!SLUG_RE.test(slug)) return json(res, 400, { error: 'slug 只能用小写字母、数字和连字符。' });
			if (await findSeasonFile(slug)) return json(res, 409, { error: `已经有一篇 slug 为 ${slug} 的季笺了。` });
			const fm = normalizeSeason({
				title: payload.title ?? '',
				season: payload.season ?? '',
				year: payload.year,
				description: payload.description ?? '',
				draft: true,
				publishDate: payload.publishDate || todayString(),
			});
			await writePost(path.join(SEASONS_DIR, `${slug}.md`), fm, payload.body ?? '');
			return json(res, 201, await readSeason(slug));
		}

		if (rest.length === 1) {
			const slug = decodeURIComponent(rest[0]);
			if (!SLUG_RE.test(slug)) return json(res, 400, { error: '非法 slug' });

			if (method === 'GET') {
				const season = await readSeason(slug);
				return season ? json(res, 200, season) : json(res, 404, { error: '季笺不存在' });
			}

			if (method === 'PUT') {
				const payload = await readJson(req);
				const file = await findSeasonFile(slug);
				if (!file) return json(res, 404, { error: '季笺不存在' });
				if (payload.mtimeMs && !payload.overwrite) {
					const stat = await fs.stat(file);
					if (Math.abs(stat.mtimeMs - Number(payload.mtimeMs)) > 1) {
						return json(res, 409, { code: 'stale', error: '这个文件在磁盘上被改过了。', mtimeMs: stat.mtimeMs });
					}
				}
				const fm = normalizeSeason({ ...payload.frontmatter, __extra: payload.extra });
				const validation = validateSeason(fm, { slug });
				if (!validation.ok && !payload.force) {
					return json(res, 422, { error: 'frontmatter 有错误，未保存。', validation });
				}
				await fs.writeFile(file, buildMarkdown(fm, String(payload.body ?? '')), 'utf8');
				const saved = await readSeason(slug);
				return json(res, 200, { ...saved, validation });
			}

			if (method === 'DELETE') {
				const file = await findSeasonFile(slug);
				if (!file) return json(res, 404, { error: '季笺不存在' });
				await fs.mkdir(TRASH_DIR, { recursive: true });
				const stamp = new Date().toISOString().replace(/[:.]/g, '-');
				await fs.rename(file, path.join(TRASH_DIR, `season--${slug}--${stamp}${path.extname(file)}`));
				return json(res, 200, { ok: true });
			}
		}
	}

	// POST /api/validate-season
	if (resource === 'validate-season' && method === 'POST') {
		const payload = await readJson(req);
		const fm = normalizeSeason({ ...payload.frontmatter, __extra: payload.extra });
		return json(res, 200, { frontmatter: fm, yaml: dumpYaml(fm), validation: validateSeason(fm, { slug: payload.slug }) });
	}

	// ------------------------------------------------------------------ 关于页
	// 只有读和写：站点上就这一篇，既不能新建也不能删。
	if (resource === 'about' && rest.length === 0) {
		if (method === 'GET') {
			const about = await readAbout();
			return about
				? json(res, 200, about)
				: json(res, 404, { error: '找不到 src/content/about/about.md' });
		}

		if (method === 'PUT') {
			const payload = await readJson(req);
			if (!existsSync(ABOUT_FILE)) return json(res, 404, { error: '找不到 src/content/about/about.md' });
			if (payload.mtimeMs && !payload.overwrite) {
				const stat = await fs.stat(ABOUT_FILE);
				if (Math.abs(stat.mtimeMs - Number(payload.mtimeMs)) > 1) {
					return json(res, 409, { code: 'stale', error: '这个文件在磁盘上被改过了。', mtimeMs: stat.mtimeMs });
				}
			}
			const fm = normalizeAbout({ ...payload.frontmatter });
			const validation = validateAbout(fm);
			if (!validation.ok && !payload.force) {
				return json(res, 422, { error: validation.errors[0].message, validation });
			}
			// 保留用户自己加的字段，别在保存时悄悄吃掉。
			const merged = { ...fm, ...(payload.extra ?? {}) };
			const ordered = {};
			for (const key of ABOUT_FIELD_ORDER) if (merged[key] !== undefined) ordered[key] = merged[key];
			for (const [key, value] of Object.entries(merged)) if (!(key in ordered)) ordered[key] = value;
			await writePost(ABOUT_FILE, ordered, payload.body ?? '');
			return json(res, 200, await readAbout());
		}

		return json(res, 405, { error: '不支持的方法' });
	}

	// POST /api/validate-about
	if (resource === 'validate-about' && method === 'POST') {
		const payload = await readJson(req);
		const fm = normalizeAbout({ ...payload.frontmatter });
		return json(res, 200, { frontmatter: fm, yaml: dumpYaml(fm), validation: validateAbout(fm) });
	}

	// ------------------------------------------------------------------ 英文版
	// GET /api/en/probe —— 本机有没有 claude 命令行
	if (resource === 'en' && rest[0] === 'probe' && method === 'GET') {
		const bin = findClaude();
		return json(res, 200, { claude: bin, name: bin ? path.basename(bin) : null });
	}

	if (resource === 'en' && rest.length >= 1 && rest[0] !== 'probe') {
		const slug = decodeURIComponent(rest[0]);
		if (!SLUG_RE.test(slug)) return json(res, 400, { error: '非法 slug' });
		const post = await readPost(slug);
		if (!post) return json(res, 404, { error: '中文原文不存在' });
		const hash = sourceFingerprint({
			title: post.frontmatter.title,
			description: post.frontmatter.description,
			body: post.body,
		});

		// GET /api/en/:slug —— 读英文版
		if (rest.length === 1 && method === 'GET') {
			const en = await readEn(slug);
			return json(res, 200, {
				slug,
				exists: Boolean(en),
				sourceHash: hash,
				stale: Boolean(en && en.frontmatter.sourceHash && en.frontmatter.sourceHash !== hash),
				source: { title: post.frontmatter.title, description: post.frontmatter.description ?? '' },
				...(en ?? { frontmatter: { title: '', description: '', draft: true }, body: '' }),
			});
		}

		// PUT /api/en/:slug —— 存英文版
		if (rest.length === 1 && method === 'PUT') {
			const payload = await readJson(req);
			const title = String(payload.title ?? '').trim();
			if (!title) return json(res, 400, { error: '英文标题不能为空。' });
			const body = String(payload.body ?? '');
			if (!body.trim()) return json(res, 400, { error: '英文正文是空的。' });
			// 存的时候把当前原文的指纹记下来：之后原文改了就知道译文过期了。
			// 只有正文确实是照这版原文译的才该盖章，所以沿用前端传回来的那个。
			const fm = normalizeEn({
				title,
				description: payload.description,
				location: payload.location,
				draft: payload.draft !== false,
				sourceHash: payload.sourceHash || hash,
				translatedAt: payload.translatedAt || todayString(),
				model: payload.model,
			});
			const mtimeMs = await writeEn(slug, fm, body.endsWith('\n') ? body : `${body}\n`);
			return json(res, 200, { ok: true, slug, mtimeMs, frontmatter: fm, sourceHash: hash });
		}

		// DELETE /api/en/:slug —— 丢掉英文版（进 .trash，和删文章一样）
		if (rest.length === 1 && method === 'DELETE') {
			const file = enFile(slug);
			if (!existsSync(file)) return json(res, 404, { error: '还没有英文版' });
			await fs.mkdir(path.join(TRASH_DIR, 'blog-en'), { recursive: true });
			const target = path.join(TRASH_DIR, 'blog-en', `${slug}-${Date.now()}.md`);
			await fs.rename(file, target);
			return json(res, 200, { ok: true, trashed: path.relative(ROOT, target) });
		}

		// POST /api/en/:slug/translate —— 调本机 claude 翻一遍，只回结果不落盘
		if (rest[1] === 'translate' && method === 'POST') {
			const payload = await readJson(req).catch(() => ({}));
			try {
				const started = Date.now();
				const result = await translateWithClaude({
					title: post.frontmatter.title,
					description: post.frontmatter.description ?? '',
					location: post.frontmatter.location ?? '',
					body: post.body,
					model: payload.model,
				});
				return json(res, 200, { ...result, sourceHash: hash, seconds: Math.round((Date.now() - started) / 1000) });
			} catch (error) {
				return json(res, error.status ?? 500, {
					error: error.message,
					noClaude: Boolean(error.noClaude),
					raw: error.raw,
					hint: error.noClaude
						? '写作台是调你这台机器上的 claude 命令行翻译的。装好之后（或者把路径写进 CLAUDE_BIN 环境变量）重开一次写作台。'
						: undefined,
				});
			}
		}

		return json(res, 405, { error: '不支持的方法' });
	}

	// GET /api/export/probe —— 有没有可用的浏览器
	if (resource === 'export' && rest[0] === 'probe' && method === 'GET') {
		const browser = findBrowser();
		return json(res, 200, { browser, name: browser ? path.basename(browser) : null });
	}

	// POST /api/export/png —— 截一张长图回来
	if (resource === 'export' && rest[0] === 'png' && method === 'POST') {
		const payload = await readJson(req);
		const slug = String(payload.slug ?? '');
		const post = await readPost(slug);
		if (!post) return json(res, 404, { error: '文章不存在' });
		const width = Math.min(2000, Math.max(320, Number(payload.width) || 1080));
		const height = Math.min(30000, Math.max(200, Math.round(Number(payload.height) || 2000)));
		const scale = Math.min(3, Math.max(1, Number(payload.scale) || 1));
		const params = new URLSearchParams({
			w: String(width),
			theme: payload.theme === 'dark' ? 'dark' : 'light',
			footer: payload.footer === false ? '0' : '1',
			limit: String(Number(payload.limit) || 0),
		});
		const url = `http://127.0.0.1:${PORT}/export/${encodeURIComponent(slug)}?${params}`;
		const out = path.join(os.tmpdir(), `frombbs-${Date.now()}.png`);
		try {
			await screenshot({ url, width, height, scale, out });
			const data = await fs.readFile(out);
			await fs.unlink(out).catch(() => {});
			res.writeHead(200, {
				'content-type': 'image/png',
				'content-length': data.length,
				'content-disposition': `attachment; filename="${encodeURIComponent(slug)}.png"`,
				'cache-control': 'no-store',
			});
			return res.end(data);
		} catch (error) {
			return json(res, error.status ?? 500, {
				error: error.message,
				noBrowser: Boolean(error.noBrowser),
				hint: error.noBrowser ? '没找到 Chrome / Edge / Brave。可以先「在新标签里打开」，再用系统截图。' : undefined,
			});
		}
	}

	// /api/git —— 同步。三个动作都要你在界面上按一下，服务自己不会动。
	if (resource === 'git') {
		if (method === 'GET' && rest.length === 0) {
			const status = await gitStatus();
			return json(res, 200, { ...status, suggested: status.files ? suggestCommitMessage(status.files) : '' });
		}
		if (method === 'POST' && rest[0] === 'fetch') {
			try {
				await git(['fetch', '--quiet', 'origin'], { timeout: 45000 });
				return json(res, 200, await gitStatus());
			} catch (error) {
				return json(res, 502, { error: `git fetch 失败：${error.message}` });
			}
		}
		if (method === 'POST' && rest[0] === 'pull') {
			try {
				// --ff-only：拉不动就老老实实报错，不在你背后造合并提交。
				const out = await git(['pull', '--ff-only'], { timeout: 60000 });
				return json(res, 200, { ok: true, output: out, ...(await gitStatus()) });
			} catch (error) {
				return json(res, 409, { error: error.message, hint: '本地有和远程冲突的改动，git pull --ff-only 拉不动。到终端里手动处理一下。' });
			}
		}
		if (method === 'POST' && rest[0] === 'push') {
			try {
				await git(['push'], { timeout: 90000 });
				return json(res, 200, { ok: true, pushed: true, ...(await gitStatus()) });
			} catch (error) {
				return json(res, 502, { error: `git push 失败：${error.message}` });
			}
		}
		if (method === 'POST' && rest[0] === 'commit') {
			const payload = await readJson(req);
			const message = String(payload.message ?? '').trim();
			if (!message) return json(res, 400, { error: '提交信息不能为空。' });
			const before = await gitStatus();
			if (!before.files.length) return json(res, 400, { error: '没有需要提交的改动。' });
			try {
				await git(['add', '-A']);
				await git(['commit', '-m', message]);
			} catch (error) {
				return json(res, 500, { error: `git commit 失败：${error.message}` });
			}
			if (payload.push === false) return json(res, 200, { ok: true, pushed: false, ...(await gitStatus()) });
			try {
				await git(['push'], { timeout: 90000 });
			} catch (error) {
				return json(res, 502, { error: `已经提交到本地，但 push 失败：${error.message}`, committed: true, ...(await gitStatus()) });
			}
			return json(res, 200, { ok: true, pushed: true, ...(await gitStatus()) });
		}
	}

	// POST /api/open  → 用系统默认程序打开文件/文件夹（只允许项目内路径）
	if (resource === 'open' && method === 'POST') {
		const payload = await readJson(req);
		const target = assertInside(ROOT, path.join(ROOT, String(payload.path ?? '')));
		if (!existsSync(target)) return json(res, 404, { error: '路径不存在' });
		openWithSystem(target);
		return json(res, 200, { ok: true });
	}

	return json(res, 404, { error: `未知接口 ${url.pathname}` });
}

function openWithSystem(target) {
	const platform = process.platform;
	const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
	const cmdArgs = platform === 'win32' ? ['/c', 'start', '', target] : [target];
	try {
		spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref();
	} catch (error) {
		console.warn('[editor] 无法打开', target, error.message);
	}
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
	try {
		if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

		if (url.pathname === '/' || url.pathname === '/index.html') return await serveFile(res, UI_FILE);

		// 长图页面：编辑器里的预览和无头截图看到的是同一个 URL
		if (url.pathname.startsWith('/export/')) {
			const slug = decodeURIComponent(url.pathname.slice('/export/'.length));
			const post = await readPost(slug);
			if (!post) {
				res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
				return res.end('文章不存在');
			}
			const page = await buildExportPage({
				post,
				width: Math.min(2000, Math.max(320, Number(url.searchParams.get('w')) || 1080)),
				theme: url.searchParams.get('theme') === 'dark' ? 'dark' : 'light',
				footer: url.searchParams.get('footer') !== '0',
				limit: Number(url.searchParams.get('limit')) || 0,
			});
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
			return res.end(page);
		}

		// 站点样式，供预览使用
		if (url.pathname === '/site.css') return await serveFile(res, path.join(ROOT, 'src', 'styles', 'global.css'));
		if (url.pathname === '/katex.css') {
			return await serveFile(res, path.join(ROOT, 'node_modules', 'katex', 'dist', 'katex.min.css'), { cache: 'max-age=3600' });
		}
		if (url.pathname.startsWith('/fonts/')) {
			const fontsDir = path.join(ROOT, 'node_modules', 'katex', 'dist', 'fonts');
			const file = assertInside(fontsDir, path.join(fontsDir, path.basename(url.pathname)));
			return await serveFile(res, file, { cache: 'max-age=86400' });
		}

		// public/ 下的静态文件（图片）
		if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/favicon')) {
			const file = assertInside(PUBLIC_DIR, path.join(PUBLIC_DIR, decodeURIComponent(url.pathname)));
			return await serveFile(res, file);
		}

		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('Not found');
	} catch (error) {
		const status = error.status ?? 500;
		console.error('[editor]', req.method, url.pathname, error);
		json(res, status, { error: String(error.message || error) });
	}
});

server.listen(PORT, '127.0.0.1', () => {
	const address = `http://127.0.0.1:${PORT}/`;
	console.log('');
	console.log('  From BBS · 本地写作台');
	console.log(`  ${address}`);
	console.log(`  项目：${ROOT}`);
	console.log('  N 速记 · ⌘K 跳转 · ⌘↩ 发布 · Ctrl+C 退出');
	console.log('');
	if (SHOULD_OPEN) openWithSystem(address);
});

server.on('error', (error) => {
	if (error.code === 'EADDRINUSE') {
		console.error(`[editor] 端口 ${PORT} 已被占用。换一个：npm run editor -- --port 4381`);
		process.exit(1);
	}
	throw error;
});
