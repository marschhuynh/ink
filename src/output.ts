import sliceAnsi from 'slice-ansi';
import stringWidth from 'string-width';
import {
	type StyledChar,
	styledCharsFromTokens,
	styledCharsToString,
	tokenize,
} from '@alcalzone/ansi-tokenize';
import type {OutputTransformer} from './render-node-to-output.js';

const TAB_SPACES = '  '; // 2 spaces per tab

const expandTabs = (text: string): string =>
	text.includes('\t') ? text.replaceAll('\t', TAB_SPACES) : text;

/**
"Virtual" output class

Handles the positioning and saving of the output of each node in the tree. Also responsible for applying transformations to each character of the output.

Used to generate the final output of all nodes before writing it to actual output stream (e.g. stdout)
*/

type Options = {
	width: number;
	height: number;
};

type Operation = WriteOperation | ClipOperation | UnclipOperation;

type WriteOperation = {
	type: 'write';
	x: number;
	y: number;
	text: string;
	transformers: OutputTransformer[];
};

type ClipOperation = {
	type: 'clip';
	clip: Clip;
};

type Clip = {
	x1: number | undefined;
	x2: number | undefined;
	y1: number | undefined;
	y2: number | undefined;
};

type UnclipOperation = {
	type: 'unclip';
};

const intersectClips = (clips: Clip[]): Clip | undefined => {
	if (clips.length === 0) {
		return undefined;
	}

	let x1: number | undefined;
	let x2: number | undefined;
	let y1: number | undefined;
	let y2: number | undefined;

	for (const c of clips) {
		if (c.x1 !== undefined) {
			x1 = x1 === undefined ? c.x1 : Math.max(x1, c.x1);
		}

		if (c.x2 !== undefined) {
			x2 = x2 === undefined ? c.x2 : Math.min(x2, c.x2);
		}

		if (c.y1 !== undefined) {
			y1 = y1 === undefined ? c.y1 : Math.max(y1, c.y1);
		}

		if (c.y2 !== undefined) {
			y2 = y2 === undefined ? c.y2 : Math.min(y2, c.y2);
		}
	}

	return {x1, x2, y1, y2};
};

export default class Output {
	width: number;
	height: number;

	private readonly operations: Operation[] = [];

	constructor(options: Options) {
		const {width, height} = options;

		this.width = width;
		this.height = height;
	}

	write(
		x: number,
		y: number,
		text: string,
		options: {transformers: OutputTransformer[]},
	): void {
		const {transformers} = options;

		if (!text) {
			return;
		}

		this.operations.push({
			type: 'write',
			x,
			y,
			text: expandTabs(text),
			transformers,
		});
	}

	clip(clip: Clip) {
		this.operations.push({
			type: 'clip',
			clip,
		});
	}

	unclip() {
		this.operations.push({
			type: 'unclip',
		});
	}

	get(): {output: string; height: number} {
		// Initialize output array with a specific set of rows, so that margin/padding at the bottom is preserved
		const output: StyledChar[][] = [];

		for (let y = 0; y < this.height; y++) {
			const row: StyledChar[] = [];

			for (let x = 0; x < this.width; x++) {
				row.push({
					type: 'char',
					value: ' ',
					fullWidth: false,
					styles: [],
				});
			}

			output.push(row);
		}

		const clips: Clip[] = [];

		for (const operation of this.operations) {
			if (operation.type === 'clip') {
				clips.push(operation.clip);
			}

			if (operation.type === 'unclip') {
				clips.pop();
			}

			if (operation.type === 'write') {
				const {text, transformers} = operation;
				let {x, y} = operation;
				let lines = text.split('\n');

				const clip = intersectClips(clips);

				if (clip) {
					const clipHorizontally =
						typeof clip?.x1 === 'number' && typeof clip?.x2 === 'number';

					const clipVertically =
						typeof clip?.y1 === 'number' && typeof clip?.y2 === 'number';

					// If text is positioned outside of clipping area altogether,
					// skip to the next operation to avoid unnecessary calculations
					if (clipHorizontally) {
						const width = Math.max(0, ...lines.map(line => stringWidth(line)));

						if (x + width < clip.x1! || x > clip.x2!) {
							continue;
						}
					}

					if (clipVertically) {
						const height = lines.length;

						if (y + height < clip.y1! || y > clip.y2!) {
							continue;
						}
					}

					if (clipHorizontally) {
						lines = lines.map(line => {
							const from = x < clip.x1! ? clip.x1! - x : 0;
							const width = stringWidth(line);
							const to = x + width > clip.x2! ? clip.x2! - x : width;

							return sliceAnsi(line, from, to);
						});

						if (x < clip.x1!) {
							x = clip.x1!;
						}
					}

					if (clipVertically) {
						const from = y < clip.y1! ? clip.y1! - y : 0;
						const height = lines.length;
						const to = y + height > clip.y2! ? clip.y2! - y : height;

						lines = lines.slice(from, to);

						if (y < clip.y1!) {
							y = clip.y1!;
						}
					}
				}

				let offsetY = 0;

				for (let [index, line] of lines.entries()) {
					const currentLine = output[y + offsetY];

					// Line can be missing if `text` is taller than height of pre-initialized `this.output`
					if (!currentLine) {
						continue;
					}

					for (const transformer of transformers) {
						line = transformer(line, index);
					}

					const characters = styledCharsFromTokens(tokenize(line));
					let offsetX = x;

					for (const character of characters) {
						// Check if this is a zero-width character (like U+FE0F emoji variation selector)
						const rawWidth = stringWidth(character.value);

						if (rawWidth === 0) {
							// Zero-width characters (like variation selectors) should be appended
							// to the previous cell rather than taking up their own space
							const previousCell = currentLine[offsetX - 1];
							if (previousCell?.value) {
								// Measure width before and after appending to detect width changes
								// This handles cases like ⏭ (width 1) + ️ (VS16) = ⏭️ (width 2)
								const prevWidth = stringWidth(previousCell.value);
								previousCell.value += character.value;
								const newWidth = stringWidth(previousCell.value);

								// If combining increased the display width, add placeholder cells
								const extraWidth = newWidth - prevWidth;
								if (extraWidth > 0) {
									for (let i = 0; i < extraWidth; i++) {
										currentLine[offsetX + i] = {
											type: 'char',
											value: '',
											fullWidth: false,
											styles: previousCell.styles,
										};
									}

									offsetX += extraWidth;
								}
							}

							// Don't advance offsetX for zero-width characters (already handled above if width changed)
							continue;
						}

						currentLine[offsetX] = character;

						// Determine printed width using string-width
						const characterWidth = Math.max(1, rawWidth);

						// For multi-column characters, clear following cells to avoid stray spaces/artifacts
						if (characterWidth > 1) {
							for (let index = 1; index < characterWidth; index++) {
								currentLine[offsetX + index] = {
									type: 'char',
									value: '',
									fullWidth: false,
									styles: character.styles,
								};
							}
						}

						offsetX += characterWidth;
					}

					offsetY++;
				}
			}
		}

		const generatedOutput = output
			.map(line => {
				// See https://github.com/vadimdemedes/ink/pull/564#issuecomment-1637022742
				const lineWithoutEmptyItems = line.filter(item => item !== undefined);

				return styledCharsToString(lineWithoutEmptyItems).trimEnd();
			})
			.join('\n');

		return {
			output: generatedOutput,
			height: output.length,
		};
	}
}
