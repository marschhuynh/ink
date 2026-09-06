import process from 'node:process';
import Input from './helpers/create-readable-stdin.js';
import {setImmediate as yieldImmediate} from 'node:timers/promises';
import test, {type ExecutionContext} from 'ava';
import React, {useEffect} from 'react';
import {
	render,
	Static,
	Text,
	useInput,
	useStderr,
	useStdout,
} from '../src/index.js';
import {useStdinContext} from '../src/hooks/use-stdin.js';
import {type RenderOptions} from '../src/render.js';
import createStdout from './helpers/create-stdout.js';

const query = '\u001B[?6n';
const probe = '\u001B]66;w=1; \u001B\\\u001B[?6n\r';
const osc = (text: string) => `\u001B]66;w=2;${text}\u001B\\`;
const until = async (predicate: () => boolean) => {
	const deadline = Date.now() + 1500;
	while (!predicate()) {
		if (Date.now() >= deadline)
			throw new Error('Timed out waiting for observable terminal state');
		await yieldImmediate();
	}
};
const setup = (
	t: ExecutionContext,
	config: {
		options?: RenderOptions;
		env?: string;
		raw?: boolean;
		text?: React.ReactNode;
		columns?: number;
		rows?: number;
		onWrite?: (text: string, stdin: Input) => void;
		onStderrWrite?: (text: string) => void;
	} = {},
) => {
	const previous = process.env['INK_EXPLICIT_WIDTH'];
	if (config.env === undefined) delete process.env['INK_EXPLICIT_WIDTH'];
	else process.env['INK_EXPLICIT_WIDTH'] = config.env;
	const stdin = new Input();
	const stdout = createStdout(config.columns ?? 40);
	const stderr = createStdout(config.columns ?? 40);
	stdout.rows = config.rows ?? 24;
	const originalWrite = stdout.write;
	stdout.write = (chunk: string | Uint8Array) => {
		originalWrite.call(stdout, String(chunk));
		config.onWrite?.(String(chunk), stdin);
		return true;
	};
	const originalStderrWrite = stderr.write;
	stderr.write = (chunk: string | Uint8Array) => {
		originalStderrWrite.call(stderr, String(chunk));
		config.onStderrWrite?.(String(chunk));
		return true;
	};
	const inputs: string[] = [];
	const pastes: string[] = [];
	let external = (_text: string) => {};
	let externalError = (_text: string) => {};
	function App({children, raw}: {children: React.ReactNode; raw: boolean}) {
		const {setRawMode, internal_eventEmitter: emitter} = useStdinContext();
		external = useStdout().write;
		externalError = useStderr().write;
		useEffect(() => {
			const onInput = (text: string) => {
				inputs.push(text);
			};
			const onPaste = (text: string) => {
				pastes.push(text);
			};
			emitter.on('input', onInput);
			emitter.on('paste', onPaste);
			if (raw) setRawMode(true);
			return () => {
				if (raw) setRawMode(false);
				emitter.off('input', onInput);
				emitter.off('paste', onPaste);
			};
		}, [raw, setRawMode, emitter]);
		return children;
	}
	const view = (node: React.ReactNode, raw = config.raw ?? true) => (
		<App raw={raw}>{node}</App>
	);
	const instance = render(view(config.text ?? <Text>⚡︎</Text>), {
		stdout,
		stderr,
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
		if (previous === undefined) delete process.env['INK_EXPLICIT_WIDTH'];
		else process.env['INK_EXPLICIT_WIDTH'] = previous;
	});
	return {
		stdin,
		stdout,
		stderr,
		inputs,
		pastes,
		instance,
		exit,
		update: (node: React.ReactNode, raw?: boolean) =>
			instance.rerender(view(node, raw)),
		external: (text: string) => external(text),
		externalError: (text: string) => externalError(text),
		waitForQuery: () => until(() => stdout.getWrites().includes(query)),
		waitForProbe: () => until(() => stdout.getWrites().includes(probe)),
	};
};
const support = (text: string, stdin: Input) => {
	if (text === query) stdin.push('\u001B[?3;1R');
	if (text === probe) stdin.push('\u001B[?3;2R');
};

