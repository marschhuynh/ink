import process from 'node:process';
import {Writable} from 'node:stream';
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import test, {type ExecutionContext} from 'ava';
import React, {useEffect} from 'react';
import ansiEscapes from 'ansi-escapes';
import {render, Box, Text} from '../src/index.js';
import {useStdinContext} from '../src/hooks/use-stdin.js';
import {type RenderOptions} from '../src/render.js';
import instances from '../src/instances.js';
import logUpdate, {type LogUpdate} from '../src/log-update.js';
import {
	decawmOff,
	decawmOn,
	eraseDisplayHome,
	type PaintContext,
} from '../src/terminal-paint.js';
import {bsu, esu} from '../src/write-synchronized.js';
import Input from './helpers/create-readable-stdin.js';

const query = '\u001B[?6n';
const ed2 = '\u001B[2J';
const relativeCursor = ansiEscapes.cursorTo(0);
const exitAlt = ansiEscapes.exitAlternativeScreen;
const enterAlt = ansiEscapes.enterAlternativeScreen;

const context = {
	strategy: 'seek-viewport',
	columns: 8,
	rows: 4,
} as const satisfies PaintContext;

const frame = 'VIEW\nr1\nr2\nr3';

type TestStdout = Writable & {
	columns: number;
	rows: number;
	isTTY: boolean;
	chunks: string[];
	getWrites: () => string[];
	joined: () => string;
};

type InkInternals = {
	isUnmounted: boolean;
	isUnmounting: boolean;
	alternateScreen: boolean;
	log: LogUpdate;
	onRender: () => void;
	unmount: (error?: Error | number) => void;
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
}) {
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

const createWritableStdout = (
	options: {
		columns?: number;
		rows?: number;
		writeImpl?: (
			text: string,
			callback: (error?: Error | null) => void,
		) => boolean | void;
	} = {},
): TestStdout => {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk, _encoding, callback) {
			const text = String(chunk);
			if (options.writeImpl) {
				const result = options.writeImpl(text, callback);
				if (result === undefined) {
					return;
				}

				if (text.length > 0) {
					chunks.push(text);
				}

				callback();
				return;
			}

			if (text.length > 0) {
				chunks.push(text);
			}

			callback();
		},
	}) as TestStdout;
	stream.columns = options.columns ?? context.columns;
	stream.rows = options.rows ?? context.rows;
	stream.isTTY = true;
	stream.chunks = chunks;
	stream.getWrites = () => chunks;
	stream.joined = () => chunks.join('');
	return stream;
};

const inkOf = (stdout: TestStdout): InkInternals =>
	instances.get(
		stdout as unknown as NodeJS.WriteStream,
	) as unknown as InkInternals;

const count = (haystack: string, needle: string) =>
	haystack.split(needle).length - 1;

const afterNeedle = (haystack: string, needle: string) => {
	const index = haystack.indexOf(needle);
	return index === -1 ? '' : haystack.slice(index + needle.length);
};

const setup = (
	t: ExecutionContext,
	config: {
		stdout?: TestStdout;
		options?: RenderOptions;
		env?: string;
		label?: string;
		columns?: number;
		rows?: number;
		stdin?: Input;
		rawStdin?: boolean;
	} = {},
) => {
	const previous = process.env['INK_EXPLICIT_WIDTH'];
	if (config.env === undefined) {
		delete process.env['INK_EXPLICIT_WIDTH'];
	} else {
		process.env['INK_EXPLICIT_WIDTH'] = config.env;
	}

	const columns = config.columns ?? context.columns;
	const rows = config.rows ?? context.rows;
	const stdout = config.stdout ?? createWritableStdout({columns, rows});
	const stdin = config.stdin ?? new Input();
	if (!config.rawStdin) {
		stdin.isTTY = false;
	}

	const node = (
		<Fullscreen label={config.label ?? 'VIEW'} rows={rows} columns={columns} />
	);
	const instance = render(
		config.rawStdin ? <RawApp raw>{node}</RawApp> : node,
		{
			stdout: stdout as unknown as NodeJS.WriteStream,
			stdin: stdin as unknown as NodeJS.ReadStream,
			interactive: true,
			patchConsole: false,
			exitOnCtrlC: false,
			incrementalRendering: true,
			maxFps: 1000,
			...config.options,
		},
	);
	const exit = instance.waitUntilExit();
	t.teardown(async () => {
		instance.unmount();
		try {
			await exit;
		} catch {}

		stdin.destroy();
		if (!stdout.destroyed) {
			stdout.destroy();
		}

		if (previous === undefined) {
			delete process.env['INK_EXPLICIT_WIDTH'];
		} else {
			process.env['INK_EXPLICIT_WIDTH'] = previous;
		}
	});
	return {stdout, stdin, instance, exit, columns, rows};
};

