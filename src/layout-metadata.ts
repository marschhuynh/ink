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
