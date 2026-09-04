# VLBox Retained-Layout Viewport Culling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Box-compatible `VLBox` to the custom Ink fork that preserves arbitrary Yoga layout while making warm scrolling paint-only and culling fully off-screen subtrees, then use it inside the CLI `ScrollBox` and tool-detail modal path.

**Architecture:** `VLBox` shares the existing `Box` implementation but opts its host node into retained-layout viewport culling. Ink computes and caches subtree bounds, content extents, and sticky candidates once per Yoga layout epoch; imperative scrolling synchronizes the component ref and host offset, then requests a throttled repaint only when the offset changes. The outer CLI preserves its controller semantics while moving the VLBox host before React state synchronization and keeping scrollbar geometry fixed across thumb movement.

**Tech Stack:** React 19, custom `@nuvin/ink`, Yoga 3.2, TypeScript, AVA/XO/npm in the nested Ink repository, Vitest/Biome/pnpm in the outer nuvin-agent repository.

**Spec:** `packages/ink/docs/superpowers/specs/2026-09-04-vlbox-retained-layout-viewport-culling-design.md`

## Global Constraints

- `VLBox` retains every React child and Yoga node; it does not claim strict bounded mounting or initial-layout memory.
- `VLBox` accepts the same public props as `Box`; `VLBoxRef` aliases `BoxRef`.
- Public `Box` behavior and its React-driven scroll invalidation stay unchanged.
- `VLBox` owns no focus, keyboard, wheel, follow-end, or scrollbar behavior.
- Culling is active only for axes resolved to `overflow="scroll"`.
- Existing `Output.clip()` remains the final cell-level correctness guard.
- Metadata is valid only for the current root `layoutEpoch` while the root metadata-dirty flag is clear; missing, dirty, or uncertain metadata fails open to normal traversal.
- Sticky candidates are indexed per nearest `VLBox`; nested normal scroll boxes keep traversal-time sticky discovery.
- Screen-reader rendering always walks the complete semantic tree.
- Geometry-changing `Transform` subtrees fail open.
- Warm-scroll gates run at terminal size `424×95`: zero Yoga layouts per imperative step, `<= 16 ms` large-fixture median, at least `5x` faster than unculled `Box`, and no more than `10%` small-fixture regression.
- The nested `packages/ink` repository uses npm, TypeScript, XO, and AVA. The outer repository uses pnpm, Biome, and Vitest.
- Publish `@nuvin/ink@7.6.0-alpha` only after explicit user approval. Never push without explicit user approval.
- Outer committed state must use `npm:@nuvin/ink@7.6.0-alpha`, never `link:packages/ink`.

## File Structure

### Nested `packages/ink` repository

- Modify `src/dom.ts` — host-node epoch, culling marker, cached metadata fields.
- Create `src/layout-metadata.ts` — rectangle math, layout metadata prepass, content extents, sticky indexes, culling predicates.
- Modify `src/ink.tsx` — increment layout epoch after Yoga calculation.
- Modify `src/render-to-string.ts` — use the same epoch rule for synchronous rendering.
- Modify `src/reconciler.ts` — store/remove the private culling marker and maintain the root VLBox count.
- Modify `src/components/Box.tsx` — shared Box factory and mode-specific imperative scroll path.
- Create `src/components/VLBox.tsx` — thin public `VLBox` export.
- Modify `src/global.d.ts` — private intrinsic host prop.
- Modify `src/index.ts` — public `VLBox` and `VLBoxRef` exports.
- Modify `src/renderer.ts` — metadata prepass before visual output traversal.
- Modify `src/render-node-to-output.ts` — active viewport propagation, early subtree rejection, indexed sticky paint.
- Modify `src/render-background.ts` and `src/render-border.ts` — restrict straddling surface generation to the active visible rectangle.
- Create `test/vlbox.tsx` — API parity, paint-only scrolling, culling, invalidation, nested viewport, transform, selection, and screen-reader coverage.
- Modify `test/fork-layering.tsx` — indexed sticky ordering/bounds coverage under `VLBox`.
- Create `benchmark/vlbox.tsx` — unculled Box versus VLBox warm-scroll benchmark.
- Modify `readme.md` — `VLBox` API and retained-layout guarantee.
- Modify `package.json` and `package-lock.json` — benchmark command and `7.6.0-alpha` release.

### Outer `nuvin-agent` repository

- Modify `package.json`, `packages/cli/package.json`, `packages/ink-input/package.json`, `packages/ink-text-input/package.json`, `packages/ink-virtualized-list/package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` — pin published Ink `7.6.0-alpha`.
- Modify `packages/cli/src/components/ComboBox/ScrollBox.tsx` — use `VLBox` for the internal viewport.
- Modify `packages/cli/src/components/ComboBox/ScrollBox.test.tsx` — preserve arbitrary-child scrolling and pointer behavior.
- Modify `packages/cli/src/components/ToolDetailModal.test.tsx` — large-result wheel/keyboard/selection regression.
- Create `packages/cli/scripts/benchmark-vlbox-tool-detail.tsx` — actual modal warm-scroll benchmark.
- Modify root `package.json` — benchmark entry.
- Create `.changeset/ink-7-6-vlbox.md` — release note for all affected outer TUI packages, including `@nuvin/nuvin-code`.

---

### Task 1: Dirty-aware root layout epochs

**Repository:** `packages/ink`

**Files:**
- Modify: `src/dom.ts:69-89`
- Modify: `src/ink.tsx:571-581`
- Modify: `src/render-to-string.ts:61-68`
- Test: `test/vlbox.tsx`

**Interfaces:**
- Produces: `DOMElement.internal_layoutEpoch?: number`
- Produces: `incrementLayoutEpoch(root: DOMElement): number` in `src/dom.ts`
- Consumers: later metadata caches compare their epoch to the root epoch.

- [ ] **Step 1: Write the failing epoch test**

Create `test/vlbox.tsx` with the shared polling helper and this test:

```tsx
import React from 'react';
import test from 'ava';
import delay from 'delay';
import {Box, type BoxRef, render, Text} from '../src/index.js';
import createStdout from './helpers/create-stdout.js';

const waitForWriteCount = async (
	stdout: {getWrites: () => string[]},
	expected: number,
): Promise<void> => {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (stdout.getWrites().length >= expected) return;
		await delay(20);
	}
	throw new Error(`Timed out waiting for ${expected} writes`);
};

const rootOf = (node: NonNullable<BoxRef>): NonNullable<BoxRef> => {
	let root = node;
	while (root.parentNode) root = root.parentNode as NonNullable<BoxRef>;
	return root;
};

test('layout epoch advances only when the Yoga root is dirty', async t => {
	const stdout = createStdout(80);
	const ref = React.createRef<BoxRef>();
	const instance = render(
		<Box ref={ref} width={20}><Text>first</Text></Box>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);
	const first = rootOf(ref.current!).internal_layoutEpoch;

	instance.rerender(
		<Box ref={ref} width={20}><Text color="red">first</Text></Box>,
	);
	await waitForWriteCount(stdout, 2);
	const paintOnly = rootOf(ref.current!).internal_layoutEpoch;

	instance.rerender(
		<Box ref={ref} width={20}><Text>second content is wider</Text></Box>,
	);
	await waitForWriteCount(stdout, 3);
	const layoutChanged = rootOf(ref.current!).internal_layoutEpoch;

	t.is(typeof first, 'number');
	t.is(paintOnly, first);
	t.is(layoutChanged, first! + 1);
	instance.unmount();
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run:

```bash
cd packages/ink
npm exec -- ava test/vlbox.tsx --match='layout epoch advances only*'
```

Expected: TypeScript/AVA fails because `internal_layoutEpoch` does not exist.

- [ ] **Step 3: Add the epoch field and helper**

Add to `DOMElement` in `src/dom.ts`:

```ts
internal_layoutEpoch?: number;
```

Add beside `createNode`:

```ts
export const incrementLayoutEpoch = (root: DOMElement): number => {
	const next = (root.internal_layoutEpoch ?? 0) + 1;
	root.internal_layoutEpoch = next;
	return next;
};
```

Add `private lastLayoutWidth?: number;` to the Ink instance. Import `incrementLayoutEpoch` and replace `calculateLayout` with:

```ts
calculateLayout = () => {
	const terminalWidth = getWindowSize(this.options.stdout).columns;
	const yoga = this.rootNode.yogaNode!;
	const widthChanged = this.lastLayoutWidth !== terminalWidth;
	if (widthChanged) {
		yoga.setWidth(terminalWidth);
		this.lastLayoutWidth = terminalWidth;
	}
	if (!widthChanged && !yoga.isDirty()) return;
	yoga.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
	incrementLayoutEpoch(this.rootNode);
};
```

`resetAfterCommit` continues to call this method and always continues to `onRender`; only the unnecessary Yoga calculation is skipped.

Use the same rule in `src/render-to-string.ts`:

```ts
rootNode.yogaNode!.calculateLayout(
	undefined,
	undefined,
	Yoga.DIRECTION_LTR,
);
incrementLayoutEpoch(rootNode);
```

- [ ] **Step 4: Run focused verification**

Run:

```bash
npm exec -- ava test/vlbox.tsx --match='layout epoch advances only*'
npm run typecheck
```

Expected: both commands pass.

- [ ] **Step 5: Commit**

```bash
git add src/dom.ts src/ink.tsx src/render-to-string.ts test/vlbox.tsx
git commit -m "feat: track root layout generations"
```

---

### Task 2: Shared Box factory and public VLBox shell

**Repository:** `packages/ink`

**Files:**
- Modify: `src/components/Box.tsx:22-298`
- Create: `src/components/VLBox.tsx`
- Modify: `src/dom.ts:69-89`
- Modify: `src/reconciler.ts:194-245,307-356`
- Modify: `src/global.d.ts:16-25`
- Modify: `src/index.ts:5-6`
- Modify: `readme.md`
- Test: `test/vlbox.tsx`

**Interfaces:**
- Produces: `createBoxComponent(displayName: string, viewportCulling: boolean)`
- Produces: public `VLBox`, `VLBoxProps = BoxProps`, `VLBoxRef = BoxRef`
- Produces: private `DOMElement.internal_viewportCulling?: boolean`
- Produces: root `internal_viewportCullingCount?: number`
- Public `Box` continues to call `createBoxComponent('Box', false)`.

- [ ] **Step 1: Add failing public-API and parity tests**

Append to `test/vlbox.tsx`:

```tsx
import {VLBox, type VLBoxRef} from '../src/index.js';
import {renderToString} from './helpers/render-to-string.js';

