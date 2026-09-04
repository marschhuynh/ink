import {Buffer} from 'node:buffer';
import process from 'node:process';
import test, {type ExecutionContext} from 'ava';
import logUpdate from '../src/log-update.js';
import createStdout from './helpers/create-stdout.js';

const csi = '\u001B[';
const csiDeleteLines = new RegExp(`${String.fromCodePoint(0x1b)}\\[\\d*M`);
const csiInsertLines = new RegExp(`${String.fromCodePoint(0x1b)}\\[\\d*L`);
const csiScrollRegion = new RegExp(
	`${String.fromCodePoint(0x1b)}\\[\\d+;\\d+r`,
	'g',
);
const cursorVisibility = new RegExp(
	`${String.fromCodePoint(0x1b)}\\[\\?25[hl]`,
	'g',
);

const secondWrite = (stdout: ReturnType<typeof createStdout>): string =>
	stdout.get();

const blankTerminalRows = (count: number): string[] =>
	Array.from({length: count}, () => '');

type TerminalSnapshot = {
	rows: string[];
	cursorRow: number;
	cursorColumn: number;
	scrollTop: number;
	scrollBottom: number;
	command: string;
};

type TerminalResult = {
	rows: string[];
	cursorRow: number;
	cursorColumn: number;
	scrollTop: number;
	scrollBottom: number;
	snapshots: TerminalSnapshot[];
};

const applyTerminalWrite = (
	initialRows: string[],
	initialCursorRow: number,
	write: string,
): TerminalResult => {
	const rows = [...initialRows];
	let row = initialCursorRow;
	let column = 0;
	let scrollTop = 0;
	let scrollBottom = initialRows.length - 1;
	const snapshots: TerminalSnapshot[] = [];
	const snapshot = (command: string) => {
		snapshots.push({
			rows: [...rows],
			cursorRow: row,
			cursorColumn: column,
			scrollTop,
			scrollBottom,
			command,
		});
	};

	for (let index = 0; index < write.length;) {
		if (write[index] === '\u001B' && write[index + 1] === '[') {
			let commandIndex = index + 2;
			while (commandIndex < write.length) {
				const code = write.codePointAt(commandIndex);
				if (code !== undefined && code >= 0x40 && code <= 0x7e) break;
				commandIndex++;
			}

			if (commandIndex >= write.length) {
				throw new Error(`Unterminated CSI at ${index}`);
			}

			const parameterBytes = write.slice(index + 2, commandIndex);
			const privatePrefix = /^[<=>?]/.exec(parameterBytes)?.[0];
			const numericBytes = privatePrefix
				? parameterBytes.slice(1)
				: parameterBytes;
			const parameters = numericBytes
				.split(';')
				.map(value => (value === '' ? undefined : Number(value)));
			const count = parameters[0] ?? 1;
			const command = write[commandIndex]!;
			const sequence = write.slice(index, commandIndex + 1);

			switch (command) {
				case 'A': {
					row -= count;
					break;
				}

				case 'E': {
					row += count;
					column = 0;
					break;
				}

				case 'G': {
					column = count - 1;
					break;
				}

				case 'H': {
					row = (parameters[0] ?? 1) - 1;
					column = (parameters[1] ?? 1) - 1;
					break;
				}

				case 'K': {
					rows[row] = rows[row]!.slice(0, column);
					break;
				}

				case 'L': {
					if (row >= scrollTop && row <= scrollBottom) {
						rows.splice(row, 0, ...blankTerminalRows(count));
						rows.splice(scrollBottom + 1, count);
					}

					break;
				}

				case 'M': {
					if (row >= scrollTop && row <= scrollBottom) {
						rows.splice(row, count);
						rows.splice(
							scrollBottom - count + 1,
							0,
							...blankTerminalRows(count),
						);
					}

					break;
				}

				case 'r': {
					scrollTop = (parameters[0] ?? 1) - 1;
					scrollBottom = (parameters[1] ?? initialRows.length) - 1;
					row = 0;
					column = 0;
					break;
				}

				default: {
					throw new Error(
						`Unsupported terminal sequence at ${index}: ${sequence}`,
					);
				}
			}

			snapshot(sequence);
			index = commandIndex + 1;
			continue;
		}

		if (write[index] === '\n') {
			row++;
			column = 0;
			snapshot('\\n');
			index++;
			continue;
		}

		const textStart = index;
		while (
			index < write.length &&
			write[index] !== '\u001B' &&
			write[index] !== '\n'
		) {
			const cells = [...rows[row]!];
			cells[column++] = write[index]!;
			rows[row] = cells.join('');
			index++;
		}

		snapshot(write.slice(textStart, index));
	}

	return {
		rows,
		cursorRow: row,
		cursorColumn: column,
		scrollTop,
		scrollBottom,
		snapshots,
	};
};

