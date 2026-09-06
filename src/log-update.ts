import process from 'node:process';
import {type Writable} from 'node:stream';
import ansiEscapes from 'ansi-escapes';
import cliCursor from 'cli-cursor';
import {
	type CursorPosition,
	cursorPositionChanged,
	getOutputCursorRow,
	buildCursorSuffix,
	buildCursorOnlySequence,
	buildReturnToBottomPrefix,
	hideCursorEscape,
	showCursorEscape,
} from './cursor-helpers.js';

export type {CursorPosition} from './cursor-helpers.js';

type EraseOptions = {
	eraseLineCount?: number;
};

type OutputOptions = {
	showCursor?: boolean;
	transformOutput?: (text: string) => string;
};

type CreateOptions = OutputOptions & {
	incremental?: boolean;
};

export type LogUpdate = {
	clear: (options?: EraseOptions) => void;
	done: () => void;
	repaint: (str: string, options?: EraseOptions) => boolean;
	reset: () => void;
	sync: (str: string) => void;
	setCursorPosition: (position: CursorPosition | undefined) => void;
	isCursorDirty: () => boolean;
	willRender: (str: string) => boolean;
	(str: string): boolean;
};

// Count visible lines in a string, ignoring the trailing empty element
// that `split('\n')` produces when the string ends with '\n'.
const visibleLineCount = (lines: string[], str: string): number =>
	str.endsWith('\n') ? lines.length - 1 : lines.length;

const getEraseLineCount = (
	cachedLineCount: number,
	options?: EraseOptions,
): number => {
	if (cachedLineCount === 0) {
		return 0;
	}

	return options?.eraseLineCount ?? cachedLineCount;
};

// Maximum shift distance (rows) considered by scroll-region detection. Real
// wheel/keyboard scrolls move a handful of rows per commit; larger jumps
// (PageUp/PageDown) rarely share half the frame and fall through to the
// ordinary diff anyway.
const maxScrollShift = 32;

// Minimum fraction of the frame that must be explained by a pure vertical
// shift for the scroll-region fast path to engage. Updates that merely resemble
// a shift (streaming appends, selection highlights, spinner ticks) stay below
// the threshold and use the ordinary diff.
const minShiftedCoreRatio = 0.5;

type ScrollShift = {
	/** Positive: content moved up k rows (delete-lines). Negative: down (insert-lines). */
	rows: number;
	/** First frame row of the shifted band (sticky chrome above is left untouched). */
	start: number;
	/** First frame row after the shifted band (sticky chrome below is left untouched). */
	end: number;
};

const setScrollRegion = (start: number, end: number): string =>
	`\u001B[${start + 1};${end}r`;
const resetScrollRegion = '\u001B[r';
const cursorToRow = (row: number): string => `\u001B[${row + 1};1H`;

const blankLines = (count: number): string[] =>
	Array.from({length: count}, () => '');

const prefixUnchanged = (
	previousLines: string[],
	nextLines: string[],
	start: number,
): boolean => {
	for (let index = 0; index < start; index++) {
		if (nextLines[index] !== previousLines[index]) {
			return false;
		}
	}

	return true;
};

const suffixUnchanged = (
	previousLines: string[],
	nextLines: string[],
	end: number,
): boolean => {
	for (let index = end; index < nextLines.length; index++) {
		if (nextLines[index] !== previousLines[index]) return false;
	}

	return true;
};

