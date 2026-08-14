# Incremental Rendering State Repair Design

## Context

Ink's incremental renderer correctly avoids rewriting unchanged lines during ordinary updates, but six transitions allow its cached frame or cursor state to diverge from the terminal's physical state:

1. `Ink.clear()` erases the frame and then syncs the erased output back into the diff cache, so the next changed render can skip rows that are no longer visible.
2. Cursor suffix calculations assume the terminal is on an empty row after the output, which is false for fullscreen output without a trailing newline.
3. `cursorDirty` currently determines both whether the cursor changed and whether a committed cursor exists, so a sibling-only rerender hides a still-mounted cursor.
4. A terminal row resize can change `outputToRender` between trailing-newline and fullscreen forms without producing a write.
5. `done()` resets cursor bookkeeping while the physical cursor may still be positioned inside the rendered frame.
6. A terminal column decrease reflows already-painted logical lines into more physical rows before Ink handles `resize`; the eager `log.clear()` erases only the cached logical-line count, leaving stale rows outside the new cache. Later renders cannot remove those rows and make the stale frame look duplicated.

The repair must preserve incremental rendering's main purpose: ordinary updates should remain surgical and should not flash. It must not introduce new `clearTerminal` operations.

## Goals

- Keep unchanged-line skipping for ordinary incremental updates.
- Restore the full visible frame after public `clear()` when later content changes.
- Keep full-frame erase/repaint transitions atomic on synchronized-update terminals and minimize intermediate writes elsewhere.
- Position and restore the terminal cursor from its actual physical baseline for both trailing-newline and fullscreen output.
- Keep a committed cursor active until its owner explicitly clears or unmounts it.
- Detect viewport-driven changes to the terminal representation even when rendered content is unchanged.
- Detect column-driven terminal reflow, erase every physical row occupied by the previous frame at the new width, and repaint once.
- Preserve existing overflow and issue-450 fallback behavior unless a change is required by one of the six fixes.

## Non-goals

- Replacing incremental line diffing with a new renderer.
- Removing existing `clearTerminal` fallbacks for overflow, content-driven fullscreen exit, or teardown.
- Adding a public rendering option or changing the public `render()` API.
- Supporting multiple simultaneous `useCursor()` owners with an owner registry or stack.
- Refactoring unrelated Ink layout, static output, selection, or alternate-screen behavior.
- Periodically repainting an unchanged frame to recover from arbitrary terminal resets when neither dimensions nor Ink state changed.

## Selected approach

Use targeted state corrections rather than a unified terminal-frame abstraction or broad fallback to standard rendering. The renderer will retain its existing line arrays and diff loop, with only the additional metadata and operations needed to keep cached state aligned with the terminal.

This approach has the smallest blast radius and preserves surgical updates. A standard-render fallback was rejected because it would unnecessarily rewrite every frame and work against the no-flash goal. A unified frame object was rejected as a larger refactor than the six confirmed failures require.

## Design

### 1. Distinguish cached output from physically present output

`LogUpdate.clear()` represents a physical erase. After it completes:

- cached output and rendered cursor state are empty;
- cursor dirty state is consumed/reset;
- the desired committed cursor position remains available for a later repaint.

`Ink.clear()` will no longer call `log.sync()` with the erased frame. The last React representation (`lastOutput`, `lastOutputToRender`, and `lastOutputHeight`) remains intact for unchanged-render suppression and future layout comparisons, while a separate `hasPhysicalFrame` marker becomes false. A dimension-only render that emits no frame keeps the marker false; only an actual frame write or stdout/stderr restoration makes it true again. If React later produces different output, the empty `log-update` cache forces a complete repaint, including rows whose text did not change relative to the pre-clear React frame.

External stdout/stderr restoration remains valid: those paths explicitly call `setCursorPosition()` and then render the saved output after clearing it.

### 2. Add an internal complete-frame repaint operation

Add an internal `LogUpdate` operation for transitions where the previous physical frame cannot safely be used as a line-diff base. The operation will:

1. Return a previously positioned cursor to the frame baseline.
2. Erase the prior frame with line-oriented erase sequences, not `clearTerminal`.
3. Write the complete next output.
4. Restore the committed cursor position.
5. Update the same cached output, lines, and rendered cursor state used by normal incremental rendering.

