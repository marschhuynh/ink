import React, {useEffect, useRef, useState} from 'react';
import test from 'ava';
import delay from 'delay';
import {Box, type BoxRef, render, Text} from '../src/index.js';
import createStdout from './helpers/create-stdout.js';
import {renderToString} from './helpers/render-to-string.js';

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

test('sticky element stays pinned to the top of a scroll container', async t => {
	const stdout = createStdout(100);

	function StickyFixture() {
		const ref = useRef<BoxRef>(null);
		const [ready, setReady] = useState(false);

		useEffect(() => {
			setReady(true);
		}, []);

		useEffect(() => {
			if (ready) {
				ref.current?.scrollTo({y: 5});
			}
		}, [ready]);

		return (
			<Box
				ref={ref}
				width={20}
				height={5}
				overflow="scroll"
				flexDirection="column"
			>
				<Box position="sticky" top={0} flexShrink={0}>
					<Text>HEADER</Text>
				</Box>
				{Array.from({length: 20}, (_, index) => (
					<Box key={index} flexShrink={0}>
						<Text>Item {index}</Text>
					</Box>
				))}
			</Box>
		);
	}

	render(<StickyFixture />, {stdout, debug: true});
	await waitForWriteCount(stdout, 3);

	const lines = stdout.get().split('\n');
	t.true(lines[0]?.includes('HEADER'));
	t.false(stdout.get().includes('Item 0'));
});

test('sticky getBounds() reports the pinned drawn position, not the natural-flow position', async t => {
	const stdout = createStdout(100);
	const containerRef = React.createRef<BoxRef>();
	const headerRef = React.createRef<BoxRef>();

	function StickyBoundsFixture() {
		const [ready, setReady] = useState(false);

		useEffect(() => {
			setReady(true);
		}, []);

		useEffect(() => {
			if (ready) {
				// Scroll far enough that the header's natural-flow position (3 rows
				// below the container top) would land above the viewport; the header
				// then pins to the container top instead of scrolling away.
				containerRef.current?.scrollTo({y: 5});
			}
		}, [ready]);

		return (
			<Box
				ref={containerRef}
				width={20}
				height={5}
				overflow="scroll"
				flexDirection="column"
			>
				{Array.from({length: 3}, (_, index) => (
					<Box key={`filler-${index}`} flexShrink={0}>
						<Text>Filler {index}</Text>
					</Box>
				))}
				<Box ref={headerRef} position="sticky" top={0} flexShrink={0}>
					<Text>HEADER</Text>
				</Box>
				{Array.from({length: 20}, (_, index) => (
					<Box key={index} flexShrink={0}>
						<Text>Item {index}</Text>
					</Box>
				))}
			</Box>
		);
	}

	render(<StickyBoundsFixture />, {stdout, debug: true});
	await waitForWriteCount(stdout, 3);

	const headerBounds = headerRef.current?.getBounds();
	const containerBounds = containerRef.current?.getBounds();

	t.truthy(headerBounds);
	t.truthy(containerBounds);

	// The pinned header is drawn at the container's top edge...
	t.is(headerBounds!.y, containerBounds!.y);
	// ...which is distinct from its natural-flow y (3 rows below the top, where
	// the pre-fix yoga-ancestor walk would have reported it).
	t.not(headerBounds!.y, 3);

	// getBounds() returns the pinned position because renderStickyNode recorded
	// the drawn rect on the element.
	t.truthy(headerRef.current?.internal_stickyRect);
	t.is(headerRef.current?.internal_stickyRect?.y, containerBounds!.y);
});

test('sticky element follows normal flow outside a scroll container', t => {
	const output = renderToString(
		<Box width={20} flexDirection="column">
			<Box flexShrink={0}>
				<Text>Before</Text>
			</Box>
			<Box position="sticky" top={0} flexShrink={0}>
				<Text>Sticky</Text>
			</Box>
			<Box flexShrink={0}>
				<Text>After</Text>
			</Box>
		</Box>,
	);

	t.is(output, 'Before\nSticky\nAfter');
});

test('zIndex controls paint order for overlapping positioned boxes', t => {
	const output = renderToString(
		<Box width={3} height={1}>
			<Box position="absolute" top={0} left={0} zIndex={10}>
				<Text>TOP</Text>
			</Box>
			<Box position="absolute" top={0} left={0} zIndex={0}>
				<Text>LOW</Text>
			</Box>
		</Box>,
	);

	t.is(output, 'TOP');
});
