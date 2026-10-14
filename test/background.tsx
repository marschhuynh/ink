import React from 'react';
import test from 'ava';
import chalk from 'chalk';
import {render, Box, Text} from '../src/index.js';
import {
	renderToString,
	renderToStringAsync,
} from './helpers/render-to-string.js';
import createStdout from './helpers/create-stdout.js';
import Input from './helpers/create-readable-stdin.js';
import {renderAsync} from './helpers/test-renderer.js';
import {
	Terminal,
	viewportLine,
	writeTerminal,
} from './helpers/terminal-model.js';
import {enableTestColors, disableTestColors} from './helpers/force-colors.js';

// ANSI escape sequences for background colors
// Note: We test against raw ANSI codes rather than chalk predicates because:
// 1. Different color reset patterns:
//    - Chalk: '\u001b[43mHello \u001b[49m\u001b[43mWorld\u001b[49m' (individual resets)
//    - Ink:   '\u001b[43mHello World\u001b[49m' (continuous blocks)
// 2. Background space fills that chalk doesn't generate:
//    - Ink: '\u001b[41mHello     \u001b[49m\n\u001b[41m          \u001b[49m' (fills entire Box area)
// 3. Context-aware color transitions:
//    - Chalk: '\u001b[43mOuter: \u001b[49m\u001b[44mInner: \u001b[49m\u001b[41mExplicit\u001b[49m'
//    - Ink:   '\u001b[43mOuter: \u001b[44mInner: \u001b[41mExplicit\u001b[49m' (no intermediate resets)
const ansi = {
	// Standard colors
	bgRed: '\u001B[41m',
	bgGreen: '\u001B[42m',
	bgYellow: '\u001B[43m',
	bgBlue: '\u001B[44m',
	bgMagenta: '\u001B[45m',
	bgCyan: '\u001B[46m',
	bgRedBright: '\u001B[101m',
	bgBlueBright: '\u001B[104m',
	bgWhiteBright: '\u001B[107m',

	// Hex/RGB colors (24-bit)
	bgHexRed: '\u001B[48;2;255;0;0m', // #FF0000 or rgb(255,0,0)

	// ANSI256 colors
	bgAnsi256Nine: '\u001B[48;5;9m', // Ansi256(9)

	// Reset
	bgReset: '\u001B[49m',
} as const;

// Enable colors for all tests
test.before(() => {
	enableTestColors();
});

test.after(() => {
	disableTestColors();
});

// Text inheritance tests (these work in non-TTY)
test('Text inherits parent Box background color', t => {
	const output = renderToString(
		<Box backgroundColor="green" alignSelf="flex-start">
			<Text>Hello World</Text>
		</Box>,
	);

	t.is(output, chalk.bgGreen('Hello World'));
});

test('Text explicit background color overrides inherited', t => {
	const output = renderToString(
		<Box backgroundColor="red" alignSelf="flex-start">
			<Text backgroundColor="blue">Hello World</Text>
		</Box>,
	);

	t.is(output, chalk.bgBlue('Hello World'));
});

test('Nested Box background inheritance', t => {
	const output = renderToString(
		<Box backgroundColor="red" alignSelf="flex-start">
			<Box backgroundColor="blue">
				<Text>Hello World</Text>
			</Box>
		</Box>,
	);

	t.is(output, chalk.bgBlue('Hello World'));
});

test('Text without parent Box background has no inheritance', t => {
	const output = renderToString(
		<Box alignSelf="flex-start">
			<Text>Hello World</Text>
		</Box>,
	);

	t.is(output, 'Hello World');
});

test('Multiple Text elements inherit same background', t => {
	const output = renderToString(
		<Box backgroundColor="yellow" alignSelf="flex-start">
			<Text>Hello </Text>
			<Text>World</Text>
		</Box>,
	);

	// Text nodes are rendered as a single block with shared background
	t.is(output, chalk.bgYellow('Hello World'));
});

test('Mixed text with and without background inheritance', t => {
	const output = renderToString(
		<Box backgroundColor="green" alignSelf="flex-start">
			<Text>Inherited </Text>
			<Text backgroundColor="">No BG </Text>
			<Text backgroundColor="red">Red BG</Text>
		</Box>,
	);

	t.is(output, chalk.bgGreen('Inherited ') + 'No BG ' + chalk.bgRed('Red BG'));
});

