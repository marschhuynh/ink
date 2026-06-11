import test from 'ava';
import {
	normalizeSelection,
	getSelectionSpans,
	extractTextFromRows,
	sliceSelectableCells,
} from '../src/text-selection.js';

const maskOf = (pattern: string) => [...pattern].map(c => c === '#');

const rowsOf =
	(rows: Array<string | {text: string; mask?: boolean[]}>) => (y: number) => {
		const row = rows[y];
		return typeof row === 'string' ? {text: row} : row;
	};

test('normalizes forward and backward selections', t => {
	t.deepEqual(normalizeSelection({x: 8, y: 3}, {x: 2, y: 1}), {
		start: {x: 2, y: 1},
		end: {x: 8, y: 3},
	});
});

test('single-row selection is exclusive at focus', t => {
	t.deepEqual(
		getSelectionSpans({x: 1, y: 0}, {x: 4, y: 0}, rowsOf(['abcdef'])),
		[{y: 0, x1: 1, x2: 4}],
	);
});

test('multi-row selection follows terminal text flow', t => {
	t.deepEqual(
		getSelectionSpans(
			{x: 2, y: 0},
			{x: 3, y: 2},
			rowsOf(['hello', 'world', 'again']),
		),
		[
			{y: 0, x1: 2, x2: 5},
			{y: 1, x1: 0, x2: 5},
			{y: 2, x1: 0, x2: 3},
		],
	);
});

test('extracts selected plain text from rows', t => {
	t.is(
		extractTextFromRows(
			{x: 2, y: 0},
			{x: 3, y: 2},
			rowsOf(['hello', 'world', 'again']),
		),
		'llo\nworld\naga',
	);
});

test('blank middle rows are preserved as empty lines', t => {
	t.deepEqual(
		getSelectionSpans(
			{x: 0, y: 0},
			{x: 3, y: 2},
			rowsOf(['hello', '', 'world']),
		),
		[
			{y: 0, x1: 0, x2: 5},
			{y: 1, x1: 0, x2: 0},
			{y: 2, x1: 0, x2: 3},
		],
	);
	t.is(
		extractTextFromRows(
			{x: 0, y: 0},
			{x: 3, y: 2},
			rowsOf(['hello', '', 'world']),
		),
		'hello\n\nwor',
	);
});

test('rows missing from the cache become empty lines', t => {
	t.is(
		extractTextFromRows({x: 0, y: 0}, {x: 2, y: 2}, rowsOf(['top'])),
		'top\n\n',
	);
});

test('click without drag is empty', t => {
	t.deepEqual(
		getSelectionSpans({x: 2, y: 0}, {x: 2, y: 0}, rowsOf(['abc'])),
		[],
	);
	t.is(extractTextFromRows({x: 2, y: 0}, {x: 2, y: 0}, rowsOf(['abc'])), '');
});

test('chrome prefix is dropped from extraction', t => {
	// "1│  import x;" with the gutter "1│  " masked as chrome
	const row = {text: '1│  import x;', mask: maskOf('----#########')};
	t.is(
		extractTextFromRows({x: 0, y: 0}, {x: 13, y: 0}, rowsOf([row])),
		'import x;',
	);
});

test('interior chrome gap collapses to a single space', t => {
	// Two text columns separated by 3 cells of padding
	const row = {text: 'name   value', mask: maskOf('####---#####')};
	t.is(
		extractTextFromRows({x: 0, y: 0}, {x: 12, y: 0}, rowsOf([row])),
		'name value',
	);
});

test('whitespace inside Text content is preserved', t => {
	// Code indentation is part of the Text write, hence selectable
	const row = {text: '+   return x;', mask: maskOf('-############')};
	t.is(
		extractTextFromRows({x: 0, y: 0}, {x: 13, y: 0}, rowsOf([row])),
		'   return x;',
	);
});

test('rowEnd ignores trailing chrome cells', t => {
	// Selecting a middle row extends only to the last selectable cell
	const rows = rowsOf([
		{text: 'aaaa', mask: maskOf('####')},
		{text: 'bb ▐', mask: maskOf('##--')}, // Trailing scrollbar-ish chrome
		{text: 'cccc', mask: maskOf('####')},
	]);
	t.deepEqual(getSelectionSpans({x: 0, y: 0}, {x: 2, y: 2}, rows)[1], {
		y: 1,
		x1: 0,
		x2: 2,
	});
});

test('sliceSelectableCells respects wide characters', t => {
	// '中' is 2 cells wide; selecting either half includes the glyph
	t.is(sliceSelectableCells({text: 'a中b'}, 1, 2), '中');
	t.is(sliceSelectableCells({text: 'a中b'}, 2, 3), '中');
	t.is(sliceSelectableCells({text: 'a中b'}, 0, 1), 'a');
});
