import process from 'node:process';
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import test, {type ExecutionContext} from 'ava';
import sinon from 'sinon';
import FakeTimers from '@sinonjs/fake-timers';
import React, {useEffect} from 'react';
import ansiEscapes from 'ansi-escapes';
import {
	render,
	Box,
	Static,
	Text,
	useStderr,
	useStdout,
	useWindowSize,
} from '../src/index.js';
import {type RenderOptions} from '../src/render.js';
import Ink from '../src/ink.js';
import instances from '../src/instances.js';
import {getWindowSize} from '../src/utils.js';
import {type LogUpdate} from '../src/log-update.js';
import {
	decawmOff,
	decawmOn,
	seekViewportReset,
	type PaintContext,
} from '../src/terminal-paint.js';
import Input from './helpers/create-readable-stdin.js';
import createStdout, {type FakeStdout} from './helpers/create-stdout.js';
import {
	Terminal,
	viewportLine,
	writeTerminal,
} from './helpers/terminal-model.js';

const csi = '\u001B[';
const ed2 = `${csi}2J`;
const ed3 = `${csi}3J`;
const home = `${csi}H`;
const homeAlt = `${csi}1;1H`;
const query = '\u001B[?6n';
const probe = '\u001B]66;w=1; \u001B\\\u001B[?6n\r';

type PendingFrameLike = {
	output: string;
	outputHeight: number;
	staticOutput: string;
	layoutColumns: number;
	layoutRows: number;
	maxVisualWidth?: number;
};

type InkInternals = {
	resolvePaintContext: (frame: PendingFrameLike) => PaintContext;
	log: LogUpdate;
	lastOutput: string;
	lastOutputToRender: string;
	lastOutputHeight: number;
	hasPhysicalFrame: boolean;
	lastPhysicalFrameWasSoftWrapped: boolean;
	writeToStdout: (data: string) => void;
	writeToStderr: (data: string) => void;
};

type TestTerminal = InstanceType<typeof Terminal>;

function SeekFrame({
	label,
	rows: rowsOverride,
}: {
	readonly label: string;
	readonly rows?: number;
}) {
	const {columns, rows: windowRows} = useWindowSize();
	const rows = rowsOverride ?? windowRows;
	return (
		<Box height={rows} width={columns} flexDirection="column">
			{Array.from({length: rows}, (_, index) => (
				<Text key={index}>
					{index === 0
						? label.slice(0, Math.max(1, columns))
						: `r${index}`.slice(0, Math.max(1, columns))}
				</Text>
			))}
		</Box>
	);
}

const emptyItems: string[] = [];

function OutputApp({
	label,
	items = emptyItems,
	onReady,
}: {
	readonly label: string;
	readonly items?: string[];
	readonly onReady?: (writers: {
		stdout: (data: string) => void;
		stderr: (data: string) => void;
	}) => void;
}) {
	const stdout = useStdout();
	const stderr = useStderr();
	useEffect(() => {
		onReady?.({
			stdout: stdout.write,
			stderr: stderr.write,
		});
	});
	return (
		<>
			<Static items={items}>{item => <Text key={item}>{item}</Text>}</Static>
			<SeekFrame label={label} />
		</>
	);
}

const inkOf = (stdout: FakeStdout): InkInternals =>
	instances.get(stdout) as unknown as InkInternals;

const stubResolvePaintContext = (
	t: ExecutionContext,
	stdout: FakeStdout,
	strategy: PaintContext['strategy'] = 'seek-viewport',
) => {
	const proto = Ink.prototype as unknown as {
		resolvePaintContext: (frame: PendingFrameLike) => PaintContext;
	};
	const stub = sinon.stub(proto, 'resolvePaintContext').callsFake(frame => {
		const {columns, rows} = getWindowSize(stdout);
		if (
			strategy === 'seek-viewport' &&
			frame.layoutColumns > 0 &&
			frame.layoutRows > 0 &&
			frame.outputHeight === rows
		) {
			return {strategy: 'seek-viewport', columns, rows};
		}

		return {strategy: 'raw', columns, rows};
	});
	t.teardown(() => {
		stub.restore();
	});
	return stub;
};

