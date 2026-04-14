import test from 'ava';
import React from 'react';
import * as Ink from '../src/index.js';
import createStdout from './helpers/create-stdout.js';

test('public v7 api exports are available', t => {
	for (const exportName of [
		'renderToString',
		'usePaste',
		'useAnimation',
		'useWindowSize',
		'useBoxMetrics',
		'useCursor',
	]) {
		t.is(
			typeof (Ink as Record<string, unknown>)[exportName],
			'function',
			`${exportName} should be exported`,
		);
	}
});

test('render instance exposes waitUntilRenderFlush', t => {
	const stdout = createStdout();
	const instance = Ink.render(<Ink.Text>Hello</Ink.Text>, {stdout});

	t.is(
		typeof (instance as {waitUntilRenderFlush?: unknown}).waitUntilRenderFlush,
		'function',
	);

	instance.unmount();
});
