import process from 'node:process';
import test from 'ava';
import delay from 'delay';
import ansiEscapes from 'ansi-escapes';
import stripAnsi from 'strip-ansi';
import React from 'react';
import {render, Box, Text, useWindowSize} from '../src/index.js';
import {bsu, esu} from '../src/write-synchronized.js';
import createStdout, {type FakeStdout} from './helpers/create-stdout.js';

const getWriteContents = (stdout: FakeStdout): string[] =>
	stdout
		.getWrites()
		.filter(w => !w.startsWith('\u001B[?25') && !w.startsWith('\u001B[?2026'));

test.serial(
	'useWindowSize returns current terminal dimensions and updates on resize',
	async t => {
		const stdout = createStdout(100);
		(stdout as any).rows = 40;

		function Test() {
			const {columns, rows} = useWindowSize();
			return (
				<Text>
					{columns}x{rows}
				</Text>
			);
		}

		const {waitUntilRenderFlush} = render(<Test />, {stdout});
		await waitUntilRenderFlush();

		t.true(stripAnsi(getWriteContents(stdout).at(-1)!).includes('100x40'));

		(stdout as any).columns = 60;
		(stdout as any).rows = 20;
		stdout.emit('resize');
		await delay(100);

		t.true(stripAnsi(getWriteContents(stdout).at(-1)!).includes('60x20'));
	},
);

test.serial('useWindowSize removes resize listener on unmount', async t => {
	const stdout = createStdout(100);
	(stdout as any).rows = 24;

	function Test() {
		const {columns, rows} = useWindowSize();
		return (
			<Text>
				{columns}x{rows}
			</Text>
		);
	}

	const initialListenerCount = stdout.listenerCount('resize');
	const {unmount, waitUntilRenderFlush} = render(<Test />, {stdout});
	await waitUntilRenderFlush();

	t.true(stdout.listenerCount('resize') > initialListenerCount);
	unmount();

	t.is(stdout.listenerCount('resize'), initialListenerCount);
});

test.serial(
	'useWindowSize does not crash when resize fires after unmount',
	async t => {
		const stdout = createStdout(100);
		(stdout as any).rows = 24;

		function Test() {
			const {columns, rows} = useWindowSize();
			return (
				<Text>
					{columns}x{rows}
				</Text>
			);
		}

		const {unmount, waitUntilRenderFlush} = render(<Test />, {stdout});
		await waitUntilRenderFlush();
		unmount();

		stdout.emit('resize');
		await delay(50);

		t.pass();
	},
);

test.serial(
	'useWindowSize falls back to a positive column count when stdout.columns is 0',
	async t => {
		const stdout = createStdout(0);
		let capturedColumns = -1;

		function Test() {
			const {columns} = useWindowSize();
			capturedColumns = columns;
			return <Text>{columns}</Text>;
		}

		const {waitUntilRenderFlush} = render(<Test />, {stdout});
		await waitUntilRenderFlush();

		t.true(capturedColumns > 0);
	},
);

test.serial(
	'useWindowSize falls back to terminal-size rows when stdout.rows is missing',
	async t => {
		const stdout = createStdout(0);
		let capturedRows = -1;
		const originalColumns = process.env.COLUMNS;
		const originalLines = process.env.LINES;
		const originalProcessStdoutColumns = process.stdout.columns;
		const originalProcessStdoutRows = process.stdout.rows;
		const originalProcessStderrColumns = process.stderr.columns;
		const originalProcessStderrRows = process.stderr.rows;

		t.teardown(() => {
			process.env.COLUMNS = originalColumns;
			process.env.LINES = originalLines;
			process.stdout.columns = originalProcessStdoutColumns;
			process.stdout.rows = originalProcessStdoutRows;
			process.stderr.columns = originalProcessStderrColumns;
			process.stderr.rows = originalProcessStderrRows;
		});

		process.env.COLUMNS = '123';
		process.env.LINES = '45';
		process.stdout.columns = 0;
		process.stdout.rows = 0;
		process.stderr.columns = 0;
		process.stderr.rows = 0;
		delete (stdout as any).rows;

		function Test() {
			const {rows} = useWindowSize();
			capturedRows = rows;
			return <Text>{rows}</Text>;
		}

		const {waitUntilRenderFlush} = render(<Test />, {stdout});
		await waitUntilRenderFlush();

		t.is(capturedRows, 45);
	},
);

