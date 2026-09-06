import {Buffer} from 'node:buffer';
import test, {type ExecutionContext} from 'ava';
import sinon from 'sinon';
import stringWidth from 'string-width';
import {createExplicitWidthEncoder} from '../src/explicit-width.js';
import Output from '../src/output.js';

const osc = (width: number, text: string): string =>
	`\u001B]66;w=${width};${text}\u001B\\`;

const supplementaryNoncharacters: string[] = [];
for (let plane = 1; plane <= 16; plane++) {
	supplementaryNoncharacters.push(
		String.fromCodePoint((plane << 16) + 0xfffe),
		String.fromCodePoint((plane << 16) + 0xffff),
	);
}

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

test('encoder preserves ASCII and original emoji selectors', t => {
	const encode = createExplicitWidthEncoder();
	t.is(encode('plain ASCII\n'), 'plain ASCII\n');
	t.is(encode('⚡︎ / ⚡️'), `${osc(2, '⚡︎')} / ${osc(2, '⚡️')}`);
	t.is(encode('e\u0301'), osc(1, 'e\u0301'));
	t.is(encode(''), '');
});

test('encoder wraps eligible graphemes with source-literal OSC 66 payloads', t => {
	const encode = createExplicitWidthEncoder();
	const cjk = '界';
	const precomposed = 'é';
	const decomposed = 'e\u0301';
	const flag = '\u{1F1EF}\u{1F1F5}';
	const skin = '\u{1F44D}\u{1F3FD}';
	const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
	const qualifiedKeycap = '1\uFE0F\u20E3';
	const unqualifiedKeycap = '1\u20E3';

	t.is(encode(''), '');
	t.is(encode('ASCII only'), 'ASCII only');
	t.is(encode(cjk), osc(2, cjk));
	t.is(encode(precomposed), osc(1, precomposed));
	t.is(encode(decomposed), osc(1, decomposed));
	t.not(encode(precomposed), encode(decomposed));
	t.is(encode('⚡︎'), osc(2, '⚡︎'));
	t.is(encode('⚡️'), osc(2, '⚡️'));
	t.is(encode(flag), osc(2, flag));
	t.is(encode(skin), osc(2, skin));
	t.is(encode(family), osc(2, family));
	t.is(encode(qualifiedKeycap), osc(2, qualifiedKeycap));
	t.is(encode(unqualifiedKeycap), osc(2, unqualifiedKeycap));
});

test('reference emoji sample encodes six w=2 wrappers to 106 UTF-8 bytes', t => {
	const encode = createExplicitWidthEncoder();
	const sample = '- ⚡, ⚡︎, ⚡️, ⚠️, ✅, ❌,';
	const encoded = encode(sample);
	t.is(Buffer.byteLength(sample, 'utf8'), 40);
	t.is(Buffer.byteLength(encoded, 'utf8'), 106);
	t.is(
		encoded,
		`- ${osc(2, '⚡')}, ${osc(2, '⚡︎')}, ${osc(2, '⚡️')}, ${osc(2, '⚠️')}, ${osc(2, '✅')}, ${osc(2, '❌')},`,
	);
});

test('encoder preserves hyperlink bytes and only encodes its label', t => {
	for (const end of ['\u0007', '\u001B\\', '\u009C']) {
		const open = `\u001B]8;id=⚡;https://example.test/⚡︎${end}`;
		const close = `\u001B]8;;${end}`;
		t.is(
			createExplicitWidthEncoder()(`${open}⚡︎${close}`),
			`${open}${osc(2, '⚡︎')}${close}`,
		);
	}
});

test('encoder never wraps string-control payloads', t => {
	for (const start of [
		'\u001B]',
		'\u009D',
		'\u001BP',
		'\u0090',
		'\u001B_',
		'\u009F',
		'\u001B^',
		'\u009E',
		'\u001BX',
		'\u0098',
	]) {
		const control = `${start}52;c;⚡︎\u001B[31m\u001B\\`;
		t.is(
			createExplicitWidthEncoder()(`${control}界`),
			`${control}${osc(2, '界')}`,
		);
	}
});

test('BEL inside DCS/APC/PM/SOS is payload, not a terminator', t => {
	for (const start of [
		'\u001BP',
		'\u0090',
		'\u001B_',
		'\u009F',
		'\u001B^',
		'\u009E',
		'\u001BX',
		'\u0098',
	]) {
		const control = `${start}52;c;\u26A1\u0007still\u001B\\`;
		t.is(
			createExplicitWidthEncoder()(`${control}\u754c`),
			`${control}${osc(2, '\u754c')}`,
		);
	}
});
test('unterminated strings preserve the whole input, including later rows', t => {
	for (const start of ['\u001B]', '\u001BP', '\u001B_', '\u001B^', '\u001BX']) {
		const input = `界${start}payload ⚡︎\nmore ⚡️`;
		t.is(createExplicitWidthEncoder()(input), input);
	}
});

