import stringWidth from 'string-width';

/**
A point in container content space: `x` is cells from the container's content
left edge, `y` is the content row index (survives scrolling).
*/
export type TextSelectionPoint = {x: number; y: number};

export type TextSelectionSpan = {y: number; x1: number; x2: number};

/**
A single cached row of rendered content. `mask` flags which display cells are
selectable (written by `<Text>` and not opted out); a missing mask means every
cell is selectable.
*/
export type SelectionRow = {text: string; mask?: readonly boolean[]};

export type RowLookup = (y: number) => SelectionRow | undefined;

export function normalizeSelection(
	anchor: TextSelectionPoint,
	focus: TextSelectionPoint,
): {start: TextSelectionPoint; end: TextSelectionPoint} {
	if (anchor.y < focus.y || (anchor.y === focus.y && anchor.x <= focus.x)) {
		return {start: anchor, end: focus};
	}

	return {start: focus, end: anchor};
}

const isCharSelectable = (
	mask: readonly boolean[] | undefined,
	charStart: number,
	charEnd: number,
): boolean => {
	if (!mask) {
		return true;
	}

	for (let cell = charStart; cell < charEnd; cell++) {
		if (mask[cell] === false) {
			return false;
		}
	}

	return true;
};

/**
One past the last printable selectable cell of the row. Trailing whitespace
and trailing chrome cells are excluded.
*/
export function getRowEnd(row: SelectionRow): number {
	const {text, mask} = row;
	let cell = 0;
	let end = 0;

	for (const char of text) {
		const width = Math.max(1, stringWidth(char));
		const charStart = cell;
		const charEnd = cell + width;
		cell = charEnd;

		if (/^\s*$/.test(char)) {
			continue;
		}

		if (isCharSelectable(mask, charStart, charEnd)) {
			end = charEnd;
		}
	}

	return end;
}

export function getSelectionSpans(
	anchor: TextSelectionPoint,
	focus: TextSelectionPoint,
	getRow: RowLookup,
): TextSelectionSpan[] {
	const {start, end} = normalizeSelection(anchor, focus);
	if (start.x === end.x && start.y === end.y) {
		return [];
	}

	const spans: TextSelectionSpan[] = [];

	for (let {y} = start; y <= end.y; y++) {
		const rowEnd = getRowEnd(getRow(y) ?? {text: ''});
		let x1 = y === start.y ? start.x : 0;
		let x2 = y === end.y ? end.x : rowEnd;

		x1 = Math.max(0, Math.min(x1, rowEnd));
		x2 = Math.max(0, Math.min(x2, rowEnd));

		// Emit empty spans (x1 === x2) so blank lines survive extraction.
		spans.push({y, x1, x2});
	}

	return spans;
}

/**
Extract the selectable text of `row` between display cells `[from, to)`.
Non-selectable runs at the edges are dropped; interior non-selectable runs
collapse to a single space. Wide glyphs are included when the range overlaps
either of their cells.
*/
export function sliceSelectableCells(
	row: SelectionRow,
	from: number,
	to: number,
): string {
	if (to <= from) {
		return '';
	}

	const {text, mask} = row;
	let cell = 0;
	let result = '';
	let pendingGap = false;

	for (const char of text) {
		const width = Math.max(1, stringWidth(char));
		const charStart = cell;
		const charEnd = cell + width;
		cell = charEnd;

		if (charEnd <= from) {
			continue;
		}

		if (charStart >= to) {
			break;
		}

		if (isCharSelectable(mask, charStart, charEnd)) {
			if (pendingGap && result.length > 0) {
				result += ' ';
			}

			pendingGap = false;
			result += char;
		} else if (result.length > 0) {
			pendingGap = true;
		}
	}

	return result;
}

export function extractTextFromRows(
	anchor: TextSelectionPoint,
	focus: TextSelectionPoint,
	getRow: RowLookup,
): string {
	return getSelectionSpans(anchor, focus, getRow)
		.map(span =>
			sliceSelectableCells(getRow(span.y) ?? {text: ''}, span.x1, span.x2),
		)
		.join('\n');
}
