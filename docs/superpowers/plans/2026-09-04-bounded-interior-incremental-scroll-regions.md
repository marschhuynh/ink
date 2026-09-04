# Bounded Interior Incremental Scroll Regions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve fast `CSI M/L` scrolling while constraining each optimized vertical shift to its detected content band so MessageList, Composer, ToolDetailModal, and surrounding terminal rows never move in intermediate terminal states.

**Architecture:** Extend Ink's private shift descriptor with an exclusive `end` row, simulate and emit the shift only inside `[start, end)`, and wrap `CSI M/L` with DECSTBM set/reset plus explicit absolute cursor positioning. Commit only the nested Ink behavior; before publication, exercise the real outer UI through ignored local validation artifacts against built `link:packages/ink`, then promote those fixtures to tracked tests during the later publish/pin task.

**Tech Stack:** TypeScript, React 19, Ink fork, AVA, tsx, pnpm, npm, ANSI/VT control sequences, DECSTBM.

## Global Constraints

- Preserve `CSI M/L` for qualifying vertical shifts; do not replace optimized scrolling with full positional redraws.
- Rows `[0, start)` and `[end, height)` must remain physically unchanged throughout every optimized write.
- Correctness must not depend on synchronized-output mode 2026.
- Every installed DECSTBM region must be reset in the same buffered `log-update` write.
- Keep `NUVIN_INK_NO_SCROLL_OPT=1` as the tested operational fallback.
- Reject optimization when cursor, trailing-newline, height, cache, threshold, prefix/suffix, or region-boundary guards are uncertain.
- No public Ink, MessageList, Composer, ScrollBox, ToolDetailModal, or renderer API changes.
- No horizontal-scroll optimization, generalized LCS diff, or multiple-region update support.
- Preserve VLBox layout/culling/sticky/selection/accessibility behavior and all incremental-rendering state-repair contracts.
- Nested Ink is a standalone npm/AVA/XO repository; outer nuvin-agent is a pnpm/Vitest repository whose consumers test built Ink output through the existing local `link:packages/ink` override.
- Commit this plan and the revised design as documentation-only nested changes before implementation begins; preserve the existing untracked `docs/superpowers/handoffs/` directory throughout execution.
- Do not commit outer regressions that require unpublished `@nuvin/ink@7.6.0-alpha`; keep pre-publication outer validators under ignored `.superpowers/sdd/`.
- Do not modify or stage unrelated outer Memory/tool-preview files, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, other design files, or nested `docs/superpowers/handoffs/`.
- Do not publish, query the registry, update package pins, add changesets, tag, push, merge, or switch away from local Ink mode.
- Use red-green TDD. Fix and review subagents run at powerful tier; every task receives an independent powerful-tier specification and quality review.

---

## File and repository ownership

### Nested Ink repository (`packages/ink`)

- Modify `src/log-update.ts` — bounded shift detection, DECSTBM emission, and bounded cache simulation.
- Modify `test/log-update-scroll-region.ts` — DECSTBM/CUP terminal model, intermediate snapshots, cursor state, up/down/full-frame/fallback/cache tests.
- Modify `test/render.tsx` only if a production Ink fullscreen-framing regression cannot be expressed through `log-update` tests.

### Outer nuvin-agent repository — ignored validation only

- Create `.superpowers/sdd/bounded-scroll-validation/terminal-screen.ts` — test-only ANSI/VT cell model.
- Create `.superpowers/sdd/bounded-scroll-validation/incremental-harness.tsx` — production interactive Ink fake-TTY harness.
- Create `.superpowers/sdd/bounded-scroll-validation/message-list-composer.tsx` — real MessageList + Composer validator.
- Create `.superpowers/sdd/bounded-scroll-validation/tool-detail-modal.tsx` — real ToolDetailModal validator.
- Create `.superpowers/sdd/bounded-scroll-validation/report.md` — exact commands, final/intermediate parity, byte counts, timings, and promotion handoff.
- Do not modify or commit tracked outer files in this plan.