test('encoder copies compound CSI byte-for-byte and encodes colored Unicode', t => {
	const encode = createExplicitWidthEncoder();
	const open = '\u001B[38:2:255:128:0;1m';
	const privateCsi = '\u001B[?25h';
	const intermediate = '\u001B[1 q';
	const close = '\u001B[0m';
	t.is(encode(`${open}界${close}`), `${open}${osc(2, '界')}${close}`);
	t.is(encode(`${privateCsi}A`), `${privateCsi}A`);
	t.is(encode(`${intermediate}é`), `${intermediate}${osc(1, 'é')}`);
	t.is(encode('\u009B31m界\u009B0m'), `\u009B31m${osc(2, '界')}\u009B0m`);
});

test('encoder leaves OSC 52 payloads unchanged under BEL and ST', t => {
	const encode = createExplicitWidthEncoder();
	for (const end of ['\u0007', '\u001B\\']) {
		const clipboard = `\u001B]52;c;YWJj${end}`;
		const unicodePayload = `\u001B]52;c;⚡︎${end}`;
		t.is(encode(`${clipboard}界`), `${clipboard}${osc(2, '界')}`);
		t.is(encode(`${unicodePayload}界`), `${unicodePayload}${osc(2, '界')}`);
	}
});

test('encoder does not nest or re-encode existing OSC 66', t => {
	const encode = createExplicitWidthEncoder();
	const existing = osc(2, '界');
	t.is(encode(`${existing}⚡︎`), `${existing}${osc(2, '⚡︎')}`);
});

test('encoder copies C0, DEL, C1, and non-string ESC sequences unchanged', t => {
	const encode = createExplicitWidthEncoder();
	t.is(encode('A\r\nB'), 'A\r\nB');
	t.is(encode('A\tB'), 'A\tB');
	t.is(encode('A\u0007B'), 'A\u0007B');
	t.is(encode('A\u0008B'), 'A\u0008B');
	t.is(encode('A\u0000B'), 'A\u0000B');
	t.is(encode('A\u007FB'), 'A\u007FB');
	t.is(encode('A\u009CB'), 'A\u009CB');
	t.is(encode('\u001B(B界'), `\u001B(B${osc(2, '界')}`);
	t.is(encode('\u001B7\u001B8界'), `\u001B7\u001B8${osc(2, '界')}`);
	t.false(encode('\r\n\t\u0007\u0008\u0000\u007F').includes(']66;'));
});

test('malformed controls fall back for the whole call and later valid calls still encode', t => {
	const encode = createExplicitWidthEncoder();
	for (const input of [
		'界\u001B[',
		'界\u009B',
		'界\u001B[31',
		'界\u001B[31\u0001',
		'界\u001B',
		'界\u001B\u0001',
		'界\u001B]payload',
		'界\u001B]payload\u001B',
		'界\u001BPpayload',
		'界\u009Dpayload',
	]) {
		t.is(encode(input), input);
	}

	t.is(encode('界'), osc(2, '界'));
});

test('complete string controls spanning LF fall back as a whole input', t => {
	const encode = createExplicitWidthEncoder();
	const oscInput = 'hello \u001B]payload\nmore\u001B\\ world 界';
	const dcsInput = 'hello \u001BPpayload\nmore\u001B\\ world 界';
	t.is(encode(oscInput), oscInput);
	t.is(encode(dcsInput), dcsInput);
});

test('payload and width bounds never truncate or split graphemes', t => {
	const encode = createExplicitWidthEncoder();
	const atLimit = `a${'\u0301'.repeat(2046)}\u20D0`;
	const overLimit = `a${'\u0301'.repeat(2048)}`;
	const width7 = `a${'\u093E'.repeat(6)}`;
	const width8 = '\u1100'.repeat(4);

	t.is(Buffer.byteLength(atLimit, 'utf8'), 4096);
	t.is(Buffer.byteLength(overLimit, 'utf8'), 4097);
	t.is(encode(atLimit), osc(1, atLimit));
	t.is(encode(overLimit), overLimit);
	t.is(encode(width7), osc(7, width7));
	t.is(encode(width8), width8);
	t.false(encode(overLimit).includes(']66;'));
	t.false(encode(width8).includes(']66;'));
});

test('unusual Unicode clusters stay raw and never emit w=0', t => {
	const encode = createExplicitWidthEncoder();
	const loneSurrogate = String.fromCharCode(0xd800);
	const emoji = '\u{1F600}';
	t.is(encode('\u200D'), '\u200D');
	t.is(encode('\u200F'), '\u200F');
	t.is(encode(loneSurrogate), loneSurrogate);
	t.is(encode('\u0301'), '\u0301');
	t.is(encode('\uFE0F'), '\uFE0F');
	t.is(encode(emoji), osc(2, emoji));
	t.false(encode('\u0301').includes('w=0'));
	t.false(encode('\uFE0F').includes('w=0'));
	t.false(encode('\u200D').includes(']66;'));
});