test('throw during seek write restores DECAWM and does not keep a physical frame', t => {
	const stdout = createWritableStdout();
	const log = logUpdate.create(stdout, {incremental: true, showCursor: true});
	const original = stdout.write.bind(stdout);
	stdout.write = (
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	) => {
		if (String(chunk).includes(decawmOff)) {
			throw new Error('boom');
		}

		return original(chunk, encoding as BufferEncoding, callback);
	};

	t.throws(
		() => {
			log(frame, context);
		},
		{message: 'boom'},
	);
	t.true(stdout.joined().includes(decawmOn));
	t.falsy(log.getPhysicalFrame()?.valid);
});

test('write backpressure followed by success still publishes the physical frame', t => {
	const stdout = createWritableStdout();
	const log = logUpdate.create(stdout, {incremental: true, showCursor: true});
	const original = stdout.write.bind(stdout);
	stdout.write = (
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	) => {
		original(chunk, encoding as BufferEncoding, callback);
		return false;
	};

	t.true(log(frame, context));
	t.true(log.getPhysicalFrame()?.valid);
	t.true(log.getPhysicalFrame()?.ownsViewport);
	stdout.emit('drain');
	t.true(log.getPhysicalFrame()?.valid);
	t.is(count(stdout.joined(), decawmOff), 1);
});

test('async seek-write error invalidates the accepted frame and restores autowrap', async t => {
	let fail = false;
	const stdout = createWritableStdout({
		writeImpl(text, callback) {
			if (text.length > 0) {
				stdout.chunks.push(text);
			}

			if (fail && text.length > 0) {
				setImmediate(() => {
					callback(new Error('async fail'));
				});
				return;
			}

			callback();
		},
	});
	stdout.on('error', () => {
		// Prevent an unhandled error crash while asserting logger invalidation.
	});
	const log = logUpdate.create(stdout, {incremental: true, showCursor: true});
	t.true(log(frame, context));
	t.true(log.getPhysicalFrame()?.valid);

	fail = true;
	t.true(log('NEXT\nr1\nr2\nr3', context));
	t.true(log.getPhysicalFrame()?.valid);

	await yieldImmediate();
	t.falsy(log.getPhysicalFrame()?.valid);
	t.true(stdout.joined().includes(decawmOn));
	t.true(count(stdout.joined(), decawmOn) >= 2);
});

test('repeated clear and done are idempotent and do not emit extra mode controls', t => {
	const stdout = createWritableStdout();
	const log = logUpdate.create(stdout, {incremental: true, showCursor: true});
	t.true(log(frame, context));
	const afterPaint = stdout.getWrites().length;

	log.clear();
	log.clear();
	const afterClear = stdout
		.joined()
		.slice(stdout.getWrites().slice(0, afterPaint).join('').length);
	t.is(count(afterClear, eraseDisplayHome), 1);
	t.is(count(afterClear, decawmOn), 0);

	log.done();
	log.done();
	t.is(
		count(
			stdout.joined().slice(stdout.joined().indexOf(eraseDisplayHome)),
			decawmOff,
		),
		0,
	);
});

test.serial(
	'throw during frame submission restores modes and rejects waitUntilExit',
	async t => {
		const stdout = createWritableStdout();
		const original = stdout.write.bind(stdout);
		stdout.write = (
			chunk: string | Uint8Array,
			encoding?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			if (String(chunk).includes(decawmOff)) {
				throw new Error('boom');
			}

			return original(chunk, encoding as BufferEncoding, callback);
		};

		const {exit} = setup(t, {stdout});
		await t.throwsAsync(exit, {message: 'boom'});
		t.true(stdout.joined().includes(decawmOn));
	},
);

