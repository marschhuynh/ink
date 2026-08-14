# Incremental Rendering State Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair six frame/cursor state mismatches while preserving surgical incremental updates and introducing no new `clearTerminal` operations.

**Architecture:** Keep the current standard and incremental renderers, but separate persistent cursor intent from dirty state, calculate cursor movement from the physical post-write row, and add an internal line-oriented complete-frame repaint operation. Ink will track the viewport and columns used by the previous frame: row-resize boundary transitions use a synchronized repaint when representation changes, while column decreases derive the old frame's reflowed physical row count and perform one synchronized complete repaint. Column growth retains the existing incremental shrink/diff path.

**Tech Stack:** TypeScript 5.8, React 19, Ink's custom reconciler, AVA 7, Sinon spies, `ansi-escapes`, Node.js 22+

## Global Constraints

- Work from the nested Git repository at `packages/ink`; do not treat the outer `nuvin-agent` repository as the change root.
- Preserve ordinary unchanged-line skipping and incremental updates.
- Introduce no new `ansiEscapes.clearTerminal` paths.
- Preserve existing overflow and issue-450 clear behavior unless a task explicitly changes viewport classification.
- Keep `render()` and all other public Ink options unchanged.
- Do not add multi-owner cursor arbitration; only preserve the currently committed cursor until explicit `undefined` cleanup.
- Use test-driven development: add each regression first, run it red, implement the minimum correction, then run it green.
- The 2026-08-10 baseline has clean typecheck and focused cursor/log-update tests, but package lint has 13 unrelated pre-existing errors and 9 warnings, while the full AVA run has 57 unrelated `TypeError: act is not a function` failures in concurrent tests. Focused rendering files and typecheck are blocking gates; rerun package-wide commands for comparison and report, but do not expand scope to repair those baseline failures.
- Do not commit unless the user explicitly approves commits. Commit steps below are conditional checkpoints, not authorization.

## File Structure

- `src/cursor-helpers.ts`: owns physical cursor-row calculation and escape-sequence construction.
- `src/log-update.ts`: owns cached terminal output, incremental line diffing, persistent cursor intent, complete-frame repainting, width-aware physical erase overrides, and teardown.
- `src/ink.tsx`: owns public clear behavior, interactive viewport/column metadata, reflowed-row counting, render-mode selection, and synchronized repaint orchestration.
- `test/cursor-helpers.tsx`: verifies cursor-row and escape-sequence calculations in isolation.
- `test/log-update.tsx`: verifies standard/incremental state-machine transitions and emitted write sequences.
- `test/render.tsx`: verifies React/Ink integration, public clear semantics, cursor commit lifecycle, resize behavior, and BSU/ESU ordering.
- `test/terminal-resize.tsx`: preserves general resize/listener behavior and verifies that both width directions avoid `clearTerminal`.

---

### Task 1: Make cursor suffixes use the physical post-write row

**Files:**
- Modify: `src/cursor-helpers.ts:21-84`
- Modify: `src/log-update.ts:4-11,74-100,141-160,217-230,242-301,344-363`
- Test: `test/cursor-helpers.tsx:3-62,80-107`
- Test: `test/log-update.tsx:257-322,356-396,455-470,512-604`

**Interfaces:**
- Produces: `getOutputCursorRow(lines: readonly string[]): number`
- Changes: `buildCursorSuffix(outputCursorRow: number, cursorPosition: CursorPosition | undefined): string`
- Changes: `CursorOnlyInput.visibleLineCount` to `CursorOnlyInput.outputCursorRow`
- Consumed by: Tasks 2, 3, and 5

- [ ] **Step 1: Add failing physical-row helper and suffix tests**

Update the imports in `test/cursor-helpers.tsx` and replace the invalid “last visible line” assumption with explicit trailing/non-trailing cases:

```ts
import {
	cursorPositionChanged,
	getOutputCursorRow,
	buildCursorSuffix,
	buildReturnToBottom,
	buildCursorOnlySequence,
	buildReturnToBottomPrefix,
} from '../src/cursor-helpers.js';

test('getOutputCursorRow - trailing newline ends below visible output', t => {
	t.is(getOutputCursorRow('A\nB\n'.split('\n')), 2);
});

test('getOutputCursorRow - fullscreen output ends on last visible row', t => {
	t.is(getOutputCursorRow('A\nB'.split('\n')), 1);
});

test('buildCursorSuffix - fullscreen cursor stays on last visible row', t => {
	const outputCursorRow = getOutputCursorRow('A\nB'.split('\n'));
	const result = buildCursorSuffix(outputCursorRow, {x: 0, y: 1});
	t.is(result, ansiEscapes.cursorTo(0) + showCursorEscape);
});

test('buildCursorSuffix - trailing newline moves up from empty baseline row', t => {
	const outputCursorRow = getOutputCursorRow('A\nB\n'.split('\n'));
	const result = buildCursorSuffix(outputCursorRow, {x: 0, y: 1});
	t.is(
		result,
		ansiEscapes.cursorUp(1) + ansiEscapes.cursorTo(0) + showCursorEscape,
	);
});
```

Update `buildCursorOnlySequence` test inputs from `visibleLineCount` to `outputCursorRow` so the tests describe a physical row rather than a visible-line count.

After the existing `renderingModes` and `createRenderForMode()` declarations in `test/log-update.tsx`, add full-render and `sync()` call-site coverage:

```ts
for (const {name, incremental} of renderingModes) {
	for (const {label, output, suffix} of [
		{
			label: 'fullscreen',
			output: 'A\nB',
			suffix: ansiEscapes.cursorTo(0) + showCursorEscape,
		},
		{
			label: 'trailing newline',
			output: 'A\nB\n',
			suffix:
				ansiEscapes.cursorUp(1) +
				ansiEscapes.cursorTo(0) +
				showCursorEscape,
		},
	] as const) {
		test(`${name} - full render uses physical baseline for ${label}`, t => {
			const {stdout, render} = createRenderForMode(incremental);
			render.setCursorPosition({x: 0, y: 1});
			render(output);

			const written = (stdout.write as any).firstCall.args[0] as string;
			t.true(written.endsWith(suffix));
		});

		test(`${name} - sync uses physical baseline for ${label}`, t => {
			const {stdout, render} = createRenderForMode(incremental);
			render.setCursorPosition({x: 0, y: 1});
			render.sync(output);

			const written = (stdout.write as any).firstCall.args[0] as string;
			t.is(written, suffix);
		});
	}
}
```

Add a dedicated incremental surgical-update regression so the suffix at the end of the line-diff path cannot keep using `visibleLineCount`:

```ts
test('incremental rendering - fullscreen surgical update uses physical cursor baseline', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {
		showCursor: true,
		incremental: true,
	});

	render.setCursorPosition({x: 0, y: 1});
	render('A\nB');
	render.setCursorPosition({x: 0, y: 1});
	render('A\nC');

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.endsWith(ansiEscapes.cursorTo(0) + showCursorEscape));
	t.false(secondCall.endsWith(ansiEscapes.cursorUp(1) + ansiEscapes.cursorTo(0) + showCursorEscape));
});
```

- [ ] **Step 2: Run the cursor-helper tests and verify the new tests fail**

Run:

```bash
npm exec ava test/cursor-helpers.tsx test/log-update.tsx
```

Expected: FAIL because `getOutputCursorRow` is not exported, `CursorOnlyInput` does not yet accept `outputCursorRow`, and the fullscreen renderer call sites still move one row too far up.

- [ ] **Step 3: Implement physical output-row calculation and rename helper inputs**

Add this helper to `src/cursor-helpers.ts` and update the existing suffix function:

```ts
/**
Return the zero-based terminal row occupied after writing output split into lines.
A trailing newline contributes an empty final row; fullscreen output does not.
*/
export const getOutputCursorRow = (lines: readonly string[]): number =>
	Math.max(0, lines.length - 1);

export const buildCursorSuffix = (
	outputCursorRow: number,
	cursorPosition: CursorPosition | undefined,
): string => {
	if (!cursorPosition) {
		return '';
	}

	const moveUp = outputCursorRow - cursorPosition.y;
	return (
		(moveUp > 0 ? ansiEscapes.cursorUp(moveUp) : '') +
		ansiEscapes.cursorTo(cursorPosition.x) +
		showCursorEscape
	);
};
```

Change `CursorOnlyInput` and `buildCursorOnlySequence` in the same file:

```ts
export type CursorOnlyInput = {
	cursorWasShown: boolean;
	previousLineCount: number;
	previousCursorPosition: CursorPosition | undefined;
	outputCursorRow: number;
	cursorPosition: CursorPosition | undefined;
};

export const buildCursorOnlySequence = (input: CursorOnlyInput): string => {
	const hidePrefix = input.cursorWasShown ? hideCursorEscape : '';
	const returnToBottom = buildReturnToBottom(
		input.previousLineCount,
		input.previousCursorPosition,
	);
	const cursorSuffix = buildCursorSuffix(
		input.outputCursorRow,
		input.cursorPosition,
	);
	return hidePrefix + returnToBottom + cursorSuffix;
};
```

