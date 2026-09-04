import test from 'ava';
import sliceAnsi from 'slice-ansi';
import Output from '../src/output.js';

test('Output.get can return plain rows without ANSI style codes', t => {
	const output = new Output({width: 10, height: 2});
	output.write(0, 0, '[31mhello[39m', {transformers: []});

	const result = output.get({capturePlainRows: true});
	t.deepEqual(result.plainRows, ['hello', '']);
});

test('mask marks only selectable-written cells', t => {
	const output = new Output({width: 8, height: 1});
	output.write(0, 0, '│', {transformers: []}); // Chrome (default)
	output.write(2, 0, 'abc', {transformers: [], selectable: true}); // Content

	const result = output.get({capturePlainRows: true});
	t.deepEqual(result.maskRows![0], [
		false,
		false,
		true,
		true,
		true,
		false,
		false,
		false,
	]);
});

test('later writes overwrite earlier mask stamps', t => {
	const output = new Output({width: 4, height: 1});
	output.write(0, 0, 'abcd', {transformers: [], selectable: true});
	output.write(1, 0, '──', {transformers: []}); // Border drawn over text

	const result = output.get({capturePlainRows: true});
	t.deepEqual(result.maskRows![0], [true, false, false, true]);
});

test('wide characters stamp the mask across both cells', t => {
	const output = new Output({width: 6, height: 1});
	output.write(0, 0, 'a中b', {transformers: [], selectable: true});

	const result = output.get({capturePlainRows: true});
	t.deepEqual(result.maskRows![0], [true, true, true, true, false, false]);
	t.deepEqual(result.plainRows, ['a中b']);
});

test('Output.get invokes the paint callback with grid, rows, and mask', t => {
	const output = new Output({width: 10, height: 1});
	output.write(0, 0, 'abc', {transformers: [], selectable: true});

	let seenRows: string[] = [];
	const result = output.get({
		capturePlainRows: true,
		paint(grid, plainRows, maskRows) {
			seenRows = plainRows;
			t.true(maskRows[0]![0]);
			// Prove grid mutation reaches the string output.
			const cell = grid[0]![0]!;
			grid[0]![0] = {
				...cell,
				styles: [...cell.styles, {type: 'ansi', code: '[7m', endCode: '[27m'}],
			};
		},
	});

	t.deepEqual(seenRows, ['abc']);
	t.true(result.output.includes('\u001B[7m'));
});

test('Output.get without options behaves as before', t => {
	const output = new Output({width: 5, height: 1});
	output.write(0, 0, 'hey', {transformers: []});

	const result = output.get();
	t.is(result.output, 'hey');
	t.is(result.plainRows, undefined);
	t.is(result.maskRows, undefined);
});

test('fully-inside horizontal clip is a no-op on write bytes', t => {
	const fill = `\u001B[48;2;10;20;30m${' '.repeat(8)}\u001B[49m`;
	const unclipped = new Output({width: 20, height: 1});
	unclipped.write(2, 0, fill, {transformers: []});

	const clipped = new Output({width: 20, height: 1});
	clipped.clip({x1: 0, x2: 20, y1: 0, y2: 1});
	clipped.write(2, 0, fill, {transformers: []});
	clipped.unclip();

	t.is(clipped.get().output, unclipped.get().output);
});

test('ANSI-only zero-width clip matches sliceAnsi', t => {
	const ansiOnly = '\u001B[31m\u001B[39m';
	const clipped = new Output({width: 10, height: 1});
	clipped.clip({x1: 0, x2: 10, y1: 0, y2: 1});
	clipped.write(0, 0, ansiOnly, {transformers: []});
	clipped.unclip();

	const sliced = new Output({width: 10, height: 1});
	sliced.write(0, 0, sliceAnsi(ansiOnly, 0, 0), {transformers: []});

	t.is(clipped.get().output, sliced.get().output);
});