const wrapWrite = (stream: FakeStdout, onChunk: (text: string) => void) => {
	const originalWrite = stream.write;
	stream.write = (
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | (() => void),
		callback?: () => void,
	) => {
		const text = String(chunk);
		const done = typeof encoding === 'function' ? encoding : callback;
		onChunk(text);
		originalWrite.call(stream, text);
		done?.();
		return true;
	};
};

const attachTimeline = (streams: readonly FakeStdout[]) => {
	const timeline: string[] = [];
	for (const stream of streams) {
		wrapWrite(stream, text => {
			timeline.push(text);
		});
	}

	return timeline;
};

const createTerminal = (
	t: ExecutionContext,
	columns: number,
	rows: number,
	scrollback = 50,
): TestTerminal => {
	const terminal = new Terminal({
		cols: columns,
		rows,
		scrollback,
		allowProposedApi: true,
	});
	t.teardown(() => {
		terminal.dispose();
	});
	return terminal;
};

const historyText = (terminal: TestTerminal) => {
	const lines: string[] = [];
	for (let index = 0; index < terminal.buffer.active.baseY; index++) {
		lines.push(terminal.buffer.active.getLine(index)!.translateToString(false));
	}

	return lines.join('\n');
};

const allBufferText = (terminal: TestTerminal) => {
	const lines: string[] = [];
	for (let index = 0; index < terminal.buffer.active.length; index++) {
		lines.push(terminal.buffer.active.getLine(index)!.translateToString(false));
	}

	return lines.join('\n');
};

const count = (haystack: string, needle: string) =>
	haystack.split(needle).length - 1;

const spacer = (rows: number) => '\r\n'.repeat(rows);

const hasExactRowSpacer = (delta: string, rows: number) => {
	const sequence = spacer(rows);
	return delta.includes(sequence + home) || delta.includes(sequence + homeAlt);
};

const autowrapEnabledBefore = (delta: string, marker: string) => {
	const index = delta.indexOf(marker);
	if (index === -1) {
		return false;
	}

	const before = delta.slice(0, index);
	const lastOff = before.lastIndexOf(decawmOff);
	const lastOn = before.lastIndexOf(decawmOn);
	return lastOff === -1 || lastOn > lastOff;
};

const setup = (
	t: ExecutionContext,
	{
		columns = 8,
		rows = 4,
		label = 'TOP',
		items = [],
		maxFps = 1000,
		strategy = 'seek-viewport',
		patchConsole = false,
		alternateScreen = false,
		explicitWidth,
		env,
		stdin,
		onWrite,
	}: {
		columns?: number;
		rows?: number;
		label?: string;
		items?: string[];
		maxFps?: number;
		strategy?: PaintContext['strategy'] | 'auto';
		patchConsole?: boolean;
		alternateScreen?: boolean;
		explicitWidth?: 'auto' | 'disabled';
		env?: string;
		stdin?: Input;
		onWrite?: (text: string, input: Input) => void;
	} = {},
) => {
	const previous = process.env['INK_EXPLICIT_WIDTH'];
	if (env === undefined) {
		delete process.env['INK_EXPLICIT_WIDTH'];
	} else {
		process.env['INK_EXPLICIT_WIDTH'] = env;
	}

	const stdout = createStdout(columns);
	stdout.rows = rows;
	const stderr = createStdout(columns);
	stderr.rows = rows;
	const timeline = attachTimeline([stdout, stderr]);
	if (onWrite && stdin) {
		wrapWrite(stdout, text => {
			onWrite(text, stdin);
		});
	}

	if (strategy !== 'auto') {
		stubResolvePaintContext(t, stdout, strategy);
	}

	let writers:
		| {
				stdout: (data: string) => void;
				stderr: (data: string) => void;
		  }
		| undefined;
	const view = (nextLabel: string, nextItems: string[] = items) => (
		<OutputApp
			label={nextLabel}
			items={nextItems}
			onReady={next => {
				writers = next;
			}}
		/>
	);
	const quietStdin = new Input();
	quietStdin.isTTY = false;
	const options: RenderOptions = {
		stdout,
		stderr,
		stdin: (stdin ?? quietStdin) as unknown as NodeJS.ReadStream,
		interactive: true,
		incrementalRendering: true,
		patchConsole,
		exitOnCtrlC: false,
		maxFps,
		alternateScreen,
	};

	if (explicitWidth) {
		options.explicitWidth = explicitWidth;
	}

	const instance = render(view(label, items), options);
	const exitPromise = instance.waitUntilExit();
	const waitForWriters = async () => {
		const deadline = Date.now() + 1500;
		let ready = writers;
		while (!ready) {
			if (Date.now() >= deadline) {
				throw new Error('Timed out waiting for stdout/stderr writers');
			}

			// eslint-disable-next-line no-await-in-loop -- poll until the hook is ready
			await yieldImmediate();
			ready = writers;
		}

		return ready;
	};

	t.teardown(async () => {
		instance.unmount();
		await exitPromise;
		stdin?.destroy();
		quietStdin.destroy();
		if (previous === undefined) {
			delete process.env['INK_EXPLICIT_WIDTH'];
		} else {
			process.env['INK_EXPLICIT_WIDTH'] = previous;
		}
	});
	return {
		stdout,
		stderr,
		instance,
		timeline,
		columns,
		rows,
		ink: () => inkOf(stdout),
		waitForWriters,
		view,
		exitPromise,
	};
};

