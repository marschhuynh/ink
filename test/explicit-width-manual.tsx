import process from 'node:process';
import test, {type ExecutionContext} from 'ava';
import React from 'react';
import ansiEscapes from 'ansi-escapes';
import {render, Static, Text, useStdout} from '../src/index.js';
import {type RenderOptions} from '../src/render.js';
import createStdout from './helpers/create-stdout.js';

const osc = (text: string) => `\u001B]66;w=2;${text}\u001B\\`;

const setFlag = (t: ExecutionContext, value: string | undefined = '1') => {
	const previous = process.env['INK_EXPLICIT_WIDTH'];
	if (value === undefined) delete process.env['INK_EXPLICIT_WIDTH'];
	else process.env['INK_EXPLICIT_WIDTH'] = value;
	t.teardown(() => {
		if (previous === undefined) delete process.env['INK_EXPLICIT_WIDTH'];
		else process.env['INK_EXPLICIT_WIDTH'] = previous;
	});
};

const mount = (
	t: ExecutionContext,
	node: React.ReactNode,
	options: RenderOptions = {},
) => {
	const stdout = options.stdout ?? createStdout(40);
	const instance = render(node, {
		stdout,
		interactive: true,
		patchConsole: false,
		exitOnCtrlC: false,
		...options,
	});
	const exit = instance.waitUntilExit();
	t.teardown(async () => {
		instance.unmount();
		await exit;
	});
	return {...instance, waitUntilExit: () => exit};
};

for (const incrementalRendering of [false, true]) {
	test.serial(
		`manual widths encode frames and skip identical output: incremental=${incrementalRendering}`,
		async t => {
			setFlag(t);
			const stdout = createStdout(40);
			const instance = mount(t, <Text>⚡︎</Text>, {
				stdout,
				incrementalRendering,
			});
			await instance.waitUntilRenderFlush();
			t.true(stdout.getWrites().join('').includes(osc('⚡︎')));
			const before = stdout.getWrites().length;
			instance.rerender(<Text>⚡︎</Text>);
			await instance.waitUntilRenderFlush();
			t.deepEqual(stdout.getWrites().slice(before), []);
			instance.rerender(<Text>⚠️</Text>);
			await instance.waitUntilRenderFlush();
			t.true(stdout.getWrites().slice(before).join('').includes(osc('⚠️')));
			t.false(/\u001B\[\??6n|\u001B\[\?u/.test(stdout.getWrites().join('')));
		},
	);
}

for (const value of [undefined, '0', 'true']) {
	test.serial(`manual widths stay off for flag=${String(value)}`, async t => {
		// Explicit undefined must not use setFlag's convenience default.
		setFlag(t, value ?? '');
		if (value === undefined) delete process.env['INK_EXPLICIT_WIDTH'];
		const stdout = createStdout(40);
		const instance = mount(t, <Text>⚡︎</Text>, {stdout});
		await instance.waitUntilRenderFlush();
		t.true(stdout.getWrites().join('').includes('⚡︎'));
		t.false(stdout.getWrites().join('').includes(']66;'));
	});
}

for (const [name, options, isTTY] of [
	['redirected', {}, false],
	['noninteractive', {interactive: false}, true],
	['debug', {debug: true}, true],
	['screen-reader', {isScreenReaderEnabled: true}, true],
] as const) {
	test.serial(`manual widths bypass ${name} output`, async t => {
		setFlag(t);
		const stdout = createStdout(40, isTTY);
		const instance = mount(t, <Text>⚡︎</Text>, {stdout, ...options});
		await instance.waitUntilRenderFlush();
		instance.unmount();
		await instance.waitUntilExit();
		t.true(stdout.getWrites().join('').includes('⚡︎'));
		t.false(stdout.getWrites().join('').includes(']66;'));
	});
}

test.serial(
	'manual widths encode Static and clear-terminal history replay',
	async t => {
		setFlag(t);
		const stdout = createStdout(40);
		stdout.rows = 2;
		const view = (text: string) => (
			<>
				<Static items={['⚠️']}>{item => <Text key={item}>{item}</Text>}</Static>
				<Text>{text}</Text>
			</>
		);
		const instance = mount(t, view('⚡︎'), {stdout, incrementalRendering: true});
		await instance.waitUntilRenderFlush();
		t.is(stdout.getWrites().join('').split(osc('⚠️')).length - 1, 1);
		const before = stdout.getWrites().length;
		instance.rerender(view('⚡︎\na\nb'));
		await instance.waitUntilRenderFlush();
		const writes = stdout.getWrites().slice(before);
		const replay = writes.find(write =>
			write.startsWith(ansiEscapes.clearTerminal),
		);
		t.is(
			replay,
			`${ansiEscapes.clearTerminal}${osc('⚠️')}\n${osc('⚡︎')}\na\nb`,
		);
	},
);

test.serial(
	'manual widths encode resize repaint and the final frame',
	async t => {
		setFlag(t);
		const stdout = createStdout(40);
		const instance = mount(t, <Text>⚡︎</Text>, {
			stdout,
			incrementalRendering: true,
		});
		await instance.waitUntilRenderFlush();
		const before = stdout.getWrites().length;
		stdout.columns = 20;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();
		t.true(stdout.getWrites().slice(before).join('').includes(osc('⚡︎')));
		instance.rerender(<Text>⚠️</Text>);
		instance.unmount();
		await instance.waitUntilExit();
		t.true(stdout.getWrites().slice(before).join('').includes(osc('⚠️')));
	},
);

test.serial(
	'manual widths leave external writes raw and encode restored Ink output',
	async t => {
		setFlag(t);
		const stdout = createStdout(40);
		let writeExternal = (_text: string) => {};
		function App() {
			writeExternal = useStdout().write;
			return <Text>⚡︎</Text>;
		}
		const instance = mount(t, <App />, {stdout});
		await instance.waitUntilRenderFlush();
		const before = stdout.getWrites().length;
		const external = 'external ⚠️\n\u001B]52;c;⚠️\u0007';
		writeExternal(external);
		const writes = stdout.getWrites().slice(before);
		t.true(writes.includes(external));
		t.true(writes.join('').includes(osc('⚡︎')));
		t.false(writes.join('').includes(osc('⚠️')));
	},
);

test.serial('manual width choice is captured per instance', async t => {
	setFlag(t);
	const firstStdout = createStdout(40);
	const first = mount(t, <Text>⚡︎</Text>, {stdout: firstStdout});
	await first.waitUntilRenderFlush();
	delete process.env['INK_EXPLICIT_WIDTH'];
	const secondStdout = createStdout(40);
	const second = mount(t, <Text>⚡︎</Text>, {stdout: secondStdout});
	await second.waitUntilRenderFlush();
	first.rerender(<Text>⚠️</Text>);
	await first.waitUntilRenderFlush();
	t.true(firstStdout.getWrites().join('').includes(osc('⚠️')));
	t.false(secondStdout.getWrites().join('').includes(']66;'));
});