test('VLBox preserves Box layout output and exposes the Box ref API', async t => {
	const boxOutput = renderToString(
		<Box width={12} height={3} borderStyle="single" flexDirection="column">
			<Text>one</Text><Text>two</Text>
		</Box>,
		{columns: 30},
	);
	const vlBoxOutput = renderToString(
		<VLBox width={12} height={3} borderStyle="single" flexDirection="column">
			<Text>one</Text><Text>two</Text>
		</VLBox>,
		{columns: 30},
	);
	t.is(vlBoxOutput, boxOutput);

	const stdout = createStdout(30);
	const ref = React.createRef<VLBoxRef>();
	const instance = render(
		<VLBox ref={ref} width={10} height={2} overflow="scroll" flexDirection="column">
			<Text>one</Text><Text>two</Text><Text>three</Text>
		</VLBox>,
		{stdout, debug: true},
	);
	await waitForWriteCount(stdout, 1);
	t.is(typeof ref.current?.scrollTo, 'function');
	t.true(ref.current?.internal_viewportCulling);
	instance.unmount();
});
```

Add an AVA test with the exact title `VLBox root count tracks committed mounts removals and reorders`. Rerender one root through zero, one, nested-two, reordered-one, and zero VLBoxes; assert `internal_viewportCullingCount` is `0`, `1`, `2`, `1`, and `0` respectively. This prevents speculative `createInstance` calls or same-root moves from leaking the count.

Keep imports consolidated according to XO after the test is red.

- [ ] **Step 2: Run the API test and verify failure**

```bash
npm exec -- ava test/vlbox.tsx \
  --match='VLBox preserves*' \
  --match='VLBox root count*'
```

Expected: failure because `VLBox` and `VLBoxRef` are not exported.

- [ ] **Step 3: Extract the shared factory without changing Box behavior**

In `src/components/Box.tsx`, rename the existing anonymous `forwardRef` construction to an exported internal factory:

Change the declaration immediately before the current forwardRef callback from:

```tsx
const Box = forwardRef<BoxRef, PropsWithChildren<Props>>(
```

to:

```tsx
export const createBoxComponent = (
	displayName: string,
	viewportCulling: boolean,
) => {
	const Component = forwardRef<BoxRef, PropsWithChildren<Props>>(
```

Keep the current callback body, hooks, ref methods, accessibility handling, background provider, and returned host element in that callback. Replace the existing closing declaration and display name:

```tsx
);

Box.displayName = 'Box';

export default Box;
```

with:

```tsx
	);

	Component.displayName = displayName;
	return Component;
};

const Box = createBoxComponent('Box', false);
export default Box;
```

This mechanical wrapper keeps every hook directly inside the generated forwardRef component and introduces no second render function.

Pass the private marker to the host element:

Add only the private marker prop to the existing host element; retain its current inline style object and other props unchanged:

```tsx
<ink-box
	ref={internalRef}
	internal_viewportCulling={viewportCulling || undefined}
	style={{
		flexWrap: 'nowrap',
		flexDirection: 'row',
		flexGrow: 0,
		flexShrink: 1,
		...style,
		backgroundColor,
		overflowX: style.overflowX ?? style.overflow ?? 'visible',
		overflowY: style.overflowY ?? style.overflow ?? 'visible',
	}}
	internal_accessibility={{role, state: ariaState}}
	internal_scrollVersion={isScrollContainer ? scrollVersion : undefined}
>
	{isScreenReaderEnabled && label ? label : children}
</ink-box>
```

- [ ] **Step 4: Store the private marker in the host node**

Add fields in `src/dom.ts`:

```ts
internal_viewportCulling?: boolean;
internal_viewportCullingCount?: number;
```

Add the intrinsic prop in `src/global.d.ts`:

```ts
internal_viewportCulling?: boolean;
```

In `reconciler.createInstance`, handle the prop before `setAttribute`, but only store it on the detached host node:

```ts
if (key === 'internal_viewportCulling') {
	node.internal_viewportCulling = value === true;
	continue;
}
```

Do not mutate the root count from `createInstance`; concurrent/speculative host instances are not committed ownership. Add these helpers in `reconciler.ts`:

```ts
const countViewportCullingNodes = (node: DOMElement): number =>
	(node.internal_viewportCulling ? 1 : 0) +
	node.childNodes.reduce(
		(total, child) =>
			total +
			(child.nodeName === '#text'
				? 0
				: countViewportCullingNodes(child as DOMElement)),
		0,
	);

const connectedRoot = (node: DOMElement): DOMElement | undefined => {
	let root = node;
	while (root.parentNode) root = root.parentNode;
	return root.nodeName === 'ink-root' ? root : undefined;
};

const adjustViewportCount = (root: DOMElement | undefined, delta: number): void => {
	if (!root || delta === 0) return;
	root.internal_viewportCullingCount = Math.max(
		0,
		(root.internal_viewportCullingCount ?? 0) + delta,
	);
};
```

Wrap committed append/insert operations (`appendChild`, `insertBefore`, `appendChildToContainer`, and `insertInContainerBefore`). Capture the child's connected root before and after the existing mutation. If the roots differ, subtract the subtree count from the old root and add it to the new root; if they are identical, a reorder changes no count. `appendInitialChild` remains the unwrapped detached-tree builder. For `removeChild` and `removeChildFromContainer`, capture the connected root and subtree count before detaching, run the existing removal/cleanup, then subtract once. This makes root count ownership follow committed connectivity rather than host allocation.

- [ ] **Step 5: Add the thin VLBox component and public exports**

Create `src/components/VLBox.tsx`:

```tsx
import {createBoxComponent, type BoxRef, type Props} from './Box.js';

export type VLBoxProps = Props;
export type VLBoxRef = BoxRef;

const VLBox = createBoxComponent('VLBox', true);
export default VLBox;
```

Update `src/index.ts`:

```ts
export type {VLBoxProps, VLBoxRef} from './components/VLBox.js';
export {default as VLBox} from './components/VLBox.js';
```

Document under the Box section in `readme.md`:

```md
### VLBox

`VLBox` accepts the same props and ref API as `Box`. When used with a bounded
`overflow="scroll"` axis, it retains the full Yoga layout but culls off-screen
paint work and scrolls without a React update. It does not virtualize mounting
or provide input handling or a scrollbar.
```

- [ ] **Step 6: Run parity and regression tests**

```bash
npm exec -- ava test/vlbox.tsx test/fork-scroll.tsx test/overflow.tsx
npm run typecheck
npm run lint
```

Expected: all pass; existing `Box` tests remain unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/components/Box.tsx src/components/VLBox.tsx src/dom.ts src/reconciler.ts src/global.d.ts src/index.ts readme.md test/vlbox.tsx
git commit -m "feat: add Box-compatible VLBox viewport"
```

---

### Task 3: Layout metadata prepass and cached content extents

**Repository:** `packages/ink`

**Files:**
- Create: `src/layout-metadata.ts`
- Modify: `src/dom.ts`
- Modify: `src/global.d.ts`
- Modify: `src/reconciler.ts`
- Modify: `src/components/Transform.tsx`
- Modify: `src/renderer.ts:16-59`
- Modify: `src/components/Box.tsx:107-160`
- Test: `test/vlbox.tsx`

**Interfaces:**
- Produces: `Rect`, `NodeLayoutMetadata`, `ScrollViewportMetadata`, `StickyCandidate`
- Produces: `prepareLayoutMetadata(root: DOMElement): void`
- Produces: `invalidateLayoutMetadata(node: DOMElement): void`
- Produces: `getNodeLayoutMetadata(node: DOMElement): NodeLayoutMetadata | undefined`
- Produces: `getScrollViewportMetadata(node: DOMElement): ScrollViewportMetadata | undefined`
- Consumers: culling and sticky tasks read only current, non-dirty metadata.

- [ ] **Step 1: Add failing metadata reuse and extent tests**

Add an AVA test with the exact title `VLBox reuses current-epoch metadata and cached content extent`. Mount a 3-row `VLBox` with ten direct rows, wait for first paint, and assert:

```tsx
const metadata = viewportRef.current?.internal_scrollViewportMetadata;
t.truthy(metadata);
t.is(metadata?.contentExtent.height, 10);
const epoch = metadata?.epoch;
viewportRef.current?.scrollToBottom();
await waitForWriteCount(stdout, 2);
t.is(viewportRef.current?.internal_scrollViewportMetadata, metadata);
t.is(viewportRef.current?.internal_scrollViewportMetadata?.epoch, epoch);
t.deepEqual(viewportRef.current?.getScrollPosition(), {x: 0, y: 7});
```

Add an AVA test with the exact title `VLBox content extent includes absolute children and respects nested clips`. Use an absolute child extending to `{left: 14, top: 8, width: 6, height: 2}` and assert content extent `{width: 20, height: 10}`. Add an overflow-hidden nested child whose escaped descendant does not enlarge the outer paint bounds.

Add `VLBox rebuilds metadata after a Yoga-clean culling-semantics update`: rerender only `zIndex` and `overflow` values that map to unchanged Yoga geometry, assert `internal_layoutEpoch` is unchanged, and assert `internal_scrollViewportMetadata` is replaced in the next painted frame.

- [ ] **Step 2: Verify the tests fail**

```bash
npm exec -- ava test/vlbox.tsx \
  --match='VLBox reuses current-epoch metadata*' \
  --match='VLBox content extent*' \
  --match='VLBox rebuilds metadata*'
```

Expected: failure because metadata fields do not exist.

- [ ] **Step 3: Define host metadata types**

In `src/dom.ts`, export:

```ts
export type Rect = {left: number; top: number; right: number; bottom: number};

export type NodeLayoutMetadata = {
	epoch: number;
	subtreePaintBounds: Rect;
	hasUnboundedTransform: boolean;
};

export type StickyCandidate = {
	node: DOMElement;
	parentOffset: {x: number; y: number};
	parentBounds: {top: number; bottom: number};
	parentIsViewport: boolean;
	transformers: OutputTransformer[];
	paintOrder: number;
};

export type ScrollViewportMetadata = {
	epoch: number;
	contentExtent: {width: number; height: number};
	stickyCandidates: StickyCandidate[];
};
```

