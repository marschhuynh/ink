import test, {type ExecutionContext} from 'ava';
import stringWidth from 'string-width';
import Output from '../src/output.js';
import {
	createSeekPreparer,
	encodeSeekRow,
	prepareSeekRow,
} from '../src/allocated-seek.js';
import {
	Terminal,
	viewportLine,
	writeTerminal,
} from './helpers/terminal-model.js';

const csi = '\u001B[';
const closeLink = '\u001B]8;;\u001B\\';
const reset = `${closeLink}${csi}0m`;
const segmenter = new Intl.Segmenter(undefined, {granularity: 'grapheme'});

type TestTerminal = InstanceType<typeof Terminal>;

const isAscii = (text: string): boolean => {
	for (const character of text) {
		if ((character.codePointAt(0) ?? 0) > 0x7f) {
			return false;
		}
	}

	return true;
};

const createTerminal = (
	t: ExecutionContext,
	columns: number,
	rows: number,
): TestTerminal => {
	t.true(columns > 0);
	t.true(rows > 0);
	const terminal = new Terminal({
		cols: columns,
		rows,
		allowProposedApi: true,
	});
	t.teardown(() => {
		terminal.dispose();
	});
	return terminal;
};

const cellAt = (terminal: TestTerminal, row: number, column: number) =>
	terminal.buffer.active
		.getLine(terminal.buffer.active.baseY + row)!
		.getCell(column)!;

const charsAt = (terminal: TestTerminal, row: number, column: number) =>
	cellAt(terminal, row, column).getChars();

const chaColumns = (encoded: string): number[] => {
	const found: number[] = [];
	let index = 0;
	while (index < encoded.length) {
		const start = encoded.indexOf(csi, index);
		if (start === -1) {
			break;
		}

		const digitsStart = start + csi.length;
		let digitsEnd = digitsStart;
		while (digitsEnd < encoded.length) {
			const code = encoded.codePointAt(digitsEnd) ?? 0;
			if (code < 48 || code > 57) {
				break;
			}

			digitsEnd++;
		}

		if (digitsEnd > digitsStart && encoded[digitsEnd] === 'G') {
			found.push(Number(encoded.slice(digitsStart, digitsEnd)));
			index = digitsEnd + 1;
			continue;
		}

		index = digitsStart;
	}

	return found;
};

const assertInBounds = (
	t: ExecutionContext,
	encoded: string,
	row: number,
	rows: number,
	columns: number,
) => {
	t.true(row >= 0);
	t.true(row < rows);
	t.true(columns > 0);
	t.true(encoded.startsWith(`${csi}${row + 1};1H`));
	for (const column of chaColumns(encoded)) {
		t.true(column >= 1);
		t.true(column <= columns);
	}
};

const assertNoScroll = (
	t: ExecutionContext,
	terminal: TestTerminal,
	rows: number,
) => {
	t.is(terminal.buffer.active.baseY, 0);
	t.is(terminal.buffer.active.length, rows);
};

const captureGrid = (text: string, width: number, height = 1) => {
	const output = new Output({width, height});
	output.write(0, 0, text, {transformers: [], selectable: true});
	let grid: Array<Array<{value: string}>> = [];
	const result = output.get({
		capturePlainRows: true,
		paint(nextGrid) {
			grid = nextGrid;
		},
	});
	return {output: result.output, grid, plainRows: result.plainRows ?? []};
};

// Pre-correction encoder: measured string-width, including 0. Same seek loop
// without Math.max(1, ...) allocation.
const encodeMeasuredWidthRow = (
	row: string,
	rowIndex: number,
	columns: number,
): string => {
	let output = `${csi}${rowIndex + 1};1H${reset}${csi}2K`;
	let column = 1;
	for (const {segment} of segmenter.segment(row)) {
		const width = stringWidth(segment);
		if (isAscii(segment)) {
			output += segment;
		} else {
			output += ' '.repeat(width) + `${csi}${column}G` + segment;
			if (column + width <= columns) {
				output += `${csi}${column + width}G`;
			}
		}

		column += width;
	}

	output += reset;
	if (column <= columns) {
		output += `${csi}${column}G${csi}K`;
	}

	return output;
};

const paintPrepared = async (
	t: ExecutionContext,
	text: string,
	row: number,
	columns: number,
	rows: number,
	terminal?: TestTerminal,
) => {
	const target = terminal ?? createTerminal(t, columns, rows);
	const prepared = prepareSeekRow(text, columns);
	const encoded = encodeSeekRow(prepared, row, columns);
	assertInBounds(t, encoded, row, rows, columns);
	await writeTerminal(target, encoded);
	assertNoScroll(t, target, rows);
	return {terminal: target, prepared, encoded};
};