- [ ] **Step 4: Update every `log-update` cursor suffix call site**

Import the helper in `src/log-update.ts`:

```ts
import {
	type CursorPosition,
	cursorPositionChanged,
	getOutputCursorRow,
	buildCursorSuffix,
	buildCursorOnlySequence,
	buildReturnToBottomPrefix,
	hideCursorEscape,
} from './cursor-helpers.js';
```

For each standard render, incremental render, and `sync()` path, derive the row from the already-split lines:

```ts
const lines = str.split('\n');
const outputCursorRow = getOutputCursorRow(lines);
const cursorSuffix = buildCursorSuffix(outputCursorRow, activeCursor);
```

Pass `outputCursorRow` to every cursor-only sequence:

```ts
buildCursorOnlySequence({
	cursorWasShown,
	previousLineCount,
	previousCursorPosition,
	outputCursorRow,
	cursorPosition: activeCursor,
});
```

In the incremental implementation, keep `visibleLineCount(nextLines, str)` only for line diffing; do not pass it to cursor helpers.

- [ ] **Step 5: Run cursor and log-update tests**

Run:

```bash
npm exec ava test/cursor-helpers.tsx test/log-update.tsx
```

Expected: PASS. In particular, fullscreen `{x: 0, y: 1}` for `A\nB` emits no `cursorUp`, while trailing `A\nB\n` emits `cursorUp(1)`.

- [ ] **Step 6: Conditional commit checkpoint**

Only with explicit commit approval:

```bash
git add src/cursor-helpers.ts src/log-update.ts test/cursor-helpers.tsx test/log-update.tsx
git commit -m "fix: use physical cursor baseline for fullscreen output"
```

---

### Task 2: Persist committed cursor intent across unrelated renders

**Files:**
- Modify: `src/log-update.ts:31-171,174-374`
- Test: `test/log-update.tsx:239-510`
- Test: `test/render.tsx:849-857,1968-1980`
- Verify: `test/cursor.tsx:195-251,359-437`

**Interfaces:**
- Consumes: `getOutputCursorRow()` and the corrected cursor helper signatures from Task 1
- Produces: persistent `cursorPosition` semantics; `cursorDirty` only signals changed intent
- Leaves unchanged: `useCursor()` cleanup continues calling `setCursorPosition(undefined)`
- Consumed by: Tasks 3, 4, and 5

- [ ] **Step 1: Add failing direct state-machine tests**

Add this loop to `test/log-update.tsx`:

```ts
for (const {name, incremental} of renderingModes) {
	test(`${name} - changed output retains committed cursor without another setter call`, t => {
		const {stdout, render} = createRenderForMode(incremental);

		render.setCursorPosition({x: 2, y: 0});
		render('Line 1\nLine 2\n');
		render('Line 1\nUpdated\n');

		const secondCall = (stdout.write as any).secondCall.args[0] as string;
		t.true(secondCall.includes('Updated'));
		t.true(secondCall.endsWith(ansiEscapes.cursorTo(2) + showCursorEscape));
	});

	test(`${name} - explicit undefined clears persistent cursor intent`, t => {
		const {stdout, render} = createRenderForMode(incremental);

		render.setCursorPosition({x: 2, y: 0});
		render('Line 1\n');
		render.setCursorPosition(undefined);
		render('Updated\n');

		const secondCall = (stdout.write as any).secondCall.args[0] as string;
		t.false(secondCall.endsWith(showCursorEscape));
	});
}
```

Replace the old `sync() hides cursor when previous render showed cursor` expectation with committed-intent behavior:

```ts
for (const {name, incremental} of renderingModes) {
	test(`${name} - sync() restores persistent committed cursor`, t => {
		const {stdout, render} = createRenderForMode(incremental);

		render.setCursorPosition({x: 5, y: 1});
		render('Line 1\nLine 2\nLine 3\n');
		render.sync('Fresh 1\nFresh 2\nFresh 3\n');

		const syncCall = (stdout.write as any).secondCall.args[0] as string;
		t.is(
			syncCall,
			ansiEscapes.cursorUp(2) + ansiEscapes.cursorTo(5) + showCursorEscape,
		);
	});
}
```

Replace the existing `sync() resets cursor state` loop with a test that distinguishes the synchronized frame from stale pre-sync state:

```ts
for (const {name, incremental} of renderingModes) {
	test(`${name} - render after sync returns from synchronized cursor state`, t => {
		const {stdout, render} = createRenderForMode(incremental);

		render.setCursorPosition({x: 0, y: 0});
		render('Line 1\nLine 2\nLine 3\n');
		render.sync('Fresh output\n');
		(stdout.write as any).resetHistory();

		render('Updated output\n');

		const renderCall = (stdout.write as any).firstCall.args[0] as string;
		t.true(renderCall.startsWith(hideCursorEscape));
		t.true(renderCall.includes(ansiEscapes.cursorDown(1)));
		t.false(renderCall.includes(ansiEscapes.cursorDown(3)));
	});
}
```

Add separate state tests proving that physical clear and cache-only reset both preserve desired cursor intent without conflating their physical contracts:

```ts
for (const {name, incremental} of renderingModes) {
	test(`${name} - clear preserves committed cursor for the next frame`, t => {
		const {stdout, render} = createRenderForMode(incremental);

		render.setCursorPosition({x: 2, y: 0});
		render('Before\n');
		render.clear();
		(stdout.write as any).resetHistory();

		render('After\n');

		const renderCall = (stdout.write as any).firstCall.args[0] as string;
		t.true(renderCall.endsWith(ansiEscapes.cursorTo(2) + showCursorEscape));
	});

	test(`${name} - cache-only reset preserves committed cursor after an external terminal reset`, t => {
		const {stdout, render} = createRenderForMode(incremental);

		render.setCursorPosition({x: 2, y: 0});
		render('Before\n');
		// reset() is cache-only. The caller is responsible for resetting or
		// replacing the physical terminal contents before the next frame.
		render.reset();
		(stdout.write as any).resetHistory();

		render('After\n');

		const renderCall = (stdout.write as any).firstCall.args[0] as string;
		t.true(renderCall.startsWith('After\n'));
		t.false(renderCall.startsWith(hideCursorEscape));
		t.true(renderCall.endsWith(ansiEscapes.cursorTo(2) + showCursorEscape));
	});
}
```

- [ ] **Step 2: Add a failing React integration test for a memoized cursor owner**

Add this test to `test/render.tsx` near the other cursor/throttle integration coverage:

```tsx
test.serial('committed cursor survives a sibling-only rerender', async t => {
	const stdout = createTtyStdout();
	stdout.rows = 10;
	const writes = captureWrites(stdout);

	const CursorOwner = React.memo(function CursorOwner() {
		const {setCursorPosition} = useCursor();
		setCursorPosition({x: 0, y: 0});
		return <Text>cursor</Text>;
	});

	function Frame({count}: {readonly count: number}) {
		return (
			<Box flexDirection="column">
				<CursorOwner />
				<Text>{count}</Text>
			</Box>
		);
	}

	const instance = render(<Frame count={0} />, {
		stdout,
		interactive: true,
		incrementalRendering: true,
		maxFps: 1000,
	});
	await instance.waitUntilRenderFlush();

	writes.length = 0;
	instance.rerender(<Frame count={1} />);
	await instance.waitUntilRenderFlush();

	const updateChunk = writes.find(write => write.includes('1'));
	t.truthy(updateChunk);
	t.true(updateChunk!.endsWith(ansiEscapes.cursorShow));

	instance.unmount();
	await instance.waitUntilExit();
});
```

- [ ] **Step 3: Run the new tests and verify they fail**

Run:

```bash
npm exec -- ava test/log-update.tsx test/render.tsx --match='*committed cursor*' --match='*persistent committed cursor*' --match='*after sync*'
```

Expected: FAIL because `getActiveCursor()` returns `undefined` after `cursorDirty` is consumed.

- [ ] **Step 4: Separate active cursor intent from dirty state in both renderers**

In both `createStandard()` and `createIncremental()`, replace the dirty-gated getter:

```ts
const getActiveCursor = () => cursorPosition;
```

Replace the old comments that say cursor positions are used only when the setter ran since the previous render with:

```ts
// cursorPosition is persistent committed intent. cursorDirty only determines
// whether unchanged output needs a cursor-only render.
```

Keep this order at the start of every render:

```ts
const activeCursor = getActiveCursor();
cursorDirty = false;
```

Update both `sync()` implementations to use persistent intent rather than dirty-gated intent:

```ts
const activeCursor = cursorPosition;
cursorDirty = false;
```

When `clear()` removes physically rendered state, consume dirty bookkeeping but preserve desired intent:

