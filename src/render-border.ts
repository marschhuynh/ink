import cliBoxes from 'cli-boxes';
import chalk from 'chalk';
import colorize from './colorize.js';
import {type DOMElement, type DOMNode, type Rect} from './dom.js';
import type Output from './output.js';

const stylePiece = (
	segment: string,
	fg?: string,
	bg?: string,
	dim?: boolean,
): string => {
	let styled = colorize(segment, fg, 'foreground');
	styled = colorize(styled, bg, 'background');
	if (dim) {
		styled = chalk.dim(styled);
	}

	return styled;
};

const recordSurfaceWrite = (node: DOMElement, cellWidth: number): void => {
	node.internal_lastSurfaceWriteCount =
		(node.internal_lastSurfaceWriteCount ?? 0) + 1;
	node.internal_lastSurfaceCellCount =
		(node.internal_lastSurfaceCellCount ?? 0) + cellWidth;
};

const findAncestorBackgroundColor = (node: DOMNode): string | undefined => {
	let current = node.parentNode;
	while (current) {
		if (current.style.backgroundColor) {
			return current.style.backgroundColor;
		}

		current = current.parentNode;
	}

	return undefined;
};

/* eslint-disable max-params -- visibleRect and stylePiece edge args */
const renderBorder = (
	x: number,
	y: number,
	node: DOMNode,
	output: Output,
	visibleRect?: Rect,
): void => {
	const element = node as DOMElement;
	if (node.style.borderStyle) {
		const width = node.yogaNode!.getComputedWidth();
		const height = node.yogaNode!.getComputedHeight();
		const box =
			typeof node.style.borderStyle === 'string'
				? cliBoxes[node.style.borderStyle]
				: node.style.borderStyle;

		const topBorderColor = node.style.borderTopColor ?? node.style.borderColor;
		const bottomBorderColor =
			node.style.borderBottomColor ?? node.style.borderColor;
		const leftBorderColor =
			node.style.borderLeftColor ?? node.style.borderColor;
		const rightBorderColor =
			node.style.borderRightColor ?? node.style.borderColor;

		const fallbackBackgroundColor =
			node.style.backgroundColor ?? findAncestorBackgroundColor(node);
		const topBorderBackgroundColor =
			node.style.borderTopBackgroundColor ??
			node.style.borderBackgroundColor ??
			fallbackBackgroundColor;
		const bottomBorderBackgroundColor =
			node.style.borderBottomBackgroundColor ??
			node.style.borderBackgroundColor ??
			fallbackBackgroundColor;
		const leftBorderBackgroundColor =
			node.style.borderLeftBackgroundColor ??
			node.style.borderBackgroundColor ??
			fallbackBackgroundColor;
		const rightBorderBackgroundColor =
			node.style.borderRightBackgroundColor ??
			node.style.borderBackgroundColor ??
			fallbackBackgroundColor;

		const dimTopBorderColor =
			node.style.borderTopDimColor ?? node.style.borderDimColor;

		const dimBottomBorderColor =
			node.style.borderBottomDimColor ?? node.style.borderDimColor;

		const dimLeftBorderColor =
			node.style.borderLeftDimColor ?? node.style.borderDimColor;

		const dimRightBorderColor =
			node.style.borderRightDimColor ?? node.style.borderDimColor;

		const showTopBorder = node.style.borderTop !== false;
		const showBottomBorder = node.style.borderBottom !== false;
		const showLeftBorder = node.style.borderLeft !== false;
		const showRightBorder = node.style.borderRight !== false;

		const contentWidth =
			width - (showLeftBorder ? 1 : 0) - (showRightBorder ? 1 : 0);

		const topY = y;
		const bottomY = y + height - 1;
		const leftX = x;
		const rightX = x + width - 1;

		const visibleLeft = visibleRect ? visibleRect.left : -Infinity;
		const visibleRight = visibleRect ? visibleRect.right : Infinity;
		const visibleTop = visibleRect ? visibleRect.top : -Infinity;
		const visibleBottom = visibleRect ? visibleRect.bottom : Infinity;

		const horizontalSlice = (
			unstyled: string,
			rowY: number,
			fg?: string,
			bg?: string,
			dim?: boolean,
		): void => {
			if (!(rowY >= visibleTop && rowY < visibleBottom)) {
				return;
			}

			const sliceStart = Math.max(0, Math.ceil(visibleLeft - x));
			const sliceEnd = Math.min(unstyled.length, Math.floor(visibleRight - x));
			if (!(sliceEnd > sliceStart)) {
				return;
			}

			const segment = unstyled.slice(sliceStart, sliceEnd);
			output.write(x + sliceStart, rowY, stylePiece(segment, fg, bg, dim), {
				transformers: [],
			});
			recordSurfaceWrite(element, segment.length);
		};

		if (showTopBorder) {
			const topUnstyled =
				(showLeftBorder ? box.topLeft : '') +
				box.top.repeat(contentWidth) +
				(showRightBorder ? box.topRight : '');
			horizontalSlice(
				topUnstyled,
				topY,
				topBorderColor,
				topBorderBackgroundColor,
				dimTopBorderColor,
			);
		}

		if (showBottomBorder) {
			const bottomUnstyled =
				(showLeftBorder ? box.bottomLeft : '') +
				box.bottom.repeat(contentWidth) +
				(showRightBorder ? box.bottomRight : '');
			horizontalSlice(
				bottomUnstyled,
				bottomY,
				bottomBorderColor,
				bottomBorderBackgroundColor,
				dimBottomBorderColor,
			);
		}

		let verticalBorderHeight = height;

		if (showTopBorder) {
			verticalBorderHeight -= 1;
		}

		if (showBottomBorder) {
			verticalBorderHeight -= 1;
		}

		const offsetY = showTopBorder ? 1 : 0;
		const verticalStart = y + offsetY;
		const verticalEnd = verticalStart + verticalBorderHeight;

		if (visibleRect) {
			const rowStart = Math.max(verticalStart, Math.ceil(visibleTop));
			const rowEnd = Math.min(verticalEnd, Math.floor(visibleBottom));

			if (showLeftBorder && leftX >= visibleLeft && leftX < visibleRight) {
				const one = stylePiece(
					box.left,
					leftBorderColor,
					leftBorderBackgroundColor,
					dimLeftBorderColor,
				);
				for (let row = rowStart; row < rowEnd; row++) {
					output.write(leftX, row, one, {transformers: []});
					recordSurfaceWrite(element, 1);
				}
			}

			if (showRightBorder && rightX >= visibleLeft && rightX < visibleRight) {
				const one = stylePiece(
					box.right,
					rightBorderColor,
					rightBorderBackgroundColor,
					dimRightBorderColor,
				);
				for (let row = rowStart; row < rowEnd; row++) {
					output.write(rightX, row, one, {transformers: []});
					recordSurfaceWrite(element, 1);
				}
			}
		} else {
			if (showLeftBorder && verticalBorderHeight > 0) {
				const one = stylePiece(
					box.left,
					leftBorderColor,
					leftBorderBackgroundColor,
					dimLeftBorderColor,
				);
				const leftBorder = (one + '\n').repeat(verticalBorderHeight);
				output.write(leftX, verticalStart, leftBorder, {transformers: []});
				recordSurfaceWrite(element, verticalBorderHeight);
			}

			if (showRightBorder && verticalBorderHeight > 0) {
				const one = stylePiece(
					box.right,
					rightBorderColor,
					rightBorderBackgroundColor,
					dimRightBorderColor,
				);
				const rightBorder = (one + '\n').repeat(verticalBorderHeight);
				output.write(rightX, verticalStart, rightBorder, {
					transformers: [],
				});
				recordSurfaceWrite(element, verticalBorderHeight);
			}
		}
	}
};

/* eslint-enable max-params */

export default renderBorder;