const assertZeroWidthSample = async (
	t: ExecutionContext,
	text: string,
	column: number,
) => {
	const columns = 8;
	const rows = 3;
	const captured = captureGrid(text, columns);
	t.is(captured.plainRows[0], text);
	t.is(captured.grid[0]![column]!.value, 'X');

	const naive = createTerminal(t, columns, rows);
	await writeTerminal(
		naive,
		encodeMeasuredWidthRow(captured.output, 0, columns),
	);
	if (text === 'A\u200BX') {
		t.is(charsAt(naive, 0, 1), 'X');
		t.not(charsAt(naive, 0, 2), 'X');
	} else {
		t.not(charsAt(naive, 0, 1), 'X');
	}

	const {terminal, encoded} = await paintPrepared(
		t,
		captured.output,
		0,
		columns,
		rows,
	);
	t.is(charsAt(terminal, 0, column), 'X');
	t.true(encoded.includes('X'));
	t.is(viewportLine(terminal, 1).trim(), '');
};

test('terminal helper constructs an xterm and reads viewport cells', async t => {
	const terminal = createTerminal(t, 8, 3);
	await writeTerminal(terminal, 'Hi');
	t.true(viewportLine(terminal, 0).startsWith('Hi'));
	t.is(typeof Terminal, 'function');
});

test('AB to ⚡ prefills a blank with the intended background, not stale B', async t => {
	const columns = 8;
	const rows = 4;
	const disagreement = createTerminal(t, columns, rows);
	await writeTerminal(disagreement, '⚡');
	const emulatorWidth = cellAt(disagreement, 0, 0).getWidth();
	const prepared = prepareSeekRow('⚡', columns);
	t.is(emulatorWidth, 1);
	t.is(prepared.allocatedWidth, 2);
	t.not(emulatorWidth, prepared.allocatedWidth);

	const terminal = createTerminal(t, columns, rows);
	await writeTerminal(terminal, 'AB');
	t.is(charsAt(terminal, 0, 0), 'A');
	t.is(charsAt(terminal, 0, 1), 'B');
	const encoded = encodeSeekRow(
		prepareSeekRow('\u001B[41m⚡', columns),
		0,
		columns,
	);
	assertInBounds(t, encoded, 0, rows, columns);
	await writeTerminal(terminal, encoded);
	assertNoScroll(t, terminal, rows);
	t.is(charsAt(terminal, 0, 0), '⚡');
	t.is(charsAt(terminal, 0, 1), ' ');
	t.not(charsAt(terminal, 0, 1), 'B');
	t.true(cellAt(terminal, 0, 1).isBgPalette());
	t.is(cellAt(terminal, 0, 1).getBgColor(), 1);
	t.true(cellAt(terminal, 0, 0).isBgPalette());
	t.is(cellAt(terminal, 0, 0).getBgColor(), 1);
	t.true(cellAt(terminal, 0, 2).isBgDefault());
	t.true(encoded.includes('\u001B[41m'));
});

test('oversized 👩‍👩⚡X keeps X on its allocated column', async t => {
	const columns = 8;
	const rows = 3;
	const {terminal, encoded, prepared} = await paintPrepared(
		t,
		'👩‍👩⚡X',
		0,
		columns,
		rows,
	);
	t.is(prepared.allocatedWidth, 5);
	t.is(charsAt(terminal, 0, 4), 'X');
	t.is(charsAt(terminal, 0, 2), '⚡');
	t.is(charsAt(terminal, 0, 3), ' ');
	t.not(charsAt(terminal, 0, 3), 'X');
	t.true(encoded.includes('👩‍👩'));
	t.true(encoded.includes('⚡'));
	t.true(encoded.includes('X'));
});

test('an exact-width ASCII row does not emit CHA N+1 or trailing EL', async t => {
	const columns = 8;
	const rows = 3;
	const {terminal, encoded} = await paintPrepared(
		t,
		'12345678',
		0,
		columns,
		rows,
	);
	t.is(viewportLine(terminal, 0), '12345678');
	t.false(encoded.includes(`${csi}9G`));
	t.false(encoded.includes(`${csi}K`));
	t.is(charsAt(terminal, 0, 7), '8');
});

test('123456界 paints the bottom row of an 8-column viewport without scrolling', async t => {
	const columns = 8;
	const rows = 8;
	const {terminal, encoded} = await paintPrepared(
		t,
		'123456界',
		rows - 1,
		columns,
		rows,
	);
	t.is(viewportLine(terminal, rows - 1), '123456界');
	t.is(cellAt(terminal, rows - 1, 6).getChars(), '界');
	t.is(cellAt(terminal, rows - 1, 6).getWidth(), 2);
	t.false(encoded.includes(`${csi}9G`));
	t.false(encoded.includes(`${csi}K`));
	t.is(viewportLine(terminal, 0).trim(), '');
});