```ts
previousCursorPosition = undefined;
cursorWasShown = false;
cursorDirty = false;
```

Apply the same state assignments in `reset()`, but keep `reset()` non-writing. It is a cache-only operation whose caller must already have reset or replaced the physical terminal contents; add a short comment documenting that precondition.

Do not assign `cursorPosition = undefined` in `clear()` or `reset()`; explicit hook cleanup owns that transition.

- [ ] **Step 5: Run focused cursor and integration tests**

Run:

```bash
npm exec -- ava test/log-update.tsx test/render.tsx test/cursor.tsx --match='*cursor*' --match='!*suspended concurrent render*'
```

Expected: PASS. Changed content restores the cursor even when its owner did not rerender; explicit `undefined` still hides it.

- [ ] **Step 6: Run the complete focused files to catch updated sync expectations**

Run:

```bash
npm exec ava test/cursor-helpers.tsx test/log-update.tsx test/render.tsx
npm exec -- ava test/cursor.tsx --match='!*suspended concurrent render*'
```

Expected: PASS, including cursor-owner unmount cleanup and stdout/stderr cursor restoration. The single documented `act is not a function` concurrent cursor test is excluded from this blocking gate.

- [ ] **Step 7: Conditional commit checkpoint**

Only with explicit commit approval:

```bash
git add src/log-update.ts test/log-update.tsx test/render.tsx
git commit -m "fix: persist committed cursor across renders"
```

---

### Task 3: Return positioned cursors to the frame bottom on teardown

**Files:**
- Modify: `src/log-update.ts:4-11,122-139,325-342`
- Test: `test/log-update.tsx:183-197,324-340`

**Interfaces:**
- Consumes: persistent cursor semantics from Task 2 and `buildReturnToBottomPrefix()`
- Produces: `done()` leaves the physical cursor at the frame baseline and clears desired/rendered cursor state
- Affects: standard and incremental `LogUpdate`

- [ ] **Step 1: Add failing teardown tests for trailing and fullscreen output**

Add these mode/output cases to `test/log-update.tsx`:

```ts
for (const {name, incremental} of renderingModes) {
	for (const {label, output, down} of [
		{label: 'trailing newline', output: 'A\nB\n', down: 2},
		{label: 'fullscreen', output: 'A\nB', down: 1},
	] as const) {
		test(`${name} - done() returns positioned cursor to bottom for ${label}`, t => {
			const {stdout, render} = createRenderForMode(incremental);

			render.setCursorPosition({x: 0, y: 0});
			render(output);
			render.done();

			const doneCall = (stdout.write as any).secondCall.args[0] as string;
			t.is(
				doneCall,
				hideCursorEscape +
					ansiEscapes.cursorDown(down) +
					ansiEscapes.cursorTo(0) +
					showCursorEscape,
			);
		});
	}
}
```

`createRenderForMode()` uses `showCursor: true`, so each test can assert the exact visibility-restoring suffix without stubbing `cli-cursor`.

Add a second mode loop proving `done()` clears desired cursor intent before a fresh render:

```ts
for (const {name, incremental} of renderingModes) {
	test(`${name} - done() clears committed cursor before the next render`, t => {
		const {stdout, render} = createRenderForMode(incremental);

		render.setCursorPosition({x: 2, y: 0});
		render('Before\n');
		render.done();
		(stdout.write as any).resetHistory();

		render('After\n');

		const renderCall = (stdout.write as any).firstCall.args[0] as string;
		t.false(renderCall.endsWith(showCursorEscape));
	});
}
```

Add visibility restoration coverage for transitions that already hid the positioned cursor and cleared `cursorWasShown` before teardown:

```ts
for (const {name, incremental} of renderingModes) {
	for (const transition of ['clear', 'explicit cursor removal'] as const) {
		test(`${name} - done() restores cursor visibility after ${transition}`, t => {
			const {stdout, render} = createRenderForMode(incremental);

			render.setCursorPosition({x: 0, y: 0});
			render('Before\n');
			if (transition === 'clear') {
				render.clear();
			} else {
				render.setCursorPosition(undefined);
				render('Before\n');
			}

			(stdout.write as any).resetHistory();
			render.done();

			t.is((stdout.write as any).firstCall.args[0], showCursorEscape);
		});
	}
}
```

- [ ] **Step 2: Run the teardown tests and verify they fail**

Run:

```bash
npm exec -- ava test/log-update.tsx --match='*done()*'
```

Expected: FAIL because `done()` currently emits no return-to-bottom sequence, leaves persistent `cursorPosition` available to the next render, and does not restore visibility when `clear()` or explicit cursor removal already hid the cursor.

- [ ] **Step 3: Move the cursor before clearing standard renderer state**

Import `showCursorEscape` from `cursor-helpers.ts`, then place this logic at the start of standard `render.done`:

```ts
render.done = () => {
	const returnPrefix = buildReturnToBottomPrefix(
		cursorWasShown,
		previousLineCount,
		previousCursorPosition,
	);
	if (returnPrefix || showCursor) {
		stream.write(returnPrefix + (showCursor ? showCursorEscape : ''));
	}

	previousOutput = '';
	previousLineCount = 0;
	previousCursorPosition = undefined;
	cursorWasShown = false;
	cursorPosition = undefined;
	cursorDirty = false;

	if (!showCursor) {
		cliCursor.show(stream);
		hasHiddenCursor = false;
	}
};
```

- [ ] **Step 4: Apply the same teardown contract to incremental state**

Use `previousLines.length` as the saved line count:

```ts
render.done = () => {
	const returnPrefix = buildReturnToBottomPrefix(
		cursorWasShown,
		previousLines.length,
		previousCursorPosition,
	);
	if (returnPrefix || showCursor) {
		stream.write(returnPrefix + (showCursor ? showCursorEscape : ''));
	}

	previousOutput = '';
	previousLines = [];
	previousCursorPosition = undefined;
	cursorWasShown = false;
	cursorPosition = undefined;
	cursorDirty = false;

	if (!showCursor) {
		cliCursor.show(stream);
		hasHiddenCursor = false;
	}
};
```

- [ ] **Step 5: Run focused and full log-update tests**

Run:

```bash
npm exec ava test/log-update.tsx
```

Expected: PASS. Existing “done resets before next render” coverage remains green, both output modes return to the physical baseline, and teardown restores visibility after clear or explicit cursor removal.

- [ ] **Step 6: Conditional commit checkpoint**

Only with explicit commit approval:

```bash
git add src/log-update.ts test/log-update.tsx
git commit -m "fix: restore terminal cursor position on teardown"
```

---

### Task 4: Keep public clear from caching physically erased output

**Files:**
- Modify: `src/ink.tsx:954-960`
- Test: `test/render.tsx:786-795`
- Verify: `test/log-update.tsx:167-217`

**Interfaces:**
- Consumes: `LogUpdate.clear()` preserving desired cursor intent while resetting rendered state from Task 2
- Produces: public `Instance.clear()` leaves `log-update` output cache empty and sets `hasPhysicalFrame` false
- Leaves unchanged: `lastOutput`, `lastOutputToRender`, and `lastOutputHeight` retain the latest React frame metadata

- [ ] **Step 1: Add a failing integration test for clear followed by changed content**

Add this test immediately after the existing `clear output` test in `test/render.tsx`:

```tsx
test.serial('incremental clear followed by changed output repaints erased rows', async t => {
	const stdout = createTtyStdout();
	stdout.rows = 10;
	const writes = captureWrites(stdout);

	function Frame({second}: {readonly second: string}) {
		return (
			<Box flexDirection="column">
				<Text>A</Text>
				<Text>{second}</Text>
			</Box>
		);
	}

	const instance = render(<Frame second="B" />, {
		stdout,
		interactive: true,
		incrementalRendering: true,
		maxFps: 1000,
	});
	await instance.waitUntilRenderFlush();

	instance.clear();
	writes.length = 0;
	instance.rerender(<Frame second="C" />);
	await instance.waitUntilRenderFlush();

	const repaint = stripAnsi(writes.join(''));
	t.true(repaint.includes('A'));
	t.true(repaint.includes('C'));

	instance.unmount();
	await instance.waitUntilExit();
});
```

- [ ] **Step 2: Run the regression test and verify it fails**

Run:

```bash
npm exec -- ava test/render.tsx --match='incremental clear followed by changed output*'
```

Expected: FAIL because the post-clear write contains `C` but skips erased row `A`.

- [ ] **Step 3: Remove the invalid post-clear sync**

Replace `Ink.clear()` with:

```ts
clear(): void {
	if (this.interactive && !this.options.debug) {
		this.log.clear();
		this.hasPhysicalFrame = false;
	}
}

Do not clear `lastOutput`, `lastOutputToRender`, or `lastOutputHeight`; those values describe the last React representation and preserve unchanged-unmount/layout behavior. `hasPhysicalFrame` alone records that the terminal is blank. Set it true after any actual frame write and in `restoreLastOutput()` after stdout/stderr restoration replays the frame.

- [ ] **Step 4: Run clear-specific unit and integration tests**

Run:

```bash
npm exec -- ava test/log-update.tsx test/render.tsx --match='*clear*'
```

Expected: PASS. Direct `LogUpdate.clear()` still resets incremental state, public clear followed by changed output includes both `A` and `C`, and a later viewport shrink does not invoke `clearTerminal` for the absent old frame.

- [ ] **Step 5: Conditional commit checkpoint**

Only with explicit commit approval:

```bash
git add src/ink.tsx test/render.tsx
git commit -m "fix: invalidate incremental cache after public clear"
```

---

### Task 5: Add a line-oriented complete-frame repaint primitive

**Files:**
- Modify: `src/log-update.ts:15-24,31-171,174-389`
- Test: `test/log-update.tsx:31-237`

**Interfaces:**
- Changes: `LogUpdate` gains `repaint: (str: string) => boolean`
- Produces: forced complete-frame erase/write that updates normal cached state and restores committed cursor intent
- Consumed by: Task 6

- [ ] **Step 1: Add failing complete-frame repaint tests**

Add this incremental test to `test/log-update.tsx`:

```ts
test('incremental rendering - repaint returns cursor, writes complete frame, then resumes surgical updates', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {
		showCursor: true,
		incremental: true,
	});

	render.setCursorPosition({x: 2, y: 0});
	render('Line 1\nLine 2\nLine 3\n');
	(stdout.write as any).resetHistory();

	render.repaint('Line 1\nUpdated\n');

	t.is((stdout.write as any).callCount, 1);
	const repaintCall = (stdout.write as any).firstCall.args[0] as string;
	const expectedPrefix =
		hideCursorEscape +
		ansiEscapes.cursorDown(3) +
		ansiEscapes.cursorTo(0) +
		ansiEscapes.eraseLines(4);
	const expectedSuffix =
		ansiEscapes.cursorUp(2) +
		ansiEscapes.cursorTo(2) +
		showCursorEscape;

	t.true(repaintCall.startsWith(expectedPrefix));
	t.true(repaintCall.includes('Line 1'));
	t.true(repaintCall.includes('Updated'));
	t.true(repaintCall.endsWith(expectedSuffix));

	(stdout.write as any).resetHistory();
	render('Line 1\nFinal\n');

	t.is((stdout.write as any).callCount, 1);
	const incrementalCall = (stdout.write as any).firstCall.args[0] as string;
	t.false(incrementalCall.includes('Line 1'));
	t.true(incrementalCall.includes('Final'));
});

test('incremental rendering - fullscreen repaint keeps cursor on last visible row', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {
		showCursor: true,
		incremental: true,
	});

	render.setCursorPosition({x: 0, y: 1});
	render('A\nB');
	(stdout.write as any).resetHistory();
	render.repaint('A\nC');

	const repaintCall = (stdout.write as any).firstCall.args[0] as string;
	t.true(
		repaintCall.startsWith(
			hideCursorEscape + ansiEscapes.cursorTo(0) + ansiEscapes.eraseLines(2),
		),
	);
	const suffix = repaintCall.slice(repaintCall.indexOf('A\nC') + 'A\nC'.length);
	t.is(suffix, ansiEscapes.cursorTo(0) + showCursorEscape);
});
```

Add a standard-mode test confirming that `repaint()` does not skip identical cached output:

```ts
test('standard rendering - repaint forces identical output to be written', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {showCursor: true});

	render('Same\n');
	(stdout.write as any).resetHistory();
	render.repaint('Same\n');

	t.is((stdout.write as any).callCount, 1);
	t.true(((stdout.write as any).firstCall.args[0] as string).includes('Same'));
});
```

- [ ] **Step 2: Run the repaint tests and verify they fail**

Run:

```bash
npm exec -- ava test/log-update.tsx --match='*repaint*'
```

Expected: FAIL because `LogUpdate` has no `repaint()` method.

- [ ] **Step 3: Add `repaint` to the internal interface**

Update `LogUpdate`:

```ts
export type LogUpdate = {
	clear: () => void;
	done: () => void;
	repaint: (str: string) => boolean;
	reset: () => void;
	sync: (str: string) => void;
	setCursorPosition: (position: CursorPosition | undefined) => void;
	isCursorDirty: () => boolean;
	willRender: (str: string) => boolean;
	(str: string): boolean;
};
```

- [ ] **Step 4: Refactor standard rendering around a force flag**

Replace the standard render body with a local `writeFrame()` and keep the existing callable interface:

```ts
const writeFrame = (str: string, force: boolean): boolean => {
	if (!showCursor && !hasHiddenCursor) {
		cliCursor.hide(stream);
		hasHiddenCursor = true;
	}

	const activeCursor = getActiveCursor();
	cursorDirty = false;
	const cursorChanged = cursorPositionChanged(
		activeCursor,
		previousCursorPosition,
	);

	if (!force && !hasChanges(str, activeCursor)) {
		return false;
	}

	const lines = str.split('\n');
	const outputCursorRow = getOutputCursorRow(lines);
	const cursorSuffix = buildCursorSuffix(outputCursorRow, activeCursor);

	if (!force && str === previousOutput && cursorChanged) {
		stream.write(
			buildCursorOnlySequence({
				cursorWasShown,
				previousLineCount,
				previousCursorPosition,
				outputCursorRow,
				cursorPosition: activeCursor,
			}),
		);
	} else {
		const returnPrefix = buildReturnToBottomPrefix(
			cursorWasShown,
			previousLineCount,
			previousCursorPosition,
		);
		stream.write(
			returnPrefix +
				ansiEscapes.eraseLines(previousLineCount) +
				str +
				cursorSuffix,
		);
		previousOutput = str;
		previousLineCount = lines.length;
	}

	previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
	cursorWasShown = activeCursor !== undefined;
	return true;
};

const render = (str: string) => writeFrame(str, false);
render.repaint = (str: string) => writeFrame(str, true);
```

Keep the existing `clear`, `done`, `reset`, `sync`, cursor setter, and query assignments after this definition.

- [ ] **Step 5: Implement buffered repaint for incremental rendering**

Add this assignment before returning the incremental renderer:

```ts
render.repaint = (str: string): boolean => {
	if (!showCursor && !hasHiddenCursor) {
		cliCursor.hide(stream);
		hasHiddenCursor = true;
	}

	const activeCursor = getActiveCursor();
	cursorDirty = false;
	const nextLines = str.split('\n');
	const outputCursorRow = getOutputCursorRow(nextLines);
	const returnPrefix = buildReturnToBottomPrefix(
		cursorWasShown,
		previousLines.length,
		previousCursorPosition,
	);
	const cursorSuffix = buildCursorSuffix(outputCursorRow, activeCursor);

	stream.write(
		returnPrefix +
			ansiEscapes.eraseLines(previousLines.length) +
			str +
			cursorSuffix,
	);

	previousOutput = str;
	previousLines = nextLines;
	previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
	cursorWasShown = activeCursor !== undefined;
	return true;
};
```

This method intentionally bypasses `hasChanges()` because its caller has determined that the physical diff base is invalid.

- [ ] **Step 6: Run the repaint and full log-update tests**

Run:

```bash
npm exec ava test/log-update.tsx
```

Expected: PASS. Repaint uses one content write, writes the entire frame, restores cursor intent, and subsequent updates skip unchanged rows again.

- [ ] **Step 7: Run typecheck before exposing the new method to Ink**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Conditional commit checkpoint**

Only with explicit commit approval:

```bash
git add src/log-update.ts test/log-update.tsx
git commit -m "feat: add synchronized frame repaint primitive"
```

---

### Task 6: Repair viewport transitions and synchronized clear state

**Files:**
- Modify: `src/ink.tsx:119-151,294-320,416-420,1056-1120`
- Test: `test/render.tsx:558-724`

**Interfaces:**
- Consumes: `LogUpdate.repaint(str: string): boolean` from Task 5
- Produces: `lastViewportRows` metadata and a pure resize-invalidation predicate
- Aligns: direct `clearTerminal` payloads with the exact `outputToRender` passed to `log.sync()`
- Preserves: existing `shouldClearTerminalForFrame()` behavior for ordinary issue-450 transitions while avoiding new clears on pure viewport growth

- [ ] **Step 1: Add failing exact-boundary row-shrink integration coverage**

Add this test near `#450: viewport shrink into overflow should clear once` in `test/render.tsx`:

```tsx
test.serial(
	'incremental viewport shrink into exact fullscreen repaints without clearTerminal',
	async t => {
		const stdout = createTtyStdout();
		stdout.rows = 3;
		const writes = captureWrites(stdout);

		function TwoRows() {
			return (
				<Box height={2} flexDirection="column">
					<Text>A</Text>
					<Text>B</Text>
				</Box>
			);
		}

		const instance = render(<TwoRows />, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			maxFps: 1000,
		});
		await instance.waitUntilRenderFlush();

		writes.length = 0;
		stdout.rows = 2;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();

		const combined = writes.join('');
		t.false(combined.includes(ansiEscapes.clearTerminal));
		t.true(writes.includes(bsu));
		t.true(writes.includes(esu));
		const repaintChunk = writes.find(write => {
			const plain = stripAnsi(write);
			return plain.includes('A') && plain.includes('B');
		});
		t.truthy(repaintChunk);
		t.true(repaintChunk!.includes(ansiEscapes.eraseLines(3)));
		t.true(writes.indexOf(bsu) < writes.indexOf(repaintChunk!));
		t.true(writes.indexOf(repaintChunk!) < writes.indexOf(esu));

		instance.unmount();
		await instance.waitUntilExit();
	},
);
```

- [ ] **Step 2: Add failing viewport-growth output-mode coverage**

Add a second test:

```tsx
test.serial(
	'incremental viewport growth emits trailing-newline transition without full repaint',
	async t => {
		const stdout = createTtyStdout();
		stdout.rows = 2;
		const writes = captureWrites(stdout);

		function TwoRows() {
			return (
				<Box height={2} flexDirection="column">
					<Text>A</Text>
					<Text>B</Text>
				</Box>
			);
		}

		const instance = render(<TwoRows />, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			maxFps: 1000,
		});
		await instance.waitUntilRenderFlush();

		writes.length = 0;
		stdout.rows = 3;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();

		const combined = writes.join('');
		const transitionChunk = writes.find(
			write => write !== bsu && write !== esu && write !== '',
		);
		const expectedTransition =
			ansiEscapes.cursorUp(1) +
			ansiEscapes.cursorNextLine +
			ansiEscapes.cursorNextLine;

		t.is(transitionChunk, expectedTransition);
		t.false(combined.includes(ansiEscapes.clearTerminal));
		t.false(combined.includes(ansiEscapes.eraseLines(2)));
		t.false(stripAnsi(combined).includes('A'));
		t.false(stripAnsi(combined).includes('B'));
		t.true(writes.indexOf(bsu) < writes.indexOf(transitionChunk!));
		t.true(writes.indexOf(transitionChunk!) < writes.indexOf(esu));

		instance.unmount();
		await instance.waitUntilExit();
	},
);
```

The second test proves that changing only `outputToRender` triggers a write while unchanged content remains surgical.

Add TTY overflow-growth coverage so previous-viewport classification cannot introduce a new clear when a larger viewport makes the same frame fit:

```tsx
test.serial(
	'incremental viewport growth from overflow avoids clearTerminal',
	async t => {
		const stdout = createTtyStdout();
		stdout.rows = 2;
		const writes = captureWrites(stdout);

		function ThreeRows() {
			return (
				<Box height={3} flexDirection="column">
					<Text>A</Text>
					<Text>B</Text>
					<Text>C</Text>
				</Box>
			);
		}

		const instance = render(<ThreeRows />, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			maxFps: 1000,
		});
		await instance.waitUntilRenderFlush();

		writes.length = 0;
		stdout.rows = 4;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();

		const combined = writes.join('');
		const transitionChunk = writes.find(
			write => write !== bsu && write !== esu && write !== '',
		);
		const expectedTransition =
			ansiEscapes.cursorUp(2) +
			ansiEscapes.cursorNextLine +
			ansiEscapes.cursorNextLine +
			ansiEscapes.cursorNextLine;

		t.is(transitionChunk, expectedTransition);
		t.false(combined.includes(ansiEscapes.clearTerminal));
		t.false(combined.includes(ansiEscapes.eraseLines(3)));
		t.false(stripAnsi(combined).includes('A'));
		t.false(stripAnsi(combined).includes('B'));
		t.false(stripAnsi(combined).includes('C'));
		t.true(writes.indexOf(bsu) < writes.indexOf(transitionChunk!));
		t.true(writes.indexOf(transitionChunk!) < writes.indexOf(esu));

		instance.unmount();
		await instance.waitUntilExit();
	},
);
```

Add content-driven fullscreen-exit coverage for the existing `clearTerminal` fallback. It must physically write the same trailing-newline representation that `log.sync()` caches before restoring an interior cursor:

```tsx
test.serial(
	'incremental content shrink from fullscreen writes synchronized trailing frame',
	async t => {
		const stdout = createTtyStdout();
		stdout.rows = 3;
		const writes = captureWrites(stdout);

		function Frame({
			compact,
			label,
		}: {
			readonly compact: boolean;
			readonly label: string;
		}) {
			const {setCursorPosition} = useCursor();
			setCursorPosition({x: 0, y: 1});

			return (
				<Box height={compact ? 2 : 3} flexDirection="column">
					<Text>A</Text>
					<Text>{label}</Text>
					{compact ? null : <Text>C</Text>}
				</Box>
			);
		}

		const instance = render(<Frame compact={false} label="B" />, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			maxFps: 1000,
		});
		await instance.waitUntilRenderFlush();

		writes.length = 0;
		instance.rerender(<Frame compact label="B" />);
		await instance.waitUntilRenderFlush();

		const clearChunk = writes.find(write =>
			write.includes(ansiEscapes.clearTerminal),
		);
		t.truthy(clearChunk);
		t.true(clearChunk!.endsWith('A\nB\n'));
		t.true(writes.includes(bsu));
		t.true(writes.includes(esu));
		t.true(writes.indexOf(bsu) < writes.indexOf(clearChunk!));
		t.true(writes.indexOf(clearChunk!) < writes.indexOf(esu));

		writes.length = 0;
		instance.rerender(<Frame compact label="Updated" />);
		await instance.waitUntilRenderFlush();
		t.true(stripAnsi(writes.join('')).includes('Updated'));

		instance.unmount();
		await instance.waitUntilExit();
	},
);
```

- [ ] **Step 3: Run the boundary and clear-alignment tests and verify they fail**

Run:

```bash
npm exec -- ava test/render.tsx --match='incremental viewport*' --match='incremental content shrink*'
```

Expected: FAIL. Exact row shrink emits no repaint, viewport growth emits no output-mode transition because `output === lastOutput`, and the content-driven clear writes `output` without the trailing newline later recorded by `sync()`.

- [ ] **Step 4: Track the viewport used by the previous frame**

Add the field beside the existing output metadata:

```ts
private lastOutput: string;
private lastOutputToRender: string;
private lastOutputHeight: number;
private lastViewportRows: number;
private lastTerminalWidth: number;
```

Initialize it in the constructor:

```ts
this.lastOutput = '';
this.lastOutputToRender = '';
this.lastOutputHeight = 0;
this.lastViewportRows = getWindowSize(this.options.stdout).rows;
this.lastTerminalWidth = getWindowSize(this.options.stdout).columns;
```

- [ ] **Step 5: Make previous-frame fullscreen classification use the previous viewport**

Extend `shouldClearTerminalForFrame()` with `previousViewportRows` and prevent pure viewport growth from being treated as content-driven fullscreen exit:

```ts
const shouldClearTerminalForFrame = ({
	isTty,
	previousViewportRows,
	viewportRows,
	previousOutputHeight,
	nextOutputHeight,
	isUnmounting,
}: {
	isTty: boolean;
	previousViewportRows: number;
	viewportRows: number;
	previousOutputHeight: number;
	nextOutputHeight: number;
	isUnmounting: boolean;
}): boolean => {
	if (!isTty) {
		return false;
	}

	const hadPreviousFrame = previousOutputHeight > 0;
	const viewportChanged = previousViewportRows !== viewportRows;
	const wasFullscreen = previousOutputHeight >= previousViewportRows;
	const wasOverflowing = previousOutputHeight > previousViewportRows;
	const isOverflowing = nextOutputHeight > viewportRows;
	const isLeavingFullscreenFromContent =
		wasFullscreen &&
		nextOutputHeight < viewportRows &&
		(!viewportChanged || nextOutputHeight < previousOutputHeight);
	const shouldClearPreviousOverflow = wasOverflowing && !viewportChanged;
	const shouldClearOnUnmount = isUnmounting && wasFullscreen;

	return (
		shouldClearPreviousOverflow ||
		(isOverflowing && hadPreviousFrame) ||
		isLeavingFullscreenFromContent ||
		shouldClearOnUnmount
	);
};
```

`shouldClearPreviousOverflow` preserves the existing same-viewport content fallback. If the viewport changed, `isOverflowing && hadPreviousFrame` still clears when the next frame overflows the current viewport, while pure growth that makes the frame fit does not clear.

Pass `this.lastViewportRows` at the call site.

- [ ] **Step 6: Add a pure predicate for exact-fullscreen resize invalidation**

