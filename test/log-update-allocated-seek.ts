import test, {type ExecutionContext} from 'ava';
import sinon from 'sinon';
import ansiEscapes from 'ansi-escapes';
import logUpdate from '../src/log-update.js';
import {
	createSeekPreparer,
	encodeSeekRow,
	prepareSeekRow,
} from '../src/allocated-seek.js';
import {type PaintContext, type PhysicalFrame} from '../src/terminal-paint.js';
import createStdout, {type FakeStdout} from './helpers/create-stdout.js';
import {
	Terminal,
	viewportLine,
	writeTerminal,
} from './helpers/terminal-model.js';

const csi = '\u001B[';
const decawmOff = `${csi}?7l`;
const decawmOn = `${csi}?7h`;
const ed2 = `${csi}2J`;
const home = `${csi}H`;
const hideCursor = `${csi}?25l`;
const showCursor = `${csi}?25h`;
const scrollRegion = new RegExp(`${String.fromCodePoint(0x1b)}\\[\\d+;\\d+r`);
const deleteLines = new RegExp(`${String.fromCodePoint(0x1b)}\\[\\d*M`);
const insertLines = new RegExp(`${String.fromCodePoint(0x1b)}\\[\\d*L`);

const context = {
	strategy: 'seek-viewport',
	columns: 8,
	rows: 3,
} as const satisfies PaintContext;

const frame = 'TOP\n👩‍👩⚡X\n123456界';

type TestTerminal = InstanceType<typeof Terminal>;

const instrumentSegmenter = (t: ExecutionContext) => {
	const {segment} = Intl.Segmenter.prototype;
	let calls = 0;
	const stub = sinon
		.stub(Intl.Segmenter.prototype, 'segment')
		.callsFake(function (this: Intl.Segmenter, input) {
			calls++;
			return segment.call(this, input);
		});
	t.teardown(() => {
		stub.restore();
	});

	return {
		reset() {
			calls = 0;
		},
		calls() {
			return calls;
		},
	};
};

const createSeekLog = (stdout: FakeStdout = createStdout(8)) => {
	stdout.rows = 3;
	const log = logUpdate.create(stdout, {
		incremental: true,
		showCursor: true,
	});
	return {stdout, log};
};

