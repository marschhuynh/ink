import Yoga from 'yoga-layout';
import {
	type DOMElement,
	type NodeLayoutMetadata,
	type Rect,
	type ScrollViewportMetadata,
} from './dom.js';

const rect = (
	left: number,
	top: number,
	width: number,
	height: number,
): Rect => ({
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

const yogaLessSubtreeHasUnboundedTransform = (node: DOMElement): boolean => {
	if (node.internal_transformAffectsGeometry === true) {
		return true;
	}

	for (const childNode of node.childNodes) {
		if (childNode.nodeName === '#text' || childNode.yogaNode) {
			continue;
		}

		if (yogaLessSubtreeHasUnboundedTransform(childNode)) {
			return true;
		}
	}

	return false;
};

const buildNode = (
	node: DOMElement,
	epoch: number,
): NodeLayoutMetadata | undefined => {
	const yoga = node.yogaNode;
	if (!yoga || yoga.getDisplay() === Yoga.DISPLAY_NONE) return undefined;

	const own = rect(0, 0, yoga.getComputedWidth(), yoga.getComputedHeight());
	let childPaintBounds: Rect | undefined;
	let hasUnboundedTransform = node.internal_transformAffectsGeometry === true;
	const viewport = node.internal_viewportCulling
		? ({
				epoch,
				contentExtent: {width: 0, height: 0},
				stickyCandidates: [],
			} satisfies ScrollViewportMetadata)
		: undefined;
	if (viewport) node.internal_scrollViewportMetadata = viewport;

	for (const childNode of node.childNodes) {
		if (childNode.nodeName === '#text') continue;
		const child = childNode;
		if (!child.yogaNode) {
			hasUnboundedTransform ||= yogaLessSubtreeHasUnboundedTransform(child);
			continue;
		}

		const childMetadata = buildNode(child, epoch);
		if (!childMetadata) continue;
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
	while (root.parentNode) root = root.parentNode;
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

export type CullingViewport = {
	rect: Rect;
	clipX: boolean;
	clipY: boolean;
};

export const intersectsViewport = (
	bounds: Rect,
	viewport: CullingViewport,
): boolean => {
	const xVisible =
		!viewport.clipX ||
		(bounds.right > viewport.rect.left && bounds.left < viewport.rect.right);
	const yVisible =
		!viewport.clipY ||
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
			nodeX + yoga.getComputedWidth() - yoga.getComputedBorder(Yoga.EDGE_RIGHT),
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
