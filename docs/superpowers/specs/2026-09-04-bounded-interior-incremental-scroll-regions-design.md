# Bounded Interior Incremental Scroll Regions Design

**Date:** 2026-09-04  
**Status:** Approved — user-approved direction and powerful-tier written-spec review complete
**Area:** `packages/ink` incremental renderer, outer CLI MessageList and ToolDetailModal verification

## 1. Objective

Keep Ink's low-byte terminal-assisted vertical scrolling while ensuring a detected transcript or modal-content shift never moves fixed rows outside that scrollable band, even temporarily.

The correction must eliminate the observed one-frame flash of transcript content behind the composer in Terminus/Tabby over SSH and provide the same intermediate-state guarantee for ToolDetailModal's Program header/status, tab strip, CLOSE row, `j/k … Esc close` footer, and surrounding application rows.

## 2. Confirmed failure

Production enables Ink `incrementalRendering` at 60 FPS. During a MessageList scroll, `log-update.ts` detects that most frame rows moved vertically and emits:

- `CSI n M` to delete lines and shift following rows upward; or
- `CSI n L` to insert lines and shift following rows downward.

The implementation positions the operation at the first shifted row but leaves the terminal's scrolling margins at their full-screen defaults. `CSI M/L` therefore also moves every physical row below the transcript band, including the composer or modal footer. The ordinary diff rewrites those rows later in the same output buffer, so the final terminal state is correct.

Ink wraps interactive writes with synchronized-output mode 2026 where it assumes a TTY. Terminus/Tabby currently uses xterm.js 5.4, which does not implement that mode, so it displays the incorrect intermediate state before the footer is restored.

The diagnosis was confirmed by launching Nuvin with:

```sh
NUVIN_INK_NO_SCROLL_OPT=1 nuvin
```

The flash disappeared. VLBox cell clipping was not the cause.

## 3. Goals

- Preserve the `CSI M/L` optimization for qualifying vertical shifts.
- Constrain each optimized operation with DECSTBM top/bottom margins covering only the detected moving band.
- Keep fixed prefix and suffix rows physically unchanged throughout every intermediate terminal state.
- Cover both MessageList + Composer and ToolDetailModal scrolling through production incremental rendering.
- Preserve existing cursor, resize, trailing-newline, cache, terminal-clear, and transform/layout behavior.
- Keep the environment escape hatch.
- Retain the existing renderer, visitation, output-parity, and latency performance gates.

## 4. Non-goals

- Horizontal scrolling optimization. `CSI M/L` operates on terminal rows only.
- Public component, renderer, MessageList, Composer, ScrollBox, or ToolDetailModal API changes.
- Multiple simultaneous terminal scroll regions in one frame update. If one safe band cannot explain the update, use positional diffing.
- Capability negotiation for synchronized-output mode 2026.
- Depending on synchronized output for correctness.
- Replacing the line cache with LCS or a generalized terminal scene graph.
- Changing VLBox layout, culling, sticky, selection, accessibility, or pointer behavior.

### 4.1 Release staging boundary

The nested Ink correction is implemented, tested, reviewed, and committed first. The outer repository must not commit regressions that require unpublished Ink behavior while its committed dependency remains `npm:@nuvin/ink@7.5.0-alpha` and the local `link:packages/ink` override remains development-only.

Before publication, real MessageList + Composer and ToolDetailModal coverage runs through ignored `.superpowers/sdd/` validation artifacts against the built local Ink link. Their source, exact commands, terminal snapshots, byte comparisons, and results are retained in the implementation handoff but are not staged in the outer repository.

After `@nuvin/ink@7.6.0-alpha` is published and the outer dependency and lockfile are atomically updated, those validated fixtures are promoted into tracked outer regression tests. Publication, pinning, and promotion remain a separate user-approved release task.

## 5. Selected approach

Use DECSTBM (`CSI top;bottom r`) around every accepted `CSI M/L` operation.

The shift descriptor becomes:

```ts
type ScrollShift = {
	/** Positive: content moved up; negative: content moved down. */
	rows: number;
	/** Zero-based first row in the moving band. */
	start: number;
	/** Zero-based exclusive end row in the moving band. */
	end: number;
};
```

Rows `[0, start)` and `[end, height)` are outside the terminal mutation. The latter includes the composer, modal CLOSE/footer rows, or other stable chrome.

