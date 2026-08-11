# Incremental Rendering State Repair Design

## Context

Ink's incremental renderer correctly avoids rewriting unchanged lines during ordinary updates, but five transitions allow its cached frame or cursor state to diverge from the terminal's physical state:

1. `Ink.clear()` erases the frame and then syncs the erased output back into the diff cache, so the next changed render can skip rows that are no longer visible.
2. Cursor suffix calculations assume the terminal is on an empty row after the output, which is false for fullscreen output without a trailing newline.
3. `cursorDirty` currently determines both whether the cursor changed and whether a committed cursor exists, so a sibling-only rerender hides a still-mounted cursor.
4. A terminal row resize can change `outputToRender` between trailing-newline and fullscreen forms without producing a write.
5. `done()` resets cursor bookkeeping while the physical cursor may still be positioned inside the rendered frame.

The repair must preserve incremental rendering's main purpose: ordinary updates should remain surgical and should not flash. It must not introduce new `clearTerminal` operations.

## Goals

- Keep unchanged-line skipping for ordinary incremental updates.
- Restore the full visible frame after public `clear()` when later content changes.
- Keep full-frame erase/repaint transitions atomic on synchronized-update terminals and minimize intermediate writes elsewhere.
- Position and restore the terminal cursor from its actual physical baseline for both trailing-newline and fullscreen output.
- Keep a committed cursor active until its owner explicitly clears or unmounts it.
- Detect viewport-driven changes to the terminal representation even when rendered content is unchanged.
- Preserve existing overflow and issue-450 fallback behavior unless a change is required by one of the five fixes.

## Non-goals

- Replacing incremental line diffing with a new renderer.
- Removing existing `clearTerminal` fallbacks for overflow, content-driven fullscreen exit, or teardown.
- Adding a public rendering option or changing the public `render()` API.
- Supporting multiple simultaneous `useCursor()` owners with an owner registry or stack.
- Refactoring unrelated Ink layout, static output, selection, or alternate-screen behavior.

## Selected approach

Use targeted state corrections rather than a unified terminal-frame abstraction or broad fallback to standard rendering. The renderer will retain its existing line arrays and diff loop, with only the additional metadata and operations needed to keep cached state aligned with the terminal.

This approach has the smallest blast radius and preserves surgical updates. A standard-render fallback was rejected because it would unnecessarily rewrite every frame and work against the no-flash goal. A unified frame object was rejected as a larger refactor than the five confirmed failures require.

## Design

### 1. Distinguish cached output from physically present output

`LogUpdate.clear()` represents a physical erase. After it completes:

- cached output and rendered cursor state are empty;
- cursor dirty state is consumed/reset;
- the desired committed cursor position remains available for a later repaint.

`Ink.clear()` will no longer call `log.sync()` with the erased frame. `Ink.lastOutput` already records the last React output and suppresses an unchanged final render. If React later produces different output, the empty `log-update` cache forces a complete repaint, including rows whose text did not change relative to the pre-clear React frame.

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

## Data flow

### Ordinary incremental update

1. React commits output and optional cursor intent.
2. Ink computes `outputToRender` from output height and current viewport rows.
3. Ink detects content, output-mode, or cursor changes.
4. `createIncremental()` returns from any positioned cursor, skips equal rows, rewrites changed rows, and restores the persistent committed cursor.
5. Ink records output height, `outputToRender`, and current viewport rows.

### Public clear followed by changed output

1. `Ink.clear()` physically erases the frame and leaves `log-update`'s output cache empty.
2. The desired cursor intent remains stored but is not displayed on the blank frame.
3. A later changed React frame enters `log-update` with no cached lines.
4. The renderer writes the complete frame and restores the cursor.

### Viewport shrink into fullscreen

1. Resize handling observes fewer rows without a width decrease.
2. Ink compares the new viewport with the viewport used by the previous frame.
3. The transition is classified as an invalidated diff base.
4. Ink emits BSU, one line-oriented complete-frame repaint, and ESU.
5. No new `clearTerminal` sequence is emitted.

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

### `test/cursor-helpers.tsx`

- Physical baseline calculations for trailing and non-trailing output.
- Cursor suffix and return-to-bottom sequences use valid zero-based visible rows.
- Cursor-only transitions share the corrected baseline behavior.

### `test/render.tsx`

- `clear()` followed by a changed rerender writes unchanged rows that were physically erased.
- A memoized `useCursor()` owner remains visible while only a sibling changes.
- A content-driven fullscreen exit writes the same trailing-newline representation that `log-update` synchronizes before restoring an interior cursor.
- Row shrink across the exact fullscreen boundary emits a synchronized erase-lines repaint containing the complete frame and no `clearTerminal`.
- Row growth across the boundary writes the trailing-newline transition without adding a terminal clear.
- Pure viewport growth from overflow to fitting output also avoids `clearTerminal` and emits only the representation transition.
- Existing issue-450 tests continue to enforce no repeated clearing during ordinary full-height rerenders.

## Verification

Run from the nested repository at `packages/ink`:

```bash
npm exec ava test/log-update.tsx test/cursor-helpers.tsx test/render.tsx
npm run typecheck
npm run lint
npm test
```

Focused tests run after each implementation step. As of 2026-08-10, typecheck and the focused cursor/log-update baseline pass, while package lint has 13 unrelated pre-existing errors and 9 warnings and the full AVA run has 57 unrelated concurrent-test failures (`TypeError: act is not a function`) in the nested/pnpm-linked environment. Focused rendering files and typecheck are blocking gates for this work; package-wide commands are rerun for baseline comparison and their pre-existing failures are reported rather than repaired in this scope.

## Risks and mitigations

- **Terminal implementations differ after viewport resize.** Mitigation: do not trust the old line-diff base after a row shrink into fullscreen; erase and repaint the complete frame with line-oriented sequences.
- **A complete repaint could flash.** Mitigation: buffer erase plus output and use synchronized-update wrappers; do not introduce a separate `clearTerminal` operation.
- **Persistent cursor intent could become stale.** Mitigation: retain explicit `undefined` cleanup from `useCursor()` and test owner unmount separately from sibling rerender.
- **Changing fullscreen classification could regress issue 450.** Mitigation: preserve existing fallback policy, add exact row-resize boundary tests, and rerun all issue-450 coverage.
- **Public clear semantics could redraw unexpectedly.** Mitigation: keep `Ink.lastOutput` suppression for unchanged React output; repaint only after content or output mode genuinely changes.