The erase and output payload will be buffered into one `stream.write()` where practical. Ink will wrap the transition in synchronized-update BSU/ESU sequences under the same capability check used by other interactive writes. This avoids exposing a blank intermediate frame on supporting terminals and minimizes intermediate writes elsewhere.

Normal updates continue through the existing surgical diff loop.

### 3. Track the viewport that produced the previous frame

Ink will retain the terminal row count used for the last interactive frame. Fullscreen classification of the previous frame must use that previous row count rather than the current viewport.

Render decisions will compare `outputToRender`, not only `output`, because the former encodes whether the frame ends with a trailing newline. Existing direct `clearTerminal` fallbacks must also write `outputToRender` before synchronizing it into `log-update`; the physical bytes and cached representation must have the same trailing-newline mode.

Viewport transitions behave as follows:

- **Row shrink invalidates a previously non-fullscreen frame:** when unchanged content becomes exact-fullscreen because the viewport shrank, use the synchronized complete-frame repaint. This repairs terminal resize displacement without adding `clearTerminal`.
- **Row growth changes fullscreen or overflow output to non-fullscreen:** emit the required trailing-newline transition through incremental rendering. Pure viewport growth must not invoke `clearTerminal`, even when the previous frame overflowed its smaller viewport.
- **Ordinary content updates:** keep surgical line updates.
- **Existing overflow/content-shrink fallbacks:** retain their current clear behavior and issue-450 expectations when content changes or the current viewport still overflows.

The saved viewport metadata is updated after every completed interactive frame, including branches that use existing terminal-clear fallbacks.

### 4. Separate desired cursor state from cursor dirtiness

`cursorPosition` becomes persistent committed intent. `cursorDirty` only records that the desired position changed and may require a cursor-only write.

Consequences:

- Rendering changed output always restores the current committed cursor, even if `setCursorPosition()` was not called during that React commit.
- A memoized cursor owner remains active while a sibling rerenders.
- `setCursorPosition(undefined)` remains the explicit way to hide the cursor.
- `useCursor()` insertion-effect cleanup continues to clear cursor intent when the owner unmounts.
- Cursor-only updates remain escape-sequence-only writes and do not repaint content.
- `LogUpdate.reset()` remains a cache-only operation for callers that have already reset or replaced the physical terminal contents. It preserves committed cursor intent but emits no cursor movement; tests must model that external-reset precondition rather than treating `reset()` as a physical erase.

This change deliberately does not add ownership arbitration for multiple cursor-producing components.

### 5. Calculate cursor movement from the physical post-write row

Cursor suffix helpers will accept or derive the physical row occupied after writing output rather than assuming an empty row follows all output.

For `str.split('\n')`, the physical baseline is `lines.length - 1`:

- `A\nB\n` produces `['A', 'B', '']`, so the baseline is row 2.
- `A\nB` produces `['A', 'B']`, so the baseline is row 1.

Cursor movement is calculated from that baseline to the requested zero-based `y`. The same metadata is used by full render, incremental render, sync, and cursor-only paths. Existing return-to-bottom logic will use the saved physical baseline consistently.

### 6. Return the cursor to the frame bottom during teardown

Before `done()` clears state, it will:

1. Hide the cursor if Ink still has a positioned cursor inside the frame.
2. Move from the saved cursor position to the physical frame baseline and column zero when that position is still available.
3. Restore the caller's expected cursor visibility even if `clear()` or explicit cursor removal already hid the cursor and cleared rendered-position bookkeeping.
4. Clear output and desired/rendered cursor bookkeeping.

This applies to both standard and incremental `LogUpdate` implementations because they share the same cursor helpers and teardown contract.

### 7. Invalidate cached row geometry when terminal columns change

The existing width-decrease workaround runs in `Ink.resized()`: it calls `log.clear()` before recalculating Yoga layout and clears `lastOutput`. That is too late to use the old logical row count. The terminal has already reflowed the painted frame at its new width.

Executable `@xterm/headless` probes confirmed two distinct mismatches:

- a three-row, 10-column box plus its trailing baseline occupies four cached `split('\n')` slots;
- after resizing to five columns, the old box occupies six visible physical rows plus the baseline;
- the current `eraseLines(4)` leaves old top rows above the new frame, while `eraseLines(7)` removes the complete reflowed frame, including when a committed cursor is active;
- widening the same fixture did not duplicate rows in xterm, confirming that column growth can keep the existing incremental shrink/diff path;
- a second probe drove real Ink output through xterm with a component whose fixed width comes from `useWindowSize()`. It reproduced the reported duplicate row even after the seven-row erase repair.

The second probe exposed resize-listener ordering as the remaining cause. Ink registers its stdout listener before hook listeners. Its synchronous resize render therefore sees the new `stdout.columns` but can still see the hook's old width, writes an intermediate frame wider than the terminal, and records the new `lastTerminalWidth`. The later `useWindowSize()` commit then takes the ordinary logical-line diff path because columns no longer appear to have decreased. Since the intermediate frame physically soft-wrapped into more rows than its cached `split('\n')` lines, that diff leaves the first wrapped row untouched and visibly duplicates it.

Ink will compare the current terminal columns with `lastTerminalWidth` inside every interactive frame, not only inside the resize-event handler. A decrease is treated as physical invalidation only when `hasPhysicalFrame` says the cached prior representation is still present, including when a delayed or missed resize notification is first discovered by a later React/animation render. Every committed physical frame is cheaply classified into `lastPhysicalFrameWasSoftWrapped`, so initially overwide fixed/min-width layouts and resize intermediates cannot become logical-line diff bases. This flag carries invalidation through width-dependent hook commits after `lastTerminalWidth` has advanced.

The soft-wrap flag is required for performance as well as correctness. A naive implementation re-wrapped `lastOutputToRender` and split it on every interactive render. A diagnostic 13 KB, 100-row ANSI frame took about 4.46 ms per call on the development machine—over a quarter of a 60 FPS frame budget—while the logical split alone took about 0.002 ms. Ordinary renders must therefore consult cached metadata and never invoke `wrap-ansi`.

For a previous physical frame:

1. Before choosing the diff path, classify an output that would be written. Invalidate on a column decrease, when `lastPhysicalFrameWasSoftWrapped` is true and the next operation would write, or when a fitted physical frame is about to become soft-wrapped. Byte-identical idle renders remain no-ops.
2. Only after that cold-path decision, re-wrap `lastOutputToRender` at the current columns with hard, character-level wrapping (`trim: false`, `hard: true`, `wordWrap: false`) and use the resulting physical row count as the erase override.
3. Keep cursor return-to-bottom movement based on the cached rendered cursor state, emit one synchronized complete-frame repaint, and update normal cached output/lines/cursor state.
4. After every physical write, classify the newly written frame once with `widest-line` (`widestLine(outputToRender) > terminalWidth`) rather than re-wrapping it. Persist whether any logical line still exceeds the viewport width; clear the flag when a fitted frame is committed. The exact `wrap-ansi` row count remains necessary only for erasing a previous soft-wrapped frame. External stdout restoration performs the same classification, while public `clear()` resets the flag after erasing.
5. Record the current columns with the completed frame, including direct `clearTerminal` fallback branches. Byte-identical/no-write frames retain the cached flag, and ordinary changed frames whose physical geometry fits retain the original surgical update path without invoking `wrap-ansi`.

`LogUpdate.clear()` and `LogUpdate.repaint()` accept the same optional internal erase-count override. The static-output branch needs the clear override because it must erase the old dynamic frame before inserting static output; ordinary physical invalidation uses `repaint()`. Before public `Instance.clear()` or an external stdout/stderr write clears a displayed soft-wrapped frame, Ink derives its exact row count at the current columns and passes the override to `LogUpdate.clear()`. Ink's `hasPhysicalFrame` prevents stale row/fullscreen/column classification after public `clear()`, while `LogUpdate` independently ignores an override when its cache is empty after `clear()` or `reset()`.

`Ink.resized()` will stop eagerly clearing output or resetting `lastOutput`. It recalculates layout and requests the render; render-time metadata chooses and synchronizes the invalidation operation. Frames at wider columns, and unchanged-column frames whose cached logical rows still match their physical rows, continue through surgical line diffing.

## Data flow

### Ordinary incremental update

