import {Buffer} from 'node:buffer';
import test, {type ExecutionContext} from 'ava';
import ansiEscapes from 'ansi-escapes';
import logUpdate from '../src/log-update.js';
import {createExplicitWidthEncoder} from '../src/explicit-width.js';
import Output from '../src/output.js';
import createStdout, {type FakeStdout} from './helpers/create-stdout.js';

const byteCount = (writes: string[]): number =>
	writes.reduce((sum, write) => sum + Buffer.byteLength(write, 'utf8'), 0);

const osc = (width: number, text: string): string =>
	`\u001B]66;w=${width};${text}\u001B\\`;

const showCursorEscape = '\u001B[?25h';
const hideCursorEscape = '\u001B[?25l';

type Instrumented = {
	stdout: FakeStdout;
	inputs: string[];
	render: ReturnType<typeof logUpdate.create>;
};

const createInstrumented = (
	options: {
		incremental?: boolean;
		transformOutput?: (text: string) => string;
	} = {},
): Instrumented => {
	const stdout = createStdout();
	const inputs: string[] = [];
	const encode = createExplicitWidthEncoder();
	const transformOutput =
		options.transformOutput ??
		((text: string) => {
			inputs.push(text);
			return encode(text);
		});
	const render = logUpdate.create(stdout, {
		showCursor: true,
		incremental: options.incremental,
		transformOutput,
	});
	return {stdout, inputs, render};
};

test('incremental hook runs only for written printable slices', t => {
	const stdout = createStdout();
	const inputs: string[] = [];
	const encode = createExplicitWidthEncoder();
	const render = logUpdate.create(stdout, {
		showCursor: true,
		incremental: true,
		transformOutput(text) {
			inputs.push(text);
			return encode(text);
		},
	});
	const frame = 'A\n⚡︎\nZ\n';
	t.true(render(frame));
	t.deepEqual(inputs, [frame]);
	const writes = stdout.getWrites().length;
	const bytes = byteCount(stdout.getWrites());
	t.false(render.willRender(frame));
	t.false(render(frame));
	t.deepEqual(inputs, [frame]);
	t.is(stdout.getWrites().length, writes);
	t.is(byteCount(stdout.getWrites()), bytes);

	t.true(render('A\n⚡️\nZ\n'));
	t.deepEqual(inputs, [frame, '⚡️']);
	t.is(
		stdout.get(),
		ansiEscapes.cursorUp(4 - 1) +
			ansiEscapes.cursorNextLine +
			ansiEscapes.cursorTo(0) +
			'\u001B]66;w=2;⚡️\u001B\\' +
			ansiEscapes.eraseEndLine +
			'\n' +
			ansiEscapes.cursorNextLine,
	);
});

for (const incremental of [false, true]) {
	const name = incremental ? 'incremental' : 'standard';

	test(`${name} omitted hook keeps exact writes and never emits OSC 66`, t => {
		const stdout = createStdout();
		const render = logUpdate.create(stdout, {
			showCursor: true,
			incremental,
		});
		t.true(render('Hello\n'));
		t.is(stdout.getWrites()[0], 'Hello\n');
		t.true(render('World ⚡︎\n'));
		t.false(render('World ⚡︎\n'));
		t.false(stdout.getWrites().join('').includes(']66;'));
		t.true(stdout.getWrites().join('').includes('⚡︎'));
	});
}

test('changed standard frame calls the hook once with the original frame', t => {
	const {stdout, inputs, render} = createInstrumented();
	const first = 'Hello\n';
	const second = 'World 界\n';
	t.true(render(first));
	t.deepEqual(inputs, [first]);
	t.is(stdout.getWrites().length, 1);
	t.true(render(second));
	t.deepEqual(inputs, [first, second]);
	t.is(stdout.getWrites().length, 2);
	t.true(stdout.get().includes(osc(2, '界')));
});

test('first incremental frame and reset use one full-frame call', t => {
	const {stdout, inputs, render} = createInstrumented({incremental: true});
	const frame = 'A\n界\n';
	t.true(render(frame));
	t.deepEqual(inputs, [frame]);
	t.is(stdout.getWrites()[0], `A\n${osc(2, '界')}\n`);
	render.reset();
	t.deepEqual(inputs, [frame]);
	t.true(render(frame));
	t.deepEqual(inputs, [frame, frame]);
	t.is(stdout.get(), `A\n${osc(2, '界')}\n`);
});

