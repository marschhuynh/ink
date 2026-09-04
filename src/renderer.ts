import renderNodeToOutput, {
	renderNodeToScreenReaderOutput,
	type PaintState,
} from './render-node-to-output.js';
import Output from './output.js';
import {paintSelection} from './paint-selection.js';
import {type TextSelectionController} from './text-selection-controller.js';
import {type DOMElement} from './dom.js';
import {prepareLayoutMetadata} from './layout-metadata.js';

type Result = {
	output: string;
	outputHeight: number;
	staticOutput: string;
};

let nextPaintEpoch = 0;

const createPaintState = (): PaintState => ({
	epoch: ++nextPaintEpoch,
	nextIndex: 0,
});

const renderer = (
	node: DOMElement,
	isScreenReaderEnabled: boolean,
	selection?: TextSelectionController,
): Result => {
	if (node.yogaNode) {
		if (isScreenReaderEnabled) {
			const output = renderNodeToScreenReaderOutput(node, {
				skipStaticElements: true,
			});

			const outputHeight = output === '' ? 0 : output.split('\n').length;

			let staticOutput = '';

			if (node.staticNode) {
				staticOutput = renderNodeToScreenReaderOutput(node.staticNode, {
					skipStaticElements: false,
				});
			}

			return {
				output,
				outputHeight,
				staticOutput: staticOutput ? `${staticOutput}\n` : '',
			};
		}

		prepareLayoutMetadata(node);

		const output = new Output({
			width: node.yogaNode.getComputedWidth(),
			height: node.yogaNode.getComputedHeight(),
		});

		renderNodeToOutput(node, output, {
			skipStaticElements: true,
			paintState: createPaintState(),
		});

		let staticOutput;

		if (node.staticNode?.yogaNode) {
			staticOutput = new Output({
				width: node.staticNode.yogaNode.getComputedWidth(),
				height: node.staticNode.yogaNode.getComputedHeight(),
			});

			renderNodeToOutput(node.staticNode, staticOutput, {
				skipStaticElements: false,
				paintState: createPaintState(),
			});
		}

		// Selection applies to the main output only; static output is written
		// once and must never contain highlight styling.
		const {output: generatedOutput, height: outputHeight} = output.get(
			selection
				? {
						capturePlainRows: true,
						paint(grid, plainRows, maskRows) {
							selection.captureRows(plainRows, maskRows);
							paintSelection(
								grid,
								selection.getPaintSpans(grid[0]?.length ?? 0, grid.length),
								maskRows,
							);
						},
					}
				: undefined,
		);

		return {
			output: generatedOutput,
			outputHeight,
			// Newline at the end is needed, because static output doesn't have one, so
			// interactive output will override last line of static output
			staticOutput: staticOutput ? `${staticOutput.get().output}\n` : '',
		};
	}

	return {
		output: '',
		outputHeight: 0,
		staticOutput: '',
	};
};

export default renderer;