Add optional fields to `DOMElement`:

```ts
internal_layoutMetadata?: NodeLayoutMetadata;
internal_layoutMetadataDirty?: boolean;
internal_scrollViewportMetadata?: ScrollViewportMetadata;
internal_transformAffectsGeometry?: boolean;
```

Mark only public arbitrary transforms as geometry-uncertain. Add `internal_transformAffectsGeometry?: boolean` to the `ink-text` intrinsic in `src/global.d.ts`, store it in `reconciler.createInstance` / `commitUpdate` beside `internal_transform`, and add the marker only in `Transform.tsx`:

```tsx
<ink-text
	style={{flexGrow: 0, flexShrink: 1, flexDirection: 'row'}}
	internal_transform={transform}
	internal_transformAffectsGeometry
>
	{isScreenReaderEnabled && accessibilityLabel
		? accessibilityLabel
		: children}
</ink-text>
```

Do not set this marker in `Text.tsx`; its transformer adds ANSI styling without changing Yoga geometry.

Import `invalidateLayoutMetadata` in `reconciler.ts`. In `commitUpdate`, after computing `props` and `style`, invalidate when the diff contains any metadata-sensitive key:

```ts
const metadataSensitiveStyle =
	style !== undefined &&
	['zIndex', 'position', 'overflow', 'overflowX', 'overflowY'].some(
		key => key in style,
	);
const metadataSensitiveProp =
	props !== undefined && 'internal_transformAffectsGeometry' in props;
if (metadataSensitiveStyle || metadataSensitiveProp) {
	invalidateLayoutMetadata(node);
}
```

These keys can change sticky membership/ordering or culling semantics while mapping to the same Yoga value. Geometry-changing Yoga setters still invalidate through the next `layoutEpoch`; background/color and ordinary `Text` transformer changes do not force an O(total) prepass.

- [ ] **Step 4: Implement the pure rectangle and prepass core**

Create `src/layout-metadata.ts` with these exact public helpers and private rules:

```ts
import Yoga from 'yoga-layout';
import {
	type DOMElement,
	type NodeLayoutMetadata,
	type Rect,
	type ScrollViewportMetadata,
} from './dom.js';

const rect = (left: number, top: number, width: number, height: number): Rect => ({
	left,
	top,
	right: left + Math.max(0, width),
	bottom: top + Math.max(0, height),
});

const translate = (value: Rect, x: number, y: number): Rect => ({
	left: value.left + x,
	top: value.top + y,
	right: value.right + x,
	bottom: value.bottom + y,
});

const union = (a: Rect, b: Rect): Rect => ({
	left: Math.min(a.left, b.left),
	top: Math.min(a.top, b.top),
	right: Math.max(a.right, b.right),
	bottom: Math.max(a.bottom, b.bottom),
});

const clipAxes = (
	value: Rect,
	clip: Rect,
	clipX: boolean,
	clipY: boolean,
): Rect => ({
	left: clipX ? Math.max(value.left, clip.left) : value.left,
	top: clipY ? Math.max(value.top, clip.top) : value.top,
	right: clipX ? Math.min(value.right, clip.right) : value.right,
	bottom: clipY ? Math.min(value.bottom, clip.bottom) : value.bottom,
});

const isScrollOrHidden = (value: unknown): boolean =>
	value === 'scroll' || value === 'hidden';

const buildNode = (node: DOMElement, epoch: number): NodeLayoutMetadata | undefined => {
	const yoga = node.yogaNode;
	if (!yoga || yoga.getDisplay() === Yoga.DISPLAY_NONE) return undefined;

	const own = rect(0, 0, yoga.getComputedWidth(), yoga.getComputedHeight());
	let childPaintBounds: Rect | undefined;
	let hasUnboundedTransform = node.internal_transformAffectsGeometry === true;
	const viewport = node.internal_viewportCulling
		? {
				epoch,
				contentExtent: {width: 0, height: 0},
				stickyCandidates: [],
			} satisfies ScrollViewportMetadata
		: undefined;
	if (viewport) node.internal_scrollViewportMetadata = viewport;

	for (const childNode of node.childNodes) {
		if (childNode.nodeName === '#text') continue;
		const child = childNode as DOMElement;
		const childMetadata = buildNode(child, epoch);
		if (!childMetadata || !child.yogaNode) continue;
		const childPaint = translate(
			childMetadata.subtreePaintBounds,
			child.yogaNode.getComputedLeft(),
			child.yogaNode.getComputedTop(),
		);
		childPaintBounds = childPaintBounds
			? union(childPaintBounds, childPaint)
			: childPaint;
		hasUnboundedTransform ||= childMetadata.hasUnboundedTransform;
	}

	const unboundedPaint = childPaintBounds ? union(own, childPaintBounds) : own;
	const clipX = isScrollOrHidden(node.style.overflowX);
	const clipY = isScrollOrHidden(node.style.overflowY);
	const metadata: NodeLayoutMetadata = {
		epoch,
		subtreePaintBounds: clipAxes(unboundedPaint, own, clipX, clipY),
		hasUnboundedTransform,
	};
	node.internal_layoutMetadata = metadata;

	if (viewport && childPaintBounds) {
		// Match Box.getContentDimensions(): only descendants contribute to the
		// scroll extent. Each child's already-clipped subtree bounds prevents a
		// descendant escaping overflow:hidden/scroll from enlarging its ancestor.
		viewport.contentExtent = {
			width: Math.max(0, childPaintBounds.right),
			height: Math.max(0, childPaintBounds.bottom),
		};
	}

	return metadata;
};

const getRoot = (node: DOMElement): DOMElement => {
	let root = node;
	while (root.parentNode) root = root.parentNode as DOMElement;
	return root;
};

export const invalidateLayoutMetadata = (node: DOMElement): void => {
	getRoot(node).internal_layoutMetadataDirty = true;
};

export const prepareLayoutMetadata = (root: DOMElement): void => {
	const epoch = root.internal_layoutEpoch ?? 0;
	if ((root.internal_viewportCullingCount ?? 0) === 0) return;
	if (
		root.internal_layoutMetadata?.epoch === epoch &&
		root.internal_layoutMetadataDirty !== true
	) {
		return;
	}
	buildNode(root, epoch);
	root.internal_layoutMetadataDirty = false;
};

export const getNodeLayoutMetadata = (
	node: DOMElement,
): NodeLayoutMetadata | undefined => {
	const root = getRoot(node);
	const metadata = node.internal_layoutMetadata;
	return root.internal_layoutMetadataDirty !== true &&
		metadata?.epoch === (root.internal_layoutEpoch ?? 0)
		? metadata
		: undefined;
};

export const getScrollViewportMetadata = (
	node: DOMElement,
): ScrollViewportMetadata | undefined => {
	const root = getRoot(node);
	const metadata = node.internal_scrollViewportMetadata;
	return root.internal_layoutMetadataDirty !== true &&
		metadata?.epoch === (root.internal_layoutEpoch ?? 0)
		? metadata
		: undefined;
};
```

The stored rectangles are node-local. Parent aggregation and renderer translation each add a child's Yoga offset exactly once; the absolute/nested fixtures enforce this invariant.

- [ ] **Step 5: Invoke the prepass before visual traversal**

In `src/renderer.ts`, call:

```ts
prepareLayoutMetadata(node);
```

immediately before constructing `Output` and calling `renderNodeToOutput`. Do not call it in the screen-reader branch.

- [ ] **Step 6: Use cached extents for VLBox ref clamping**

In the shared Box ref implementation, choose the existing recursive `getContentDimensions()` for normal `Box`, but for `VLBox` use:

```ts
const metadata = getScrollViewportMetadata(element);
const content = viewportCulling && metadata
	? metadata.contentExtent
	: getContentDimensions();
```

This step still uses the current React state invalidation for both components; paint-only scrolling lands in Task 6.

- [ ] **Step 7: Verify and commit**

```bash
npm exec -- ava test/vlbox.tsx test/fork-scroll.tsx test/overflow.tsx
npm run typecheck
npm run lint
git add src/layout-metadata.ts src/dom.ts src/global.d.ts src/reconciler.ts src/components/Transform.tsx src/renderer.ts src/components/Box.tsx test/vlbox.tsx
git commit -m "feat: cache VLBox layout metadata"
```

Expected: all commands pass.

---

### Task 4: Early viewport subtree culling

**Repository:** `packages/ink`

**Files:**
- Modify: `src/layout-metadata.ts`
- Modify: `src/dom.ts`
- Modify: `src/renderer.ts:16-59`
- Modify: `src/render-node-to-output.ts:64-76,285-480`
- Modify: `src/render-background.ts:5-50`
- Modify: `src/render-border.ts:22-160`
- Test: `test/vlbox.tsx`

**Interfaces:**
- Produces: `CullingViewport = {rect: Rect; clipX: boolean; clipY: boolean}`
- Produces: `shouldCullNode(node, absoluteNodeX, absoluteNodeY, viewport): boolean`
- Produces: `getChildCullingViewport(node, absoluteNodeX, absoluteNodeY, inherited): CullingViewport | undefined`.
- Produces: optional absolute `visibleRect?: Rect` parameter on `renderBackground` and `renderBorder`.
- Produces: internal `DOMElement.internal_lastRenderVisitCount?: number`, `internal_lastSurfaceWriteCount?: number`, and `internal_lastSurfaceCellCount?: number` diagnostics.
- Consumes: current-epoch `NodeLayoutMetadata` from Task 3.

- [ ] **Step 1: Add failing culling and parity tests**

Add an AVA test with the exact title `VLBox culls off-screen subtrees before renderer traversal`, using refs for 20 one-row children in a 3-row `VLBox`:

```tsx
const visibleOrder = rowRefs[1]?.current?.getPaintOrder();
const hiddenOrder = rowRefs[15]?.current?.getPaintOrder();
t.truthy(visibleOrder);
t.is(hiddenOrder, undefined);
```

After `scrollTo({y: 14})` and a flushed paint, assert row 15 has current paint order and row 1 does not. Read `rootOf(viewportRef.current!).internal_lastRenderVisitCount` and assert it is less than 15 for the 20-row fixture, proving traversal—not only output writes—is bounded.

Add an AVA test with the exact title `VLBox matches Box output for arbitrary retained layout`, using table-driven `Box`/`VLBox` output comparisons for:

- column and row/reverse flex directions;
- percentage width, flex grow/shrink, gap, padding, border, and background;
- absolute descendants outside their immediate parent's own box;
- nested `overflow="hidden"` and nested `overflow="scroll"`;
- z-index overlap.

Add an AVA test with the exact title `VLBox fails open for geometry-changing Transform`; its off-screen parent remains painted/current-epoch. Add `VLBox fails open before viewport layout is valid`; a zero-sized/not-yet-laid-out VLBox keeps descendants on the normal traversal path.

Add `VLBox culls only axes resolved to overflow scroll`. Prove an `overflow="hidden"`-only VLBox does not activate culling, and prove `overflowY="scroll"` with visible X culls a vertically disjoint child but traverses a horizontally disjoint child.

Add the exact AVA title `VLBox clips straddling background and border generation to visible rows and columns`. Render a 500-row by 500-column bordered/background Box straddling a 3-row by 12-column viewport. Read `internal_lastSurfaceWriteCount` and `internal_lastSurfaceCellCount`; assert writes are bounded by visible rows and generated cells are bounded by the viewport area/perimeter while output remains byte-identical to the normal clipped path.

- [ ] **Step 2: Verify the culling test fails**

```bash
npm exec -- ava test/vlbox.tsx \
  --match='VLBox culls*' \
  --match='VLBox matches*' \
  --match='VLBox fails open*' \
  --match='VLBox clips straddling*'
```

Expected: hidden nodes still have current paint order.

- [ ] **Step 3: Add culling rectangle helpers**

In `src/layout-metadata.ts`, export:

```ts
export type CullingViewport = {
	rect: Rect;
	clipX: boolean;
	clipY: boolean;
};

export const intersectsViewport = (
	bounds: Rect,
	viewport: CullingViewport,
): boolean => {
	const xVisible = !viewport.clipX ||
		(bounds.right > viewport.rect.left && bounds.left < viewport.rect.right);
	const yVisible = !viewport.clipY ||
		(bounds.bottom > viewport.rect.top && bounds.top < viewport.rect.bottom);
	return xVisible && yVisible;
};

export const shouldCullNode = (
	node: DOMElement,
	nodeX: number,
	nodeY: number,
	viewport: CullingViewport | undefined,
): boolean => {
	if (!viewport) return false;
	const metadata = getNodeLayoutMetadata(node);
	if (!metadata || metadata.hasUnboundedTransform) return false;
	const bounds = translate(metadata.subtreePaintBounds, nodeX, nodeY);
	return !intersectsViewport(bounds, viewport);
};
```

Also export `getChildCullingViewport`. It derives the node's content rectangle from absolute `nodeX`/`nodeY`, computed width/height, and Yoga borders. Its exact ownership branches are:

```ts
export const getChildCullingViewport = (
	node: DOMElement,
	nodeX: number,
	nodeY: number,
	inherited: CullingViewport | undefined,
): CullingViewport | undefined => {
	const yoga = node.yogaNode;
	if (!yoga) return inherited;
	const isScrollContainer =
		node.style.overflowX === 'scroll' || node.style.overflowY === 'scroll';
	if (isScrollContainer && !node.internal_viewportCulling) return undefined;
	if (!node.internal_viewportCulling) return inherited;

	const ownClipX = node.style.overflowX === 'scroll';
	const ownClipY = node.style.overflowY === 'scroll';
	if (!ownClipX && !ownClipY) return inherited;
	const own = {
		left: nodeX + yoga.getComputedBorder(Yoga.EDGE_LEFT),
		top: nodeY + yoga.getComputedBorder(Yoga.EDGE_TOP),
		right:
			nodeX +
			yoga.getComputedWidth() -
			yoga.getComputedBorder(Yoga.EDGE_RIGHT),
		bottom:
			nodeY +
			yoga.getComputedHeight() -
			yoga.getComputedBorder(Yoga.EDGE_BOTTOM),
	};
	if (
		(ownClipX && !(own.right > own.left)) ||
		(ownClipY && !(own.bottom > own.top))
	) {
		return inherited;
	}
	return {
		rect: {
			left:
				ownClipX && inherited?.clipX
					? Math.max(own.left, inherited.rect.left)
					: ownClipX
						? own.left
						: (inherited?.rect.left ?? own.left),
			right:
				ownClipX && inherited?.clipX
					? Math.min(own.right, inherited.rect.right)
					: ownClipX
						? own.right
						: (inherited?.rect.right ?? own.right),
			top:
				ownClipY && inherited?.clipY
					? Math.max(own.top, inherited.rect.top)
					: ownClipY
						? own.top
						: (inherited?.rect.top ?? own.top),
			bottom:
				ownClipY && inherited?.clipY
					? Math.min(own.bottom, inherited.rect.bottom)
					: ownClipY
						? own.bottom
						: (inherited?.rect.bottom ?? own.bottom),
		},
		clipX: ownClipX || inherited?.clipX === true,
		clipY: ownClipY || inherited?.clipY === true,
	};
};
```

Inactive-axis rectangle values fall back to the node's own interval when no ancestor viewport exists; the corresponding clip flag remains false. Keep `translate` private to this module; do not expose general geometry beyond the named APIs.

- [ ] **Step 4: Propagate the active culling viewport**

Extend `renderNodeToOutput` options with:

```ts
cullingViewport?: CullingViewport;
```

At the start of a Yoga-backed node, after calculating `x`/`y` and before text handling or `markPainted`, return when:

```ts
if (shouldCullNode(node, x, y, cullingViewport)) return;
```

When entering a `VLBox`, derive its absolute content rectangle from Yoga bounds and computed borders. Use the resolved host styles written by `Box`: `ownClipX = node.style.overflowX === 'scroll'` and `ownClipY = node.style.overflowY === 'scroll'`. Do not use the broad `isScrollContainer` predicate for culling. If neither axis is `scroll`, pass through the inherited viewport unchanged. For each active axis, intersect the VLBox content interval with the inherited active interval; for an inactive axis, retain only the inherited interval/flag.

A normal scroll `Box` is still eligible for whole-subtree rejection against the inherited viewport at its own function entry. Once entered, its helper result is `undefined`, so naturally off-screen sticky nodes reach the existing traversal-time discovery path. Its own `Output.clip()` preserves visible cells. A nested VLBox inside that normal container establishes a fresh culling viewport.

Compute the child viewport once before the sorted child loop and pass it on the only recursive call:

```ts
const childCullingViewport = getChildCullingViewport(
	node,
	x,
	y,
	cullingViewport,
);

for (const childNode of sortedChildren) {
	renderNodeToOutput(childNode as DOMElement, output, {
		offsetX: x - scrollOffset.x,
		offsetY: y - scrollOffset.y,
		transformers: newTransformers,
		skipStaticElements,
		scrollContext: newScrollContext,
		parentTop: childParentTop,
		parentBottom: childParentBottom,
		paintState,
		cullingViewport: childCullingViewport,
	});
}
```

This call-site assertion is part of `VLBox culls off-screen subtrees before renderer traversal`; omitting the option leaves the hidden row's paint order current and fails the test.

Before surface painting, convert the active culling viewport to an absolute visible rectangle with unbounded values on inactive axes and pass it to both surface helpers:

```ts
const surfaceVisibleRect = cullingViewport
	? {
			left: cullingViewport.clipX ? cullingViewport.rect.left : -Infinity,
			top: cullingViewport.clipY ? cullingViewport.rect.top : -Infinity,
			right: cullingViewport.clipX ? cullingViewport.rect.right : Infinity,
			bottom: cullingViewport.clipY ? cullingViewport.rect.bottom : Infinity,
		}
	: undefined;
renderBackground(x, y, node, output, surfaceVisibleRect);
renderBorder(x, y, node, output, surfaceVisibleRect);
```

Change `renderBackground` to intersect its content box with `visibleRect` before constructing the colored line and looping rows. The repeated string length is `visibleRight - visibleLeft`, and the loop covers only `[visibleTop, visibleBottom)`. Change `renderBorder` so top/bottom border strings are sliced to the visible horizontal interval before colorization/write, and left/right borders are emitted one visible row at a time instead of constructing `height` newlines. Preserve corners, per-edge visibility, colors, backgrounds, and dim styling. With `visibleRect === undefined`, both helpers generate the same cells as today.

Add `internal_lastSurfaceWriteCount?: number` and `internal_lastSurfaceCellCount?: number` to `DOMElement`. Immediately before a box's two surface helpers, set both to `0`. After each actual `output.write`, increment the write count and add the unstyled segment's cell width to the cell count. The fields record only the most recent paint of that box and prove that neither row loops nor repeated-string construction scale with the off-screen surface dimensions.

Keep `Output.clip()` exactly where it is; culling and bounded surface generation are early optimizations, not replacements.

Extend `PaintState` with `visitedCount`. Initialize it in `createPaintState()` and increment only after display/static checks and `shouldCullNode` have accepted a node for expensive traversal. A rejected child pays one cached-bounds predicate but is not counted as renderer visitation:

```ts
export type PaintState = {
	epoch: number;
	nextIndex: number;
	visitedCount: number;
};

const createPaintState = (): PaintState => ({
	epoch: ++nextPaintEpoch,
	nextIndex: 0,
	visitedCount: 0,
});

// In renderNodeToOutput, immediately after the early culling return:
paintState.visitedCount++;

const paintState = createPaintState();
renderNodeToOutput(node, output, {
	skipStaticElements: true,
	paintState,
});
node.internal_lastRenderVisitCount = paintState.visitedCount;
```

Add `internal_lastRenderVisitCount?: number` to `DOMElement`. This is internal diagnostic metadata, not a public render option.

- [ ] **Step 5: Verify visual parity and culling**

```bash
npm exec -- ava test/vlbox.tsx test/overflow.tsx test/fork-layering.tsx
npm run typecheck
npm run lint
```

Expected: all tests pass; transformed subtree test confirms fail-open traversal.

- [ ] **Step 6: Commit**

```bash
git add src/layout-metadata.ts src/dom.ts src/renderer.ts src/render-node-to-output.ts src/render-background.ts src/render-border.ts test/vlbox.tsx
git commit -m "perf: cull off-screen VLBox subtrees"
```

---

### Task 5: Indexed sticky candidates

**Repository:** `packages/ink`