// Detect whether `nextLines` is `previousLines` shifted vertically by k rows
// with at most a small band of changed edge lines. Only exact whole-line
// equality counts (same semantics as the existing positional diff).
const detectScrollShift = (
	previousLines: string[],
	nextLines: string[],
): ScrollShift | undefined => {
	const height = nextLines.length;
	if (height < 4 || height !== previousLines.length) {
		return undefined;
	}

	const required = Math.ceil(height * minShiftedCoreRatio);

	for (let rows = 1; rows <= Math.min(maxScrollShift, height - 1); rows++) {
		// Content moved up: nextLines[i] === previousLines[i + rows] over the
		// overlap [0, height - rows); the bottom `rows` lines are new.
		let up = 0;
		let upFirst = -1;
		let upLast = -1;
		for (let i = 0; i < height - rows; i++) {
			if (nextLines[i] !== previousLines[i + rows]) {
				continue;
			}

			up++;
			if (nextLines[i] === previousLines[i]) {
				continue;
			}

			upFirst = upFirst < 0 ? i : upFirst;
			upLast = i;
		}

		const upEnd = upLast + rows + 1;
		if (
			up >= required &&
			upFirst >= 0 &&
			upLast - upFirst + 1 >= required &&
			upEnd <= height &&
			upEnd - upFirst > rows &&
			prefixUnchanged(previousLines, nextLines, upFirst) &&
			suffixUnchanged(previousLines, nextLines, upEnd)
		) {
			return {rows, start: upFirst, end: upEnd};
		}

		// Content moved down: nextLines[i] === previousLines[i - rows]; the top
		// `rows` lines of the shifted band are new.
		let down = 0;
		let downFirst = -1;
		let downLast = -1;
		for (let i = rows; i < height; i++) {
			if (nextLines[i] !== previousLines[i - rows]) {
				continue;
			}

			down++;
			if (nextLines[i] === previousLines[i]) {
				continue;
			}

			downFirst = downFirst < 0 ? i : downFirst;
			downLast = i;
		}

		const downStart = downFirst - rows;
		const downEnd = downLast + 1;
		if (
			down >= required &&
			downFirst >= 0 &&
			downLast - downFirst + 1 >= required &&
			downStart >= 0 &&
			downEnd <= height &&
			downEnd - downStart > rows &&
			prefixUnchanged(previousLines, nextLines, downStart) &&
			suffixUnchanged(previousLines, nextLines, downEnd)
		) {
			return {rows: -rows, start: downStart, end: downEnd};
		}
	}

	return undefined;
};