test('identical frame and willRender add zero hook calls or bytes', t => {
	const {stdout, inputs, render} = createInstrumented({incremental: true});
	const frame = 'A\n界\nZ\n';
	t.true(render(frame));
	const writes = stdout.getWrites().length;
	const bytes = byteCount(stdout.getWrites());
	t.false(render.willRender(frame));
	t.false(render(frame));
	t.deepEqual(inputs, [frame]);
	t.is(stdout.getWrites().length, writes);
	t.is(byteCount(stdout.getWrites()), bytes);
});

for (const incremental of [false, true]) {
	const name = incremental ? 'incremental' : 'standard';

	test(`${name} cursor-only change does not call the hook`, t => {
		const {stdout, inputs, render} = createInstrumented({incremental});
		const frame = 'Hello 界\n';
		render.setCursorPosition({x: 2, y: 0});
		t.true(render(frame));
		t.deepEqual(inputs, [frame]);
		t.deepEqual(stdout.getWrites(), [
			`Hello ${osc(2, '界')}\n` +
				ansiEscapes.cursorUp(1) +
				ansiEscapes.cursorTo(2) +
				showCursorEscape,
		]);
		const before = stdout.getWrites().length;
		render.setCursorPosition({x: 3, y: 0});
		t.true(render(frame));
		t.deepEqual(inputs, [frame]);
		t.deepEqual(stdout.getWrites().slice(before), [
			hideCursorEscape +
				ansiEscapes.cursorDown(1) +
				ansiEscapes.cursorTo(0) +
				ansiEscapes.cursorUp(1) +
				ansiEscapes.cursorTo(3) +
				showCursorEscape,
		]);
		const after = stdout.getWrites().length;
		t.false(render(frame));
		t.deepEqual(stdout.getWrites().slice(after), []);
		t.deepEqual(inputs, [frame]);
	});
}

test('surgical update transforms only changed written rows', t => {
	const {stdout, inputs, render} = createInstrumented({incremental: true});
	t.true(render('Line 1\nLine 2\nLine 3\n'));
	t.deepEqual(inputs, ['Line 1\nLine 2\nLine 3\n']);
	t.true(render('Line 1\nUpdated 界\nLine 3\n'));
	t.deepEqual(inputs, ['Line 1\nLine 2\nLine 3\n', 'Updated 界']);
	t.is(
		stdout.get(),
		ansiEscapes.cursorUp(3) +
			ansiEscapes.cursorNextLine +
			ansiEscapes.cursorTo(0) +
			`Updated ${osc(2, '界')}` +
			ansiEscapes.eraseEndLine +
			'\n' +
			ansiEscapes.cursorNextLine,
	);
});

test('shrink, grow, and blank rows transform only written slices', t => {
	const {inputs, render} = createInstrumented({incremental: true});
	t.true(render('Line 1\nLine 2\nLine 3\n'));
	t.true(render('Line 1\n'));
	t.deepEqual(inputs, ['Line 1\nLine 2\nLine 3\n']);
	t.true(render('Line 1\nLine 2\nLine 3\n'));
	t.deepEqual(inputs, ['Line 1\nLine 2\nLine 3\n', 'Line 2', 'Line 3']);
	t.true(render('Line 1\n\nLine 3\n'));
	t.deepEqual(inputs, ['Line 1\nLine 2\nLine 3\n', 'Line 2', 'Line 3', '']);
});

test('scroll shift up transforms only exposed edges', t => {
	const {stdout, inputs, render} = createInstrumented({incremental: true});
	const previous = ['row 1', 'row 2', 'row 3', 'row 4', 'row 5', 'row 6'];
	const next = ['row 3', 'row 4', 'row 5', 'row 6', 'new 7', '界'];
	t.true(render(previous.join('\n')));
	t.deepEqual(inputs, [previous.join('\n')]);
	const before = stdout.getWrites().length;
	t.true(render(next.join('\n')));
	t.deepEqual(inputs, [previous.join('\n'), 'new 7', '界']);
	t.deepEqual(stdout.getWrites().slice(before), [
		'\u001B[1;6r\u001B[1;1H\u001B[2M\u001B[r\u001B[1;1H' +
			ansiEscapes.cursorNextLine.repeat(4) +
			ansiEscapes.cursorTo(0) +
			'new 7' +
			ansiEscapes.eraseEndLine +
			'\n' +
			ansiEscapes.cursorTo(0) +
			osc(2, '界') +
			ansiEscapes.eraseEndLine,
	]);
});

