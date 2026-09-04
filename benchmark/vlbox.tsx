/**
 * VLBox warm-scroll production-path benchmark (424×95).
 *
 * Compares unculled Box versus VLBox on a large mixed tree and a small fixture.
 * Measures end-to-end wall time and onRender.renderTime after warm-up; release
 * gates apply only to median renderTime (plus visitation, layout-epoch, parity).
 *
 * The large fixture groups 6,000 mixed rows into SECTION_SIZE=25 retained
 * subtrees so VLBox can reject off-screen chunks as cull units. This is the
 * supported retained-subtree benchmark shape, not flat-list virtualization:
 * a 6,000-row list of direct siblings still pays O(n) sibling probes.
 *
 * Usage:
 *   npm run benchmark:vlbox -- --samples=30
 *   npm run benchmark:vlbox -- --samples=30 --release-check
 */
/* eslint-disable no-await-in-loop, @typescript-eslint/naming-convention, @typescript-eslint/no-restricted-types, unicorn/prefer-event-target, n/prefer-global/buffer, react/boolean-prop-naming */
import {performance} from 'node:perf_hooks';
import EventEmitter from 'node:events';
import process from 'node:process';
import React from 'react';
import {
	Box,
	render,
	Text,
	VLBox,
	type BoxRef,
	type DOMElement,
	type VLBoxRef,
} from '../src/index.js';

const TERMINAL_COLUMNS = 424;
const TERMINAL_ROWS = 95;
const LARGE_ROWS = 6000;
const SMALL_ROWS = 80;
const SMALL_VIEWPORT_ROWS = 12;
const SECTION_SIZE = 25;
const WARMUP_STEPS = 5;
const CHECKPOINT_OFFSETS = [1, 10, 30] as const;
// 95 visible rows × ≤5 expanded host nodes per mixed row + 20 ancestors/stickies.
const MAX_LARGE_VISITS = 600;

type Metrics = {
	outputHeight: number;
	outputLength: number;
	renderTime: number;
};

type FakeStdout = NodeJS.WriteStream & {
	get: () => string;
	bytes: () => number;
	writeCount: () => number;
	writesFrom: (index: number) => string;
};

type RenderInstance = {
	waitUntilRenderFlush: () => Promise<void>;
	unmount: () => void;
};

const createStdout = (columns: number, rows: number): FakeStdout => {
	const stdout = new EventEmitter() as unknown as FakeStdout;
	stdout.columns = columns;
	stdout.rows = rows;
	stdout.isTTY = true;
	let last = '';
	let totalBytes = 0;
	const writeLog: string[] = [];
	stdout.write = (
		chunk: string | Uint8Array,
		encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
		maybeCallback?: (error?: Error | null) => void,
	) => {
		const text =
			typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
		last = text;
		writeLog.push(text);
		totalBytes += text.length;
		const callback =
			typeof encodingOrCallback === 'function'
				? encodingOrCallback
				: maybeCallback;
		callback?.(null);
		return true;
	};

	stdout.get = () => last;
	stdout.bytes = () => totalBytes;
	stdout.writeCount = () => writeLog.length;
	stdout.writesFrom = (index: number) => writeLog.slice(index).join('');
	return stdout;
};

const createStdin = (): NodeJS.ReadStream => {
	const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
	stdin.isTTY = true;
	stdin.setEncoding = () => stdin;
	stdin.setRawMode = () => stdin;
	stdin.ref = () => stdin;
	stdin.unref = () => stdin;
	stdin.read = () => null;
	return stdin;
};

const median = (values: number[]): number => {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid]!;
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + upper) / 2 : upper;
};

const p95 = (values: number[]): number => {
	if (values.length === 0) {
		return 0;
	}

	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.ceil(sorted.length * 0.95) - 1,
	);
	return sorted[index]!;
};

const maximum = (values: number[]): number => {
	if (values.length === 0) {
		return 0;
	}

	return Math.max(...values);
};

const formatMs = (value: number): string => value.toFixed(3);

const formatBytes = (value: number): string =>
	Number.isInteger(value) ? String(value) : value.toFixed(1);

type MixedRowProps = {
	readonly index: number;
};

/**
 * Mixed retained-layout row: plain text, markdown-like multi-Text hosts,
 * nested clips, absolute children, and occasional sticky headers.
 * Visible expansion stays within ~5 host nodes so large visitation ≤ 600.
 *
 * Rows are nested enough that unculled Box pays per-node walk cost across the
 * full tree, while VLBox culls off-screen section subtrees as units.
 */
