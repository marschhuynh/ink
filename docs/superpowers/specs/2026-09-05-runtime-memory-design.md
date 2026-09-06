# Ink runtime memory: behavior-preserving internals

Date: 2026-09-05
Status: Approved for implementation planning on 2026-09-05; implementation and release are not authorized.
Parent: [TUI runtime-memory roadmap](../../../../../docs/superpowers/specs/2026-09-05-tui-runtime-memory-design.md)

## 1. Purpose and boundary

Reduce Ink's text-cache retention, raster allocation pressure, and root Yoga lifecycle overhead without changing the renderer's output, public selection contracts, terminal transitions, or user interaction. This companion owns Ink tasks in phases 2 and 3 of the parent roadmap. Later phase 4/5 work must not assume new Ink APIs from this document.

The working nested package and installed CLI dependency were both version 7.6.0-alpha during review. They are distinct resolutions; build and verify the intended one for every measurement.

Non-goals: replacing log-update, changing static-output retention, lowering FPS, deferring frames, changing VLBox semantics, redesigning layout metadata, adding public configuration, or changing source-text/selection availability.

## 2. Current source and scaling

- `src/measure-text.ts`: global 256-entry Map retains full text keys.
- `src/wrap-text.ts`: global 256-entry Map stores JSON keys containing source text and wrapped-result values. Entry count does not bound retained text bytes.
- `src/renderer.ts`: creates a new Output per normal paint, sized to the Yoga root.
- `src/output.ts:233`: initializes a distinct blank StyledChar and empty styles array per cell plus boolean mask rows.
- `src/renderer.ts:85` and `src/text-selection-controller.ts:226`: capture plain rows/masks for selection; selection is not merely an optional active-drag feature.
- `src/text-selection.ts:16`: exported SelectionRow has `mask?: readonly boolean[]`. `isCharSelectable` tests strict boolean false. Passing Uint8Array values directly would change semantics.
- `src/ink.tsx:940`: ordinary React teardown does not explicitly free the separately created root Yoga node. `src/render-to-string.ts:114` demonstrates the separate root-free ownership step after child teardown.

The blank grid allocates O(width x height) objects and style arrays per frame. Frame caches are generally current-frame-sized, not growing transcript histories. Root cleanup concerns one Yoga node per Ink instance, not one node per frame. Do not conflate these mechanisms in performance claims.

## 3. Cross-cutting invariants

1. Identical committed node trees/options must produce identical output and terminal transitions.
2. Blank cells, parsed cells, and cached selection rows may be shared only when immutable under all writers.
3. Previously returned selection data remains stable across later paints, resize, scroll, and teardown.
4. Public exports and boolean-mask semantics remain unchanged.
5. Wide glyph leading/trailing cells, zero-width/combining text behavior, ANSI styles, backgrounds, clipping, selectable flags, and selected whitespace preserve current results.
6. Screen-reader rendering, debug rendering, normal/incremental rendering, and alternate-screen lifecycle remain supported as before.
7. No generic catch/recovery paths, background GC loops, public tuning flags, or unrelated refactoring.

## 4. Work unit I: bound text caches by size

Retain existing measurement/wrapping functions and algorithms. Add a retained-text accounting ceiling and maximum entry size in addition to the existing count ceiling. Account for source-containing keys and wrapped values conservatively; source/result sharing must not be assumed to eliminate memory ownership.

Use the parent roadmap's calibration procedure to choose and record concrete internal constants before accepting the implementation. Expose diagnostic accounting in the same internal/test-only manner as current cache-size helpers; no new public configuration API.

Required behavior:

- Oversized inputs compute normally without entering the cache.
- Hits, replacements, LRU eviction, and clearing leave accurate nonnegative accounting.
- Unicode is accounted consistently using a documented conservative code-unit estimate, not `Buffer.byteLength` mislabeled as V8 heap size.
- Empty string values must not accidentally alter semantics or accounting.
- Preserve key distinction for every source, width, and wrap mode. Do not introduce hash-collision rendering risks to reduce key size.
- Prefer bounding the current representation before redesigning keys. A nested-map/key optimization needs an independent measured benefit.

Verification: extend `test/text-cache.ts` with large inputs, Unicode, mode/width distinctions, replacement/eviction, oversize bypass, and cache/no-cache parity. Compare warm scroll/render latency and post-GC retention. Reducing counts alone is not sufficient proof.

## 5. Work unit II: immutable blank-cell sharing

Create one private blank-cell value with a shared immutable empty-style list and initialize row slots with references to it. Written cells and selection highlights replace grid entries rather than modifying shared cells or their style arrays.

Before implementation, inspect all grid writers, wide-character repair, paintSelection, transformers, and serialization. Type-level readonly or a cast is not proof of runtime safety. Freeze the singleton and its style list where compatible with the existing cell representation; use tests to detect accidental mutation.

Each row remains independently writable. Do not share mutable row arrays or reuse a row after it has escaped to a consumer. No general object pool is introduced by this work unit.

Verification:

- White/blank space, padding, borders, backgrounds, clipping, empty terminal, and selected blank rows are output-identical.
- Painting/highlighting one blank cell cannot change any other cell or later frame.
- Wide glyph overwrite/repair and mixed styled/unstyled cells remain correct.
- Allocation evidence shows removal of per-blank-cell objects/style arrays for equal frame counts.
- Treat this as an allocation-pressure optimization. It need not reduce retained transcript heap.