for (const incrementalRendering of [false, true]) {
	test.serial(
		`auto detects before first physical frame: incremental=${incrementalRendering}`,
		async t => {
			const h = setup(t, {options: {incrementalRendering}, onWrite: support});
			await h.instance.waitUntilRenderFlush();
			const writes = h.stdout.getWrites();
			t.true(writes.includes(query));
			t.true(writes.includes(probe));
			t.true(writes.some(text => text.includes(osc('⚡︎'))));
			t.true(
				writes.indexOf(probe) <
					writes.findIndex(text => text.includes(osc('⚡︎'))),
			);
			t.deepEqual(h.inputs, []);
			t.is(h.stdin.listenerCount('data'), 0);
			const before = writes.length;
			h.update(<Text>⚡︎</Text>);
			await h.instance.waitUntilRenderFlush();
			t.deepEqual(h.stdout.getWrites().slice(before), []);
		},
	);
}

test.serial(
	'split replies and UTF-8 keys share one readable path with Kitty negotiation',
	async t => {
		const h = setup(t, {options: {kittyKeyboard: {mode: 'auto'}}});
		await h.waitForQuery();
		h.stdin.push('x\u001B[?');
		await yieldImmediate();
		h.stdin.push('3;1R\u001B[?1u');
		await h.waitForProbe();
		h.stdin.push('\u001B[?3;');
		await yieldImmediate();
		h.stdin.push('2R');
		const emoji = Buffer.from('⚡︎');
		h.stdin.push(emoji.subarray(0, 2));
		h.stdin.push(emoji.subarray(2));
		await h.instance.waitUntilRenderFlush();
		await until(() => h.inputs.join('').includes('⚡︎'));
		t.is(h.inputs.join(''), 'x⚡︎');
		t.true(h.stdout.getWrites().includes('\u001B[>1u'));
		t.is(h.stdin.listenerCount('data'), 0);
		t.is(h.stdout.getWrites().filter(text => text === query).length, 1);
	},
);

test.serial(
	'response-shaped pasted text stays on the paste channel',
	async t => {
		const h = setup(t, {onWrite: support});
		await h.instance.waitUntilRenderFlush();
		const pasted = '⚡︎\u001B[?3;2R\u001B[?1u';
		h.stdin.push(`\u001B[200~${pasted}\u001B[201~`);
		await until(() => h.pastes.length === 1);
		t.deepEqual(h.pastes, [pasted]);
		t.deepEqual(h.inputs, []);
	},
);

test.serial(
	'unanswered queries time out plain and late replies cannot enable encoding',
	async t => {
		const h = setup(t);
		await h.waitForQuery();
		h.stdin.push('\u001B');
		await h.instance.waitUntilRenderFlush();
		await until(() => h.inputs.length === 1);
		t.deepEqual(h.inputs, ['\u001B']);
		t.true(h.stdout.getWrites().join('').includes('⚡︎'));
		t.false(h.stdout.getWrites().join('').includes(']66;'));
		h.stdin.push('\u001B[?3;1R\u001B[?3;2Rz');
		await until(() => h.inputs.includes('z'));
		h.update(<Text>⚠️</Text>);
		await h.instance.waitUntilRenderFlush();
		t.deepEqual(h.inputs, ['\u001B', 'z']);
		t.false(h.stdout.getWrites().join('').includes(osc('⚠️')));
	},
);

test.serial(
	'no raw consumer settles plain without a query or a forced raw lease',
	async t => {
		const h = setup(t, {raw: false});
		await h.instance.waitUntilRenderFlush();
		t.false(h.stdin.isRaw);
		t.false(h.stdout.getWrites().includes(query));
		t.true(h.stdout.getWrites().join('').includes('⚡︎'));
	},
);

for (const [name, config] of [
	['manual force', {env: '1'}],
	['environment opt-out', {env: '0'}],
	['explicit opt-out', {options: {explicitWidth: 'disabled' as const}}],
	[
		'explicit opt-out overrides manual force',
		{env: '1', options: {explicitWidth: 'disabled' as const}},
	],
	['debug', {options: {debug: true}}],
	['screen reader', {options: {isScreenReaderEnabled: true}}],
	['noninteractive', {options: {interactive: false}}],
] as const) {
	test.serial(`auto mode skips queries: ${name}`, async t => {
		const h = setup(t, config);
		await h.instance.waitUntilRenderFlush();
		t.false(h.stdout.getWrites().includes(query));
		t.false(h.stdout.getWrites().includes(probe));
		t.is(
			h.stdout.getWrites().join('').includes(osc('⚡︎')),
			name === 'manual force',
		);
	});
}