test('Complex nested structure with background inheritance', t => {
	const output = renderToString(
		<Box backgroundColor="yellow" alignSelf="flex-start">
			<Box>
				<Text>Outer: </Text>
				<Box backgroundColor="blue">
					<Text>Inner: </Text>
					<Text backgroundColor="red">Explicit</Text>
				</Box>
			</Box>
		</Box>,
	);

	// Colors transition without reset codes between them - actual behavior from debug output
	t.is(
		output,
		`${ansi.bgYellow}Outer: ${ansi.bgBlue}Inner: ${ansi.bgRed}Explicit${ansi.bgReset}`,
	);
});

// Background color tests for different formats
test('Box background with standard color', t => {
	const output = renderToString(
		<Box backgroundColor="red" alignSelf="flex-start">
			<Text>Hello</Text>
		</Box>,
	);

	t.is(output, chalk.bgRed('Hello'));
});

test('Box background with hex color', t => {
	const output = renderToString(
		<Box backgroundColor="#FF0000" alignSelf="flex-start">
			<Text>Hello</Text>
		</Box>,
	);

	t.is(output, chalk.bgHex('#FF0000')('Hello'));
});

test('Box background with rgb color', t => {
	const output = renderToString(
		<Box backgroundColor="rgb(255, 0, 0)" alignSelf="flex-start">
			<Text>Hello</Text>
		</Box>,
	);

	t.is(output, chalk.bgRgb(255, 0, 0)('Hello'));
});

test('Box background with ansi256 color', t => {
	const output = renderToString(
		<Box backgroundColor="ansi256(9)" alignSelf="flex-start">
			<Text>Hello</Text>
		</Box>,
	);

	t.is(output, chalk.bgAnsi256(9)('Hello'));
});

test('Box background with wide characters', t => {
	const output = renderToString(
		<Box backgroundColor="yellow" alignSelf="flex-start">
			<Text>こんにちは</Text>
		</Box>,
	);

	t.is(output, chalk.bgYellow('こんにちは'));
});

test('Box background with emojis', t => {
	const output = renderToString(
		<Box backgroundColor="red" alignSelf="flex-start">
			<Text>🎉🎊</Text>
		</Box>,
	);

	t.is(output, chalk.bgRed('🎉🎊'));
});

// Box background space fill tests - these should work with forced colors
test('Box background fills entire area with standard color', t => {
	const output = renderToString(
		<Box backgroundColor="red" width={10} height={3} alignSelf="flex-start">
			<Text>Hello</Text>
		</Box>,
	);

	// Should contain background color codes and fill spaces for entire Box area
	t.true(
		output.includes(ansi.bgRed),
		'Should contain red background start code',
	);
	t.true(output.includes(ansi.bgReset), 'Should contain background reset code');
	t.true(output.includes('Hello'), 'Should contain the text');
	t.true(
		output.includes(`${ansi.bgRed}          ${ansi.bgReset}`),
		'Should contain background fill line',
	);
});

test('Box background fills with hex color', t => {
	const output = renderToString(
		<Box backgroundColor="#FF0000" width={10} height={3} alignSelf="flex-start">
			<Text>Hello</Text>
		</Box>,
	);

	// Should contain hex color background codes and fill spaces
	t.true(output.includes('Hello'), 'Should contain the text');
	t.true(
		output.includes(ansi.bgHexRed),
		'Should contain hex RGB background code',
	);
	t.true(output.includes(ansi.bgReset), 'Should contain background reset code');
});

test('Box background fills with rgb color', t => {
	const output = renderToString(
		<Box
			backgroundColor="rgb(255, 0, 0)"
			width={10}
			height={3}
			alignSelf="flex-start"
		>
			<Text>Hello</Text>
		</Box>,
	);

	// Should contain RGB color background codes and fill spaces
	t.true(output.includes('Hello'), 'Should contain the text');
	t.true(output.includes(ansi.bgHexRed), 'Should contain RGB background code');
	t.true(output.includes(ansi.bgReset), 'Should contain background reset code');
});

test('Box background fills with ansi256 color', t => {
	const output = renderToString(
		<Box
			backgroundColor="ansi256(9)"
			width={10}
			height={3}
			alignSelf="flex-start"
		>
			<Text>Hello</Text>
		</Box>,
	);

	// Should contain ANSI256 color background codes and fill spaces
	t.true(output.includes('Hello'), 'Should contain the text');
	t.true(
		output.includes(ansi.bgAnsi256Nine),
		'Should contain ANSI256 background code',
	);
	t.true(output.includes(ansi.bgReset), 'Should contain background reset code');
});