Place this next to `shouldClearTerminalForFrame()`:

```ts
const shouldRepaintForViewportTransition = ({
	isTty,
	previousViewportRows,
	viewportRows,
	previousOutputHeight,
	nextOutputHeight,
}: {
	isTty: boolean;
	previousViewportRows: number;
	viewportRows: number;
	previousOutputHeight: number;
	nextOutputHeight: number;
}): boolean =>
	isTty &&
	previousOutputHeight > 0 &&
	viewportRows < previousViewportRows &&
	previousOutputHeight < previousViewportRows &&
	nextOutputHeight === viewportRows;
```

This predicate covers the newly confirmed exact-fullscreen row-shrink case. Existing overflow logic remains in `shouldClearTerminalForFrame()`.

- [ ] **Step 7: Route invalidated frames through synchronized `repaint()`**

In `renderInteractiveFrame()`, calculate both decisions:

```ts
const shouldClearTerminal = shouldClearTerminalForFrame({
	isTty,
	previousViewportRows: this.lastViewportRows,
	viewportRows,
	previousOutputHeight: this.lastOutputHeight,
	nextOutputHeight: outputHeight,
	isUnmounting: this.isUnmounting,
});
const shouldRepaintFrame = shouldRepaintForViewportTransition({
	isTty,
	previousViewportRows: this.lastViewportRows,
	viewportRows,
	previousOutputHeight: this.lastOutputHeight,
	nextOutputHeight: outputHeight,
});
```

In the existing `shouldClearTerminal` branch, write `outputToRender` rather than `output` so the physical payload and `log.sync(outputToRender)` use the same trailing-newline mode. Also record the viewport before returning:

```ts
this.options.stdout.write(
	ansiEscapes.clearTerminal + this.fullStaticOutput + outputToRender,
);
this.lastOutput = output;
this.lastOutputToRender = outputToRender;
this.lastOutputHeight = outputHeight;
this.lastViewportRows = viewportRows;
this.log.sync(outputToRender);
```

Do not add another `clearTerminal` call site. This replaces the payload at the existing fallback only.

Keep the existing static-output branch first because it already erases and restores the complete dynamic frame. Add the new branch immediately after it:

```ts
} else if (shouldRepaintFrame) {
	const sync = this.shouldSync();
	if (sync) {
		this.options.stdout.write(bsu);
	}

	this.log.repaint(outputToRender);

	if (sync) {
		this.options.stdout.write(esu);
	}
} else if (
	outputToRender !== this.lastOutputToRender ||
	this.log.isCursorDirty()
) {
	this.throttledLog(outputToRender);
}
```

At the end of `renderInteractiveFrame()`, update all frame metadata:

```ts
this.lastOutput = output;
this.lastOutputToRender = outputToRender;
this.lastOutputHeight = outputHeight;
this.lastViewportRows = viewportRows;
```

Comparing `outputToRender` is required for viewport growth, where `output` is unchanged but trailing-newline mode changes.

- [ ] **Step 8: Run exact-boundary and issue-450 tests**

Run:

```bash
npm exec -- ava test/render.tsx --match='incremental viewport*' --match='incremental content shrink*' --match='#450*' --match='fullscreen mode*'
```

Expected: PASS. Exact row shrink emits BSU → complete erase-lines repaint → ESU with no new `clearTerminal`; exact-fullscreen and prior-overflow row growth emit incremental representation updates without clearing; the existing clear fallback writes and synchronizes the same trailing-newline representation; existing issue-450 counts remain unchanged.

- [ ] **Step 9: Run all focused rendering tests**

Run:

```bash
npm exec ava test/cursor-helpers.tsx test/log-update.tsx test/render.tsx test/terminal-resize.tsx
npm exec -- ava test/cursor.tsx --match='!*suspended concurrent render*'
```

Expected: PASS. The single documented `act is not a function` concurrent cursor test is excluded from this blocking gate.

- [ ] **Step 10: Conditional commit checkpoint**

Only with explicit commit approval:

```bash
git add src/ink.tsx test/render.tsx
git commit -m "fix: repaint invalidated fullscreen resize frames"
```

---

### Task 7: Repair terminal-column reflow invalidation

**Starting point:** Tasks 1-6 are present on the current branch. This task addresses the separately confirmed column-reflow failure without reopening their cursor, public-clear, or row-viewport contracts.

**Files:**
- Modify: `src/log-update.ts:17-25,34-190,193-438`
- Modify: `src/ink.tsx:158-175,330-336,501-515,1077-1166`
- Test: `test/log-update.tsx:240-486,793-870`
- Test: `test/render.tsx:1018-1160`
- Test: `test/terminal-resize.tsx:153-286`

**Interfaces:**
- Extends internal `LogUpdate.clear()` and `LogUpdate.repaint()` with an optional physical erase-count override; this is not a public Ink API.
- Consumes: `lastOutputToRender`, `lastTerminalWidth`, persistent cursor state, `LogUpdate.willRender()`, and synchronized repainting from prior tasks.
- Produces: a terminal-equivalent prior-frame row count at current columns, one complete repaint for each column decrease, and continued invalidation while the last written frame is physically soft-wrapped beyond its cached logical rows.
- Preserves: cached cursor return-to-bottom distance, static-output ordering, existing `clearTerminal` fallbacks, no erase of a frame already removed by `clear()`/`reset()`, byte-identical idle no-ops, and surgical diffing as soon as physical and logical row geometry match.

- [ ] **Step 1: Add failing `LogUpdate` erase-override tests**

Add these beside the existing clear/repaint tests in `test/log-update.tsx` for both `renderingModes`:

```tsx
for (const {name, incremental} of renderingModes) {
	test(`${name} - clear honors a physical erase override`, t => {
		const {stdout, render} = createRenderForMode(incremental);
		render.setCursorPosition({x: 0, y: 0});
		render('A\nB\n');
		resetHistory();

		render.clear({eraseLineCount: 7});

		t.is(
			stdout.get(),
			hideCursorEscape +
				ansiEscapes.cursorDown(2) +
				ansiEscapes.cursorTo(0) +
				ansiEscapes.eraseLines(7),
		);
	});

	test(`${name} - repaint honors a physical erase override`, t => {
		const {stdout, render} = createRenderForMode(incremental);
		render.setCursorPosition({x: 0, y: 0});
		render('A\nB\n');
		resetHistory();

		t.true(render.repaint('C\nD\n', {eraseLineCount: 7}));
		const write = stdout.get();
		t.true(
			write.startsWith(
				hideCursorEscape +
					ansiEscapes.cursorDown(2) +
					ansiEscapes.cursorTo(0) +
					ansiEscapes.eraseLines(7),
			),
		);
		t.true(write.includes('C\nD\n'));
	});
}
```

The expected cursor-down distance remains based on the cached three-slot frame (`A`, `B`, trailing baseline). Only the physical erase height is overridden.

Also add a mode-loop regression that renders a frame, calls `clear()`, resets write history, and then calls `repaint()` with an erase override. The repaint must write only the new frame because the cache no longer represents physically present rows.

- [ ] **Step 2: Add a failing narrow-width physical-reflow integration test**

Add a reusable fixture near the existing resize tests in `test/render.tsx`:

```tsx
function WidthReflowFrame({suffix = ''}: {readonly suffix?: string}) {
	const {setCursorPosition} = useCursor();
	setCursorPosition({x: 1, y: 1});

	return (
		<Box borderStyle="round">
			<Text>{`ABCDEFGH${suffix}`}</Text>
		</Box>
	);
}
```

Then add:

```tsx
test.serial(
	'incremental column shrink erases reflowed rows and repaints once',
	async t => {
		const stdout = createTtyStdout(10);
		stdout.rows = 24;
		const writes = captureWrites(stdout);
		const instance = render(<WidthReflowFrame />, {
			stdout,
			interactive: true,
			incrementalRendering: true,
			maxFps: 1000,
		});
		t.teardown(async () => {
			instance.unmount();
			await instance.waitUntilExit();
		});
		await instance.waitUntilRenderFlush();

		writes.length = 0;
		stdout.columns = 5;
		stdout.emit('resize');
		await instance.waitUntilRenderFlush();

		const repaint = writes.find(
			write =>
				write.includes(ansiEscapes.eraseLines(7)) &&
				stripAnsi(write).includes('╭'),
		);
		t.truthy(repaint);
		t.false(writes.some(write => write.includes(ansiEscapes.clearTerminal)));

		const bsuIndex = writes.indexOf(bsu);
		const repaintIndex = writes.indexOf(repaint!);
		const esuIndex = writes.indexOf(esu);
		t.true(bsuIndex < repaintIndex);
		t.true(repaintIndex < esuIndex);

		writes.length = 0;
		instance.rerender(<WidthReflowFrame suffix="!" />);
		await instance.waitUntilRenderFlush();
		t.true(stripAnsi(writes.join('')).includes('!'));
		t.false(stripAnsi(writes.join('')).includes('╭'));
	},
);
```

