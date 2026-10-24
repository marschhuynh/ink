import {stripVTControlCharacters} from 'node:util';
import wrapAnsi from 'wrap-ansi';
import cliTruncate from 'cli-truncate';
import {tokenizeAnsi} from './ansi-tokenizer.js';
import {type Styles} from './styles.js';
import {type TextContinuation} from './text-selection.js';

export const wrapTextCacheMax = 256;

/**
 * Remove the whitespace before the first visible character of a wrapped row
 * while preserving any ANSI styling wrap-ansi re-emitted at the row start.
 * Boundary whitespace may be split across styled spans (e.g. a space before
 * a color code and another after the re-emitted code), so scanning continues
 * across escape sequences and whitespace-only text tokens. Returns the
 * removed whitespace and the display text without it.
 */
const stripLeadingLayoutWhitespace = (
	row: string,
): {removed: string; text: string} => {
	let styledPrefix = '';
	let removed = '';
	let scanned = 0;

	for (const token of tokenizeAnsi(row)) {
		scanned += token.value.length;

		if (token.type !== 'text') {
			styledPrefix += token.value;
			continue;
		}

		const whitespace = /^\s*/u.exec(token.value)![0];
		removed += whitespace;

		if (whitespace.length < token.value.length) {
			return {
				removed,
				text:
					styledPrefix +
					token.value.slice(whitespace.length) +
					row.slice(scanned),
			};
		}
	}

	return {removed: '', text: row};
};

type WrappedText = {
	text: string;
	continuations: Array<TextContinuation | undefined>;
};
const cache = new Map<string, WrappedText>();

export const wrapTextWithContinuations = (
	text: string,
	maxWidth: number,
	wrapType: Styles['textWrap'],
	options?: {stripLeadingWhitespace?: boolean},
): WrappedText => {
	// Rendering strips leading boundary whitespace from continuation rows;
	// layout measurement must not, or the shrunken measured width would
	// re-wrap the source at a narrower width and clip trailing rows. Both
	// paths wrap identically, so row counts still match.
	const stripLeadingWhitespace = options?.stripLeadingWhitespace ?? true;
	const cacheKey = JSON.stringify([
		text,
		maxWidth,
		wrapType,
		stripLeadingWhitespace,
	]);
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

				if (!stripLeadingWhitespace) {
					return wrapped;
				}

				const rows = wrapped.split('\n');
				for (const [index] of rows.entries()) {
					if (index === 0) {
						continuations.push(undefined);
						continue;
					}

					// With trim:false wrap-ansi retains source spaces at wrap boundaries.
					// Row capture trims trailing whitespace, and continuation rows must
					// not render with leading whitespace, so `join` records exactly the
					// whitespace removed at the boundary: the previous row's trailing
					// portion plus this row's stripped leading portion.
					const trailing = /\s*$/u.exec(
						stripVTControlCharacters(rows[index - 1]!),
					)![0];
					const row = rows[index]!;

					if (stripVTControlCharacters(row).trim() === '') {
						// Whitespace-only rows have no visible content to shift: keep the
						// row and its boundary whitespace exactly as wrap-ansi produced
						// them, counting each source space once via the next row's join.
						continuations.push({join: trailing, start: 0});
						continue;
					}

					const {removed, text} = stripLeadingLayoutWhitespace(row);
					continuations.push({join: trailing + removed, start: 0});
					rows[index] = text;
				}

				return rows.join('\n');
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
): string =>
	wrapTextWithContinuations(text, maxWidth, wrapType, {
		stripLeadingWhitespace: false,
	}).text;

export default wrapText;
