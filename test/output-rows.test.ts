import test from 'ava';
import sliceAnsi from 'slice-ansi';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import sinon from 'sinon';
import Output from '../src/output.js';
import {paintSelection} from '../src/paint-selection.js';

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

const clippingGlyphs: Array<[string, string]> = [
	['lightning', '\u26A1'],
	['lightning VS15', '\u26A1\uFE0E'],
	['lightning VS16', '\u26A1\uFE0F'],
	['warning VS16', '\u26A0\uFE0F'],
	['check', '\u2705'],
	['cross', '\u274C'],
	['heart VS15', '\u2764\uFE0E'],
	['heart VS16', '\u2764\uFE0F'],
	['CJK', '中'],
	['keycap', '1\uFE0F\u20E3'],
	['ZWJ', '\u{1F469}\u200D\u{1F4BB}'],
	['unqualified eye ZWJ', '\u{1F441}\u200D\u{1F5E8}'],
];

for (const [name, glyph] of clippingGlyphs) {
	for (const styled of [false, true]) {
		for (const edge of ['left', 'right', 'both', 'inside']) {
			test(`grapheme clip preserves columns: ${name}, ${edge}, styled=${styled}`, t => {
				const width = stringWidth(glyph);
				const text = `${glyph}X${glyph}`;
				const outputWidth = width * 2 + 3;
				const output = new Output({width: outputWidth, height: 1});
				const clipLeft = edge === 'left' || edge === 'both';
				const clipRight = edge === 'right' || edge === 'both';
				output.write(outputWidth - 1, 0, '|', {transformers: []});
				output.clip({
					x1: clipLeft ? width : 1,
					x2: clipRight ? width + 3 : width * 2 + 2,
					y1: 0,
					y2: 1,
				});
				output.write(1, 0, styled ? `\u001B[31m${text}\u001B[39m` : text, {
					transformers: [],
					selectable: true,
				});
				output.unclip();

				// A one-column VS15 glyph fits at either edge; a wide glyph does not.
				const omitLeft = clipLeft && width > 1;
				const omitRight = clipRight && width > 1;
				const expected = ` ${omitLeft ? ' '.repeat(width) : glyph}X${omitRight ? ' '.repeat(width) : glyph}|`;
				const expectedMask = [
					false,
					...Array.from({length: width}, () => !omitLeft),
					true,
					...Array.from({length: width}, () => !omitRight),
					false,
				];
				const result = output.get({
					capturePlainRows: true,
					paint(grid, rows, masks) {
						t.is(grid[0]![width + 1]!.value, 'X');
						t.is(grid[0]![outputWidth - 1]!.value, '|');
						t.deepEqual(rows, [expected]);
						t.deepEqual(masks, [expectedMask]);
						paintSelection(grid, [{y: 0, x1: 0, x2: outputWidth}], masks);
						t.deepEqual(
							grid[0]!.map(cell =>
								cell.styles.some(style => style.code === '\u001B[7m'),
							),
							expectedMask,
						);
						if (styled) {
							t.true(
								grid[0]![width + 1]!.styles.some(
									style => style.code === '\u001B[31m',
								),
							);
						}
					},
				});
				t.is(stripAnsi(result.output), expected);
				t.is(stringWidth(result.output), outputWidth);
				t.is(result.maxVisualWidth, outputWidth);
			});
		}
	}
}

test('left clipping a wide glyph does not shift the following marker', t => {
	const output = new Output({width: 3, height: 1});
	output.clip({x1: 1, x2: 3, y1: 0, y2: 1});
	output.write(0, 0, '\u26A1X', {transformers: []});
	output.unclip();
	t.is(output.get().output, '  X');
});

test('clipped lines keep independent columns and reach transformers after clipping', t => {
	const output = new Output({width: 4, height: 2});
	const transformed: Array<[string, number]> = [];
	output.clip({x1: 0, x2: 4, y1: 0, y2: 2});
	output.clip({x1: 0, x2: 3, y1: 0, y2: 2});
	output.write(-1, -1, 'skip\n\u26A1X\nabX', {
		transformers: [
			(line, index) => {
				transformed.push([line, index]);
				return `\u001B[31m${line}\u001B[39m`;
			},
		],
		selectable: true,
	});
	output.unclip();
	output.write(3, 0, '|\n|', {transformers: []});
	output.unclip();

	const result = output.get({capturePlainRows: true});
	t.deepEqual(transformed, [
		['X', 0],
		['bX', 1],
	]);
	t.is(stripAnsi(result.output), ' X |\nbX |');
	t.deepEqual(result.maskRows, [
		[false, true, false, false],
		[true, true, false, false],
	]);
});

test('omitted edge glyphs do not overwrite underlying cells or masks', t => {
	const output = new Output({width: 5, height: 1});
	output.write(0, 0, 'abcde', {transformers: []});
	output.clip({x1: 1, x2: 4, y1: 0, y2: 1});
	output.write(0, 0, '\u26A1X\u26A1', {
		transformers: [],
		selectable: true,
	});
	output.unclip();

	const result = output.get({capturePlainRows: true});
	t.is(result.output, 'abXde');
	t.deepEqual(result.maskRows, [[false, false, true, false, false]]);
});

for (const firstLine of ['', 'a', '\u26A1']) {
	for (const x of [-1, -3]) {
		test(`empty clipped transformer output uses clip boundary: ${JSON.stringify(firstLine)}, x=${x}`, t => {
			const output = new Output({width: 4, height: 2});
			const inputs: string[] = [];
			output.clip({x1: 0, x2: 4, y1: 0, y2: 2});
			output.write(x, 0, `${firstLine}\nabcde`, {
				transformers: [
					line => {
						inputs.push(line);
						return line || '.';
					},
				],
				selectable: true,
			});
			output.unclip();

			const tail = x === -1 ? 'bcde' : 'de';
			const result = output.get({capturePlainRows: true});
			t.deepEqual(inputs, ['', tail]);
			t.is(result.output, `.\n${tail}`);
			t.deepEqual(result.plainRows, ['.', tail]);
			t.deepEqual(result.maskRows, [
				[true, false, false, false],
				Array.from({length: 4}, (_, index) => index < tail.length),
			]);
		});
	}
}

