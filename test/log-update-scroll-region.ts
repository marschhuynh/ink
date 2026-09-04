import process from 'node:process';
import test from 'ava';
import logUpdate from '../src/log-update.js';
import createStdout from './helpers/create-stdout.js';

const csi = '\u001B[';
const csiDeleteLines = new RegExp(`${String.fromCodePoint(0x1b)}\\[\\d*M`);
const csiInsertLines = new RegExp(`${String.fromCodePoint(0x1b)}\\[\\d*L`);

const secondWrite = (stdout: ReturnType<typeof createStdout>): string =>
	stdout.get();

const blankTerminalRows = (count: number): string[] =>
	Array.from({length: count}, () => '');

const applyTerminalWrite = (
	initialRows: string[],
	initialCursorRow: number,
	write: string,
): string[] => {
	const rows = [...initialRows];
	let row = initialCursorRow;
	let column = 0;

	for (let index = 0; index < write.length;) {
		if (write[index] === '\u001B' && write[index + 1] === '[') {
			let commandIndex = index + 2;
			while (/\d/.test(write[commandIndex] ?? '')) commandIndex++;
			const parameter = write.slice(index + 2, commandIndex);
			const count = parameter === '' ? 1 : Number(parameter);
			const command = write[commandIndex] ?? '';

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

				case 'L': {
					rows.splice(row, 0, ...blankTerminalRows(count));
					rows.length = initialRows.length;

					break;
				}

				case 'M': {
					rows.splice(row, count);
					rows.push(...blankTerminalRows(count));

					break;
				}

				case 'G': {
					column = count - 1;

					break;
				}

				case 'K': {
					rows[row] = rows[row]!.slice(0, column);

					break;
				}

				default: {
					throw new Error(`Unsupported terminal sequence at ${index}`);
				}
			}

			index = commandIndex + 1;
			continue;
		}

		if (write[index] === '\n') {
			row++;
			column = 0;
			index++;
			continue;
		}

		const cells = [...rows[row]!];
		cells[column++] = write[index]!;
		rows[row] = cells.join('');
		index++;
	}

	return rows;
};

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
	t.deepEqual(terminal.slice(previousRows.length + 1), belowRows);
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
	// IL/DL at the body also moves the footer; the ordinary diff must restore it.
	t.true(
		write.includes('FOOT'),
		`expected FOOT to be rewritten after CSI 1 M, got: ${JSON.stringify(write)}`,
	);
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
	t.true(
		write.includes('FOOT'),
		`expected FOOT to be rewritten after CSI 1 L, got: ${JSON.stringify(write)}`,
	);
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