for (const initial of ['\n⚡︎', '']) {
	test.serial(
		`unsafe first row never gets a drawing probe: ${JSON.stringify(initial)}`,
		async t => {
			const h = setup(t, {text: <Text>{initial}</Text>, onWrite: support});
			await h.instance.waitUntilRenderFlush();
			t.false(h.stdout.getWrites().includes(probe));
		},
	);
}

test.serial('midline cursor position never gets a drawing probe', async t => {
	const h = setup(t, {
		onWrite: (text, stdin) => {
			if (text === query) stdin.push('\u001B[?3;8R');
		},
	});
	await h.instance.waitUntilRenderFlush();
	t.false(h.stdout.getWrites().includes(probe));
	t.true(h.stdout.getWrites().join('').includes('⚡︎'));
});

for (const action of [
	'clear',
	'unmount',
	'external',
	'resize',
	'raw-loss',
] as const) {
	test.serial(
		`drawn reservation is fulfilled before ${action} cancellation`,
		async t => {
			const h = setup(t);
			await h.waitForQuery();
			h.stdin.push('\u001B[?3;1R');
			await h.waitForProbe();
			if (action === 'clear') h.instance.clear();
			else if (action === 'unmount') h.instance.unmount();
			else if (action === 'external') h.external('EXTERNAL ⚠️\n');
			else if (action === 'resize') {
				h.stdout.columns = 20;
				h.stdout.emit('resize');
			} else h.update(<Text>⚡︎</Text>, false);
			if (action === 'unmount') await h.exit;
			else await h.instance.waitUntilRenderFlush();
			const writes = h.stdout.getWrites();
			t.true(
				writes
					.slice(writes.indexOf(probe) + 1)
					.join('')
					.includes('⚡︎'),
			);
			t.false(writes.join('').includes(osc('⚡︎')));
			if (action === 'external') t.true(writes.includes('EXTERNAL ⚠️\n'));
			const before = writes.length;
			h.stdin.push('\u001B[?3;2R');
			await yieldImmediate();
			t.is(h.stdout.getWrites().length, before);
		},
	);
}

for (const callbackWrite of [query, probe]) {
	for (const action of [
		'clear',
		'stdout',
		'stderr',
		'resize',
		'raw-loss',
		'unmount',
	] as const) {
		test.serial(
			`${action} waits for settlement requested from the ${
				callbackWrite === query ? 'query' : 'probe'
			} write callback`,
			async t => {
				const events: string[] = [];
				let runAction = () => {};
				const h = setup(t, {
					onWrite: (text, stdin) => {
						events.push(text);
						if (text === callbackWrite) runAction();
						if (text === query && callbackWrite === probe)
							stdin.push('\u001B[?3;1R');
					},
					onStderrWrite: text => events.push(text),
					options:
						action === 'resize'
							? {onRender: () => events.push('render')}
							: undefined,
				});
				const originalSetRawMode = h.stdin.setRawMode.bind(h.stdin);
				h.stdin.setRawMode = raw => {
					events.push(`raw:${raw}`);
					return originalSetRawMode(raw);
				};
				runAction = () => {
					if (action === 'clear') h.instance.clear();
					else if (action === 'stdout') h.external('EXTERNAL OUT\n');
					else if (action === 'stderr') {
						h.externalError('EXTERNAL ERR\n');
					} else if (action === 'resize') {
						h.stdout.columns = 20;
						h.stdout.emit('resize');
						events.push('resize-complete');
					} else if (action === 'raw-loss') h.update(<Text>⚡︎</Text>, false);
					else {
						h.instance.unmount();
						events.push(`readable:${h.stdin.listenerCount('readable')}`);
					}
				};

				if (action === 'unmount') await h.exit;
				else await h.instance.waitUntilRenderFlush();

				const frameIndex = events.findIndex(
					(event, index) =>
						index > events.indexOf(callbackWrite) && event.includes('⚡︎'),
				);
				t.true(frameIndex > events.indexOf(callbackWrite));
				if (action === 'stdout')
					t.true(events.indexOf('EXTERNAL OUT\n') > frameIndex);
				else if (action === 'stderr')
					t.true(events.indexOf('EXTERNAL ERR\n') > frameIndex);
				else if (action === 'resize')
					t.true(events.lastIndexOf('render') > frameIndex);
				else if (action === 'raw-loss')
					t.true(events.indexOf('raw:false') > frameIndex);
				else if (action === 'unmount') {
					t.true(events.indexOf('raw:false') > frameIndex);
					t.true(events.includes('readable:1'));
				} else {
					const clearIndex = events.findIndex(
						(event, index) => index > frameIndex && event.includes('\u001B[2K'),
					);
					t.true(clearIndex > frameIndex);
				}
				if (action !== 'stdout' && action !== 'stderr')
					t.is(events.filter(event => event.includes('⚡︎')).length, 1);
			},
		);
	}
}