test('scroll shift down transforms only exposed edges', t => {
	const {stdout, inputs, render} = createInstrumented({incremental: true});
	const previous = ['row 1', 'row 2', 'row 3', 'row 4', 'row 5', 'row 6'];
	const next = ['界', 'new 1', 'row 1', 'row 2', 'row 3', 'row 4'];
	t.true(render(previous.join('\n')));
	const before = stdout.getWrites().length;
	t.true(render(next.join('\n')));
	t.deepEqual(inputs, [previous.join('\n'), '界', 'new 1']);
	t.deepEqual(stdout.getWrites().slice(before), [
		'\u001B[1;6r\u001B[1;1H\u001B[2L\u001B[r\u001B[1;1H' +
			ansiEscapes.cursorTo(0) +
			osc(2, '界') +
			ansiEscapes.eraseEndLine +
			'\n' +
			ansiEscapes.cursorTo(0) +
			'new 1' +
			ansiEscapes.eraseEndLine +
			'\n' +
			ansiEscapes.cursorNextLine.repeat(3),
	]);
});

test('sticky chrome scroll keeps footer rows out of the hook', t => {
	const {stdout, inputs, render} = createInstrumented({incremental: true});
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
		'b9 界',
		'COMPOSER STATUS',
		'COMPOSER INPUT',
	];
	t.true(render(previous.join('\n')));
	const before = stdout.getWrites().length;
	t.true(render(nextUp.join('\n')));
	t.deepEqual(inputs, [previous.join('\n'), 'b9 界']);
	t.deepEqual(stdout.getWrites().slice(before), [
		'\u001B[2;9r\u001B[2;1H\u001B[1M\u001B[r\u001B[2;1H' +
			ansiEscapes.cursorNextLine.repeat(7) +
			ansiEscapes.cursorTo(0) +
			`b9 ${osc(2, '界')}` +
			ansiEscapes.eraseEndLine +
			'\n' +
			ansiEscapes.cursorNextLine,
	]);
});

for (const incremental of [false, true]) {
	const name = incremental ? 'incremental' : 'standard';

	test(`${name} forced repaint encodes the original frame once`, t => {
		const {stdout, inputs, render} = createInstrumented({incremental});
		const frame = 'A\n界\nZ\n';
		t.true(render(frame));
		const before = stdout.getWrites().length;
		t.true(render.repaint(frame, {eraseLineCount: 7}));
		t.deepEqual(inputs, [frame, frame]);
		t.deepEqual(stdout.getWrites().slice(before), [
			ansiEscapes.eraseLines(7) + `A\n${osc(2, '界')}\nZ\n`,
		]);
		t.false(render(frame));
		t.deepEqual(inputs, [frame, frame]);
		t.true(render('A\n⚡️\nZ\n'));
		if (incremental) {
			t.deepEqual(inputs, [frame, frame, '⚡️']);
		} else {
			t.deepEqual(inputs, [frame, frame, 'A\n⚡️\nZ\n']);
		}
	});
}