const applyTerminalSequences = (
	initialRows: string[],
	write: string,
): TerminalResult => applyTerminalWrite(initialRows, 0, write);

test('terminal model parses and resets DECSTBM margins', t => {
	const result = applyTerminalSequences(
		Array.from({length: 11}, () => ''),
		'\u001B[2;9r\u001B[2;1H\u001B[r',
	);
	const setMargin = result.snapshots[0]!;
	const cursor = result.snapshots[1]!;

	t.is(setMargin.scrollTop, 1);
	t.is(setMargin.scrollBottom, 8);
	t.is(cursor.cursorRow, 1);
	t.is(cursor.cursorColumn, 0);
	t.is(result.scrollTop, 0);
	t.is(result.scrollBottom, 10);
	t.is(result.cursorRow, 0);
	t.is(result.cursorColumn, 0);
});

const assertBoundedFooterShift = (
	t: ExecutionContext,
	direction: 'up' | 'down',
	previous: string[],
	nextFrame: string[],
): void => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});
	render(previous.join('\n'));
	render(nextFrame.join('\n'));

	const write = secondWrite(stdout);
	const operation =
		direction === 'up'
			? '\u001B[2;9r\u001B[2;1H\u001B[1M\u001B[r\u001B[2;1H'
			: '\u001B[2;9r\u001B[2;1H\u001B[1L\u001B[r\u001B[2;1H';
	t.true(write.includes(operation));
	t.is(write.split('\u001B[2;9r').length - 1, 1);
	t.is(write.split('\u001B[r').length - 1, 1);
	t.false(write.includes('COMPOSER STATUS'));
	t.false(write.includes('COMPOSER INPUT'));
	t.false(write.includes(direction === 'up' ? 'b4' : 'b5'));

	const result = applyTerminalWrite(previous, previous.length - 1, write);
	for (const snapshot of result.snapshots) {
		t.deepEqual(snapshot.rows.slice(9, 11), previous.slice(9, 11));
	}

	t.deepEqual(result.rows.slice(0, 11), nextFrame);
	t.is(result.scrollTop, 0);
	t.is(result.scrollBottom, 10);
	t.is(result.cursorRow, 10);
	t.is(result.cursorColumn, 0);

	const positional = createStdout();
	const positionalRender = logUpdate.create(positional, {incremental: true});
	process.env['NUVIN_INK_NO_SCROLL_OPT'] = '1';
	try {
		positionalRender(previous.join('\n'));
		positionalRender(nextFrame.join('\n'));
	} finally {
		delete process.env['NUVIN_INK_NO_SCROLL_OPT'];
	}

	t.true(
		Buffer.byteLength(write, 'utf8') <
			Buffer.byteLength(secondWrite(positional), 'utf8'),
	);
};

test('incremental scroll region - bounded shift up never moves footer rows', t => {
	const previous = [
		'HEAD',
		'b1',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'b8',
		'COMPOSER STATUS',
		'COMPOSER INPUT',
	];
	const nextUp = [
		'HEAD',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'b8',
		'b9',
		'COMPOSER STATUS',
		'COMPOSER INPUT',
	];
	assertBoundedFooterShift(t, 'up', previous, nextUp);
});

test('incremental scroll region - bounded shift down never moves footer rows', t => {
	const previous = [
		'HEAD',
		'b1',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'b8',
		'COMPOSER STATUS',
		'COMPOSER INPUT',
	];
	const nextDown = [
		'HEAD',
		'b0',
		'b1',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'COMPOSER STATUS',
		'COMPOSER INPUT',
	];
	assertBoundedFooterShift(t, 'down', previous, nextDown);
});

