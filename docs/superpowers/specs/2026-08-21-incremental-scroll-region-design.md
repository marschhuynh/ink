# Incremental Scroll-Region Paint Design

## Context

The nuvin-agent TUI transcript (`VirtualizedList`) scrolls by shifting every
visible line up or down. React-level measurement (render-count probe,
2026-08-21 session) confirms row components correctly bail out via
`React.memo`: only boundary rows re-render per wheel notch. The perceived
"everything re-renders" jank comes from the **paint layer**:

`log-update.ts`'s incremental renderer diffs **positionally**
(`nextLines[i] === previousLines[i]`, ~line 331). After any scroll of k > 0
rows, every line index holds different content, so the diff finds zero
unchanged lines and rewrites the **entire frame** — every scroll notch emits a
full-viewport erase + redraw (~viewport-height × line-width bytes), even though
(1 − k/H) of the frame is byte-identical content that merely moved.

## Goals

- Detect pure vertical shifts between the previous and next frame and emit
  terminal scroll operations instead of rewriting the shifted core.
- Rewrite only the newly exposed edge lines (plus any genuinely changed lines)
  after the scroll operation.
- Compose with the existing diff loop: after applying a shift, mutate the
  cached previous-lines array to the shifted arrangement and let the ordinary
  unchanged-line skipping finish the job.
- Preserve all six repairs from `2026-08-09-incremental-rendering-state-repair-design.md`.

## Non-goals

- Generalized line-reconciliation (LCS diffing beyond a single global shift).
- Horizontal scroll handling (frames are wrapped to terminal width).
- Changes outside `packages/ink/src/log-update.ts` and its tests.
- New public API surface.

## Selected approach

### Shift detection

In the incremental branch of `render()`, when `visibleCount === previousVisible`
and both frames have at least a few lines, search shifts `k = 1..K_MAX`
(K_MAX = min(visibleCount − 1, 32)) in both directions:

- **Scroll up** (content moved up): `nextLines[i] === previousLines[i + k]` for
  a contiguous core of rows.
- **Scroll down**: `nextLines[i] === previousLines[i − k]`.

Accept the smallest qualifying k whose **matched-core ratio** ≥ 0.5 of the
frame. The ratio requirement makes the optimization self-disabling for updates
that merely resemble a shift (streaming appends, selection highlights, spinner
ticks): those fail the threshold and fall through to the existing diff path
unchanged. Exact string equality (including ANSI styling) matches the existing
diff semantics.

### Emission

One atomic write, single buffer:

1. Save/normalize cursor position (existing return-prefix logic).
2. Set a scroll region covering exactly the frame's physical rows
   (`CSI top;bottom r`, DECSTBM).
3. Emit `CSI k S` (scroll up) or `CSI k T` (scroll down).
4. Reset the scroll region to full screen (`CSI r`) — never leave a region
   installed, other writers (and other Ink instances) share the tty.
5. Update the in-memory cache: `previousLines` becomes the shifted array;
   `previousOutput` is left stale (unused by the diff loop) — then **fall
   through into the existing per-line diff**, which now sees only the k edge
   lines plus genuine changes as dirty.

Because step 5 feeds the standard loop, cursor-suffix bookkeeping, trailing
newline handling, and erase-end-line behavior remain governed by the repaired
logic from the 2026-08-09 design.

### Guards (skip shift detection when)

- `incremental` is off, frames are empty, or `visibleCount !== previousVisible`.
- A committed cursor is currently drawn **inside** the frame
  (`activeCursor` present): the scroll would visually displace the cursor
  while its owner's logical coordinates stay fixed. Fall back to the normal
  diff (which repaints the cursor line anyway).
- Either frame ends with a shape change (trailing-newline ↔ fullscreen form);
  the 2026-08-09 repair treats those transitions specially.
- The previous frame was erased (`clear()` path) or this is the first render.

### Escape hatch

`NUVIN_INK_NO_SCROLL_OPT=1` disables detection entirely, for terminals with
faulty SU/SD or scroll-region behavior.

## Edge cases

| Case | Behavior |
|---|---|
| Page jump (k ≈ viewport height) | Core ratio still ≥ 0.5 only if overlap exists; otherwise falls back to full rewrite (correct: nothing is shared). |
| Resize between renders | Dimensions recorded per frame; width mismatch forces the existing reflow path, no shift attempt. |
| Selection overlay active | Many interior lines change → ratio < 0.5 → normal path. |
| Multiple Ink instances | Region is set and reset inside one synchronous write; interleaving risk unchanged from status-quo full rewrites. |
| Synchronized-update terminals | Scroll write is part of the same buffered frame commit as the follow-up edge-line writes; begin/end wrapping already applied by caller is preserved. |

## Test plan (AVA, packages/ink)

1. **Shift up/down detection**: fake stream; two frames differing by a 3-row
   shift; assert emitted bytes contain DECSTBM set, `CSI 3 S`/`T`, DECSTBM
   reset, and exactly the k edge lines rewritten (no interior line content).
2. **Below-threshold updates**: append-style change (ratio < 0.5) emits no
   scroll op and matches legacy byte-for-byte output.
3. **Cache correctness**: after a scrolled render, a subsequent unrelated
   single-line change rewrites only that line.
4. **Committed cursor inside frame**: scroll skipped, legacy path taken.
5. **Escape hatch**: env var set → legacy path byte-for-byte.
6. **Regression sweep**: existing `log-update` / rendering test suites pass
   unmodified (byte-compat for all non-shift scenarios).

## End-to-end verification (nuvin-agent)

Extend `packages/cli/scripts/benchmark-virtualized-list.tsx` to count stdout
bytes per scenario. Success criterion: wheel-notch scenario bytes drop by
roughly the non-edge fraction of the viewport (≈ 80%+ for step 3 at typical
heights), frame medians improve or stay flat.
