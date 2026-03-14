import wrapAnsi from 'wrap-ansi';
import cliTruncate from 'cli-truncate';
import {type Styles} from './styles.js';

const cache: Record<string, string> = {};

const wrapText = (
	text: string,
	maxWidth: number,
	wrapType: Styles['textWrap'],
): string => {
	const cacheKey = text + String(maxWidth) + String(wrapType);
	const cachedText = cache[cacheKey];

	if (cachedText) {
		return cachedText;
	}

	let wrappedText = text;

	if (wrapType === 'wrap') {
		wrappedText = wrapAnsi(text, maxWidth, {
			trim: false,
			hard: true,
		});

		// wrap-ansi with trim:false can leave a single leading space on wrapped
		// lines when the break falls on a word boundary. Strip that artifact
		// while keeping intentional multi-space indentation intact.
		const lines = wrappedText.split('\n');
		for (let i = 1; i < lines.length; i++) {
			// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence handling
			const visible = lines[i]!.replace(/\u001b\[[^m]*m/g, '');
			if (visible.length > 0 && visible[0] === ' ' && (visible.length < 2 || visible[1] !== ' ')) {
				// Remove the first visible space, preserving any leading ANSI codes
				// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence handling
				lines[i] = lines[i]!.replace(/^((?:\u001b\[[^m]*m)*) /, '$1');
			}
		}
		wrappedText = lines.join('\n');
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

	cache[cacheKey] = wrappedText;

	return wrappedText;
};

export default wrapText;
