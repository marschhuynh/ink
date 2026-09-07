# Allocated Cursor-Seek Fallback Design

## Decision and scope

Implement a seek-based paint strategy for **fullscreen incremental frames**
when OSC 66 is unavailable. Keep one layout calculator (`string-width`) and
keep original grid text for Ink-managed selection/copy.

The first version is deliberately bounded:

- `incrementalRendering: true`, interactive TTY, debug off, screen reader off.
- The dynamic frame occupies exactly the terminal viewport height. Wider
  rows are clipped at grapheme boundaries to the current viewport width.
- Cover initial paint, changed rows, forced repaint, resize, cursor-only
  updates, and restoration after ordinary output within that mode.
- Standard rendering, inline incremental frames, frames taller than the
  viewport, and Static output retain their existing raw fallback when OSC
  66 is unavailable. OSC 66 behavior remains unchanged in all modes.
- No CLI component or layout changes. Nuvin's main TUI already opts into
  incremental rendering and enters the alternate screen externally; do not
  require Ink's `alternateScreen` option to recognize a fullscreen frame.
  Confirm the live Shell frame fills the viewport during acceptance.

This restriction permits absolute row positioning and a viewport repaint on
resize without guessing how many rows an inline frame occupies after the
terminal reflows it. Extending seek painting to inline frames or Static
scrollback is separate work.

## Context and limits

The reported failure is a bash/markdown line containing `🏳️‍♀️`
(U+1F3F3 U+FE0F U+200D U+2640 U+FE0F). Ink allocates two cells, while
some terminals paint several glyphs, disturbing the tool card and rows below.
The existing OSC 66 implementation addresses this on supporting terminals.
The recorded Kitty encoded-advance checks passed on 2026-09-06; automatic
startup and physical Warp/Terminal.app acceptance are separate checks.

Seeking can restore allocated cursor positions and overwrite excess paint.
It cannot make an unsupported terminal shape a ZWJ sequence into one glyph.
Split, clipped, incomplete, or erased portions of that glyph are acceptable;
damage to other content and unintended row movement are not.

Original grapheme payloads are emitted intact when they fit the allocated
viewport. Source text, selectors, and ZWJ sequences are not rewritten.
Ink-managed copy reads original grid text. Native terminal copy reads cells
that may have been overwritten, so exact native copy is not guaranteed.

Non-goals: terminal-specific width tables, layout changes, per-glyph CPR,
mode 2027, forcing OSC 66 on unsupported terminals, and guaranteeing behavior
on every terminal that fails the OSC 66 probe.

## Strategy selection

Capability detection remains per Ink instance. Frame eligibility is evaluated
separately, at actual write time, using current terminal dimensions.

| Condition, in precedence order | Paint strategy |
| --- | --- |
| Disabled option, `INK_EXPLICIT_WIDTH=0`, non-interactive, non-TTY, debug, or screen reader | Existing output path; no new controls |
| `INK_EXPLICIT_WIDTH=1` on an eligible TTY | Existing OSC 66 encoder |
| Probe confirms OSC 66 | Existing OSC 66 encoder |
| Probe fails, times out, or cannot start; fullscreen incremental frame | Allocated seek row writer |
| Probe unavailable/failed; other frame or Static output | Existing raw output path |

A failed probe establishes only that OSC 66 was not confirmed. It does not
certify seeking, overwrite behavior, or resize behavior. Target terminals
must pass the acceptance gate before this fallback ships by default.

On settlement, replay reserved/pending frames in their existing order with
the selected strategy. Check unmount and writable-stream state before any
mode or frame write. When input cannot start a probe, select the appropriate
fallback directly rather than waiting for a callback that will never arrive.

## Integration contract

The existing `transformOutput` seam remains the OSC 66 encoder's home. The
seek path needs a **row writer**, not just another string transformer:

- `createIncremental` compares logical rows before parsing or painting them.
  Its seek branch owns row origin, cell initialization, grapheme output,
  trailing cleanup, and the final cursor position.
- Every changed row starts with absolute `CUP(row + 1, 1)`. Do not depend on
  the cursor advance of a preceding row. Do not emit newlines while painting
  a fullscreen seek frame, including at the bottom-right corner.