**Files:**
- Modify: `src/layout-metadata.ts`
- Modify: `src/render-node-to-output.ts:32-214,357-472`
- Modify: `test/fork-layering.tsx`
- Test: `test/vlbox.tsx` (regression run only)

**Interfaces:**
- Consumes: `ScrollViewportMetadata.stickyCandidates`
- Produces: metadata prepass registration with nearest VLBox ownership.
- Preserves: traversal-time `ScrollContext.stickyNodes` for normal Box scroll containers.

- [ ] **Step 1: Add failing VLBox sticky tests**

Add all three tests below to `test/fork-layering.tsx`, matching the Task 5 red command. Add the exact title `VLBox sticky index preserves pinning order and pointer bounds` by porting the existing sticky fixture from `Box` to `VLBox`. Add `VLBox sticky index defers nested normal scroll boxes to traversal` for nested ownership. Add `VLBox sticky index rebuilds after Yoga-clean ownership and z-index changes`: rerender only sticky `zIndex` and a nested container's `overflow` from `hidden` to `scroll`, assert the root layout epoch is unchanged, the viewport metadata object is replaced, and ownership/paint order follows the new styles.

Use this base fixture for the first test:

```tsx
<VLBox
	ref={containerRef}
	width={20}
	height={3}
	overflow="scroll"
	flexDirection="column"
>
	<Box ref={headerRef} position="sticky" top={0} flexShrink={0}>
		<Text>HEADER</Text>
	</Box>
	{Array.from({length: 10}, (_, index) => (
		<Box key={index} ref={index === 4 ? coveredRowRef : undefined} flexShrink={0}>
			<Text>Item {index}</Text>
		</Box>
	))}
</VLBox>
```

For `VLBox sticky index defers nested normal scroll boxes to traversal`, render a visible nested normal scroll container whose sticky row is naturally below its own viewport:

```tsx
<VLBox width={24} height={5} overflow="scroll" flexDirection="column">
	<Box
		ref={nestedScrollRef}
		height={3}
		overflow="scroll"
		flexDirection="column"
		flexShrink={0}
	>
		{Array.from({length: 5}, (_, index) => (
			<Box key={index} flexShrink={0}>
				<Text>Nested {index}</Text>
			</Box>
		))}
		<Box ref={nestedStickyRef} position="sticky" top={0} flexShrink={0}>
			<Text>NESTED STICKY</Text>
		</Box>
	</Box>
	<Text>outer tail</Text>
</VLBox>
```

Imperatively scroll `nestedScrollRef` to the sticky row while the nested container remains visible in the outer VLBox. Assert exactly one `NESTED STICKY`, pinned to the nested viewport top, with current paint order.

After `scrollTo({y: 5})` in the first fixture, assert:

- HEADER is on viewport row 0;
- the sticky node's `getBounds().y` equals the viewport y;
- sticky paint order is after the covered row;
- the naturally off-screen sticky node is still painted through the index.

- [ ] **Step 2: Verify the sticky tests fail**

```bash
npm exec -- ava test/fork-layering.tsx --match='VLBox sticky*'
```

Expected: sticky discovery is lost or duplicated when natural sticky nodes are culled.

- [ ] **Step 3: Build sticky indexes during metadata preparation**

Extend the metadata walk with explicit nearest-scroll ownership and unscrolled absolute layout coordinates:

```ts
type StickyOwner = {
	node: DOMElement;
	originX: number;
	originY: number;
};

type MetadataWalk = {
	owner?: StickyOwner;
	nodeX: number;
	nodeY: number;
	parentX: number;
	parentY: number;
	parent?: DOMElement;
	transformers: OutputTransformer[];
	nextPaintOrder: {value: number};
};
```

At function entry, register a sticky node against `state.owner` before changing ownership for its descendants. Cache the immediate parent's position and bounds in the owning VLBox's unscrolled border-box-local coordinate space; Yoga child offsets already include border/padding placement:

```ts
if (node.style.position === 'sticky' && state.owner && state.parent?.yogaNode) {
	state.owner.node.internal_scrollViewportMetadata?.stickyCandidates.push({
		node,
		parentOffset: {
			x: state.parentX - state.owner.originX,
			y: state.parentY - state.owner.originY,
		},
		parentBounds: {
			top: state.parentY - state.owner.originY,
			bottom:
				state.parentY -
				state.owner.originY +
				state.parent.yogaNode.getComputedHeight(),
		},
		parentIsViewport: state.parent === state.owner.node,
		transformers: state.transformers,
		paintOrder: state.nextPaintOrder.value++,
	});
}
```

Before visiting children, determine their owner from the current node's resolved scroll axes:

```ts
const isScrollContainer =
	node.style.overflowX === 'scroll' || node.style.overflowY === 'scroll';
const childOwner = isScrollContainer
	? node.internal_viewportCulling
		? {node, originX: state.nodeX, originY: state.nodeY}
		: undefined
	: state.owner;
```

Initialize a VLBox's `internal_scrollViewportMetadata` before recursing so descendants can register into it. Replace Task 3's child loop with a z-index-sorted loop that still aggregates each returned `subtreePaintBounds` once and passes this walk state:

```ts
const childTransformers =
	typeof node.internal_transform === 'function'
		? [node.internal_transform, ...state.transformers]
		: state.transformers;
const sortedChildren = [...node.childNodes].sort((a, b) => {
	const aZ = (a as DOMElement).style?.zIndex ?? 0;
	const bZ = (b as DOMElement).style?.zIndex ?? 0;
	return aZ - bZ;
});
for (const childNode of sortedChildren) {
	if (childNode.nodeName === '#text') continue;
	const child = childNode as DOMElement;
	const childX = state.nodeX + (child.yogaNode?.getComputedLeft() ?? 0);
	const childY = state.nodeY + (child.yogaNode?.getComputedTop() ?? 0);
	const childMetadata = buildNode(child, epoch, {
		owner: childOwner,
		nodeX: childX,
		nodeY: childY,
		parentX: state.nodeX,
		parentY: state.nodeY,
		parent: node,
		transformers: childTransformers,
		nextPaintOrder: state.nextPaintOrder,
	});
	if (!childMetadata || !child.yogaNode) continue;
	const childPaint = translate(
		childMetadata.subtreePaintBounds,
		child.yogaNode.getComputedLeft(),
		child.yogaNode.getComputedTop(),
	);
	childPaintBounds = childPaintBounds
		? union(childPaintBounds, childPaint)
		: childPaint;
	hasUnboundedTransform ||= childMetadata.hasUnboundedTransform;
}
```

Start the root walk with:

```ts
buildNode(root, epoch, {
	owner: undefined,
	nodeX: 0,
	nodeY: 0,
	parentX: 0,
	parentY: 0,
	parent: undefined,
	transformers: [],
	nextPaintOrder: {value: 0},
});
```

A nested normal scroll container therefore clears indexed ownership for its descendants and retains traversal-time sticky discovery; a nested scrolling VLBox replaces ownership with itself. Sort each completed candidate array by `paintOrder`.

- [ ] **Step 4: Paint indexed stickies once per VLBox**

Extend `ScrollContext` with:

```ts
indexedStickyCandidates?: readonly StickyCandidate[];
```

Populate this field for a VLBox whose resolved `overflowX` or `overflowY` is `scroll` and whose metadata is current, including when its live offset is `{x: 0, y: 0}`. “Scrolling” here describes container mode, not a nonzero offset. Replace the current sticky deferral branch with:

```ts
if (node.style.position === 'sticky' && scrollContext) {
	if (scrollContext.indexedStickyCandidates !== undefined) return;
	scrollContext.stickyNodes.push({
		node,
		offsetX,
		offsetY,
		transformers,
		parentTop,
		parentBottom,
	});
	return;
}
```

A nested normal scroll container creates its existing fresh context with `indexedStickyCandidates: undefined`, so its sticky descendants continue into `stickyNodes`. After normal children:

```ts
const indexed = newScrollContext.indexedStickyCandidates;
if (indexed) {
	for (const sticky of indexed) {
		renderIndexedStickyNode(sticky, newScrollContext, output, paintState);
	}
} else {
	for (const sticky of newScrollContext.stickyNodes) {
		renderStickyNode(sticky.node, {
			output,
			position: {x: sticky.offsetX, y: sticky.offsetY},
			transformers: sticky.transformers,
			scrollContext: newScrollContext,
			parentBounds: {
				top: sticky.parentTop,
				bottom: sticky.parentBottom,
			},
			paintState,
		});
	}
}
```

`renderIndexedStickyNode` translates cached content-space coordinates exactly once:

```ts
const position = {
	x: context.containerX + candidate.parentOffset.x - context.scrollOffset.x,
	y: context.containerY + candidate.parentOffset.y - context.scrollOffset.y,
};
const parentBounds = candidate.parentIsViewport
	? {
			top: context.containerY,
			bottom: context.containerY + context.containerHeight,
		}
	: {
			top:
				context.containerY +
				candidate.parentBounds.top -
				context.scrollOffset.y,
			bottom:
				context.containerY +
				candidate.parentBounds.bottom -
				context.scrollOffset.y,
		};
renderStickyNode(candidate.node, {
	output,
	position,
	transformers: candidate.transformers,
	scrollContext: context,
	parentBounds,
	paintState,
});
```

This deliberately leaves the owning viewport's own parent bounds unscrolled, matching current direct-child sticky behavior. `renderStickyNode` remains the single owner of adding the sticky node's Yoga left/top, applying the clamp, setting/clearing `internal_stickyRect`, and marking paint order. Keep the existing `stickyNodes` loop byte-for-byte for normal scroll boxes.

- [ ] **Step 5: Run sticky, culling, and pointer-order regressions**

```bash
npm exec -- ava test/vlbox.tsx test/fork-layering.tsx test/fork-scroll.tsx
npm run typecheck
npm run lint
```

Expected: all tests pass; no duplicate HEADER output and paint ordering stays stable.

- [ ] **Step 6: Commit**

```bash
git add src/layout-metadata.ts src/render-node-to-output.ts test/fork-layering.tsx
git commit -m "perf: index VLBox sticky descendants"
```

---

### Task 6: Paint-only imperative scrolling and invalidation

**Repository:** `packages/ink`

**Files:**
- Modify: `src/components/Box.tsx:97-189,243-277`
- Modify: `src/layout-metadata.ts`
- Modify: `src/render-node-to-output.ts:415-437`
- Test: `test/vlbox.tsx`