The initial box has three 10-cell visible rows plus a trailing baseline (four cached newline slots). At five columns, the terminal reflows those rows to six visible rows plus the baseline, so the correct erase is seven rows. Add a fixed-width two-row fullscreen control as well: because its output has no trailing newline, shrinking 10 → 5 erases exactly four reflowed visible rows rather than inventing a fifth baseline row. The final changed-frame assertion proves normal updates return to surgical diffing.

Add public-clear boundaries as well: (1) render the ten-column frame, call `instance.clear()`, then shrink to five columns—the resize may repaint the new frame but must not emit the seven-row override for the absent old frame; (2) use a fixed-width two-row frame whose bytes do not change, clear it, shrink columns with no write, then shrink rows—the no-write resize must keep `hasPhysicalFrame` false and avoid `clearTerminal`; (3) after clear, restore the frame through `useStdout().write()`, then shrink columns—the replay must set `hasPhysicalFrame` true so the seven-row reflow erase is used again.

- [ ] **Step 3: Add width-direction, delayed, static, grapheme, cursor, listener-order, and hot-path controls**

Add seven focused tests using the same setup:

1. **Column growth control, 5 → 10:** start with `<WidthReflowFrame />` at five columns, clear captured writes, emit resize at ten columns, and assert no `clearTerminal` and no width-invalidation `ansiEscapes.eraseLines(6)` complete repaint. Require the existing incremental shrink sequence (including erasure of rows removed by the shorter next frame). The headless-terminal probe showed no duplicated physical rows on growth, so this control prevents an unnecessary full-frame fallback.
2. **Delayed/missed resize event:** start at ten columns, set `stdout.columns = 5` without emitting `resize`, then call `instance.rerender(<WidthReflowFrame suffix="!" />)`. Require the same synchronized `eraseLines(7)` complete repaint. This proves render-time column comparison repairs the next real render after suspension/idle rather than depending solely on event delivery.
3. **Wide-grapheme boundary:** render `<Text color="red">aaaa中aaaa</Text>` at ten columns, shrink to five, and require `eraseLines(4)`. The old visible line reflows to three physical rows because `中` cannot start in the final one-cell slot; the trailing baseline is the fourth row. This rejects a naive `Math.ceil(stringWidth(line) / columns)` implementation.
4. **Static output during shrink:** render `<WidthReflowWithStatic items={[]} />` at ten columns, set columns to five without emitting resize, and rerender with `items={['static']}`. Require the width-aware `eraseLines(7)` clear before the wrapped static write and restored dynamic frame, all within BSU/ESU. This locks the `LogUpdate.clear()` override path rather than only `repaint()`.
5. **Delayed cursor-only render:** render a fixed ten-column frame with a committed cursor, set columns to five without emitting `resize`, allow an idle turn with no writes, then rerender with only the cursor position changed. Require byte-identical frame output to be repainted with `eraseLines(3)` inside BSU/ESU. This proves width invalidation runs before a cursor-only write can reuse a pre-resize cache.
6. **`useWindowSize()` follow-up commit:** render a fixed-width frame whose width and text length come from `useWindowSize()`, with a committed cursor. Shrink 10 → 5 and let normal listener order run. Ink's listener first paints an `XXXXXXXXXX` intermediate frame at five columns; the hook listener then commits `XXXXX`. Require the final frame write—not merely the first resize repaint—to contain `eraseLines(3)` and strip to exactly `XXXXX\n`. An isolated `@xterm/headless` run must fail before the fix with two visible `XXXXX` rows and pass afterward with one.
7. **Ordinary-frame hot path:** invoke `renderInteractiveFrame()` for an unchanged-width, byte-identical physical frame while a stubbed `Intl.Segmenter.segment()` throws. The call must not throw. `wrap-ansi` uses that segmenter, so this deterministically proves ordinary frames do not re-wrap the prior output. The naive always-measure implementation must fail this test.

For resize cases, call `waitUntilRenderFlush()` and register unmount/wait teardown. For the five shrink invalidations, assert BSU precedes erase/repaint and ESU follows it.

- [ ] **Step 4: Run the new regressions and verify they fail**

Run:

```bash
npm exec -- ava test/log-update.tsx --match='*physical erase override*'
npm exec -- ava test/render.tsx --match='incremental column*' --match='incremental delayed*' --match='*after public clear*' --match='*wide-grapheme*' --match='*resize invalidation*' --match='*skips terminal reflow measurement*'
```

Expected: FAIL overall. `LogUpdate` does not accept erase options; shrinking eagerly emits cached `eraseLines(4)` before the synchronized render; a changed narrower width discovered without `resize` is not treated as invalidation; a cursor-only delayed render can reuse the pre-resize cache; an override after public `clear()` can erase unrelated rows; no-write resize metadata can resurrect an absent frame; stdout restoration can fail to restore physical-frame tracking; the static branch erases only cached logical rows; and wide-glyph physical height is not calculated. After the first width-aware repaint implementation, the `useWindowSize()` case must still fail because the hook's second commit takes the logical diff path and leaves a wrapped row behind. The width-growth control should already pass and must remain incremental.

- [ ] **Step 5: Add the internal physical erase override**

In `src/log-update.ts`, add one shared internal options type and extend only the internal callable contract:

```ts
type EraseOptions = {
	eraseLineCount?: number;
};

export type LogUpdate = {
	clear: (options?: EraseOptions) => void;
	done: () => void;
	repaint: (str: string, options?: EraseOptions) => boolean;
	// Existing members unchanged.
};

const getEraseLineCount = (
	cachedLineCount: number,
	options?: EraseOptions,
): number =>
	cachedLineCount === 0
		? 0
		: (options?.eraseLineCount ?? cachedLineCount);
```

For standard rendering, thread options into forced `writeFrame()` calls. For incremental rendering, use the override directly in `repaint()`. In both implementations, use it in `clear()` as well:

```ts
ansiEscapes.eraseLines(getEraseLineCount(cachedLineCount, options))
```

Do not use the override for `buildReturnToBottomPrefix()`: xterm probing confirmed resize preserves the committed cursor's distance to the post-frame baseline. The override changes only how many physical rows are erased after reaching that baseline. Ignore it when the cached line count is zero, because `clear()`/`reset()` means no physical frame remains to erase. After repaint, cache `str.split('\n')` normally so subsequent updates are incremental.

- [ ] **Step 6: Derive the previous frame's row count at current columns**

Place this pure helper near the existing render predicates in `src/ink.tsx` (the file already imports `wrap-ansi`):

```ts
const getReflowedLineCount = (output: string, columns: number): number => {
	if (output === '') {
		return 0;
	}

	return wrapAnsi(output, columns, {
		trim: false,
		hard: true,
		wordWrap: false,
	}).split('\n').length;
};
```

`wrap-ansi` invokes wrapping separately for every existing newline, so Ink's hard row boundaries remain hard. `wordWrap: false` models terminal character-cell wrapping rather than semantic word wrapping. Its existing `string-width` integration handles SGR/OSC sequences and wide graphemes.

Classifying the newly written frame only needs a boolean, not an exact physical row count. Use the existing `widest-line` dependency so this cold path does not pay for a second complete `wrap-ansi` pass:

```ts
const isOutputSoftWrapped = (output: string, columns: number): boolean =>
	output !== '' && widestLine(output) > columns;
```

Keep `getReflowedLineCount()` for the previous frame's erase override, where the exact grapheme-aware physical row count is required.

- [ ] **Step 7: Replace eager resize clearing with render-time invalidation**

Change `resized()` so it does not erase output or reset either cached output string:

```ts
resized = () => {
	const currentWidth = getWindowSize(this.options.stdout).columns;
	this.calculateLayout();
	this.onRender();
	// Keep this after onRender so renderInteractiveFrame sees the prior width.
	this.lastTerminalWidth = currentWidth;
};
```

In `renderInteractiveFrame()`, read dimensions once and classify physical invalidation from cached frame metadata. Do not consume invalidation merely because `lastTerminalWidth` advanced: an intermediate frame written from stale width-dependent React state can already be soft-wrapped at the current columns. Equally, do not discover that fact by re-wrapping the whole frame on every render.

Add `lastPhysicalFrameWasSoftWrapped`, initialized and cleared with `hasPhysicalFrame`. Classify every committed physical frame with the cheap width predicate, then keep exact reflow measurement behind the cold-path predicate:

```ts
const hadPhysicalFrame = this.hasPhysicalFrame;
const previousOutputHeight = hadPhysicalFrame ? this.lastOutputHeight : 0;
const hasCachedPhysicalOutput =
	hadPhysicalFrame && this.lastOutputToRender !== '';
const columnsDecreased =
	Boolean(isTty) && terminalWidth < this.lastTerminalWidth;
const outputWillRender = hasStaticOutput || this.log.willRender(outputToRender);
const shouldClassifyNextFrame =
	Boolean(isTty) && (columnsDecreased || outputWillRender);
const nextFrameIsSoftWrapped =
	shouldClassifyNextFrame && isOutputSoftWrapped(outputToRender, terminalWidth);
const shouldRepairReflow =
	Boolean(isTty) &&
	hasCachedPhysicalOutput &&
	(columnsDecreased ||
		((this.lastPhysicalFrameWasSoftWrapped || nextFrameIsSoftWrapped) &&
			outputWillRender));
const reflowedLineCount = shouldRepairReflow
	? getReflowedLineCount(this.lastOutputToRender, terminalWidth)
	: 0;
const reflowEraseOptions = shouldRepairReflow
	? {eraseLineCount: reflowedLineCount}
	: undefined;
```

After a physical write, update the cached flag even when the frame was initially rendered wider than the terminal:

```ts
if (didWriteFrame) {
	this.lastPhysicalFrameWasSoftWrapped = shouldClassifyNextFrame
		? nextFrameIsSoftWrapped
		: Boolean(isTty) && isOutputSoftWrapped(outputToRender, terminalWidth);
}
```

Apply the same classification in the direct `clearTerminal` branch and after `restoreLastOutput()`. Before public `clear()` or external stdout/stderr output calls `LogUpdate.clear()`, use `getReflowedLineCount(lastOutputToRender, currentColumns)` as an erase override when the displayed frame is currently soft-wrapped. Public `clear()` resets the physical markers only after that complete erase. `columnsDecreased` forces the first repaint even when bytes are unchanged; the cached flag carries invalidation into delayed width-dependent follow-up commits and protects initially overwide frames; ordinary valid updates perform no `wrap-ansi` or full-output split work.

Apply the options without changing branch ownership:

- Pass `previousOutputHeight` rather than raw `lastOutputHeight` to the row/fullscreen predicates. Existing `shouldClearTerminal` still wins when its established overflow/content fallback requires a full clear for a physical frame; record `lastTerminalWidth`, set `hasPhysicalFrame = true`, and classify the newly written frame before that branch returns.
- In the static-output branch, call `this.log.clear(reflowEraseOptions)` before writing static output.
- Otherwise, enter the synchronized repaint branch when either the row predicate is true or `reflowEraseOptions` exists, and call `this.log.repaint(outputToRender, reflowEraseOptions)`. Column growth must not enter this branch solely because columns changed.
- Keep ordinary `this.throttledLog(outputToRender)` only when neither physical invalidation applies.
- Track `didWriteFrame` across the static, repaint, and ordinary render branches. At the common metadata update, always retain the latest React height/dimensions and set `hasPhysicalFrame = hadPhysicalFrame || didWriteFrame`.
- Public `clear()` has set both physical markers false, so neither row/fullscreen classification nor column reflow treats the erased frame as present. A byte-identical resize that emits no write preserves false; `restoreLastOutput()` changes it back to true and classifies the restored bytes once.

The erase and complete frame must remain inside the existing BSU/ESU wrapper. There must be no separate `log.clear()` write before BSU and no new `clearTerminal` branch.

- [ ] **Step 8: Update general resize expectations**

In `test/terminal-resize.tsx`, rename width tests/comments that describe the old eager-clear implementation. Preserve their layout/listener assertions, but assert the resulting transition:

- decreasing width performs a complete repaint and does not emit `clearTerminal`;
- increasing width stays on the existing incremental shrink/diff path and does not emit `clearTerminal` or a complete width-invalidation repaint;
- consecutive changes each repaint once;
- a later content update still renders normally.

Do not add `@xterm/headless` as a package dependency. The isolated diagnostic probes establish both physical-screen failures; committed tests should lock the deterministic erase/repaint protocol, including the final width-hook commit.

- [ ] **Step 9: Run the new tests and existing resize coverage**

Run:

```bash
npm exec -- ava test/log-update.tsx --match='*physical erase override*'
npm exec -- ava test/render.tsx --match='incremental column*' --match='incremental delayed*' --match='*wide-grapheme*' --match='*resize invalidation*'
npm exec ava test/terminal-resize.tsx
```

Expected: PASS. Both renderers honor erase overrides; narrow/delayed/cursor-only/wide cases emit synchronized complete repaints with exact erase counts; a soft-wrapped resize-listener intermediate frame remains invalid until the `useWindowSize()` follow-up commit repaints it; width growth remains incremental; and general resize behavior remains intact without `clearTerminal`.

- [ ] **Step 10: Run all focused rendering tests**

Run:

```bash
npm exec ava test/cursor-helpers.tsx test/log-update.tsx test/render.tsx test/terminal-resize.tsx
npm exec -- ava test/cursor.tsx --match='!*suspended concurrent render*'
npm run typecheck
```

Expected: PASS. Existing cursor, clear, row-viewport, issue-450, and terminal-resize regressions remain green.

- [ ] **Step 11: Conditional commit checkpoint**

Only with explicit commit approval:

```bash
git add src/log-update.ts src/ink.tsx test/log-update.tsx test/render.tsx test/terminal-resize.tsx docs/superpowers/specs/2026-08-09-incremental-rendering-state-repair-design.md docs/superpowers/plans/2026-08-09-incremental-rendering-state-repair.md
git commit -m "fix: repaint terminal column reflow"
```

---


### Task 8: Complete package verification and review

**Files:**
- Verify only: `src/cursor-helpers.ts`
- Verify only: `src/log-update.ts`
- Verify only: `src/ink.tsx`
- Verify only: `test/cursor-helpers.tsx`
- Verify only: `test/cursor.tsx`
- Verify only: `test/log-update.tsx`
- Verify only: `test/render.tsx`
- Verify only: `test/terminal-resize.tsx`

**Interfaces:**
- Consumes: all prior tasks
- Produces: evidence that focused regressions and typing pass, with package-wide lint/test results compared against the documented pre-existing baseline

- [ ] **Step 1: Run focused regression files**

Run:

```bash
npm exec ava test/cursor-helpers.tsx test/log-update.tsx test/render.tsx test/terminal-resize.tsx
npm exec -- ava test/cursor.tsx --match='!*suspended concurrent render*'
```

Expected: both commands pass with zero failed tests. The single documented `act is not a function` concurrent cursor test is excluded from this blocking gate.

- [ ] **Step 2: Run TypeScript validation**

Run:

```bash
npm run typecheck
```

Expected: exit code 0 with no diagnostics.

- [ ] **Step 3: Run lint and compare with the baseline**

Run:

```bash
npm run lint
```

Expected: no new diagnostics attributable to the planned source or test changes. The command may remain non-zero with the documented 13 unrelated pre-existing errors and 9 warnings.

- [ ] **Step 4: Run the complete package command for baseline comparison**

Run:

```bash
npm test
npm exec ava
```

Expected: typecheck remains clean and no new planned-file lint diagnostics appear. `npm test` may stop at the documented pre-existing lint failures, so run AVA directly as well; it may retain the documented 57-failure concurrent-test baseline. Focused AVA files from Step 1 are the blocking behavior gate, and every new rendering/resize regression must also pass when encountered in the complete run.

- [ ] **Step 5: Inspect the nested repository diff and whitespace**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

Then run:

```bash
git status --short
```

Expected: only the planned source, test, spec, and plan files are listed. The pre-existing final-newline-only `package.json` change must not be included in any commit unless separately requested.

- [ ] **Step 6: Request code review**

Review the final diff for:

- no new `clearTerminal` call sites or new clear invocations on pure viewport growth;
- every direct terminal-clear payload exactly matches the `outputToRender` representation passed to `log.sync()`;
- no public API changes; the erase-count options remain internal to `LogUpdate.clear()`/`repaint()`;
- complete handling of trailing and non-trailing cursor baselines;
- persistent cursor intent cleared only by explicit `undefined`, teardown, or fresh instance creation;
- cache-only `reset()` remains non-writing and documents its external-reset precondition;
- column decreases are detected from frame metadata, erase the previous frame's physical height at current columns, and keep erase/repaint between BSU and ESU; column growth stays incremental;
- static-output insertion receives the same width-aware erase override;
- unchanged-column frames remain surgical and unchanged issue-450 clear counts remain intact.

- [ ] **Step 7: Conditional final commit checkpoint**

Only with explicit commit approval, stage the exact reviewed files and exclude the pre-existing `package.json` change:

```bash
git add src/cursor-helpers.ts src/log-update.ts src/ink.tsx test/cursor-helpers.tsx test/log-update.tsx test/render.tsx test/terminal-resize.tsx docs/superpowers/specs/2026-08-09-incremental-rendering-state-repair-design.md docs/superpowers/plans/2026-08-09-incremental-rendering-state-repair.md
git commit -m "fix: keep incremental rendering state aligned with terminal"
```