const replay = async (
	t: ExecutionContext,
	timeline: readonly string[],
	columns: number,
	rows: number,
) => {
	const terminal = createTerminal(t, columns, rows);
	await writeTerminal(terminal, timeline.join(''));
	return terminal;
};

test.serial(
	'useStdout keeps wrapped ordinary output in primary-screen history after seek restore',
	async t => {
		const columns = 8;
		const rows = 4;
		const {instance, timeline, ink, waitForWriters} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
		});
		await instance.waitUntilRenderFlush();
		const writers = await waitForWriters();
		t.true(ink().log.getPhysicalFrame()?.ownsViewport);

		const start = timeline.length;
		const message = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n';
		writers.stdout(message);
		const delta = timeline.slice(start).join('');
		t.true(delta.includes(message.trimEnd()), delta);
		t.true(autowrapEnabledBefore(delta, 'ABCDEFGH'), delta);
		t.true(hasExactRowSpacer(delta, rows), delta);
		t.false(delta.includes(ed3));
		t.false(delta.includes(ansiEscapes.clearTerminal));

		const terminal = await replay(t, timeline, columns, rows);
		t.true(viewportLine(terminal, 0).startsWith('VIEW'));
		t.true(viewportLine(terminal, 1).trimEnd().startsWith('r1'));
		const history = historyText(terminal);
		t.true(history.includes('ABCDEFGH'), history);
		t.true(history.includes('IJKLMNOP'), history);
		t.true(terminal.buffer.active.baseY > 0);
		t.true(ink().log.getPhysicalFrame()?.valid);
		t.true(ink().log.getPhysicalFrame()?.ownsViewport);
		// Extra blank history lines from the deliberate rows-CRLF spacer are accepted.
		t.true(count(history, '\n') >= 1);
	},
);

test.serial(
	'useStderr shares terminal ordering with stdout and survives restore',
	async t => {
		const columns = 8;
		const rows = 4;
		const {instance, timeline, waitForWriters, ink} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
		});
		await instance.waitUntilRenderFlush();
		const writers = await waitForWriters();

		const start = timeline.length;
		writers.stdout('OUTMSG\n');
		writers.stderr('ERRMSG\n');
		const delta = timeline.slice(start).join('');
		t.true(delta.indexOf('OUTMSG') < delta.indexOf('ERRMSG'), delta);
		t.true(hasExactRowSpacer(delta, rows), delta);
		t.true(autowrapEnabledBefore(delta, 'OUTMSG'), delta);
		t.true(autowrapEnabledBefore(delta, 'ERRMSG'), delta);

		const terminal = await replay(t, timeline, columns, rows);
		const history = historyText(terminal);
		t.true(history.includes('OUTMSG'), history);
		t.true(history.includes('ERRMSG'), history);
		t.true(history.indexOf('OUTMSG') < history.indexOf('ERRMSG'), history);
		t.true(viewportLine(terminal, 0).startsWith('VIEW'));
		t.true(ink().log.getPhysicalFrame()?.ownsViewport);
	},
);

