import {stripVTControlCharacters} from 'node:util';
import wrapAnsi from 'wrap-ansi';
import cliTruncate from 'cli-truncate';
import {type Styles} from './styles.js';
import {type TextContinuation} from './text-selection.js';

export const wrapTextCacheMax = 256;

type WrappedText = {
	text: string;
	continuations: Array<TextContinuation | undefined>;
};
const cache = new Map<string, WrappedText>();

export const wrapTextWithContinuations = (
	text: string,
	maxWidth: number,
	wrapType: Styles['textWrap'],
): WrappedText => {
	const cacheKey = JSON.stringify([text, maxWidth, wrapType]);
	const cachedText = cache.get(cacheKey);

	if (cachedText) {
		cache.delete(cacheKey);
		cache.set(cacheKey, cachedText);
		return cachedText;
	}

	let wrappedText = text;

	const continuations: Array<TextContinuation | undefined> = [];
	if (wrapType === 'wrap' || wrapType === 'hard') {
		// The wrapper processes each source line independently. Keep that boundary
		// rather than trying to infer hard breaks from rendered row widths.
		wrappedText = text
			.normalize()
			.replaceAll('\r\n', '\n')
			.split('\n')
			.map(line => {
				const wrapped = wrapAnsi(line, maxWidth, {
					trim: false,
					hard: true,
					wordWrap: wrapType !== 'hard',
				});
				const rows = wrapped.split('\n');
				for (const [index] of rows.entries()) {
					// With trim:false wrap-ansi retains source spaces. Row capture trims
					// their trailing portion, so restore exactly that portion on joining.
					continuations.push(
						index === 0
							? undefined
							: {
									join: /\s*$/u.exec(
										stripVTControlCharacters(rows[index - 1]!),
									)![0],
									start: 0,
								},
					);
				}

				return wrapped;
			})
			.join('\n');
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

	const result = {text: wrappedText, continuations};
	cache.set(cacheKey, result);
	if (cache.size > wrapTextCacheMax) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey !== undefined) {
			cache.delete(oldestKey);
		}
	}

	return result;
};

export const getWrapTextCacheSize = (): number => cache.size;

const wrapText = (
	text: string,
	maxWidth: number,
	wrapType: Styles['textWrap'],
): string => wrapTextWithContinuations(text, maxWidth, wrapType).text;

export default wrapText;
