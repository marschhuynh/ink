import wrapAnsi from 'wrap-ansi';
import cliTruncate from 'cli-truncate';
import {type Styles} from './styles.js';

export const WRAP_TEXT_CACHE_MAX = 256;

const cache = new Map<string, string>();

const wrapText = (
	text: string,
	maxWidth: number,
	wrapType: Styles['textWrap'],
): string => {
	const cacheKey = JSON.stringify([text, maxWidth, wrapType]);
	const cachedText = cache.get(cacheKey);

	if (cachedText) {
		cache.delete(cacheKey);
		cache.set(cacheKey, cachedText);
		return cachedText;
	}

	let wrappedText = text;

	if (wrapType === 'wrap') {
		wrappedText = wrapAnsi(text, maxWidth, {
			trim: false,
			hard: true,
		});
	}

	if (wrapType === 'hard') {
		wrappedText = wrapAnsi(text, maxWidth, {
			trim: false,
			hard: true,
			wordWrap: false,
		});
	}

	if (wrapType!.startsWith('truncate')) {
		let position: 'end' | 'middle' | 'start' = 'end';

		if (wrapType === 'truncate-middle') {
			position = 'middle';
		}

		if (wrapType === 'truncate-start') {
			position = 'start';
		}

		wrappedText = cliTruncate(text, maxWidth, {position});
	}

	cache.set(cacheKey, wrappedText);
	if (cache.size > WRAP_TEXT_CACHE_MAX) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey !== undefined) {
			cache.delete(oldestKey);
		}
	}

	return wrappedText;
};

export const getWrapTextCacheSize = (): number => cache.size;

export default wrapText;