test.serial(
	'patched console output is preserved around seek restoration',
	async t => {
		const columns = 8;
		const rows = 4;
		const {instance, timeline, ink} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
			patchConsole: true,
		});
		await instance.waitUntilRenderFlush();
		const start = timeline.length;
		console.log('CONSMSG');
		const delta = timeline.slice(start).join('');
		t.true(delta.includes('CONSMSG'), delta);
		t.true(hasExactRowSpacer(delta, rows), delta);

		const terminal = await replay(t, timeline, columns, rows);
		t.true(historyText(terminal).includes('CONSMSG'));
		t.true(viewportLine(terminal, 0).startsWith('VIEW'));
		t.true(ink().log.getPhysicalFrame()?.ownsViewport);
	},
);

test.serial(
	'Static deltas write once, stay in history, and do not replay on resize',
	async t => {
		const columns = 8;
		const rows = 4;
		const {stdout, instance, timeline, ink} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
			items: ['STA'],
		});
		await instance.waitUntilRenderFlush();
		t.is(count(timeline.join(''), 'STA'), 1);
		t.true(hasExactRowSpacer(timeline.join(''), rows));

		const start = timeline.length;
		stdout.columns = 6;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();
		const resizeDelta = timeline.slice(start).join('');
		t.is(count(resizeDelta, 'STA'), 0, resizeDelta);
		t.false(hasExactRowSpacer(resizeDelta, rows), resizeDelta);
		t.true(resizeDelta.includes(seekViewportReset), resizeDelta);

		instance.rerender(<OutputApp label="VIEW" items={['STA', 'STB']} />);
		await instance.waitUntilRenderFlush();
		const output = timeline.join('');
		t.is(count(output, 'STA'), 1, output);
		t.is(count(output, 'STB'), 1, output);

		const terminal = await replay(t, timeline, 6, rows);
		const history = historyText(terminal);
		t.true(history.includes('STA'), history);
		t.true(history.includes('STB'), history);
		t.true(viewportLine(terminal, 0).startsWith('VIEW'));
		t.true(ink().log.getPhysicalFrame()?.ownsViewport);
	},
);

test.serial(
	'pending Static, ordinary output, and resize keep Static exactly once',
	t => {
		const clock = FakeTimers.install({
			toFake: ['setTimeout', 'clearTimeout', 'Date'],
		});
		try {
			const columns = 8;
			const rows = 4;
			const {stdout, instance, timeline, ink} = setup(t, {
				columns,
				rows,
				label: 'OLDX',
				items: [],
				maxFps: 1,
			});
			t.true(timeline.join('').includes('OLDX'));

			instance.rerender(<OutputApp label="NEWX" items={['STATIC_P']} />);

			const start = timeline.length;
			ink().writeToStdout('ORDINARY\n');
			stdout.columns = 6;
			stdout.emit('resize');
			clock.tick(1000);

			const output = timeline.join('');
			t.is(count(output, 'STATIC_P'), 1, output);
			t.true(output.includes('ORDINARY'), output);
			t.true(hasExactRowSpacer(timeline.slice(start).join(''), rows));
			t.true(ink().log.getPhysicalFrame()?.ownsViewport);
			t.deepEqual(ink().log.getPhysicalFrame()?.context.columns, 6);
		} finally {
			clock.uninstall();
		}
	},
);

test.serial(
	'alternate-screen ordinary output remains disposable after restore',
	async t => {
		const columns = 8;
		const rows = 4;
		const {instance, timeline, waitForWriters} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
			alternateScreen: true,
		});
		await instance.waitUntilRenderFlush();
		const writers = await waitForWriters();
		t.true(timeline.join('').includes(ansiEscapes.enterAlternativeScreen));

		writers.stdout('ALTMSG\n');
		const beforeExit = timeline.join('');
		t.true(hasExactRowSpacer(beforeExit, rows));
		t.true(beforeExit.includes('ALTMSG'));

		const terminal = createTerminal(t, columns, rows);
		await writeTerminal(terminal, beforeExit);
		t.true(viewportLine(terminal, 0).startsWith('VIEW'));

		instance.unmount();
		await writeTerminal(terminal, timeline.join('').slice(beforeExit.length));
		// Alternate-screen contents are discarded with the screen; extra history is not kept.
		t.false(allBufferText(terminal).includes('ALTMSG'));
	},
);

