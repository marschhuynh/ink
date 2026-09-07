import test, {type ExecutionContext} from 'ava';
import sinon from 'sinon';
import FakeTimers from '@sinonjs/fake-timers';
import React from 'react';
import ansiEscapes from 'ansi-escapes';
import {render, Box, Text, useWindowSize} from '../src/index.js';
import Ink from '../src/ink.js';
import instances from '../src/instances.js';
import {getWindowSize} from '../src/utils.js';
import {type LogUpdate} from '../src/log-update.js';
import {type PaintContext} from '../src/terminal-paint.js';
import createStdout, {type FakeStdout} from './helpers/create-stdout.js';
import {
	Terminal,
	viewportLine,
	writeTerminal,
} from './helpers/terminal-model.js';

const csi = '\u001B[';
const decawmOff = `${csi}?7l`;
const ed2 = `${csi}2J`;
const ed3 = `${csi}3J`;
const home = `${csi}H`;
const closeLink = '\u001B]8;;\u001B\\';
const sgrReset = `${csi}0m`;
const seekEntry = `${closeLink}${sgrReset}${ed2}${home}`;
const cursorUp = new RegExp(`${String.fromCodePoint(0x1b)}\\[\\d+A`);

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
	throttledOnRender?: {cancel: () => void; flush: () => void};
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

function WrappedRawFrame() {
	return (
		<Box width={16} minWidth={16} flexShrink={0} flexDirection="column">
			<Text>ABCDEFGHIJKLMNOP</Text>
			<Text>1234567890123456</Text>
		</Box>
	);
}

const inkOf = (stdout: FakeStdout): InkInternals =>
	instances.get(stdout) as unknown as InkInternals;

