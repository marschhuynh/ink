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
						const effectiveCount = Math.min(count, scrollBottom - row + 1);
						rows.splice(row, 0, ...blankTerminalRows(effectiveCount));
						rows.splice(scrollBottom + 1, effectiveCount);
					}

					break;
				}

				case 'M': {
					if (row >= scrollTop && row <= scrollBottom) {
						const effectiveCount = Math.min(count, scrollBottom - row + 1);
						rows.splice(row, effectiveCount);
						rows.splice(
							scrollBottom - effectiveCount + 1,
							0,
							...blankTerminalRows(effectiveCount),
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

const countMatches = (write: string, expression: RegExp): number =>
	write.match(new RegExp(expression.source, 'g'))?.length ?? 0;

const assertNoScrollOptimization = (
	t: ExecutionContext,
	write: string,
): void => {
	t.notRegex(write, csiDeleteLines);
	t.notRegex(write, csiInsertLines);
	t.notRegex(write, csiScrollRegion);
};

const assertOptimizedScrollOperation = (
	t: ExecutionContext,
	write: string,
	{
		start,
		end,
		rows,
		height,
	}: {start: number; end: number; rows: number; height: number},
): void => {
	const set = `\u001B[${start + 1};${end}r`;
	const cup = `\u001B[${start + 1};1H`;
	const mutation = `\u001B[${Math.abs(rows)}${rows > 0 ? 'M' : 'L'}`;
	const reset = '\u001B[r';

	t.true(write.includes(`${set}${cup}${mutation}${reset}${cup}`));
	t.is(countMatches(write, csiScrollRegion), 1);
	t.is(write.split(reset).length - 1, 1);
	t.is(
		countMatches(write, csiDeleteLines) + countMatches(write, csiInsertLines),
		1,
	);

	const setIndex = write.indexOf(set);
	const firstCupIndex = write.indexOf(cup, setIndex + set.length);
	const mutationIndex = write.indexOf(mutation, firstCupIndex + cup.length);
	const resetIndex = write.indexOf(reset, mutationIndex + mutation.length);
	const secondCupIndex = write.indexOf(cup, resetIndex + reset.length);
	t.true(
		setIndex >= 0 &&
			setIndex < firstCupIndex &&
			firstCupIndex < mutationIndex &&
			mutationIndex < resetIndex &&
			resetIndex < secondCupIndex,
	);

	const result = applyTerminalWrite(
		blankTerminalRows(height),
		height - 1,
		write,
	);
	t.is(result.scrollTop, 0);
	t.is(result.scrollBottom, height - 1);
};

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

test('terminal model clamps line mutations to the remaining scroll region', t => {
	const initialRows = [
		'above',
		'top',
		'target',
		'bottom',
		'suffix 1',
		'suffix 2',
	];
	const expectedRows = ['above', 'top', '', '', 'suffix 1', 'suffix 2'];

	for (const command of ['M', 'L']) {
		const result = applyTerminalSequences(
			initialRows,
			`\u001B[2;4r\u001B[3;1H\u001B[9${command}`,
		);
		t.deepEqual(result.rows, expectedRows);
	}
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
	assertOptimizedScrollOperation(t, write, {
		start: 1,
		end: 9,
		rows: direction === 'up' ? 1 : -1,
		height: previous.length,
	});
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
	assertOptimizedScrollOperation(t, write, {
		start: 0,
		end: 6,
		rows: 2,
		height: 6,
	});
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
	assertNoScrollOptimization(t, write);
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
	assertOptimizedScrollOperation(t, write, {
		start: 0,
		end: 6,
		rows: -2,
		height: 6,
	});
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
	assertOptimizedScrollOperation(t, write, {
		start: 1,
		end: 9,
		rows: 1,
		height: 10,
	});
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
	assertOptimizedScrollOperation(t, write, {
		start: 1,
		end: 9,
		rows: -1,
		height: 10,
	});
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
	assertNoScrollOptimization(t, write);
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
	assertNoScrollOptimization(t, write);
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
	assertNoScrollOptimization(t, write);
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
	assertOptimizedScrollOperation(t, write, {
		start: 0,
		end: 6,
		rows: 1,
		height: 6,
	});
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
	const shiftWrite = secondWrite(stdout);
	assertOptimizedScrollOperation(t, shiftWrite, {
		start: 1,
		end: 9,
		rows: 1,
		height: previous.length,
	});
	const afterShift = applyTerminalWrite(
		previous,
		previous.length - 1,
		shiftWrite,
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
	const shiftWrite = secondWrite(stdout);
	assertOptimizedScrollOperation(t, shiftWrite, {
		start: 1,
		end: 9,
		rows: 1,
		height: previous.length,
	});
	const afterShift = applyTerminalWrite(
		previous,
		previous.length - 1,
		shiftWrite,
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
	assertOptimizedScrollOperation(t, write, {
		start: 1,
		end: 9,
		rows: 1,
		height: 10,
	});
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
	assertOptimizedScrollOperation(t, secondWrite(stdout), {
		start: 0,
		end: 6,
		rows: 2,
		height: 6,
	});
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
	assertNoScrollOptimization(t, thirdWrite);
});

test('incremental scroll region - committed active cursor rejects a shift-shaped update', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});
	const previous = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
	const shifted = ['r2', 'r3', 'r4', 'r5', 'r6', 'r7'];

	render(previous.join('\n'));
	render.setCursorPosition({x: 2, y: 3});
	render(previous.join('\n'));
	render(shifted.join('\n'));

	assertNoScrollOptimization(t, secondWrite(stdout));
});

test('incremental scroll region - height change skips scroll path', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render(['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].join('\n'));
	render(['r3', 'r4', 'r5', 'r6'].join('\n'));

	const write = secondWrite(stdout);
	assertNoScrollOptimization(t, write);
});

test('incremental scroll region - cache reset rejects shifts until a new baseline exists', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});
	const previous = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'];
	const shifted = ['r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
	const shiftedAgain = ['r3', 'r4', 'r5', 'r6', 'r7', 'r8'];

	render(previous.join('\n'));
	render.reset();
	render(shifted.join('\n'));
	assertNoScrollOptimization(t, secondWrite(stdout));

	render(shiftedAgain.join('\n'));
	assertOptimizedScrollOperation(t, secondWrite(stdout), {
		start: 0,
		end: 6,
		rows: 1,
		height: 6,
	});
});

test('incremental scroll region - escape hatch keeps legacy bytes for a pure shift', t => {
	const previous = process.env['NUVIN_INK_NO_SCROLL_OPT'];
	process.env['NUVIN_INK_NO_SCROLL_OPT'] = '1';
	try {
		const stdout = createStdout();
		const render = logUpdate.create(stdout, {incremental: true});
		render(['row 1', 'row 2', 'row 3', 'row 4', 'row 5', 'row 6'].join('\n'));
		render(['row 3', 'row 4', 'row 5', 'row 6', 'new 7', 'new 8'].join('\n'));

		const write = secondWrite(stdout);
		assertNoScrollOptimization(t, write);
		t.is(
			write,
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
