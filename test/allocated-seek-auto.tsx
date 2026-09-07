import process from 'node:process';
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import test, {type ExecutionContext} from 'ava';
import React, {useEffect} from 'react';
import {render, Box, Static, Text, useStdout} from '../src/index.js';
import {useStdinContext} from '../src/hooks/use-stdin.js';
import {type RenderOptions} from '../src/render.js';
import instances from '../src/instances.js';
import {
	decawmOff,
	selectPaintStrategy,
	seekViewportReset,
} from '../src/terminal-paint.js';
import Input from './helpers/create-readable-stdin.js';
import createStdout, {type FakeStdout} from './helpers/create-stdout.js';

const query = '\u001B[?6n';
const probe = '\u001B]66;w=1; \u001B\\\u001B[?6n\r';
const osc = (text: string) => `\u001B]66;w=2;${text}\u001B\\`;
const ed3 = '\u001B[3J';

const until = async (predicate: () => boolean) => {
	const deadline = Date.now() + 1500;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for observable terminal state');
		}

		// eslint-disable-next-line no-await-in-loop -- poll until the write is observable
		await yieldImmediate();
	}
};

function Fullscreen({
	label,
	rows,
	columns,
}: {
	readonly label: string;
	readonly rows: number;
	readonly columns: number;
}) {
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

function RawApp({
	children,
	raw,
}: {
	readonly children: React.ReactNode;
	readonly raw: boolean;
}): React.ReactNode {
	const {setRawMode} = useStdinContext();
	useEffect(() => {
		if (raw) {
			setRawMode(true);
		}

		return () => {
			if (raw) {
				setRawMode(false);
			}
		};
	}, [raw, setRawMode]);
	return children;
}

const inkOf = (stdout: FakeStdout) =>
	instances.get(stdout) as unknown as {
		log: {
			getPhysicalFrame: () =>
				| {
						context: {strategy: string; columns: number; rows: number};
						ownsViewport?: boolean;
						valid?: boolean;
				  }
				| undefined;
		};
	};

const setup = (
	t: ExecutionContext,
	config: {
		options?: RenderOptions;
		env?: string;
		raw?: boolean;
		text?: React.ReactNode;
		label?: string;
		columns?: number;
		rows?: number;
		onWrite?: (text: string, stdin: Input) => void;
	} = {},
) => {
	const previous = process.env['INK_EXPLICIT_WIDTH'];
	if (config.env === undefined) {
		delete process.env['INK_EXPLICIT_WIDTH'];
	} else {
		process.env['INK_EXPLICIT_WIDTH'] = config.env;
	}

	const columns = config.columns ?? 8;
	const rows = config.rows ?? 4;
	const stdin = new Input();
	const stdout = createStdout(columns);
	stdout.rows = rows;
	const originalWrite = stdout.write;
	stdout.write = (chunk: string | Uint8Array) => {
		originalWrite.call(stdout, String(chunk));
		config.onWrite?.(String(chunk), stdin);
		return true;
	};

	const view = (node: React.ReactNode, raw = config.raw ?? true) => (
		<RawApp raw={raw}>{node}</RawApp>
	);
	const node = config.text ?? (
		<Fullscreen label={config.label ?? '⚡︎'} rows={rows} columns={columns} />
	);
	const instance = render(view(node), {
		stdout,
		stdin: stdin as unknown as NodeJS.ReadStream,
		interactive: true,
		patchConsole: false,
		exitOnCtrlC: false,
		incrementalRendering: true,
		...config.options,
	});
	const exit = instance.waitUntilExit();
	t.teardown(async () => {
		instance.unmount();
		await exit;
		stdin.destroy();
		if (previous === undefined) {
			delete process.env['INK_EXPLICIT_WIDTH'];
		} else {
			process.env['INK_EXPLICIT_WIDTH'] = previous;
		}
	});
	return {
		stdin,
		stdout,
		instance,
		exit,
		columns,
		rows,
		update(next: React.ReactNode, raw?: boolean) {
			instance.rerender(view(next, raw));
		},
		async waitForQuery() {
			await until(() => stdout.getWrites().includes(query));
		},
		async waitForProbe() {
			await until(() => stdout.getWrites().includes(probe));
		},
	};
};

const support = (text: string, stdin: Input) => {
	if (text === query) {
		stdin.push('\u001B[?3;1R');
	}

	if (text === probe) {
		stdin.push('\u001B[?3;2R');
	}
};

const reject = (text: string, stdin: Input) => {
	if (text === query || text === probe) {
		stdin.push('\u001B[?3;1R');
	}
};

const joined = (stdout: FakeStdout) => stdout.getWrites().join('');
const hasOsc = (stdout: FakeStdout) => joined(stdout).includes(osc('⚡︎'));
const hasSeek = (stdout: FakeStdout) =>
	joined(stdout).includes(decawmOff) &&
	joined(stdout).includes(seekViewportReset);

test('selectPaintStrategy treats ineligibility as raw even when OSC 66 is known', t => {
	t.is(
		selectPaintStrategy({
			eligible: false,
			capability: 'osc66',
			incremental: true,
			outputHeight: 4,
			rows: 4,
		}),
		'raw',
	);
	t.is(
		selectPaintStrategy({
			eligible: false,
			capability: 'fallback',
			incremental: true,
			outputHeight: 4,
			rows: 4,
		}),
		'raw',
	);
});

test('selectPaintStrategy treats explicit disable as raw, not absent detection', t => {
	t.is(
		selectPaintStrategy({
			eligible: true,
			capability: 'raw',
			incremental: true,
			outputHeight: 4,
			rows: 4,
		}),
		'raw',
	);
});

test('selectPaintStrategy keeps OSC 66 regardless of frame shape', t => {
	t.is(
		selectPaintStrategy({
			eligible: true,
			capability: 'osc66',
			incremental: false,
			outputHeight: 1,
			rows: 4,
		}),
		'osc66',
	);
});

test('selectPaintStrategy selects seek only for eligible fallback fullscreen incremental frames', t => {
	t.is(
		selectPaintStrategy({
			eligible: true,
			capability: 'fallback',
			incremental: true,
			outputHeight: 4,
			rows: 4,
		}),
		'seek-viewport',
	);
	t.is(
		selectPaintStrategy({
			eligible: true,
			capability: 'fallback',
			incremental: false,
			outputHeight: 4,
			rows: 4,
		}),
		'raw',
	);
	t.is(
		selectPaintStrategy({
			eligible: true,
			capability: 'fallback',
			incremental: true,
			outputHeight: 5,
			rows: 4,
		}),
		'raw',
	);
	t.is(
		selectPaintStrategy({
			eligible: true,
			capability: 'fallback',
			incremental: true,
			outputHeight: 3,
			rows: 4,
		}),
		'raw',
	);
});

test.serial(
	'unsupported same-position reply selects seek for a fullscreen incremental frame',
	async t => {
		const h = setup(t, {onWrite: reject});
		await h.instance.waitUntilRenderFlush();
		t.true(h.stdout.getWrites().includes(probe));
		t.true(hasSeek(h.stdout));
		t.false(hasOsc(h.stdout));
		t.false(joined(h.stdout).includes(ed3));
		const physical = inkOf(h.stdout).log.getPhysicalFrame();
		t.true(physical?.valid);
		t.true(physical?.ownsViewport);
		t.deepEqual(physical?.context, {
			strategy: 'seek-viewport',
			columns: h.columns,
			rows: h.rows,
		});
		t.is(h.stdin.listenerCount('data'), 0);
		t.is(h.stdout.getWrites().filter(text => text === query).length, 1);
	},
);

test.serial(
	'unanswered queries time out to seek without enabling OSC 66',
	async t => {
		const h = setup(t);
		await h.waitForQuery();
		t.false(joined(h.stdout).includes('⚡︎'));
		await h.instance.waitUntilRenderFlush();
		t.true(hasSeek(h.stdout));
		t.false(hasOsc(h.stdout));
		t.true(joined(h.stdout).includes('⚡︎'));
	},
);

test.serial(
	'unreadable input selects seek without constructing a detector',
	async t => {
		const stdin = new Input();
		stdin.isTTY = false;
		const stdout = createStdout(8);
		stdout.rows = 4;
		const instance = render(<Fullscreen label="⚡︎" rows={4} columns={8} />, {
			stdout,
			stdin: stdin as unknown as NodeJS.ReadStream,
			interactive: true,
			patchConsole: false,
			exitOnCtrlC: false,
			incrementalRendering: true,
		});
		const exit = instance.waitUntilExit();
		t.teardown(async () => {
			instance.unmount();
			await exit;
			stdin.destroy();
		});
		await instance.waitUntilRenderFlush();
		t.false(stdout.getWrites().includes(query));
		t.false(stdout.getWrites().includes(probe));
		t.true(hasSeek(stdout));
		t.false(hasOsc(stdout));
	},
);

test.serial(
	'missing input capability selects seek without a query',
	async t => {
		const stdout = createStdout(8);
		stdout.rows = 4;
		const stdin = createStdout(8);
		const instance = render(<Fullscreen label="⚡︎" rows={4} columns={8} />, {
			stdout,
			stdin: stdin as unknown as NodeJS.ReadStream,
			interactive: true,
			patchConsole: false,
			exitOnCtrlC: false,
			incrementalRendering: true,
		});
		const exit = instance.waitUntilExit();
		t.teardown(async () => {
			instance.unmount();
			await exit;
		});
		await instance.waitUntilRenderFlush();
		t.false(stdout.getWrites().includes(query));
		t.true(hasSeek(stdout));
		t.false(hasOsc(stdout));
	},
);

test.serial(
	'successful negotiation encodes OSC 66 and does not seek',
	async t => {
		const h = setup(t, {onWrite: support});
		await h.instance.waitUntilRenderFlush();
		t.true(h.stdout.getWrites().includes(probe));
		t.true(hasOsc(h.stdout));
		t.false(hasSeek(h.stdout));
		t.falsy(inkOf(h.stdout).log.getPhysicalFrame()?.ownsViewport);
	},
);

test.serial(
	'standard rendering stays raw after failed negotiation',
	async t => {
		const h = setup(t, {
			onWrite: reject,
			options: {incrementalRendering: false},
		});
		await h.instance.waitUntilRenderFlush();
		t.true(joined(h.stdout).includes('⚡︎'));
		t.false(hasSeek(h.stdout));
		t.false(hasOsc(h.stdout));
	},
);

test.serial('inline frames stay raw after failed negotiation', async t => {
	const h = setup(t, {text: <Text>⚡︎</Text>, onWrite: reject});
	await h.instance.waitUntilRenderFlush();
	t.true(joined(h.stdout).includes('⚡︎'));
	t.false(hasSeek(h.stdout));
	t.false(hasOsc(h.stdout));
});

test.serial(
	'taller-than-viewport frames stay raw after failed negotiation',
	async t => {
		const rows = 4;
		const columns = 8;
		const h = setup(t, {
			rows,
			columns,
			text: <Fullscreen label="⚡︎" rows={rows + 2} columns={columns} />,
			onWrite: reject,
		});
		await h.instance.waitUntilRenderFlush();
		t.true(joined(h.stdout).includes('⚡︎'));
		t.false(hasSeek(h.stdout));
		t.false(hasOsc(h.stdout));
	},
);

for (const [name, config] of [
	['debug', {options: {debug: true as const}}],
	['screen reader', {options: {isScreenReaderEnabled: true}}],
	['non-TTY', {options: {stdout: createStdout(8, false)}}],
	['disabled', {options: {explicitWidth: 'disabled' as const}}],
	['env-off', {env: '0', options: {}}],
] as const) {
	test.serial(`auto mode stays raw without querying: ${name}`, async t => {
		const options = {...config.options};
		if (name === 'non-TTY' && 'stdout' in options && options.stdout) {
			(options.stdout as FakeStdout).rows = 4;
		}

		const h = setup(t, {...config, options});
		await h.instance.waitUntilRenderFlush();
		const stdout =
			name === 'non-TTY' && 'stdout' in options
				? (options.stdout as FakeStdout)
				: h.stdout;
		t.false(stdout.getWrites().includes(query));
		t.false(stdout.getWrites().includes(probe));
		t.true(stdout.getWrites().join('').includes('⚡︎'));
		t.false(hasSeek(stdout));
		t.false(hasOsc(stdout));
	});
}

test.serial(
	'force-on encodes OSC 66 for fullscreen frames and does not seek',
	async t => {
		const h = setup(t, {env: '1'});
		await h.instance.waitUntilRenderFlush();
		t.false(h.stdout.getWrites().includes(query));
		t.false(h.stdout.getWrites().includes(probe));
		t.true(hasOsc(h.stdout));
		t.false(hasSeek(h.stdout));
	},
);

test.serial(
	'externally entered alternate screen still seeks without Ink entering it',
	async t => {
		const h = setup(t, {onWrite: reject});
		await h.instance.waitUntilRenderFlush();
		t.true(hasSeek(h.stdout));
		t.false(joined(h.stdout).includes('\u001B[?1049h'));
	},
);

test.serial(
	'reserved then pending frames appear in order after a failed probe',
	async t => {
		const columns = 8;
		const rows = 4;
		const h = setup(t, {
			columns,
			rows,
			label: 'ONE',
		});
		await h.waitForQuery();
		h.stdin.push('\u001B[?3;1R');
		await h.waitForProbe();
		h.update(<Fullscreen label="TWO" rows={rows} columns={columns} />);
		await yieldImmediate();
		h.stdin.push('\u001B[?3;1R');
		await h.instance.waitUntilRenderFlush();
		const output = joined(h.stdout);
		t.true(output.includes('ONE'));
		t.true(output.includes('TWO'));
		t.true(output.indexOf('ONE') < output.indexOf('TWO'));
		t.true(hasSeek(h.stdout));
		t.false(output.includes(osc('ONE')));
		t.false(output.includes(osc('TWO')));
	},
);

test.serial(
	'Static deltas during reserved seek settlement appear exactly once',
	async t => {
		const columns = 8;
		const rows = 4;
		const view = (items: string[], label: string) => (
			<>
				<Static items={items}>{item => <Text key={item}>{item}</Text>}</Static>
				<Fullscreen label={label} rows={rows} columns={columns} />
			</>
		);
		const h = setup(t, {
			columns,
			rows,
			text: view(['STATIC'], 'ONE'),
		});
		await h.waitForQuery();
		h.stdin.push('\u001B[?3;1R');
		await h.waitForProbe();
		h.update(view(['STATIC', 'DELTA'], 'TWO'));
		await yieldImmediate();
		h.stdin.push('\u001B[?3;1R');
		await h.instance.waitUntilRenderFlush();
		const output = joined(h.stdout);
		t.is(output.split('STATIC').length - 1, 1);
		t.is(output.split('DELTA').length - 1, 1);
		t.true(output.indexOf('STATIC') < output.indexOf('DELTA'));
		t.true(output.indexOf('ONE') < output.indexOf('TWO'));
		t.true(output.includes(decawmOff));
		t.true(inkOf(h.stdout).log.getPhysicalFrame()?.ownsViewport);
		t.false(output.includes(osc('ONE')));
	},
);

test.serial(
	'late replies cannot change a settled fallback strategy',
	async t => {
		const h = setup(t, {onWrite: reject});
		await h.instance.waitUntilRenderFlush();
		t.true(hasSeek(h.stdout));
		const before = h.stdout.getWrites().length;
		h.stdin.push('\u001B[?3;1R\u001B[?3;2R');
		await yieldImmediate();
		h.update(<Fullscreen label="⚡︎" rows={h.rows} columns={h.columns} />);
		await h.instance.waitUntilRenderFlush();
		t.is(
			h.stdout.getWrites().slice(before).join('').includes(osc('⚡︎')),
			false,
		);
		t.true(hasSeek(h.stdout));
		t.false(hasOsc(h.stdout));
		t.deepEqual(
			inkOf(h.stdout).log.getPhysicalFrame()?.context.strategy,
			'seek-viewport',
		);
	},
);

test.serial('no strategy is installed after teardown', async t => {
	const h = setup(t);
	await h.waitForQuery();
	h.instance.unmount();
	await h.exit;
	const before = h.stdout.getWrites().length;
	h.stdin.push('\u001B[?3;1R\u001B[?3;2R');
	await yieldImmediate();
	t.is(h.stdout.getWrites().length, before);
	t.false(hasOsc(h.stdout));
	t.false(h.stdout.getWrites().slice(before).join('').includes(decawmOff));
});

test.serial('readiness waits include fallback settlement', async t => {
	const h = setup(t, {onWrite: reject});
	await h.instance.waitUntilRenderFlush();
	t.true(hasSeek(h.stdout));
	t.true(joined(h.stdout).includes('⚡︎'));
});

test.serial(
	'failed probe does not query again or add an input listener',
	async t => {
		const h = setup(t, {onWrite: reject});
		await h.instance.waitUntilRenderFlush();
		const queries = h.stdout.getWrites().filter(text => text === query);
		t.is(queries.length, 1);
		t.is(h.stdin.listenerCount('data'), 0);
		const before = h.stdout.getWrites().length;
		h.update(<Fullscreen label="NEXT" rows={h.rows} columns={h.columns} />);
		await h.instance.waitUntilRenderFlush();
		t.is(
			h.stdout
				.getWrites()
				.slice(before)
				.filter(text => text === query).length,
			0,
		);
		t.true(joined(h.stdout).includes('NEXT'));
	},
);

test.serial(
	'useStdout writes wait for failed settlement before the seek frame',
	async t => {
		let writeExternal = (_text: string) => {};
		function App() {
			writeExternal = useStdout().write;
			return <Fullscreen label="⚡︎" rows={4} columns={8} />;
		}

		const h = setup(t, {text: <App />});
		await h.waitForQuery();
		h.stdin.push('\u001B[?3;1R');
		await h.waitForProbe();
		writeExternal('EXTERNAL\n');
		h.stdin.push('\u001B[?3;1R');
		await h.instance.waitUntilRenderFlush();
		const writes = h.stdout.getWrites();
		const frameIndex = writes.findIndex(text => text.includes(decawmOff));
		t.true(frameIndex > writes.indexOf(probe));
		t.true(writes.indexOf('EXTERNAL\n') > frameIndex);
		t.true(hasSeek(h.stdout));
	},
);