const createStandard = (
	stream: Writable,
	{showCursor = false, transformOutput}: OutputOptions = {},
): LogUpdate => {
	let previousLineCount = 0;
	let previousOutput = '';
	let hasHiddenCursor = false;
	let cursorPosition: CursorPosition | undefined;
	let cursorDirty = false;
	let previousCursorPosition: CursorPosition | undefined;
	let cursorWasShown = false;

	const getActiveCursor = () => cursorPosition;
	const hasChanges = (
		str: string,
		activeCursor: CursorPosition | undefined,
	): boolean => {
		const cursorChanged = cursorPositionChanged(
			activeCursor,
			previousCursorPosition,
		);
		return str !== previousOutput || cursorChanged;
	};

	const writeFrame = (str: string, force: boolean, options?: EraseOptions) => {
		if (!showCursor && !hasHiddenCursor) {
			cliCursor.hide(stream);
			hasHiddenCursor = true;
		}

		// Cursor intent:
		// cursorPosition is persistent committed intent. cursorDirty only determines
		// whether unchanged output needs a cursor-only render.
		const activeCursor = getActiveCursor();
		cursorDirty = false;
		const cursorChanged = cursorPositionChanged(
			activeCursor,
			previousCursorPosition,
		);

		if (!force && !hasChanges(str, activeCursor)) {
			return false;
		}

		const lines = str.split('\n');
		const outputCursorRow = getOutputCursorRow(lines);
		const cursorSuffix = buildCursorSuffix(outputCursorRow, activeCursor);

		if (!force && str === previousOutput && cursorChanged) {
			stream.write(
				buildCursorOnlySequence({
					cursorWasShown,
					previousLineCount,
					previousCursorPosition,
					outputCursorRow,
					cursorPosition: activeCursor,
				}),
			);
		} else {
			previousOutput = str;
			const returnPrefix = buildReturnToBottomPrefix(
				cursorWasShown,
				previousLineCount,
				previousCursorPosition,
			);
			stream.write(
				returnPrefix +
					ansiEscapes.eraseLines(
						getEraseLineCount(previousLineCount, options),
					) +
					(transformOutput ? transformOutput(str) : str) +
					cursorSuffix,
			);
			previousLineCount = lines.length;
		}

		previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
		cursorWasShown = activeCursor !== undefined;
		return true;
	};

	const render = (str: string) => writeFrame(str, false);
	render.repaint = (str: string, options?: EraseOptions) =>
		writeFrame(str, true, options);

	render.clear = (options?: EraseOptions) => {
		const prefix = buildReturnToBottomPrefix(
			cursorWasShown,
			previousLineCount,
			previousCursorPosition,
		);
		stream.write(
			prefix +
				ansiEscapes.eraseLines(getEraseLineCount(previousLineCount, options)),
		);
		previousOutput = '';
		previousLineCount = 0;
		previousCursorPosition = undefined;
		cursorWasShown = false;
		cursorDirty = false;
	};

	render.done = () => {
		const returnPrefix = buildReturnToBottomPrefix(
			cursorWasShown,
			previousLineCount,
			previousCursorPosition,
		);
		if (returnPrefix || showCursor) {
			stream.write(returnPrefix + (showCursor ? showCursorEscape : ''));
		}

		previousOutput = '';
		previousLineCount = 0;
		previousCursorPosition = undefined;
		cursorWasShown = false;
		cursorPosition = undefined;
		cursorDirty = false;

		if (!showCursor) {
			cliCursor.show(stream);
			hasHiddenCursor = false;
		}
	};

	render.reset = () => {
		// Cache-only: the caller must have externally reset or replaced terminal contents.
		previousOutput = '';
		previousLineCount = 0;
		previousCursorPosition = undefined;
		cursorWasShown = false;
		cursorDirty = false;
	};

	render.sync = (str: string) => {
		const activeCursor = cursorPosition;
		cursorDirty = false;

		const lines = str.split('\n');
		previousOutput = str;
		previousLineCount = lines.length;

		if (!activeCursor && cursorWasShown) {
			stream.write(hideCursorEscape);
		}

		if (activeCursor) {
			stream.write(buildCursorSuffix(getOutputCursorRow(lines), activeCursor));
		}

		previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
		cursorWasShown = activeCursor !== undefined;
	};

	render.setCursorPosition = (position: CursorPosition | undefined) => {
		cursorPosition = position;
		cursorDirty = true;
	};

	render.isCursorDirty = () => cursorDirty;
	render.willRender = (str: string) => hasChanges(str, getActiveCursor());

	return render;
};