---

## Pre-execution documentation commit gate

**Repository:** nested `packages/ink`

Complete this gate once, before invoking the implementation workflow or recording `NESTED_BASE` in Task 1. From the outer root:

```bash
git -C packages/ink status --short --branch
git -C packages/ink add -- \
  docs/superpowers/specs/2026-09-04-bounded-interior-incremental-scroll-regions-design.md \
  docs/superpowers/plans/2026-09-04-bounded-interior-incremental-scroll-regions.md
staged="$(git -C packages/ink diff --cached --name-only)"
expected="$(printf '%s\n%s' \
  docs/superpowers/plans/2026-09-04-bounded-interior-incremental-scroll-regions.md \
  docs/superpowers/specs/2026-09-04-bounded-interior-incremental-scroll-regions-design.md)"
test "$staged" = "$expected"
git -C packages/ink commit -m "docs: finalize bounded scroll implementation plan"
git -C packages/ink status --short --branch
```

Expected: the commit contains exactly the revised design and this plan; `docs/superpowers/handoffs/` remains untracked, outer files remain unstaged, and Task 1 records the resulting documentation commit as `NESTED_BASE`.

---

### Task 1: Implement bounded Ink line shifts

**Repository:** nested `packages/ink`

**Files:**

- Modify: `src/log-update.ts:50-158,411-501`
- Modify: `test/log-update-scroll-region.ts:1-315`
- Optional modify: `test/render.tsx` only for a production-framing assertion not owned by `log-update`

**Interfaces:**

- Consumes: existing `LogUpdate`, `detectScrollShift`, cursor helpers, `previousLines`, `previousOutput`, and `visibleLineCount`.
- Produces: private `ScrollShift = {rows: number; start: number; end: number}` and a margin-bounded incremental write whose terminal/cache state matches the next logical frame.

- [ ] **Step 1: Record repository bases and same-machine performance baseline**

From the outer root:

```bash
mkdir -p packages/ink/.superpowers/sdd .superpowers/sdd/bounded-scroll-validation
printf 'NESTED_BASE=%s\nOUTER_BASE=%s\n' \
  "$(git -C packages/ink rev-parse HEAD)" \
  "$(git rev-parse HEAD)" \
  > packages/ink/.superpowers/sdd/bounded-scroll-bases.env
corepack pnpm benchmark:vlbox-tool-detail -- --samples 30 --release-check \
  > packages/ink/.superpowers/sdd/bounded-scroll-modal-baseline.txt
```

Expected: the baseline command exits 0 and records at least 30 samples. Do not run `benchmark:vl-scroll:real` as the byte oracle because its current tracked script omits `interactive: true`; the ignored real-surface harness in Task 2 is explicitly interactive, and the tracked benchmark correction is deferred to the publish/pin follow-up.

Run Steps 2–11 with `packages/ink` as the working directory. Every `npm`, `npm exec`, `git`, and path below is therefore scoped to the standalone nested repository.

- [ ] **Step 2: Extend the nested terminal-cell model before production changes**

Replace the scalar CSI parser with semicolon-aware parsing and expose cursor/margin state:

```ts
type TerminalSnapshot = {
	rows: string[];
	cursorRow: number;
	cursorColumn: number;
	scrollTop: number;
	scrollBottom: number;
	command: string;
};

type TerminalResult = {
	rows: string[];
	cursorRow: number;
	cursorColumn: number;
	scrollTop: number;
	scrollBottom: number;
	snapshots: TerminalSnapshot[];
};
```

Scan through the complete CSI parameter/intermediate range until the final byte (`0x40..0x7e`), rather than stopping at the first non-digit:

```ts
let commandIndex = index + 2;
while (commandIndex < write.length) {
	const code = write.codePointAt(commandIndex);
	if (code !== undefined && code >= 0x40 && code <= 0x7e) break;
	commandIndex++;
}
if (commandIndex >= write.length)
	throw new Error(`Unterminated CSI at ${index}`);

const parameterBytes = write.slice(index + 2, commandIndex);
const privatePrefix = /^[<=>?]/.exec(parameterBytes)?.[0];
const numericBytes = privatePrefix ? parameterBytes.slice(1) : parameterBytes;
const parameters = numericBytes
	.split(';')
	.map(value => (value === '' ? undefined : Number(value)));
```

