import React, {useEffect, useRef, useState} from 'react';
import test from 'ava';
import delay from 'delay';
import stripAnsi from 'strip-ansi';
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

const rootOf = (node: NonNullable<BoxRef>): NonNullable<BoxRef> => {
	let root = node;
	while (root.parentNode) root = root.parentNode as NonNullable<BoxRef>;
	return root;
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

	// GetBounds() returns the pinned position because renderStickyNode recorded
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

test('paint order follows zIndex instead of declaration order', async t => {
	const stdout = createStdout(100);
	const topRef = React.createRef<BoxRef>();
	const lowRef = React.createRef<BoxRef>();
	const instance = render(
		<Box width={3} height={1}>
			<Box ref={topRef} position="absolute" top={0} left={0} zIndex={10}>
				<Text>TOP</Text>
			</Box>
			<Box ref={lowRef} position="absolute" top={0} left={0} zIndex={0}>
				<Text>LOW</Text>
			</Box>
		</Box>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	const topOrder = topRef.current?.getPaintOrder();
	const lowOrder = lowRef.current?.getPaintOrder();
	t.truthy(topOrder);
	t.truthy(lowOrder);
	t.is(topOrder?.epoch, lowOrder?.epoch);
	t.true((topOrder?.index ?? -1) > (lowOrder?.index ?? -1));
});

test('paint order keeps a high-z descendant below a later parent sibling', async t => {
	const stdout = createStdout(100);
	const descendantRef = React.createRef<BoxRef>();
	const siblingRef = React.createRef<BoxRef>();
	const instance = render(
		<Box width={3} height={1}>
			<Box position="absolute" top={0} left={0} zIndex={0}>
				<Box ref={descendantRef} zIndex={100}>
					<Text>LOW</Text>
				</Box>
			</Box>
			<Box ref={siblingRef} position="absolute" top={0} left={0} zIndex={10}>
				<Text>TOP</Text>
			</Box>
		</Box>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	const descendantOrder = descendantRef.current?.getPaintOrder();
	const siblingOrder = siblingRef.current?.getPaintOrder();
	t.truthy(descendantOrder);
	t.truthy(siblingOrder);
	t.is(descendantOrder?.epoch, siblingOrder?.epoch);
	t.true((descendantOrder?.index ?? -1) < (siblingOrder?.index ?? -1));
});

test('paint order records a sticky header after the row it covers', async t => {
	const stdout = createStdout(100);
	const containerRef = React.createRef<BoxRef>();
	const headerRef = React.createRef<BoxRef>();
	const coveredRowRef = React.createRef<BoxRef>();

	const instance = render(
		<Box
			ref={containerRef}
			width={20}
			height={3}
			overflow="scroll"
			flexDirection="column"
		>
			<Box ref={headerRef} position="sticky" top={0} flexShrink={0}>
				<Text>HEADER</Text>
			</Box>
			{Array.from({length: 10}, (_, index) => (
				<Box
					key={index}
					ref={index === 4 ? coveredRowRef : undefined}
					flexShrink={0}
				>
					<Text>Item {index}</Text>
				</Box>
			))}
		</Box>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	containerRef.current?.scrollTo({y: 5});
	await instance.waitUntilRenderFlush();

	const headerOrder = headerRef.current?.getPaintOrder();
	const coveredRowOrder = coveredRowRef.current?.getPaintOrder();
	t.truthy(headerOrder);
	t.truthy(coveredRowOrder);
	t.is(headerOrder?.epoch, coveredRowOrder?.epoch);
	t.true((headerOrder?.index ?? -1) > (coveredRowOrder?.index ?? -1));
});

test('paint order hides an element that was not painted in the current frame', async t => {
	const stdout = createStdout(100);
	const ref = React.createRef<BoxRef>();
	const frame = (display: 'flex' | 'none') => (
		<Box width={4} height={1}>
			<Box ref={ref} display={display}>
				<Text>item</Text>
			</Box>
		</Box>
	);
	const instance = render(frame('flex'), {stdout, debug: true});
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	t.truthy(ref.current?.getPaintOrder());
	instance.rerender(frame('none'));
	await instance.waitUntilRenderFlush();

	t.is(ref.current?.getPaintOrder(), undefined);
});

test('VLBox sticky index preserves pinning order and pointer bounds', async t => {
	const stdout = createStdout(100);
	const containerRef = React.createRef<VLBoxRef>();
	const headerRef = React.createRef<BoxRef>();
	const coveredRowRef = React.createRef<BoxRef>();

	const instance = render(
		<VLBox
			ref={containerRef}
			width={20}
			height={3}
			overflow="scroll"
			flexDirection="column"
		>
			<Box ref={headerRef} position="sticky" top={0} flexShrink={0}>
				<Text>HEADER</Text>
			</Box>
			{Array.from({length: 10}, (_, index) => (
				<Box
					key={index}
					ref={index === 4 ? coveredRowRef : undefined}
					flexShrink={0}
				>
					<Text>Item {index}</Text>
				</Box>
			))}
		</VLBox>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	containerRef.current?.scrollTo({y: 5});
	await instance.waitUntilRenderFlush();

	const lines = stdout.get().split('\n');
	t.true(lines[0]?.includes('HEADER'));
	t.is(
		(stdout.get().match(/HEADER/g) ?? []).length,
		1,
		'HEADER must paint exactly once through the sticky index',
	);

	const headerBounds = headerRef.current?.getBounds();
	const containerBounds = containerRef.current?.getBounds();
	t.truthy(headerBounds);
	t.truthy(containerBounds);
	t.is(headerBounds!.y, containerBounds!.y);

	const headerOrder = headerRef.current?.getPaintOrder();
	const coveredRowOrder = coveredRowRef.current?.getPaintOrder();
	t.truthy(headerOrder);
	t.truthy(coveredRowOrder);
	t.is(headerOrder?.epoch, coveredRowOrder?.epoch);
	t.true((headerOrder?.index ?? -1) > (coveredRowOrder?.index ?? -1));
});

test('VLBox paints a nested sticky once with its pinned parent', async t => {
	const boxStdout = createStdout(100);
	const vlBoxStdout = createStdout(100);
	const boxContainerRef = React.createRef<BoxRef>();
	const vlBoxContainerRef = React.createRef<VLBoxRef>();
	const outerStickyRef = React.createRef<BoxRef>();
	const nestedStickyRef = React.createRef<BoxRef>();
	const coveredRowRef = React.createRef<BoxRef>();

	const children = (
		outerRef?: React.Ref<BoxRef>,
		nestedRef?: React.Ref<BoxRef>,
		rowRef?: React.Ref<BoxRef>,
	) => (
		<>
			<Box flexShrink={0}>
				<Text>before</Text>
			</Box>
			<Box
				ref={outerRef}
				position="sticky"
				top={0}
				flexDirection="column"
				flexShrink={0}
			>
				<Text>OUTER</Text>
				<Box ref={nestedRef} position="sticky" top={0} flexShrink={0}>
					<Text>INNER</Text>
				</Box>
			</Box>
			{Array.from({length: 8}, (_, index) => (
				<Box key={index} ref={index === 0 ? rowRef : undefined} flexShrink={0}>
					<Text>row {index}</Text>
				</Box>
			))}
		</>
	);

	const boxInstance = render(
		<Box
			ref={boxContainerRef}
			width={20}
			height={4}
			overflow="scroll"
			flexDirection="column"
		>
			{children()}
		</Box>,
		{stdout: boxStdout, debug: true},
	);
	const vlBoxInstance = render(
		<VLBox
			ref={vlBoxContainerRef}
			width={20}
			height={4}
			overflow="scroll"
			flexDirection="column"
		>
			{children(outerStickyRef, nestedStickyRef, coveredRowRef)}
		</VLBox>,
		{stdout: vlBoxStdout, debug: true},
	);
	t.teardown(() => {
		boxInstance.unmount();
		vlBoxInstance.unmount();
	});
	await Promise.all([
		waitForWriteCount(boxStdout, 1),
		waitForWriteCount(vlBoxStdout, 1),
	]);

	boxContainerRef.current?.scrollTo({y: 2});
	vlBoxContainerRef.current?.scrollTo({y: 2});
	await Promise.all([
		boxInstance.waitUntilRenderFlush(),
		vlBoxInstance.waitUntilRenderFlush(),
	]);

	const output = vlBoxStdout.get();
	t.is(
		output,
		boxStdout.get(),
		'VLBox output must remain byte-identical to Box',
	);
	t.is(
		(output.match(/INNER/g) ?? []).length,
		1,
		'nested sticky must paint only with its nearest sticky ancestor',
	);

	const containerBounds = vlBoxContainerRef.current?.getBounds();
	const outerBounds = outerStickyRef.current?.getBounds();
	const nestedBounds = nestedStickyRef.current?.getBounds();
	t.truthy(containerBounds);
	t.truthy(outerBounds);
	t.truthy(nestedBounds);
	t.is(outerBounds!.y, containerBounds!.y);
	t.is(nestedBounds!.y, outerBounds!.y + 1);

	const coveredOrder = coveredRowRef.current?.getPaintOrder();
	const outerOrder = outerStickyRef.current?.getPaintOrder();
	const nestedOrder = nestedStickyRef.current?.getPaintOrder();
	t.truthy(coveredOrder);
	t.truthy(outerOrder);
	t.truthy(nestedOrder);
	t.is(outerOrder?.epoch, coveredOrder?.epoch);
	t.is(nestedOrder?.epoch, outerOrder?.epoch);
	t.true((outerOrder?.index ?? -1) > (coveredOrder?.index ?? -1));
	t.true((nestedOrder?.index ?? -1) > (outerOrder?.index ?? -1));
});

test('VLBox sticky index defers nested normal scroll boxes to traversal', async t => {
	const stdout = createStdout(100);
	const nestedScrollRef = React.createRef<BoxRef>();
	const nestedStickyRef = React.createRef<BoxRef>();

	const instance = render(
		<VLBox width={24} height={5} overflow="scroll" flexDirection="column">
			<Box
				ref={nestedScrollRef}
				height={3}
				overflow="scroll"
				flexDirection="column"
				flexShrink={0}
			>
				{Array.from({length: 5}, (_, index) => (
					<Box key={index} flexShrink={0}>
						<Text>Nested {index}</Text>
					</Box>
				))}
				<Box ref={nestedStickyRef} position="sticky" top={0} flexShrink={0}>
					<Text>NESTED STICKY</Text>
				</Box>
				{/* Trailing rows so max scroll can lift the sticky to the nested top. */}
				{Array.from({length: 5}, (_, index) => (
					<Box key={`after-${index}`} flexShrink={0}>
						<Text>After {index}</Text>
					</Box>
				))}
			</Box>
			<Text>outer tail</Text>
		</VLBox>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	// Scroll the nested normal Box so the sticky row pins inside it while the
	// nested container itself remains visible in the outer VLBox.
	nestedScrollRef.current?.scrollTo({y: 5});
	await instance.waitUntilRenderFlush();

	const output = stdout.get();
	t.is(
		(output.match(/NESTED STICKY/g) ?? []).length,
		1,
		'nested sticky must paint exactly once via traversal-time stickyNodes',
	);

	const nestedBounds = nestedScrollRef.current?.getBounds();
	const stickyBounds = nestedStickyRef.current?.getBounds();
	t.truthy(nestedBounds);
	t.truthy(stickyBounds);
	t.is(stickyBounds!.y, nestedBounds!.y);

	const stickyOrder = nestedStickyRef.current?.getPaintOrder();
	t.truthy(stickyOrder);
	t.is(
		stickyOrder?.epoch,
		rootOf(nestedStickyRef.current!).internal_paintEpoch,
	);
});

test('VLBox sticky index rebuilds after Yoga-clean ownership and z-index changes', async t => {
	const stdout = createStdout(100);
	const viewportRef = React.createRef<VLBoxRef>();
	const outerStickyRef = React.createRef<BoxRef>();
	const nestedRef = React.createRef<BoxRef>();
	const nestedStickyRef = React.createRef<BoxRef>();
	const midRowRef = React.createRef<BoxRef>();

	const frame = (stickyZ: number, nestedOverflow: 'hidden' | 'scroll') => (
		<VLBox
			ref={viewportRef}
			width={24}
			height={6}
			overflow="scroll"
			flexDirection="column"
		>
			<Box
				ref={outerStickyRef}
				position="sticky"
				top={0}
				zIndex={stickyZ}
				flexShrink={0}
			>
				<Text>OUTER STICKY</Text>
			</Box>
			<Box ref={midRowRef} flexShrink={0}>
				<Text>mid row</Text>
			</Box>
			<Box
				ref={nestedRef}
				height={3}
				overflow={nestedOverflow}
				flexDirection="column"
				flexShrink={0}
			>
				{Array.from({length: 4}, (_, index) => (
					<Box key={index} flexShrink={0}>
						<Text>Nested {index}</Text>
					</Box>
				))}
				<Box ref={nestedStickyRef} position="sticky" top={0} flexShrink={0}>
					<Text>INNER STICKY</Text>
				</Box>
				{Array.from({length: 4}, (_, index) => (
					<Box key={`after-${index}`} flexShrink={0}>
						<Text>After {index}</Text>
					</Box>
				))}
			</Box>
			{Array.from({length: 8}, (_, index) => (
				<Box key={`tail-${index}`} flexShrink={0}>
					<Text>tail {index}</Text>
				</Box>
			))}
		</VLBox>
	);

	const instance = render(frame(0, 'hidden'), {stdout, debug: true});
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	const firstMetadata = viewportRef.current?.internal_scrollViewportMetadata;
	const layoutEpoch = rootOf(viewportRef.current!).internal_layoutEpoch;
	t.truthy(firstMetadata);
	t.is(firstMetadata?.stickyCandidates.length, 2);
	t.true(
		firstMetadata!.stickyCandidates.some(
			candidate => candidate.node === outerStickyRef.current,
		),
	);
	t.true(
		firstMetadata!.stickyCandidates.some(
			candidate => candidate.node === nestedStickyRef.current,
		),
	);

	instance.rerender(frame(10, 'scroll'));
	await instance.waitUntilRenderFlush();

	t.is(rootOf(viewportRef.current!).internal_layoutEpoch, layoutEpoch);
	const rebuiltMetadata = viewportRef.current?.internal_scrollViewportMetadata;
	t.truthy(rebuiltMetadata);
	t.not(rebuiltMetadata, firstMetadata);
	// Nested normal scroll clears indexed ownership; only the outer sticky remains.
	t.is(rebuiltMetadata!.stickyCandidates.length, 1);
	t.is(rebuiltMetadata!.stickyCandidates[0]?.node, outerStickyRef.current);

	const writesAfterRebuild = stdout.getWrites().length;
	viewportRef.current?.scrollTo({y: 1});
	await waitForWriteCount(stdout, writesAfterRebuild + 1);

	const outerOrder = outerStickyRef.current?.getPaintOrder();
	const midOrder = midRowRef.current?.getPaintOrder();
	t.truthy(outerOrder);
	t.truthy(midOrder);
	t.is(outerOrder?.epoch, midOrder?.epoch);
	t.true((outerOrder?.index ?? -1) > (midOrder?.index ?? -1));

	const writesAfterOuterScroll = stdout.getWrites().length;
	nestedRef.current?.scrollTo({y: 4});
	await waitForWriteCount(stdout, writesAfterOuterScroll + 1);
	t.deepEqual(nestedRef.current?.getScrollPosition(), {x: 0, y: 4});

	t.is((stdout.get().match(/INNER STICKY/g) ?? []).length, 1);
	t.truthy(nestedStickyRef.current?.getPaintOrder());
	// Nested Box getBounds is layout-space (no ancestor scroll). The sticky pins
	// to the nested viewport's drawn top = layout y - outer scroll y.
	const nestedLayoutY = nestedRef.current!.getBounds().y;
	const outerScrollY = viewportRef.current!.getScrollPosition().y;
	t.is(nestedStickyRef.current?.getBounds().y, nestedLayoutY - outerScrollY);
});

test('VLBox bounds direct-child surface work beneath a pinned indexed sticky', async t => {
	const stdout = createStdout(40);
	const viewportRef = React.createRef<VLBoxRef>();
	const stickyRef = React.createRef<BoxRef>();
	const surfaceRef = React.createRef<BoxRef>();

	const instance = render(
		<VLBox
			ref={viewportRef}
			width={12}
			height={3}
			overflow="scroll"
			flexDirection="column"
		>
			<Box height={1} flexShrink={0}>
				<Text>before</Text>
			</Box>
			<Box
				ref={stickyRef}
				position="sticky"
				top={0}
				width={12}
				height={1}
				flexShrink={0}
			>
				<Box
					ref={surfaceRef}
					position="absolute"
					width={500}
					height={500}
					borderStyle="single"
					backgroundColor="red"
				/>
			</Box>
			{Array.from({length: 5}, (_, index) => (
				<Box key={index} flexShrink={0}>
					<Text>row {index}</Text>
				</Box>
			))}
		</VLBox>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	const surface = surfaceRef.current!;
	let surfaceWriteCount = surface.internal_lastSurfaceWriteCount;
	let surfaceCellCount = surface.internal_lastSurfaceCellCount;
	let maximumWriteCount = surfaceWriteCount ?? 0;
	let maximumCellCount = surfaceCellCount ?? 0;
	Object.defineProperty(surface, 'internal_lastSurfaceWriteCount', {
		configurable: true,
		get() {
			return surfaceWriteCount;
		},
		set(value: number | undefined) {
			surfaceWriteCount = value;
			maximumWriteCount = Math.max(maximumWriteCount, value ?? 0);
		},
	});
	Object.defineProperty(surface, 'internal_lastSurfaceCellCount', {
		configurable: true,
		get() {
			return surfaceCellCount;
		},
		set(value: number | undefined) {
			surfaceCellCount = value;
			maximumCellCount = Math.max(maximumCellCount, value ?? 0);
		},
	});

	viewportRef.current?.scrollTo({y: 1});
	await instance.waitUntilRenderFlush();

	const viewportBounds = viewportRef.current?.getBounds();
	const stickyBounds = stickyRef.current?.getBounds();
	t.truthy(viewportBounds);
	t.truthy(stickyBounds);
	t.is(stickyBounds!.y, viewportBounds!.y);
	t.true(stripAnsi(stdout.get()).startsWith('┌───────────\n│'));
	t.true(
		maximumWriteCount < 40,
		`writes ${maximumWriteCount} should stay viewport-bounded across resets`,
	);
	t.true(
		maximumCellCount < 12 * 3 * 4,
		`cells ${maximumCellCount} should stay viewport-bounded across resets`,
	);
	t.is(surface.internal_lastSurfaceWriteCount, maximumWriteCount);
	t.is(surface.internal_lastSurfaceCellCount, maximumCellCount);
});

test('VLBox clears stale bounds when a nested sticky is culled with its indexed ancestor', async t => {
	const stdout = createStdout(40);
	const viewportRef = React.createRef<VLBoxRef>();
	const outerStickyRef = React.createRef<BoxRef>();
	const nestedStickyRef = React.createRef<BoxRef>();

	const instance = render(
		<VLBox
			ref={viewportRef}
			width={12}
			height={4}
			overflow="scroll"
			flexDirection="column"
		>
			<Box height={3} flexDirection="column" flexShrink={0}>
				<Box height={2} flexShrink={0} />
				<Box
					ref={outerStickyRef}
					position="sticky"
					top={0}
					height={1}
					flexShrink={0}
				>
					<Text>OUTER</Text>
					<Box position="absolute" top={0} width={12} height={1}>
						<Box
							ref={nestedStickyRef}
							position="sticky"
							top={-1}
							height={1}
							flexShrink={0}
						>
							<Text>NESTED</Text>
						</Box>
					</Box>
				</Box>
			</Box>
			{Array.from({length: 5}, (_, index) => (
				<Box key={index} flexShrink={0}>
					<Text>row {index}</Text>
				</Box>
			))}
		</VLBox>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	viewportRef.current?.scrollTo({y: 1});
	await instance.waitUntilRenderFlush();
	const visibleBounds = nestedStickyRef.current?.getBounds();
	t.truthy(visibleBounds);
	t.is(visibleBounds!.y, viewportRef.current!.getBounds().y);
	t.truthy(nestedStickyRef.current?.getPaintOrder());

	viewportRef.current?.scrollTo({y: 2});
	await instance.waitUntilRenderFlush();

	t.true(stripAnsi(stdout.get()).split('\n')[0]?.includes('OUTER'));
	t.false(stripAnsi(stdout.get()).includes('NESTED'));
	t.is(nestedStickyRef.current?.getPaintOrder(), undefined);
	t.notDeepEqual(nestedStickyRef.current?.getBounds(), visibleBounds);
	t.is(nestedStickyRef.current?.internal_stickyRect, undefined);
});

test('VLBox clears stale bounds for a culled direct child of an indexed sticky', async t => {
	const stdout = createStdout(40);
	const viewportRef = React.createRef<VLBoxRef>();
	const nestedStickyRef = React.createRef<BoxRef>();

	const instance = render(
		<VLBox
			ref={viewportRef}
			width={12}
			height={4}
			overflow="scroll"
			flexDirection="column"
		>
			<Box height={3} flexDirection="column" flexShrink={0}>
				<Box height={2} flexShrink={0} />
				<Box position="sticky" top={0} height={1} flexShrink={0}>
					<Text>OUTER</Text>
					<Box
						ref={nestedStickyRef}
						position="sticky"
						top={-1}
						height={1}
						flexShrink={0}
					>
						<Text>NESTED</Text>
					</Box>
				</Box>
			</Box>
			{Array.from({length: 5}, (_, index) => (
				<Box key={index} flexShrink={0}>
					<Text>row {index}</Text>
				</Box>
			))}
		</VLBox>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	viewportRef.current?.scrollTo({y: 1});
	await instance.waitUntilRenderFlush();
	const visibleBounds = nestedStickyRef.current?.getBounds();
	t.truthy(visibleBounds);
	t.is(visibleBounds!.y, viewportRef.current!.getBounds().y);
	t.truthy(nestedStickyRef.current?.getPaintOrder());

	viewportRef.current?.scrollTo({y: 2});
	await instance.waitUntilRenderFlush();

	t.true(stripAnsi(stdout.get()).split('\n')[0]?.includes('OUTER'));
	t.false(stripAnsi(stdout.get()).includes('NESTED'));
	t.is(nestedStickyRef.current?.getPaintOrder(), undefined);
	t.notDeepEqual(nestedStickyRef.current?.getBounds(), visibleBounds);
});

test('VLBox bounds a wide pinned indexed sticky root surface', async t => {
	const stdout = createStdout(40);
	const viewportRef = React.createRef<VLBoxRef>();
	const stickyRef = React.createRef<BoxRef>();

	const instance = render(
		<VLBox
			ref={viewportRef}
			width={12}
			height={4}
			overflow="scroll"
			flexDirection="column"
		>
			<Box height={1} flexShrink={0}>
				<Text>before</Text>
			</Box>
			<Box
				ref={stickyRef}
				position="sticky"
				top={0}
				width={500}
				height={3}
				borderStyle="single"
				backgroundColor="red"
				flexShrink={0}
			/>
			{Array.from({length: 5}, (_, index) => (
				<Box key={index} flexShrink={0}>
					<Text>row {index}</Text>
				</Box>
			))}
		</VLBox>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	const sticky = stickyRef.current!;
	let surfaceWriteCount = 0;
	let surfaceCellCount = 0;
	let maximumWriteCount = 0;
	let maximumCellCount = 0;
	Object.defineProperty(sticky, 'internal_lastSurfaceWriteCount', {
		configurable: true,
		get() {
			return surfaceWriteCount;
		},
		set(value: number | undefined) {
			surfaceWriteCount = value ?? 0;
			maximumWriteCount = Math.max(maximumWriteCount, value ?? 0);
		},
	});
	Object.defineProperty(sticky, 'internal_lastSurfaceCellCount', {
		configurable: true,
		get() {
			return surfaceCellCount;
		},
		set(value: number | undefined) {
			surfaceCellCount = value ?? 0;
			maximumCellCount = Math.max(maximumCellCount, value ?? 0);
		},
	});

	viewportRef.current?.scrollTo({y: 1});
	await instance.waitUntilRenderFlush();

	const viewportBounds = viewportRef.current?.getBounds();
	const stickyBounds = sticky.getBounds();
	t.truthy(viewportBounds);
	t.is(stickyBounds.y, viewportBounds!.y);
	t.deepEqual(stripAnsi(stdout.get()).split('\n').slice(0, 3), [
		'┌───────────',
		'│',
		'└───────────',
	]);
	t.true(
		maximumWriteCount < 40,
		`writes ${maximumWriteCount} should stay viewport-bounded across resets`,
	);
	t.true(
		maximumCellCount < 12 * 3 * 4,
		`cells ${maximumCellCount} should stay viewport-bounded across resets`,
	);
	t.is(sticky.internal_lastSurfaceWriteCount, maximumWriteCount);
	t.is(sticky.internal_lastSurfaceCellCount, maximumCellCount);
});

test('VLBox rejects a wholly horizontally off-screen indexed sticky root', async t => {
	const stdout = createStdout(40);
	const stickyRef = React.createRef<BoxRef>();
	const childRef = React.createRef<BoxRef>();

	const instance = render(
		<VLBox width={12} height={4} overflow="scroll" flexDirection="column">
			<Box height={1} flexShrink={0}>
				<Text>visible</Text>
			</Box>
			<Box
				ref={stickyRef}
				position="sticky"
				top={0}
				left={30}
				width={6}
				height={3}
				borderStyle="single"
				backgroundColor="red"
				flexShrink={0}
			>
				<Box ref={childRef}>
					<Text>HIDDEN</Text>
				</Box>
			</Box>
		</VLBox>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	t.false(stripAnsi(stdout.get()).includes('HIDDEN'));
	t.is(stickyRef.current?.getPaintOrder(), undefined);
	t.is(stickyRef.current?.internal_stickyRect, undefined);
	t.is(stickyRef.current?.internal_lastSurfaceWriteCount, undefined);
	t.is(stickyRef.current?.internal_lastSurfaceCellCount, undefined);
	t.is(childRef.current?.getPaintOrder(), undefined);
});

test('sticky getBounds ignores a prior epoch rect when its indexed root is rejected', async t => {
	const stdout = createStdout(40);
	const viewportRef = React.createRef<VLBoxRef>();
	const rootStickyRef = React.createRef<BoxRef>();
	const nestedStickyRef = React.createRef<BoxRef>();

	const instance = render(
		<VLBox
			ref={viewportRef}
			width={12}
			height={4}
			overflow="scroll"
			flexDirection="column"
		>
			<Box height={1} flexShrink={0}>
				<Text>before</Text>
			</Box>
			<Box
				ref={rootStickyRef}
				position="sticky"
				top={0}
				width={6}
				height={2}
				flexShrink={0}
			>
				<Text>ROOT</Text>
				<Box
					ref={nestedStickyRef}
					position="sticky"
					top={0}
					width={6}
					height={1}
					borderStyle="single"
					backgroundColor="red"
					flexShrink={0}
				/>
			</Box>
			<Box width={40} height={1} flexShrink={0}>
				<Text>abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN</Text>
			</Box>
			{Array.from({length: 2}, (_, index) => (
				<Box key={index} flexShrink={0}>
					<Text>tail {index}</Text>
				</Box>
			))}
		</VLBox>,
		{stdout, debug: true},
	);
	t.teardown(() => {
		instance.unmount();
	});
	await waitForWriteCount(stdout, 1);

	viewportRef.current?.scrollTo({x: 0, y: 1});
	await instance.waitUntilRenderFlush();
	const visibleBounds = nestedStickyRef.current?.getBounds();
	const storedVisibleRect = nestedStickyRef.current?.internal_stickyRect;
	t.truthy(visibleBounds);
	t.truthy(storedVisibleRect);
	t.is(
		rootStickyRef.current?.getBounds().y,
		viewportRef.current?.getBounds().y,
	);
	t.truthy(nestedStickyRef.current?.getPaintOrder());

	nestedStickyRef.current!.internal_lastSurfaceWriteCount = 0;
	nestedStickyRef.current!.internal_lastSurfaceCellCount = 0;
	viewportRef.current?.scrollTo({x: 20});
	await instance.waitUntilRenderFlush();

	const output = stripAnsi(stdout.get());
	t.false(output.includes('ROOT'));
	t.true(output.includes('uvwxyzABCDEF'));
	t.is(rootStickyRef.current?.getPaintOrder(), undefined);
	t.is(nestedStickyRef.current?.getPaintOrder(), undefined);
	t.is(nestedStickyRef.current?.internal_lastSurfaceWriteCount, 0);
	t.is(nestedStickyRef.current?.internal_lastSurfaceCellCount, 0);
	t.deepEqual(nestedStickyRef.current?.internal_stickyRect, storedVisibleRect);
	t.notDeepEqual(nestedStickyRef.current?.getBounds(), visibleBounds);
});