**Interfaces:**
- Produces: `requestRootPaint(node: DOMElement): void`
- Produces: `clampViewportScroll(node: DOMElement, requested?: {x?: number; y?: number}): {x: number; y: number}`
- Synchronizes the shared component's `scrollStateRef` with the authoritative VLBox host offset.
- Suppresses root repaint requests when a VLBox offset is unchanged.
- `Box` retains `setScrollVersion`; `VLBox` does not call it.

- [ ] **Step 1: Add failing zero-layout and invalidation tests**

Add an AVA test with the exact title `VLBox scroll is paint-only and suppresses unchanged repaint`. Mount `VLBox` with an external ref and no effect/state-driven scroll. After the first flushed frame:

```tsx
const root = rootOf(viewportRef.current!);
const epoch = root.internal_layoutEpoch;
viewportRef.current!.scrollTo({y: 2});
await waitForWriteCount(stdout, 2);
t.is(root.internal_layoutEpoch, epoch);
t.true(stdout.get().includes('Line 3'));
let paintRequests = 0;
const onRender = root.onRender!;
root.onRender = () => {
	paintRequests++;
	onRender();
};
const {act} = await import('react');
await act(async () => {
	viewportRef.current!.scrollTo({y: 2});
});
t.is(paintRequests, 0);
```

Add these exact tests:

- `VLBox host offset survives a later paint-only React commit`: scroll imperatively, rerender only a color prop, flush, and assert `getScrollPosition()` and the visible row remain unchanged;
- `VLBox normalizes invalid scroll offsets`: call `scrollTo({x: Number.NaN, y: Number.POSITIVE_INFINITY})` and assert finite clamped values;
- `VLBox clamps retained scroll after content shrink`: scroll to bottom, rerender shorter content, and observe the host offset clamped to the new maximum;
- `VLBox recalculates metadata and clamps after terminal resize`: resize fake stdout, emit `resize`, and observe a new epoch plus valid offset;
- `nested VLBoxes retain independent offsets`: changing one offset leaves the other unchanged.

- [ ] **Step 2: Verify the zero-layout test fails**

```bash
npm exec -- ava test/vlbox.tsx \
  --match='VLBox scroll is paint-only*' \
  --match='VLBox host offset survives*'
```

Expected: the epoch assertion already passes after Task 1, but the unchanged-offset assertion fails because current `Box.scrollTo()` still commits React state and requests another root paint.

- [ ] **Step 3: Add paint request and clamp helpers**

In `src/layout-metadata.ts`:

```ts
export const requestRootPaint = (node: DOMElement): void => {
	let root = node;
	while (root.parentNode) root = root.parentNode as DOMElement;
	root.onRender?.();
};

const finiteOr = (value: number | undefined, fallback: number): number =>
	value === undefined ? fallback : Number.isFinite(value) ? value : 0;

export const clampViewportScroll = (
	node: DOMElement,
	requested: {x?: number; y?: number} = {},
): {x: number; y: number} => {
	const current = node.internal_scrollOffset ?? {x: 0, y: 0};
	const metadata = getScrollViewportMetadata(node);
	if (!metadata || !node.yogaNode) return current;
	const yoga = node.yogaNode;
	const width =
		yoga.getComputedWidth() -
		yoga.getComputedBorder(Yoga.EDGE_LEFT) -
		yoga.getComputedBorder(Yoga.EDGE_RIGHT);
	const height =
		yoga.getComputedHeight() -
		yoga.getComputedBorder(Yoga.EDGE_TOP) -
		yoga.getComputedBorder(Yoga.EDGE_BOTTOM);
	const maxX = Math.max(0, metadata.contentExtent.width - width);
	const maxY = Math.max(0, metadata.contentExtent.height - height);
	return {
		x: Math.max(0, Math.min(finiteOr(requested.x, current.x), maxX)),
		y: Math.max(0, Math.min(finiteOr(requested.y, current.y), maxY)),
	};
};
```

Adjust viewport dimensions for computed borders exactly as current `Box.getMaxScroll()` does.

- [ ] **Step 4: Split only the imperative invalidation branch**

In the shared Box ref methods:

```ts
const sameOffset = (
	a: {x: number; y: number},
	b: {x: number; y: number},
): boolean => a.x === b.x && a.y === b.y;

const applyViewportScroll = (requested: {x?: number; y?: number}) => {
	if (viewportCulling) {
		const current = element.internal_scrollOffset ?? scrollStateRef.current;
		const next = clampViewportScroll(element, requested);
		// Keep the hook ref synchronized before the caller's React controller
		// commit can run this component's layout effect.
		scrollStateRef.current = {...next};
		if (sameOffset(current, next)) return;
		element.internal_scrollOffset = {...next};
		requestRootPaint(element);
		return;
	}

	const maxScroll = getMaxScroll();
	if (requested.x !== undefined) {
		scrollStateRef.current.x = Math.max(
			0,
			Math.min(requested.x, maxScroll.x),
		);
	}
	if (requested.y !== undefined) {
		scrollStateRef.current.y = Math.max(
			0,
			Math.min(requested.y, maxScroll.y),
		);
	}
	element.internal_scrollOffset = {...scrollStateRef.current};
	setScrollVersion(version => version + 1);
};
```

Use `applyViewportScroll(requested)` from `scrollTo`. `scrollToTop()` calls `applyViewportScroll({y: 0})`; `scrollToBottom()` calls `applyViewportScroll({y: Number.MAX_SAFE_INTEGER})`, which remains finite and clamps to the cached maximum. For `VLBox`, `getScrollPosition()` reads `element.internal_scrollOffset ?? {x: 0, y: 0}`. Keep normal Box behavior byte-for-byte.

Split the existing layout effect by mode. Normal `Box` keeps writing `scrollStateRef.current` to the host. `VLBox` reads the retained host value back into the hook ref instead, so a later React commit cannot reset an imperative offset:

```ts
useLayoutEffect(() => {
	const element = internalRef.current;
	if (!element || !isScrollContainer) return;
	if (viewportCulling) {
		const retained = element.internal_scrollOffset ?? scrollStateRef.current;
		scrollStateRef.current = {...retained};
		element.internal_scrollOffset = {...retained};
		return;
	}
	element.internal_scrollOffset = scrollStateRef.current;
});
```

Before reading `scrollOffset` for a current-epoch VLBox in `renderNodeToOutput`, clamp and write the host value without requesting another paint:

```ts
if (node.internal_viewportCulling && getScrollViewportMetadata(node)) {
	const current = node.internal_scrollOffset ?? {x: 0, y: 0};
	const clamped = clampViewportScroll(node);
	if (!sameOffset(current, clamped)) {
		node.internal_scrollOffset = {...clamped};
	}
}
```

Export `sameOffset` from `layout-metadata.ts` or keep an identical private helper at both call sites. This handles content shrink and resize in the frame that discovered the new extent; `getScrollPosition()` reads that authoritative host value, and the next component layout effect synchronizes the hook ref from it.

- [ ] **Step 5: Run the scroll and dynamic-layout suites**

```bash
npm exec -- ava test/vlbox.tsx test/fork-scroll.tsx test/terminal-resize.tsx test/use-box-metrics.tsx
npm run typecheck
npm run lint
```

Expected: all pass and the explicit epoch assertion proves zero Yoga layouts per warm scroll.

- [ ] **Step 6: Commit**

```bash
git add src/components/Box.tsx src/layout-metadata.ts src/render-node-to-output.ts test/vlbox.tsx
git commit -m "perf: make VLBox scrolling paint-only"
```

---

### Task 7: Selection, accessibility, and full correctness gates

**Repository:** `packages/ink`

**Files:**
- Modify: `test/vlbox.tsx`
- Modify if tests expose defects: `src/layout-metadata.ts`, `src/render-node-to-output.ts`

**Interfaces:**
- No new public interface.
- Proves selection, pointer paint epochs, and screen-reader behavior required by the spec.

- [ ] **Step 1: Add complete selection and screen-reader tests**

Add an AVA test with the exact title `VLBox selection matches the unculled visible output before and after scroll`. Use an interactive `useTextSelection()` fixture, select visible text before and after `VLBox.scrollTo()`, and assert the selection snapshot contains only visible selectable rows and matches the same viewport rendered through normal `Box`.

Add this screen-reader test:

```tsx
test('VLBox screen-reader output includes the complete unscrolled tree', t => {
	const output = renderToString(
		<VLBox height={2} overflow="scroll" flexDirection="column" aria-role="list">
			{Array.from({length: 6}, (_, index) => (
				<Box key={index} aria-role="listitem">
					<Text>Row {index + 1}</Text>
				</Box>
			))}
		</VLBox>,
		{isScreenReaderEnabled: true},
	);
	t.true(output.includes('Row 1'));
	t.true(output.includes('Row 6'));
});
```

Add an AVA test with the exact title `VLBox pointer paint epochs track viewport visibility`: a culled child returns `undefined`; after scrolling it into view its epoch equals the root's current paint epoch.

- [ ] **Step 2: Run tests and apply only correctness fixes they require**

```bash
npm exec -- ava test/vlbox.tsx test/paint-selection.test.ts test/text-selection-controller.test.ts test/text-selection-hook.test.tsx test/screen-reader.tsx test/fork-layering.tsx
```

Expected: all pass. If a failure requires source changes, keep the fix in culling/index code; do not add a second selection or screen-reader path.

- [ ] **Step 3: Run the full nested verification gate**

```bash
npm test
npm run build
git diff --check
```

Expected: typecheck, XO, all AVA tests, build, and whitespace check pass.

- [ ] **Step 4: Commit**

```bash
git add test/vlbox.tsx src/layout-metadata.ts src/render-node-to-output.ts
git commit -m "test: cover VLBox selection and accessibility"
```

If no source or test file changed after Task 6, skip this commit rather than creating an empty commit.

---

### Task 8: Ink warm-scroll benchmark, documentation, and release artifact

**Repository:** `packages/ink`

**Files:**
- Create: `benchmark/vlbox.tsx`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `readme.md`

**Interfaces:**
- Produces: `npm run benchmark:vlbox -- --samples=30 --release-check`
- Produces: package version `7.6.0-alpha` and built `build/index.js` / `build/index.d.ts`.

- [ ] **Step 1: Add the benchmark harness**