Implement `A`, `E`, `G`, `H`, `K`, `L`, `M`, and `r`. DECSTBM set and reset both home the modeled cursor to row 0, column 0. `L/M` mutate only `[cursorRow, scrollBottom]` when the cursor is inside the active margins. Record snapshots after margin, line, erase, cursor, text-run, and newline mutations. Throw on unterminated or unsupported CSI instead of silently accepting it.

Before the production change, directly apply `CSI 2;9r`, `CSI 2;1H`, and `CSI r` to the model and assert parsed margins `(1, 8)`, parsed cursor `(1, 0)`, reset margins `(0, height - 1)`, and reset cursor `(0, 0)`. These parser assertions must pass independently of the red bounded-scroll renderer tests.

- [ ] **Step 3: Add failing multi-row-footer regressions**

Add:

```ts
test('incremental scroll region - bounded shift up never moves footer rows', t => {});
test('incremental scroll region - bounded shift down never moves footer rows', t => {});
```

Use 11 fullscreen rows:

```ts
const previous = [
	'HEAD',
	'b1',
	'b2',
	'b3',
	'b4',
	'b5',
	'b6',
	'b7',
	'b8',
	'COMPOSER STATUS',
	'COMPOSER INPUT',
];
const nextUp = [
	'HEAD',
	'b2',
	'b3',
	'b4',
	'b5',
	'b6',
	'b7',
	'b8',
	'b9',
	'COMPOSER STATUS',
	'COMPOSER INPUT',
];
const nextDown = [
	'HEAD',
	'b0',
	'b1',
	'b2',
	'b3',
	'b4',
	'b5',
	'b6',
	'b7',
	'COMPOSER STATUS',
	'COMPOSER INPUT',
];
```

Require:

```ts
const operation =
	direction === 'up'
		? '\u001B[2;9r\u001B[2;1H\u001B[1M\u001B[r\u001B[2;1H'
		: '\u001B[2;9r\u001B[2;1H\u001B[1L\u001B[r\u001B[2;1H';
t.true(write.includes(operation)); // exact set → CUP → IL/DL → reset → CUP order
t.is(write.split('\u001B[2;9r').length - 1, 1);
t.is(write.split('\u001B[r').length - 1, 1);
t.false(write.includes('COMPOSER STATUS'));
t.false(write.includes('COMPOSER INPUT'));
for (const snapshot of result.snapshots) {
	t.deepEqual(snapshot.rows.slice(9, 11), previous.slice(9, 11));
}
t.deepEqual(result.rows.slice(0, 11), nextFrame);
t.is(result.scrollTop, 0);
t.is(result.scrollBottom, 10);
t.is(result.cursorRow, 10);
t.is(result.cursorColumn, 0);
```

Also assert that stable shifted-core sentinels are absent from `write` and that `Buffer.byteLength(write, 'utf8')` is below the corresponding escape-hatch positional write for the same frames.

- [ ] **Step 4: Run the focused tests and verify RED**

```bash
NODE_ENV=test npm exec -- ava test/log-update-scroll-region.ts \
  --match='incremental scroll region - bounded shift*never moves footer rows'
```

Expected: 2 failures because current writes contain unbounded `CSI M/L`, no `CSI 2;9r`, and at least one intermediate snapshot moves or blanks a composer row.

- [ ] **Step 5: Add bounded shift metadata**

Change the private type:

```ts
type ScrollShift = {
	rows: number;
	start: number;
	end: number;
};
```

Add:

```ts
const suffixUnchanged = (
	previousLines: string[],
	nextLines: string[],
	end: number,
): boolean => {
	for (let index = end; index < nextLines.length; index++) {
		if (nextLines[index] !== previousLines[index]) return false;
	}
	return true;
};
```

