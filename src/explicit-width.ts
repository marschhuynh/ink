import {Buffer} from 'node:buffer';
import stringWidth from 'string-width';
import {readTerminalControl} from './terminal-control.js';

const ascii = /^[\u0000-\u007F]*$/;
const terminalControl = /[\u0000-\u001F\u007F-\u009F]/;
const formatOnly = /^\p{Format}+$/u;
const noncharacter =
	/[\uFDD0-\uFDEF\uFFFE\uFFFF\u{1FFFE}\u{1FFFF}\u{2FFFE}\u{2FFFF}\u{3FFFE}\u{3FFFF}\u{4FFFE}\u{4FFFF}\u{5FFFE}\u{5FFFF}\u{6FFFE}\u{6FFFF}\u{7FFFE}\u{7FFFF}\u{8FFFE}\u{8FFFF}\u{9FFFE}\u{9FFFF}\u{AFFFE}\u{AFFFF}\u{BFFFE}\u{BFFFF}\u{CFFFE}\u{CFFFF}\u{DFFFE}\u{DFFFF}\u{EFFFE}\u{EFFFF}\u{FFFFE}\u{FFFFF}\u{10FFFE}\u{10FFFF}]/u;

const isWellFormed = (value: string): boolean =>
	(value as string & {isWellFormed: () => boolean}).isWellFormed();

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

			if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
				const control = readTerminalControl(row, index);
				if (control === undefined) {
					return undefined;
				}

				flushPrintable(index);
				pieces.push(control.raw);
				index = control.end;
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