- First paint and forced repaint use the same row writer for all viewport
  rows. There is no separate bulk-string path that bypasses cleanup.
- Suppress the existing unconditional post-row `eraseEndLine` on this branch.
  The seek writer alone owns row erasure. Raw and OSC 66 paths retain their
  existing behavior; no CHA corrections or DECAWM changes are added to them.
- Disable the scroll-region optimization for seek frames in this first
  version. Positional row comparison still skips unchanged rows. This keeps
  the first implementation focused on correct changed-row painting.
- `sync()` remains cache priming. A caller that writes externally may prime
  the cache only with matching physical-frame metadata after that write.

Introduce an internal paint context carrying strategy, current dimensions,
and viewport ownership. Force a full repaint when strategy or dimensions
change even if logical text is identical. The exact TypeScript API is an
implementation choice; these ownership rules are required.

## Preparing a row

Scan complete controls before emitting any bytes. Reuse the existing
encoder's control-token parsing, without treating control payloads as text.
Accept normal printable graphemes, SGR styles, and OSC 8 hyperlinks. Preserve
those styles and links around their original text.

Do not blindly pass through arbitrary cursor motion, tabs, backspaces,
carriage returns, terminal mode changes, or malformed escapes. The seek
writer's input is the renderer's styled grid row, not a terminal transcript.
Reject unsupported controls before committing the frame and surface the
failure through Ink's error handling with modes restored. Never partly seek
encode a frame and then switch to raw output while claiming known geometry.
This intentionally replaces the original proposed fail-open rule for the
seek branch; the OSC 66 encoder's existing policy is unchanged.

Segment printable runs into complete graphemes and mirror the existing
`Output` grid allocation: `Math.max(1, stringWidth(grapheme))` for each
nonempty grapheme. Measured width and allocated width are distinct: a
standalone combining mark, selector, or format-only grapheme still reserves
one grid cell. Do not merge independently allocated zero-width graphemes
into a neighboring allocation or let them bypass prefill and cursor correction.
Combining marks, selectors, and ZWJ sequences already within a grapheme stay
in that complete payload; never insert a seek inside it or allocate its
individual code points separately. SGR/link controls and empty rows allocate
no cells; empty wide-cell placeholders are not independent graphemes.
Clip a grapheme that would cross the allocated viewport boundary as a whole;
leave the remaining visible cells blank. Clipping affects painting only.

SGR boundaries inside a grapheme require normalization or rejection before
painting; they must not make the row writer silently segment one allocated
cluster into independently positioned pieces. This is an input-contract test,
not a new terminal-specific width calculator.

## Painting a changed row

Autowrap must be disabled before any printable bytes. Use one buffered write
for the row/frame, inside the existing synchronized-output mechanism when
available. For each rewritten row:

1. Move to its absolute origin. Reset SGR and close any active hyperlink,
   then erase the whole row (`EL 2`) to remove prior text. Replay the row's
   own styling from a known default state.
2. Walk left to right with one-based allocated column `x`.
3. Copy ASCII runs normally. Their cells are known to advance by one.
4. For every non-ASCII grapheme allocated `W >= 1` cells, including one whose
   measured `string-width` is zero, under its active style:
   write `W` ordinary spaces at `x`, seek back to `x`, then emit the complete
   original grapheme. The spaces initialize all allocated cells, including
   their background, before the terminal potentially paints fewer cells.
   If `x + W <= N`, seek to column `x + W`; otherwise omit the out-of-range
   seek. Advance the logical column by `W`, independently of terminal advance.
5. Following cells overwrite excess paint. At row end, close the hyperlink
   and reset SGR. If allocated row width `L < N`, seek to `L + 1` and erase
   to the right. If `L === N`, do not seek to `N + 1` and do not erase at the
   current cursor: it may be clamped onto valid content in column `N`.
6. Restore the requested cursor with an absolute position inside the viewport,
   or leave it hidden at a known in-bounds position. Do not append a newline.

Prefill is necessary even after clearing the row: an earlier oversized
cluster in the *same frame* can spill into the next grapheme's allocation.
Prefilling that next allocation removes the spill and gives a narrower glyph
its intended blank/background cells. Do not replace this with an unstyled
row erase alone, or with a background-only pass before all glyphs.