For upward candidates, derive `end = upLast + rows + 1`. For downward candidates, derive `start = downFirst - rows` and `end = downLast + 1`.

Accept only when:

```ts
start >= 0 &&
	end <= height &&
	end - start > rows &&
	prefixUnchanged(previousLines, nextLines, start) &&
	suffixUnchanged(previousLines, nextLines, end);
```

Return `{rows, start, end}` or `{rows: -rows, start, end}`. Preserve smallest shift, exact ANSI line equality, total matched-core ratio, and the existing first-to-last evidence-span threshold. In-band mismatching holes remain allowed and are repaired by the ordinary diff; prefix and suffix equality provide the safety boundary.

- [ ] **Step 6: Emit DECSTBM-bounded `CSI M/L`**

Add private helpers:

```ts
const setScrollRegion = (start: number, end: number): string =>
	`\u001B[${start + 1};${end}r`;
const resetScrollRegion = '\u001B[r';
const cursorToRow = (row: number): string => `\u001B[${row + 1};1H`;
```

For an accepted shift, append exactly:

```ts
const {start, end} = shift;
buffer.push(
	setScrollRegion(start, end),
	cursorToRow(start),
	shift.rows > 0 ? `\u001B[${k}M` : `\u001B[${k}L`,
	resetScrollRegion,
	cursorToRow(start),
);
```

Do not depend on the pre-DECSTBM cursor because setting/resetting margins may home it. Keep set, mutation, reset, edge repair, and cursor suffix in the existing single buffered `stream.write()`.

- [ ] **Step 7: Simulate only the bounded cache band**

Use:

```ts
const prefix = prevVisible.slice(0, start);
const band = prevVisible.slice(start, end);
const suffix = prevVisible.slice(end);
const shiftedBand =
	shift.rows > 0
		? [...band.slice(k), ...blankLines(k)]
		: [...blankLines(k), ...band.slice(0, band.length - k)];
const shiftedPrevious = [...prefix, ...shiftedBand, ...suffix];
```

Set `diffPrevious = shiftedPrevious` and `loopStart = start`. The ordinary diff repairs exposed edge rows and genuine in-band differences; unchanged suffix rows are not retransmitted.

- [ ] **Step 8: Run the focused tests and verify GREEN**

```bash
NODE_ENV=test npm exec -- ava test/log-update-scroll-region.ts \
  --match='incremental scroll region - bounded shift*never moves footer rows'
```

Expected: 2 tests pass; both composer rows remain unchanged in every intermediate snapshot; final rows and cursor baseline match; margins are reset.

- [ ] **Step 9: Cover changed chrome, full-frame shifts, cache, and cursor follow-up**

Add:

```ts
test('incremental scroll region - changed footer rejects an unsafe bounded shift', t => {});
test('incremental scroll region - full-frame shift keeps optimized bounded bytes', t => {});
test('incremental scroll region - bounded shift cache remains surgical on the next update', t => {});
test('incremental scroll region - bounded shift preserves a later committed cursor', t => {});
test('incremental scroll region - every installed margin resets in the same write', t => {});
```

Apply all writes sequentially to one terminal model. The third-frame cache test must change one known body row, assert only that row's text is transmitted, assert that physical row changes, and assert `cursorRow === height - 1` afterward. The committed-cursor test must call `setCursorPosition({x: 3, y: 4})` before a later single-line update and assert final modeled cursor row 4, column 3. The changed-footer test must use positional diffing unless a region ending before both footer rows is proven; no intermediate snapshot may move either footer row.

For a six-row whole-frame one-row shift, assert the exact operation substring `\u001B[1;6r\u001B[1;1H\u001B[1M\u001B[r\u001B[1;1H`. For every optimized write, count DECSTBM sets, resets, and `CSI M/L`: require exactly one of each, require set < CUP < mutation < reset < CUP ordering, and require final full-screen margins. Retain explicit negative assertions for `CSI M/L` and DECSTBM on cursor, trailing-newline, height-change, below-threshold, changed-prefix/suffix, cache-reset, and `NUVIN_INK_NO_SCROLL_OPT=1` paths.

- [ ] **Step 10: Run nested focused verification**

```bash
NODE_ENV=test npm exec -- ava \
  test/log-update-scroll-region.ts \
  test/log-update.tsx \
  test/render.tsx \
  test/output-rows.test.ts
npm exec -- xo src/log-update.ts test/log-update-scroll-region.ts
npm run typecheck
npm run build
git diff --check
```

Expected: all commands exit 0. Existing cursor, cache, non-fullscreen, resize, escape-hatch, and non-shift byte contracts remain green.

- [ ] **Step 11: Commit nested Ink behavior**

```bash
git add src/log-update.ts test/log-update-scroll-region.ts
if ! git diff --quiet -- test/render.tsx; then git add test/render.tsx; fi
git commit -m "fix: bound incremental terminal scroll regions"
```

Do not stage `docs/superpowers/handoffs/`.

---

### Task 2: Validate real outer scroll surfaces locally

**Repository:** outer `nuvin-agent`; artifacts are ignored and must not be committed.

**Files:**

- Create: `.superpowers/sdd/bounded-scroll-validation/terminal-screen.ts`
- Create: `.superpowers/sdd/bounded-scroll-validation/incremental-harness.tsx`
- Create: `.superpowers/sdd/bounded-scroll-validation/message-list-composer.tsx`
- Create: `.superpowers/sdd/bounded-scroll-validation/tool-detail-modal.tsx`
- Create: `.superpowers/sdd/bounded-scroll-validation/report.md`

**Interfaces:**

- `TerminalScreen.apply(chunk)` returns snapshots with styled grapheme cell grids, cursor/autowrap state, and margins.
- `renderIncrementalScenario(tree, {columns, rows})` forces `interactive: true`, `debug: false`, `incrementalRendering: true`, captures globally indexed write boundaries, and counts UTF-8 bytes with `Buffer.byteLength`.
- Each validator runs optimized and legacy (`NUVIN_INK_NO_SCROLL_OPT=1`) scenarios sequentially and compares final cell grids.

- [ ] **Step 1: Build nested Ink before any outer consumer run**

```bash
cd packages/ink
npm run build
cd ../..
```

Expected: build exits 0; local linked consumers now load the DECSTBM implementation.

- [ ] **Step 2: Implement and self-test the ignored terminal model**

Port the proven CSI scanner and command subset from Task 1 into `terminal-screen.ts`, then extend it for production frames:

```ts
type CellStyle = {
	foreground?: string;
	background?: string;
	bold: boolean;
	dim: boolean;
	inverse: boolean;
};

type Cell = {
	grapheme: string;
	width: 0 | 1 | 2;
	continuation: boolean;
	style: CellStyle;
};
```

Track cursor row/column, pending autowrap, DECSTBM homing, margin-bounded `L/M`, and the SGR foreground/background/style/reset forms emitted by Ink. Preserve complete cells and attributes through shifts; erase/insert uses the terminal's current erase style. Segment text with `Intl.Segmenter` at grapheme granularity and use the CLI's `string-width` implementation for terminal width. Combining/zero-width input attaches to the preceding grapheme, width-two cells own a continuation cell, and a printable grapheme at the right margin follows terminal delayed-autowrap semantics. Skip OSC payloads and ignore only enumerated non-cell-mutating private modes, including BSU/ESU and cursor visibility; unknown CSI/OSC/private sequences throw.

All frame/protected-row comparisons use full `Cell` grids, including styles and continuation cells. All output-size gates use `Buffer.byteLength(chunk, 'utf8')`, never JavaScript string length.

Add an executable self-test at the bottom guarded by:

```ts
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
	runTerminalScreenSelfTests();
}
```

The self-test must seed a 12×6 screen, run bounded up/down writes, and throw unless both footer rows remain unchanged in every snapshot and margins/cursor finish at expected values. Add direct cases for ANSI foreground/background/reset, a width-two CJK grapheme, an emoji grapheme, a combining sequence, and right-margin delayed autowrap; assert both cells and cursor positions.

Run:

```bash
corepack pnpm --filter @nuvin/nuvin-code exec tsx \
  ../../.superpowers/sdd/bounded-scroll-validation/terminal-screen.ts
```

Expected: prints `terminal-screen: PASS` and exits 0.

- [ ] **Step 3: Implement the production interactive harness**

Before each run, call the same resets as `packages/cli/src/test-utils.tsx`:

```ts
resetInputStore();
resetFocusStore();
resetContextStore();
resetCommandBus();
resetKeymapRegistry();
```

Use EventEmitter-compatible streams typed through `RenderOptions`. Render with:

```tsx
render(<InputSetup>{tree}</InputSetup>, {
	stdout,
	stdin,
	stderr,
	interactive: true,
	debug: false,
	incrementalRendering: true,
	maxFps: 60,
	exitOnCtrlC: false,
	patchConsole: false,
});
```

Expose raw write ranges, terminal snapshots, `stdin.send()`, `waitUntilRenderFlush()`, and cleanup. The stdout `write` must feed every chunk to `TerminalScreen`; do not strip DECSTBM or BSU/ESU before application.

- [ ] **Step 4: Add the real MessageList + Composer validator**

Render a fullscreen `50×20` column containing a shrinking MessageList area and the real Composer. Use `status="idle"` (the current string-union API), `disabled={true}` to prevent cursor blinking during snapshot collection, and fixed `COMPOSER_BOUNDARY_TOP` / `COMPOSER_BOUNDARY_BOTTOM` Text rows immediately around the Composer.

Drive wheel events through `stdin.send()` at a row inside the message viewport until one committed write contains a DECSTBM set, absolute CUP to its start, `CSI M/L`, reset, and the second absolute CUP in that exact order. Record every input event and every stdout chunk with a monotonically increasing global write index. Select one exact qualifying write range; require exactly one set, one mutation, and one reset in it. Derive the complete protected interval from the two boundary sentinels and require the emitted zero-based `[start, end)` to end at or above its top boundary.

For the chosen write:

- replay every stdout chunk with an index before the selected range into a fresh `TerminalScreen`, including chunks caused by earlier nonqualifying wheel attempts;
- clone the screen immediately before the selected range once for optimized bytes and once for a control write with DECSTBM set/reset removed;
- prove the stripped control moves a composer row in an intermediate snapshot;
- prove every optimized snapshot preserves the entire boundary-delimited composer interval;
- assert no transcript marker enters protected rows;
- assert final margins are full-screen and final cursor row/column match the legacy scenario;
- run the escape-hatch scenario sequentially inside `try/finally`, send the identical recorded input sequence, wait for each corresponding logical scroll state, and compare the final styled cell grid after the selected logical event as the independent oracle;
- assert optimized update UTF-8 bytes are at most 50% of legacy update UTF-8 bytes and shifted-core transcript sentinels are absent from the optimized payload.

Run:

```bash
corepack pnpm --filter @nuvin/nuvin-code exec tsx \
  ../../.superpowers/sdd/bounded-scroll-validation/message-list-composer.tsx
```

Expected: prints final parity, protected-row count, optimized/legacy bytes, median step timing, and `message-list-composer: PASS`.

- [ ] **Step 5: Add the real ToolDetailModal validator using current chrome**

Reuse the overflowing Program shape from `packages/cli/src/components/ToolDetailModal.test.tsx:770-800`: a `Program` message with a long source/result and at least one rebased child call so the Calls/Details tabs render. Do not assume modal borders or a `"Tool details"` title. Render `ToolDetailModal open` at `100×30`, wait for the initial Calls view, send Tab to select Details, and identify current fixed chrome by:

- header row containing `Program` plus its status;
- the Calls/Details tab row and its stable surrounding row;
- row containing `CLOSE`;
- footer row containing both `j/k` and `Esc`;
- blank application rows outside the centered panel.

Infer the scrollable Details interval strictly between the tab chrome and CLOSE row. Drive a wheel event inside that interval until one committed write contains exactly one bounded DECSTBM set, one `CSI M/L`, one reset, and the two absolute CUP operations in set → CUP → mutation → reset → CUP order. Require the emitted zero-based `[start, end)` margins to be wholly inside the inferred Details interval.

Record the selected qualifying write by global index and replay every earlier chunk, including Tab and nonqualifying wheel-attempt writes, before testing it. For every optimized snapshot, assert the Program/status header, both tab labels, button row, footer hints, and outside application rows equal their pre-scroll styled cells and contain no source/result sentinel. Assert shifted-core sentinels are absent from the optimized payload. Run the identical recorded Tab-plus-wheel input sequence sequentially with the escape hatch in `try/finally`, stop after the corresponding logical scroll event, compare the complete final styled cell grid as the independent oracle, and require optimized UTF-8 bytes at most 50% of legacy UTF-8 bytes.

Run:

```bash
corepack pnpm --filter @nuvin/nuvin-code exec tsx \
  ../../.superpowers/sdd/bounded-scroll-validation/tool-detail-modal.tsx
```

Expected: prints protected rows, DECSTBM bounds, optimized/legacy bytes, median step timing, and `tool-detail-modal: PASS`.

- [ ] **Step 6: Write the ignored validation report and verify outer scope**

Record exact commands, outputs, byte ratios, timing samples, terminal environments, final parity, and promotion instructions in `.superpowers/sdd/bounded-scroll-validation/report.md`.

```bash
test -s .superpowers/sdd/bounded-scroll-validation/report.md
corepack pnpm exec biome check --vcs-enabled=false --verbose \
  .superpowers/sdd/bounded-scroll-validation/terminal-screen.ts \
  .superpowers/sdd/bounded-scroll-validation/incremental-harness.tsx \
  .superpowers/sdd/bounded-scroll-validation/message-list-composer.tsx \
  .superpowers/sdd/bounded-scroll-validation/tool-detail-modal.tsx
git status --short --branch
git diff --check
```

Expected: Biome's verbose output names and checks all four TypeScript/TSX artifacts despite `.superpowers/` being Git-ignored, and the non-empty report check accounts for the fifth artifact. No new tracked or untracked outer files appear because `.superpowers/sdd/` is ignored; all pre-existing user-owned dirty files remain unchanged and unstaged. Do not commit Task 2 artifacts.

- [ ] **Step 7: Request powerful-tier validation-artifact review**

Provide the reviewer the spec, plan, all five ignored artifact paths, exact validation report, and nested commit package. Require specification-compliance and code-quality verdicts. Fix any Critical or Important finding in the ignored validators or nested source through one powerful-tier fix wave, then re-run only affected validation before re-review.

---

### Task 3: Run final correctness and performance gates

**Repositories:** nested Ink and outer nuvin-agent.

**Files:** verify only; no tracked outer edits.

**Interfaces:**

- Consumes: Task 1 nested commit and Task 2 ignored real-surface evidence.
- Produces: final verification report and review package; no publication or pin changes.

- [ ] **Step 1: Run full nested Ink gates**

```bash
cd packages/ink
NODE_ENV=test npm test
npm run build
npm run benchmark:vlbox -- --samples=30 --release-check
git diff --check
git status --short --branch
```

Expected: full AVA/XO/typecheck, build, release benchmark, visitation limit, and output checkpoints pass. The plan and revised spec were committed before implementation; nested status therefore contains only the preserved pre-existing `?? docs/superpowers/handoffs/` entry (ignored `.superpowers/sdd/` evidence does not appear).

- [ ] **Step 2: Run outer unchanged-source regression gates against built local Ink**

From the outer root:

```bash
corepack pnpm --filter @nuvin/nuvin-code exec vitest run \
  src/components/MessageList.test.tsx \
  src/components/MessageList.sticky-bottom-flash.test.tsx \
  src/components/ComboBox/ScrollBox.test.tsx \
  src/components/ToolDetailModal.test.tsx
corepack pnpm --filter @nuvin/ink-virtualized-list exec vitest run \
  test/wheel-coalescing.test.tsx \
  test/keyboard-scroll.test.tsx
corepack pnpm --filter @nuvin/nuvin-code... build
```

Expected: all named suites and build pass. The sibling VirtualizedList tests run through their owning package configuration.

- [ ] **Step 3: Run outer real performance corroboration**

```bash
corepack pnpm benchmark:vlbox-tool-detail -- --samples 30 --release-check
```

Expected: at least 30 samples, non-zero stdout, and wall median `<= 16 ms`. Compare against `packages/ink/.superpowers/sdd/bounded-scroll-modal-baseline.txt`; report both values without weakening the existing gate.

The deterministic MessageList and modal gates are the Task 2 optimized-versus-legacy comparisons: optimized UTF-8 update bytes `<= 50%` of legacy for each qualifying fixture, shifted-core sentinels absent, and final styled cell grids exactly equal.

- [ ] **Step 4: Verify repository preservation**

```bash
git -C packages/ink status --short --branch
git status --short --branch
git -C packages/ink diff --check
git diff --check
```

Expected: nested behavior commit plus approved docs and preserved handoff only; outer tracked state contains no Task 2 changes. Existing outer Memory/tool-preview, workspace/lock, and design-file changes remain unstaged and untouched.

- [ ] **Step 5: Generate the nested review package with recorded concrete state**

From the outer root:

```bash
source packages/ink/.superpowers/sdd/bounded-scroll-bases.env
NESTED_HEAD="$(git -C packages/ink rev-parse HEAD)"
bash /Users/marsch/.nuvin-code/skills/subagent-driven-development/scripts/review-package \
  "$NESTED_BASE" "$NESTED_HEAD"
```

Expected: the script prints one nested review-package path covering the complete implementation range. There is no outer Task 2 commit or outer review range.

- [ ] **Step 6: Request final powerful-tier whole-change review**

Give the reviewer:

- approved spec and implementation plan;
- Task 1 red/green report and nested full-range package;
- Task 2 ignored terminal model, harness, both validators, and report;
- Task 3 full nested/outer verification and performance evidence;
- the deferred-promotion boundary for outer durable tests.

Require explicit verdicts for specification compliance, code quality, MessageList + Composer intermediate safety, ToolDetailModal intermediate safety, cache/cursor correctness, deterministic byte efficiency, and final `APPROVED` or `CHANGES REQUIRED`. Do not ask the reviewer to rerun evidenced commands.

---

## Deferred publish/pin follow-up — not part of this plan

After explicit user authorization to publish `@nuvin/ink@7.6.0-alpha` and update outer pins:

1. Publish the verified nested package.
2. Switch outer committed dependencies and lockfile atomically to `7.6.0-alpha`.
3. Promote the two ignored validators and terminal model into tracked CLI test utilities/tests.
4. Make `benchmark-virtualized-list.tsx` explicitly pass `interactive: true` and add its deterministic DECSTBM/byte-integrity gate.
5. Run clean-checkout outer tests and build against the published package.
6. Add required changesets, then review and commit that release integration separately.

## Execution notes

- Each implementation task writes an ignored `.superpowers/sdd/task-N-report.md` with exact red/green commands, results, commit SHA when applicable, status, and concerns.
- Generate one review package per nested source task; reviewers run at powerful tier and return both specification and quality verdicts.
- Task 2 has no commit by design. Its ignored artifacts still receive independent review and remain available for the later publish/pin promotion.
- Any Critical or Important finding receives one powerful-tier fix wave containing the complete finding list, followed by focused verification and re-review.
- Do not begin outer validation until nested Ink has been rebuilt after Task 1; outer consumers test built output through local `link:packages/ink`.
- Stop after final approval. Publication, pin changes, changesets, tags, pushes, and merges remain separate user-approved work.