1. React commits output and optional cursor intent.
2. Ink computes `outputToRender` from output height and current viewport rows.
3. Ink detects content, output-mode, or cursor changes.
4. `createIncremental()` returns from any positioned cursor, skips equal rows, rewrites changed rows, and restores the persistent committed cursor.
5. Ink records output height, `outputToRender`, and current viewport rows.

### Public clear followed by changed output

1. `Ink.clear()` derives a physical erase override when the displayed frame is soft-wrapped, erases the complete frame, leaves `log-update`'s output cache empty, and sets `hasPhysicalFrame` to false.
2. The desired cursor intent and last React representation remain stored, but are not displayed on the blank frame.
3. A later changed React frame enters `log-update` with no cached lines.
4. The renderer writes the complete frame, restores the cursor, and marks the frame physical again.
5. If a column decrease is the next render, the false marker and empty cache suppress the physical erase override so unrelated rows above the cleared frame are not removed.
6. A resize that leaves the output representation byte-identical emits no write and keeps `hasPhysicalFrame` false; it cannot resurrect the cleared frame for a later fullscreen decision.
7. A later stdout/stderr restoration replays the frame and sets `hasPhysicalFrame` true, so subsequent width invalidation uses the reflow-aware erase again.

### Viewport shrink into fullscreen

1. Resize handling observes fewer rows without a width decrease.
2. Ink compares the new viewport with the viewport used by the previous frame.
3. The transition is classified as an invalidated diff base.
4. Ink emits BSU, one line-oriented complete-frame repaint, and ESU.
5. No new `clearTerminal` sequence is emitted.

### Terminal column decrease

1. The terminal decreases its columns and physically reflows the painted frame before JavaScript handles `resize`.
2. The next interactive frame observes that current columns are smaller than the columns recorded for `lastOutputToRender` and derives the previous frame's physical row count at the new width.
3. Ink emits BSU, one erase-lines complete repaint using the derived count, and ESU.
4. If every component already rendered at the new width, the committed frame's physical and logical row counts match and later renders are surgical again.
5. If an earlier Ink resize listener painted output from stale `useWindowSize()` state, that intermediate output is wider than the new terminal and remains physically soft-wrapped even though `lastTerminalWidth` now equals the current width.
6. The cached soft-wrap flag tells the hook's follow-up commit that the previous frame is still an invalid diff base. Because the output/cursor will change, Ink derives that intermediate frame's physical row count and performs another synchronized complete repaint instead of entering the unsafe logical diff.
7. Once a fitted frame is committed, the mismatch disappears and ordinary incremental rendering resumes.

## Testing strategy

All implementation work follows red-green-refactor sequencing. Each confirmed failure receives a regression test before its fix.

### `test/log-update.tsx`

- Cursor placement for trailing-newline and no-trailing-newline output, including first and last visible rows.
- Changed output without another cursor setter call retains the committed cursor.
- Explicit `undefined` still hides the cursor.
- `clear()` preserves committed cursor intent after physically erasing output.
- Cache-only `reset()` preserves committed cursor intent when the caller has externally reset the terminal.
- `done()` returns a positioned cursor to the bottom for both output forms.
- `done()` restores visibility after `clear()` or explicit cursor removal already hid the cursor.
- Complete-frame repaint emits the entire frame, erases prior rows, performs one buffered content write, restores cursor state, and leaves subsequent updates incremental.
- Width-aware `clear()` and `repaint()` honor an explicit physical erase count while still using cached cursor state for return-to-bottom and updating the normal next-frame cache.
- After `clear()` empties the physical-frame cache, a later repaint ignores a stale physical erase override.

### `test/cursor-helpers.tsx`

- Physical baseline calculations for trailing and non-trailing output.
- Cursor suffix and return-to-bottom sequences use valid zero-based visible rows.
- Cursor-only transitions share the corrected baseline behavior.

### `test/render.tsx`