test('noncharacters remain raw even inside a larger cluster', t => {
	const encode = createExplicitWidthEncoder();
	const bmp = ['\uFDD0', '\uFDEF', '\uFFFE', '\uFFFF'];
	for (const value of [...bmp, ...supplementaryNoncharacters]) {
		t.is(encode(value), value);
		t.is(encode(`界${value}é`), `${osc(2, '界')}${value}${osc(1, 'é')}`);
		const clustered = `${value}\uFE0F`;
		t.is(
			encode(`界${clustered}界`),
			`${osc(2, '界')}${clustered}${osc(2, '界')}`,
		);
	}
});

test('grid allocation matches eligible wrappers and keeps zero-width raw', t => {
	const encode = createExplicitWidthEncoder();
	const width7 = `a${'\u093E'.repeat(6)}`;
	const cases = ['\u0301', '\uFE0F', '⚡︎', width7];

	for (const grapheme of cases) {
		const output = new Output({width: 20, height: 1});
		output.write(0, 0, `${grapheme}X`, {
			transformers: [],
			selectable: true,
		});
		const result = output.get({capturePlainRows: true});
		const snapshot = {
			output: result.output,
			plainRows: result.plainRows ? [...result.plainRows] : undefined,
			maskRows: result.maskRows?.map(row => [...row]),
			maxVisualWidth: result.maxVisualWidth,
		};
		const encodedGrapheme = encode(grapheme);
		t.deepEqual(result.output, snapshot.output);
		t.deepEqual(result.plainRows, snapshot.plainRows);
		t.deepEqual(result.maskRows, snapshot.maskRows);
		t.is(result.maxVisualWidth, snapshot.maxVisualWidth);
		t.false(JSON.stringify(result).includes(']66;'));

		const measured = stringWidth(grapheme);
		t.is(result.maxVisualWidth, Math.max(1, measured) + 1);
		t.is(
			result.maskRows![0]!.filter(Boolean).length,
			Math.max(1, measured) + 1,
		);
		t.deepEqual(result.plainRows, [`${grapheme}X`]);

		if (measured >= 1 && measured <= 7) {
			t.is(encodedGrapheme, osc(measured, grapheme));
		} else {
			t.is(encodedGrapheme, grapheme);
			t.false(encodedGrapheme.includes(']66;'));
		}
	}
});

test.serial('warmed identical Unicode row adds zero segmentation work', t => {
	const encode = createExplicitWidthEncoder();
	const row = 'status \u26A1\uFE0E 界';
	const expected = `status ${osc(2, '\u26A1\uFE0E')} ${osc(2, '界')}`;
	const segmenter = instrumentSegmenter(t);

	t.is(encode(row), expected);
	const first = segmenter.stats();
	t.true(first.calls > 0);
	t.true(first.visited > 0);

	segmenter.reset();
	t.is(encode(row), expected);
	t.deepEqual(segmenter.stats(), {calls: 0, visited: 0});
});

test.serial(
	'new row of cached graphemes segments the row but not per-grapheme widths',
	t => {
		const encode = createExplicitWidthEncoder();
		const glyph = '界';
		const expectedGlyph = osc(2, glyph);
		const segmenter = instrumentSegmenter(t);

		t.is(encode(glyph), expectedGlyph);
		segmenter.reset();

		const row = `${glyph}A${glyph}`;
		t.is(encode(row), `${expectedGlyph}A${expectedGlyph}`);
		t.deepEqual(segmenter.stats(), {calls: 1, visited: 3});
	},
);

test.serial('independent factories do not share cache state', t => {
	const first = createExplicitWidthEncoder();
	const second = createExplicitWidthEncoder();
	const row = '界';
	const expected = osc(2, row);
	const segmenter = instrumentSegmenter(t);

	t.is(first(row), expected);
	segmenter.reset();
	t.is(second(row), expected);
	const stats = segmenter.stats();
	t.true(stats.calls > 0);
	t.true(stats.visited > 0);
});

test.serial('row cache evicts FIFO after 256 unique Unicode rows', t => {
	const encode = createExplicitWidthEncoder();
	const rows = Array.from({length: 257}, (_, index) =>
		String.fromCodePoint(0x4e00 + index),
	);
	const segmenter = instrumentSegmenter(t);

	for (const row of rows) {
		t.is(encode(row), osc(2, row));
	}

	segmenter.reset();
	t.is(encode(rows[0]!), osc(2, rows[0]!));
	// Only the row was evicted: all 257 grapheme widths remain cached.
	t.deepEqual(segmenter.stats(), {calls: 1, visited: 1});

	segmenter.reset();
	t.is(encode(rows[256]!), osc(2, rows[256]!));
	t.deepEqual(segmenter.stats(), {calls: 0, visited: 0});
});