test('incremental scroll region - shift up rewrites only edge lines', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render(['row 1', 'row 2', 'row 3', 'row 4', 'row 5', 'row 6'].join('\n'));
	render(['row 3', 'row 4', 'row 5', 'row 6', 'new 7', 'new 8'].join('\n'));

	const write = secondWrite(stdout);
	t.true(
		write.includes(`${csi}2M`),
		`expected CSI 2 M (delete 2 lines / scroll up), got: ${JSON.stringify(write)}`,
	);
	t.true(write.includes('new 7'));
	t.true(write.includes('new 8'));
	t.false(write.includes('row 3'));
	t.false(write.includes('row 4'));
	t.false(write.includes('row 6'));
});

test('incremental scroll region - non-fullscreen shift preserves rows below the frame', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});
	const previousRows = ['row 1', 'row 2', 'row 3', 'row 4', 'row 5', 'row 6'];
	const nextRows = ['row 3', 'row 4', 'row 5', 'row 6', 'new 7', 'new 8'];

	render(`${previousRows.join('\n')}\n`);
	render(`${nextRows.join('\n')}\n`);

	const write = secondWrite(stdout);
	t.notRegex(write, csiDeleteLines);
	t.notRegex(write, csiInsertLines);
	t.is(
		write,
		'\u001B[6A\u001B[1Grow 3\u001B[K\n\u001B[1Grow 4\u001B[K\n\u001B[1Grow 5\u001B[K\n\u001B[1Grow 6\u001B[K\n\u001B[1Gnew 7\u001B[K\n\u001B[1Gnew 8\u001B[K\n',
	);

	const belowRows = ['below one', 'below two', 'below three'];
	const terminal = applyTerminalWrite(
		[...previousRows, '', ...belowRows],
		previousRows.length,
		write,
	);
	t.deepEqual(terminal.rows.slice(previousRows.length + 1), belowRows);
});

test('incremental scroll region - shift down emits insert-lines and rewrites top edge', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render(['row 1', 'row 2', 'row 3', 'row 4', 'row 5', 'row 6'].join('\n'));
	render(['new 0', 'new 1', 'row 1', 'row 2', 'row 3', 'row 4'].join('\n'));

	const write = secondWrite(stdout);
	t.true(
		write.includes(`${csi}2L`),
		`expected CSI 2 L (insert 2 lines / scroll down), got: ${JSON.stringify(write)}`,
	);
	t.true(write.includes('new 0'));
	t.true(write.includes('new 1'));
	t.false(write.includes('row 3'));
	t.false(write.includes('row 5'));
});

test('incremental scroll region - centered interior shift does not IL/DL at frame top', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render(
		['HEAD', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'FOOT'].join('\n'),
	);
	render(
		['HEAD', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'FOOT'].join('\n'),
	);

	const write = secondWrite(stdout);
	t.true(
		write.includes(`${csi}1M`),
		`expected CSI 1 M at the interior body, got: ${JSON.stringify(write)}`,
	);
	// Sticky chrome above the shifted band must not be rewritten.
	t.false(write.includes('HEAD'));
	// Interior body moved via IL/DL, so it must not be rewritten.
	t.false(write.includes('b4'));
	t.false(write.includes('b5'));
	// Newly exposed edge line is rewritten.
	t.true(write.includes('b9'));
	// Bounded IL/DL leaves the footer untouched, so it is not retransmitted.
	t.false(write.includes('FOOT'));
});

test('incremental scroll region - centered interior shift down emits insert-lines and restores footer', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render(
		['HEAD', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'FOOT'].join('\n'),
	);
	render(
		['HEAD', 'b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'FOOT'].join('\n'),
	);

	const write = secondWrite(stdout);
	t.true(
		write.includes(`${csi}1L`),
		`expected CSI 1 L at the interior body, got: ${JSON.stringify(write)}`,
	);
	t.false(write.includes('HEAD'));
	t.false(write.includes('b4'));
	t.true(write.includes('b0'));
	t.false(write.includes('FOOT'));
});