test('Box background with border fills content area', t => {
	const output = renderToString(
		<Box
			backgroundColor="cyan"
			borderStyle="round"
			width={10}
			height={5}
			alignSelf="flex-start"
		>
			<Text>Hi</Text>
		</Box>,
	);

	// Should have background fill inside the border and border characters
	t.true(output.includes('Hi'), 'Should contain the text');
	t.true(output.includes(ansi.bgCyan), 'Should contain cyan background code');
	t.true(output.includes(ansi.bgReset), 'Should contain background reset code');
	t.true(output.includes('╭'), 'Should contain top-left border');
	t.true(output.includes('╮'), 'Should contain top-right border');
});

test('Box background with padding fills entire padded area', t => {
	const output = renderToString(
		<Box
			backgroundColor="magenta"
			padding={1}
			width={10}
			height={5}
			alignSelf="flex-start"
		>
			<Text>Hi</Text>
		</Box>,
	);

	// Background should fill the entire Box area including padding
	t.true(output.includes('Hi'), 'Should contain the text');
	t.true(
		output.includes(ansi.bgMagenta),
		'Should contain magenta background code',
	);
	t.true(output.includes(ansi.bgReset), 'Should contain background reset code');
});

test('Box background with center alignment fills entire area', t => {
	const output = renderToString(
		<Box
			backgroundColor="blue"
			width={10}
			height={3}
			justifyContent="center"
			alignSelf="flex-start"
		>
			<Text>Hi</Text>
		</Box>,
	);

	t.true(output.includes('Hi'), 'Should contain centered text');
	t.true(output.includes(ansi.bgBlue), 'Should contain blue background code');
	t.true(output.includes(ansi.bgReset), 'Should contain background reset code');
});

test('Box background with column layout fills entire area', t => {
	const output = renderToString(
		<Box
			backgroundColor="green"
			flexDirection="column"
			width={10}
			height={5}
			alignSelf="flex-start"
		>
			<Text>Line 1</Text>
			<Text>Line 2</Text>
		</Box>,
	);

	t.true(output.includes('Line 1'), 'Should contain first line text');
	t.true(output.includes('Line 2'), 'Should contain second line text');
	t.true(output.includes(ansi.bgGreen), 'Should contain green background code');
	t.true(output.includes(ansi.bgReset), 'Should contain background reset code');
});

// Update tests using render() for comprehensive coverage
test('Box background updates on rerender', t => {
	const stdout = createStdout();

	function Test({bgColor}: {readonly bgColor?: string}) {
		return (
			<Box backgroundColor={bgColor} alignSelf="flex-start">
				<Text>Hello</Text>
			</Box>
		);
	}

	const {rerender} = render(<Test />, {
		stdout,
		debug: true,
	});

	t.is((stdout.write as any).lastCall.args[0], 'Hello');

	rerender(<Test bgColor="green" />);
	t.is((stdout.write as any).lastCall.args[0], chalk.bgGreen('Hello'));

	rerender(<Test />);
	t.is((stdout.write as any).lastCall.args[0], 'Hello');
});

// Concurrent mode tests
test('Text inherits parent Box background color - concurrent', async t => {
	const output = await renderToStringAsync(
		<Box backgroundColor="green" alignSelf="flex-start">
			<Text>Hello World</Text>
		</Box>,
	);

	t.is(output, chalk.bgGreen('Hello World'));
});

test('Nested Box background inheritance - concurrent', async t => {
	const output = await renderToStringAsync(
		<Box backgroundColor="red" alignSelf="flex-start">
			<Box backgroundColor="blue">
				<Text>Hello World</Text>
			</Box>
		</Box>,
	);

	t.is(output, chalk.bgBlue('Hello World'));
});

test('Box background with hex color - concurrent', async t => {
	const output = await renderToStringAsync(
		<Box backgroundColor="#FF0000" alignSelf="flex-start">
			<Text>Hello</Text>
		</Box>,
	);

	t.is(output, chalk.bgHex('#FF0000')('Hello'));
});