test.serial(
	'reentrant empty replacement cannot bypass or abandon a Static reservation',
	async t => {
		let h!: ReturnType<typeof setup>;
		h = setup(t, {
			text: (
				<>
					<Static items={['STATIC']}>
						{item => <Text key={item}>{item}</Text>}
					</Static>
					<Text>⚡︎</Text>
				</>
			),
			onWrite: (text, stdin) => {
				if (text === query) stdin.push('\u001B[?3;1R');
				if (text === probe) {
					h.update(null);
					h.instance.clear();
					h.external('AFTER CLEAR\n');
				}
			},
		});
		await h.instance.waitUntilRenderFlush();
		const writes = h.stdout.getWrites();
		const output = writes.join('');
		t.is(output.split('STATIC').length - 1, 1);
		t.is(output.split('⚡︎').length - 1, 1);
		const probeIndex = writes.indexOf(probe);
		const frameIndex = writes.findIndex(
			(text, index) => index > probeIndex && text.includes('⚡︎'),
		);
		const clearIndex = writes.findIndex(
			(text, index) => index > probeIndex && text.includes('\u001B[2K'),
		);
		t.true(frameIndex > probeIndex);
		t.true(clearIndex > frameIndex);
		t.true(writes.indexOf('AFTER CLEAR\n') > frameIndex);
	},
);

test.serial(
	'reentrant render during settlement publishes before queued lifecycle work',
	async t => {
		let h!: ReturnType<typeof setup>;
		let updated = false;
		h = setup(t, {
			onWrite: text => {
				if (text === query) {
					h.instance.clear();
					h.external('AFTER CLEAR\n');
				}
				if (text.includes('⚡︎') && !updated) {
					updated = true;
					h.update(<Text>LATEST</Text>);
				}
			},
		});
		await h.instance.waitUntilRenderFlush();
		const writes = h.stdout.getWrites();
		const latestIndex = writes.findIndex(text => text.includes('LATEST'));
		t.true(latestIndex > writes.indexOf(query));
		t.true(
			writes.indexOf('AFTER CLEAR\n') > latestIndex,
			JSON.stringify(writes),
		);
	},
);

for (const action of ['raw-loss', 'unmount'] as const) {
	for (const pending of ['\u001B', '\u001B[']) {
		test.serial(
			`${action} synchronously delivers held ${JSON.stringify(pending)} once`,
			async t => {
				const h = setup(t);
				await h.waitForQuery();
				h.stdin.push(pending);
				await yieldImmediate();
				t.deepEqual(h.inputs, []);
				if (action === 'raw-loss') {
					h.update(<Text>⚡︎</Text>, false);
					await h.instance.waitUntilRenderFlush();
				} else {
					h.instance.unmount();
					await h.exit;
				}
				t.deepEqual(h.inputs, [pending]);
				await yieldImmediate();
				t.deepEqual(h.inputs, [pending]);
			},
		);
	}

	test.serial(`${action} discards a held private response partial`, async t => {
		const h = setup(t);
		await h.waitForQuery();
		h.stdin.push('\u001B[?3;');
		await yieldImmediate();
		if (action === 'raw-loss') {
			h.update(<Text>⚡︎</Text>, false);
			await h.instance.waitUntilRenderFlush();
		} else {
			h.instance.unmount();
			await h.exit;
		}
		t.deepEqual(h.inputs, []);
	});
}