function MixedRow({index}: MixedRowProps) {
	// Sparse stickies keep the indexed sticky walk small while still present.
	if (index % 100 === 0) {
		return (
			<Box flexShrink={0} height={1} flexDirection="column">
				<Box position="sticky" top={0} height={1} flexShrink={0}>
					<Text backgroundColor="blue" color="white">
						{`sticky-${index}`}
					</Text>
				</Box>
			</Box>
		);
	}

	const variant = index % 7;
	const line = `row-${index} retained-layout mixed content ${index % 17}`;

	if (variant === 0) {
		return (
			<Box flexShrink={0} height={1}>
				<Box overflow="hidden" width={72} height={1}>
					<Box width={200} flexShrink={0}>
						<Text>{`clipped-${index}-${line}----extra-tail-for-clip`}</Text>
					</Box>
				</Box>
			</Box>
		);
	}

	if (variant === 1) {
		return (
			<Box flexShrink={0} height={1} width={100}>
				<Text>{`base-${line}`}</Text>
				<Box position="absolute" left={70} top={0} width={20} height={1}>
					<Text>{`abs-${index}`}</Text>
				</Box>
			</Box>
		);
	}

	if (variant === 2) {
		return (
			<Box flexShrink={0} height={1} flexDirection="row" gap={1}>
				<Text color="green">{`md-${index}`}</Text>
				<Text bold>bold</Text>
				<Text dimColor>`code`</Text>
				<Text>{line}</Text>
			</Box>
		);
	}

	if (variant === 3) {
		return (
			<Box flexShrink={0} height={1}>
				<Box paddingLeft={1} flexShrink={0}>
					<Box flexShrink={0}>
						<Box flexShrink={0}>
							<Text color="cyan">{`nest-${line}`}</Text>
						</Box>
					</Box>
				</Box>
			</Box>
		);
	}

	// Default rows carry nested hosts so unculled Box walks more nodes per row
	// while VLBox still culls whole off-screen sections.
	return (
		<Box flexShrink={0} height={1}>
			<Box flexShrink={0}>
				<Box flexShrink={0}>
					<Box flexShrink={0}>
						<Text>{line}</Text>
					</Box>
				</Box>
			</Box>
		</Box>
	);
}

type ViewportProps = {
	readonly rows: number;
	readonly width: number;
	readonly height: number;
	readonly onViewportRef: (node: BoxRef | VLBoxRef | null) => void;
	readonly useVlBox: boolean;
};

function Viewport({
	rows,
	width,
	height,
	onViewportRef,
	useVlBox,
}: ViewportProps) {
	// Section wrappers are the supported retained-subtree shape: VLBox rejects
	// off-screen chunks as cull units. Flat direct siblings still pay O(n)
	// sibling probes; this is not flat-list virtualization.
	const sections: React.ReactNode[] = [];
	for (let start = 0; start < rows; start += SECTION_SIZE) {
		const end = Math.min(rows, start + SECTION_SIZE);
		const sectionRows = Array.from({length: end - start}, (_, offset) => {
			const index = start + offset;
			return <MixedRow key={index} index={index} />;
		});
		sections.push(
			<Box key={`section-${start}`} flexShrink={0} flexDirection="column">
				{sectionRows}
			</Box>,
		);
	}

	if (useVlBox) {
		return (
			<VLBox
				ref={onViewportRef}
				width={width}
				height={height}
				overflow="scroll"
				flexDirection="column"
			>
				{sections}
			</VLBox>
		);
	}

	return (
		<Box
			ref={onViewportRef}
			width={width}
			height={height}
			overflow="scroll"
			flexDirection="column"
		>
			{sections}
		</Box>
	);
}

const rootOf = (node: DOMElement): DOMElement => {
	let root: DOMElement = node;
	while (root.parentNode) {
		root = root.parentNode;
	}

	return root;
};

type ScenarioResult = {
	label: string;
	useVlBox: boolean;
	rows: number;
	viewportRows: number;
	mountRenderTime: number;
	mountWallTime: number;
	renderTimes: number[];
	wallTimes: number[];
	maxVisited: number;
	layoutEpochBefore: number | undefined;
	layoutEpochAfter: number | undefined;
	checkpoints: Record<number, string>;
	stdoutDeltas: number[];
};

