# VLBox usage and bounded-scroll performance

This document explains where `VLBox` is used, how its viewport-culling optimization differs from Ink's bounded terminal-scroll optimization, and the performance evidence recorded on 2026-09-04 for nested Ink revision `b0c28f9`.

## What VLBox is

`VLBox` is Ink's viewport-culling variant of `Box`:

```tsx
const VLBox = createBoxComponent('VLBox', true);
```

The second argument enables internal viewport-culling behavior. A `VLBox` retains its content tree for layout, measurement, scrolling, selection, and sticky-row behavior while avoiding paint traversal for content outside the visible viewport.

Implementation and exports:

- `src/components/VLBox.tsx`
- `src/components/Box.tsx`
- `src/layout-metadata.ts`
- `src/render-node-to-output.ts`
- `src/index.ts`

## Production usage

The nuvin-agent CLI directly uses `VLBox` in its shared `ScrollBox` implementation:

```tsx
<VLBox
  ref={viewportRef}
  flexDirection="column"
  width={viewportInnerWidth}
  height="100%"
  overflow="scroll"
>
  {content}
</VLBox>
```

Source: `../cli/src/components/ComboBox/ScrollBox.tsx`.

Components that render `ScrollBox` therefore use `VLBox` indirectly, including:

- `ToolDetailModal`
- `ComboBox`
- `ApprovalModal`
- `MasterDetail`
- `BashPersistentPermissionEditor`

In `ToolDetailModal`, the `VLBox` is the Details content viewport. Its host ref also supplies mouse-selection bounds and the authoritative scroll position.

### MessageList distinction

`MessageList` does **not** use `VLBox` directly. It uses `@nuvin/ink-virtualized-list`, which calculates a visible item range, renders only that item slice, and positions it inside ordinary `Box` elements.

This distinction matters when interpreting the results:

- The nested `benchmark:vlbox` command measures `VLBox` layout and paint culling directly.
- The ToolDetailModal benchmark exercises `VLBox` through `ScrollBox`.
- The MessageList validator exercises `VirtualizedList`, not `VLBox`.
- Bounded DECSTBM byte reductions measure terminal-update efficiency and are not solely attributable to `VLBox`.

## Two complementary optimization layers

### 1. VLBox viewport culling

`VLBox` reduces renderer work by skipping off-screen paint traversal while preserving the state needed for scrolling and visible sticky content.

The relevant pipeline is:

1. `VLBox` opts its host node into internal viewport culling.
2. Layout metadata records content extents and sticky candidates.
3. The renderer intersects subtree paint bounds with the active viewport.
4. Off-screen subtrees are omitted from paint traversal.

### 2. Bounded terminal scrolling

The bounded-scroll change optimizes terminal output after rendering. When Ink detects a safe vertical shift, it emits one buffered operation:

```text
DECSTBM set → absolute CUP → CSI M/L → DECSTBM reset → absolute CUP
```

The terminal mutation and Ink's cache simulation are restricted to the detected `[start, end)` content band. Rows before and after that band remain physically stationary throughout the write.

This layer reduces bytes sent to the terminal and prevents transient MessageList content from moving through Composer or ToolDetailModal chrome. It is implemented in `src/log-update.ts` and covered by `test/log-update-scroll-region.ts`.

## Recorded performance results

All timing measurements below are host-sensitive. Byte counts, protocol cardinality, sentinel absence, and styled-cell parity are the primary deterministic evidence.

### Direct VLBox benchmark

Command:

```bash
cd packages/ink
npm run benchmark:vlbox -- --samples=30 --release-check
```

Large 6,000-row fixture at `424×95`:

| Implementation | Render median | Wall median | Maximum renderer visits |
|---|---:|---:|---:|
| Box | 41.288 ms | 60.641 ms | 28,364 |
| VLBox | 6.451 ms | 6.714 ms | 453 |

Recorded release-check results:

- Renderer median speedup: **6.40×**
- Wall-median ratio: approximately **9.03×**
- VLBox visits: **453**, below the `600` limit
- Layout epoch delta during scrolling: **0**
- Output checkpoints: **MATCH**
- Release check: **PASS**

### ToolDetailModal wall-clock corroboration

Command:

```bash
corepack pnpm benchmark:vlbox-tool-detail -- --samples 30 --release-check
```

| Measurement | Pre-change baseline | Current | Change |
|---|---:|---:|---:|
| Wall median | 16.97 ms | 16.11 ms | **5.07% lower** |
| Wall p95 | 20.50 ms | 18.44 ms | **10.05% lower** |
| Render median | 16.56 ms | 15.78 ms | **4.71% lower** |
| Render p95 | 20.18 ms | 18.09 ms | **10.36% lower** |

The strict release gate is wall median `<=16 ms`. Both measurements failed that unchanged absolute gate:

- Pre-change: `16.97 ms` — **FAIL**
- Current: `16.11 ms` — **FAIL** by `0.11 ms`

The current run is an improvement over the same-machine baseline, so it does not show a change-related regression. It must not be described as a passing release result, and a release requiring every absolute gate remains blocked until the timing gate is separately resolved or dispositioned.

### Deterministic bounded-scroll output

The pre-publication real-surface validators compare one qualifying optimized logical event with the identical sequential scenario under `NUVIN_INK_NO_SCROLL_OPT=1`.

| Surface | Optimized bytes | Fallback bytes | Ratio | Reduction |
|---|---:|---:|---:|---:|
| MessageList + Composer | 156 | 731 | 0.213 | **78.7%** |
| Program ToolDetailModal | 218 | 2,188 | 0.100 | **90.0%** |

Both validators additionally establish:

- exact final styled-cell, cursor, and margin parity;
- fixed rows unchanged in every intermediate terminal snapshot;
- exactly one DECSTBM set, two total absolute CUP operations, one `CSI M` or `CSI L`, and one DECSTBM reset;
- no movement-proven shifted-core sentinel in the decoded complete optimized write range, including ANSI-interleaved and cross-write cases;
- identical recorded input for optimized and fallback runs;
- UTF-8 accounting through `Buffer.byteLength(..., "utf8")`.

These byte reductions and the 5.07% wall-median improvement answer different questions and must not be combined into one percentage. The byte results isolate terminal-update efficiency; the timing benchmark measures the complete host rendering and terminal-output path.

## Reproduction and validation

Build and run the committed nested gates:

```bash
cd packages/ink
NODE_ENV=test npm test
npm run build
npm run benchmark:vlbox -- --samples=30 --release-check
```

Run the outer ToolDetailModal corroborating benchmark from the repository root:

```bash
corepack pnpm benchmark:vlbox-tool-detail -- --samples 30 --release-check
```

The real MessageList and Program-modal terminal validators currently remain ignored/local under:

```text
.superpowers/sdd/bounded-scroll-validation/
```

They must remain local until the verified Ink package is published and the outer repository atomically pins that version. At that point, the terminal model and production validators should be promoted into tracked CLI tests, and the tracked virtualized-list benchmark should explicitly enable interactive rendering and enforce deterministic DECSTBM and byte-integrity checks.

## Related documents

- `docs/superpowers/specs/2026-09-04-bounded-interior-incremental-scroll-regions-design.md`
- `docs/superpowers/plans/2026-09-04-bounded-interior-incremental-scroll-regions.md`
- `test/log-update-scroll-region.ts`
- `src/log-update.ts`
