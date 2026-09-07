import stringWidth from 'string-width';
import {readTerminalControl} from './terminal-control.js';

export type SeekPart =
	| {kind: 'control'; raw: string}
	// width is allocated cells, not measured width. Each non-ASCII part is
	// one complete grapheme with width >= 1; ASCII runs may be coalesced.
	| {kind: 'text'; text: string; width: number; ascii: boolean};

export type PreparedSeekRow = {
	logical: string;
	parts: readonly SeekPart[];
	allocatedWidth: number;
	// Entry SGR/link plus logical source; used for incremental comparison.
	identity: string;
};

export type SeekPreparer = {
	prepareFrame(text: string, columns: number): readonly PreparedSeekRow[];
};

type ControlItem = {
	kind: 'control';
	raw: string;
	sgr: boolean;
	start: number;
};

type TextToken = {
	kind: 'text';
	text: string;
	start: number;
};

type GraphemeItem = {
	kind: 'grapheme';
	text: string;
	width: number;
	ascii: boolean;
	start: number;
};

type RowItem = ControlItem | GraphemeItem;

type ParsedRow = {
	logical: string;
	items: readonly RowItem[];
};

const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});
const sgrBody = /^[\d:;]*m$/;
const csi = '\u001B[';
const closeLink = '\u001B]8;;\u001B\\';
const reset = `${closeLink}${csi}0m`;

const isWellFormed = (value: string): boolean =>
	(value as string & {isWellFormed: () => boolean}).isWellFormed();

const isControlIntroducer = (code: number): boolean =>
	code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);

const isAscii = (text: string): boolean => {
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) > 0x7f) {
			return false;
		}
	}

	return true;
};

const fail = (message: string): never => {
	throw new Error(message);
};

const isSgr = (raw: string): boolean => {
	const start = raw.charCodeAt(0) === 0x9b ? 1 : 2;
	return sgrBody.test(raw.slice(start));
};

const oscPayload = (raw: string): string => {
	const start = raw.charCodeAt(0) === 0x9d ? 1 : 2;
	if (raw.endsWith('\u001B\\')) {
		return raw.slice(start, -2);
	}

	return raw.slice(start, -1);
};

const isOsc8 = (raw: string): boolean => oscPayload(raw).startsWith('8;');

const isLinkClose = (raw: string): boolean => {
	const rest = oscPayload(raw).slice(2);
	const separator = rest.lastIndexOf(';');
	if (separator === -1) {
		return true;
	}

	return rest.slice(separator + 1).length === 0;
};

const sgrParams = (raw: string): string[] => {
	const start = raw.charCodeAt(0) === 0x9b ? 1 : 2;
	const body = raw.slice(start, -1);
	return body.length === 0 ? [] : body.split(/[;:]/);
};

const isResetParam = (part: string): boolean =>
	part === '0' || /^0+$/.test(part);

const isOnlyReset = (raw: string): boolean => {
	const params = sgrParams(raw);
	return (
		params.length === 0 ||
		params.every(part => part === '' || isResetParam(part))
	);
};

const identityOf = (sgr: string, link: string, logical: string): string =>
	JSON.stringify([sgr, link, logical]);

const tokenize = (row: string): Array<ControlItem | TextToken> => {
	if (!isWellFormed(row)) {
		fail('Malformed UTF-16 in seek row');
	}

	const tokens: Array<ControlItem | TextToken> = [];
	let index = 0;
	while (index < row.length) {
		const code = row.charCodeAt(index);
		if (isControlIntroducer(code)) {
			const control = readTerminalControl(row, index);
			if (control === undefined) {
				throw new Error('Malformed terminal control in seek row');
			}

			const allowedSgr = control.kind === 'csi' && isSgr(control.raw);

			const allowedLink = control.kind === 'osc' && isOsc8(control.raw);
			if (!allowedSgr && !allowedLink) {
				fail('Unsupported terminal control in seek row');
			}

			tokens.push({
				kind: 'control',
				raw: control.raw,
				sgr: allowedSgr,
				start: index,
			});
			index = control.end;
			continue;
		}

		const start = index;
		index++;
		while (index < row.length && !isControlIntroducer(row.charCodeAt(index))) {
			index++;
		}

		tokens.push({kind: 'text', text: row.slice(start, index), start});
	}

	return tokens;
};