test.serial(
	'ineligible fullscreen output keeps legacy restore without a seek spacer',
	async t => {
		const columns = 8;
		const rows = 4;
		const {instance, timeline, waitForWriters, ink} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
			strategy: 'raw',
			explicitWidth: 'disabled',
			env: '0',
		});
		await instance.waitUntilRenderFlush();
		const writers = await waitForWriters();
		t.falsy(ink().log.getPhysicalFrame()?.ownsViewport);

		const start = timeline.length;
		writers.stdout('LEGACY\n');
		writers.stderr('LEGERR\n');
		const delta = timeline.slice(start).join('');
		t.true(delta.includes('LEGACY'), delta);
		t.true(delta.includes('LEGERR'), delta);
		t.false(delta.includes(decawmOff), delta);
		t.false(hasExactRowSpacer(delta, rows), delta);
		t.false(delta.includes(seekViewportReset), delta);
		t.false(delta.includes(ed2), delta);

		const terminal = await replay(t, timeline, columns, rows);
		t.true(allBufferText(terminal).includes('LEGACY'));
		t.true(allBufferText(terminal).includes('VIEW'));
	},
);

test.serial(
	'public clear and unchanged seek updates do not emit the history spacer',
	async t => {
		const columns = 8;
		const rows = 4;
		const {stdout, instance, timeline, ink} = setup(t, {
			columns,
			rows,
			label: 'AAA',
		});
		await instance.waitUntilRenderFlush();

		let start = timeline.length;
		instance.clear();
		const clearDelta = timeline.slice(start).join('');
		t.true(clearDelta.includes(ed2), clearDelta);
		t.true(
			clearDelta.includes(home) || clearDelta.includes(homeAlt),
			clearDelta,
		);
		t.false(hasExactRowSpacer(clearDelta, rows), clearDelta);
		t.falsy(ink().log.getPhysicalFrame()?.valid);

		instance.rerender(<OutputApp label="BBB" />);
		await instance.waitUntilRenderFlush();
		t.true(ink().log.getPhysicalFrame()?.ownsViewport);

		start = timeline.length;
		instance.rerender(<OutputApp label="CCC" />);
		await instance.waitUntilRenderFlush();
		const changed = timeline.slice(start).join('');
		t.true(changed.includes('CCC') || ink().lastOutput.includes('CCC'));
		t.false(hasExactRowSpacer(changed, rows), changed);
		t.false(changed.includes(seekViewportReset), changed);

		start = timeline.length;
		stdout.columns = 6;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();
		const resizeDelta = timeline.slice(start).join('');
		t.true(resizeDelta.includes(seekViewportReset), resizeDelta);
		t.false(hasExactRowSpacer(resizeDelta, rows), resizeDelta);
		t.false(resizeDelta.includes(ed3), resizeDelta);
	},
);

test.serial(
	'public clear then ordinary write spacers so KEEPME survives restore',
	async t => {
		const columns = 8;
		const rows = 4;
		const {instance, timeline, waitForWriters, ink} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
		});
		await instance.waitUntilRenderFlush();
		const writers = await waitForWriters();
		t.true(ink().log.getPhysicalFrame()?.ownsViewport);

		instance.clear();
		t.falsy(ink().log.getPhysicalFrame()?.valid);

		const start = timeline.length;
		writers.stdout('KEEPME\n');
		const delta = timeline.slice(start).join('');
		t.true(delta.includes('KEEPME'), delta);
		t.true(hasExactRowSpacer(delta, rows), delta);

		const terminal = await replay(t, timeline, columns, rows);
		const history = historyText(terminal);
		t.true(history.includes('KEEPME'), history);
		t.true(viewportLine(terminal, 0).startsWith('VIEW'));
		t.true(ink().log.getPhysicalFrame()?.ownsViewport);
	},
);