test.serial(
	'right clipping bounds segmentation independently of invisible suffix length',
	t => {
		const segment = Intl.Segmenter.prototype.segment;
		let visited = 0;
		const stub = sinon
			.stub(Intl.Segmenter.prototype, 'segment')
			.callsFake(function (this: Intl.Segmenter, input) {
				const segments = segment.call(this, input);
				const iterate = segments[Symbol.iterator].bind(segments);
				Object.defineProperty(segments, Symbol.iterator, {
					*value() {
						for (const item of iterate()) {
							visited++;
							yield item;
						}
					},
				});
				return segments;
			});
		t.teardown(() => stub.restore());

		for (const x of [0, -1]) {
			for (const styled of [false, true]) {
				const counts: number[] = [];
				for (const length of [100, 10_000, 100_000]) {
					const text = '\u26A1'.repeat(40) + 'X'.repeat(length);
					const output = new Output({width: 80, height: 1});
					output.clip({x1: 0, x2: 80, y1: 0, y2: 1});
					output.write(x, 0, styled ? `\u001B[31m${text}\u001B[39m` : text, {
						transformers: [],
					});
					output.unclip();
					visited = 0;
					const result = output.get();
					counts.push(visited);
					t.is(
						stripAnsi(result.output),
						x === 0 ? '\u26A1'.repeat(40) : ` ${'\u26A1'.repeat(39)}X`,
					);
				}

				t.log({x, styled, segmentedGraphemes: counts});
				t.true(counts.every(count => count < 1000));
				t.is(counts[0], counts[1]);
				t.is(counts[1], counts[2]);
			}
		}
	},
);

test('fully-inside clipped transformer receives original ANSI bytes at the right edge', t => {
	const output = new Output({width: 3, height: 1});
	const text = '\u001B[31;1m\u26A1X\u001B[0m';
	output.clip({x1: 0, x2: 3, y1: 0, y2: 1});
	output.write(0, 0, text, {
		transformers: [
			line => {
				t.is(line, text);
				return line;
			},
		],
	});
	output.unclip();
	t.is(stripAnsi(output.get().output), '\u26A1X');
});

test('bounded tokenization does not truncate glyphs whose tokenizer width is too large', t => {
	// The tokenizer marks any VS16 cluster fullWidth, but string-width measures
	// this non-emoji cluster as one column. Token widths must not drive clipping.
	const text = 'a\uFE0F'.repeat(80);
	t.is(stringWidth(text), 80);
	const output = new Output({width: 80, height: 1});
	output.clip({x1: 0, x2: 80, y1: 0, y2: 1});
	output.write(0, 0, `${text}X`, {transformers: []});
	output.unclip();
	t.is(output.get().output, text);
});

for (const {width, height} of [
	{width: 80, height: 40},
	{width: 160, height: 60},
]) {
	test.serial(
		`fully-inside ANSI rows reuse complete geometry and styles: ${width}x${height}`,
		t => {
			const segment = Intl.Segmenter.prototype.segment;
			let visited = 0;
			const stub = sinon
				.stub(Intl.Segmenter.prototype, 'segment')
				.callsFake(function (this: Intl.Segmenter, input) {
					const segments = segment.call(this, input);
					const iterate = segments[Symbol.iterator].bind(segments);
					Object.defineProperty(segments, Symbol.iterator, {
						*value() {
							for (const item of iterate()) {
								visited++;
								yield item;
							}
						},
					});
					return segments;
				});
			t.teardown(() => stub.restore());

			const line = Array.from(
				{length: width},
				(_, index) =>
					`\u001B[38;2;${index};${index + 1};${index + 2}mX\u001B[39m`,
			).join('');
			const reference = new Output({width, height: 1});
			reference.write(0, 0, line, {transformers: []});
			const expected = reference.get().output;
			const counts: number[] = [];
			for (const rows of [1, height]) {
				const output = new Output({width, height: rows});
				output.clip({x1: 0, x2: width, y1: 0, y2: rows});
				for (let y = 0; y < rows; y++) {
					output.write(0, y, line, {transformers: []});
				}

				output.unclip();
				visited = 0;
				const result = output.get();
				counts.push(visited);
				t.deepEqual(
					result.output.split('\n'),
					Array.from({length: rows}, () => expected),
				);
				t.is(result.maxVisualWidth, width);
			}

			t.log({width, height, segmentedGraphemes: counts});
			t.true(counts[0]! > 0);
			t.is(counts[0], counts[1]);
		},
	);
}

test('complete-line cache does not promote clipped prefixes or ignore later clip bounds', t => {
	const output = new Output({width: 3, height: 3});
	for (const {y, x1, x2} of [
		{y: 0, x1: 0, x2: 1},
		{y: 1, x1: 0, x2: 3},
		{y: 2, x1: 1, x2: 3},
	]) {
		output.clip({x1, x2, y1: 0, y2: 3});
		output.write(0, y, '\u26A1X', {transformers: [], selectable: true});
		output.unclip();
	}

	const result = output.get({capturePlainRows: true});
	t.is(result.output, '\n\u26A1X\n  X');
	t.deepEqual(result.maskRows, [
		[false, false, false],
		[true, true, true],
		[false, false, true],
	]);
});
