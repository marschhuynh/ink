import React from 'react';
import test from 'ava';
import delay from 'delay';
import {Box, type BoxRef, render, Text} from '../src/index.js';
import createStdout from './helpers/create-stdout.js';

const waitForWriteCount = async (
	stdout: {getWrites: () => string[]},
	expected: number,
): Promise<void> => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (stdout.getWrites().length >= expected) return;
		await delay(20);
	}
	throw new Error(`Timed out waiting for ${expected} writes`);
};

const rootOf = (node: NonNullable<BoxRef>): NonNullable<BoxRef> => {
	let root = node;
	while (root.parentNode) root = root.parentNode as NonNullable<BoxRef>;
	return root;
};

test('layout epoch advances only when the Yoga root is dirty', async t => {
	const stdout = createStdout(80);
	const ref = React.createRef<BoxRef>();
	const instance = render(
		<Box ref={ref} width={20}><Text>first</Text></Box>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);
	const first = rootOf(ref.current!).internal_layoutEpoch;

	instance.rerender(
		<Box ref={ref} width={20}><Text color="red">first</Text></Box>,
	);
	await waitForWriteCount(stdout, 2);
	const paintOnly = rootOf(ref.current!).internal_layoutEpoch;

	instance.rerender(
		<Box ref={ref} width={20}><Text>second content is wider</Text></Box>,
	);
	await waitForWriteCount(stdout, 3);
	const layoutChanged = rootOf(ref.current!).internal_layoutEpoch;

	t.is(typeof first, 'number');
	t.is(paintOnly, first);
	t.is(layoutChanged, first! + 1);
	instance.unmount();
});