for (const callbackWrite of [query, probe]) {
	for (const action of ['raw-loss', 'unmount'] as const) {
		for (const pending of ['\u001B', '\u001B[']) {
			test.serial(
				`${action} from the ${
					callbackWrite === query ? 'query' : 'probe'
				} callback delivers held ${JSON.stringify(pending)} once`,
				async t => {
					let runAction = () => {};
					const h = setup(t, {
						onWrite: (text, stdin) => {
							if (text === query && callbackWrite === probe)
								stdin.push('\u001B[?3;1R');
							if (text === callbackWrite) {
								stdin.push(pending);
								runAction();
							}
						},
					});
					runAction = () => {
						if (action === 'raw-loss') h.update(<Text>⚡︎</Text>, false);
						else h.instance.unmount();
					};
					if (action === 'unmount') await h.exit;
					else await h.instance.waitUntilRenderFlush();
					t.deepEqual(h.inputs, [pending]);
					await yieldImmediate();
					t.deepEqual(h.inputs, [pending]);
				},
			);
		}

		test.serial(
			`${action} from the ${
				callbackWrite === query ? 'query' : 'probe'
			} callback discards a private response partial`,
			async t => {
				let runAction = () => {};
				const h = setup(t, {
					onWrite: (text, stdin) => {
						if (text === query && callbackWrite === probe)
							stdin.push('\u001B[?3;1R');
						if (text === callbackWrite) {
							stdin.push('\u001B[?3;');
							runAction();
						}
					},
				});
				runAction = () => {
					if (action === 'raw-loss') h.update(<Text>⚡︎</Text>, false);
					else h.instance.unmount();
				};
				if (action === 'unmount') await h.exit;
				else await h.instance.waitUntilRenderFlush();
				t.deepEqual(h.inputs, []);
			},
		);
	}
}

test.serial(
	'an empty replacement cannot abandon a drawn reservation',
	async t => {
		const h = setup(t);
		await h.waitForQuery();
		h.stdin.push('\u001B[?3;1R');
		await h.waitForProbe();
		h.update(null);
		await yieldImmediate();
		h.stdin.push('\u001B[?3;2R');
		await h.instance.waitUntilRenderFlush();
		t.true(h.stdout.getWrites().join('').includes(osc('⚡︎')));
	},
);

test.serial(
	'Static deltas during a reserved fullscreen frame are not duplicated by replay',
	async t => {
		const view = (items: string[]) => (
			<>
				<Static items={items}>{item => <Text key={item}>{item}</Text>}</Static>
				<Text>{'⚡︎\na\nb'}</Text>
			</>
		);
		const h = setup(t, {rows: 2, text: view(['✅'])});
		await h.waitForQuery();
		h.stdin.push('\u001B[?1;1R');
		await h.waitForProbe();
		h.update(view(['✅', '❌']));
		await yieldImmediate();
		h.stdin.push('\u001B[?1;2R');
		await h.instance.waitUntilRenderFlush();
		const text = h.stdout.getWrites().join('');
		// A fullscreen clear may intentionally replay history; the later delta must
		// not appear in the earlier reserved frame and then again as a new delta.
		const firstDynamic = text.indexOf(osc('⚡︎'));
		t.true(firstDynamic > text.indexOf(osc('✅')));
		t.true(text.indexOf(osc('❌')) > firstDynamic);
		t.is(text.split(osc('❌')).length - 1, 1);
	},
);

test.serial(
	'useInput receives normal keys coalesced with immediate terminal replies',
	async t => {
		const keys: string[] = [];
		function Keys() {
			useInput(input => {
				keys.push(input);
			});
			return <Text>⚡︎</Text>;
		}
		const h = setup(t, {
			raw: false,
			text: <Keys />,
			onWrite: (text, stdin) => {
				if (text === query) stdin.push('x\u001B[?3;1R');
				if (text === probe) stdin.push('\u001B[?3;2Ry');
			},
		});
		await h.instance.waitUntilRenderFlush();
		t.is(keys.join(''), 'xy');
	},
);

test.serial(
	'an initially empty tree negotiates when its first nonempty frame arrives',
	async t => {
		const h = setup(t, {text: <></>, onWrite: support});
		await h.instance.waitUntilRenderFlush();
		t.false(h.stdout.getWrites().includes(query));
		h.update(<Text>⚡︎</Text>);
		await h.instance.waitUntilRenderFlush();
		t.true(h.stdout.getWrites().includes(query));
		t.true(h.stdout.getWrites().join('').includes(osc('⚡︎')));
	},
);

test.serial(
	'timeout after drawing fulfills the reservation without enabling encoding',
	async t => {
		const h = setup(t);
		await h.waitForQuery();
		h.stdin.push('\u001B[?3;1R');
		await h.waitForProbe();
		await h.instance.waitUntilRenderFlush();
		const writes = h.stdout.getWrites();
		t.true(
			writes
				.slice(writes.indexOf(probe) + 1)
				.join('')
				.includes('⚡︎'),
		);
		t.false(writes.join('').includes(osc('⚡︎')));
	},
);