const parseArgs = (
	argv: string[],
): {
	samples: number;
	releaseCheck: boolean;
} => {
	let samples = 30;
	let releaseCheck = false;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === '--release-check') {
			releaseCheck = true;
			continue;
		}

		if (arg === '--samples') {
			samples = Number.parseInt(argv[index + 1] ?? '', 10);
			index++;
			continue;
		}

		if (arg.startsWith('--samples=')) {
			samples = Number.parseInt(arg.slice('--samples='.length), 10);
		}
	}

	if (!Number.isFinite(samples) || samples < 1) {
		throw new Error('--samples must be >= 1');
	}

	if (releaseCheck && samples < 30) {
		throw new Error('--release-check requires --samples >= 30');
	}

	return {samples, releaseCheck};
};

const yieldEventLoop = async (): Promise<void> =>
	new Promise(resolve => {
		setTimeout(resolve, 0);
	});

async function awaitCommit(
	instance: RenderInstance,
	getCommits: () => number,
	target: number,
	options: {deadline: number; label: string},
): Promise<void> {
	while (getCommits() < target) {
		await instance.waitUntilRenderFlush();
		if (getCommits() < target) {
			await yieldEventLoop();
		}

		if (performance.now() > options.deadline) {
			throw new Error(options.label);
		}
	}
}

async function runScenario(options: {
	label: string;
	useVlBox: boolean;
	rows: number;
	viewportRows: number;
	samples: number;
	collectCheckpoints: boolean;
}): Promise<ScenarioResult> {
	const {label, useVlBox, rows, viewportRows, samples, collectCheckpoints} =
		options;
	const stdout = createStdout(TERMINAL_COLUMNS, TERMINAL_ROWS);
	const stderr = createStdout(TERMINAL_COLUMNS, TERMINAL_ROWS);
	const stdin = createStdin();
	let viewport: BoxRef | VLBoxRef | null = null;

	let commits = 0;
	let lastMetrics: Metrics = {
		outputHeight: 0,
		outputLength: 0,
		renderTime: 0,
	};

	const mountWallStart = performance.now();
	const instance = render(
		<Viewport
			rows={rows}
			width={TERMINAL_COLUMNS}
			height={viewportRows}
			useVlBox={useVlBox}
			onViewportRef={node => {
				viewport = node;
			}}
		/>,
		{
			stdout,
			stdin,
			stderr,
			patchConsole: false,
			interactive: true,
			incrementalRendering: true,
			maxFps: 1000,
			onRender(metrics: Metrics) {
				commits += 1;
				lastMetrics = metrics;
			},
		},
	);

	try {
		// Await the initial committed frame through onRender (not a fixed sleep).
		await awaitCommit(instance, () => commits, 1, {
			deadline: performance.now() + 180_000,
			label: `${label}: timed out waiting for initial mount frame`,
		});

		const mountWallTime = performance.now() - mountWallStart;
		const mountRenderTime = lastMetrics.renderTime;

		// One extra flush so layout effects / imperative handles are settled.
		await instance.waitUntilRenderFlush();
		await yieldEventLoop();

		if (!viewport) {
			throw new Error(
				`${label}: viewport ref was not attached (commits=${commits}, mountRender=${mountRenderTime.toFixed(3)})`,
			);
		}

		const root = rootOf(viewport);
		const totalSteps = WARMUP_STEPS + samples;
		// Keep offsets within scrollable range: content rows - viewport.
		const maxOffset = Math.max(0, rows - viewportRows - 1);
		if (totalSteps > maxOffset) {
			throw new Error(
				`${label}: need ${totalSteps} steps but max scroll offset is ${maxOffset}`,
			);
		}

		const renderTimes: number[] = [];
		const wallTimes: number[] = [];
		const stdoutDeltas: number[] = [];
		let maxVisited = 0;
		const checkpoints: Record<number, string> = {};

		const scrollToOffset = async (offset: number, message: string) => {
			const before = commits;
			viewport!.scrollTo({y: offset});
			await awaitCommit(instance, () => commits, before + 1, {
				deadline: performance.now() + 30_000,
				label: message,
			});
		};

		const isCheckpointOffset = (offset: number): boolean =>
			collectCheckpoints && CHECKPOINT_OFFSETS.includes(offset as 1 | 10 | 30);

		const captureCheckpoint = async (offset: number, writeIndex: number) => {
			if (!isCheckpointOffset(offset)) {
				return;
			}

			await instance.waitUntilRenderFlush();
			checkpoints[offset] = stdout.writesFrom(writeIndex);
		};

		// Warm-up scrolls (not measured).
		for (let step = 1; step <= WARMUP_STEPS; step++) {
			const writeIndex = stdout.writeCount();
			await scrollToOffset(
				step,
				`${label}: timed out during warm-up step ${step}`,
			);
			await captureCheckpoint(step, writeIndex);
		}

		const layoutEpochBefore = root.internal_layoutEpoch;

		// Measured warm samples: scroll current+1 from the post-warm offset.
		for (let index = 0; index < samples; index++) {
			const offset = WARMUP_STEPS + index + 1;
			const writeIndex = stdout.writeCount();
			const bytesBefore = stdout.bytes();
			const wallStart = performance.now();
			await scrollToOffset(
				offset,
				`${label}: timed out during sample offset ${offset}`,
			);
			const wallTime = performance.now() - wallStart;
			renderTimes.push(lastMetrics.renderTime);
			wallTimes.push(wallTime);
			stdoutDeltas.push(stdout.bytes() - bytesBefore);
			maxVisited = Math.max(
				maxVisited,
				root.internal_lastRenderVisitCount ?? 0,
			);
			await captureCheckpoint(offset, writeIndex);
		}

		const layoutEpochAfter = root.internal_layoutEpoch;

		// Capture any checkpoint still missing after the measured range.
		if (collectCheckpoints) {
			for (const offset of CHECKPOINT_OFFSETS) {
				if (checkpoints[offset] !== undefined) {
					continue;
				}

				const writeIndex = stdout.writeCount();
				await scrollToOffset(
					offset,
					`${label}: timed out seeking checkpoint ${offset}`,
				);
				await captureCheckpoint(offset, writeIndex);
			}
		}

		return {
			label,
			useVlBox,
			rows,
			viewportRows,
			mountRenderTime,
			mountWallTime,
			renderTimes,
			wallTimes,
			maxVisited,
			layoutEpochBefore,
			layoutEpochAfter,
			checkpoints,
			stdoutDeltas,
		};
	} finally {
		instance.unmount();
	}
}