Create `benchmark/vlbox.tsx` with `TERMINAL_COLUMNS = 424` and `TERMINAL_ROWS = 95`; expose both through the fake TTY and size the benchmark viewport to the 95-row terminal. Use `render(..., {incrementalRendering: true, maxFps: 1000, onRender})`, 6,000 mixed rows, nested clips, absolute content, and sticky headers. Mount once with `Box` and once with `VLBox`; call their ref `scrollTo({y: current + 1})` for warm samples. Record end-to-end wall time, Ink's `onRender.renderTime`, root `internal_lastRenderVisitCount`, and rendered frames at fixed checkpoint offsets, then report median/p95 for both timing series and maximum visits. The harness must await each committed frame through `onRender`, not a fixed sleep.

The Ink `<=16 ms` and `>=5x` gates use median `onRender.renderTime`, isolating renderer/culling work from event-loop delay. Wall time is reported but not used for the Ink microbenchmark gate; Task 11 gates actual wheel-step wall time through the CLI. Define `MAX_LARGE_VISITS = 600` from 95 visible rows × at most five expanded host nodes per mixed row, plus 20 ancestors and indexed stickies. Compare ANSI output at offsets 1, 10, and 30 between Box and VLBox. The release checks are exact:

```ts
if (vlLargeRenderMedian > 16) {
	throw new Error('VLBox large render median exceeded 16 ms');
}
if (boxLargeRenderMedian / vlLargeRenderMedian < 5) {
	throw new Error('VLBox render speedup was below 5x');
}
if (vlSmallRenderMedian > boxSmallRenderMedian * 1.1) {
	throw new Error('VLBox small-fixture render regression exceeded 10%');
}
if (layoutEpochAfter !== layoutEpochBefore) {
	throw new Error('VLBox scroll triggered Yoga layout');
}
if (vlLargeMaxVisited > MAX_LARGE_VISITS) {
	throw new Error('VLBox renderer visitation exceeded the visible-tree bound');
}
if (!checkpointFramesMatch) {
	throw new Error('VLBox checkpoint frames differ from Box');
}
```

Do not use `debug: true`; it bypasses the production paint path. Warm up five steps and measure at least 30 steps.

- [ ] **Step 2: Add the package command**

In `package.json` scripts:

```json
"benchmark:vlbox": "NODE_NO_WARNINGS=1 node --import=tsx benchmark/vlbox.tsx"
```

- [ ] **Step 3: Run baseline and release checks**

```bash
npm run benchmark:vlbox -- --samples=30
npm run benchmark:vlbox -- --samples=30 --release-check
```

Expected: the report includes Box and VLBox large/small renderer and wall-time medians/p95, renderer speedup, maximum visitation, frame parity, and layout-epoch delta; release check exits 0. Do not lower gates to make a failure pass—profile culling visitation and fix the owning task.

- [ ] **Step 4: Verify the public build before versioning**

```bash
npm test
npm run build
node --input-type=module -e "import('./build/index.js').then(m => { if (!m.VLBox) process.exit(1) })"
```

Expected: all pass and built exports contain `VLBox`.

- [ ] **Step 5: Bump the nested package to 7.6.0-alpha**

```bash
npm version 7.6.0-alpha --no-git-tag-version
npm run build
npm pack --dry-run
```

Expected: `package.json` and `package-lock.json` report `7.6.0-alpha`; dry-run package includes `build/index.js` and `build/index.d.ts`.

- [ ] **Step 6: Commit the benchmark and release artifact**

```bash
git add benchmark/vlbox.tsx package.json package-lock.json readme.md build
git commit -m "chore: prepare 7.6.0-alpha"
```

If `build/` is ignored or intentionally untracked in this repository, omit it from `git add` after verifying `npm pack --dry-run` builds it through `prepare`.

- [ ] **Step 7: Stop for explicit publication approval**

Report the nested commit range, complete test output summary, benchmark table, and `npm pack --dry-run` contents. Do not run `npm publish` until the user explicitly approves publication.

After approval only:

```bash
npm publish --tag alpha
npm view @nuvin/ink@7.6.0-alpha version
```

Expected: registry returns `7.6.0-alpha`.

---

### Task 9: Update outer Ink pins after publication

**Repository:** outer `nuvin-agent`