test.serial(
	'terminal width decrease repaints the reflowed frame without clearTerminal',
	async t => {
		const stdout = createStdout(100);

		function Test() {
			return (
				<Box borderStyle="round">
					<Text>Hello World</Text>
				</Box>
			);
		}

		const instance = render(<Test />, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			maxFps: 1000,
		});
		const exitPromise = instance.waitUntilExit();
		t.teardown(async () => {
			instance.unmount();
			await exitPromise;
		});
		await instance.waitUntilRenderFlush();

		const initialOutput = stripAnsi(getWriteContents(stdout)[0]!);
		t.true(initialOutput.includes('Hello World'));
		t.true(initialOutput.includes('╭'));

		const resizeWriteStart = stdout.getWrites().length;
		stdout.columns = 50;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();

		const resizeWrites = stdout.getWrites().slice(resizeWriteStart);
		const repaintChunks = resizeWrites.filter(
			write =>
				write.includes(ansiEscapes.eraseLines(7)) &&
				stripAnsi(write).includes('╭'),
		);
		t.is(repaintChunks.length, 1);
		t.false(
			resizeWrites.some(write => write.includes(ansiEscapes.clearTerminal)),
		);

		const repaintIndex = resizeWrites.indexOf(repaintChunks[0]!);
		t.true(resizeWrites.indexOf(bsu) < repaintIndex);
		t.true(repaintIndex < resizeWrites.indexOf(esu));
		t.not(initialOutput, stripAnsi(repaintChunks[0]!));
	},
);

test.serial(
	'terminal width increase stays incremental without clearTerminal',
	async t => {
		const stdout = createStdout(50);

		function Test() {
			return (
				<Box borderStyle="round">
					<Text>Test</Text>
				</Box>
			);
		}

		const instance = render(<Test />, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			maxFps: 1000,
		});
		const exitPromise = instance.waitUntilExit();
		t.teardown(async () => {
			instance.unmount();
			await exitPromise;
		});
		await instance.waitUntilRenderFlush();

		const initialOutput = stripAnsi(getWriteContents(stdout)[0]!);
		const resizeWriteStart = stdout.getWrites().length;
		stdout.columns = 100;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();

		const resizeWrites = stdout.getWrites().slice(resizeWriteStart);
		const resizeOutput = resizeWrites.join('');
		t.false(resizeOutput.includes(ansiEscapes.clearTerminal));
		t.false(resizeOutput.includes(ansiEscapes.eraseLines(4)));
		t.true(stripAnsi(resizeOutput).includes('Test'));
		t.not(initialOutput, stripAnsi(resizeOutput));
	},
);

test.serial(
	'consecutive terminal width decreases each repaint exactly once',
	async t => {
		const stdout = createStdout(100);

		function Test() {
			return (
				<Box borderStyle="round">
					<Text>Content</Text>
				</Box>
			);
		}

		const instance = render(<Test />, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			maxFps: 1000,
		});
		const exitPromise = instance.waitUntilExit();
		t.teardown(async () => {
			instance.unmount();
			await exitPromise;
		});
		await instance.waitUntilRenderFlush();

		const firstResizeStart = stdout.getWrites().length;
		stdout.columns = 80;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();
		const firstResizeWrites = stdout.getWrites().slice(firstResizeStart);

		const firstRepaints = firstResizeWrites.filter(
			write =>
				write.includes(ansiEscapes.eraseLines(7)) &&
				stripAnsi(write).includes('Content'),
		);
		t.is(firstRepaints.length, 1);
		t.false(
			firstResizeWrites.some(write =>
				write.includes(ansiEscapes.clearTerminal),
			),
		);
		const firstRepaintIndex = firstResizeWrites.indexOf(firstRepaints[0]!);
		t.true(firstResizeWrites.indexOf(bsu) < firstRepaintIndex);
		t.true(firstRepaintIndex < firstResizeWrites.indexOf(esu));

		const secondResizeStart = stdout.getWrites().length;
		stdout.columns = 60;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();
		const secondResizeWrites = stdout.getWrites().slice(secondResizeStart);

		const secondRepaints = secondResizeWrites.filter(
			write =>
				write.includes(ansiEscapes.eraseLines(7)) &&
				stripAnsi(write).includes('Content'),
		);
		t.is(secondRepaints.length, 1);
		t.false(
			secondResizeWrites.some(write =>
				write.includes(ansiEscapes.clearTerminal),
			),
		);
		const secondRepaintIndex = secondResizeWrites.indexOf(secondRepaints[0]!);
		t.true(secondResizeWrites.indexOf(bsu) < secondRepaintIndex);
		t.true(secondRepaintIndex < secondResizeWrites.indexOf(esu));
	},
);

test.serial(
	'width-decrease repaint leaves later updates incremental',
	async t => {
		const stdout = createStdout(100);

		function Test({content}: {readonly content: string}) {
			return (
				<Box borderStyle="round">
					<Text>{content}</Text>
				</Box>
			);
		}

		const instance = render(<Test content="Test Content" />, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			maxFps: 1000,
		});
		const exitPromise = instance.waitUntilExit();
		t.teardown(async () => {
			instance.unmount();
			await exitPromise;
		});
		await instance.waitUntilRenderFlush();

		stdout.columns = 50;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();

		const updateWriteStart = stdout.getWrites().length;
		instance.rerender(<Test content="Updated Content" />);
		await instance.waitUntilRenderFlush();

		const updateWrites = stdout.getWrites().slice(updateWriteStart);
		const updateChunk = updateWrites.find(write =>
			stripAnsi(write).includes('Updated Content'),
		);
		t.truthy(updateChunk);
		t.false(stripAnsi(updateChunk!).includes('╭'));
		t.false(
			updateWrites.some(write => write.includes(ansiEscapes.clearTerminal)),
		);
	},
);