const parseRow = (row: string): ParsedRow => {
	const tokens = tokenize(row);
	let controlFree = '';
	const controlFreeToSource: number[] = [];
	for (const token of tokens) {
		if (token.kind !== 'text') {
			continue;
		}

		for (let offset = 0; offset < token.text.length; offset++) {
			controlFreeToSource.push(token.start + offset);
		}

		controlFree += token.text;
	}

	const graphemes: GraphemeItem[] = [];
	for (const {segment, index} of segmenter.segment(controlFree)) {
		if (segment.length === 0) {
			continue;
		}

		const sourceStart = controlFreeToSource[index]!;
		const sourceEnd = controlFreeToSource[index + segment.length - 1]! + 1;
		if (sourceEnd - sourceStart !== segment.length) {
			fail('Control boundary inside a grapheme in seek row');
		}

		graphemes.push({
			kind: 'grapheme',
			text: segment,
			width: Math.max(1, stringWidth(segment)),
			ascii: isAscii(segment),
			start: sourceStart,
		});
	}

	const items: RowItem[] = [];
	let graphemeIndex = 0;
	for (const token of tokens) {
		if (token.kind === 'control') {
			items.push(token);
			continue;
		}

		const tokenEnd = token.start + token.text.length;
		while (
			graphemeIndex < graphemes.length &&
			graphemes[graphemeIndex]!.start < tokenEnd
		) {
			items.push(graphemes[graphemeIndex]!);
			graphemeIndex++;
		}
	}

	return {logical: row, items};
};

const clipParts = (
	items: readonly RowItem[],
	columns: number,
	entrySgr: string,
	entryLink: string,
): {parts: SeekPart[]; allocatedWidth: number} => {
	const parts: SeekPart[] = [];
	if (entrySgr.length > 0) {
		parts.push({kind: 'control', raw: entrySgr});
	}

	if (entryLink.length > 0) {
		parts.push({kind: 'control', raw: entryLink});
	}

	let allocatedWidth = 0;
	let asciiText = '';
	let asciiWidth = 0;
	let clipped = false;

	const flushAscii = () => {
		if (asciiText.length === 0) {
			return;
		}

		parts.push({kind: 'text', text: asciiText, width: asciiWidth, ascii: true});
		asciiText = '';
		asciiWidth = 0;
	};

	for (const item of items) {
		if (item.kind === 'control') {
			if (!clipped) {
				flushAscii();
				parts.push({kind: 'control', raw: item.raw});
			}

			continue;
		}

		if (clipped) {
			continue;
		}

		if (allocatedWidth + item.width > columns) {
			clipped = true;
			continue;
		}

		allocatedWidth += item.width;
		if (item.ascii) {
			asciiText += item.text;
			asciiWidth += item.width;
		} else {
			flushAscii();
			parts.push({
				kind: 'text',
				text: item.text,
				width: item.width,
				ascii: false,
			});
		}
	}

	flushAscii();
	return {parts, allocatedWidth};
};

const applyRendition = (
	items: readonly RowItem[],
	entrySgr: string,
	entryLink: string,
): {sgr: string; link: string} => {
	let sgr = entrySgr;
	let link = entryLink;
	for (const item of items) {
		if (item.kind !== 'control') {
			continue;
		}

		if (item.sgr) {
			if (isOnlyReset(item.raw)) {
				sgr = '';
			} else {
				sgr += item.raw;
			}
		} else if (isLinkClose(item.raw)) {
			link = '';
		} else {
			link = item.raw;
		}
	}

	return {sgr, link};
};

const materialize = (
	parsed: ParsedRow,
	columns: number,
	entrySgr: string,
	entryLink: string,
): PreparedSeekRow => {
	const {parts, allocatedWidth} = clipParts(
		parsed.items,
		columns,
		entrySgr,
		entryLink,
	);
	return {
		logical: parsed.logical,
		parts,
		allocatedWidth,
		identity: identityOf(entrySgr, entryLink, parsed.logical),
	};
};

export function prepareSeekRow(row: string, columns: number): PreparedSeekRow {
	return materialize(parseRow(row), columns, '', '');
}

export function createSeekPreparer(): SeekPreparer {
	let cache = new Map<string, ParsedRow>();
	return {
		prepareFrame(text: string, columns: number) {
			const rows = text.split('\n');
			const nextCache = new Map<string, ParsedRow>();
			const prepared: PreparedSeekRow[] = [];
			let sgr = '';
			let link = '';
			for (const row of rows) {
				let parsed = nextCache.get(row) ?? cache.get(row);
				if (parsed === undefined) {
					parsed = parseRow(row);
				}

				nextCache.set(row, parsed);
				prepared.push(materialize(parsed, columns, sgr, link));
				({sgr, link} = applyRendition(parsed.items, sgr, link));
			}

			cache = nextCache;
			return prepared;
		},
	};
}

export function encodeSeekRow(
	prepared: PreparedSeekRow,
	row: number,
	columns: number,
): string {
	let output = `${csi}${row + 1};1H${reset}${csi}2K`;
	let column = 1;
	for (const part of prepared.parts) {
		if (part.kind === 'control') {
			output += part.raw;
			continue;
		}

		if (part.ascii) {
			output += part.text;
		} else {
			output += ' '.repeat(part.width) + `${csi}${column}G` + part.text;
			if (column + part.width <= columns) {
				output += `${csi}${column + part.width}G`;
			}
		}

		column += part.width;
	}

	output += reset;
	if (column <= columns) {
		output += `${csi}${column}G${csi}K`;
	}

	return output;
}