Example: replace `AB` with a two-cell allocation whose terminal glyph uses
one cell. The result is the glyph plus a styled blank, not the glyph plus
stale `B`. Also test an oversized cluster followed by such a narrow glyph.

Terminal overwrite semantics can erase an entire wide glyph when one of its
cells is overwritten. That may reduce the glyph's appearance, which is an
accepted limit. Right-edge tests must nevertheless verify adjacent text and
backgrounds: DECAWM alone is not proof that every terminal confines paint to
the expected cells. A terminal that damages neighbors fails qualification.

## Physical-frame state and resize

Keep logical output for diffing/copy separate from the last committed
physical frame. Record at least:

- Strategy (`raw`, `osc66`, or `seek-viewport`) and terminal dimensions.
- Whether Ink owns a complete viewport and whether that origin is valid.
- The bounded rows actually painted, including allocated widths after clipping.
- The final cursor position and whether it is shown.

Commit this record at actual successful write time, not when a throttled
render is scheduled. Cancelled/coalesced frames must not update it. A partial
or failed output write invalidates the record; do not claim the terminal
still matches a cached frame.

At unchanged dimensions, clearing/restoring a seek viewport uses its known
viewport bounds. Do not call `getReflowedLineCount(lastOutputToRender, ...)`
or classify the original unclipped text as physically soft-wrapped.

On resize, do **not** assume DECAWM-off prevents reflow of existing contents.
The primary screen can reflow hard lines even when they were painted without
autowrap. Invalidate the seek viewport's origin and row cache. For a new
fullscreen frame, reset SGR/hyperlinks, erase the current viewport (`ED 2`,
not the scrollback-erasing `ED 3`), home the cursor, and paint every row using
absolute positions at the new dimensions. Recompute Yoga/layout when needed;
if dimensions change between layout and write, schedule that recomputation
and do not commit a stale frame as a valid full viewport.

This path replaces relative reflow erasure for a previously owned fullscreen
seek frame. It does not calculate extra rows from original text or erase
unrelated scrollback. Apply it both to ordinary rendering and
`getPhysicalEraseOptions`/`restoreLastOutput` callers.

Entering seek mode from raw/OSC 66 invalidates the old cache and performs a
full viewport repaint. Leaving it clears the previously owned viewport,
restores modes, resets physical/diff state, and uses the existing renderer
for the new frame. A smaller frame must not silently inherit fullscreen
coordinates. Height changes receive the same treatment as width changes.

## Ordinary output, Static, and teardown

DECAWM is terminal state. Bracket each seek paint transaction with autowrap
off before painting and autowrap on afterward, including a best-effort
`finally` path. Restore it before ordinary stdout/stderr, patched console
output, Static output, or React cleanup diagnostics. Cursor-only updates,
unchanged frames, and cache priming need no DECAWM changes.

Retain the existing ordering when ordinary or Static output arrives: clear
the dynamic frame, write that output through its existing path with normal
wrapping, then restore the dynamic frame. Before an absolute fullscreen
repaint, advance a fresh blank viewport with `viewportRows` explicit CRLFs.
This moves visible ordinary output into primary-screen scrollback rather
than immediately overwriting it at the home position. In the alternate
screen that output remains disposable, as it is today. This conservative
first version may add blank lines to primary-screen history around external
output; avoiding those extra blanks is not part of this phase. Then home
the cursor and restore through the same row writer. Do not wrap Static
graphemes with the seek writer in this phase.

Normal/error unmount and process-exit cleanup best-effort restore autowrap
if a paint was interrupted. Track that state idempotently. Allow the existing
controlled final render during `isUnmounting`, but never begin a paint after
`isUnmounted` is set. Cleanup must still restore a mode acquired before
unmount, even if `isUnmounted` was set before React cleanup. Keep alternate-screen teardown
ordering intact, including the CLI's externally managed alternate screen.
Assume enabled autowrap on entry and restore enabled autowrap; querying an
arbitrary preexisting DECAWM state is outside this phase.

## Acceptance and implementation checkpoints

### Automated: incremental mode

1. Reproduce `AB` -> narrower two-cell allocation, then verify prefill removes
   the old second cell and preserves its background. Repeat with prior spill
   from an oversized cluster in the same row, styles, and hyperlinks.