test.serial('unsupported same-position reply flushes plain output', async t => {
	const h = setup(t, {
		onWrite: (text, stdin) => {
			if (text === query || text === probe) stdin.push('\u001B[?3;1R');
		},
	});
	await h.instance.waitUntilRenderFlush();
	t.true(h.stdout.getWrites().includes(probe));
	t.false(h.stdout.getWrites().join('').includes(osc('⚡︎')));
	t.true(h.stdout.getWrites().join('').includes('⚡︎'));
});

test.serial('query write failure fails open to the normal frame', async t => {
	const h = setup(t, {
		onWrite: text => {
			if (text === query) throw new Error('probe unavailable');
		},
	});
	await h.instance.waitUntilRenderFlush();
	t.false(h.stdout.getWrites().includes(probe));
	t.true(h.stdout.getWrites().join('').includes('⚡︎'));
});

test.serial(
	'unmount before raw readiness sends no capability query',
	async t => {
		const h = setup(t);
		h.instance.unmount();
		await h.exit;
		await yieldImmediate();
		t.false(h.stdout.getWrites().includes(query));
		t.false(h.stdout.getWrites().includes(probe));
		t.is(h.stdin.listenerCount('readable'), 0);
	},
);

test.serial(
	'unwritable output discards pending content and cancels detection',
	async t => {
		const h = setup(t);
		await h.waitForQuery();
		Object.defineProperty(h.stdout, 'destroyed', {value: true});
		const before = h.stdout.getWrites().length;
		h.instance.unmount();
		await h.exit;
		t.false(h.stdout.getWrites().slice(before).join('').includes('⚡︎'));
		t.false(h.stdout.getWrites().includes(probe));
	},
);

test.serial(
	'concurrent render waits for automatic capability settlement',
	async t => {
		const h = setup(t, {options: {concurrent: true}, onWrite: support});
		await h.instance.waitUntilRenderFlush();
		t.true(h.stdout.getWrites().includes(probe));
		t.true(h.stdout.getWrites().join('').includes(osc('⚡︎')));
	},
);

test.serial('capabilities belong to separate instances', async t => {
	const supported = setup(t, {onWrite: support});
	await supported.instance.waitUntilRenderFlush();
	const unsupported = setup(t, {
		onWrite: (text, stdin) => {
			if (text === query || text === probe) stdin.push('\u001B[?3;1R');
		},
	});
	await unsupported.instance.waitUntilRenderFlush();
	t.true(supported.stdout.getWrites().join('').includes(osc('⚡︎')));
	t.false(unsupported.stdout.getWrites().join('').includes(osc('⚡︎')));
	t.true(unsupported.stdout.getWrites().includes(query));
});

for (const kind of ['stdout', 'stdin', 'synthetic']) {
	test.serial('auto skips ineligible ' + kind, async t => {
		const stdout = createStdout(40, kind !== 'stdout');
		const stdin = kind === 'synthetic' ? createStdout(40) : new Input();
		if (kind === 'stdin') stdin.isTTY = false;
		const h = setup(t, {
			raw: false,
			options: {stdout, stdin: stdin as unknown as NodeJS.ReadStream},
		});
		await h.instance.waitUntilRenderFlush();
		t.false(stdout.getWrites().includes(query));
		t.false(stdout.getWrites().includes(probe));
		t.true(stdout.getWrites().join('').includes('⚡︎'));
		if (stdin instanceof Input) stdin.destroy();
	});
}

test.serial(
	'auto negotiation works inside an owned alternate screen',
	async t => {
		const h = setup(t, {options: {alternateScreen: true}, onWrite: support});
		await h.instance.waitUntilRenderFlush();
		const writes = h.stdout.getWrites();
		t.true(writes.includes(query));
		t.true(writes.includes(probe));
		t.true(writes.some(text => text.includes(osc('⚡︎'))));
		h.instance.unmount();
		await h.exit;
		t.is(h.stdout.getWrites().filter(text => text === query).length, 1);
		t.is(h.stdin.listenerCount('readable'), 0);
	},
);

test.serial(
	'disabled and force-on instances keep private CPR on the application channel',
	async t => {
		for (const config of [
			{options: {explicitWidth: 'disabled' as const}},
			{env: '1'},
		] as const) {
			const h = setup(t, config);
			await h.instance.waitUntilRenderFlush();
			t.false(h.stdout.getWrites().includes(query));
			h.stdin.push('\u001B[?7;9Rz');
			await until(() => h.inputs.length > 0);
			t.deepEqual(h.inputs, ['\u001B[?7;9R', 'z']);
			h.instance.unmount();
			await h.exit;
		}
	},
);