test('Box background updates on rerender - concurrent', async t => {
	function Test({bgColor}: {readonly bgColor?: string}) {
		return (
			<Box backgroundColor={bgColor} alignSelf="flex-start">
				<Text>Hello</Text>
			</Box>
		);
	}

	const {getOutput, rerenderAsync} = await renderAsync(<Test />);

	t.is(getOutput(), 'Hello');

	await rerenderAsync(<Test bgColor="green" />);
	t.is(getOutput(), chalk.bgGreen('Hello'));

	await rerenderAsync(<Test />);
	t.is(getOutput(), 'Hello');
});

test('Box backgroundColor fills full width on every line when text wraps', t => {
	// "Hello World!!" is 13 chars, width=10 forces wrapping into 2 lines
	const output = renderToString(
		<Box backgroundColor="red" width={10} alignSelf="flex-start">
			<Text>Hello World!!</Text>
		</Box>,
	);

	// Both lines are padded to the full 10-char Box width with background color
	t.is(
		output,
		`${ansi.bgRed}Hello     ${ansi.bgReset}\n${ansi.bgRed}World!!   ${ansi.bgReset}`,
	);
});

test('Text-only backgroundColor colors text content but does not fill Box width', t => {
	// Without a Box backgroundColor, only the text characters are colored
	const output = renderToString(
		<Box width={10} alignSelf="flex-start">
			<Text backgroundColor="red">Hello World!!</Text>
		</Box>,
	);

	// Text-only bg colors just the text, not the remaining space to fill Box width
	t.is(
		output,
		`${ansi.bgRed}Hello ${ansi.bgReset}\n${ansi.bgRed}World!!${ansi.bgReset}`,
	);
});

test('Box backgroundColor preserves styled trailing spaces', t => {
	const output = renderToString(
		<Box backgroundColor="red" width={10} alignSelf="flex-start">
			<Text>Hi</Text>
		</Box>,
	);

	t.is(output, `${ansi.bgRed}Hi        ${ansi.bgReset}`);
});

test('nested overflow clips to the tightest active bounds', t => {
	const output = renderToString(
		<Box width={4} height={1} overflow="hidden" alignSelf="flex-start">
			<Box width={10} height={1} overflow="hidden" flexShrink={0}>
				<Text>ABCDEFGHIJ</Text>
			</Box>
		</Box>,
	);

	t.is(output, 'ABCD');
});

test('sibling backgroundColor does not leak into following parent background rows', t => {
	const output = renderToString(
		<Box
			backgroundColor="whiteBright"
			width={8}
			height={3}
			flexDirection="column"
		>
			<Box backgroundColor="redBright" width={8} height={1} />
			<Box height={1} />
			<Box backgroundColor="blueBright" width={8} height={1} />
		</Box>,
	);

	t.is(
		output,
		`${ansi.bgRedBright}        ${ansi.bgReset}\n${ansi.bgWhiteBright}        ${ansi.bgReset}\n${ansi.bgBlueBright}        ${ansi.bgReset}`,
	);
});

test('full-width backgroundColor line keeps its styled trailing spaces', t => {
	const output = renderToString(
		<Box backgroundColor="redBright" width={8} height={1}>
			<Text>Hi</Text>
		</Box>,
		{columns: 8},
	);

	// The final styled space reaches the wrap column; output.ts must not trim it.
	t.is(output, `${ansi.bgRedBright}Hi      ${ansi.bgReset}`);
});

const cellBackground = (
	terminal: InstanceType<typeof Terminal>,
	row: number,
	column: number,
) => {
	const line = terminal.buffer.active.getLine(
		terminal.buffer.active.baseY + row,
	);
	return line?.getCell(column)?.getBgColor();
};