const summarize = (result: ScenarioResult) => ({
	renderMedian: median(result.renderTimes),
	renderP95: p95(result.renderTimes),
	wallMedian: median(result.wallTimes),
	wallP95: p95(result.wallTimes),
	maxVisited: result.maxVisited,
	layoutDelta: (result.layoutEpochAfter ?? 0) - (result.layoutEpochBefore ?? 0),
	mountRenderTime: result.mountRenderTime,
	mountWallTime: result.mountWallTime,
	stdoutDeltaMedian: median(result.stdoutDeltas),
	stdoutDeltaP95: p95(result.stdoutDeltas),
	stdoutDeltaMax: maximum(result.stdoutDeltas),
});

const printTable = (
	title: string,
	box: ReturnType<typeof summarize> & {label: string},
	vl: ReturnType<typeof summarize> & {label: string},
) => {
	const speedup =
		vl.renderMedian > 0
			? box.renderMedian / vl.renderMedian
			: Number.POSITIVE_INFINITY;
	console.log(`\n=== ${title} ===`);
	console.log(
		[
			'impl'.padEnd(8),
			'render med'.padStart(12),
			'render p95'.padStart(12),
			'wall med'.padStart(12),
			'wall p95'.padStart(12),
			'max visits'.padStart(12),
			'mount render'.padStart(14),
			'mount wall'.padStart(12),
			'stdout Δ med'.padStart(13),
			'stdout Δ p95'.padStart(13),
			'stdout Δ max'.padStart(13),
		].join(' '),
	);
	for (const row of [box, vl]) {
		console.log(
			[
				row.label.padEnd(8),
				formatMs(row.renderMedian).padStart(12),
				formatMs(row.renderP95).padStart(12),
				formatMs(row.wallMedian).padStart(12),
				formatMs(row.wallP95).padStart(12),
				String(row.maxVisited).padStart(12),
				formatMs(row.mountRenderTime).padStart(14),
				formatMs(row.mountWallTime).padStart(12),
				formatBytes(row.stdoutDeltaMedian).padStart(13),
				formatBytes(row.stdoutDeltaP95).padStart(13),
				formatBytes(row.stdoutDeltaMax).padStart(13),
			].join(' '),
		);
	}

	console.log(
		`renderer speedup (Box med render / VLBox med render): ${speedup.toFixed(2)}x`,
	);
	console.log(
		`VLBox layout epoch delta (after - before measured scrolls): ${vl.layoutDelta}`,
	);
};

