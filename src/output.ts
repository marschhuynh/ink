import stringWidth from 'string-width';
import widestLine from 'widest-line';
import {
	type StyledChar,
	ansiCodesToString,
	diffAnsiCodes,
	styledCharsFromTokens,
	tokenize,
} from '@alcalzone/ansi-tokenize';
import {type OutputTransformer} from './render-node-to-output.js';

/**
"Virtual" output class

Handles the positioning and saving of the output of each node in the tree. Also responsible for applying transformations to each character of the output.

Used to generate the final output of all nodes before writing it to actual output stream (e.g. stdout)
*/

type Options = {
	width: number;
	height: number;
	caches?: OutputCaches;
};

type Operation = WriteOperation | ClipOperation | UnclipOperation;

type WriteOperation = {
	type: 'write';
	x: number;
	y: number;
	text: string;
	transformers: OutputTransformer[];
	selectable: boolean;
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

type GetOptions = {
	capturePlainRows?: boolean;
	paint?: (
		grid: StyledChar[][],
		plainRows: string[],
		maskRows: boolean[][],
	) => void;
};

const maxDefined = (
	first: number | undefined,
	second: number | undefined,
): number | undefined => {
	if (first === undefined) {
		return second;
	}

	if (second === undefined) {
		return first;
	}

	return Math.max(first, second);
};

const minDefined = (
	first: number | undefined,
	second: number | undefined,
): number | undefined => {
	if (first === undefined) {
		return second;
	}

	if (second === undefined) {
		return first;
	}

	return Math.min(first, second);
};

const intersectClips = (clips: Clip[]): Clip | undefined => {
	if (clips.length === 0) {
		return;
	}

	let result: Clip = {
		x1: undefined,
		x2: undefined,
		y1: undefined,
		y2: undefined,
	};

	for (const clip of clips) {
		result = {
			x1: maxDefined(result.x1, clip.x1),
			x2: minDefined(result.x2, clip.x2),
			y1: maxDefined(result.y1, clip.y1),
			y2: minDefined(result.y2, clip.y2),
		};
	}

	return result;
};

// Trims only trailing unstyled spaces. Styled spaces (e.g. a Box
// background fill reaching the wrap column) are preserved while they fit
// inside the terminal width; `end <= width` keeps the final styled cell of
// a full-width row while excess styled space is still trimmed.
const trimTrailingSpaces = (
	line: StyledChar[],
	width: number,
): StyledChar[] => {
	let end = line.length;

	while (end > 0) {
		const character = line[end - 1];
		if (character?.type !== 'char' || character.value !== ' ') {
			break;
		}

		if (character.styles.length > 0 && end <= width) {
			break;
		}

		end--;
	}

	return line.slice(0, end);
};

const stylesEqual = (
	a: StyledChar['styles'],
	b: StyledChar['styles'],
): boolean => {
	if (a === b) {
		return true;
	}

	if (a.length !== b.length) {
		return false;
	}

	for (let index = 0; index < a.length; index++) {
		if (a[index] !== b[index]) {
			return false;
		}
	}

	return true;
};

// Same output as styledCharsToString but only pays diffAnsiCodes + Set
// allocations at real style boundaries. Transcript rows are mostly long
// style-homogeneous runs (padding spaces, uniformly styled text), so the
// per-cell diff is almost always a no-op — element-equal styles guarantee
// diffAnsiCodes emits nothing, so skipping it preserves bytes exactly.
const serializeRow = (chars: StyledChar[]): string => {
	if (chars.length === 0) {
		return '';
	}

	const first = chars[0]!;
	let output = ansiCodesToString(first.styles) + first.value;
	let active = first.styles;
	for (let index = 1; index < chars.length; index++) {
		const char = chars[index]!;
		const styles = char.styles;
		if (styles !== active && !stylesEqual(styles, active)) {
			output += ansiCodesToString(diffAnsiCodes(active, styles));
		}

		active = styles;
		output += char.value;
	}

	output += ansiCodesToString(diffAnsiCodes(active, []));
	return output;
};

// Cache bounds: frame-stable line sets are small, but long sessions keep
// producing distinct lines (scrolled-off transcript). FIFO-evict the oldest
// quarter when full to bound memory while preserving temporal locality.
const CACHE_CAP = 4096;
const boundedSet = <K, V>(map: Map<K, V>, key: K, value: V): void => {
	if (!map.has(key) && map.size >= CACHE_CAP) {
		let removed = 0;
		for (const oldest of map.keys()) {
			map.delete(oldest);
			if (++removed >= CACHE_CAP >> 2) {
				break;
			}
		}
	}

	map.set(key, value);
};

export class OutputCaches {
	widths = new Map<string, number>();
	styledChars = new Map<string, StyledChar[]>();
	completeLineWidths = new Map<string, number>();
	// Whole-string widestLine results, keyed by squashed text — scroll frames
	// re-measure identical rows.
	widestLineWidths = new Map<string, number>();

	getStyledChars(line: string, maxWidth?: number): StyledChar[] {
		if (maxWidth !== undefined) {
			// The tokenizer counts at most two columns per grapheme, while the
			// grid writes at least one. Include one extra glyph to detect overflow
			// without trusting the tokenizer's widths or scanning the hidden tail.
			return styledCharsFromTokens(tokenize(line, (maxWidth + 1) * 2));
		}

		let cached = this.styledChars.get(line);
		if (cached === undefined) {
			cached = styledCharsFromTokens(tokenize(line));
			this.styledChars.set(line, cached);
		}

		return cached;
	}

	getStringWidth(text: string): number {
		let cached = this.widths.get(text);
		if (cached === undefined) {
			cached = stringWidth(text);
			boundedSet(this.widths, text, cached);
		}

		return cached;
	}

	measureWidestLine(text: string): number {
		let cached = this.widestLineWidths.get(text);
		if (cached === undefined) {
			cached = widestLine(text);
			boundedSet(this.widestLineWidths, text, cached);
		}

		return cached;
	}

	getWidestLine(text: string, maxWidth: number): number {
		let widest = 0;
		for (const line of text.split('\n')) {
			let width = 0;
			for (const character of this.getStyledChars(line, maxWidth)) {
				width += Math.max(1, this.getStringWidth(character.value));
				if (width >= maxWidth) {
					return maxWidth;
				}
			}

			widest = Math.max(widest, width);
		}

		return widest;
	}
}

export default class Output {
	width: number;
	height: number;

	private readonly operations: Operation[] = [];
	private readonly caches: OutputCaches;

	constructor(options: Options) {
		const {width, height} = options;

		this.width = width;
		this.height = height;
		this.caches = options.caches ?? new OutputCaches();
	}

	write(
		x: number,
		y: number,
		text: string,
		options: {transformers: OutputTransformer[]; selectable?: boolean},
	): void {
		const {transformers, selectable = false} = options;

		if (!text) {
			return;
		}

		this.operations.push({
			type: 'write',
			x,
			y,
			text,
			transformers,
			selectable,
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

	// Widest visible line of `text`, memoized on the shared caches when the
	// renderer injects them — scroll frames re-measure the same rows.
	measureWidestLine(text: string): number {
		return this.caches.measureWidestLine(text);
	}

	get(options?: GetOptions): {
		output: string;
		height: number;
		maxVisualWidth: number;
		plainRows?: string[];
		maskRows?: boolean[][];
	} {
		const needSelection = Boolean(options?.capturePlainRows ?? options?.paint);
		// Initialize output array with a specific set of rows, so that margin/padding at the bottom is preserved
		const output: StyledChar[][] = [];
		// Selectability mask: true only for cells written with `selectable: true`
		// (i.e. Text content). Padding, margin, borders, and untouched cells stay false.
		const mask: boolean[][] = [];

		const spaceCell: StyledChar = {
			type: 'char',
			value: ' ',
			fullWidth: false,
			styles: [],
		};
		for (let y = 0; y < this.height; y++) {
			const row = new Array<StyledChar>(this.width).fill(spaceCell);
			output.push(row);
			if (needSelection) {
				mask.push(new Array<boolean>(this.width).fill(false));
			}
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
				const {text, transformers, selectable, x} = operation;
				let {y} = operation;
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
						if (
							x > clip.x2! ||
							(x < clip.x1! &&
								this.caches.getWidestLine(text, clip.x1! - x) < clip.x1! - x)
						) {
							continue;
						}
					}

					if (clipVertically) {
						const height = lines.length;

						if (y + height < clip.y1! || y > clip.y2!) {
							continue;
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
					const currentMaskLine = mask[y + offsetY];

					// Line can be missing if `text` is taller than height of pre-initialized `this.output`
					if (!currentLine || (needSelection && !currentMaskLine)) {
						continue;
					}

					let offsetX = x;

					if (typeof clip?.x1 === 'number' && typeof clip?.x2 === 'number') {
						const {x1, x2} = clip;
						const width = this.caches.completeLineWidths.get(line);
						if (width === undefined || x < x1 || x + width > x2) {
							const characters = this.caches.getStyledChars(line, x2 - x);
							const visibleCharacters: StyledChar[] = [];
							let column = x;
							let clipped = characters.length === 0;
							// Transformers can add content even when no source glyph survives.
							offsetX = Math.max(x, x1);

							for (const character of characters) {
								if (column >= x2) {
									clipped = true;
									break;
								}

								const end =
									column +
									Math.max(1, this.caches.getStringWidth(character.value));
								if (column >= x1 && end <= x2) {
									// Keep the first surviving glyph at its original column.
									if (visibleCharacters.length === 0) {
										offsetX = column;
									}

									visibleCharacters.push(character);
								} else {
									clipped = true;
								}

								column = end;
							}

							// Keep fully-inside lines untouched, including their ANSI bytes.
							if (clipped) {
								line = serializeRow(visibleCharacters);
							} else {
								// The bounded lookahead proved this is the complete line.
								// Reuse its geometry and styles, never a clipped prefix.
								boundedSet(this.caches.completeLineWidths, line, column - x);
								boundedSet(this.caches.styledChars, line, characters);
							}
						}
					}

					for (const transformer of transformers) {
						line = transformer(line, index);
					}

					const characters = this.caches.getStyledChars(line);

					// Nothing to write (e.g. line was clipped away).
					if (characters.length === 0) {
						offsetY++;
						continue;
					}

					const spaceCell: StyledChar = {
						type: 'char',
						value: ' ',
						fullWidth: false,
						styles: [],
					};

					// Wide characters (e.g. CJK) occupy two cells: a leading
					// cell with the character and a trailing placeholder with
					// value ''. When an overlapping write lands in the middle
					// of a wide character, the boundary cells need cleanup so
					// the terminal never renders a half-visible wide character.
					if (
						currentLine[offsetX]?.value === '' &&
						offsetX > 0 &&
						this.caches.getStringWidth(currentLine[offsetX - 1]?.value ?? '') >
							1
					) {
						currentLine[offsetX - 1] = spaceCell;
						if (currentMaskLine) {
							currentMaskLine[offsetX - 1] = false;
						}
					}

					for (const character of characters) {
						currentLine[offsetX] = character;
						if (currentMaskLine) {
							currentMaskLine[offsetX] = selectable;
						}

						// Determine printed width using string-width to align with measurement
						const characterWidth = Math.max(
							1,
							this.caches.getStringWidth(character.value),
						);

						// For multi-column characters, clear following cells to avoid stray spaces/artifacts
						if (characterWidth > 1) {
							for (let index = 1; index < characterWidth; index++) {
								currentLine[offsetX + index] = {
									type: 'char',
									value: '',
									fullWidth: false,
									styles: character.styles,
								};
								// Placeholder cells inherit the glyph's selectability.
								if (currentMaskLine) {
									currentMaskLine[offsetX + index] = selectable;
								}
							}
						}

						offsetX += characterWidth;
					}

					if (currentLine[offsetX]?.value === '') {
						currentLine[offsetX] = spaceCell;
						if (currentMaskLine) {
							currentMaskLine[offsetX] = false;
						}
					}

					offsetY++;
				}
			}
		}

		let plainRows: string[] | undefined;

		if (needSelection) {
			plainRows = output.map(row => {
				let plain = '';
				for (const character of row) {
					// Sparse holes from out-of-bounds writes read as undefined.
					plain += character?.value ?? '';
				}

				return plain.trimEnd();
			});
		}

		// Generic final mutation point: sees the fully built grid (after
		// wrapping, transforms, borders, backgrounds, and scroll clipping)
		// before it is converted to ANSI.
		options?.paint?.(output, plainRows!, mask ?? []);

		let maxVisualWidth = 0;
		const generatedOutput = output
			.map(line => {
				// See https://github.com/vadimdemedes/ink/pull/564#issuecomment-1637022742
				// Writes past `width` extend rows with sparse holes; compact them out.
				// Holes read as `undefined` but aren't in the StyledChar type.
				const lineWithoutEmptyItems = (
					line as Array<StyledChar | undefined>
				).includes(undefined)
					? line.filter(item => item !== undefined)
					: line;
				const trimmedLine = trimTrailingSpaces(
					lineWithoutEmptyItems,
					this.width,
				);
				maxVisualWidth = Math.max(maxVisualWidth, trimmedLine.length);

				return serializeRow(trimmedLine);
			})
			.join('\n');

		return {
			output: generatedOutput,
			height: output.length,
			maxVisualWidth,
			plainRows,
			maskRows: needSelection ? mask : undefined,
		};
	}
}