- `clear()` followed by a changed rerender writes unchanged rows that were physically erased.
- A viewport shrink after public `clear()` does not invoke the overflow `clearTerminal` fallback for the already-absent frame.
- A byte-identical/no-write column resize after public `clear()` keeps the frame physically absent, so a subsequent row shrink also avoids `clearTerminal`.
- A memoized `useCursor()` owner remains visible while only a sibling changes.
- A content-driven fullscreen exit writes the same trailing-newline representation that `log-update` synchronizes before restoring an interior cursor.
- Row shrink across the exact fullscreen boundary emits a synchronized erase-lines repaint containing the complete frame and no `clearTerminal`.
- Row growth across the boundary writes the trailing-newline transition without adding a terminal clear.
- Pure viewport growth from overflow to fitting output also avoids `clearTerminal` and emits only the representation transition.
- Existing issue-450 tests continue to enforce no repeated clearing during ordinary full-height rerenders.
- Column shrink from 10 to 5 erases the complete reflowed prior frame, emits one synchronized full repaint, and introduces no `clearTerminal`.
- A `useWindowSize()`-dependent fixed-width frame reproduces resize-listener ordering: after an old-width intermediate repaint, the final narrower hook commit must itself erase the intermediate frame's three physical rows before repainting, preventing the duplicate row observed in xterm.
- An ordinary unchanged-width interactive frame with a valid physical cache must not invoke terminal reflow measurement; the regression makes `Intl.Segmenter.segment()` throw so any accidental `wrap-ansi` call fails deterministically.
- Fullscreen width shrink without a trailing newline erases only the reflowed visible rows, with no synthetic baseline row.
- Column shrink after public `clear()` may repaint the new frame but does not erase rows for the already-absent old frame.
- Stdout restoration after public `clear()` marks the replayed frame physical again, so a subsequent column shrink uses the full reflow-aware erase.
- A column decrease that coincides with new `<Static>` output uses the same reflowed erase count before writing static and restored dynamic output.
- Column growth remains on the incremental shrink/diff path, emits no eager clear or `clearTerminal`, and does not rewrite unchanged rows.
- A changed column value discovered by a later rerender (without a delivered `resize` event) still triggers the width-aware repaint.
- A fixed-width frame whose output remains byte-identical after a missed column decrease still performs the width-aware repaint when a delayed cursor-only commit is the next render.
- ANSI-styled text with a wide grapheme at a wrap boundary produces the terminal-equivalent erase count rather than a naive `ceil(totalWidth / columns)` count.

## Verification

Run from the nested repository at `packages/ink`:

```bash
npm exec ava test/log-update.tsx test/cursor-helpers.tsx test/render.tsx test/terminal-resize.tsx
npm run typecheck
npm run lint
npm test
npm exec ava
```

Final verification on 2026-08-14: the four focused rendering files pass 185 tests; the cursor lifecycle file passes 13 tests with the known suspended-concurrent case excluded; and typecheck is clean. Package lint remains at the documented unrelated baseline of 13 errors and 9 warnings. The complete AVA run remains at the documented 57 unrelated failures, dominated by `TypeError: act is not a function` in concurrent tests; all new rendering/resize regressions pass within that run.

## Risks and mitigations

- **Terminal implementations differ after viewport or column resize.** Mitigation: do not trust the old line-diff base after exact-fullscreen row shrink or a column decrease that can add physical rows; erase and repaint the complete frame with line-oriented sequences. Keep evidence-backed column growth on the existing diff path.
- **ANSI and wide graphemes can reflow differently from a naive width quotient.** Mitigation: derive the erase count with hard character-level `wrap-ansi` using the same `string-width` dependency as Ink, and cover a wide-character boundary.
- **A resize event can be delayed or missed during suspension/idle.** Mitigation: compare columns in every interactive frame, including unchanged-output cursor-only commits, so the next real render repairs the cache; do not add periodic repainting.
- **A complete repaint could flash.** Mitigation: buffer erase plus output and use synchronized-update wrappers; do not introduce a separate `clearTerminal` operation.
- **Persistent cursor intent could become stale.** Mitigation: retain explicit `undefined` cleanup from `useCursor()` and test owner unmount separately from sibling rerender.
- **Changing fullscreen classification could regress issue 450.** Mitigation: preserve existing fallback policy, add exact row-resize boundary tests, and rerun all issue-450 coverage.
- **Public clear semantics or stale metadata could affect later resizes.** Mitigation: keep React frame metadata for unchanged-output behavior but track physical presence separately; clear/reset erase overrides require a cached frame, no-write resizes cannot resurrect one, and stdout/stderr restoration marks the replayed frame physical again.
