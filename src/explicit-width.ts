import {Buffer} from 'node:buffer';
import stringWidth from 'string-width';

const ascii = /^[\u0000-\u007F]*$/;
const terminalControl = /[\u0000-\u001F\u007F-\u009F]/;
const formatOnly = /^\p{Format}+$/u;
const noncharacter =
	/[\uFDD0-\uFDEF\uFFFE\uFFFF\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]/u;

const isWellFormed = (value: string): boolean =>
	(value as string & {isWellFormed: () => boolean}).isWellFormed();

const consumeCsiBody = (text: string, start: number): number | undefined => {
	let index = start;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code < 0x30 || code > 0x3f) {
			break;
		}

		index++;
	}

	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code < 0x20 || code > 0x2f) {
			break;
		}

		index++;
	}

	if (index >= text.length) {
		return undefined;
	}

	const final = text.charCodeAt(index);
	if (final < 0x40 || final > 0x7e) {
		return undefined;
	}

	return index - start + 1;
};

const consumeString = (
	text: string,
	start: number,
	isOsc: boolean,
	c1Introducer: boolean,
): number | undefined => {
	let index = start + (c1Introducer ? 1 : 2);
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (isOsc && code === 0x07) {
			return index - start + 1;
		}

		if (code === 0x9c) {
			return index - start + 1;
		}

		if (
			code === 0x1b &&
			index + 1 < text.length &&
			text.charCodeAt(index + 1) === 0x5c
		) {
			return index - start + 2;
		}

		index++;
	}

	return undefined;
};

const consumeEsc = (text: string, start: number): number | undefined => {
	if (start + 1 >= text.length) {
		return undefined;
	}

	const next = text.charCodeAt(start + 1);
	if (next === 0x5b) {
		const body = consumeCsiBody(text, start + 2);
		return body === undefined ? undefined : 2 + body;
	}

	if (next === 0x5d) {
		return consumeString(text, start, true, false);
	}

	if (next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58) {
		return consumeString(text, start, false, false);
	}

	let index = start + 1;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code >= 0x20 && code <= 0x2f) {
			index++;
			continue;
		}

		if (code >= 0x30 && code <= 0x7e) {
			return index - start + 1;
		}

		return undefined;
	}

	return undefined;
};

const remember = (
	cache: Map<string, string>,
	key: string,
	value: string,
	maxEntries: number,
	maxBytes: number,
): void => {
	if (
		Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8') >
		maxBytes
	) {
		return;
	}

	if (!cache.has(key) && cache.size >= maxEntries) {
		const oldest = cache.keys().next();
		if (!oldest.done) {
			cache.delete(oldest.value);
		}
	}

	cache.set(key, value);
};

export function createExplicitWidthEncoder(): (text: string) => string {
	const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
	const rowCache = new Map<string, string>();
	const graphemeCache = new Map<string, string>();

	const encodeGrapheme = (grapheme: string): string => {
		if (ascii.test(grapheme)) {
			return grapheme;
		}

		const cached = graphemeCache.get(grapheme);
		if (cached !== undefined) {
			return cached;
		}

		let encoded = grapheme;
		if (
			isWellFormed(grapheme) &&
			!terminalControl.test(grapheme) &&
			!formatOnly.test(grapheme) &&
			!noncharacter.test(grapheme) &&
			Buffer.byteLength(grapheme, 'utf8') <= 4096
		) {
			const width = stringWidth(grapheme);
			if (Number.isInteger(width) && width >= 1 && width <= 7) {
				encoded = `\u001B]66;w=${width};${grapheme}\u001B\\`;
			}
		}

		remember(graphemeCache, grapheme, encoded, 1024, 8192);
		return encoded;
	};

	const encodePrintable = (text: string): string => {
		if (ascii.test(text)) {
			return text;
		}

		const pieces: string[] = [];
		for (const {segment} of segmenter.segment(text)) {
			pieces.push(encodeGrapheme(segment));
		}

		return pieces.join('');
	};

	const scanRow = (row: string): string | undefined => {
		const pieces: string[] = [];
		let index = 0;
		let printableStart = 0;

		const flushPrintable = (end: number): void => {
			if (end > printableStart) {
				pieces.push(encodePrintable(row.slice(printableStart, end)));
			}
		};

		while (index < row.length) {
			const code = row.charCodeAt(index);

			if (code === 0x1b) {
				const length = consumeEsc(row, index);
				if (length === undefined) {
					return undefined;
				}

				flushPrintable(index);
				pieces.push(row.slice(index, index + length));
				index += length;
				printableStart = index;
				continue;
			}

			if (code === 0x9b) {
				const body = consumeCsiBody(row, index + 1);
				if (body === undefined) {
					return undefined;
				}

				flushPrintable(index);
				pieces.push(row.slice(index, index + 1 + body));
				index += 1 + body;
				printableStart = index;
				continue;
			}

			if (
				code === 0x9d ||
				code === 0x90 ||
				code === 0x9f ||
				code === 0x9e ||
				code === 0x98
			) {
				const length = consumeString(row, index, code === 0x9d, true);
				if (length === undefined) {
					return undefined;
				}

				flushPrintable(index);
				pieces.push(row.slice(index, index + length));
				index += length;
				printableStart = index;
				continue;
			}

			if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
				flushPrintable(index);
				pieces.push(row[index]!);
				index++;
				printableStart = index;
				continue;
			}

			index++;
		}

		flushPrintable(row.length);
		return pieces.join('');
	};

	const encodeRow = (row: string): string | undefined => {
		const cached = rowCache.get(row);
		if (cached !== undefined) {
			return cached;
		}

		const encoded = scanRow(row);
		if (encoded === undefined) {
			return undefined;
		}

		remember(rowCache, row, encoded, 256, 16_384);
		return encoded;
	};

	return (text: string): string => {
		if (!text.includes('\n')) {
			const encoded = encodeRow(text);
			return encoded === undefined ? text : encoded;
		}

		const rows = text.split('\n');
		const encodedRows: string[] = [];
		for (const row of rows) {
			const encoded = encodeRow(row);
			if (encoded === undefined) {
				return text;
			}

			encodedRows.push(encoded);
		}

		return encodedRows.join('\n');
	};
}