test('incremental scroll region - changed prefix rejects shift and rewrites chrome', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render(
		['HEAD', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'FOOT'].join('\n'),
	);
	render(
		['HEAD2', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'FOOT'].join(
			'\n',
		),
	);

	const write = secondWrite(stdout);
	t.notRegex(
		write,
		csiDeleteLines,
		`changed HEAD must not take the interior IL/DL path, got: ${JSON.stringify(write)}`,
	);
	t.notRegex(write, csiInsertLines);
	t.true(
		write.includes('HEAD2'),
		`expected changed HEAD to be rewritten, got: ${JSON.stringify(write)}`,
	);
});

test('incremental scroll region - below-threshold change stays byte-identical to the legacy diff', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render(['a', 'b', 'c', 'd', 'e', 'f'].join('\n'));
	render(['a', 'X', 'Y', 'Z', 'e', 'f'].join('\n'));

	const write = secondWrite(stdout);
	t.notRegex(write, csiDeleteLines);
	t.notRegex(write, csiInsertLines);
	t.is(
		write,
		'\u001B[5A\u001B[E\u001B[1GX\u001B[K\n\u001B[1GY\u001B[K\n\u001B[1GZ\u001B[K\n\u001B[E',
	);
});

test('incremental scroll region - changed footer rejects an unsafe bounded shift', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});
	const previous = [
		'HEAD',
		'b1',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'b8',
		'COMPOSER STATUS',
		'COMPOSER INPUT',
	];
	const next = [
		'HEAD',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'b8',
		'b9',
		'COMPOSER STATUS 2',
		'COMPOSER INPUT',
	];
	render(previous.join('\n'));
	render(next.join('\n'));

	const write = secondWrite(stdout);
	t.notRegex(write, csiDeleteLines);
	t.notRegex(write, csiInsertLines);
	t.false(write.includes('\u001B[2;9r'));
	const result = applyTerminalWrite(previous, previous.length - 1, write);
	for (const snapshot of result.snapshots) {
		t.true(snapshot.rows[9] === previous[9] || snapshot.rows[9] === next[9]);
		t.is(snapshot.rows[10], previous[10]);
	}

	t.deepEqual(result.rows, next);
});

test('incremental scroll region - full-frame shift keeps optimized bounded bytes', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});
	render(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].join('\n'));
	render(['r2', 'r3', 'r4', 'r5', 'r6', 'r7'].join('\n'));

	const write = secondWrite(stdout);
	t.true(write.includes('\u001B[1;6r\u001B[1;1H\u001B[1M\u001B[r\u001B[1;1H'));
	t.is(write.split(csiScrollRegion).length - 1, 1);
	t.is(write.split('\u001B[r').length - 1, 1);
	t.is(write.split(csiDeleteLines).length - 1, 1);
	const result = applyTerminalWrite(
		['r1', 'r2', 'r3', 'r4', 'r5', 'r6'],
		5,
		write,
	);
	t.deepEqual(result.rows, ['r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
	t.is(result.scrollTop, 0);
	t.is(result.scrollBottom, 5);
});

test('incremental scroll region - bounded shift cache remains surgical on the next update', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});
	const previous = [
		'HEAD',
		'b1',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'b8',
		'COMPOSER STATUS',
		'COMPOSER INPUT',
	];
	const shifted = [
		'HEAD',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'b8',
		'b9',
		'COMPOSER STATUS',
		'COMPOSER INPUT',
	];
	const next = [...shifted];
	next[4] = 'b5 changed';
	render(previous.join('\n'));
	render(shifted.join('\n'));
	const afterShift = applyTerminalWrite(
		previous,
		previous.length - 1,
		secondWrite(stdout),
	);
	render(next.join('\n'));

	const write = secondWrite(stdout);
	t.true(write.includes('b5 changed'));
	t.false(write.includes('b6'));
	const result = applyTerminalWrite(
		afterShift.rows,
		afterShift.cursorRow,
		write,
	);
	t.deepEqual(result.rows, next);
	t.is(result.cursorRow, next.length - 1);
});

