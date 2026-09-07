# Allocated Cursor-Seek Fallback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep fullscreen incremental Ink frames on their allocated cell grid when OSC 66 is unavailable, without changing layout or original text.

**Architecture:** Add a validated, style-preserving row writer to `createIncremental`, after logical row comparison. The incremental logger owns its physical viewport record and autowrap transaction; Ink owns capability selection, layout freshness, pending frames, and ordinary-output ordering. Fullscreen resize invalidates the viewport and repaints it with absolute coordinates; the existing raw/OSC 66 branches retain their current behavior.

**Tech Stack:** Nested `@nuvin/ink` repository at Node >=22, TypeScript, React, AVA, `Intl.Segmenter`, existing `string-width`, and test-only `@xterm/headless@6.0.0`; outer workspace uses pnpm 10.19.0.

---

## Scope, source of truth, and execution rules

- Spec: [Allocated Cursor-Seek Fallback Design](../specs/2026-09-06-allocated-cursor-seek-fallback-design.md).
- **Only fullscreen incremental dynamic frames:** `incrementalRendering === true`, interactive TTY, non-debug, non-screen-reader, and `outputHeight === terminal.rows`. Frames shorter or taller than the viewport and Static output do not use seek painting.
- Existing OSC 66 success/force-on behavior takes precedence. `explicitWidth: 'disabled'` and `INK_EXPLICIT_WIDTH=0` disable the new path too.
- No CLI component/layout changes, width-table replacement, selector stripping, ZWJ substitution, new public option, brand dispatch, or change to native-copy guarantees.
- Preserve raw logical text for comparison and Ink-managed copy. Clip only the paint representation.
- Disable scroll-region optimization only for seek frames; retain positional changed-row comparison.
- Physical Warp/Terminal.app acceptance is required before shipping the fallback enabled by default. Completing source tests does not complete that gate.
- This document is a plan, not authorization to commit, merge, push, publish, or change the user's existing dependency mode. At each task checkpoint, review the scoped diff. Create the suggested commit only if the execution session explicitly authorizes commits; otherwise leave the work unstaged.
- Use @superpowers:test-driven-development for implementation and @superpowers:verification-before-completion for checkpoints. Use @superpowers:systematic-debugging for unexpected failures. Do not implement during this planning session.

**Path convention:** All `src/`, `test/`, `docs/`, `package.json`, and `readme.md` paths below are relative to `packages/ink`. Paths starting `outer:` are relative to the Nuvin workspace root. Run AVA/npm commands in `packages/ink`; run pnpm workspace commands at the outer root. Save the plan beside the existing Ink plan, following this repository's `docs/superpowers/plans` convention.

## Current checkout audit — 2026-09-07

Nested Ink HEAD is `ee60c0e` (`feat: negotiate OSC 66 explicit grapheme widths`). The seek implementation does not exist yet. Recheck HEAD before execution; do not replay already completed tasks.

Relevant current seams:

| File / symbol                                                         | Existing behavior                                                                          | Planned responsibility                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `src/explicit-width.ts` / control consumers                           | Complete escape-token scanning private to OSC 66 encoder                                   | Share token boundaries without changing OSC 66 acceptance                |
| `src/log-update.ts` / `createIncremental`                             | Initial/repaint bulk writes; changed-row cursor-to-zero plus unconditional trailing erase  | Separate seek viewport branch with one row writer                        |
| `src/log-update.ts` / `detectScrollShift`                             | Whole-line shift optimization                                                              | Bypass on seek frames only                                               |
| `src/ink.tsx` / `PendingFrame`, `throttledLog`                        | Carries text, height, Static delta; physical flags sometimes update when work is scheduled | Snapshot layout size and publish physical state only on actual writes    |
| `src/ink.tsx` / constructor, `settleExplicitWidth`                    | Failed negotiation leaves raw output                                                       | Select seek only for eligible dynamic frames                             |
| `src/ink.tsx` / `renderInteractiveFrame`, `getPhysicalEraseOptions`   | Computes reflow from raw text; direct clear/replay can bypass log                          | Route owned seek viewports through absolute clear/repaint                |
| `src/ink.tsx` / `writeToStdout`, `writeToStderr`, `restoreLastOutput` | Clear, external write, restore                                                             | Preserve ordering and primary-screen history before absolute restoration |
| `src/ink.tsx` / `unmount`, `writeBestEffort`                          | Controlled final render, then React cleanup / screen teardown                              | Restore interrupted seek modes without starting a new late paint         |
| `src/output.ts`, `src/renderer.ts`, selection files                   | Grid allocation and original plain rows                                                    | Preserve these contracts; no width-calculator change                     |

Outer `pnpm-workspace.yaml` already selects `ink: link:packages/ink`; it and `pnpm-lock.yaml` contain unrelated local changes. Nested Ink has no separate tracked lockfile; the outer lock has a `packages/ink` importer. The spec and prior OSC 66 documents are currently untracked. Do not lose them when creating a worktree, and do not stage them incidentally.

## Dependency order

`0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8 -> 9 -> 10`

Tasks 1–3 establish row correctness. Tasks 4–5 integrate actual incremental writes and viewport state. Tasks 6–8 integrate selection and lifecycle. Task 9 validates source/consumers; Task 10 supplies physical acceptance. Complete each checkpoint before continuing.

## Task 0: Prepare the execution checkout and record a baseline

**Files:**

