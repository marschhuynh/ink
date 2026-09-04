import React from 'react';
import test from 'ava';
import delay from 'delay';
import {
	Box,
	type BoxRef,
	type DOMElement,
	render,
	Text,
	Transform,
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

const firstMatchingElement = (
	node: DOMElement,
	predicate: (child: DOMElement) => boolean,
): DOMElement | undefined => {
	for (const childNode of node.childNodes) {
		if (childNode.nodeName === '#text') {
			continue;
		}

		if (predicate(childNode)) {
			return childNode;
		}
	}

	return undefined;
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

test('appending a host text child to a connected Text does not throw', async t => {
	const stdout = createStdout(30);

	function Test({text}: {readonly text?: string}) {
		return <Text>{text ?? false}</Text>;
	}

	const instance = render(<Test />, {
		stdout,
		debug: true,
	});
	await instance.waitUntilRenderFlush();

	instance.rerender(<Test text="hello" />);
	await instance.waitUntilRenderFlush();

	const contentWrites = stdout
		.getWrites()
		.filter(
			write =>
				write !== '' &&
				!write.startsWith('\u001B[?25') &&
				!write.startsWith('\u001B[?2026'),
		);
	t.is(contentWrites.at(-1), 'hello');
	instance.unmount();
});

test('VLBox reuses current-epoch metadata and cached content extent', async t => {
	const stdout = createStdout(80);
	const viewportRef = React.createRef<VLBoxRef>();
	const instance = render(
		<VLBox
			ref={viewportRef}
			width={10}
			height={3}
			overflow="scroll"
			flexDirection="column"
		>
			{Array.from({length: 10}, (_, index) => (
				<Box key={index} flexShrink={0}>
					<Text>row {index}</Text>
				</Box>
			))}
		</VLBox>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);

	const metadata = viewportRef.current?.internal_scrollViewportMetadata;
	t.truthy(metadata);
	t.is(metadata?.contentExtent.height, 10);
	const epoch = metadata?.epoch;
	viewportRef.current?.scrollToBottom();
	await waitForWriteCount(stdout, 2);
	t.is(viewportRef.current?.internal_scrollViewportMetadata, metadata);
	t.is(viewportRef.current?.internal_scrollViewportMetadata?.epoch, epoch);
	t.deepEqual(viewportRef.current?.getScrollPosition(), {x: 0, y: 7});
	instance.unmount();
});

test('VLBox content extent includes absolute children and respects nested clips', async t => {
	const stdout = createStdout(80);
	const viewportRef = React.createRef<VLBoxRef>();
	const instance = render(
		<VLBox
			ref={viewportRef}
			width={10}
			height={5}
			overflow="scroll"
			flexDirection="column"
		>
			<Box position="absolute" left={14} top={8} width={6} height={2}>
				<Text>abs</Text>
			</Box>
			<Box width={4} height={4} overflow="hidden" flexShrink={0}>
				<Box position="absolute" left={30} top={30} width={20} height={20}>
					<Text>escape</Text>
				</Box>
			</Box>
		</VLBox>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);

	t.deepEqual(
		viewportRef.current?.internal_scrollViewportMetadata?.contentExtent,
		{width: 20, height: 10},
	);
	instance.unmount();
});

test('VLBox rebuilds metadata after a Yoga-clean culling-semantics update', async t => {
	const stdout = createStdout(80);
	const viewportRef = React.createRef<VLBoxRef>();
	const instance = render(
		<VLBox
			ref={viewportRef}
			width={10}
			height={3}
			overflow="scroll"
			flexDirection="column"
			zIndex={0}
		>
			{Array.from({length: 5}, (_, index) => (
				<Box key={index} flexShrink={0}>
					<Text>row {index}</Text>
				</Box>
			))}
		</VLBox>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);

	const firstMetadata = viewportRef.current?.internal_scrollViewportMetadata;
	const layoutEpoch = rootOf(viewportRef.current!).internal_layoutEpoch;
	t.truthy(firstMetadata);

	instance.rerender(
		<VLBox
			ref={viewportRef}
			width={10}
			height={3}
			overflow="hidden"
			flexDirection="column"
			zIndex={1}
		>
			{Array.from({length: 5}, (_, index) => (
				<Box key={index} flexShrink={0}>
					<Text>row {index}</Text>
				</Box>
			))}
		</VLBox>,
	);
	await waitForWriteCount(stdout, 2);

	t.is(rootOf(viewportRef.current!).internal_layoutEpoch, layoutEpoch);
	t.not(viewportRef.current?.internal_scrollViewportMetadata, firstMetadata);
	t.truthy(viewportRef.current?.internal_scrollViewportMetadata);
	instance.unmount();
});

test('VLBox fail-opens metadata for Transform nested under Text virtual-text', async t => {
	const stdout = createStdout(80);
	const viewportRef = React.createRef<VLBoxRef>();
	const instance = render(
		<VLBox
			ref={viewportRef}
			width={20}
			height={3}
			overflow="scroll"
			flexDirection="column"
		>
			<Text>
				<Text>
					<Transform transform={value => value}>nested</Transform>
				</Text>
			</Text>
		</VLBox>,
		{stdout, debug: true},
	);
	await instance.waitUntilRenderFlush();

	const viewport = viewportRef.current!;
	const textHost = firstMatchingElement(
		viewport,
		node => node.nodeName === 'ink-text',
	);
	t.truthy(textHost?.yogaNode);

	const nestedText = textHost
		? firstMatchingElement(
				textHost,
				node => node.nodeName === 'ink-virtual-text',
			)
		: undefined;
	t.falsy(nestedText?.yogaNode);
	t.falsy(nestedText?.internal_transformAffectsGeometry);

	const virtualTransform = nestedText
		? firstMatchingElement(
				nestedText,
				node =>
					node.nodeName === 'ink-virtual-text' &&
					node.internal_transformAffectsGeometry === true,
			)
		: undefined;
	t.truthy(virtualTransform);
	t.falsy(virtualTransform?.yogaNode);
	t.true(textHost?.internal_layoutMetadata?.hasUnboundedTransform);
	t.true(viewport.internal_layoutMetadata?.hasUnboundedTransform);
	instance.unmount();
});

test('VLBox culls off-screen subtrees before renderer traversal', async t => {
	const stdout = createStdout(80);
	const viewportRef = React.createRef<VLBoxRef>();
	const rowRefs = Array.from({length: 20}, () => React.createRef<BoxRef>());
	const instance = render(
		<VLBox
			ref={viewportRef}
			width={10}
			height={3}
			overflow="scroll"
			flexDirection="column"
		>
			{Array.from({length: 20}, (_, index) => (
				<Box key={index} ref={rowRefs[index]} flexShrink={0}>
					<Text>row {index}</Text>
				</Box>
			))}
		</VLBox>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);

	const visibleOrder = rowRefs[1]?.current?.getPaintOrder();
	const hiddenOrder = rowRefs[15]?.current?.getPaintOrder();
	t.truthy(visibleOrder);
	t.is(hiddenOrder, undefined);
	t.true(
		(rootOf(viewportRef.current!).internal_lastRenderVisitCount ?? 999) < 15,
	);

	viewportRef.current?.scrollTo({y: 14});
	await instance.waitUntilRenderFlush();

	t.truthy(rowRefs[15]?.current?.getPaintOrder());
	t.is(rowRefs[1]?.current?.getPaintOrder(), undefined);
	t.true(
		(rootOf(viewportRef.current!).internal_lastRenderVisitCount ?? 999) < 15,
	);
	instance.unmount();
});

test('VLBox matches Box output for arbitrary retained layout', t => {
	const cases: Array<{
		name: string;
		props: React.ComponentProps<typeof Box>;
		children: React.ReactNode;
	}> = [
		{
			name: 'column flex',
			props: {width: 12, height: 4, flexDirection: 'column', gap: 1},
			children: (
				<>
					<Text>one</Text>
					<Text>two</Text>
				</>
			),
		},
		{
			name: 'row reverse with grow',
			props: {
				width: 20,
				height: 2,
				flexDirection: 'row-reverse',
				gap: 1,
			},
			children: (
				<>
					<Box flexGrow={1}>
						<Text>A</Text>
					</Box>
					<Box flexShrink={0} width={4}>
						<Text>B</Text>
					</Box>
				</>
			),
		},
		{
			name: 'percentage width padding border background',
			props: {
				width: 20,
				height: 4,
				padding: 1,
				borderStyle: 'single',
				backgroundColor: 'blue',
			},
			children: (
				<Box width="50%">
					<Text>half</Text>
				</Box>
			),
		},
		{
			name: 'absolute descendant outside parent box',
			props: {width: 10, height: 3, borderStyle: 'single'},
			children: (
				<>
					<Box position="absolute" left={12} top={1} width={4} height={1}>
						<Text>out</Text>
					</Box>
					<Text>in</Text>
				</>
			),
		},
		{
			name: 'nested overflow hidden',
			props: {
				width: 8,
				height: 3,
				overflow: 'hidden',
				flexDirection: 'column',
			},
			children: (
				<Box width={20} height={5} flexShrink={0}>
					<Text>clipped-content</Text>
				</Box>
			),
		},
		{
			name: 'nested overflow scroll',
			props: {
				width: 10,
				height: 3,
				overflow: 'scroll',
				flexDirection: 'column',
			},
			children: Array.from({length: 6}, (_, index) => (
				<Box key={index} flexShrink={0}>
					<Text>r{index}</Text>
				</Box>
			)),
		},
		{
			name: 'z-index overlap',
			props: {width: 5, height: 1},
			children: (
				<>
					<Box position="absolute" left={0} top={0} zIndex={1}>
						<Text>LO</Text>
					</Box>
					<Box position="absolute" left={0} top={0} zIndex={5}>
						<Text>HI</Text>
					</Box>
				</>
			),
		},
	];

	for (const testCase of cases) {
		const boxOutput = renderToString(
			<Box {...testCase.props}>{testCase.children}</Box>,
			{columns: 40},
		);
		const vlBoxOutput = renderToString(
			<VLBox {...testCase.props}>{testCase.children}</VLBox>,
			{columns: 40},
		);
		t.is(vlBoxOutput, boxOutput, `${testCase.name}`);
	}
});

test('VLBox fails open for geometry-changing Transform', async t => {
	const stdout = createStdout(80);
	const viewportRef = React.createRef<VLBoxRef>();
	const offscreenRef = React.createRef<BoxRef>();
	const instance = render(
		<VLBox
			ref={viewportRef}
			width={20}
			height={3}
			overflow="scroll"
			flexDirection="column"
		>
			{Array.from({length: 3}, (_, index) => (
				<Box key={`v-${index}`} flexShrink={0}>
					<Text>visible {index}</Text>
				</Box>
			))}
			{Array.from({length: 10}, (_, index) => (
				<Box
					key={`h-${index}`}
					ref={index === 5 ? offscreenRef : undefined}
					flexShrink={0}
				>
					{index === 5 ? (
						<Transform transform={value => value}>
							<Text>transform-row</Text>
						</Transform>
					) : (
						<Text>hidden {index}</Text>
					)}
				</Box>
			))}
		</VLBox>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);

	// Off-screen Transform-bearing parent remains painted/current-epoch (fail-open).
	t.truthy(offscreenRef.current?.getPaintOrder());
	t.true(
		offscreenRef.current?.internal_layoutMetadata?.hasUnboundedTransform ===
			true,
	);
	instance.unmount();
});

test('VLBox fails open before viewport layout is valid', async t => {
	const stdout = createStdout(80);
	const viewportRef = React.createRef<VLBoxRef>();
	const childRef = React.createRef<BoxRef>();
	const instance = render(
		<VLBox
			ref={viewportRef}
			width={0}
			height={0}
			overflow="scroll"
			flexDirection="column"
		>
			<Box ref={childRef} width={4} height={1} flexShrink={0}>
				<Text>kid</Text>
			</Box>
		</VLBox>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);

	// Zero-sized VLBox must not establish a culling viewport, so descendants stay
	// on the normal traversal path and receive a current paint order.
	t.truthy(childRef.current?.getPaintOrder());
	instance.unmount();
});

test('VLBox culls only axes resolved to overflow scroll', async t => {
	const stdout = createStdout(80);
	const hiddenOnlyRef = React.createRef<VLBoxRef>();
	const hiddenChildRef = React.createRef<BoxRef>();
	const verticalScrollRef = React.createRef<VLBoxRef>();
	const verticalOffRef = React.createRef<BoxRef>();
	const horizontalOffRef = React.createRef<BoxRef>();

	const instance = render(
		<Box flexDirection="column" width={40}>
			<VLBox
				ref={hiddenOnlyRef}
				width={10}
				height={3}
				overflow="hidden"
				flexDirection="column"
			>
				{Array.from({length: 10}, (_, index) => (
					<Box
						key={index}
						ref={index === 8 ? hiddenChildRef : undefined}
						flexShrink={0}
					>
						<Text>h{index}</Text>
					</Box>
				))}
			</VLBox>
			<VLBox
				ref={verticalScrollRef}
				width={10}
				height={3}
				overflowY="scroll"
				flexDirection="column"
			>
				{Array.from({length: 10}, (_, index) => (
					<Box
						key={`v-${index}`}
						ref={index === 8 ? verticalOffRef : undefined}
						flexShrink={0}
					>
						<Text>v{index}</Text>
					</Box>
				))}
				<Box
					ref={horizontalOffRef}
					position="absolute"
					left={40}
					top={0}
					width={4}
					height={1}
				>
					<Text>xoff</Text>
				</Box>
			</VLBox>
		</Box>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);

	// Overflow="hidden" only does not activate culling — off-screen child still visited.
	t.truthy(hiddenChildRef.current?.getPaintOrder());
	// OverflowY="scroll" culls vertically disjoint children.
	t.is(verticalOffRef.current?.getPaintOrder(), undefined);
	// But still traverses horizontally disjoint children (X axis not scroll).
	t.truthy(horizontalOffRef.current?.getPaintOrder());
	instance.unmount();
});

test('VLBox clips straddling background and border generation to visible rows and columns', async t => {
	const stdout = createStdout(40);
	const viewportRef = React.createRef<VLBoxRef>();
	const surfaceRef = React.createRef<BoxRef>();
	const boxStdout = createStdout(40);
	const boxSurfaceRef = React.createRef<BoxRef>();

	const surface = (ref: typeof surfaceRef) => (
		<Box
			ref={ref}
			width={500}
			height={500}
			borderStyle="single"
			backgroundColor="red"
			flexShrink={0}
		>
			<Text>x</Text>
		</Box>
	);

	const vlInstance = render(
		<VLBox
			ref={viewportRef}
			width={12}
			height={3}
			overflow="scroll"
			flexDirection="column"
		>
			{surface(surfaceRef)}
		</VLBox>,
		{stdout, debug: true},
	);
	const boxInstance = render(
		<Box width={12} height={3} overflow="scroll" flexDirection="column">
			{surface(boxSurfaceRef)}
		</Box>,
		{stdout: boxStdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);
	await waitForWriteCount(boxStdout, 1);

	const writeCount = surfaceRef.current?.internal_lastSurfaceWriteCount ?? 999;
	const cellCount =
		surfaceRef.current?.internal_lastSurfaceCellCount ?? 999_999;
	// Visible region is 3 rows x 12 cols. Background rows + border edges must not
	// scale with the 500x500 off-screen surface.
	t.true(writeCount < 40, `writes ${writeCount} should be viewport-bounded`);
	t.true(
		cellCount < 12 * 3 * 4,
		`cells ${cellCount} should be viewport-bounded`,
	);

	// Byte-identical to the normal clipped Box path.
	t.is(stdout.get(), boxStdout.get());
	vlInstance.unmount();
	boxInstance.unmount();
});