### 5.1 Why DECSTBM

DECSTBM and margin-bounded `CSI M/L` are supported by xterm.js 5.4 and established VT terminal behavior. SSH transports the byte stream and does not change those local terminal semantics.

This keeps the performance advantage of terminal-assisted row movement. Disabling shifts around fixed suffixes would retransmit most transcript rows on each wheel step; disabling shifts globally would discard the optimization entirely.

### 5.2 Why synchronized output remains optional

Mode 2026 may still hide multi-command updates on supporting terminals, so existing BSU/ESU wrapping remains. The bounded mutation is independently correct when a terminal ignores those sequences, as Terminus/Tabby currently does.

## 6. Safe band detection

Detection remains private to incremental `log-update` and uses exact ANSI-preserving line equality.

For each candidate shift magnitude `k = 1..min(32, height - 1)` and direction:

1. Identify the unchanged positional prefix before the shifted evidence.
2. Identify the unchanged positional suffix after the shifted evidence.
3. Define `[start, end)` so the candidate's shifted matches and its `k` newly exposed edge rows are inside the band.
4. Compare shifted rows only inside that band:
   - up: `next[i] === previous[i + k]`;
   - down: `next[i] === previous[i - k]`.
5. Require the existing total matched-core threshold of at least half the frame and an at-least-threshold span from the first to last non-positional shifted match. Holes inside that established band remain allowed and are repaired by the ordinary diff.
6. Require every row outside `[start, end)` to be positionally unchanged. Any uncertain boundary rejects the candidate.
7. Prefer the smallest qualifying `k`, preserving current behavior.

Mismatched rows inside the established band are allowed only under the existing threshold and are repaired by the ordinary diff. They cannot affect protected rows outside the DECSTBM margins.

A whole-frame shift may use `[0, height)`. An interior shift must have a valid bounded end derived from the shifted core and protected suffix; if that boundary is ambiguous, the optimization is rejected.

This is intentionally conservative. A frame with simultaneous footer/chrome changes may fall back to positional diffing rather than risk including those rows in the terminal mutation.

## 7. Terminal emission

For an accepted zero-based band `[start, end)` and shift magnitude `k`:

1. Emit the existing return-to-frame prefix.
2. Install DECSTBM margins using one-based inclusive rows:

   ```text
   CSI (start + 1);end r
   ```

3. Position the cursor at column 1, row `start + 1` with absolute CUP. DECSTBM can home the cursor, so emission must not depend on the previous cursor position afterward.
4. Emit `CSI k M` for content moving up or `CSI k L` for content moving down.
5. Reset margins immediately with `CSI r`.
6. Reposition the cursor at column 1, row `start + 1`, because resetting margins may home the cursor.
7. Continue through the existing positional diff loop from `start`.
8. Emit the existing committed-cursor suffix.

Set margins, line mutation, reset, edge-row repair, and cursor restoration remain in the same buffered `stream.write()` performed by `log-update`.

The reset is mandatory on every optimized path. No exception or early return may leave custom margins installed.

## 8. Cache simulation

The simulated previous frame must mirror the bounded terminal operation.

For an upward shift:

```text
prefix
+ previous band excluding its first k rows
+ k blank rows
+ unchanged suffix
```

For a downward shift:

```text
prefix
+ k blank rows
+ previous band excluding its last k rows
+ unchanged suffix
```

Only `[start, end)` changes in `diffPrevious`. The ordinary loop then rewrites newly exposed edge rows and any genuinely changed rows inside the band. Protected suffix rows compare equal and are neither shifted nor retransmitted when unchanged.

After the write, the normal `previousLines`, `previousOutput`, cursor, and physical-frame bookkeeping remains authoritative. A subsequent unrelated update must stay surgical.

## 9. Fallback and compatibility rules

The shift path remains disabled when any existing guard applies:

- `incremental` is disabled;
- `NUVIN_INK_NO_SCROLL_OPT=1`;
- an active committed cursor is present;
- either physical frame has a trailing newline;
- visible heights differ;
- this is the first frame or the cache was reset/cleared;
- the shifted core is below threshold;
- prefix, suffix, or band boundaries are uncertain.