## 6. Work unit III: compact private masks, preserve public booleans

Use a private raster mask representation, initially Uint8Array rows rather than bitsets. This is a smaller change than packing individual bits. All raster write sites and paintSelection readers must explicitly interpret 0/1 values correctly.

Keep `SelectionRow.mask` and other exported selection contracts boolean-based. Convert numeric masks to booleans once at the existing selection-row capture boundary, cropped to the necessary viewport segment. Avoid constructing a complete temporary full-width boolean mask and then slicing it. Preserve missing-mask behavior, out-of-range defaults, and immutable row ownership.

Do not return Uint8Array as a boolean array via a type assertion. Do not expose mutable shared views into a reusable output buffer. Keep the public selection functions on their existing boolean contract; do not introduce a duplicate selection algorithm.

Scope is the private frame mask and redundant intermediate copies. A canonical cross-frame selection-buffer redesign is deferred. If conversion makes this candidate neutral or slower without a meaningful memory benefit, retain boolean raster masks and ship only the independently proven work units.

Verification:

- `false`/`true`, omitted masks, clipped mask ranges, and out-of-range cells match the old implementation.
- Selection start/update/end, select-all/copy, active drag during scroll/resize, viewport switching, and cached offscreen rows match.
- Captured snapshots remain unchanged after subsequent frames and teardown.
- Public type/build fixtures continue to accept `readonly boolean[]` unchanged.
- Allocation/retention evidence includes conversion costs, not only the smaller raster buffer.

## 7. Work unit IV: root Yoga disposal

Treat child Yoga nodes and the root as separate owners. After synchronous React unmount, required passive-effect cleanup, and all final layout-dependent rendering are complete, free the root exactly once. Preserve existing finishUnmount behavior, terminal writes, and waitUntilExit resolution.

Audit both supported reconciler modes, repeated unmount/cleanup calls, pending throttles/timers, root callbacks, and final output paths. Clearing references or callbacks is permitted only after no supported operation can use them. A root-free exception or use-after-free must not be silently swallowed.

Add deterministic lifecycle tests observing root allocation/free calls or the existing Yoga instrumentation where available. Cover normal, concurrent, double-unmount/cleanup, pending scheduled work, and error teardown. Repeated mount/unmount profiling supplements these tests; RSS is not a reliable per-node free counter because WASM/native allocators can retain capacity.

Do not alter the independently correct `renderToString` root-free behavior or double-free its root.

## 8. Verification matrix and acceptance

Reuse current suites, extending focused fixtures as needed:

- `test/text-cache.ts`
- `test/output-rows.test.ts`
- `test/paint-selection.test.ts`
- `test/text-selection.test.ts`
- `test/text-selection-controller.test.ts`
- `test/text-selection-hook.test.tsx`
- `test/render-to-string.tsx`
- Existing render/unmount, log-update, bounded-scroll-region, and VLBox tests.

Then run outer real MessageList+Composer and ToolDetailModal fixtures against the rebuilt local Ink. Include normal/wide geometries, Unicode, active selection, nested/sticky content, resize, and alternate-screen exit.

Follow the parent measurement discipline: production React, intended incremental path, bounded stdout capture, warmups, repeated isolated runs, retained heap separate from allocation/peak/RSS, no forced GC inside timed frame loops. Unchanged output/interaction is mandatory; repeatable latency regression or inconclusive evidence blocks acceptance. Existing benchmark gates remain in force.

Do not update canonical screenshots/frames to excuse changed output. No candidate is accepted solely because text-cache counts or Node tests pass.

## 9. Repository, build, and release sequence

1. Write and review the nested implementation plan; reference parent roadmap task IDs.
2. During later authorized implementation, isolate the nested repository separately from any outer worktree.
3. Run nested npm build and focused AVA tests before consumers.
4. Link the built local Ink only for development integration. Record resolution and keep override/lockfile link changes out of commits.
5. Run outer pnpm builds/tests in producer-before-consumer order; do not mistake the published package for the changed nested build.
6. Request independent review of correctness and measurement evidence for each work unit and the combined result.
7. Publication, pin/lockfile updates, and tracked outer tests that depend on unpublished APIs/behavior require a separately authorized release step. Do not land consumers requiring a version that has not been published.

The current task is planning-only. No commit, push, package publication, or release action is authorized by the roadmap approval.

## 10. Related specifications

- [Parent TUI runtime-memory roadmap](../../../../../docs/superpowers/specs/2026-09-05-tui-runtime-memory-design.md): phase ordering, content/UX contract, cache calibration, benchmark gates, and outer integration.
- [VLBox retained-layout culling](2026-09-04-vlbox-retained-layout-viewport-culling-design.md): all children stay mounted; memory work must not change arbitrary layout, sticky ordering, selection, or pointer behavior.
- [Bounded interior scroll regions](2026-09-04-bounded-interior-incremental-scroll-regions-design.md): intermediate terminal correctness and publication/pinning boundary.
- [Incremental rendering state repair](2026-08-09-incremental-rendering-state-repair-design.md): logical/physical frame, resize, trailing newline, and cursor repair invariants.
- [Incremental scroll region design](2026-08-21-incremental-scroll-region-design.md): existing diff/scroll optimization context; algorithm changes are outside this memory phase.