test.serial(
	'resize during external output schedules a current layout after history advance',
	async t => {
		const columns = 8;
		const rows = 4;
		const {stdout, instance, timeline, ink, waitForWriters} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
		});
		await instance.waitUntilRenderFlush();
		const writers = await waitForWriters();
		t.deepEqual(ink().log.getPhysicalFrame()?.context, {
			strategy: 'seek-viewport',
			columns,
			rows,
		});

		const start = timeline.length;
		stdout.columns = 6;
		stdout.rows = 5;
		writers.stdout('RESIZE_OUT\n');
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();
		const delta = timeline.slice(start).join('');
		t.true(delta.includes('RESIZE_OUT'), delta);
		t.true(
			hasExactRowSpacer(delta, 5) || hasExactRowSpacer(delta, rows),
			delta,
		);

		const physical = ink().log.getPhysicalFrame();
		t.true(physical?.valid);
		t.true(physical?.ownsViewport);
		t.deepEqual(physical?.context.columns, 6);
		t.deepEqual(physical?.context.rows, 5);

		const terminal = createTerminal(t, 6, 5);
		await writeTerminal(terminal, delta);
		const history = historyText(terminal).replaceAll(/\s+/g, '');
		t.true(history.includes('RESIZE_OUT'), history);
		t.true(viewportLine(terminal, 0).startsWith('VIEW'));
	},
);

test.serial(
	'handled external write failure restores autowrap and does not claim a seek frame',
	async t => {
		const columns = 8;
		const rows = 4;
		const {stdout, instance, timeline, ink} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
		});
		await instance.waitUntilRenderFlush();
		t.true(ink().log.getPhysicalFrame()?.ownsViewport);

		const originalWrite = stdout.write;
		stdout.write = (chunk: string | Uint8Array) => {
			const text = String(chunk);
			if (text.includes('BOOM')) {
				throw new Error('external write failed');
			}

			return originalWrite.call(stdout, text);
		};

		try {
			const error = t.throws(() => {
				ink().writeToStdout('BOOM\n');
			});
			t.is(error?.message, 'external write failed');

			const output = timeline.join('');
			const lastOff = output.lastIndexOf(decawmOff);
			const lastOn = output.lastIndexOf(decawmOn);
			t.true(lastOn > lastOff, output);
			t.falsy(ink().log.getPhysicalFrame()?.valid);
			t.falsy(ink().log.getPhysicalFrame()?.ownsViewport);
			t.false(ink().hasPhysicalFrame);
		} finally {
			stdout.write = originalWrite;
		}
	},
);

test.serial(
	'unhandled restore failure does not pretend restoration succeeded',
	async t => {
		const columns = 8;
		const rows = 4;
		const {stdout, instance, timeline, ink, exitPromise} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
		});
		await instance.waitUntilRenderFlush();

		const originalWrite = stdout.write;
		stdout.write = (chunk: string | Uint8Array) => {
			const text = String(chunk);
			if (text.includes('EXTMSG')) {
				return originalWrite.call(stdout, text);
			}

			if (timeline.join('').includes('EXTMSG') && text.includes(decawmOff)) {
				throw new Error('restore write failed');
			}

			return originalWrite.call(stdout, text);
		};

		try {
			const error = t.throws(() => {
				ink().writeToStdout('EXTMSG\n');
			});
			t.is(error?.message, 'restore write failed');
			t.falsy(ink().log.getPhysicalFrame()?.valid);
			t.false(ink().hasPhysicalFrame);
			const lastOff = timeline.join('').lastIndexOf(decawmOff);
			const lastOn = timeline.join('').lastIndexOf(decawmOn);
			t.true(lastOn >= lastOff);
		} finally {
			stdout.write = originalWrite;
		}

		void exitPromise;
	},
);

test.serial(
	'ordinary output arriving during negotiation is restored after seek settlement',
	async t => {
		const columns = 8;
		const rows = 4;
		const stdin = new Input();
		const {instance, timeline, waitForWriters} = setup(t, {
			columns,
			rows,
			label: 'VIEW',
			strategy: 'auto',
			stdin,
			onWrite(text, input) {
				if (text === query || text === probe) {
					input.push('\u001B[?3;1R');
				}
			},
		});
		const writers = await waitForWriters();
		writers.stdout('DURING\n');
		await instance.waitUntilRenderFlush();

		const output = timeline.join('');
		t.true(output.includes('DURING'), output);
		t.true(output.includes(decawmOff), output);
		t.true(hasExactRowSpacer(output, rows), output);
		const terminal = await replay(t, timeline, columns, rows);
		t.true(historyText(terminal).includes('DURING'));
		t.true(viewportLine(terminal, 0).includes('VIEW'));
	},
);
