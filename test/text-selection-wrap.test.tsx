import React from 'react';
import test from 'ava';
import stripAnsi from 'strip-ansi';
import {
	Box,
	Text,
	render,
	useTextSelectionActions,
	type TextSelectionHandle,
	type TextProps,
} from '../src/index.js';
import createStdout from './helpers/create-stdout.js';

const fixtures: Array<{
	source: string;
	width: number;
	display: string;
	wrap?: TextProps['wrap'];
}> = [
	{source: 'hello world', width: 8, display: 'hello\nworld'},
	{source: 'abcdefghijk', width: 5, display: 'abcde\nfghij\nk'},
	{
		source: 'hello world\n\n  code\n    next',
		width: 8,
		display: 'hello\nworld\n\n  code\n    next',
	},
	{source: 'hello  world', width: 8, display: 'hello\nworld'},
	{source: 'abcde fgh', width: 5, display: 'abcde\n fgh'},
	{source: '日本語日本語', width: 5, display: '日本\n語日\n本語'},
	{source: 'hello  world', width: 8, display: 'hello  w\norld', wrap: 'hard'},
	{
		source: '\u001B[31mhello world\u001B[39m',
		width: 8,
		display: 'hello \nworld',
	},
];
for (const fixture of fixtures) {
	test(`rendered wraps copy source text: ${fixture.wrap ?? 'wrap'}, ${fixture.source.length} chars: ${JSON.stringify(fixture.source)}`, async t => {
		let handle: TextSelectionHandle | undefined;
		function Fixture() {
			handle = useTextSelectionActions();
			return (
				<Box width={fixture.width}>
					<Text wrap={fixture.wrap}>{fixture.source}</Text>
				</Box>
			);
		}

		const stdout = createStdout(40);
		const instance = render(<Fixture />, {stdout, debug: true});
		t.teardown(() => {
			instance.unmount();
		});
		await instance.waitUntilRenderFlush();
		t.is(stripAnsi(stdout.get()).trimEnd(), fixture.display);
		t.truthy(handle);
		handle!.start({x: 0, y: 0});
		handle!.update({
			x: fixture.width,
			y: fixture.display.split('\n').length - 1,
		});
		t.is(handle!.getSnapshot().text, stripAnsi(fixture.source));
	});
}
