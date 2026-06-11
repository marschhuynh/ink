import {type StyledChar} from '@alcalzone/ansi-tokenize';
import {type TextSelectionSpan} from './text-selection.js';

// SGR inverse video. The end code lets styledCharsToString close the
// highlight cleanly between cells and at the end of each row.
const inverseCode = {
	type: 'ansi',
	code: '\u001B[7m',
	endCode: '\u001B[27m',
} as const;

/**
Paint the selection highlight onto the final output grid. Spans are already
in screen space (from `TextSelectionController.getPaintSpans`); only cells
whose selectability mask is true are painted, so chrome inside a span stays
unhighlighted. Wide glyphs are always painted whole: touching either cell of
a glyph includes the glyph cell and its placeholder cells.

Cells are replaced (not mutated) because identical lines share cached
StyledChar objects within a frame.
*/
export function paintSelection(
	grid: StyledChar[][],
	spans: TextSelectionSpan[],
	maskRows: boolean[][],
): void {
	for (const span of spans) {
		const row = grid[span.y];
		const maskRow = maskRows[span.y];

		if (!row || !maskRow || span.x2 <= span.x1) {
			continue;
		}

		const cells = new Set<number>();

		for (let x = Math.max(0, span.x1); x < Math.min(row.length, span.x2); x++) {
			if (maskRow[x] !== true) {
				continue;
			}

			// Expand over wide-character placeholders so a glyph is never
			// half-highlighted: walk left to the owning glyph cell, then right
			// across its placeholder cells.
			let start = x;
			while (start > 0 && row[start]?.value === '') {
				start--;
			}

			let end = x + 1;
			while (end < row.length && row[end]?.value === '') {
				end++;
			}

			for (let cell = start; cell < end; cell++) {
				cells.add(cell);
			}
		}

		for (const x of cells) {
			const cell = row[x];

			if (cell) {
				row[x] = {...cell, styles: [...cell.styles, inverseCode]};
			}
		}
	}
}
