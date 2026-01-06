import cliBoxes from 'cli-boxes';
import chalk from 'chalk';
import colorize from './colorize.js';
import type {DOMNode} from './dom.js';
import type Output from './output.js';

const renderBorder = (
	x: number,
	y: number,
	node: DOMNode,
	output: Output,
): void => {
	if (node.style.borderStyle) {
		const width = node.yogaNode?.getComputedWidth() ?? 0;
		const height = node.yogaNode?.getComputedHeight() ?? 0;
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

		const {backgroundColor} = node.style;

		const renderBorderChar = (
			char: string,
			borderColor: string | undefined,
			dimColor: boolean | undefined,
		): string => {
			let result = char;

			if (backgroundColor) {
				result = colorize(result, backgroundColor, 'background');
			}

			result = colorize(result, borderColor, 'foreground');

			if (dimColor) {
				result = chalk.dim(result);
			}

			return result;
		};

		const topBorder = showTopBorder
			? renderBorderChar(
					(showLeftBorder ? box.topLeft : '') +
						box.top.repeat(contentWidth) +
						(showRightBorder ? box.topRight : ''),
					topBorderColor,
					dimTopBorderColor,
				)
			: undefined;

		let verticalBorderHeight = height;

		if (showTopBorder) {
			verticalBorderHeight -= 1;
		}

		if (showBottomBorder) {
			verticalBorderHeight -= 1;
		}

		const leftBorder = (
			renderBorderChar(box.left, leftBorderColor, dimLeftBorderColor) + '\n'
		).repeat(verticalBorderHeight);

		const rightBorder = (
			renderBorderChar(box.right, rightBorderColor, dimRightBorderColor) + '\n'
		).repeat(verticalBorderHeight);

		const bottomBorder = showBottomBorder
			? renderBorderChar(
					(showLeftBorder ? box.bottomLeft : '') +
						box.bottom.repeat(contentWidth) +
						(showRightBorder ? box.bottomRight : ''),
					bottomBorderColor,
					dimBottomBorderColor,
				)
			: undefined;

		const offsetY = showTopBorder ? 1 : 0;

		if (topBorder) {
			output.write(x, y, topBorder, {transformers: []});
		}

		if (showLeftBorder) {
			output.write(x, y + offsetY, leftBorder, {transformers: []});
		}

		if (showRightBorder) {
			output.write(x + width - 1, y + offsetY, rightBorder, {
				transformers: [],
			});
		}

		if (bottomBorder) {
			output.write(x, y + height - 1, bottomBorder, {transformers: []});
		}
	}
};

export default renderBorder;