for (const incremental of [false, true]) {
	const name = incremental ? 'incremental' : 'standard';

	test(`${name} lifecycle methods do not call the hook`, t => {
		const {stdout, inputs, render} = createInstrumented({incremental});
		const frame = 'Hello 界\n';
		const encodedFrame = `Hello ${osc(2, '界')}\n`;
		let before = stdout.getWrites().length;
		render.sync(frame);
		t.deepEqual(stdout.getWrites().slice(before), []);
		t.deepEqual(inputs, []);
		before = stdout.getWrites().length;
		t.false(render(frame));
		t.deepEqual(stdout.getWrites().slice(before), []);
		t.deepEqual(inputs, []);
		before = stdout.getWrites().length;
		render.reset();
		t.deepEqual(stdout.getWrites().slice(before), []);
		t.deepEqual(inputs, []);
		before = stdout.getWrites().length;
		t.true(render(frame));
		t.deepEqual(stdout.getWrites().slice(before), [encodedFrame]);
		t.deepEqual(inputs, [frame]);
		before = stdout.getWrites().length;
		render.clear();
		t.deepEqual(stdout.getWrites().slice(before), [ansiEscapes.eraseLines(2)]);
		t.deepEqual(inputs, [frame]);
		before = stdout.getWrites().length;
		t.true(render(frame));
		t.deepEqual(stdout.getWrites().slice(before), [encodedFrame]);
		t.deepEqual(inputs, [frame, frame]);
		before = stdout.getWrites().length;
		render.done();
		t.deepEqual(stdout.getWrites().slice(before), [showCursorEscape]);
		t.deepEqual(inputs, [frame, frame]);
		before = stdout.getWrites().length;
		t.true(render(frame));
		t.deepEqual(stdout.getWrites().slice(before), [encodedFrame]);
		t.deepEqual(inputs, [frame, frame, frame]);
	});
}

test('direct stream writes bypass the hook', t => {
	const {stdout, inputs, render} = createInstrumented({incremental: true});
	const frame = 'visible 界\n';
	t.true(render(frame));
	const before = inputs.length;
	const clipboard = '\u001B]52;c;YWJj\u0007';
	stdout.write(clipboard);
	stdout.write('⚡︎ arbitrary \u001B[31mcontrol');
	t.is(inputs.length, before);
	t.true(stdout.getWrites().includes(clipboard));
	t.is(stdout.getWrites().at(-1), '⚡︎ arbitrary \u001B[31mcontrol');
});

test('plain comparison ignores non-injective encoded output', t => {
	const stdout = createStdout();
	const inputs: string[] = [];
	const render = logUpdate.create(stdout, {
		showCursor: true,
		incremental: true,
		transformOutput(text) {
			inputs.push(text);
			return 'FIXED';
		},
	});
	t.true(render('A\nB\n'));
	t.true(render('A\nC\n'));
	t.deepEqual(inputs, ['A\nB\n', 'C']);
	t.false(render('A\nC\n'));
	t.deepEqual(inputs, ['A\nB\n', 'C']);
});

test('hook receives original slices, not generated cursor controls', t => {
	const {stdout, inputs, render} = createInstrumented({incremental: true});
	const styled = '\u001B[31m界\u001B[0m';
	t.true(render(`${styled}\nnext\n`));
	t.deepEqual(inputs, [`${styled}\nnext\n`]);
	t.true(render(`${styled}\n⚡︎\n`));
	t.deepEqual(inputs, [`${styled}\nnext\n`, '⚡︎']);
	t.false(inputs.some(input => input.includes(ansiEscapes.cursorUp(1))));
	t.false(inputs.some(input => input.includes(ansiEscapes.eraseEndLine)));
	t.true(stdout.getWrites()[0]!.includes(`\u001B[31m${osc(2, '界')}\u001B[0m`));
});

const logPair = (
	t: ExecutionContext,
	mode: string,
	phase: string,
	encoderCalls: number,
	plainWrites: string[],
	encodedWrites: string[],
	emittedEligibleGraphemes: number,
) => {
	const writes = encodedWrites.length;
	const plainBytes = byteCount(plainWrites);
	const encodedBytes = byteCount(encodedWrites);
	t.log({mode, phase, encoderCalls, writes, plainBytes, encodedBytes});
	t.is(encodedBytes, plainBytes + 11 * emittedEligibleGraphemes);
	return {plainBytes, encodedBytes};
};

const sliceWrites = (stdout: FakeStdout, before: number): string[] =>
	stdout.getWrites().slice(before);