const createIncremental = (
	stream: Writable,
	{showCursor = false, transformOutput}: OutputOptions = {},
): LogUpdate => {
	let previousLines: string[] = [];
	let previousOutput = '';
	let hasHiddenCursor = false;
	let cursorPosition: CursorPosition | undefined;
	let cursorDirty = false;
	let previousCursorPosition: CursorPosition | undefined;
	let cursorWasShown = false;

	const getActiveCursor = () => cursorPosition;
	const hasChanges = (
		str: string,
		activeCursor: CursorPosition | undefined,
	): boolean => {
		const cursorChanged = cursorPositionChanged(
			activeCursor,
			previousCursorPosition,
		);
		return str !== previousOutput || cursorChanged;
	};

	const render = (str: string) => {
		if (!showCursor && !hasHiddenCursor) {
			cliCursor.hide(stream);
			hasHiddenCursor = true;
		}

		// Cursor intent:
		// cursorPosition is persistent committed intent. cursorDirty only determines
		// whether unchanged output needs a cursor-only render.
		const activeCursor = getActiveCursor();
		cursorDirty = false;
		const cursorChanged = cursorPositionChanged(
			activeCursor,
			previousCursorPosition,
		);

		if (!hasChanges(str, activeCursor)) {
			return false;
		}

		const nextLines = str.split('\n');
		const outputCursorRow = getOutputCursorRow(nextLines);
		const visibleCount = visibleLineCount(nextLines, str);
		const previousVisible = visibleLineCount(previousLines, previousOutput);

		if (str === previousOutput && cursorChanged) {
			stream.write(
				buildCursorOnlySequence({
					cursorWasShown,
					previousLineCount: previousLines.length,
					previousCursorPosition,
					outputCursorRow,
					cursorPosition: activeCursor,
				}),
			);
			previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
			cursorWasShown = activeCursor !== undefined;
			return true;
		}

		const returnPrefix = buildReturnToBottomPrefix(
			cursorWasShown,
			previousLines.length,
			previousCursorPosition,
		);

		if (str === '\n' || previousOutput.length === 0) {
			const cursorSuffix = buildCursorSuffix(outputCursorRow, activeCursor);
			stream.write(
				returnPrefix +
					ansiEscapes.eraseLines(previousLines.length) +
					(transformOutput ? transformOutput(str) : str) +
					cursorSuffix,
			);
			cursorWasShown = activeCursor !== undefined;
			previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
			previousOutput = str;
			previousLines = nextLines;
			return true;
		}

		const hasTrailingNewline = str.endsWith('\n');

		// We aggregate all chunks for incremental rendering into a buffer, and then write them to stdout at the end.
		const buffer: string[] = [];

		buffer.push(returnPrefix);

		const prevVisible = previousLines.slice(0, previousVisible);
		const nextVisible = nextLines.slice(0, visibleCount);
		const shift =
			process.env['NUVIN_INK_NO_SCROLL_OPT'] === '1' ||
			activeCursor !== undefined ||
			hasTrailingNewline ||
			previousOutput.endsWith('\n') ||
			visibleCount !== previousVisible
				? undefined
				: detectScrollShift(prevVisible, nextVisible);

		let diffPrevious = previousLines;
		let loopStart = 0;

		if (shift) {
			const k = Math.abs(shift.rows);
			const {start, end} = shift;
			const prefix = prevVisible.slice(0, start);
			const band = prevVisible.slice(start, end);
			const suffix = prevVisible.slice(end);
			const shiftedBand =
				shift.rows > 0
					? [...band.slice(k), ...blankLines(k)]
					: [...blankLines(k), ...band.slice(0, band.length - k)];
			const shiftedPrevious = [...prefix, ...shiftedBand, ...suffix];

			buffer.push(
				setScrollRegion(start, end),
				cursorToRow(start),
				shift.rows > 0 ? `\u001B[${k}M` : `\u001B[${k}L`,
				resetScrollRegion,
				cursorToRow(start),
			);
			diffPrevious = shiftedPrevious;
			loopStart = start;
		} else if (visibleCount < previousVisible) {
			// Clear extra lines if the current content's line count is lower than the previous.
			const previousHadTrailingNewline = previousOutput.endsWith('\n');
			const extraSlot = previousHadTrailingNewline ? 1 : 0;
			buffer.push(
				ansiEscapes.eraseLines(previousVisible - visibleCount + extraSlot),
				ansiEscapes.cursorUp(visibleCount),
			);
		} else {
			buffer.push(ansiEscapes.cursorUp(previousLines.length - 1));
		}

		for (let i = loopStart; i < visibleCount; i++) {
			const isLastLine = i === visibleCount - 1;

			// We do not write lines if the contents are the same. This prevents flickering during renders.
			if (nextLines[i] === diffPrevious[i]) {
				// Don't move past the last line when there's no trailing newline,
				// otherwise the cursor overshoots the rendered block.
				if (!isLastLine || hasTrailingNewline) {
					buffer.push(ansiEscapes.cursorNextLine);
				}

				continue;
			}

			buffer.push(
				ansiEscapes.cursorTo(0) +
					(transformOutput ? transformOutput(nextLines[i]!) : nextLines[i]) +
					ansiEscapes.eraseEndLine +
					// Don't append newline after the last line when the input
					// has no trailing newline (fullscreen mode).
					(isLastLine && !hasTrailingNewline ? '' : '\n'),
			);
		}

		const cursorSuffix = buildCursorSuffix(outputCursorRow, activeCursor);
		buffer.push(cursorSuffix);

		stream.write(buffer.join(''));

		cursorWasShown = activeCursor !== undefined;
		previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
		previousOutput = str;
		previousLines = nextLines;
		return true;
	};

	render.repaint = (str: string, options?: EraseOptions) => {
		if (!showCursor && !hasHiddenCursor) {
			cliCursor.hide(stream);
			hasHiddenCursor = true;
		}

		const activeCursor = getActiveCursor();
		cursorDirty = false;
		const nextLines = str.split('\n');
		const outputCursorRow = getOutputCursorRow(nextLines);
		const returnPrefix = buildReturnToBottomPrefix(
			cursorWasShown,
			previousLines.length,
			previousCursorPosition,
		);
		const cursorSuffix = buildCursorSuffix(outputCursorRow, activeCursor);

		stream.write(
			returnPrefix +
				ansiEscapes.eraseLines(
					getEraseLineCount(previousLines.length, options),
				) +
				(transformOutput ? transformOutput(str) : str) +
				cursorSuffix,
		);

		previousOutput = str;
		previousLines = nextLines;
		previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
		cursorWasShown = activeCursor !== undefined;
		return true;
	};

	render.clear = (options?: EraseOptions) => {
		const prefix = buildReturnToBottomPrefix(
			cursorWasShown,
			previousLines.length,
			previousCursorPosition,
		);
		stream.write(
			prefix +
				ansiEscapes.eraseLines(
					getEraseLineCount(previousLines.length, options),
				),
		);
		previousOutput = '';
		previousLines = [];
		previousCursorPosition = undefined;
		cursorWasShown = false;
		cursorDirty = false;
	};

	render.done = () => {
		const returnPrefix = buildReturnToBottomPrefix(
			cursorWasShown,
			previousLines.length,
			previousCursorPosition,
		);
		if (returnPrefix || showCursor) {
			stream.write(returnPrefix + (showCursor ? showCursorEscape : ''));
		}

		previousOutput = '';
		previousLines = [];
		previousCursorPosition = undefined;
		cursorWasShown = false;
		cursorPosition = undefined;
		cursorDirty = false;

		if (!showCursor) {
			cliCursor.show(stream);
			hasHiddenCursor = false;
		}
	};

	render.reset = () => {
		// Cache-only: the caller must have externally reset or replaced terminal contents.
		previousOutput = '';
		previousLines = [];
		previousCursorPosition = undefined;
		cursorWasShown = false;
		cursorDirty = false;
	};

	render.sync = (str: string) => {
		const activeCursor = cursorPosition;
		cursorDirty = false;

		const lines = str.split('\n');
		previousOutput = str;
		previousLines = lines;

		if (!activeCursor && cursorWasShown) {
			stream.write(hideCursorEscape);
		}

		if (activeCursor) {
			stream.write(buildCursorSuffix(getOutputCursorRow(lines), activeCursor));
		}

		previousCursorPosition = activeCursor ? {...activeCursor} : undefined;
		cursorWasShown = activeCursor !== undefined;
	};

	render.setCursorPosition = (position: CursorPosition | undefined) => {
		cursorPosition = position;
		cursorDirty = true;
	};

	render.isCursorDirty = () => cursorDirty;
	render.willRender = (str: string) => hasChanges(str, getActiveCursor());

	return render;
};

const create = (
	stream: Writable,
	{
		showCursor = false,
		incremental = false,
		transformOutput,
	}: CreateOptions = {},
): LogUpdate => {
	if (incremental) {
		return createIncremental(stream, {showCursor, transformOutput});
	}

	return createStandard(stream, {showCursor, transformOutput});
};

const logUpdate = {create};
export default logUpdate;