test.serial(
	'seek paint that throws after BSU still emits ESU',
	async t => {
		const stdout = createWritableStdout();
		const original = stdout.write.bind(stdout);
		let sawBsu = false;
		stdout.write = (
			chunk: string | Uint8Array,
			encoding?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			const text = String(chunk);
			if (sawBsu && text !== esu) {
				throw new Error('after bsu');
			}

			if (text.includes(bsu)) {
				sawBsu = true;
			}

			return original(chunk, encoding as BufferEncoding, callback);
		};

		const {exit} = setup(t, {stdout});
		await t.throwsAsync(exit, {message: 'after bsu'});
		const joined = stdout.joined();
		t.true(sawBsu);
		t.true(joined.includes(bsu), joined);
		t.true(joined.includes(esu), joined);
		t.true(joined.lastIndexOf(esu) > joined.lastIndexOf(bsu), joined);
	},
);

test.serial(
	'async write error surfaces through the exit promise without hanging flush',
	async t => {
		const stdout = createWritableStdout();
		const {instance, exit} = setup(t, {stdout});
		await instance.waitUntilRenderFlush();
		const ink = inkOf(stdout);
		t.true(ink.log.getPhysicalFrame()?.valid);

		const original = stdout.write.bind(stdout);
		stdout.write = (
			chunk: string | Uint8Array,
			encoding?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			const result = original(chunk, encoding as BufferEncoding, callback);
			if (String(chunk).includes(decawmOff)) {
				setImmediate(() => {
					stdout.emit('error', new Error('async fail'));
				});
			}

			return result;
		};

		instance.rerender(
			<Fullscreen label="NEXT" rows={context.rows} columns={context.columns} />,
		);
		await instance.waitUntilRenderFlush();
		await t.throwsAsync(exit, {message: 'async fail'});
		t.falsy(ink.log.getPhysicalFrame()?.valid);
		t.true(count(stdout.joined(), decawmOn) >= 2);
	},
);

test.serial(
	'synchronous reentrant unmount from write does not resurrect physical state',
	async t => {
		const stdout = createWritableStdout();
		const {instance} = setup(t, {stdout});
		await instance.waitUntilRenderFlush();
		const ink = inkOf(stdout);
		t.true(ink.log.getPhysicalFrame()?.valid);

		const original = stdout.write.bind(stdout);
		let reentered = false;
		stdout.write = (
			chunk: string | Uint8Array,
			encoding?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		) => {
			if (!reentered && String(chunk).includes(decawmOff)) {
				reentered = true;
				original(chunk, encoding as BufferEncoding, callback);
				instance.unmount();
				return true;
			}

			return original(chunk, encoding as BufferEncoding, callback);
		};

		instance.rerender(
			<Fullscreen label="NEXT" rows={context.rows} columns={context.columns} />,
		);
		await instance.waitUntilRenderFlush();
		t.true(reentered);
		t.falsy(ink.log.getPhysicalFrame()?.valid);
		t.falsy(ink.log.getPhysicalFrame()?.ownsViewport);
	},
);

test.serial('destroyed stdout unmount restores without throwing', async t => {
	const {stdout, instance, exit} = setup(t);
	await instance.waitUntilRenderFlush();
	t.true(inkOf(stdout).log.getPhysicalFrame()?.valid);
	stdout.destroy();
	t.notThrows(() => {
		instance.unmount();
	});
	await t.notThrowsAsync(exit);
});

test.serial('process-exit cleanup restores an acquired seek mode', async t => {
	const {stdout, instance} = setup(t);
	await instance.waitUntilRenderFlush();
	const ink = inkOf(stdout);
	t.true(ink.log.getPhysicalFrame()?.valid);
	const originalRestore = ink.log.restoreTerminalModes.bind(ink.log);
	let restoredAfterUnmounted = false;
	ink.log.restoreTerminalModes = () => {
		if (ink.isUnmounted) {
			restoredAfterUnmounted = true;
		}

		originalRestore();
	};

	ink.unmount(1);
	t.true(ink.isUnmounted);
	t.true(restoredAfterUnmounted);
	t.falsy(ink.log.getPhysicalFrame()?.valid);
});

test.serial(
	'deferred negotiation cancellation during unmount does not paint late replies',
	async t => {
		const stdin = new Input();
		const {stdout, instance, exit} = setup(t, {
			stdin,
			rawStdin: true,
			options: {explicitWidth: 'auto'},
		});
		const deadline = Date.now() + 1500;
		while (!stdout.joined().includes(query) && Date.now() < deadline) {
			// eslint-disable-next-line no-await-in-loop -- poll until the query is observable
			await yieldImmediate();
		}

		t.true(stdout.joined().includes(query));
		instance.unmount();
		await exit;
		const before = stdout.getWrites().length;
		stdin.push('\u001B[?3;1R\u001B[?3;2R');
		await yieldImmediate();
		t.is(stdout.getWrites().length, before);
		t.false(stdout.joined().includes('\u001B]66;w=2;'));
		t.is(stdout.listenerCount('error'), 0);
		t.is(stdin.listenerCount('data'), 0);
	},
);