Non-fullscreen output therefore never installs DECSTBM or emits `CSI M/L`. Full repaint, resize repair, static output, teardown, and terminal-clear branches remain unchanged.

DECSTBM predates the existing line insertion/deletion commands and is supported by the target xterm.js terminal. The existing escape hatch remains the operational fallback for terminals or intermediaries with broken scrolling-margin behavior.

## 10. Intermediate terminal-state model

Final emitted bytes are insufficient to test this defect because the old sequence restored the correct final frame. Tests need a terminal-cell model that processes commands in order and records state after each mutating operation.

The nested ASCII regression model must support the subset used directly by `log-update`:

- CUP / cursor positioning;
- cursor up and next-line movement used by the diff loop;
- erase-to-end-of-line;
- DECSTBM set/reset and their cursor-homing effects;
- `CSI n M` and `CSI n L` constrained by active margins;
- text runs and newline writes.

The real outer-surface oracle must additionally represent each terminal cell's grapheme, width/continuation state, and relevant SGR foreground/background/style attributes. It uses grapheme segmentation plus Ink-compatible `string-width`, models combining and width-two cells, delayed right-margin autowrap, SGR reset/erase attributes, skips OSC, and explicitly ignores only known non-cell-mutating private modes such as synchronized output and cursor visibility. Unknown control sequences fail the validator.

For every intermediate snapshot, complete styled cells outside the detected band must remain unchanged unless the ordinary diff explicitly rewrites a row because its desired content changed. Final parity compares complete cell grids with an identical no-scroll-optimization scenario. Deterministic payload gates measure UTF-8 bytes with `Buffer.byteLength`, not JavaScript code-unit length.

These models intentionally implement only the terminal subset emitted by the fixtures; ANSI-color, CJK width-two, emoji/grapheme, combining-mark, and delayed-autowrap self-tests pin that subset before real validation.

## 11. Verification strategy

All implementation follows red-green-refactor sequencing.

### 11.1 Nested Ink unit and terminal-cell tests

Add or update `test/log-update-scroll-region.ts` coverage for:

1. Interior upward shift: fixed header and multi-row footer never move in any intermediate state.
2. Interior downward shift: same guarantee.
3. Changed footer/chrome: reject the optimization when a safe boundary cannot be proven, or rewrite it without ever moving it.
4. Full-frame shift: still uses optimized `CSI M/L` with full-frame margins.
5. Margin lifecycle: every set has a reset in the same write, and the terminal model ends with full-screen margins.
6. Cache correctness: the next single-line change remains surgical.
7. Existing guards: cursor, height, trailing newline, changed prefix, threshold, and environment escape hatch retain their behavior.
8. Byte efficiency: shifted core text does not appear in the update payload.

Existing tests that expect the footer to be shifted and restored must be changed to the stronger invariant: the footer is excluded from the mutation and need not be restored when unchanged.

### 11.2 Real MessageList + Composer regression

Use the real MessageList/VirtualizedList scroll path in a fullscreen incremental Ink render with a fixed composer below it.

Capture actual stdout bytes for a controlled wheel/programmatic scroll and apply them to the terminal-cell model. Assert for every intermediate state:

- transcript rows remain inside the message viewport;
- composer rows never contain transcript cells;
- composer status, prompt/input, notification, and boundary rows remain stationary when unchanged;
- final output equals the renderer's intended frame;
- an optimized bounded shift was used for the qualifying fixture.

The existing `MessageList.sticky-bottom-flash.test.tsx` paint-frame assertions remain, but they are not sufficient alone because they do not model intermediate terminal commands.

### 11.3 Real ToolDetailModal regression

Render the real overflowing Program ToolDetailModal with child calls through production incremental Ink mode. Switch from the initial Calls tab to Details, scroll its VLBox/ScrollBox viewport, and apply captured stdout bytes to the terminal-cell model.

Assert for every intermediate state:

- the `Program` header and status remain fixed;
- the Calls/Details tab strip, CLOSE row, and `j/k … Esc close` footer remain fixed;
- blank application rows outside the centered panel never receive result cells;
- scrollbar changes are repaired within the bounded content region;
- final terminal cells match an independent no-scroll-optimization render of the identical scenario;
- qualifying scrolls retain bounded `CSI M/L` rather than full row retransmission.

### 11.4 Regression suites