const stubResolvePaintContext = (
	t: ExecutionContext,
	stdout: FakeStdout,
	resolve?: (frame: PendingFrameLike) => PaintContext,
) => {
	const proto = Ink.prototype as unknown as {
		resolvePaintContext: (frame: PendingFrameLike) => PaintContext;
	};
	const stub = sinon.stub(proto, 'resolvePaintContext').callsFake(frame => {
		if (resolve) {
			return resolve(frame);
		}

		const {columns, rows} = getWindowSize(stdout);
		if (
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

const setup = (
	t: ExecutionContext,
	{
		columns = 8,
		rows = 4,
		label = 'TOP',
		maxFps = 1000,
		resolve,
	}: {
		columns?: number;
		rows?: number;
		label?: string;
		maxFps?: number;
		resolve?: (frame: PendingFrameLike) => PaintContext;
	} = {},
) => {
	const stdout = createStdout(columns);
	stdout.rows = rows;

	stubResolvePaintContext(t, stdout, resolve);
	const instance = render(<SeekFrame label={label} />, {
		stdout,
		interactive: true,
		incrementalRendering: true,
		patchConsole: false,
		exitOnCtrlC: false,
		maxFps,
	});
	const exitPromise = instance.waitUntilExit();
	t.teardown(async () => {
		instance.unmount();
		await exitPromise;
	});
	return {stdout, instance, ink: () => inkOf(stdout)};
};

const joinedFrom = (stdout: FakeStdout, start: number): string =>
	stdout.getWrites().slice(start).join('');

const physicalMatches = (
	stdout: FakeStdout,
	context: {columns?: number; rows?: number},
) => {
	const physical = inkOf(stdout).log.getPhysicalFrame();
	return (
		Boolean(physical?.valid) &&
		Boolean(physical?.ownsViewport) &&
		(context.columns === undefined ||
			physical?.context.columns === context.columns) &&
		(context.rows === undefined || physical?.context.rows === context.rows)
	);
};

const waitForPhysical = async (
	instance: ReturnType<typeof render>,
	stdout: FakeStdout,
	context: {columns?: number; rows?: number},
) => {
	await instance.waitUntilRenderFlush();
	if (physicalMatches(stdout, context)) {
		return;
	}

	await instance.waitUntilRenderFlush();
	if (physicalMatches(stdout, context)) {
		return;
	}

	throw new Error(
		`Timed out waiting for physical frame ${JSON.stringify(context)}, got ${JSON.stringify(inkOf(stdout).log.getPhysicalFrame()?.context)}`,
	);
};

const createTerminal = (
	t: ExecutionContext,
	columns: number,
	rows: number,
	scrollback = 20,
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

const historyLine = (terminal: TestTerminal, index: number) =>
	terminal.buffer.active.getLine(index)!.translateToString(false);

test.serial('width shrink repaints the seek viewport without ED 3', async t => {
	const {stdout, instance} = setup(t, {columns: 8, rows: 4, label: 'ABCD'});
	await instance.waitUntilRenderFlush();
	t.true(stdout.getWrites().join('').includes(decawmOff));
	t.true(inkOf(stdout).log.getPhysicalFrame()?.ownsViewport);

	const start = stdout.getWrites().length;
	stdout.columns = 5;
	stdout.emit('resize');
	await waitForPhysical(instance, stdout, {columns: 5, rows: 4});

	const delta = joinedFrom(stdout, start);
	t.true(delta.includes(seekEntry));
	t.false(delta.includes(ed3));
	t.false(delta.includes(ansiEscapes.clearTerminal));
	t.false(delta.includes(ansiEscapes.eraseLines(4)));
	t.false(delta.includes(ansiEscapes.eraseLines(5)));
	t.true(delta.includes(decawmOff));
	t.true(delta.includes(`${csi}1;1H`));
	t.true(delta.includes(`${csi}4;1H`));
	const physical = inkOf(stdout).log.getPhysicalFrame();
	t.true(physical?.valid);
	t.true(physical?.ownsViewport);
	t.deepEqual(physical?.context, {
		strategy: 'seek-viewport',
		columns: 5,
		rows: 4,
	});
	t.is(inkOf(stdout).lastOutputToRender.includes('\n'), true);
	t.false(inkOf(stdout).lastPhysicalFrameWasSoftWrapped);
});

test.serial('width growth repaints the seek viewport without ED 3', async t => {
	const {stdout, instance} = setup(t, {columns: 5, rows: 4, label: 'AB'});
	await instance.waitUntilRenderFlush();

	const start = stdout.getWrites().length;
	stdout.columns = 8;
	stdout.emit('resize');
	await waitForPhysical(instance, stdout, {columns: 8, rows: 4});

	const delta = joinedFrom(stdout, start);
	t.true(delta.includes(seekEntry));
	t.false(delta.includes(ed3));
	t.false(delta.includes(ansiEscapes.clearTerminal));
	t.false(delta.includes(ansiEscapes.eraseLines(4)));
	t.deepEqual(inkOf(stdout).log.getPhysicalFrame()?.context, {
		strategy: 'seek-viewport',
		columns: 8,
		rows: 4,
	});
});

test.serial(
	'height shrink repaints the seek viewport without ED 3',
	async t => {
		const {stdout, instance} = setup(t, {columns: 8, rows: 5, label: 'TOP'});
		await instance.waitUntilRenderFlush();

		const start = stdout.getWrites().length;
		stdout.rows = 3;
		stdout.emit('resize');
		await waitForPhysical(instance, stdout, {columns: 8, rows: 3});

		const delta = joinedFrom(stdout, start);
		t.true(delta.includes(seekEntry));
		t.false(delta.includes(ed3));
		t.false(delta.includes(ansiEscapes.clearTerminal));
		t.false(delta.includes(ansiEscapes.eraseLines(5)));
		t.true(delta.includes(`${csi}3;1H`));
		t.false(delta.includes(`${csi}5;1H`));
		t.deepEqual(inkOf(stdout).log.getPhysicalFrame()?.context, {
			strategy: 'seek-viewport',
			columns: 8,
			rows: 3,
		});
	},
);

test.serial(
	'height growth repaints the seek viewport without ED 3',
	async t => {
		const {stdout, instance} = setup(t, {columns: 8, rows: 3, label: 'TOP'});
		await instance.waitUntilRenderFlush();

		const start = stdout.getWrites().length;
		stdout.rows = 5;
		stdout.emit('resize');
		await waitForPhysical(instance, stdout, {columns: 8, rows: 5});

		const delta = joinedFrom(stdout, start);
		t.true(delta.includes(seekEntry));
		t.false(delta.includes(ed3));
		t.false(delta.includes(ansiEscapes.clearTerminal));
		t.true(delta.includes(`${csi}5;1H`));
		t.deepEqual(inkOf(stdout).log.getPhysicalFrame()?.context, {
			strategy: 'seek-viewport',
			columns: 8,
			rows: 5,
		});
	},
);

test.serial(
	'identical text after a dimension change still does a full seek repaint',
	async t => {
		const {stdout, instance} = setup(t, {columns: 8, rows: 4, label: 'SAME'});
		await instance.waitUntilRenderFlush();
		const before = inkOf(stdout).lastOutput;

		const start = stdout.getWrites().length;
		stdout.columns = 6;
		stdout.emit('resize');
		await waitForPhysical(instance, stdout, {columns: 6, rows: 4});

		const delta = joinedFrom(stdout, start);
		t.true(delta.includes(seekEntry));
		t.true(delta.includes(`${csi}1;1H`));
		t.true(delta.includes(`${csi}4;1H`));
		t.true(inkOf(stdout).lastOutput.includes('SAME'));
		t.true(before.includes('SAME'));
	},
);

test.serial(
	'resize between scheduling and write does not emit the stale frame',
	t => {
		const clock = FakeTimers.install({
			toFake: ['setTimeout', 'clearTimeout', 'Date'],
		});
		try {
			const stdout = createStdout(8);
			stdout.rows = 4;
			stubResolvePaintContext(t, stdout);
			const instance = render(<SeekFrame label="OLDX" />, {
				stdout,
				interactive: true,
				incrementalRendering: true,
				patchConsole: false,
				exitOnCtrlC: false,
				maxFps: 1,
			});
			t.teardown(() => {
				instance.unmount();
			});
			t.true(stdout.getWrites().join('').includes('OLDX'));

			instance.rerender(<SeekFrame label="NEWX" />);
			t.false(stdout.getWrites().join('').includes('NEWX'));

			const start = stdout.getWrites().length;
			stdout.columns = 5;
			stdout.emit('resize');
			clock.tick(1000);

			const delta = joinedFrom(stdout, start);
			t.false(delta.includes(`${csi}1;9H`));
			t.true(delta.includes('NEWX') || delta.includes('NEW'));
			t.true(delta.includes(seekEntry));
			t.false(delta.includes(ed3));
			t.deepEqual(inkOf(stdout).log.getPhysicalFrame()?.context.columns, 5);
		} finally {
			clock.uninstall();
		}
	},
);

test.serial('a cancelled queued frame does not write', t => {
	const clock = FakeTimers.install({
		toFake: ['setTimeout', 'clearTimeout', 'Date'],
	});
	try {
		const stdout = createStdout(8);
		stdout.rows = 4;
		stubResolvePaintContext(t, stdout);
		const instance = render(<SeekFrame label="KEEP" />, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			patchConsole: false,
			exitOnCtrlC: false,
			maxFps: 1,
		});
		t.teardown(() => {
			instance.unmount();
		});

		instance.rerender(<SeekFrame label="DROP" />);
		t.false(stdout.getWrites().join('').includes('DROP'));
		const writes = stdout.getWrites().length;
		inkOf(stdout).throttledOnRender!.cancel();
		clock.tick(1000);
		t.is(stdout.getWrites().length, writes);
		t.false(stdout.getWrites().join('').includes('DROP'));
	} finally {
		clock.uninstall();
	}
});

test.serial(
	'primary-screen resize preserves history and does not use relative erase',
	async t => {
		const columns = 8;
		const rows = 4;
		const {stdout, instance} = setup(t, {columns, rows, label: 'VIEW'});
		await instance.waitUntilRenderFlush();

		const terminal = createTerminal(t, columns, rows);
		await writeTerminal(
			terminal,
			'SAVED_A\nSAVED_B\nSAVED_C\nSAVED_D\nSAVED_E\n',
		);
		const saved = historyLine(terminal, 0);
		t.true(saved.includes('SAVED'));

		await writeTerminal(terminal, stdout.getWrites().join(''));
		t.true(viewportLine(terminal, 0).startsWith('VIEW'));
		t.is(terminal.buffer.active.baseY > 0, true);

		const start = stdout.getWrites().length;
		stdout.columns = 6;
		stdout.emit('resize');
		await waitForPhysical(instance, stdout, {columns: 6, rows: 4});
		const delta = joinedFrom(stdout, start);
		t.false(delta.includes(ed3));
		t.false(delta.includes(ansiEscapes.clearTerminal));
		t.false(cursorUp.test(delta));

		terminal.resize(6, rows);
		await writeTerminal(terminal, delta);
		t.is(viewportLine(terminal, 0).trimEnd(), 'VIEW');
		t.is(viewportLine(terminal, 1).trimEnd(), 'r1');
		t.is(viewportLine(terminal, 2).trimEnd(), 'r2');
		t.is(viewportLine(terminal, 3).trimEnd(), 'r3');
		t.true(historyLine(terminal, 0).includes('SAVED'));
		t.deepEqual(inkOf(stdout).log.getPhysicalFrame()?.context.columns, 6);
	},
);

test.serial(
	'leaving seek clears only the owned viewport then uses the legacy path',
	async t => {
		const {stdout, instance} = setup(t, {columns: 8, rows: 4, label: 'FULL'});
		await instance.waitUntilRenderFlush();
		t.true(inkOf(stdout).log.getPhysicalFrame()?.ownsViewport);

		const start = stdout.getWrites().length;
		instance.rerender(<Text>tiny</Text>);
		await instance.waitUntilRenderFlush();

		const delta = joinedFrom(stdout, start);
		t.true(delta.includes(ed2));
		t.true(delta.includes(home) || delta.includes(`${csi}1;1H`));
		t.false(delta.includes(ed3));
		t.false(delta.includes(ansiEscapes.clearTerminal));
		t.true(delta.includes('tiny'));
		t.falsy(inkOf(stdout).log.getPhysicalFrame()?.ownsViewport);
		t.falsy(inkOf(stdout).log.getPhysicalFrame()?.valid);
		t.true(inkOf(stdout).lastOutput.includes('tiny'));
	},
);

test.serial(
	'later raw updates after leaving seek do not clear the viewport again',
	async t => {
		const {stdout, instance} = setup(t, {columns: 8, rows: 4, label: 'FULL'});
		await instance.waitUntilRenderFlush();
		instance.rerender(<Text>tiny</Text>);
		await instance.waitUntilRenderFlush();

		const unchangedStart = stdout.getWrites().length;
		instance.rerender(<Text>tiny</Text>);
		await instance.waitUntilRenderFlush();
		t.is(stdout.getWrites().length, unchangedStart);

		const start = stdout.getWrites().length;
		instance.rerender(<Text>tiny2</Text>);
		await instance.waitUntilRenderFlush();
		const delta = joinedFrom(stdout, start);
		t.true(delta.includes('tiny2'));
		t.false(delta.includes(ed2));
		t.false(delta.includes(seekEntry));
		t.false(delta.includes(ansiEscapes.clearTerminal));
		t.falsy(inkOf(stdout).log.getPhysicalFrame()?.ownsViewport);
	},
);

test.serial(
	'leave-seek soft-wrapped raw frames use reflow erase for clear and stdout-stderr writes',
	async t => {
		const stdout = createStdout(8);
		stdout.rows = 4;
		const stderr = createStdout(8);
		stubResolvePaintContext(t, stdout);
		const instance = render(<SeekFrame label="FULL" />, {
			stdout,
			stderr,
			interactive: true,
			incrementalRendering: true,
			patchConsole: false,
			exitOnCtrlC: false,
			maxFps: 1000,
		});
		const exitPromise = instance.waitUntilExit();
		t.teardown(async () => {
			instance.unmount();
			await exitPromise;
		});
		await instance.waitUntilRenderFlush();
		t.true(inkOf(stdout).log.getPhysicalFrame()?.ownsViewport);

		instance.rerender(<Text>tiny</Text>);
		await instance.waitUntilRenderFlush();
		instance.rerender(<WrappedRawFrame />);
		await instance.waitUntilRenderFlush();

		const ink = inkOf(stdout);
		t.true(ink.hasPhysicalFrame);
		t.true(ink.lastPhysicalFrameWasSoftWrapped);
		t.falsy(ink.log.getPhysicalFrame()?.ownsViewport);
		t.falsy(ink.log.getPhysicalFrame()?.valid);

		const reflowErase = ansiEscapes.eraseLines(5);
		const assertLegacyReflowErase = (delta: string) => {
			t.true(delta.includes(reflowErase), delta);
			t.false(delta.includes(ed2));
			t.false(delta.includes(seekEntry));
			t.false(delta.includes(ansiEscapes.clearTerminal));
		};

		let start = stdout.getWrites().length;
		ink.writeToStdout('out\n');
		assertLegacyReflowErase(joinedFrom(stdout, start));
		t.true(joinedFrom(stdout, start).includes('out'));

		start = stdout.getWrites().length;
		ink.writeToStderr('err\n');
		assertLegacyReflowErase(joinedFrom(stdout, start));
		t.true(stderr.getWrites().join('').includes('err'));

		start = stdout.getWrites().length;
		instance.clear();
		assertLegacyReflowErase(joinedFrom(stdout, start));
	},
);

test.serial(
	'entering seek from inline raw output waits until the frame owns the viewport',
	async t => {
		const stdout = createStdout(8);
		stdout.rows = 4;
		stubResolvePaintContext(t, stdout);
		const instance = render(<Text>inline</Text>, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			patchConsole: false,
			exitOnCtrlC: false,
			maxFps: 1000,
		});
		const exitPromise = instance.waitUntilExit();
		t.teardown(async () => {
			instance.unmount();
			await exitPromise;
		});
		await instance.waitUntilRenderFlush();
		t.falsy(inkOf(stdout).log.getPhysicalFrame()?.ownsViewport);
		const inlineWrites = stdout.getWrites().join('');
		t.true(inlineWrites.includes('inline'));
		t.false(inlineWrites.includes(decawmOff));

		const start = stdout.getWrites().length;
		instance.rerender(<SeekFrame label="FULL" />);
		await instance.waitUntilRenderFlush();
		const delta = joinedFrom(stdout, start);
		t.true(delta.includes(seekEntry));
		t.false(delta.includes(ed3));
		t.false(delta.includes(ansiEscapes.clearTerminal));
		t.true(inkOf(stdout).log.getPhysicalFrame()?.ownsViewport);
	},
);

test.serial(
	'a height mismatch from stale layout relayouts instead of leaving seek',
	async t => {
		const {stdout, instance} = setup(t, {columns: 8, rows: 4, label: 'HOLD'});
		await instance.waitUntilRenderFlush();
		t.true(inkOf(stdout).log.getPhysicalFrame()?.ownsViewport);

		const start = stdout.getWrites().length;
		stdout.rows = 6;
		instance.rerender(<SeekFrame label="HOLD" />);
		await instance.waitUntilRenderFlush();

		const delta = joinedFrom(stdout, start);
		t.false(delta.includes('tiny'));
		t.false(delta.includes(ansiEscapes.eraseLines(4)));
		t.true(inkOf(stdout).log.getPhysicalFrame()?.ownsViewport);
		t.deepEqual(inkOf(stdout).log.getPhysicalFrame()?.context.rows, 4);
	},
);

test.serial(
	'unchanged-size seek updates do not classify original text as soft-wrapped',
	async t => {
		const {stdout, instance} = setup(t, {columns: 8, rows: 4, label: 'AAA'});
		await instance.waitUntilRenderFlush();
		t.false(inkOf(stdout).lastPhysicalFrameWasSoftWrapped);

		const start = stdout.getWrites().length;
		instance.rerender(<SeekFrame label="BBB" />);
		await instance.waitUntilRenderFlush();
		const delta = joinedFrom(stdout, start);
		t.false(delta.includes(seekEntry));
		t.false(delta.includes(ed2));
		t.false(delta.includes(ansiEscapes.eraseLines(4)));
		t.true(delta.includes(decawmOff));
		t.false(inkOf(stdout).lastPhysicalFrameWasSoftWrapped);
		t.true(inkOf(stdout).lastOutput.includes('BBB'));
	},
);

test.serial(
	'clearPhysicalFrame clears an owned seek viewport without relative erase',
	async t => {
		const {stdout, instance} = setup(t, {columns: 8, rows: 4, label: 'CLR'});
		await instance.waitUntilRenderFlush();
		const start = stdout.getWrites().length;
		instance.clear();
		const delta = joinedFrom(stdout, start);
		t.true(delta.includes(ed2));
		t.true(delta.includes(home) || delta.includes(`${csi}1;1H`));
		t.false(delta.includes(ansiEscapes.eraseLines(4)));
		t.false(delta.includes(ed3));
		t.falsy(inkOf(stdout).log.getPhysicalFrame()?.valid);
	},
);
