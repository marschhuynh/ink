# VLBox retained-layout viewport culling design

**Date:** 2026-09-04  
**Status:** Approved design  
**Area:** `packages/ink`, with initial integration in `packages/cli`

## 1. Problem

The CLI tool-detail modal can display results hundreds of kilobytes long. Its Details pane
currently uses the passive `ScrollBox`, which mounts and lays out the complete ARGS, SOURCE,
and RESULT tree. The custom Ink fork clips output correctly, but scrolling still pays work
proportional to the complete retained tree:

1. `Box.scrollTo()` updates React state through `setScrollVersion`.
2. The resulting commit runs the root Yoga `calculateLayout()`.
3. `renderNodeToOutput()` recursively visits every child, including fully clipped subtrees.
4. `Output` discards clipped writes only after text squashing, width measurement, wrapping,
   backgrounds, borders, and descendant traversal have already occurred.
5. `Box.getContentDimensions()` recursively walks the complete subtree whenever an imperative
   scroll operation needs its maximum offset.

The existing item-based `@nuvin/ink-virtualized-list` solves a different problem: it gives
strict bounded mounting when callers provide keyed items, height estimates, and a renderer.
It cannot be a drop-in replacement for an arbitrary Ink `Box`, because unmounted flex
children have no Yoga geometry.

## 2. Goals

- Add a public, Box-compatible `<VLBox>` viewport to the Ink fork.
- Preserve arbitrary Ink/Yoga child layout exactly: rows, columns, flex growth and shrink,
  wrapping, percentages, absolute positioning, nested overflow, z-index, and sticky nodes.
- Make an imperative scroll a paint-only invalidation: no React reconciliation and no Yoga
  layout when content and terminal geometry are unchanged.
- Skip Yoga calculation after React commits whose host changes leave the Yoga root clean.
- Cull fully off-screen subtrees before expensive renderer traversal.
- Cache content extents and culling metadata per layout generation.
- Preserve pointer targeting, text selection, accessibility, and incremental rendering.
- Integrate the primitive into CLI `ScrollBox` so the tool-detail modal benefits without a
  modal-specific section/chunk model.

## 3. Non-goals

- Strict bounded React component count, Yoga node count, or initial-layout memory.
- Replacing the item-based `@nuvin/ink-virtualized-list` for data-driven lists.
- Parsing or chunking Markdown, tool results, or other application content.
- Adding wheel, keyboard, focus, follow-end, or scrollbar behavior to `VLBox`.
- Changing terminal frame diffing or the incremental scroll-region algorithm.
- Changing current `Box` behavior for callers that do not opt into `VLBox`.
- Culling screen-reader output.

## 4. Terminology and guarantees

`VLBox` uses **retained-layout virtualization**:

- Every child remains mounted and participates in Yoga, preserving arbitrary layout.
- After a layout, scroll-only frames visit and paint only viewport-intersecting normal
  subtrees plus visible indexed sticky candidates.
- Initial mount and content-changing layout remain O(total retained tree size).
- Warm scrolling is bounded by visible paint complexity rather than total content paint
  complexity, subject to conservative fail-open cases.

This is intentionally distinct from strict item virtualization, which removes off-screen
React and Yoga nodes and therefore requires an explicit item/measurement contract.

## 5. Locked decisions

| Decision | Choice |
|---|---|
| Public primitive | `VLBox` exported from `ink` |
| Props | Same public props as `Box` |
| Ref | `VLBoxRef` is a type alias of `BoxRef` |
| Layout model | Retain all children in React and Yoga |
| Scroll invalidation | Direct host offset mutation + root throttled paint invalidation |
| Layout execution | Call Yoga only when terminal width changes or the Yoga root is dirty |
| Layout cache lifetime | Root `layoutEpoch` plus targeted dirty rebuilds for metadata-sensitive Yoga-clean host changes |
| Culling unit | Complete host subtree plus visible-row clipping for straddling surfaces |
| Bounds | Cached subtree paint bounds, including absolute and overflow-visible descendants |
| Sticky handling | Per-scroll-container indexed sticky candidates; sticky subtrees remain cullable |
| Transform classification | Ink `Text` styling is geometry-preserving; public `Transform` is unbounded and fails open |
| Uncertain geometry | Fail open and traverse normally |
| Screen readers | Render complete semantic tree; culling disabled |
| Input/scrollbar ownership | Existing higher-level controllers such as CLI `ScrollBox` |
| First integration | `ScrollBox` uses `VLBox`, immediate imperative offset updates, and a fixed-geometry scrollbar |
| Ink release | Publish `@nuvin/ink@7.6.0-alpha`, then update outer pins |

## 6. Public API

```tsx
import {VLBox, type VLBoxRef} from 'ink';

const viewportRef = useRef<VLBoxRef>(null);

<VLBox
  ref={viewportRef}
  height={12}
  overflow="scroll"
  flexDirection="column"
>
  {children}
</VLBox>;
```