- Read: spec, this plan, `package.json`, `test/tsconfig.json`.
- Preserve: `outer:pnpm-workspace.yaml`, `outer:pnpm-lock.yaml`, all existing tracked/untracked work.
- Create during execution: `docs/superpowers/reports/2026-09-07-allocated-cursor-seek-fallback-verification.md`.

- [ ] **Step 1:** Record `git status --short` and `git rev-parse HEAD` in both repositories. Use @superpowers:using-git-worktrees if execution needs isolation. Remember `packages/ink` is a separate nested Git repository; an outer worktree does not automatically contain it or the untracked spec. Copy the reviewed documents explicitly into the execution checkout. Do not create a symlink that lets worktree installs mutate the live checkout.
- [ ] **Step 2:** Record the active Node/pnpm versions and CLI Ink resolution. Run at the outer root:

```sh
node --version
pnpm --version
pnpm --filter @nuvin/nuvin-code exec node --input-type=module -e 'console.log(import.meta.resolve("ink"))'
git diff -- pnpm-workspace.yaml pnpm-lock.yaml
```

Expected: the current checkout resolves the local nested Ink build; a fresh execution checkout must resolve its own intended build. Preserve any preexisting link/patch configuration. Do not run `make ink-npm` or an unrelated reinstall.

- [ ] **Step 3:** Run the focused existing baseline from nested Ink:

```sh
env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/explicit-width.ts test/log-update-explicit-width.ts test/log-update.tsx test/log-update-scroll-region.ts test/explicit-width-auto.tsx
npm run typecheck
```

Expected: baseline tests/typecheck complete with recorded exit codes. Diagnose missing dependencies/artifacts before calling them product regressions. Historical pass counts and known-failure notes are not today's results.

- [ ] **Step 4:** Initialize the report with baseline versions/HEADs, preserved files, commands/results, and all task/live gates marked pending. No implementation commit at this step.

## Task 1: Share escape-token boundaries without changing OSC 66

**Files:**

- Create: `src/terminal-control.ts`, `test/terminal-control.ts`.
- Modify: `src/explicit-width.ts` — `consumeCsiBody`, `consumeString`, `consumeEsc`, scanner call sites.
- Regression tests: `test/explicit-width.ts`, `test/log-update-explicit-width.ts`.

- [ ] **Step 1:** Add failing tests for CSI, OSC BEL/ST/C1-ST, DCS/APC/PM/SOS, C1 introducers, truncated controls, and controls containing apparent emoji/CSI text in their payloads. Assert exact consumed boundaries; never recursively tokenize a payload.

