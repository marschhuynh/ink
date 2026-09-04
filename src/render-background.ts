import colorize from './colorize.js';
import {type DOMElement, type DOMNode, type Rect} from './dom.js';
import type Output from './output.js';

const recordSurfaceWrite = (node: DOMElement, cellWidth: number): void => {
	node.internal_lastSurfaceWriteCount =
		(node.internal_lastSurfaceWriteCount ?? 0) + 1;
	node.internal_lastSurfaceCellCount =
		(node.internal_lastSurfaceCellCount ?? 0) + cellWidth;
};

/* eslint-disable max-params -- visibleRect is an optional culling bound */
const renderBackground = (
	x: number,
	y: number,
	node: DOMNode,
	output: Output,
	visibleRect?: Rect,
): void => {
	if (!node.style.backgroundColor) {
		return;
	}

	const width = node.yogaNode!.getComputedWidth();
	const height = node.yogaNode!.getComputedHeight();

	// Calculate the actual content area considering borders
	const leftBorderWidth =
		node.style.borderStyle && node.style.borderLeft !== false ? 1 : 0;
	const rightBorderWidth =
		node.style.borderStyle && node.style.borderRight !== false ? 1 : 0;
	const topBorderHeight =
		node.style.borderStyle && node.style.borderTop !== false ? 1 : 0;
	const bottomBorderHeight =
		node.style.borderStyle && node.style.borderBottom !== false ? 1 : 0;

	const contentWidth = width - leftBorderWidth - rightBorderWidth;
	const contentHeight = height - topBorderHeight - bottomBorderHeight;

	if (!(contentWidth > 0 && contentHeight > 0)) {
		return;
	}

	const contentLeft = x + leftBorderWidth;
	const contentTop = y + topBorderHeight;
	const contentRight = contentLeft + contentWidth;
	const contentBottom = contentTop + contentHeight;

	let visibleLeft = contentLeft;
	let visibleTop = contentTop;
	let visibleRight = contentRight;
	let visibleBottom = contentBottom;

	if (visibleRect) {
		visibleLeft = Math.max(contentLeft, visibleRect.left);
		visibleTop = Math.max(contentTop, visibleRect.top);
		visibleRight = Math.min(contentRight, visibleRect.right);
		visibleBottom = Math.min(contentBottom, visibleRect.bottom);
	}

	const lineWidth = visibleRight - visibleLeft;
	const rowCount = visibleBottom - visibleTop;

	if (!(lineWidth > 0 && rowCount > 0)) {
		return;
	}

	// Create background fill for each visible row
	const backgroundLine = colorize(
		' '.repeat(lineWidth),
		node.style.backgroundColor,
		'background',
	);

	for (let row = visibleTop; row < visibleBottom; row++) {
		output.write(visibleLeft, row, backgroundLine, {transformers: []});
		recordSurfaceWrite(node as DOMElement, lineWidth);
	}
};

/* eslint-enable max-params */

export default renderBackground;
