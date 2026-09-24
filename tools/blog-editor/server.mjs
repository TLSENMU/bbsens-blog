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
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const CONTENT_DIR = path.join(ROOT, 'src', 'content', 'blog');
const SEASONS_DIR = path.join(ROOT, 'src', 'content', 'seasons');
const ASSETS_DIR = path.join(ROOT, 'public', 'assets', 'posts');
const PUBLIC_DIR = path.join(ROOT, 'public');
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
		posts.push({
			slug: slugFromFile(file),
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