test.serial(
	'controlled final render may run while unmounting and no new frame starts after unmount',
	async t => {
		const {stdout, instance} = setup(t);
		await instance.waitUntilRenderFlush();
		const ink = inkOf(stdout);
		const originalOnRender = ink.onRender.bind(ink);
		let renderedWhileUnmounting = false;
		let renderedWhileUnmounted = false;
		ink.onRender = () => {
			if (ink.isUnmounting && !ink.isUnmounted) {
				renderedWhileUnmounting = true;
			}

			if (ink.isUnmounted) {
				renderedWhileUnmounted = true;
			}

			originalOnRender();
		};

		instance.unmount();
		t.true(renderedWhileUnmounting);
		t.false(renderedWhileUnmounted);

		const writes = stdout.getWrites().length;
		ink.onRender();
		t.is(stdout.getWrites().length, writes);
		t.true(ink.isUnmounted);
	},
);

test.serial(
	'acquired seek mode is restored after isUnmounted is set',
	async t => {
		const {stdout, instance} = setup(t);
		await instance.waitUntilRenderFlush();
		const ink = inkOf(stdout);
		const originalRestore = ink.log.restoreTerminalModes.bind(ink.log);
		let restoredAfterUnmounted = false;
		ink.log.restoreTerminalModes = () => {
			if (ink.isUnmounted) {
				restoredAfterUnmounted = true;
			}

			originalRestore();
		};

		instance.unmount();
		t.true(ink.isUnmounted);
		t.true(restoredAfterUnmounted);
	},
);

test.serial(
	'Ink-managed alternate-screen teardown finishes seek done before the screen switch',
	async t => {
		const {stdout, instance} = setup(t, {options: {alternateScreen: true}});
		await instance.waitUntilRenderFlush();
		t.true(stdout.joined().includes(enterAlt));
		const ink = inkOf(stdout);
		const originalDone = ink.log.done.bind(ink.log);
		let doneWhileAlt = false;
		ink.log.done = () => {
			doneWhileAlt = ink.alternateScreen;
			originalDone();
		};

		instance.unmount();
		t.true(doneWhileAlt);
		const joined = stdout.joined();
		const afterExit = afterNeedle(joined, exitAlt);
		t.true(joined.includes(exitAlt));
		t.false(afterExit.includes(ed2));
		t.false(afterExit.includes(relativeCursor));
		t.false(afterExit.includes(ansiEscapes.cursorDown(1)));
	},
);

test.serial(
	'external alternate-screen owner does not receive an unsolicited screen exit',
	async t => {
		const {stdout, instance} = setup(t, {options: {alternateScreen: false}});
		await instance.waitUntilRenderFlush();
		t.true(inkOf(stdout).log.getPhysicalFrame()?.valid);
		instance.unmount();
		t.false(stdout.joined().includes(enterAlt));
		t.false(stdout.joined().includes(exitAlt));
	},
);

test.serial(
	'raw and OSC 66 instances emit no seek mode controls on unmount',
	async t => {
		const raw = setup(t, {options: {explicitWidth: 'disabled'}});
		await raw.instance.waitUntilRenderFlush();
		raw.instance.unmount();
		await raw.exit;
		t.false(raw.stdout.joined().includes(decawmOff));
		t.false(raw.stdout.joined().includes(decawmOn));

		const osc = setup(t, {env: '1'});
		await osc.instance.waitUntilRenderFlush();
		osc.instance.unmount();
		await osc.exit;
		t.false(osc.stdout.joined().includes(decawmOff));
		t.false(osc.stdout.joined().includes(decawmOn));
	},
);

test.serial('unmount removes output-error listeners', async t => {
	const {stdout, instance, exit} = setup(t);
	await instance.waitUntilRenderFlush();
	t.true(stdout.listenerCount('error') > 0);
	instance.unmount();
	await exit;
	t.is(stdout.listenerCount('error'), 0);
});