test('incremental scroll region - bounded shift preserves a later committed cursor', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});
	const previous = [
		'HEAD',
		'b1',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'b8',
		'COMPOSER STATUS',
		'COMPOSER INPUT',
	];
	const shifted = [
		'HEAD',
		'b2',
		'b3',
		'b4',
		'b5',
		'b6',
		'b7',
		'b8',
		'b9',
		'COMPOSER STATUS',
		'COMPOSER INPUT',
	];
	render(previous.join('\n'));
	render(shifted.join('\n'));
	const afterShift = applyTerminalWrite(
		previous,
		previous.length - 1,
		secondWrite(stdout),
	);
	render.setCursorPosition({x: 3, y: 4});
	const next = [...shifted];
	next[5] = 'b6 changed';
	render(next.join('\n'));

	const result = applyTerminalWrite(
		afterShift.rows,
		afterShift.cursorRow,
		secondWrite(stdout).replaceAll(cursorVisibility, ''),
	);
	t.deepEqual(result.rows, next);
	t.is(result.cursorRow, 4);
	t.is(result.cursorColumn, 3);
});

test('incremental scroll region - every installed margin resets in the same write', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});
	render(
		['HEAD', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'FOOT'].join('\n'),
	);
	render(
		['HEAD', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'FOOT'].join('\n'),
	);

	const write = secondWrite(stdout);
	const sets = write.match(csiScrollRegion) ?? [];
	t.is(sets.length, 1);
	t.is(write.split('\u001B[r').length - 1, 1);
	const setIndex = write.indexOf(sets[0]!);
	const cupIndex = write.indexOf('\u001B[2;1H', setIndex);
	const mutationIndex = write.indexOf('\u001B[1M', cupIndex);
	const resetIndex = write.indexOf('\u001B[r', mutationIndex);
	t.true(
		setIndex < cupIndex &&
			cupIndex < mutationIndex &&
			mutationIndex < resetIndex,
	);
	const result = applyTerminalWrite(
		['HEAD', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'FOOT'],
		9,
		write,
	);
	t.is(result.scrollTop, 0);
	t.is(result.scrollBottom, 9);
});

test('incremental scroll region - cache correctness after shift', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].join('\n'));
	render(['r3', 'r4', 'r5', 'r6', 'n7', 'n8'].join('\n'));
	render(['r3', 'r9', 'r5', 'r6', 'n7', 'n8'].join('\n'));

	const thirdWrite = secondWrite(stdout);
	t.true(
		thirdWrite.includes('r9'),
		`expected r9 rewrite, got: ${JSON.stringify(thirdWrite)}`,
	);
	t.false(
		thirdWrite.includes('r5\n'),
		`unchanged r5 must not be rewritten, got: ${JSON.stringify(thirdWrite)}`,
	);
	t.notRegex(thirdWrite, csiDeleteLines);
	t.notRegex(thirdWrite, csiInsertLines);
});

test('incremental scroll region - height change skips scroll path', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].join('\n'));
	render(['r3', 'r4', 'r5', 'r6'].join('\n'));

	const write = secondWrite(stdout);
	t.notRegex(write, csiDeleteLines);
	t.notRegex(write, csiInsertLines);
});

test('incremental scroll region - escape hatch keeps legacy bytes for a pure shift', t => {
	const previous = process.env['NUVIN_INK_NO_SCROLL_OPT'];
	process.env['NUVIN_INK_NO_SCROLL_OPT'] = '1';
	try {
		const stdout = createStdout();
		const render = logUpdate.create(stdout, {incremental: true});
		render(['row 1', 'row 2', 'row 3', 'row 4', 'row 5', 'row 6'].join('\n'));
		render(['row 3', 'row 4', 'row 5', 'row 6', 'new 7', 'new 8'].join('\n'));

		t.is(
			secondWrite(stdout),
			'\u001B[5A\u001B[1Grow 3\u001B[K\n\u001B[1Grow 4\u001B[K\n\u001B[1Grow 5\u001B[K\n\u001B[1Grow 6\u001B[K\n\u001B[1Gnew 7\u001B[K\n\u001B[1Gnew 8\u001B[K',
		);
	} finally {
		if (previous === undefined) {
			delete process.env['NUVIN_INK_NO_SCROLL_OPT'];
		} else {
			process.env['NUVIN_INK_NO_SCROLL_OPT'] = previous;
		}
	}
});
