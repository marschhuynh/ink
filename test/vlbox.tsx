import React from 'react';
import test from 'ava';
import delay from 'delay';
import {
	Box,
	type BoxRef,
	render,
	Text,
	VLBox,
	type VLBoxRef,
} from '../src/index.js';
import createStdout from './helpers/create-stdout.js';
import {renderToString} from './helpers/render-to-string.js';

const waitForWriteCount = async (
	stdout: {getWrites: () => string[]},
	expected: number,
	retriesLeft = 50,
): Promise<void> => {
	if (stdout.getWrites().length >= expected) {
		return;
	}

	if (retriesLeft === 0) {
		throw new Error(`Timed out waiting for ${expected} writes`);
	}

	await delay(20);
	return waitForWriteCount(stdout, expected, retriesLeft - 1);
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
		<Box ref={ref} width={20}>
			<Text>first</Text>
		</Box>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);
	const first = rootOf(ref.current!).internal_layoutEpoch;

	instance.rerender(
		<Box ref={ref} width={20}>
			<Text color="red">first</Text>
		</Box>,
	);
	await waitForWriteCount(stdout, 2);
	const paintOnly = rootOf(ref.current!).internal_layoutEpoch;

	instance.rerender(
		<Box ref={ref} width={20}>
			<Text>second content is wider</Text>
		</Box>,
	);
	await waitForWriteCount(stdout, 3);
	const layoutChanged = rootOf(ref.current!).internal_layoutEpoch;

	t.is(typeof first, 'number');
	t.is(paintOnly, first);
	t.is(layoutChanged, first! + 1);
	instance.unmount();
});

test('VLBox preserves Box layout output and exposes the Box ref API', async t => {
	const boxOutput = renderToString(
		<Box width={12} height={3} borderStyle="single" flexDirection="column">
			<Text>one</Text>
			<Text>two</Text>
		</Box>,
		{columns: 30},
	);
	const vlBoxOutput = renderToString(
		<VLBox width={12} height={3} borderStyle="single" flexDirection="column">
			<Text>one</Text>
			<Text>two</Text>
		</VLBox>,
		{columns: 30},
	);
	t.is(vlBoxOutput, boxOutput);

	const stdout = createStdout(30);
	const ref = React.createRef<VLBoxRef>();
	const instance = render(
		<VLBox
			ref={ref}
			width={10}
			height={2}
			overflow="scroll"
			flexDirection="column"
		>
			<Text>one</Text>
			<Text>two</Text>
			<Text>three</Text>
		</VLBox>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);
	t.is(typeof ref.current?.scrollTo, 'function');
	t.true(ref.current?.internal_viewportCulling);
	instance.unmount();
});

test('VLBox root count tracks committed mounts removals and reorders', async t => {
	const stdout = createStdout(30);
	const ref = React.createRef<BoxRef>();
	const instance = render(
		<Box ref={ref} width={20} flexDirection="column">
			<Text>none</Text>
		</Box>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);
	t.is(rootOf(ref.current!).internal_viewportCullingCount ?? 0, 0);

	instance.rerender(
		<Box ref={ref} width={20} flexDirection="column">
			<VLBox width={10}>
				<Text>one</Text>
			</VLBox>
		</Box>,
	);
	await waitForWriteCount(stdout, 2);
	t.is(rootOf(ref.current!).internal_viewportCullingCount, 1);

	instance.rerender(
		<Box ref={ref} width={20} flexDirection="column">
			<VLBox width={10}>
				<VLBox width={8}>
					<Text>nested</Text>
				</VLBox>
			</VLBox>
		</Box>,
	);
	await waitForWriteCount(stdout, 3);
	t.is(rootOf(ref.current!).internal_viewportCullingCount, 2);

	instance.rerender(
		<Box ref={ref} width={20} flexDirection="column">
			<Text key="before">before</Text>
			<VLBox key="keep" width={10}>
				<Text>one</Text>
			</VLBox>
			<Text key="after">after</Text>
		</Box>,
	);
	await waitForWriteCount(stdout, 4);
	t.is(rootOf(ref.current!).internal_viewportCullingCount, 1);

	instance.rerender(
		<Box ref={ref} width={20} flexDirection="column">
			<VLBox key="keep" width={10}>
				<Text>one</Text>
			</VLBox>
			<Text key="before">before</Text>
			<Text key="after">after</Text>
		</Box>,
	);
	await waitForWriteCount(stdout, 5);
	t.is(rootOf(ref.current!).internal_viewportCullingCount, 1);

	instance.rerender(
		<Box ref={ref} width={20} flexDirection="column">
			<Text>none</Text>
		</Box>,
	);
	await waitForWriteCount(stdout, 6);
	t.is(rootOf(ref.current!).internal_viewportCullingCount ?? 0, 0);
	instance.unmount();
});