test.serial(
	'bottom-row full-width styled spaces paint the wrap column without scrolling',
	async t => {
		const columns = 8;
		const rows = 4;
		const stdout = createStdout(columns);
		stdout.rows = rows;
		// Deterministic raw paint path: no OSC 66 probe and no allocated-seek
		// DECAWM wrapping, so the timeline replays identically in CI.
		const stdin = new Input();
		stdin.isTTY = false;

		const instance = render(
			<Box height={rows} flexDirection="column" justifyContent="flex-end">
				<Box backgroundColor="red" width={columns} height={1}>
					<Text>Hi</Text>
				</Box>
			</Box>,
			{
				stdout,
				stdin: stdin as unknown as NodeJS.ReadStream,
				interactive: true,
				explicitWidth: 'disabled',
				exitOnCtrlC: false,
			},
		);
		t.teardown(() => {
			instance.unmount();
			stdin.destroy();
		});
		await instance.waitUntilRenderFlush();

		const timeline = stdout.getWrites().join('');
		// Pinned raw strategy emits neither the DECAWM wrap nor OSC 66.
		t.false(timeline.includes('\u001B[?7l'));
		t.false(timeline.includes('\u001B]66'));

		const terminal = new Terminal({
			cols: columns,
			rows,
			allowProposedApi: true,
		});
		t.teardown(() => {
			terminal.dispose();
		});
		await writeTerminal(terminal, timeline);

		// Writing the styled space into the last column must not scroll.
		t.is(terminal.buffer.active.baseY, 0);
		t.is(viewportLine(terminal, rows - 1), 'Hi      ');
		// Xterm bg color index 1 is red.
		t.is(cellBackground(terminal, rows - 1, 0), 1);
		t.is(cellBackground(terminal, rows - 1, columns - 1), 1);
	},
);

test.serial(
	'shorter repaint after a full-width styled bottom row does not scroll the viewport',
	async t => {
		const columns = 8;
		const rows = 4;
		const stdout = createStdout(columns);
		stdout.rows = rows;

		const app = (styled: boolean) => (
			<Box height={rows} flexDirection="column" justifyContent="flex-end">
				<Box
					backgroundColor={styled ? 'red' : undefined}
					width={columns}
					height={1}
				>
					<Text>Hi</Text>
				</Box>
			</Box>
		);

		const stdin = new Input();
		stdin.isTTY = false;
		const instance = render(app(true), {
			stdout,
			stdin: stdin as unknown as NodeJS.ReadStream,
			interactive: true,
			explicitWidth: 'disabled',
			exitOnCtrlC: false,
		});
		t.teardown(() => {
			instance.unmount();
			stdin.destroy();
		});
		await instance.waitUntilRenderFlush();

		instance.rerender(app(false));
		await instance.waitUntilRenderFlush();

		const terminal = new Terminal({
			cols: columns,
			rows,
			allowProposedApi: true,
		});
		t.teardown(() => {
			terminal.dispose();
		});
		await writeTerminal(terminal, stdout.getWrites().join(''));

		t.is(terminal.buffer.active.baseY, 0);
		t.is(viewportLine(terminal, rows - 1).trimEnd(), 'Hi');
		// Xterm returns -1 for the default (unstyled) background.
		t.is(cellBackground(terminal, rows - 1, columns - 1), -1);
	},
);

test.serial(
	'over-wide background fill is trimmed to the terminal width',
	async t => {
		const columns = 8;
		const rows = 4;
		const stdout = createStdout(columns);
		stdout.rows = rows;
		const stdin = new Input();
		stdin.isTTY = false;

		// The Box is wider than the terminal; flexShrink={0} keeps the layout
		// width so the fill produces styled spaces past the wrap column.
		const instance = render(
			<Box height={rows} flexDirection="column" justifyContent="flex-end">
				<Box backgroundColor="red" width={10} height={1} flexShrink={0}>
					<Text>Hi</Text>
				</Box>
			</Box>,
			{
				stdout,
				stdin: stdin as unknown as NodeJS.ReadStream,
				interactive: true,
				explicitWidth: 'disabled',
				exitOnCtrlC: false,
			},
		);
		t.teardown(() => {
			instance.unmount();
			stdin.destroy();
		});
		await instance.waitUntilRenderFlush();

		const timeline = stdout.getWrites().join('');
		const terminal = new Terminal({
			cols: columns,
			rows,
			allowProposedApi: true,
		});
		t.teardown(() => {
			terminal.dispose();
		});
		await writeTerminal(terminal, timeline);

		// Only the terminal-width styled cells remain; excess styled space is
		// trimmed before serialization (and the buffer row stays 8 cells).
		t.is(terminal.buffer.active.baseY, 0);
		t.is(viewportLine(terminal, rows - 1), 'Hi      ');
		t.is(cellBackground(terminal, rows - 1, columns - 1), 1);

		// Serialization must not carry more than `columns` cells on that row.
		const paint = stdout.getWrites().find(write => write.includes('Hi'));
		const row = paint!.split('\n').find(line => line.includes('Hi'))!;
		t.is(row, `${ansi.bgRed}Hi      ${ansi.bgReset}`);
	},
);