**Files:**
- Modify: `package.json`
- Modify: `packages/cli/package.json`
- Modify: `packages/ink-input/package.json`
- Modify: `packages/ink-text-input/package.json`
- Modify: `packages/ink-virtualized-list/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: published `@nuvin/ink@7.6.0-alpha`.
- Produces: one consistent npm-resolved Ink runtime for all TUI packages.

- [ ] **Step 1: Restore npm mode before editing pins**

The current workspace may be in development-only `link:packages/ink` mode. Run:

```bash
make ink-npm
git diff -- pnpm-workspace.yaml pnpm-lock.yaml
```

Expected: the override is restored to the committed npm version before the 7.6 edits; no `link:packages/ink` remains.

- [ ] **Step 2: Update every exact Ink pin**

Replace `npm:@nuvin/ink@7.5.0-alpha` with `npm:@nuvin/ink@7.6.0-alpha` in the five package manifests and `pnpm-workspace.yaml` override. Verify:

```bash
rg -n 'npm:@nuvin/ink@7\.5\.0-alpha|link:packages/ink' package.json pnpm-workspace.yaml packages/*/package.json
```

Expected: no matches.

- [ ] **Step 3: Regenerate and verify the lockfile**

```bash
corepack pnpm install
corepack pnpm why ink
```

Expected: all consumers resolve `npm:@nuvin/ink@7.6.0-alpha`; no link resolution appears.

- [ ] **Step 4: Build and test dist-consuming support packages in order**

```bash
corepack pnpm --filter @nuvin/ink-input build
corepack pnpm --filter @nuvin/ink-input test
corepack pnpm --filter @nuvin/ink-text-input build
corepack pnpm --filter @nuvin/ink-text-input test
corepack pnpm --filter @nuvin/ink-virtualized-list build
corepack pnpm --filter @nuvin/ink-virtualized-list test
```

Expected: all pass against the published 7.6 build.

- [ ] **Step 5: Commit the dependency alignment**

```bash
git add package.json packages/cli/package.json packages/ink-input/package.json packages/ink-text-input/package.json packages/ink-virtualized-list/package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore: upgrade TUI packages to Ink 7.6"
```

Do not include the user's unrelated untracked design files.

---

### Task 10: Integrate VLBox into CLI ScrollBox

**Repository:** outer `nuvin-agent`

**Files:**
- Modify: `packages/cli/src/components/ComboBox/ScrollBox.tsx:2,117-245,411-499`
- Modify: `packages/cli/src/components/ComboBox/ScrollBox.test.tsx`
- Test: `packages/cli/src/components/ComboBox/ComboBox.test.tsx`
- Test: `packages/cli/src/components/ApprovalModal.test.tsx`

**Interfaces:**
- `ScrollBoxProps`, focus IDs, callbacks, follow state, scrollbar appearance, and selection refs remain unchanged.
- The internal viewport ref remains structurally compatible because `VLBoxRef = BoxRef`.
- Produces: imperative-first wheel/keyboard/drag updates backed by a synchronized controller ref.
- Produces: stable one-Text-per-row scrollbar Yoga geometry while viewport height is unchanged.

- [ ] **Step 1: Add a failing integration assertion**

Add these exact tests in `ScrollBox.test.tsx`:

1. `moves the VLBox host before synchronizing wheel controller state`: capture the viewport through `onViewportRef`, send one wheel-down event, and immediately assert `viewport.getScrollPosition().y === 1` before polling for the React-rendered scrollbar frame.
2. `keeps scrollbar Yoga geometry stable while the thumb moves`: capture the viewport's Ink root `internal_layoutEpoch`, send a wheel step, wait for the controller commit, and assert the epoch is unchanged and the thumb moved one row. This test requires one stable `Text` child per track row.
3. `keeps mixed-tree pointer targeting correct after imperative VLBox scrolling`: use 200 rows, a sticky child, an absolute badge, and `Clickable` rows; wheel to a deep row and assert that row receives hover while the original row does not. Keep SGR mouse coordinates derived from the rendered frame, following existing tests.

Task 9's built-export check already proves that the resolved Ink package exports `VLBox`; do not add a temporary module spy.

- [ ] **Step 2: Run the focused test before the swap**

```bash
corepack pnpm --filter @nuvin/nuvin-code exec vitest run src/components/ComboBox/ScrollBox.test.tsx
```

Expected: the immediate host-position and unchanged-layout-epoch assertions fail with the React-driven `Box`; the mixed-tree characterization remains green.

- [ ] **Step 3: Integrate the VLBox host and paint-only controller path**

Update the `ScrollBox` comment to call it a retained-layout scroll viewport: all arbitrary children remain mounted and measured, while `VLBox` culls off-screen paint work. Keep the note that parent layout owns available height.

Change only the Ink import needed by the viewport:

```tsx
import {Box, type BoxRef, measureElement, Text, VLBox} from 'ink';
```

Extract the existing inline controller-state annotation to this local type:

```ts
type ScrollState = {
	resetKey: ScrollBoxProps['resetKey'];
	userScroll: {sourceScrollY: number; scrollY: number} | null;
	followEnabled: boolean;
	followingEnd: boolean;
};
```

Replace the inline state declaration with:

```ts
const [scrollState, setScrollState] = useState<ScrollState>({
	resetKey,
	userScroll: null,
	followEnabled: followEnd,
	followingEnd: followEnd,
});
const scrollStateRef = useRef(scrollState);
scrollStateRef.current = scrollState;
```

Add one imperative-first commit helper:

```ts
const commitScrollState = useCallback((nextState: ScrollState, nextY: number) => {
	viewportRef.current?.scrollTo({x: 0, y: nextY});
	scrollStateRef.current = nextState;
	setScrollState(nextState);
}, []);
```

Rewrite `scrollBy` to compute from `scrollStateRef.current` and move the host before committing state:

```ts
const scrollBy = useCallback(
	(delta: number) => {
		const current = scrollStateRef.current;
		const base = current.followingEnd
			? maxScrollY
			: current.userScroll?.sourceScrollY === scrollY
				? current.userScroll.scrollY
				: clampedScrollY;
		const next = Math.min(Math.max(0, base + delta), maxScrollY);
		commitScrollState(
			{
				...current,
				userScroll: {sourceScrollY: scrollY, scrollY: next},
				followingEnd: current.followEnabled
					? next === maxScrollY
					: current.followingEnd,
			},
			next,
		);
	},
	[clampedScrollY, commitScrollState, maxScrollY, scrollY],
);
```

Rewrite `scrollScrollbarTo` the same way after calculating `next`:

```ts
const current = scrollStateRef.current;
commitScrollState(
	{
		...current,
		userScroll: {sourceScrollY: scrollY, scrollY: next},
		followingEnd: current.followEnabled
			? next === maxScrollY
			: current.followingEnd,
	},
	next,
);
```

Do not put the imperative mutation inside a React state-updater callback.

In the measurement layout effect, determine whether metrics changed before calling the setter. When following the end, move to the maximum derived from the newly measured values before committing those metrics:

```ts
const metricsChanged =
	metrics.containerHeight !== nextMetrics.containerHeight ||
	metrics.contentHeight !== nextMetrics.contentHeight;
if (metricsChanged && scrollStateRef.current.followingEnd) {
	const nextMaxScrollY = Math.max(
		0,
		nextMetrics.contentHeight - nextMetrics.containerHeight,
	);
	viewportRef.current.scrollTo({x: 0, y: nextMaxScrollY});
}
setMetrics(current =>
	current.containerHeight === nextMetrics.containerHeight &&
	current.contentHeight === nextMetrics.contentHeight
		? current
		: nextMetrics,
);
```

Include `metrics.containerHeight` and `metrics.contentHeight` in the effect's captured render values; the existing no-dependency layout effect still runs after every commit. Retain the existing `[clampedScrollY]` layout effect for controlled `scrollY`, reset, and post-commit synchronization; VLBox's unchanged-offset suppression makes it a no-op after imperative-first handlers.

At the viewport around current lines 411–433, make an exact outer-tag swap. Preserve every existing prop and provider callback; only `Box` becomes `VLBox`:

```tsx
<VLBox
	ref={viewportRef}
	flexDirection="column"
	width={viewportInnerWidth}
	height="100%"
	overflow="scroll"
	backgroundColor={backgroundColor}
>
	<ScrollMouseBoundsProvider
		getScrollPosition={getScrollPosition}
		getViewportBounds={wheelGetBounds}
	>
		<Box
			ref={contentRef}
			flexDirection="column"
			flexShrink={0}
			width="100%"
			backgroundColor={backgroundColor}
		>
			{children}
		</Box>
	</ScrollMouseBoundsProvider>
</VLBox>
```

Finally, preserve the scrollbar's outer Box and glyph appearance but keep Yoga geometry fixed while `containerHeight` is stable. Replace the three variable-height Text groups with one keyed Text per track row:

```tsx
<Box flexDirection="column" flexShrink={0} width={1}>
	{Array.from({length: trackHeight}, (_, row) => {
		const isThumb = row >= thumbPosition && row < thumbPosition + thumbHeight;
		return (
			<Text key={row} color={isThumb ? color : trackColor}>
				{SCROLLBAR_GLYPH}
			</Text>
		);
	})}
</Box>
```

Remove `repeatGlyph` if this leaves it unused. Keep the root layout, public props/callbacks, controlled synchronization, focus/capture behavior, selection bounds, and scrollbar drag math unchanged.

- [ ] **Step 4: Run ScrollBox consumer regressions**

```bash
corepack pnpm --filter @nuvin/nuvin-code exec vitest run \
  src/components/ComboBox/ScrollBox.test.tsx \
  src/components/ComboBox/ComboBox.test.tsx \
  src/components/ApprovalModal.test.tsx
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/components/ComboBox/ScrollBox.tsx packages/cli/src/components/ComboBox/ScrollBox.test.tsx
git commit -m "perf(cli): use VLBox for scroll viewports"
```

---

### Task 11: Tool-detail large-result regression and benchmark

**Repository:** outer `nuvin-agent`

**Files:**
- Modify: `packages/cli/src/components/ToolDetailModal.test.tsx`
- Create: `packages/cli/scripts/benchmark-vlbox-tool-detail.tsx`
- Modify: `package.json`
- Create: `.changeset/ink-7-6-vlbox.md`

**Interfaces:**
- Tool-detail formatting, Markdown rendering, unified ARGS/SOURCE/RESULT scroll, copy payloads, and modal chrome remain unchanged.
- Produces: root command `benchmark:vlbox-tool-detail`.

- [ ] **Step 1: Add the large-result regression**

Add a Vitest test with the exact title `scrolls a large tool result through wheel keyboard scrollbar and selection paths`, using approximately 400 physical lines with long wrapped bodies and a sentinel near line 320. Open the normal Bash detail modal, then:

1. Assert first rows are visible and sentinel is absent.
2. Send PageDown until the sentinel is visible, polling each frame rather than sleeping.
3. Send `k` and `j` and assert one-line movement behavior remains.
4. Drag-select visible result text using SGR press/move/release and assert `copyText` receives the selection.
5. Assert the scrollbar and existing RESULT Markdown/plain formatting remain visible.

Use the existing helpers and selection test near `ToolDetailModal.test.tsx:249`; do not duplicate clipboard plumbing.

- [ ] **Step 2: Run the regression**

```bash
corepack pnpm --filter @nuvin/nuvin-code exec vitest run src/components/ToolDetailModal.test.tsx
```

Expected: PASS with the VLBox-backed ScrollBox.

- [ ] **Step 3: Add the actual modal benchmark**

Create `packages/cli/scripts/benchmark-vlbox-tool-detail.tsx` using the existing fake TTY/input and median/p95 helpers from `benchmark-virtualized-list.tsx`. Set fake terminal columns to `424` and rows to `95`. Render a `ToolDetailModal` with a 200–250 KB result, initialize the theme store, focus `tool-detail.content`, warm five wheel steps, and measure end-to-end wall time for 30 committed wheel steps through Ink's production path:

```tsx
render(<ToolDetailModal open message={message} childMessages={[]} copyText={() => {}} onClose={() => {}} />, {
	stdout,
	stdin,
	maxFps: 1000,
	incrementalRendering: true,
	onRender: () => { commits += 1; },
});
```

The `--release-check` branch throws when median exceeds 16 ms. Report initial mount separately and do not include it in warm-scroll samples.

- [ ] **Step 4: Add and run the benchmark command**

Add to root `package.json`:

```json
"benchmark:vlbox-tool-detail": "pnpm --filter @nuvin/nuvin-code exec tsx scripts/benchmark-vlbox-tool-detail.tsx"
```

Run:

```bash
corepack pnpm benchmark:vlbox-tool-detail -- --samples 30
corepack pnpm benchmark:vlbox-tool-detail -- --samples 30 --release-check
```

Expected: median `<= 16 ms`; initial mount is printed separately.

- [ ] **Step 5: Add the outer changeset**

Create `.changeset/ink-7-6-vlbox.md`:

```md
---
"@nuvin/ink-input": patch
"@nuvin/ink-text-input": patch
"@nuvin/ink-virtualized-list": patch
"@nuvin/nuvin-code": patch
---

Upgrade the TUI to @nuvin/ink 7.6.0-alpha and cull off-screen ScrollBox paint work so large tool results scroll smoothly without changing layout or interaction behavior.
```

- [ ] **Step 6: Run focused CLI verification**

```bash
corepack pnpm --filter @nuvin/nuvin-code exec vitest run \
  src/components/ComboBox/ScrollBox.test.tsx \
  src/components/ToolDetailModal.test.tsx
corepack pnpm --filter @nuvin/nuvin-code build
corepack pnpm biome check \
  packages/cli/src/components/ComboBox/ScrollBox.tsx \
  packages/cli/src/components/ComboBox/ScrollBox.test.tsx \
  packages/cli/src/components/ToolDetailModal.test.tsx \
  packages/cli/scripts/benchmark-vlbox-tool-detail.tsx
```

Expected: tests, build, and Biome pass.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/components/ToolDetailModal.test.tsx packages/cli/scripts/benchmark-vlbox-tool-detail.tsx package.json .changeset/ink-7-6-vlbox.md
git commit -m "test(cli): verify large-result VLBox scrolling"
```

---

### Task 12: Final cross-repository verification

**Repositories:** nested `packages/ink`, then outer `nuvin-agent`

**Files:** verification only

**Interfaces:** no new interfaces; this is the release proof gate.

- [ ] **Step 1: Verify nested Ink at the exact release commit**

```bash
cd packages/ink
npm test
npm run build
npm run benchmark:vlbox -- --samples=30 --release-check
git status --short
```

Expected: all commands pass and nested status is clean.

- [ ] **Step 2: Verify outer dependency resolution and focused consumers**

```bash
cd ../..
corepack pnpm why ink
corepack pnpm --filter @nuvin/ink-input build
corepack pnpm --filter @nuvin/ink-input test
corepack pnpm --filter @nuvin/ink-text-input build
corepack pnpm --filter @nuvin/ink-text-input test
corepack pnpm --filter @nuvin/ink-virtualized-list build
corepack pnpm --filter @nuvin/ink-virtualized-list test
corepack pnpm --filter @nuvin/nuvin-code exec vitest run \
  src/components/ComboBox/ScrollBox.test.tsx \
  src/components/ComboBox/ComboBox.test.tsx \
  src/components/ApprovalModal.test.tsx \
  src/components/ToolDetailModal.test.tsx
corepack pnpm --filter @nuvin/nuvin-code build
corepack pnpm benchmark:vlbox-tool-detail -- --samples 30 --release-check
```

Expected: all consumers resolve `@nuvin/ink@7.6.0-alpha`; all tests/builds/benchmark pass.

- [ ] **Step 3: Verify repository hygiene**

```bash
rg -n 'npm:@nuvin/ink@7\.5\.0-alpha|link:packages/ink' package.json pnpm-workspace.yaml packages/*/package.json || true
git diff --check
git status --short
```

Expected: no old/link Ink references, no whitespace errors, and only explicitly user-owned unrelated files remain untracked. Do not alter `.changeset/pre.json`.

- [ ] **Step 4: Request code review before merge or push**

Run the requesting-code-review workflow against:

- the nested Ink commit range from Task 1 through Task 8;
- the outer commit range from Task 9 through Task 11;
- the approved design and this implementation plan.

Fix only findings tied to correctness, performance gates, API compatibility, security, or test coverage. Re-run the affected repository's full gate after fixes. Do not push, publish another version, or merge without explicit user direction.