const createTerminal = (
	t: ExecutionContext,
	columns = context.columns,
	rows = context.rows,
): TestTerminal => {
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

const replayWrites = async (
	t: ExecutionContext,
	stdout: FakeStdout,
	columns = context.columns,
	rows = context.rows,
) => {
	const terminal = createTerminal(t, columns, rows);
	await writeTerminal(terminal, stdout.getWrites().join(''));
	t.is(terminal.buffer.active.baseY, 0);
	return terminal;
};

const lastWrite = (stdout: FakeStdout): string =>
	stdout.getWrites().at(-1) ?? '';

test('changed middle row seeks without rewriting neighbors', async t => {
	const {stdout, log} = createSeekLog();
	t.true(log(frame, context));
	const before = stdout.getWrites().length;
	t.true(log('TOP\nchanged\n123456界', context));
	const delta = stdout.getWrites().slice(before).join('');
	t.true(delta.includes(`${csi}2;1H`));
	t.false(delta.includes('TOP'));
	t.false(delta.includes('123456界'));
	t.true(delta.includes(encodeSeekRow(prepareSeekRow('changed', 8), 1, 8)));
	t.true(delta.includes(decawmOff));
	t.true(delta.includes(decawmOn));
	t.true(delta.indexOf(decawmOff) < delta.indexOf(decawmOn));
	t.false(scrollRegion.test(delta));

	const terminal = await replayWrites(t, stdout);
	t.true(viewportLine(terminal, 0).startsWith('TOP'));
	t.true(viewportLine(terminal, 1).startsWith('changed'));
	t.is(viewportLine(terminal, 2), '123456界');
});

test('identical seek frames do no segmentation or painting', t => {
	const {stdout, log} = createSeekLog();
	t.true(log(frame, context));
	t.true(log.getPhysicalFrame()?.valid);
	const writes = stdout.getWrites().length;
	const segmenter = instrumentSegmenter(t);
	segmenter.reset();
	t.false(log.willRender(frame, context));
	t.false(log(frame, context));
	t.is(stdout.getWrites().length, writes);
	t.is(segmenter.calls(), 0);
});

test('cursor-only seek updates use absolute CUP without DECAWM', t => {
	const {stdout, log} = createSeekLog();
	t.true(log(frame, context));
	log.setCursorPosition({x: 3, y: 1});
	t.true(log.willRender(frame, context));
	const before = stdout.getWrites().length;
	t.true(log(frame, context));
	const delta = stdout.getWrites().slice(before).join('');
	t.is(stdout.getWrites().length, before + 1);
	t.true(delta.includes(`${csi}2;4H`));
	t.true(delta.includes(showCursor));
	t.false(delta.includes(decawmOff));
	t.false(delta.includes(decawmOn));
	t.false(delta.includes('TOP'));
	t.false(delta.includes('changed'));
	t.false(delta.includes(`${csi}2K`));
});

test('same text at new dimensions paints every row', t => {
	const {stdout, log} = createSeekLog();
	t.true(log(frame, context));
	const wider = {strategy: 'seek-viewport', columns: 10, rows: 3} as const;
	t.true(log.willRender(frame, wider));
	const before = stdout.getWrites().length;
	t.true(log(frame, wider));
	const delta = stdout.getWrites().slice(before).join('');
	t.true(delta.includes(`${csi}1;1H`));
	t.true(delta.includes(`${csi}2;1H`));
	t.true(delta.includes(`${csi}3;1H`));
	t.true(delta.includes(decawmOff));
});

test('forced seek repaint paints every row', t => {
	const {stdout, log} = createSeekLog();
	t.true(log(frame, context));
	const before = stdout.getWrites().length;
	t.true(log.repaint(frame, undefined, context));
	const delta = stdout.getWrites().slice(before).join('');
	const prepared = createSeekPreparer().prepareFrame(frame, 8);
	t.true(delta.includes(`${csi}1;1H`));
	t.true(delta.includes(`${csi}2;1H`));
	t.true(delta.includes(`${csi}3;1H`));
	t.true(delta.includes('TOP'));
	t.true(delta.includes(encodeSeekRow(prepared[2]!, 2, 8)));
});

test('inherited style carry repaints dependents with the same logical text', async t => {
	const {stdout, log} = createSeekLog();
	const styled = '\u001B[41mhello\nworld!!!';
	const plain = 'hello\nworld!!!';
	t.true(log(styled, context));
	const before = stdout.getWrites().length;
	t.true(log(plain, context));
	const delta = stdout.getWrites().slice(before).join('');
	const prepared = createSeekPreparer().prepareFrame(plain, 8);
	t.true(delta.includes(`${csi}2;1H`));
	t.true(delta.includes(encodeSeekRow(prepared[1]!, 1, 8)));

	const terminal = await replayWrites(t, stdout);
	t.is(charsAt(terminal, 0, 0), 'h');
	t.true(cellAt(terminal, 1, 0).isBgDefault());
});

test('unsupported control in the last row emits nothing and does not acquire DECAWM', t => {
	const {stdout, log} = createSeekLog();
	t.true(log('TOP\nMIDDLE\nBOTTOM', context));
	const before = stdout.getWrites().length;
	const physical = log.getPhysicalFrame();
	t.throws(() => {
		log('TOP\nMIDDLE\nok\u001B[2Aunsafe', context);
	});
	t.is(stdout.getWrites().length, before);
	t.false(stdout.getWrites().slice(before).join('').includes(decawmOff));
	t.deepEqual(log.getPhysicalFrame(), physical);
});

test('zero-width fixture transitions keep allocated X and adjacent rows', async t => {
	const assertSample = async (text: string, column: number) => {
		const {stdout, log} = createSeekLog();
		t.true(log(`ABOVE___\nXXXXXXXX\nBELOW___`, context));
		t.true(log(`ABOVE___\n${text}\nBELOW___`, context));
		const terminal = await replayWrites(t, stdout);
		t.is(viewportLine(terminal, 0), 'ABOVE___');
		t.is(viewportLine(terminal, 2), 'BELOW___');
		t.is(charsAt(terminal, 1, column), 'X');

		const before = stdout.getWrites().length;
		t.true(log('ABOVE___\nchanged!\nBELOW___', context));
		const delta = stdout.getWrites().slice(before).join('');
		t.true(delta.includes(`${csi}2;1H`));
		t.false(delta.includes('ABOVE___'));
		t.false(delta.includes('BELOW___'));
		await writeTerminal(terminal, delta);
		t.is(viewportLine(terminal, 0), 'ABOVE___');
		t.is(viewportLine(terminal, 2), 'BELOW___');
		t.true(viewportLine(terminal, 1).startsWith('changed!'));
	};

	await assertSample('\u0301X', 1);
	await assertSample('\uFE0FX', 1);
	await assertSample('\u200BX', 1);
	await assertSample('A\u200BX', 2);
});

test('shifted seek frames use row diffs without scroll-region commands', t => {
	const tall = {strategy: 'seek-viewport', columns: 8, rows: 8} as const;
	const stdout = createStdout(8);
	stdout.rows = 8;
	const log = logUpdate.create(stdout, {
		incremental: true,
		showCursor: true,
	});
	const line = (index: number) => `row${String(index).padStart(2, '0')}xx`;
	const makeFrame = (start: number) =>
		Array.from({length: 8}, (_, index) => line(start + index)).join('\n');
	t.true(log(makeFrame(0), tall));
	const before = stdout.getWrites().length;
	t.true(log(makeFrame(1), tall));
	const delta = stdout.getWrites().slice(before).join('');
	t.false(scrollRegion.test(delta));
	t.false(deleteLines.test(delta));
	t.false(insertLines.test(delta));
	t.true(delta.includes(`${csi}1;1H`));
	t.true(delta.includes(line(8)));
	t.false(delta.includes(line(0)));
});

test('raw and osc66 contexts never select seek painting', t => {
	for (const strategy of ['raw', 'osc66'] as const) {
		const {stdout, log} = createSeekLog();
		t.true(log(frame, {strategy, columns: 8, rows: 3}));
		const written = stdout.getWrites().join('');
		t.false(written.includes(decawmOff));
		t.false(written.includes(`${csi}2;1H`));
		t.true(written.includes('TOP'));
		t.falsy(log.getPhysicalFrame());
	}
});

test('createStandard accepts seek arguments but never paints a seek viewport', t => {
	const stdout = createStdout(8);
	const log = logUpdate.create(stdout, {showCursor: true});
	t.is(log.getPhysicalFrame(), undefined);
	log.restoreTerminalModes();
	t.is(stdout.getWrites().length, 0);
	t.true(log(frame, context));
	t.false(stdout.getWrites().join('').includes(decawmOff));
	t.false(stdout.getWrites().join('').includes(`${csi}1;1H`));
	t.is(log.getPhysicalFrame(), undefined);
	log.sync(frame, {
		context,
		ownsViewport: true,
		valid: true,
		logicalRows: frame.split('\n'),
		allocatedWidths: [3, 5, 8],
		cursor: undefined,
	});
	t.is(log.getPhysicalFrame(), undefined);
	t.false(log.willRender(frame, context));
});

test('clear uses ED 2 plus home for an owned seek viewport', t => {
	const {stdout, log} = createSeekLog();
	t.true(log(frame, context));
	const before = stdout.getWrites().length;
	log.clear();
	const delta = stdout.getWrites().slice(before).join('');
	t.true(delta.includes(ed2));
	t.true(delta.includes(home) || delta.includes(`${csi}1;1H`));
	t.false(delta.includes(ansiEscapes.eraseLines(3)));
	t.false(log.getPhysicalFrame()?.valid);
	t.false(log.getPhysicalFrame()?.ownsViewport);
});

test('done does not use a relative cursor-return for a seek viewport', t => {
	const {stdout, log} = createSeekLog();
	log.setCursorPosition({x: 0, y: 0});
	t.true(log(frame, context));
	const before = stdout.getWrites().length;
	log.done();
	const delta = stdout.getWrites().slice(before).join('');
	t.false(delta.includes(ansiEscapes.cursorDown(1)));
	t.false(delta.includes(ansiEscapes.cursorDown(2)));
	t.true(delta.includes(showCursor));
	t.false(log.getPhysicalFrame()?.valid);
});

test('reset invalidates caches without clearing the screen', t => {
	const {stdout, log} = createSeekLog();
	t.true(log(frame, context));
	const writes = stdout.getWrites().length;
	log.reset();
	t.is(stdout.getWrites().length, writes);
	t.false(log.getPhysicalFrame()?.valid);
	t.true(log.willRender(frame, context));
});

test('sync never prepares or paints rows and cannot invent a seek viewport', t => {
	const {stdout, log} = createSeekLog();
	const segmenter = instrumentSegmenter(t);
	segmenter.reset();
	log.sync(frame);
	t.is(segmenter.calls(), 0);
	t.is(stdout.getWrites().length, 0);
	t.falsy(log.getPhysicalFrame()?.valid);
	t.true(log.willRender(frame, context));

	const matching: PhysicalFrame = {
		context,
		ownsViewport: true,
		valid: true,
		logicalRows: frame.split('\n'),
		allocatedWidths: [3, 5, 8],
		cursor: undefined,
	};
	log.sync(frame, matching);
	t.is(segmenter.calls(), 0);
	t.is(stdout.getWrites().length, 0);
	t.true(log.getPhysicalFrame()?.valid);
	t.false(log.willRender(frame, context));
});

test('write backpressure still publishes the physical frame', t => {
	const {stdout, log} = createSeekLog();
	const original = stdout.write.bind(stdout);
	stdout.write = (chunk: string) => {
		original(chunk);
		return false;
	};

	t.true(log(frame, context));
	t.true(log.getPhysicalFrame()?.valid);
	t.true(log.getPhysicalFrame()?.ownsViewport);
});

test('a write exception restores DECAWM and does not keep the previous frame', t => {
	const {stdout, log} = createSeekLog();
	t.true(log(frame, context));
	const original = stdout.write.bind(stdout);
	const before = stdout.getWrites().length;
	stdout.write = (chunk: string) => {
		if (String(chunk).includes(decawmOff)) {
			throw new Error('boom');
		}

		return original(chunk);
	};

	t.throws(
		() => {
			log('TOP\nchanged\n123456界', context);
		},
		{message: 'boom'},
	);
	t.true(stdout.getWrites().slice(before).join('').includes(decawmOn));
	t.false(log.getPhysicalFrame()?.valid);
});

test('reentrant clear during write does not publish the in-flight frame', t => {
	const {stdout, log} = createSeekLog();
	const original = stdout.write.bind(stdout);
	let reentered = false;
	stdout.write = (chunk: string) => {
		if (!reentered && String(chunk).includes(decawmOff)) {
			reentered = true;
			original(chunk);
			log.clear();
			return true;
		}

		return original(chunk);
	};

	t.true(log(frame, context));
	t.true(reentered);
	t.falsy(log.getPhysicalFrame()?.valid);
	t.falsy(log.getPhysicalFrame()?.ownsViewport);
});

test('seek write throw keeps teardown ownership for remaining seek cells', t => {
	const {stdout, log} = createSeekLog();
	log.setCursorPosition({x: 0, y: 0});
	t.true(log(frame, context));
	const original = stdout.write.bind(stdout);
	stdout.write = (chunk: string) => {
		if (String(chunk).includes(decawmOff)) {
			throw new Error('boom');
		}

		return original(chunk);
	};

	t.throws(
		() => {
			log('TOP\nchanged\n123456界', context);
		},
		{message: 'boom'},
	);
	t.false(log.getPhysicalFrame()?.valid);

	stdout.write = original;
	const before = stdout.getWrites().length;
	log.clear();
	const delta = stdout.getWrites().slice(before).join('');
	t.true(delta.includes(ed2));
	t.true(delta.includes(home) || delta.includes(`${csi}1;1H`));
	t.false(delta.includes(ansiEscapes.eraseLines(3)));
});

test('seek write throw does not use a relative cursor-return on done', t => {
	const {stdout, log} = createSeekLog();
	log.setCursorPosition({x: 0, y: 0});
	t.true(log(frame, context));
	const original = stdout.write.bind(stdout);
	stdout.write = (chunk: string) => {
		if (String(chunk).includes(decawmOff)) {
			throw new Error('boom');
		}

		return original(chunk);
	};

	t.throws(
		() => {
			log('TOP\nchanged\n123456界', context);
		},
		{message: 'boom'},
	);

	stdout.write = original;
	const before = stdout.getWrites().length;
	log.done();
	const delta = stdout.getWrites().slice(before).join('');
	t.false(delta.includes(ansiEscapes.cursorDown(1)));
	t.false(delta.includes(ansiEscapes.cursorDown(2)));
	t.false(delta.includes(ansiEscapes.cursorTo(0)));
	t.true(delta.includes(showCursor));
});

test('reentrant clear during first seek paint erases the in-flight viewport', t => {
	const {stdout, log} = createSeekLog();
	const original = stdout.write.bind(stdout);
	let reentered = false;
	stdout.write = (chunk: string) => {
		if (!reentered && String(chunk).includes(decawmOff)) {
			reentered = true;
			original(chunk);
			log.clear();
			return true;
		}

		return original(chunk);
	};

	t.true(log(frame, context));
	t.true(reentered);
	const written = stdout.getWrites().join('');
	t.true(written.includes(ed2));
	t.true(written.includes(home) || written.includes(`${csi}1;1H`));
	t.falsy(log.getPhysicalFrame()?.valid);
	t.falsy(log.getPhysicalFrame()?.ownsViewport);
});

test('first seek paint reports a valid owned physical frame', t => {
	const {stdout, log} = createSeekLog();
	t.true(log(frame, context));
	t.is(stdout.getWrites().length, 1);
	t.true(lastWrite(stdout).includes(decawmOff));
	t.true(lastWrite(stdout).endsWith(decawmOn));
	const physical = log.getPhysicalFrame();
	t.deepEqual(physical?.context, context);
	t.true(physical?.valid);
	t.true(physical?.ownsViewport);
	t.deepEqual([...physical!.logicalRows], frame.split('\n'));
	t.deepEqual([...physical!.allocatedWidths], [3, 5, 8]);
	t.is(physical?.cursor, undefined);
});

test('no active cursor is left hidden at the bottom-left cell', t => {
	const {stdout, log} = createSeekLog();
	t.true(log(frame, context));
	const written = lastWrite(stdout);
	t.true(written.includes(`${csi}3;1H`));
	t.true(written.includes(hideCursor));
	t.false(written.includes(showCursor));
});
