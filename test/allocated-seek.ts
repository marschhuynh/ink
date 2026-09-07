import test, {type ExecutionContext} from 'ava';
import sinon from 'sinon';
import Output from '../src/output.js';
import {
	createSeekPreparer,
	encodeSeekRow,
	prepareSeekRow,
	type SeekPart,
} from '../src/allocated-seek.js';

const csi = '\u001B[';
const closeLink = '\u001B]8;;\u001B\\';
const reset = `${closeLink}${csi}0m`;

const instrumentSegmenter = (t: ExecutionContext) => {
	const segment = Intl.Segmenter.prototype.segment;
	let calls = 0;
	let visited = 0;
	const stub = sinon
		.stub(Intl.Segmenter.prototype, 'segment')
		.callsFake(function (this: Intl.Segmenter, input) {
			calls++;
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
	t.teardown(() => {
		stub.restore();
	});

	return {
		reset() {
			calls = 0;
			visited = 0;
		},
		stats() {
			return {calls, visited};
		},
	};
};

const textParts = (parts: readonly SeekPart[]): string =>
	parts
		.filter(part => part.kind === 'text')
		.map(part => part.text)
		.join('');

const captureGrid = (text: string, width: number, height = 1) => {
	const output = new Output({width, height});
	output.write(0, 0, text, {transformers: [], selectable: true});
	let grid: Array<Array<{value: string}>> = [];
	let plainRows: string[] = [];
	let maskRows: boolean[][] = [];
	const result = output.get({
		capturePlainRows: true,
		paint(nextGrid, nextPlain, nextMask) {
			grid = nextGrid;
			plainRows = nextPlain;
			maskRows = nextMask;
		},
	});
	return {output: result.output, grid, plainRows, maskRows};
};

const assertPartsMatchGrid = (
	t: ExecutionContext,
	parts: readonly SeekPart[],
	row: Array<{value: string}>,
) => {
	let column = 0;
	for (const part of parts) {
		if (part.kind === 'control') {
			continue;
		}

		if (part.ascii) {
			t.is(part.width, part.text.length);
			for (const character of part.text) {
				t.is(row[column]?.value, character);
				column++;
			}

			continue;
		}

		t.true(part.width >= 1);
		t.is(row[column]?.value, part.text);
		for (let index = 1; index < part.width; index++) {
			t.is(row[column + index]?.value, '');
		}

		column += part.width;
	}

	return column;
};

test('clipping keeps logical text and drops a crossing grapheme whole', t => {
	const result = prepareSeekRow('1234567界', 8);
	t.is(result.logical, '1234567界');
	t.is(result.allocatedWidth, 7);
	t.is(
		result.parts
			.filter(p => p.kind === 'text')
			.map(p => p.text)
			.join(''),
		'1234567',
	);
});

test('cursor motion is rejected before painting', t => {
	t.throws(() => prepareSeekRow('ok\u001B[2Aunsafe', 20));
});

test('standalone zero-width graphemes retain their grid allocation', t => {
	for (const row of ['\u0301X', '\uFE0FX', '\u200BX']) {
		const result = prepareSeekRow(row, 8);
		t.is(result.logical, row);
		t.is(result.allocatedWidth, 2);
	}

	const result = prepareSeekRow('A\u200BX', 8);
	t.is(result.allocatedWidth, 3);
	t.is(prepareSeekRow('e\u0301', 8).allocatedWidth, 1);
	t.is(prepareSeekRow('', 8).allocatedWidth, 0);
});

test('ASCII runs are coalesced and non-ASCII graphemes stay separate', t => {
	t.deepEqual(prepareSeekRow('ab界cd', 20).parts, [
		{kind: 'text', text: 'ab', width: 2, ascii: true},
		{kind: 'text', text: '界', width: 2, ascii: false},
		{kind: 'text', text: 'cd', width: 2, ascii: true},
	]);
	t.deepEqual(prepareSeekRow('aéb', 20).parts, [
		{kind: 'text', text: 'a', width: 1, ascii: true},
		{kind: 'text', text: 'é', width: 1, ascii: false},
		{kind: 'text', text: 'b', width: 1, ascii: true},
	]);
});

test('SGR and OSC 8 contribute no cells and keep their bytes', t => {
	const open = '\u001B]8;;https://example.test\u0007';
	const close = '\u001B]8;;\u0007';
	const result = prepareSeekRow(`\u001B[31m${open}hi${close}\u001B[39m`, 20);
	t.deepEqual(result.parts, [
		{kind: 'control', raw: '\u001B[31m'},
		{kind: 'control', raw: open},
		{kind: 'text', text: 'hi', width: 2, ascii: true},
		{kind: 'control', raw: close},
		{kind: 'control', raw: '\u001B[39m'},
	]);
	t.is(result.allocatedWidth, 2);
	t.is(prepareSeekRow('\u001B[31m\u001B[0m', 8).allocatedWidth, 0);
});

test('BEL, ST, and C1 hyperlinks are accepted', t => {
	for (const [open, close] of [
		['\u001B]8;;https://example.test\u0007', '\u001B]8;;\u0007'],
		['\u001B]8;;https://example.test\u001B\\', '\u001B]8;;\u001B\\'],
		['\u001B]8;;https://example.test\u009C', '\u001B]8;;\u009C'],
		['\u009D8;;https://example.test\u0007', '\u009D8;;\u0007'],
		['\u001B]8;id=⚡;https://example.test/⚡︎\u001B\\', '\u001B]8;;\u001B\\'],
	]) {
		const result = prepareSeekRow(`${open}X${close}`, 8);
		t.is(result.logical, `${open}X${close}`);
		t.is(result.allocatedWidth, 1);
		t.deepEqual(result.parts, [
			{kind: 'control', raw: open},
			{kind: 'text', text: 'X', width: 1, ascii: true},
			{kind: 'control', raw: close},
		]);
	}

	const c1Sgr = prepareSeekRow('\u009B31mY\u009B0m', 8);
	t.deepEqual(c1Sgr.parts, [
		{kind: 'control', raw: '\u009B31m'},
		{kind: 'text', text: 'Y', width: 1, ascii: true},
		{kind: 'control', raw: '\u009B0m'},
	]);
});

test('combining marks, ZWJ, and selectors stay inside one grapheme', t => {
	const flag = '🏳️‍♀️';
	const zwj = '👩‍💻';
	const vs15 = '⚡︎';
	const vs16 = '⚡️';
	const keycap = '1\uFE0F\u20E3';

	t.deepEqual(prepareSeekRow('e\u0301', 8).parts, [
		{kind: 'text', text: 'e\u0301', width: 1, ascii: false},
	]);
	t.deepEqual(prepareSeekRow(flag, 8).parts, [
		{kind: 'text', text: flag, width: 2, ascii: false},
	]);
	t.deepEqual(prepareSeekRow(zwj, 8).parts, [
		{kind: 'text', text: zwj, width: 2, ascii: false},
	]);
	t.deepEqual(prepareSeekRow(vs15, 8).parts, [
		{kind: 'text', text: vs15, width: 2, ascii: false},
	]);
	t.deepEqual(prepareSeekRow(vs16, 8).parts, [
		{kind: 'text', text: vs16, width: 2, ascii: false},
	]);
	t.deepEqual(prepareSeekRow(keycap, 8).parts, [
		{kind: 'text', text: keycap, width: 2, ascii: false},
	]);
	t.deepEqual(prepareSeekRow('\uFE0E', 8).parts, [
		{kind: 'text', text: '\uFE0E', width: 1, ascii: false},
	]);
	t.deepEqual(prepareSeekRow('\u200D', 8).parts, [
		{kind: 'text', text: '\u200D', width: 1, ascii: false},
	]);
});

test('unsupported controls are rejected even in the clipped tail', t => {
	for (const row of [
		'ok\u001B[2Aunsafe',
		'hello\u001B[2K',
		'a\tb',
		'a\rb',
		'a\bb',
		'a\nb',
		'A\u0000B',
		'A\u0007B',
		'A\u007FB',
		'A\u009CB',
		'\u001B7X',
		'\u001B(B界',
		'\u001B[?25hX',
		'\u001B[1 qX',
		'\u001B]52;c;YWJj\u0007X',
		'\u001B]66;w=2;界\u001B\\X',
		'\u001BP52;c;⚡︎\u001B\\X',
		'\u0090payload\u001B\\X',
		'\u001B[31',
		'\u001B]8;;url',
		'\u001B',
		'A\uD800B',
		'e\u001B[31m\u0301',
		`👩\u001B[31m\u200D💻`,
		`hi\u001B[2A`,
		`${'x'.repeat(8)}\u001B[2A`,
	]) {
		t.throws(() => prepareSeekRow(row, 8));
	}
});

test('clipping stops before a crossing grapheme and after a fitting one', t => {
	t.is(textParts(prepareSeekRow('\u200BX', 1).parts), '\u200B');
	t.is(prepareSeekRow('\u200BX', 1).allocatedWidth, 1);
	t.is(textParts(prepareSeekRow('A\u200B', 1).parts), 'A');
	t.is(prepareSeekRow('A\u200B', 1).allocatedWidth, 1);
	t.is(textParts(prepareSeekRow('\u0301X', 1).parts), '\u0301');
	t.is(textParts(prepareSeekRow('\uFE0FX', 1).parts), '\uFE0F');

	t.is(prepareSeekRow('界', 1).allocatedWidth, 0);
	t.is(textParts(prepareSeekRow('界', 1).parts), '');
	t.is(prepareSeekRow('界X', 2).allocatedWidth, 2);
	t.is(textParts(prepareSeekRow('界X', 2).parts), '界');

	const styled = prepareSeekRow('\u001B[31m1234567界\u001B[39m', 8);
	t.is(styled.logical, '\u001B[31m1234567界\u001B[39m');
	t.is(styled.allocatedWidth, 7);
	t.is(textParts(styled.parts), '1234567');
	t.deepEqual(styled.parts[0], {kind: 'control', raw: '\u001B[31m'});
});

test('Output grid cells match prepared columns and keep selection text', t => {
	const samples = [
		'\u0301X',
		'\uFE0FX',
		'\u200BX',
		'A\u200BX',
		'e\u0301',
		'界X',
	];
	for (const sample of samples) {
		const captured = captureGrid(sample, 8);
		const plainSnapshot = [...captured.plainRows];
		const maskSnapshot = captured.maskRows.map(row => [...row]);
		const prepared = prepareSeekRow(captured.output, 8);
		const columns = assertPartsMatchGrid(t, prepared.parts, captured.grid[0]!);
		t.is(prepared.allocatedWidth, columns);
		t.is(prepared.logical, captured.output);
		t.deepEqual(captured.plainRows, plainSnapshot);
		t.deepEqual(captured.maskRows, maskSnapshot);
		t.is(captured.plainRows[0], sample);
	}

	const zwBefore = captureGrid('\u200BX', 8);
	const clippedBefore = prepareSeekRow(zwBefore.output, 1);
	t.is(clippedBefore.logical, zwBefore.output);
	t.is(clippedBefore.allocatedWidth, 1);
	t.is(zwBefore.grid[0]![0]!.value, '\u200B');
	t.is(zwBefore.grid[0]![1]!.value, 'X');
	t.is(zwBefore.plainRows[0], '\u200BX');

	const zwAfter = captureGrid('A\u200BX', 8);
	const clippedAfter = prepareSeekRow(zwAfter.output, 1);
	t.is(clippedAfter.logical, zwAfter.output);
	t.is(textParts(clippedAfter.parts), 'A');
	t.is(zwAfter.grid[0]![0]!.value, 'A');
	t.is(zwAfter.grid[0]![1]!.value, '\u200B');
	t.is(zwAfter.grid[0]![2]!.value, 'X');
	t.is(zwAfter.plainRows[0], 'A\u200BX');
});

test('splitting at a newline does not establish independently styled rows', t => {
	const preparer = createSeekPreparer();
	const open = '\u001B]8;;https://example.test\u0007';
	const close = '\u001B]8;;\u0007';
	const inherited = preparer.prepareFrame('\u001B[31mhello\nworld', 20);
	t.is(inherited[0]!.logical, '\u001B[31mhello');
	t.is(inherited[1]!.logical, 'world');
	t.deepEqual(inherited[1]!.parts[0], {kind: 'control', raw: '\u001B[31m'});
	t.is(textParts(inherited[1]!.parts), 'world');
	t.not(inherited[0]!.identity, inherited[1]!.identity);

	const linked = preparer.prepareFrame(`${open}hello\nworld${close}`, 20);
	t.deepEqual(linked[1]!.parts[0], {kind: 'control', raw: open});
	t.is(linked[1]!.logical, `world${close}`);

	const reset = preparer.prepareFrame('\u001B[31mhello\u001B[0m\nworld', 20);
	t.is(reset[1]!.parts[0]?.kind, 'text');
	t.is(
		reset[1]!.identity,
		preparer.prepareFrame('hello\nworld', 20)[1]!.identity,
	);

	const recolored = preparer.prepareFrame('\u001B[32mhello\nworld', 20);
	t.not(recolored[1]!.identity, inherited[1]!.identity);
	t.is(recolored[1]!.logical, inherited[1]!.logical);
	t.deepEqual(recolored[1]!.parts[0], {kind: 'control', raw: '\u001B[32m'});
});

test('line breaks are row boundaries and do not build cross-row graphemes', t => {
	const rows = createSeekPreparer().prepareFrame('e\n\u0301', 8);
	t.is(rows.length, 2);
	t.is(rows[0]!.logical, 'e');
	t.is(rows[1]!.logical, '\u0301');
	t.is(rows[0]!.allocatedWidth, 1);
	t.is(rows[1]!.allocatedWidth, 1);
	t.deepEqual(rows[1]!.parts, [
		{kind: 'text', text: '\u0301', width: 1, ascii: false},
	]);
	t.throws(() => createSeekPreparer().prepareFrame('ok\n\u001B[2A', 20));
});

test('unchanged source rows reuse tokenization and segmentation', t => {
	const preparer = createSeekPreparer();
	const instrument = instrumentSegmenter(t);
	preparer.prepareFrame('hello 界\nworld', 20);
	instrument.reset();
	const again = preparer.prepareFrame('hello 界\nworld', 20);
	t.deepEqual(instrument.stats(), {calls: 0, visited: 0});
	t.is(again[0]!.allocatedWidth, 8);

	instrument.reset();
	const clipped = preparer.prepareFrame('hello 界\nworld', 7);
	t.deepEqual(instrument.stats(), {calls: 0, visited: 0});
	t.is(clipped[0]!.logical, 'hello 界');
	t.is(clipped[0]!.allocatedWidth, 6);
	t.is(textParts(clipped[0]!.parts), 'hello ');

	instrument.reset();
	preparer.prepareFrame('hello X\nworld', 20);
	t.is(instrument.stats().calls, 1);
});

test('truecolor and ansi256 channels do not drop inherited SGR', t => {
	const preparer = createSeekPreparer();
	// chalk.hex('#ff0000') and chalk.rgb(255, 0, 0) both emit 38;2;255;0;0.
	const rgb = preparer.prepareFrame(
		'\u001B[1m\u001B[38;2;255;0;0mhello\nworld',
		20,
	);
	t.deepEqual(rgb[1]!.parts, [
		{kind: 'control', raw: '\u001B[1m\u001B[38;2;255;0;0m'},
		{kind: 'text', text: 'world', width: 5, ascii: true},
	]);

	const named = preparer.prepareFrame('\u001B[1m\u001B[31mhello\nworld', 20);
	t.deepEqual(named[1]!.parts[0], {
		kind: 'control',
		raw: '\u001B[1m\u001B[31m',
	});

	const ansi256 = preparer.prepareFrame(
		'\u001B[1m\u001B[38;5;0mhello\nworld',
		20,
	);
	t.deepEqual(ansi256[1]!.parts, [
		{kind: 'control', raw: '\u001B[1m\u001B[38;5;0m'},
		{kind: 'text', text: 'world', width: 5, ascii: true},
	]);

	const reset = preparer.prepareFrame(
		'\u001B[1m\u001B[38;2;255;0;0mhello\u001B[0m\nworld',
		20,
	);
	t.is(reset[1]!.parts[0]?.kind, 'text');
	t.is(textParts(reset[1]!.parts), 'world');
});

test('encodeSeekRow emits CUP, reset, EL2, ASCII, and trailing EL', t => {
	const encoded = encodeSeekRow(prepareSeekRow('AB', 8), 0, 8);
	t.is(encoded, `${csi}1;1H${reset}${csi}2KAB${reset}${csi}3G${csi}K`);
});

test('encodeSeekRow prefills non-ASCII graphemes and stays in-bounds', t => {
	const prepared = prepareSeekRow('⚡', 8);
	t.is(prepared.allocatedWidth, 2);
	const encoded = encodeSeekRow(prepared, 3, 8);
	t.is(
		encoded,
		`${csi}4;1H${reset}${csi}2K  ${csi}1G⚡${csi}3G${reset}${csi}3G${csi}K`,
	);
	t.false(encoded.includes(`${csi}9G`));
});

test('an exact-width ASCII row has neither CHA N+1 nor EL after its final cell', t => {
	const encoded = encodeSeekRow(prepareSeekRow('12345678', 8), 0, 8);
	t.is(encoded, `${csi}1;1H${reset}${csi}2K12345678${reset}`);
	t.false(encoded.includes(`${csi}9G`));
	t.false(encoded.includes(`${csi}K`));
});

test('encodeSeekRow keeps combining marks and OSC 8 payloads intact', t => {
	const accent = encodeSeekRow(prepareSeekRow('e\u0301', 8), 0, 8);
	t.true(accent.includes('e\u0301'));
	const open = '\u001B]8;;https://example.test\u001B\\';
	const close = '\u001B]8;;\u001B\\';
	const encoded = encodeSeekRow(prepareSeekRow(`${open}X${close}`, 8), 0, 8);
	t.is(
		encoded,
		`${csi}1;1H${reset}${csi}2K${open}X${close}${reset}${csi}2G${csi}K`,
	);
});

test('encodeSeekRow emits inherited entry SGR from frame preparation', t => {
	const rows = createSeekPreparer().prepareFrame('\u001B[41mhello\nworld', 8);
	const encoded = encodeSeekRow(rows[1]!, 1, 8);
	t.true(encoded.startsWith(`${csi}2;1H${reset}${csi}2K\u001B[41mworld`));
});