`VLBox` accepts the same layout, background, accessibility, and children props as `Box`.
It exposes the same methods:

```ts
type VLBoxRef = BoxRef;
```

- `scrollTo({x?, y?})`
- `getScrollPosition()`
- `scrollToTop()`
- `scrollToBottom()`
- `getBounds()`
- `getPaintOrder()`

Viewport culling activates only on axes whose resolved overflow is `scroll`. With no bounded
scroll axis, `VLBox` renders equivalently to `Box` and provides no culling benefit.

`VLBox` is a low-level viewport. It does not register input handlers or render a scrollbar.
Those concerns remain in composition layers such as CLI `ScrollBox`.

## 7. Component and host ownership

### 7.1 Shared Box implementation

`Box` and `VLBox` share one private implementation/factory in `packages/ink/src/components`.
The implementation receives an internal viewport-culling mode; public `Box` keeps that mode
disabled and preserves current behavior. Do not duplicate Box accessibility, background
context, ref, or style logic.

The `VLBox` host node carries an internal culling marker. This is renderer metadata, not a
public style and not a DOM attribute exposed to application code.

### 7.2 Root layout generation

The Ink root stores a monotonically increasing `layoutEpoch`. Before calling Yoga, the root
updates terminal width and checks whether width changed or `yogaNode.isDirty()` is true. Only
then does it call `calculateLayout()` and increment the epoch. A React commit that changes only
paint metadata or fixed-geometry scrollbar styling therefore repaints without invalidating
layout metadata. Terminal resize and layout-affecting host changes still calculate Yoga and
increment the epoch. Paint-only scroll invalidation does neither.

### 7.3 Cached host metadata

For the current epoch, host nodes may cache:

```ts
type Rect = {left: number; top: number; right: number; bottom: number};

type LayoutMetadata = {
  epoch: number;
  subtreePaintBounds: Rect;
  hasUnboundedTransform: boolean;
};
```

Each scroll container also caches:

```ts
type ScrollViewportMetadata = {
  epoch: number;
  contentExtent: {width: number; height: number};
  stickyCandidates: StickyCandidate[];
};
```

When the root contains a `VLBox`, the renderer runs one metadata prepass over each culling
viewport subtree before output traversal for a new layout epoch. The reconciler also marks the
metadata dirty when a Yoga-clean host update changes culling semantics or indexed paint order:
`zIndex`, `position` transitions involving sticky, resolved overflow mode, or the
public-Transform geometry marker. Such a commit rebuilds metadata without
calling Yoga. Paint-only color/transformer updates and imperative scroll do not mark it dirty.

The prepass computes subtree bounds, content extents, and sticky indexes. It is O(total retained
tree size) once per real layout or targeted metadata invalidation; output traversal can then
cull safely in that same frame, and warm scroll paints reuse the metadata. Roots without
`VLBox` skip the prepass.

## 8. Bounds and culling algorithm

### 8.1 Subtree paint bounds

Bounds are expressed in the owning node's unscrolled layout coordinate space. They union:

- the node's own Yoga border box;
- normal and absolute descendants;
- descendants that may paint outside an `overflow: visible` ancestor.

At an `overflow: hidden` or `overflow: scroll` descendant, escaped descendant bounds are
intersected with that descendant's clip. Display-none nodes contribute nothing.

Ink `Text` always installs an internal transformer for ANSI styling; that transformer does
not change measured geometry and must not disable culling. The public `Transform` component
can change output geometry and marks its host text as unbounded. A subtree containing an
unbounded transform is traversed normally rather than culled from inferred bounds. Correctness
wins over optimization.

### 8.2 Active viewport

When the renderer enters a `VLBox`, it computes the visible content rectangle from the Yoga
box minus borders on each scroll axis. A nested viewport intersects its rectangle with the
active ancestor clip. Existing `Output.clip()` operations remain in place as the final
cell-level correctness guard.

### 8.3 Early rejection

Before normal rendering of a child subtree:

1. Translate its cached subtree bounds through parent positions and active scroll offsets.
2. Compare only axes clipped by the active viewport.
3. If there is no intersection, return before marking paint order, squashing text, measuring
   width, wrapping, painting surfaces, sorting descendants, or recursively walking children.
4. If metadata is absent, stale, or uncertain, traverse normally and refresh metadata.

Visible children retain the existing per-parent z-index sort and paint order. A tall Box that
straddles the viewport is not rejected as a whole, so `renderBackground` and `renderBorder`
receive the active visible rectangle and generate only intersecting rows/columns. This avoids
O(total height) surface work while preserving the existing Output clip guard.

## 9. Sticky candidate indexing

Sticky descendants must remain correct even when their natural parent subtree is culled.
For every layout generation, metadata construction creates an ordered sticky index for each
scroll container:

```ts
type StickyCandidate = {
  node: DOMElement;
  parentOffset: {x: number; y: number};
  parentBounds: {top: number; bottom: number};
  parentIsViewport: boolean;
  transformers: OutputTransformer[];
  paintOrder: number;
};
```

Rules:

- Traverse children in the same per-parent z-index order as normal rendering.
- Register a sticky node with its nearest scroll-container ancestor.
- Entering a nested scroll container transfers ownership of nested candidates to that
  container; an outer viewport does not also register them.
- Cache the sticky node's parent offset, immediate parent bounds, whether that parent is the
  owning viewport itself, inherited transformer chain, and DFS paint order in the owning
  viewport's unscrolled border-box-local coordinate space. Yoga child offsets already include
  border/padding placement. This matches the existing `StickyNodeInfo`: `renderStickyNode`
  adds the sticky node's own Yoga left/top.
- Invalidate the complete index on a new layout epoch.

After visible normal content is painted, the scroll container processes its sticky index:

1. Build the sticky node's normal parent position by adding the cached parent offset to the
   live viewport origin and subtracting the live scroll offset.
2. For nested content parents, translate cached parent bounds by the same live origin and
   scroll offset. When the immediate parent is the viewport itself, use the viewport's live
   unscrolled container bounds, matching current traversal-time sticky behavior.
3. Pass those screen-space values to the existing sticky clamp exactly once.
4. Paint visible candidates in the same order as current traversal.
5. Refresh `internal_stickyRect` and current paint-epoch metadata.
6. Clear or invalidate stale sticky rectangles for candidates not visible this frame.

This replaces traversal-time sticky discovery only for `VLBox`. A nested normal `Box` scroll
container can be rejected as one complete subtree against the outer active viewport. Once that
container is visible and entered, ancestor culling is suspended for its descendants so the
nested container keeps current traversal-time sticky discovery, including naturally off-screen
sticky nodes. Its own clip prevents those descendants from escaping into the outer viewport.
A VLBox nested inside it establishes a new active culling viewport and indexed owner.

## 10. Paint-only scrolling

`VLBox` keeps the authoritative scroll offset on its host node. Its ref methods:

1. Normalize non-finite requested values to the current value for omitted axes and `0` for
   invalid supplied axes.
2. Obtain cached content extents for the current layout epoch, populating them once if needed.
3. Clamp offsets to `[0, maxScroll]`.
4. Update `internal_scrollOffset` directly.
5. Walk to the Ink root and invoke its existing throttled `onRender` callback.

They do not update React state. Consequently, scroll-only changes do not run reconciliation,
layout effects, or Yoga.

On content/style updates or terminal resize, normal layout increments `layoutEpoch`. Before
painting the new generation, each `VLBox` clamps its retained offset to the new extent.
`getScrollPosition()` reads the host offset, so it observes any layout-time clamp.

Nested `VLBox` instances keep independent offsets. Their active clip rectangles intersect,
and their sticky indexes belong to the nearest corresponding scroll container.

## 11. Selection, pointer targeting, and accessibility

### Selection

The renderer produces the same visible `Output` grid as the unculled path. The existing text
selection controller continues to capture visible plain rows and masks. Scrolling during a
selection uses the same imperative ref; no separate virtual selection model is introduced.

### Pointer targeting

Only nodes actually painted in the current renderer epoch receive the current paint epoch and
index. Culled nodes retain stale metadata and `getPaintOrder()` returns `undefined`, matching
the existing pointer-target validation model. Indexed sticky nodes receive paint metadata
when their pinned copies are drawn.

### Screen readers

Screen-reader rendering bypasses viewport culling and emits the complete semantic tree, as it
does today. `aria-hidden` behavior remains owned by the shared Box implementation.

## 12. CLI integration

`packages/cli/src/components/ComboBox/ScrollBox.tsx` keeps its public API and interaction
semantics. Its internal scrolling viewport changes from `Box` to `VLBox`. Wheel, keyboard,
and scrollbar-drag handlers update the VLBox offset imperatively before synchronizing
controller state. Follow-end content growth applies the new maximum offset before committing
its measured metrics. Controlled prop synchronization retains the existing layout effect.
Consequently, interactive scrolling does not wait for a React commit or layout effect.

The scrollbar keeps a fixed row count and one glyph node per track row while viewport height is
stable. Thumb movement changes only output styling, leaving Yoga clean; Ink's dirty-root guard
skips layout for that controller commit. VLBox suppresses repaint requests when an imperative
offset is unchanged, including the subsequent synchronization effect.

The following public behavior remains unchanged:

- focus registration and keyboard/wheel capture;
- follow-end and manual-scroll semantics;
- scrollbar appearance and dragging;
- viewport refs and selection bounds;
- `onScrollInfo` callbacks;
- content formatting and component trees.