2. Verify oversized clusters followed by text, trailing clusters, empty rows,
   exact-width ASCII/CJK/emoji rows, adjacent backgrounds, and the bottom-right
   glyph. No out-of-range CHA or final-cell erasure; no unexpected scroll.
3. Verify first paint, changed rows, forced repaint, restoration after raw
   stdout/stderr/Static writes (preserving primary-screen history), and
   fullscreen entry/exit. Identical frames,
   unchanged rows, cursor-only changes, and `sync()` do not paint glyphs.
4. Verify clipping, width and height resize, including a primary-screen model
   that reflows previously hard lines. Sentinels outside ordinary inline
   frames remain untouched because those frames do not enter seek mode.
   Fullscreen resize must repaint the viewport without erasing scrollback.
5. Verify pending/coalesced frames, strategy changes, probe failure/timeout/
   unavailable input, cancellation, unmount, unwritable streams, and late
   responses. Physical state follows actual writes; modes are restored.
6. Verify original grid copy and complete emitted grapheme payloads. Reject
   unsupported/malformed controls before a partial frame reaches the terminal.
   Feed actual `Output` rows into preparation and painting for `\u0301X`,
   `\uFE0FX`, `\u200BX`, and `A\u200BX`. Compare the terminal's `X` cell with
   its grid column (zero-based 1 for the first three, 2 for the last), including
   styles, clipping, and changed-row updates. Verify attached marks such as
   `e\u0301` remain one grapheme. Assert neighboring text and backgrounds,
   complete payload bytes, and unchanged plain rows/selection masks.
7. Existing OSC 66 tests stay green. Disabled/debug/non-interactive/screen-reader
   modes, standard rendering, inline incremental frames, and Static-only
   output gain no seek controls. Existing renderer cursor controls are allowed.

Use terminal-model cell assertions as well as byte assertions. A custom
width provider may simulate width disagreements, but record when widths are
simulated. Keep tests against actual `createIncremental` and Ink lifecycle
paths; a standalone encoder test is not integration evidence.

### Physical terminal gate

In Warp and Terminal.app, run the actual fullscreen incremental TUI and
check initial paint, streaming changes, narrow and oversized glyphs,
backgrounds, right-edge neighbors, bottom-right painting, resize, ordinary
output, and exit. Verify Ink-managed copy separately from native copy. Use
CPR where available; unsupported CPR does not prevent visual acceptance.

In Kitty, confirm normal OSC 66 selection still works and adds no seek-writer
CHA or DECAWM changes. Normal renderer cursor controls remain valid.

Record terminal/version and observed results. Do not claim compatibility for
untested terminals or treat a failed OSC 66 probe as successful qualification.
If neighbor damage, unexpected scrolling, or repaint corruption occurs, the
fallback must not ship enabled by default until the algorithm is corrected
and that case passes. Existing `INK_EXPLICIT_WIDTH=0` remains the opt-out;
there is no terminal-brand dispatch or substitute width table in this design.

### Delivery boundary

Implement and verify in this order: incremental row writer, physical-frame
and resize handling, capability/lifecycle integration, then physical terminal
acceptance. The design is ready to implement within the bounded scope above;
implementation and verified Warp/Terminal.app rendering remain separate work.

## Review evidence and references

A temporary review check with `@xterm/headless` 6.0.0 reproduced the stale-cell
and final-column-erase failures and verified styled prefill. The proposed row
algorithm also passed oversized-to-narrow transitions, bottom-right wide-glyph
painting without scrolling, and isolated changed-row updates. The emulator
showed primary-screen reflow with DECAWM disabled; an absolute viewport repaint
restored the intended rows while retaining saved history. Ordinary output
also survived fullscreen restoration in primary-screen history.
These are emulator observations,
not physical Warp/Terminal.app acceptance or tests of an implemented Ink fix.

- [OSC 66 plan](../plans/2026-09-06-explicit-width.md)
- [OSC 66 handoff](../handoffs/2026-09-06-explicit-width.md)
- [OSC 66 verification](../reports/2026-09-06-explicit-width-verification.md)
- [Kitty text-sizing protocol](https://sw.kovidgoyal.net/kitty/text-sizing-protocol/)
- [Xterm control sequences](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