test('changed middle-row paint leaves sentinel rows above and below untouched', async t => {
	const columns = 8;
	const rows = 3;
	const terminal = createTerminal(t, columns, rows);
	await writeTerminal(
		terminal,
		encodeSeekRow(prepareSeekRow('ABOVE___', columns), 0, columns),
	);
	await writeTerminal(
		terminal,
		encodeSeekRow(prepareSeekRow('MIDDLE__', columns), 1, columns),
	);
	await writeTerminal(
		terminal,
		encodeSeekRow(prepareSeekRow('BELOW___', columns), 2, columns),
	);
	t.is(viewportLine(terminal, 0), 'ABOVE___');
	t.is(viewportLine(terminal, 2), 'BELOW___');
	const encoded = encodeSeekRow(
		prepareSeekRow('\u001B[42m⚡XXXXX', columns),
		1,
		columns,
	);
	assertInBounds(t, encoded, 1, rows, columns);
	await writeTerminal(terminal, encoded);
	assertNoScroll(t, terminal, rows);
	t.is(viewportLine(terminal, 0), 'ABOVE___');
	t.is(viewportLine(terminal, 2), 'BELOW___');
	t.is(charsAt(terminal, 1, 0), '⚡');
	t.is(charsAt(terminal, 1, 1), ' ');
	t.is(charsAt(terminal, 1, 2), 'X');
	t.true(cellAt(terminal, 1, 1).isBgPalette());
	t.is(cellAt(terminal, 1, 1).getBgColor(), 2);
});

test('width-zero loop erases or shifts X before corrected allocation keeps it', async t => {
	await assertZeroWidthSample(t, '\u0301X', 1);
	await assertZeroWidthSample(t, '\uFE0FX', 1);
	await assertZeroWidthSample(t, '\u200BX', 1);
	await assertZeroWidthSample(t, 'A\u200BX', 2);
});

test('clipping drops a crossing grapheme and leaves neighbors blank', async t => {
	const columns = 8;
	const rows = 2;
	const {terminal, encoded, prepared} = await paintPrepared(
		t,
		'1234567界',
		0,
		columns,
		rows,
	);
	t.is(prepared.allocatedWidth, 7);
	t.is(viewportLine(terminal, 0).startsWith('1234567'), true);
	t.not(charsAt(terminal, 0, 6), '界');
	t.false(encoded.includes('界'));
	t.is(charsAt(terminal, 0, 7), '');
	t.true(cellAt(terminal, 0, 7).isBgDefault());
});

test('attached e\u0301 stays one cell with an intact payload', async t => {
	const columns = 8;
	const rows = 2;
	const {terminal, encoded, prepared} = await paintPrepared(
		t,
		'e\u0301',
		0,
		columns,
		rows,
	);
	t.is(prepared.allocatedWidth, 1);
	t.is(charsAt(terminal, 0, 0), 'e\u0301');
	t.is(cellAt(terminal, 0, 0).getWidth(), 1);
	t.not(charsAt(terminal, 0, 1), '\u0301');
	t.true(encoded.includes('e\u0301'));
	t.false(encoded.includes(`${csi}0G`));
});

test('styles, hyperlinks, and inherited entry SGR survive encoding', async t => {
	const columns = 8;
	const rows = 3;
	const open = '\u001B]8;id=seek;https://example.test\u001B\\';
	const close = '\u001B]8;;\u001B\\';
	const linked = await paintPrepared(
		t,
		`${open}\u001B[1;44mXY${close}`,
		0,
		columns,
		rows,
	);
	t.is(charsAt(linked.terminal, 0, 0), 'X');
	t.is(charsAt(linked.terminal, 0, 1), 'Y');
	t.true(cellAt(linked.terminal, 0, 0).isBgPalette());
	t.is(cellAt(linked.terminal, 0, 0).getBgColor(), 4);
	t.not(cellAt(linked.terminal, 0, 0).isBold(), 0);
	t.true(linked.encoded.includes(open));
	t.true(linked.encoded.includes(close));
	t.true(linked.encoded.includes('\u001B[1;44m'));

	const inherited = createSeekPreparer().prepareFrame(
		'\u001B[41mhello\n⚡',
		columns,
	);
	const terminal = createTerminal(t, columns, rows);
	await writeTerminal(terminal, encodeSeekRow(inherited[0]!, 0, columns));
	const encoded = encodeSeekRow(inherited[1]!, 1, columns);
	assertInBounds(t, encoded, 1, rows, columns);
	await writeTerminal(terminal, encoded);
	assertNoScroll(t, terminal, rows);
	t.true(encoded.includes('\u001B[41m'));
	t.is(charsAt(terminal, 1, 0), '⚡');
	t.is(charsAt(terminal, 1, 1), ' ');
	t.true(cellAt(terminal, 1, 0).isBgPalette());
	t.is(cellAt(terminal, 1, 0).getBgColor(), 1);
	t.true(cellAt(terminal, 1, 1).isBgPalette());
	t.is(cellAt(terminal, 1, 1).getBgColor(), 1);
	t.is(charsAt(terminal, 0, 0), 'h');
});
