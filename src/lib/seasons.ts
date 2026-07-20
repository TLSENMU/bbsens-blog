import type { CollectionEntry } from 'astro:content';

export type SeasonEntry = CollectionEntry<'seasons'>;

export function getSeasonSlug(season: SeasonEntry) {
	return season.id.replace(/\/index\.(md|mdx)$/i, '').replace(/\.(md|mdx)$/i, '');
}

export function getSeasonUrl(season: SeasonEntry) {
	return `/seasons/${getSeasonSlug(season)}/`;
}

export function sortSeasons(seasons: SeasonEntry[]) {
	return [...seasons].sort(
		(a, b) => b.data.publishDate.getTime() - a.data.publishDate.getTime(),
	);
}