const {samples, releaseCheck} = parseArgs(process.argv.slice(2));
console.log(
	`VLBox benchmark — ${TERMINAL_COLUMNS}×${TERMINAL_ROWS}, samples=${samples}, warmup=${WARMUP_STEPS}, releaseCheck=${releaseCheck}`,
);
console.log(
	'Path: incrementalRendering=true maxFps=1000 interactive=true patchConsole=false (production paint; debug=false)',
);
console.log(
	`Fixture: ${LARGE_ROWS} mixed rows in SECTION_SIZE=${SECTION_SIZE} retained subtrees (supported cull-unit shape; not flat-list virtualization — flat direct siblings still pay O(n) sibling probes).`,
);

const boxLarge = await runScenario({
	label: 'Box-large',
	useVlBox: false,
	rows: LARGE_ROWS,
	viewportRows: TERMINAL_ROWS,
	samples,
	collectCheckpoints: true,
});
const vlLarge = await runScenario({
	label: 'VLBox-large',
	useVlBox: true,
	rows: LARGE_ROWS,
	viewportRows: TERMINAL_ROWS,
	samples,
	collectCheckpoints: true,
});

const boxSmall = await runScenario({
	label: 'Box-small',
	useVlBox: false,
	rows: SMALL_ROWS,
	viewportRows: SMALL_VIEWPORT_ROWS,
	samples,
	collectCheckpoints: false,
});
const vlSmall = await runScenario({
	label: 'VLBox-small',
	useVlBox: true,
	rows: SMALL_ROWS,
	viewportRows: SMALL_VIEWPORT_ROWS,
	samples,
	collectCheckpoints: false,
});

const boxLargeSummary = {...summarize(boxLarge), label: 'Box'};
const vlLargeSummary = {...summarize(vlLarge), label: 'VLBox'};
const boxSmallSummary = {...summarize(boxSmall), label: 'Box'};
const vlSmallSummary = {...summarize(vlSmall), label: 'VLBox'};

printTable(
	`Large fixture (${LARGE_ROWS} mixed rows in SECTION_SIZE=${SECTION_SIZE} retained subtrees, ${TERMINAL_COLUMNS}×${TERMINAL_ROWS})`,
	boxLargeSummary,
	vlLargeSummary,
);
printTable(
	`Small fixture (${SMALL_ROWS} rows, viewport ${SMALL_VIEWPORT_ROWS})`,
	boxSmallSummary,
	vlSmallSummary,
);

let checkpointFramesMatch = true;
for (const offset of CHECKPOINT_OFFSETS) {
	const boxFrame = boxLarge.checkpoints[offset] ?? '';
	const vlFrame = vlLarge.checkpoints[offset] ?? '';
	const match = boxFrame === vlFrame;
	console.log(
		`checkpoint offset ${offset}: ${match ? 'MATCH' : 'DIFF'} (boxBytes=${boxFrame.length}, vlBytes=${vlFrame.length})`,
	);
	if (!match) {
		checkpointFramesMatch = false;
	}
}

console.log(
	`VLBox large max visits: ${vlLargeSummary.maxVisited} (bound ${MAX_LARGE_VISITS})`,
);
console.log(
	`VLBox large layout epoch before=${vlLarge.layoutEpochBefore} after=${vlLarge.layoutEpochAfter} delta=${vlLargeSummary.layoutDelta}`,
);

if (releaseCheck) {
	const {renderMedian: vlLargeRenderMedian, maxVisited: vlLargeMaxVisited} =
		vlLargeSummary;
	const {renderMedian: boxLargeRenderMedian} = boxLargeSummary;
	const {renderMedian: vlSmallRenderMedian} = vlSmallSummary;
	const {renderMedian: boxSmallRenderMedian} = boxSmallSummary;
	const {layoutEpochAfter, layoutEpochBefore} = vlLarge;

	if (vlLargeRenderMedian > 16) {
		throw new Error('VLBox large render median exceeded 16 ms');
	}

	if (boxLargeRenderMedian / vlLargeRenderMedian < 5) {
		throw new Error('VLBox render speedup was below 5x');
	}

	if (vlSmallRenderMedian > boxSmallRenderMedian * 1.1) {
		throw new Error('VLBox small-fixture render regression exceeded 10%');
	}

	if (layoutEpochAfter !== layoutEpochBefore) {
		throw new Error('VLBox scroll triggered Yoga layout');
	}

	if (vlLargeMaxVisited > MAX_LARGE_VISITS) {
		throw new Error(
			'VLBox renderer visitation exceeded the visible-tree bound',
		);
	}

	if (!checkpointFramesMatch) {
		throw new Error('VLBox checkpoint frames differ from Box');
	}

	console.log('\nrelease-check: PASS');
}