The tool-detail modal continues to render its current ARGS/SOURCE/RESULT cards and Markdown.
It benefits transitively through `ScrollBox`; no raw-line chunking, Markdown splitting, or
modal-specific `VirtualizedList` item model is added.

## 13. Failure behavior

- Missing, stale, or contradictory culling metadata causes normal traversal for that subtree.
- Geometry-changing output transformers cause normal traversal for their subtree.
- Invalid scroll offsets are normalized and clamped; they never enter renderer coordinates.
- A zero-sized or not-yet-laid-out viewport paints through the normal path until valid layout
  exists.
- Cache failures affect performance only; they must not suppress visible output.
- Existing errors thrown by invalid Ink composition remain unchanged.

## 14. Testing

### 14.1 Ink AVA tests

Add focused tests for:

1. Byte-identical `Box` and `VLBox` output for column, row, reverse directions, wrapping,
   flex grow/shrink, percentages, gap, padding, borders, backgrounds, and z-index.
2. Absolute and overflow-visible descendants that paint outside a parent's own box.
3. Nested hidden/scroll clips and nested `VLBox` offsets.
4. Imperative scroll does not invoke another Yoga `calculateLayout()`.
5. Paint-only React commits with a clean Yoga root also skip `calculateLayout()`.
6. Repeated scroll reuses content extents instead of recursively measuring the tree.
7. Fully off-screen subtrees are absent from the current paint epoch; newly visible subtrees
   receive the current epoch after scrolling.
8. Straddling backgrounds and borders generate only viewport-intersecting rows and columns.
9. Sticky candidates remain pinned, ordered, and pointer-addressable while natural parent
   subtrees are culled.
10. Content growth, content shrink, and terminal resize invalidate metadata and clamp offsets.
11. Text selection output is byte-identical to the unculled reference path.
12. Screen-reader output contains the full tree regardless of scroll position.
13. Invalid offsets and uncertain transformed geometry take their documented safe paths.

### 14.2 CLI tests

Keep all existing `ScrollBox` and `ToolDetailModal` suites green. Add a large-result modal
regression that:

- opens a substantially overflowing result;
- reaches a deep sentinel via wheel and keyboard scrolling;
- preserves scrollbar behavior;
- preserves drag-selection copy;
- preserves the current frame chrome and Markdown formatting.

Ink tests run with the nested repository's npm/AVA toolchain. CLI tests run with the outer
pnpm/vitest toolchain against the built Ink artifact selected for development.

## 15. Performance verification

Add or extend a warm-scroll benchmark with a large mixed tree containing nested boxes, plain
text, Markdown-like per-line Text nodes, absolute children, nested clips, and sticky headers.
Run performance gates at a terminal size of **424 columns × 95 rows** and measure after initial
layout.

Required gates:

- zero Yoga layout calls per imperative scroll step;
- renderer visitation bounded to viewport-intersecting subtrees plus indexed sticky
  candidates;
- large tool-detail wheel median `<= 16 ms`;
- at least `5x` faster than the unculled baseline for the large fixture;
- no more than `10%` median regression for a small viewport/content fixture;
- byte-identical rendered frames for benchmark checkpoints.

Record initial mount and content-changing layout separately. They remain O(total tree size)
and are not part of the warm-scroll claim. Incremental terminal scroll-region improvements
are complementary and must not be counted as subtree-culling visitation savings.

## 16. Delivery sequence

`packages/ink` is a nested standalone repository and uses npm/AVA. Outer workspace consumers
normally resolve the published package rather than nested source.

1. Implement `VLBox`, metadata, culling, sticky indexing, and Ink tests in the nested repo.
2. Run focused and full relevant AVA tests, typecheck, and build.
3. Commit the Ink change independently.
4. Publish `@nuvin/ink@7.6.0-alpha` only with explicit user approval.
5. Update the outer workspace's Ink pins and lockfile from the verified current `7.5.0-alpha` to `7.6.0-alpha`.
6. Replace CLI `ScrollBox`'s viewport with `VLBox`; add integration tests and benchmark.
7. Return any development-only `ink-local` override to npm mode before outer commits.
8. Add the required CLI changeset, including `nuvin-code`, and commit outer changes
   independently. Do not push without explicit user approval.

## 17. Related designs

- Outer tool-detail modal refined-cards design:
  `docs/superpowers/specs/2026-08-30-tool-detail-modal-refined-cards-design.md`
- Outer tall-row line-windowing design:
  `docs/superpowers/specs/2026-08-27-tui-tall-row-line-windowing-design.md`
- Ink incremental scroll-region paint design:
  `docs/superpowers/specs/2026-08-21-incremental-scroll-region-design.md`
- Ink incremental rendering state repair design:
  `docs/superpowers/specs/2026-08-09-incremental-rendering-state-repair-design.md`
