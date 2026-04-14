import React, {useEffect, useRef, useState} from 'react';
import test from 'ava';
import delay from 'delay';
import {Box, type DOMElement, render, Text} from '../src/index.js';
import createStdout from './helpers/create-stdout.js';
import {renderToString} from './helpers/render-to-string.js';

type ScrollableBoxRef = DOMElement & {
	scrollTo: (options: {x?: number; y?: number}) => void;
	getScrollPosition: () => {x: number; y: number};
	scrollToTop: () => void;
	scrollToBottom: () => void;
	getBounds: () => {x: number; y: number; width: number; height: number};
};

const waitForWriteCount = async (
	stdout: {getWrites: () => string[]},
	expectedWrites: number,
) => waitForWriteCountWithRetries(stdout, expectedWrites, 50);

const waitForWriteCountWithRetries = async (
	stdout: {getWrites: () => string[]},
	expectedWrites: number,
	retriesLeft: number,
): Promise<void> => {
	if (stdout.getWrites().length >= expectedWrites) {
		return;
	}

	if (retriesLeft === 0) {
		throw new Error(`Timed out waiting for ${expectedWrites} writes`);
	}

	await delay(20);
	return waitForWriteCountWithRetries(stdout, expectedWrites, retriesLeft - 1);
};

test('overflow scroll clips horizontal content', t => {
	const output = renderToString(
		<Box width={6} overflowX="scroll">
			<Box width={16} flexShrink={0}>
				<Text>Hello World</Text>
			</Box>
		</Box>,
	);

	t.is(output, 'Hello');
});

test('scrollTo updates the visible vertical window', async t => {
	const stdout = createStdout(100);

	function ScrollFixture() {
		const ref = useRef<ScrollableBoxRef>(null);
		const [ready, setReady] = useState(false);

		useEffect(() => {
			setReady(true);
		}, []);

		useEffect(() => {
			if (ready) {
				ref.current?.scrollTo({y: 2});
			}
		}, [ready]);

		return (
			<Box
				ref={ref}
				width={10}
				height={3}
				overflow="scroll"
				flexDirection="column"
			>
				{Array.from({length: 5}, (_, index) => (
					<Box key={index} flexShrink={0}>
						<Text>Line {index + 1}</Text>
					</Box>
				))}
			</Box>
		);
	}

	render(<ScrollFixture />, {stdout, debug: true});
	await waitForWriteCount(stdout, 3);

	const output = stdout.get();
	t.true(output.includes('Line 3'));
	t.true(output.includes('Line 4'));
	t.true(output.includes('Line 5'));
	t.false(output.includes('Line 1'));
});

test('getScrollPosition and scrollToBottom clamp to the valid range', async t => {
	const stdout = createStdout(100);
	let capturedPosition: {x: number; y: number} | undefined;

	function ScrollFixture() {
		const ref = useRef<ScrollableBoxRef>(null);
		const [ready, setReady] = useState(false);

		useEffect(() => {
			setReady(true);
		}, []);

		useEffect(() => {
			if (!ready || !ref.current) {
				return;
			}

			ref.current.scrollTo({x: 10, y: 100});
			ref.current.scrollToBottom();
			capturedPosition = ref.current.getScrollPosition();
		}, [ready]);

		return (
			<Box
				ref={ref}
				width={10}
				height={3}
				overflow="scroll"
				flexDirection="column"
			>
				<Box width={20} flexShrink={0}>
					<Text>Very long content here</Text>
				</Box>
				{Array.from({length: 10}, (_, index) => (
					<Box key={index} flexShrink={0}>
						<Text>Line {index}</Text>
					</Box>
				))}
			</Box>
		);
	}

	render(<ScrollFixture />, {stdout, debug: true});
	await waitForWriteCount(stdout, 3);

	t.deepEqual(capturedPosition, {x: 10, y: 9});
});

test('getBounds reports the rendered box metrics', t => {
	const stdout = createStdout(100);
	let capturedBounds:
		| {x: number; y: number; width: number; height: number}
		| undefined;

	function BoundsFixture() {
		const ref = useRef<ScrollableBoxRef>(null);

		useEffect(() => {
			capturedBounds = ref.current?.getBounds();
		}, []);

		return (
			<Box ref={ref} width={12} height={4}>
				<Text>Bounds</Text>
			</Box>
		);
	}

	render(<BoundsFixture />, {stdout, debug: true});

	t.deepEqual(capturedBounds, {x: 0, y: 0, width: 12, height: 4});
});

test('scroll offsets preserve line precision', async t => {
	const stdout = createStdout(100);

	function OffsetFixture() {
		const ref = useRef<ScrollableBoxRef>(null);
		const [ready, setReady] = useState(false);

		useEffect(() => {
			setReady(true);
		}, []);

		useEffect(() => {
			if (ready) {
				ref.current?.scrollTo({y: 1});
			}
		}, [ready]);

		return (
			<Box
				ref={ref}
				width={10}
				height={3}
				overflow="scroll"
				flexDirection="column"
			>
				<Box flexDirection="column" flexShrink={0}>
					<Text>A1</Text>
					<Text>A2</Text>
				</Box>
				<Box flexShrink={0}>
					<Text>B1</Text>
				</Box>
				<Box flexShrink={0}>
					<Text>C1</Text>
				</Box>
			</Box>
		);
	}

	render(<OffsetFixture />, {stdout, debug: true});
	await waitForWriteCount(stdout, 3);

	t.is(stdout.get().trimEnd(), 'A2\nB1\nC1');
});