Run focused and full nested Ink log-update/render/output tests, the outer MessageList and ToolDetailModal/ScrollBox suites, and exact-frame snapshots affected by control-sequence expectations.

## 12. Performance gates

Correctness gates:

- zero intermediate mutations outside the detected band;
- exact final terminal-cell parity;
- DECSTBM reset after every optimized write;
- existing output checkpoints and renderer visitation limits remain green.

Efficiency gates:

- shifted core lines are not retransmitted;
- unchanged fixed suffix rows are not retransmitted;
- control overhead is constant per shift and independent of viewport height;
- nested `benchmark:vlbox -- --samples=30 --release-check` remains green;
- the explicitly interactive ignored MessageList and Program-modal validators each emit at most 50% of the matching no-scroll-optimization bytes for a qualifying step;
- outer ToolDetailModal release benchmark remains within its existing gate.

Because host timing is noisy, byte-count and shifted-core non-retransmission are the primary deterministic performance assertions. Timing benchmarks are corroborating gates using the existing sample counts and thresholds. The tracked real-list benchmark does not currently force interactive rendering, so correcting and promoting its durable DECSTBM/byte gate is deferred to the publish/pin follow-up rather than used as pre-publication evidence.

## 13. Rollout and diagnostics

`NUVIN_INK_NO_SCROLL_OPT=1` remains documented and tested. It disables both DECSTBM and `CSI M/L`, selecting legacy positional diffing.

No new user-facing option is added. If a terminal has faulty DECSTBM behavior, the existing environment variable provides immediate mitigation without splitting production code paths by terminal brand.

## 14. Alternatives considered

### Disable shifts when a fixed suffix exists

Rejected as the default because MessageList + Composer and ToolDetailModal are primary scrolling surfaces. Repainting most viewport rows would sacrifice the optimization where users need it most.

### Disable shifts globally

Rejected because it restores full-frame positional repaint cost and contradicts the performance objective.

### Rely on synchronized-output mode 2026

Rejected as a correctness mechanism. Terminus/Tabby's current xterm.js does not implement it, and synchronized output would only hide an incorrectly scoped mutation rather than constrain it.

### Pass component-owned viewport regions into `log-update`

Deferred. Explicit renderer provenance could support more complex or simultaneous regions, but it would cross renderer/log-update APIs and is unnecessary for the confirmed single-band frame shifts. Conservative detection plus fallback keeps this repair private and minimal.

## 15. Related specifications and references

- [`2026-08-21-incremental-scroll-region-design.md`](./2026-08-21-incremental-scroll-region-design.md) — establishes vertical-shift detection, low-byte scrolling, cache simulation, and the escape hatch. Its DECSTBM emission intent was not preserved by the later `CSI M/L` implementation; this design supersedes its emission and intermediate-state guarantees.
- [`2026-08-09-incremental-rendering-state-repair-design.md`](./2026-08-09-incremental-rendering-state-repair-design.md) — defines physical-frame/cache ownership, cursor baselines, fullscreen/trailing-newline transitions, resize repair, and synchronized write boundaries that must remain intact.
- [`2026-09-04-vlbox-retained-layout-viewport-culling-design.md`](./2026-09-04-vlbox-retained-layout-viewport-culling-design.md) — defines paint-only VLBox scrolling, output parity, visitation limits, and the ToolDetailModal integration whose terminal update must remain bounded.
- [`../../../../../docs/superpowers/specs/2026-08-13-expansion-scrollbar-stability-design.md`](../../../../../docs/superpowers/specs/2026-08-13-expansion-scrollbar-stability-design.md) — defines MessageList disclosure/scrollbar anti-flash ownership that must not regress.
- [VT510 DECSTBM](https://vt100.net/docs/vt510-rm/DECSTBM.html) — specifies top and bottom scrolling margins.
- [xterm.js 5.4 `InputHandler.ts`](https://github.com/xtermjs/xterm.js/blob/5.4.0/src/common/InputHandler.ts) — implements DECSTBM and margin-bounded insert/delete-line handling used by Terminus/Tabby.
- [xterm.js synchronized-output issue #3375](https://github.com/xtermjs/xterm.js/issues/3375) and [implementation PR #5453](https://github.com/xtermjs/xterm.js/pull/5453) — establish that mode 2026 is not available in the xterm.js generation currently used by Tabby.