for (const incremental of [false, true]) {
	const mode = incremental ? 'incremental' : 'standard';

	test(`${mode} paired ASCII and Unicode byte and work accounting`, t => {
		const plain = createStdout();
		const encoded = createStdout();
		const inputs: string[] = [];
		const encode = createExplicitWidthEncoder();
		const plainRender = logUpdate.create(plain, {
			showCursor: true,
			incremental,
		});
		const encodedRender = logUpdate.create(encoded, {
			showCursor: true,
			incremental,
			transformOutput(text) {
				inputs.push(text);
				return encode(text);
			},
		});

		const run = (
			phase: string,
			frame: string,
			eligible: number,
			expectedCalls: number,
			expectedPlainWrites: string[],
			method: 'render' | 'repaint' = 'render',
		) => {
			const plainBefore = plain.getWrites().length;
			const encodedBefore = encoded.getWrites().length;
			const inputBefore = inputs.length;
			if (method === 'repaint') {
				plainRender.repaint(frame);
				encodedRender.repaint(frame);
			} else {
				plainRender(frame);
				encodedRender(frame);
			}

			const encodedSlice = sliceWrites(encoded, encodedBefore);
			t.deepEqual(sliceWrites(plain, plainBefore), expectedPlainWrites);
			t.deepEqual(
				encodedSlice,
				expectedPlainWrites.map(write =>
					write.replaceAll('界', osc(2, '界')).replaceAll('中', osc(2, '中')),
				),
			);
			logPair(
				t,
				mode,
				phase,
				inputs.length - inputBefore,
				sliceWrites(plain, plainBefore),
				encodedSlice,
				eligible,
			);
			t.is(inputs.length - inputBefore, expectedCalls);
		};

		run('ascii-first', 'A\nB\nC\nD\nE\nF', 0, 1, ['A\nB\nC\nD\nE\nF']);
		run('ascii-identical', 'A\nB\nC\nD\nE\nF', 0, 0, []);
		const fullUnicodeWrite = ansiEscapes.eraseLines(6) + 'A\nB\n界\nD\nE\nF';
		run('unicode-row', 'A\nB\n界\nD\nE\nF', 1, 1, [
			incremental
				? ansiEscapes.cursorUp(5) +
					ansiEscapes.cursorNextLine.repeat(2) +
					ansiEscapes.cursorTo(0) +
					'界' +
					ansiEscapes.eraseEndLine +
					'\n' +
					ansiEscapes.cursorNextLine.repeat(2)
				: fullUnicodeWrite,
		]);
		run('unicode-identical', 'A\nB\n界\nD\nE\nF', 0, 0, []);
		run(
			'unicode-repaint',
			'A\nB\n界\nD\nE\nF',
			1,
			1,
			[fullUnicodeWrite],
			'repaint',
		);
		run('unicode-after-repaint-skip', 'A\nB\n界\nD\nE\nF', 0, 0, []);
		run(
			'shift-or-redraw',
			'界\nD\nE\nF\nG\n中',
			incremental ? 1 : 2,
			incremental ? 2 : 1,
			[
				incremental
					? '\u001B[1;6r\u001B[1;1H\u001B[2M\u001B[r\u001B[1;1H' +
						ansiEscapes.cursorNextLine.repeat(4) +
						ansiEscapes.cursorTo(0) +
						'G' +
						ansiEscapes.eraseEndLine +
						'\n' +
						ansiEscapes.cursorTo(0) +
						'中' +
						ansiEscapes.eraseEndLine
					: ansiEscapes.eraseLines(6) + '界\nD\nE\nF\nG\n中',
			],
		);
	});
}

test('clipped hidden suffixes never enter the hook', t => {
	const encode = createExplicitWidthEncoder();
	const inputs: string[] = [];
	const hook = (text: string): string => {
		inputs.push(text);
		return encode(text);
	};
	const sizes: number[] = [];
	for (const length of [100, 10_000, 100_000]) {
		const output = new Output({width: 10, height: 1});
		output.clip({x1: 0, x2: 10, y1: 0, y2: 1});
		output.write(0, 0, `visible${'X'.repeat(length)}`, {
			transformers: [],
		});
		output.unclip();
		const result = output.get();
		sizes.push(Buffer.byteLength(result.output, 'utf8'));
		hook(result.output);
		t.false(result.output.includes('X'.repeat(20)));
		t.true(result.output.includes('visible'));
	}

	t.is(sizes[0], sizes[1]);
	t.is(sizes[1], sizes[2]);
	t.is(inputs[0], inputs[1]);
	t.is(inputs[1], inputs[2]);
	t.true(sizes.every(size => size <= 32));
});
