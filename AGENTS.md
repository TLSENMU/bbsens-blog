## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

## Documentation

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)

# 任务：重构 From BBS 博客外观与本地写作界面

请先阅读项目结构、AGENTS.md、README.md 和现有 Astro 代码，不要重做技术架构。

## 项目背景

这是一个 Astro + TypeScript 的个人博客，部署在 Cloudflare Pages，内容主要是中文游记、生活感悟、食记、朋友与物件记录。

技术栈保持：

- Astro
- TypeScript
- Astro Content Collections
- Markdown / MDX
- 原生 CSS
- npm
- Cloudflare Pages 静态部署

不要引入 React、Vue、数据库、后端线上服务或大型 UI 框架。

## 一、网站外观和交互重构

请在现有设计基础上优化，不要推翻重做。

保留：

- From BBS
- 此间春秋
- 当前导航：首页 / 在路上 / 食 / 物与人 / 关于我
- 暖白纸张感
- 中文宋体标题
- 私人季刊、游记、食记、日常记录的方向

重点优化：

- 首页层次
- 文章页阅读体验
- 图片展示
- 菜谱小卡片
- 移动端排版
- 深色模式
- 标签、归档、搜索页面的质感

不要做成程序员博客，不要做炫技动画，不要大面积渐变或玻璃拟态。

## 二、本地博客更新图形界面

请新增一个本地工具，路径：

tools/blog-editor/

这个工具只用于本地运行，不作为线上站点部署。

目标：让我用图形界面更新博客文章，而不是手写所有 frontmatter。

功能包括：

1. 新建文章
2. 编辑已有文章
3. 编辑 frontmatter
4. 上传或选择封面图
5. 插入正文图片
6. 自动把图片放到：
   public/assets/posts/[slug]/
7. 自动把文章保存到：
   src/content/blog/[slug].md
8. 支持字段：
   - title
   - description
   - publishDate
   - updatedDate
   - tags
   - cover
   - coverAlt
   - coverLayout
   - coverPosition
   - category
   - draft
   - unlisted
   - featured
   - location
   - language
9. 支持 Markdown 正文编辑
10. 支持预览 frontmatter 是否有效
11. 不要引入数据库
12. 不要要求线上登录
13. 不要自动 push
14. 不要修改 Cloudflare 配置

可以新增 npm scripts，例如：

npm run editor

## 三、内容安全和兼容

请保持 Astro Content Collections schema 正确。

所有公开页面仍然使用现有过滤逻辑：

- draft 不上线
- unlisted 可访问但不出现在公开列表
- RSS、sitemap、搜索都保持正确

## 四、开发要求

按照 AGENTS.md：

启动开发服务器时使用：

astro dev --background

管理服务使用：

astro dev status
astro dev logs
astro dev stop

完成后运行：

npm run build

修复所有错误。

不要提交或 push，除非我明确要求。