Public-to-the-module contract (not exported from Ink's public index):

```ts
export type TerminalControl = {
	kind: 'csi' | 'osc' | 'string' | 'esc' | 'c0';
	raw: string;
	end: number; // exclusive source offset
};
export declare function readTerminalControl(
	text: string,
	start: number,
): TerminalControl | undefined;
```

`undefined` means incomplete/invalid when called at a control introducer. The scanner must distinguish ordinary printable text from an invalid control before calling this function.

Concrete test:

```ts
test('OSC payload is one opaque token', t => {
	const raw = '\u001B]8;;https://example.test/🏳️‍♀️\u001B\\';
	const token = readTerminalControl(raw + 'X', 0);
	t.deepEqual(token, {kind: 'osc', raw, end: raw.length});
});
```

- [ ] **Step 2:** Run `env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/terminal-control.ts`; expect failure for the missing module/function.
- [ ] **Step 3:** Move the existing boundary consumers into the shared module and adapt OSC 66 to use them. Keep OSC 66's current fail-open policy, payload limits, grapheme eligibility, caching, and output bytes. Tokenization is shared; seek acceptance is a separate allowlist.
- [ ] **Step 4:** Run the new test plus `test/explicit-width.ts test/log-update-explicit-width.ts` and `npm run typecheck`. Expected: exact legacy encoder assertions stay green.
- [ ] **Step 5 — checkpoint:** Review the extraction for behavior drift. Suggested authorized commit: `refactor: share terminal control token boundaries`.

## Task 2: Prepare bounded, validated seek rows

**Files:**

- Create: `src/allocated-seek.ts`, `test/allocated-seek.ts`.
- Read: `src/terminal-control.ts`, `src/output.ts` / grid allocations, `src/renderer.ts` / selection capture.

- [ ] **Step 1:** Add failing tests for grapheme allocation, styles/links, clipping and unsafe input. Use this internal representation:

```ts
export type SeekPart =
	| {kind: 'control'; raw: string}
	// width is allocated cells, not measured width. Each non-ASCII part is
	// one complete grapheme with width >= 1; ASCII runs may be coalesced.
	| {kind: 'text'; text: string; width: number; ascii: boolean};
export type PreparedSeekRow = {
	logical: string;
	parts: readonly SeekPart[];
	allocatedWidth: number;
};
export declare function prepareSeekRow(
	row: string,
	columns: number,
): PreparedSeekRow;
```

Concrete cases:

```ts
test('clipping keeps logical text and drops a crossing grapheme whole', t => {
	const result = prepareSeekRow('1234567界', 8);
	t.is(result.logical, '1234567界');
	t.is(result.allocatedWidth, 7);
	t.is(
		result.parts
			.filter(p => p.kind === 'text')
			.map(p => p.text)
			.join(''),
		'1234567',
	);
});

test('cursor motion is rejected before painting', t => {
	t.throws(() => prepareSeekRow('ok\u001B[2Aunsafe', 20));
});

test('standalone zero-width graphemes retain their grid allocation', t => {
	for (const row of ['\u0301X', '\uFE0FX', '\u200BX']) {
		const result = prepareSeekRow(row, 8);
		t.is(result.logical, row);
		t.is(result.allocatedWidth, 2);
	}
	const result = prepareSeekRow('A\u200BX', 8);
	t.is(result.allocatedWidth, 3);
	t.is(prepareSeekRow('e\u0301', 8).allocatedWidth, 1);
	t.is(prepareSeekRow('', 8).allocatedWidth, 0);
});
```

- [ ] **Step 2:** Run `env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/allocated-seek.ts`; expect the new API to fail until implemented.
- [ ] **Step 3:** Implement two-pass row preparation. First tokenize the **entire** row, allow only SGR and OSC 8, and validate well-formed printable text. Build a control-free text/offset map, segment it with `Intl.Segmenter`, then ensure SGR/link boundaries fall between graphemes. Reject a control boundary inside a grapheme in this version, as the spec permits. Only after full validation build clipped parts with `Math.max(1, stringWidth(grapheme))` for every nonempty grapheme, matching `Output`'s current grid allocation. Sum those allocated widths for ASCII runs and `allocatedWidth`; use them for clipping, prefill, cursor correction, and trailing erasure. Reject unsupported controls even in the clipped tail. Stop printing at the first crossing grapheme, not at an arbitrary code unit.
- [ ] **Step 4:** Cover BEL/ST links, C1 equivalents, combining text, ZWJ, VS15/VS16, format-only text, malformed UTF-16, CR/BS/TAB, OSC 52/66, DCS, and malformed sequences. SGR/link tokens and empty rows contribute no cells; empty wide-cell placeholders are not independent graphemes. Standalone zero-width graphemes each retain their one-cell grid allocation and use the normal non-ASCII writer. Keep attached marks/selectors/ZWJ inside their existing grapheme without seeking or allocating per code point. Add tests using real `Output.get({paint, capturePlainRows: true})` rows to compare prepared columns with grid cells and preserve plain rows/selection masks; do not use only hand-authored strings as allocation evidence. Include clipping immediately before and after a standalone zero-width grapheme.
- [ ] **Step 5:** Add style-state propagation for multiline source strings accepted by the logger. Splitting at a newline alone does not establish independently styled rows. During frame preparation compute each row's effective entry SGR and link state; fold that state into the prepared-row identity used by incremental comparison. Reuse cached tokenization/segmentation for unchanged source rows; track rendition effects separately from glyph encoding. A changed prior-row style that changes the next row's entry state must repaint the affected row. Preserve the original logical text separately. Reject cross-row grapheme construction; line breaks are row boundaries.
- [ ] **Step 6:** Run the new suite, Task 1 suites, and typecheck. Expected: malformed rows fail before any stream write, and clipped/normalized paint data does not alter selection text. Suggested authorized commit: `feat: prepare validated allocated seek rows`.

## Task 3: Implement the row writer and reproduce cell-level failures

**Files:**

- Modify: `src/allocated-seek.ts`, `test/allocated-seek.ts`, `package.json` (test dependency only).
- Create: `test/helpers/terminal-model.ts`, `test/allocated-seek-terminal.ts`.
- Modify intentionally: `outer:pnpm-lock.yaml` — only the `packages/ink` development dependency and its required package entry.

- [ ] **Step 1:** Add the pinned model dependency from the outer workspace:

```sh
pnpm --filter @nuvin/ink add --save-dev --save-exact @xterm/headless@6.0.0
```

Inspect the resulting lock delta against Task 0's saved diff. Do not lose unrelated changes or change `pnpm-workspace.yaml`. In an isolated checkout, install against that checkout's owning workspace; do not create a second nested lockfile.

- [ ] **Step 2:** Create a small terminal helper that awaits xterm's write callback and reads viewport cells using `buffer.active.baseY + row`. Construct test terminals with `allowProposedApi: true` for any inspected experimental APIs. Dispose terminals via `t.teardown`. Do not use the simple scroll-test interpreter as the width oracle; it does not model wide-cell erasure/reflow.

```ts
import headless, {type Terminal as TerminalInstance} from '@xterm/headless';
export const {Terminal} = headless;
export const writeTerminal = (terminal: TerminalInstance, bytes: string) =>
	new Promise<void>(resolve => terminal.write(bytes, resolve));
export const viewportLine = (terminal: TerminalInstance, row: number) =>
	terminal.buffer.active
		.getLine(terminal.buffer.active.baseY + row)!
		.translateToString(false);
```

The pinned package's runtime entry is CommonJS. Keep the default runtime import and separate type-only binding above; a named runtime `Terminal` import fails under native ESM. Import the constructor from this helper in terminal-model tests and verify both AVA loading and the focused test typecheck.

- [ ] **Step 3:** Add failing tests against `encodeSeekRow(prepareSeekRow(...), rowIndex, columns)`. Reproduce `AB` -> `⚡`, where this pinned emulator paints `⚡` one cell but the installed layout allocator assigns two; assert the fixture actually has that disagreement. Verify the second cell is a blank with the intended background, not stale `B`. Test `👩‍👩⚡X`, an exact-width ASCII row, `123456界` at the bottom of an 8-column viewport, and changed middle-row sentinels above/below. Feed Task 2's actual grid output for `\u0301X`, `\uFE0FX`, `\u200BX`, and `A\u200BX` through the encoder: `X` must survive at zero-based columns 1, 1, 1, and 2 respectively. Cover styles/backgrounds, clipping, and attached `e\u0301`; assert intact emitted payloads and unchanged neighboring cells. The pre-correction width-zero loop erases `X` for the leading mark case and shifts it left after `A\u200B`; record that reproduction before verifying the corrected allocation.
- [ ] **Step 4:** Run `env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/allocated-seek-terminal.ts`; expect missing encoder or cell assertions to fail.
- [ ] **Step 5:** Implement the row emitter following this complete loop. It returns bytes only; Task 4 owns frame transactions and cursor suffixes.

```ts
const csi = '\u001B[';
const closeLink = '\u001B]8;;\u001B\\';
const reset = `${closeLink}${csi}0m`;

export function encodeSeekRow(
	prepared: PreparedSeekRow,
	row: number,
	columns: number,
): string {
	let output = `${csi}${row + 1};1H${reset}${csi}2K`;
	let column = 1;
	for (const part of prepared.parts) {
		if (part.kind === 'control') {
			output += part.raw;
			continue;
		}
		if (!part.ascii) {
			output += ' '.repeat(part.width) + `${csi}${column}G` + part.text;
			if (column + part.width <= columns) {
				output += `${csi}${column + part.width}G`;
			}
		} else {
			output += part.text;
		}
		column += part.width;
	}
	output += reset;
	if (column <= columns) output += `${csi}${column}G${csi}K`;
	return output;
}
```

Frame preparation must insert the effective entry-style/link controls into `prepared.parts` before this emitter runs. Every text part has positive allocated width, including standalone graphemes whose measured width is zero; there is no raw zero-width bypass. A row ending at column `N` gets neither `CHA N+1` nor `EL` after its final cell.

- [ ] **Step 6:** Run all allocated-seek and token suites plus typecheck. Assert exact control bytes as well as cells, backgrounds, link IDs where exposed, unchanged adjacent rows, and zero scroll. Validate row/column inputs as positive/in-bounds. Suggested authorized commit: `feat: paint allocated seek rows with styled prefill`.

## Task 4: Integrate a seek branch into the incremental logger

**Files:**

- Modify: `src/log-update.ts` — internal types, `createIncremental`, `willRender`, `repaint`, `clear`, `reset`, `sync`, `done`.
- Create: `src/terminal-paint.ts`, `test/log-update-allocated-seek.ts`.
- Regression tests: `test/log-update.tsx`, `test/log-update-explicit-width.ts`, `test/log-update-scroll-region.ts`.

- [ ] **Step 1:** Add internal context and physical-state types. These do not enter `src/index.ts` or the public `RenderOptions` API.

```ts
export type PaintContext = {
	strategy: 'raw' | 'osc66' | 'seek-viewport';
	columns: number;
	rows: number;
};
export type PhysicalFrame = {
	context: PaintContext;
	ownsViewport: boolean;
	valid: boolean;
	logicalRows: readonly string[];
	allocatedWidths: readonly number[];
	cursor: {x: number; y: number} | undefined;
};
```

Extend only the internal `LogUpdate` API with optional context arguments for call/repaint/willRender, `getPhysicalFrame()`, and idempotent `restoreTerminalModes()`. Preserve existing call sites by keeping new arguments optional. `createStandard` accepts the interface additions but never selects seek painting. `sync` may take a matching externally committed physical record; without it, it cannot make a seek viewport valid.

- [ ] **Step 2:** Add failing integration tests using the real logger. A small test fixture:

```ts
const context = {strategy: 'seek-viewport', columns: 8, rows: 3} as const;
const stdout = createStdout(8);
stdout.rows = 3;
const log = logUpdate.create(stdout, {incremental: true, showCursor: true});
log('TOP\n👩‍👩⚡X\n123456界', context);
const before = stdout.getWrites().length;
log('TOP\nchanged\n123456界', context);
const delta = stdout.getWrites().slice(before).join('');
t.true(delta.includes('\u001B[2;1H'));
t.false(delta.includes('TOP'));
t.false(delta.includes('123456界'));
```

Replay both writes into the terminal model. Add identical-frame, cursor-only, same-text/different-dimensions, forced repaint, row-style carry, and unsupported-control-in-last-row cases. Include changed-row transitions to/from Task 3's standalone zero-width fixtures, checking their grid-allocated `X` columns and unchanged adjacent rows. Failure in the last row must not emit earlier rows or acquire DECAWM.

- [ ] **Step 3:** Run `env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/log-update-allocated-seek.ts`; expect the existing logger to ignore the context and fail the new assertions.
- [ ] **Step 4:** Prepare/validate all rows that require preparation before any terminal/mode write. Use per-row prepared identities and carry-state changes to select paint work. First entry, invalid physical state, dimension change and explicit repaint paint all rows. Do not use the scroll-shift branch. Build one frame payload from changed rows plus a clamped absolute cursor suffix. With no active cursor, leave it hidden at `(0, rows - 1)`; cursor-only updates use absolute CUP and visibility controls without erasing, painting or touching DECAWM.
- [ ] **Step 5:** Bracket nonempty paint payloads with `DECAWM off` and `DECAWM on` in one ordered stream write. Set the local mode-owned flag before submission; clear it after successful submission. If submission throws, invalidate physical/diff state, try `DECAWM on` best-effort, clear the flag and rethrow. Existing synchronized-output wrappers remain the owner's responsibility; do not nest a second independent BSU/ESU pair. Make `clear` use `ED 2` plus home only when the logger owns a seek viewport. `done` must never use a relative cursor-return assumption from the legacy path for a seek viewport.
- [ ] **Step 6:** Publish physical/diff state only after actual `stream.write` acceptance. `write() === false` is backpressure, not failure. If a real Writable later reports an error, invalidate the record and surface the error through Ink; a callback must never restore an older frame record. Guard against synchronous reentrant `clear`/`done`/unmount during the write using a generation token. `reset()` only invalidates caches; it does not clear the screen. `sync()` never prepares/encodes/paints rows.
- [ ] **Step 7:** Run the new integration suite and all three logger regression suites. Assert raw and OSC 66 byte output stays unchanged, unchanged seek frames do no segmentation/painting, and shifted seek frames use row diffs without scroll-region commands. Suggested authorized commit: `feat: add fullscreen seek painting to incremental logger`.

## Task 5: Route physical viewport changes at actual write time

**Files:**

- Modify: `src/ink.tsx` — `PendingFrame`, constructor throttled-log callback, `onRender`, `resized`, `renderInteractiveFrame`, `getPhysicalEraseOptions`, `restoreLastOutput`.
- Modify: `src/terminal-paint.ts`.
- Create: `test/allocated-seek-resize.tsx`.
- Regression tests: `test/terminal-resize.tsx`, `test/render.tsx`, `test/write-synchronized.tsx`.

- [ ] **Step 1:** Add layout-size snapshots to each pending dynamic frame. Preserve its ordered Static delta separately; never coalesce Static deltas with dynamic text. Carry the immutable frame/paint request through throttling instead of pairing an old string with mutable current context. Re-read terminal size inside the callback that actually writes. If the snapshot is stale, schedule layout/render and do not advance caches or consume that request's Static delta twice.
- [ ] **Step 2:** Add failing integration tests by stubbing a private `resolvePaintContext(frame)` method on the Ink prototype with Sinon and restoring the stub in teardown; do not add a public test option. Task 6 replaces this stub with real negotiation. Test width shrink/growth, height shrink/growth, identical text after dimension change, resize between scheduling/write, and cancellation of a queued frame. Use `waitUntilRenderFlush()`/observable readiness and controlled timers, not arbitrary sleeps.
- [ ] **Step 3:** Run `env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/allocated-seek-resize.tsx`; expect missing context/physical routing to fail.
- [ ] **Step 4:** In `renderInteractiveFrame`, handle a new or previous seek viewport **before** the existing raw-text reflow/clear-terminal branch. For seek resize/entry emit reset/link-close + `ED 2` + home followed by a full logger repaint at the new size. Never use `ansiEscapes.clearTerminal` here because it includes scrollback clearing on supported terminals. At unchanged size use the logger's physical record; do not classify the original text with `isOutputSoftWrapped`.
- [ ] **Step 5:** Introduce a private `clearPhysicalFrame()` routing method for callers currently combining `log.clear(getPhysicalEraseOptions())`. If the logger owns a seek viewport, clear that viewport without calling `getReflowedLineCount`. Otherwise preserve the existing legacy calculation. Keep `lastOutput`/`lastOutputToRender` as desired logical text, but remove their authority over seek physical geometry. All seek physical flags come from the logger's accepted write record.
- [ ] **Step 6:** Cover leaving seek mode: clear only the previously owned viewport, restore modes, reset both logger and Ink physical state, then invoke the existing legacy path for a smaller/taller frame. Entering seek from inline raw output is allowed only once the new frame owns the full viewport. A height mismatch caused by stale layout must trigger relayout rather than an accidental raw-frame transition.
- [ ] **Step 7:** In the primary-screen model, reproduce hard-line reflow despite DECAWM-off. Seed saved history, resize, then assert exact new viewport cells and preserved history. Assert no `ED 3`, no raw-width-derived relative erase, and no write from a cancelled request. Run new and regression suites plus typecheck. Suggested authorized commit: `fix: track seek viewport state through incremental resize`.

## Task 6: Connect capability settlement and scope selection

**Files:**

- Modify: `src/ink.tsx` — constructor explicit-width setup, `settleExplicitWidth`, frame-context selection.
- Modify: `src/terminal-paint.ts`.
- Create: `test/allocated-seek-auto.tsx`.
- Regression tests: `test/explicit-width-auto.tsx`, `test/explicit-width-detection.ts`, `test/explicit-width-manual.tsx`.

- [ ] **Step 1:** Implement/test the pure selection function with an explicit eligibility input so absent detection is not confused with opt-out:

```ts
export function selectPaintStrategy(input: {
	eligible: boolean;
	capability: 'raw' | 'osc66' | 'fallback';
	incremental: boolean;
	outputHeight: number;
	rows: number;
}): PaintContext['strategy'] {
	if (!input.eligible || input.capability === 'raw') return 'raw';
	if (input.capability === 'osc66') return 'osc66';
	return input.incremental && input.outputHeight === input.rows
		? 'seek-viewport'
		: 'raw';
}
```

The constructor preserves current option/environment precedence and force-on eligibility. `raw` here includes explicit disable; `fallback` means allowed but OSC 66 was not confirmed. Pending detection still gates writes through the existing pending/reserved-frame mechanism.

- [ ] **Step 2:** Add integration tests modeled on `test/explicit-width-auto.tsx` using its real Readable input pattern. Render `<Box height={rows} flexDirection="column">...</Box>`, with explicit `stdout.rows` and columns. Cover same-position unsupported replies, timeout, unreadable/missing input capability, and success. Include standard, inline, taller-than-viewport, debug, screen reader, non-TTY, disabled/env-off, force-on and externally entered alternate-screen cases.
- [ ] **Step 3:** Run `env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/allocated-seek-auto.tsx`; expect failed negotiation to remain raw until the new selection is connected.
- [ ] **Step 4:** Store settled capability separately from the OSC 66 transform. A failed probe enables fallback eligibility, not an unconditional seek encoder. `settleExplicitWidth(false)` replays the reservation through current frame selection; eligible no-probe input setups select fallback without constructing a detector. Do not query again or add another input listener. Force-on and successful negotiation continue using `createExplicitWidthEncoder()` only.
- [ ] **Step 5:** Replace Task 5's test-only eligibility wiring with actual failure/timeout negotiation. Verify preserved reservation and newer pending frames appear in order, Static deltas remain exactly once, late responses cannot change the settled strategy, and no strategy is installed after teardown. Readiness waits include settlement just as they do today.
- [ ] **Step 6:** Run new auto/resize tests and all existing explicit-width suites; typecheck. Suggested authorized commit: `feat: select seek fallback for fullscreen incremental frames`.

## Task 7: Preserve ordinary output and Static ordering

**Files:**

- Modify: `src/ink.tsx` — `writeToStdout`, `writeToStderr`, `renderInteractiveFrame` Static branch, direct full-static replay, `restoreLastOutput`, public `clear`.
- Create: `test/allocated-seek-output.tsx`.
- Regression tests: `test/render.tsx`, `test/hooks.tsx`, `test/explicit-width-auto.tsx`.

- [ ] **Step 1:** Add failing tests using `useStdout`, `useStderr`, patched console and `<Static>`. Interleave Static additions with a pending frame, ordinary output, resize and restoration. Validate the actual output stream in a terminal model, not just substring presence. Use shared terminal output ordering for stdout/stderr where they address the same terminal.
- [ ] **Step 2:** Test that messages longer than the viewport wrap with DECAWM enabled and that their text remains in primary-screen history after restoring a seek frame. Match the spec's deliberate `rows` CRLF spacer cost; record that extra blank history lines are accepted. In an alternate screen the messages remain disposable. Test the same paths with fallback ineligible to protect their existing behavior.
- [ ] **Step 3:** Run `env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/allocated-seek-output.tsx`; expect legacy relative-clear or home-overwrite failures.
- [ ] **Step 4:** Route clearing through Task 5's `clearPhysicalFrame`. Emit ordinary and Static bytes through the existing raw/OSC 66 policy with normal autowrap. For a subsequent seek restoration after actual ordinary/Static output, emit exactly `currentRows` CRLFs before absolute home/repaint. Do not add this spacer to every changed frame, cursor-only update, resize repaint, or a clear with no external output. Restore using a fresh eligible context; resize during external output must schedule a current layout.
- [ ] **Step 5:** Remove seek-mode bypasses through `transformOutput(fullStaticOutput + dynamicOutput)`. Preserve exactly-once Static deltas and their raw text ledger. Do not replay old Static history on every resize. `restoreLastOutput` must use the same prepared row writer and re-establish physical metadata; it cannot `sync` a frame it did not paint.
- [ ] **Step 6:** Verify public `clear`, restoration, synchronous external-write exceptions, and messages arriving during negotiation. A handled external failure cannot leave autowrap off; an unhandled output failure exits through the normal error lifecycle without pretending restoration succeeded. Run new and regression suites plus typecheck. Suggested authorized commit: `fix: preserve external output around seek viewport restoration`.

## Task 8: Finish teardown and failure ownership

**Files:**

- Modify: `src/ink.tsx` — `unmount`, `finishUnmount`, `waitUntilRenderFlush`, output-error handling, final-render scheduling.
- Modify: `src/log-update.ts` — transaction restore, `done`, error invalidation.
- Create: `test/allocated-seek-lifecycle.tsx`.
- Regression tests: `test/exit.tsx`, `test/errors.tsx`, `test/write-synchronized.tsx`, `test/explicit-width-auto.tsx`.

- [ ] **Step 1:** Add failing tests with real Writable fixtures for: throw during frame submission; return false/backpressure followed by success; async write error; synchronous reentrant unmount from `write`; repeated `clear`/`done`; destroyed stdout; process-exit cleanup; and deferred negotiation cancellation during unmount.
- [ ] **Step 2:** Test that the controlled final render may occur during `isUnmounting`, while no new frame can start after `isUnmounted`. An already acquired mode must still be restored after `isUnmounted` was set. Test both Ink-managed alternate-screen teardown and an external alternate-screen owner; never add an unsolicited screen exit for the latter.
- [ ] **Step 3:** Run `env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/allocated-seek-lifecycle.tsx`; expect incomplete teardown/error routing to fail.
- [ ] **Step 4:** Call `log.restoreTerminalModes()` at cleanup boundaries before diagnostics and before yielding terminal ownership. Only restore if the logger marked the mode acquired or a failed frame may have interrupted it; unchanged/raw/OSC 66 instances should emit no new mode controls. Finish seek cursor positioning/cache teardown before Ink exits its alternate screen: after the screen switch, no seek `done()` path may reposition or erase the returned primary screen. An external alternate-screen owner still controls its own switch. Keep final flush-before-cleanup ordering and normal console restoration. Guard the write-commit generation so a reentrant teardown cannot resurrect physical state.
- [ ] **Step 5:** Ensure pending output is either accepted in order or cancelled before exit. Preserve `waitUntilRenderFlush()`'s existing stream barrier; surface write errors through the normal exit promise rather than hanging the barrier. An asynchronous seek-write error must mark the mode potentially interrupted and attempt autowrap restoration while writable even if synchronous submission had already returned. Remove any new stream listeners on unmount. Document accepted-write metadata versus confirmed-flush evidence: a queued successful `write` can establish the next ordered diff base, but an async error invalidates it; it is not proof that a terminal displayed the frame.
- [ ] **Step 6:** Run the new lifecycle suite and regression suites with typecheck. Suggested authorized commit: `fix: restore seek terminal state across output failures and exit`.

## Task 9: Validate the integrated change and document its scope

**Files:**

- Modify: `readme.md` — explicit-width/fallback section near current `INK_EXPLICIT_WIDTH` documentation.
- Modify: `src/render.ts` / `explicitWidth` and incremental-rendering documentation comments only if needed to describe the bounded fallback.
- Update: `docs/superpowers/reports/2026-09-07-allocated-cursor-seek-fallback-verification.md`.
- Consumer verification only: `outer:packages/ink-input`, `outer:packages/cli`.

- [ ] **Step 1:** Document fullscreen/incremental eligibility, inline/Static/raw exclusions, unchanged force-on/off precedence, incomplete-glyph/native-copy limits, scroll-optimization tradeoff, and extra blank history around external output. Do not describe Warp/Terminal.app as verified before Task 10.
- [ ] **Step 2:** Run the focused integrated suites from nested Ink:

```sh
env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava test/terminal-control.ts test/allocated-seek.ts test/allocated-seek-terminal.ts test/log-update-allocated-seek.ts test/allocated-seek-resize.tsx test/allocated-seek-auto.tsx test/allocated-seek-output.tsx test/allocated-seek-lifecycle.tsx test/explicit-width.ts test/explicit-width-detection.ts test/explicit-width-auto.tsx test/explicit-width-manual.tsx test/log-update-explicit-width.ts test/log-update.tsx test/log-update-scroll-region.ts
npm run typecheck
npm run build
```

Expected: all change-owned suites pass; report exact counts/exit codes. Do not mistake an AVA known-failure annotation for a new passing regression.

- [ ] **Step 3:** Typecheck new test files using the focused temporary config below. The source build excludes `test`, so it cannot establish test TypeScript correctness. Run scoped Prettier and XO over owned files, then the full nested AVA suite once. If XO cannot start, record the tooling error rather than claiming lint passed.

Run from nested Ink; the exclusive create avoids overwriting an existing file:

```sh
node --input-type=module <<'JS'
import {writeFileSync, unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const config = 'test/tsconfig.allocated-seek-check.json';
const include = [
  'terminal-control.ts', 'allocated-seek.ts', 'allocated-seek-terminal.ts',
  'helpers/terminal-model.ts', 'log-update-allocated-seek.ts',
  'allocated-seek-resize.tsx', 'allocated-seek-auto.tsx',
  'allocated-seek-output.tsx', 'allocated-seek-lifecycle.tsx',
];
writeFileSync(config, JSON.stringify({
  extends: './tsconfig.json', compilerOptions: {noEmit: true}, include,
}), {flag: 'wx'});
try {
  const result = spawnSync('npm', ['exec', '--', 'tsc', '-p', config], {stdio: 'inherit'});
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(config);
}
JS
```

```sh
npm exec -- prettier --check src/terminal-control.ts src/allocated-seek.ts src/terminal-paint.ts src/explicit-width.ts src/log-update.ts src/ink.tsx test/terminal-control.ts test/allocated-seek.ts test/allocated-seek-terminal.ts test/helpers/terminal-model.ts test/log-update-allocated-seek.ts test/allocated-seek-resize.tsx test/allocated-seek-auto.tsx test/allocated-seek-output.tsx test/allocated-seek-lifecycle.tsx
npm exec -- xo src/terminal-control.ts src/allocated-seek.ts src/terminal-paint.ts src/explicit-width.ts src/log-update.ts src/ink.tsx test/terminal-control.ts test/allocated-seek.ts test/allocated-seek-terminal.ts test/helpers/terminal-model.ts test/log-update-allocated-seek.ts test/allocated-seek-resize.tsx test/allocated-seek-auto.tsx test/allocated-seek-output.tsx test/allocated-seek-lifecycle.tsx
env NODE_ENV=test FORCE_COLOR=1 npm exec -- ava
```

- [ ] **Step 4:** Verify the rebuilt local consumer resolution again. At the outer root:

```sh
pnpm --filter @nuvin/nuvin-code exec node --input-type=module -e 'console.log(import.meta.resolve("ink"))'
pnpm --filter @nuvin/ink-input test
pnpm --filter @nuvin/nuvin-code exec vitest run src/root.test.ts src/root-boot.test.ts src/components/MessageList.test.tsx src/components/MessageList.sticky-bottom-flash.test.tsx src/components/RemoteSession.test.tsx
pnpm --filter @nuvin/nuvin-code build
```

Expected: tests run against the rebuilt execution checkout, not stale/published Ink. Build missing upstream artifacts only if diagnosed. Do not regenerate unrelated lock entries or switch dependency mode as a testing shortcut.

- [ ] **Step 5:** Record deterministic work counters: identical frame = zero row encoding, cursor-only = zero row encoding, one changed row = one row paint (plus any actual inherited-style dependents), resize = full viewport. Record raw/seek byte counts for one realistic fullscreen frame; the extra seeks/prefill and disabled scroll optimization are intentional costs, not a performance claim. Preserve unchanged-row skipping.
- [ ] **Step 6:** Review the complete diff against the spec and the scope matrix below. Recheck `git diff --check` in both repositories and compare lock/workspace deltas with the saved baseline. Update the report with source/consumer results and Task 10 still pending. Suggested authorized commit: `docs: document and verify fullscreen incremental seek fallback`.

## Task 10: Run the physical terminal gate

**Files:**

- Create: `examples/allocated-seek/index.tsx` — a foreground-only Ink fixture using the actual implementation.
- Update: `docs/superpowers/reports/2026-09-07-allocated-cursor-seek-fallback-verification.md`.

- [ ] **Step 1:** Build a small fullscreen fixture with `useWindowSize`, `Box height={rows}`, `Text`, `useInput`, `useStdout`, and `useStderr`. Use `incrementalRendering: true`, `patchConsole: true`, `exitOnCtrlC: false`, and either Ink-managed alternate screen or an explicit externally managed case. Include `🏳️‍♀️`, `👩‍👩⚡X`, VS15/VS16, colored allocation blanks, ASCII neighbors, and a right-edge/bottom-right sentinel. Put output controls outside rendered text.
- [ ] **Step 2:** Provide keys: `n` changes one middle row; `f` changes the full frame; `o` emits a long stdout message; `e` emits a long stderr message; `i` switches inline/fullscreen; `q` exits. Use real terminal resize for geometry changes. Guard stdout/stdin TTY presence before starting; a piped invocation must refuse clearly without terminal controls. Do not force OSC 66 for Warp/Terminal.app.
- [ ] **Step 3:** Verify fixture syntax/build and refusal in a non-TTY tool run. Foreground command from nested Ink:

```sh
env -u INK_EXPLICIT_WIDTH NODE_NO_WARNINGS=1 node --import=tsx examples/allocated-seek/index.tsx
```

Also run `INK_EXPLICIT_WIDTH=0` as the control. On Kitty, compare automatic operation with `INK_EXPLICIT_WIDTH=1` only if needed to isolate negotiation. Never inject the diagnostic into an already-running TUI's input stream.

- [ ] **Step 4:** Run the fixture and actual Nuvin Shell in Warp, Terminal.app and Kitty. Confirm Shell output height equals viewport rows so the intended fallback really activates. Record terminal/version, mode, first paint, one-row streaming update, right/bottom edges, backgrounds, resize in both directions, output/history, inline transition and exit. Where CPR works, use it as additional evidence; lack of private CPR is not itself failure.
- [ ] **Step 5:** Check Ink-managed selection/copy in actual Nuvin. Record native terminal copy separately. Capture screenshots or concrete observations for the original tool-card case. Glyph fragmentation is allowed; neighbor damage or unintended row movement is failure.
- [ ] **Step 6 — completion gate:** If a target fails, keep default shipping blocked, reproduce it, correct the affected task with a regression, and rerun that terminal case. If the physical terminals are inaccessible, finish all authorized source work and mark physical acceptance **pending**, not passed. Do not invent a terminal whitelist or claim the OSC 66 failure probe establishes support. No publish/release action is part of this plan.

## Final coverage checklist

| Required behavior                                  | Primary tasks |
| -------------------------------------------------- | ------------- |
| Single layout; intact source and copy              | 2, 3, 9, 10   |
| Narrow glyph gaps and same-row spill               | 3, 4          |
| Right margin and bottom-right cell                 | 3, 4, 10      |
| First paint and changed rows share writer          | 4             |
| No encoding on unchanged/cursor-only/cache priming | 4, 9          |
| Style/link continuity and unsafe-control rejection | 1, 2, 4       |
| Width/height changes and primary-screen reflow     | 5, 10         |
| Physical metadata follows actual writes            | 4, 5, 8       |
| Fullscreen entry/exit and raw/OSC exclusions       | 5, 6          |
| Probe settlement/reservation/input ownership       | 6, 8          |
| Ordinary output and Static exactly once            | 7             |
| Autowrap restoration and screen ownership          | 4, 7, 8       |
| Existing OSC 66 and consumers remain valid         | 1, 6, 9, 10   |
| Warp/Terminal.app physical compatibility           | 10            |

## Planning verification

This plan was checked against current source entry points, existing test helpers,
workspace dependency ownership, and the reviewed spec. The commands above are
execution instructions; they have not been run as implementation verification
by writing this document. No production code is changed by this planning task.

Review corrections were checked separately: the revised resolution command
resolved the local Ink build, extracted helper/emitter snippets passed the test
TypeScript configuration, and eight temporary checks using actual `Output`
rows and xterm 6.0.0 preserved expected columns and adjacent rows. Those checks
used a plain-text preparation harness; they do not establish completion of
the planned styled-row parser, logger integration, or physical terminal gate.