test.serial(
	'grapheme cache evicts FIFO after 1024 distinct non-ASCII graphemes',
	t => {
		const encode = createExplicitWidthEncoder();
		const graphemes = Array.from({length: 1025}, (_, index) =>
			String.fromCodePoint(0x4e00 + index),
		);
		const segmenter = instrumentSegmenter(t);

		for (const grapheme of graphemes.slice(0, 1024)) {
			t.is(encode(grapheme), osc(2, grapheme));
		}

		// These indices exist in the fixed 1025-entry corpus above.
		const first = graphemes[0]!;
		const last = graphemes[1024]!;
		segmenter.reset();
		// A distinct row must miss the row cache. At capacity, the oldest
		// grapheme is still retained; reading it must not refresh FIFO order.
		t.is(encode(`${first}A`), `${osc(2, first)}A`);
		t.deepEqual(segmenter.stats(), {calls: 1, visited: 2});

		segmenter.reset();
		t.is(encode(last), osc(2, last));
		t.deepEqual(segmenter.stats(), {calls: 2, visited: 2});

		segmenter.reset();
		t.is(encode(`${first}B`), `${osc(2, first)}B`);
		// One row call visits two graphemes, one width call visits the evictee.
		t.deepEqual(segmenter.stats(), {calls: 2, visited: 3});

		segmenter.reset();
		t.is(encode(`${last}A`), `${osc(2, last)}A`);
		// Retained-grapheme probe also misses the row cache: no width work.
		t.deepEqual(segmenter.stats(), {calls: 1, visited: 2});
	},
);

test.serial('oversized Unicode rows skip row-cache retention', t => {
	const encode = createExplicitWidthEncoder();
	const glyph = '界';
	const row = glyph.repeat(1000);
	const expected = osc(2, glyph).repeat(1000);
	const segmenter = instrumentSegmenter(t);

	t.is(encode(row), expected);
	segmenter.reset();
	t.is(encode(row), expected);
	t.deepEqual(segmenter.stats(), {calls: 1, visited: 1000});
});

test.serial('grapheme cache admits at most 8192 key-plus-value bytes', t => {
	const encode = createExplicitWidthEncoder();
	const cases = [
		{grapheme: `a${'\u0301'.repeat(2043)}\u20D0`, bytes: 4090},
		{grapheme: `a${'\u0301'.repeat(2045)}`, bytes: 4091},
		{grapheme: `a${'\u0301'.repeat(2046)}\u20D0`, bytes: 4096},
	];
	const segmenter = instrumentSegmenter(t);

	for (const {grapheme, bytes} of cases) {
		const encoded = osc(1, grapheme);
		t.is(Buffer.byteLength(grapheme), bytes);
		const entryBytes = Buffer.byteLength(grapheme) + Buffer.byteLength(encoded);
		t.is(entryBytes, 2 * bytes + 11);
		// All payloads are eligible; 8191/8193 straddle the cache cap, and
		// the 4096-byte payload's 8203-byte entry must not be admitted either.
		segmenter.reset();
		t.is(encode(`A${grapheme}`), `A${encoded}`);
		t.deepEqual(segmenter.stats(), {calls: 2, visited: 3});

		segmenter.reset();
		// Distinct rows prevent a row-cache hit from hiding width work.
		t.is(encode(`B${grapheme}`), `B${encoded}`);
		t.deepEqual(
			segmenter.stats(),
			entryBytes <= 8192 ? {calls: 1, visited: 2} : {calls: 2, visited: 3},
		);
	}
});

test.serial(
	'oversized raw graphemes repeat row work but skip width work',
	t => {
		const encode = createExplicitWidthEncoder();
		const grapheme = `a${'\u0301'.repeat(10_000)}`;
		const segmenter = instrumentSegmenter(t);

		t.is(encode(grapheme), grapheme);
		t.deepEqual(segmenter.stats(), {calls: 1, visited: 1});
		segmenter.reset();
		t.is(encode(grapheme), grapheme);
		t.deepEqual(segmenter.stats(), {calls: 1, visited: 1});
	},
);

test.serial('ASCII-only input never calls Segmenter', t => {
	const encode = createExplicitWidthEncoder();
	const segmenter = instrumentSegmenter(t);
	const text = `${'plain ASCII log line\n'.repeat(200)}status ok`;
	t.is(encode(text), text);
	t.deepEqual(segmenter.stats(), {calls: 0, visited: 0});
});
