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

const createStandard = (
	stream: Writable,
	{showCursor = false} = {},
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
					str +
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
	{showCursor = false} = {},
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
					str +
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

		// Clear extra lines if the current content's line count is lower than the previous.
		if (visibleCount < previousVisible) {
			const previousHadTrailingNewline = previousOutput.endsWith('\n');
			const extraSlot = previousHadTrailingNewline ? 1 : 0;
			buffer.push(
				ansiEscapes.eraseLines(previousVisible - visibleCount + extraSlot),
				ansiEscapes.cursorUp(visibleCount),
			);
		} else {
			buffer.push(ansiEscapes.cursorUp(previousLines.length - 1));
		}

		for (let i = 0; i < visibleCount; i++) {
			const isLastLine = i === visibleCount - 1;

			// We do not write lines if the contents are the same. This prevents flickering during renders.
			if (nextLines[i] === previousLines[i]) {
				// Don't move past the last line when there's no trailing newline,
				// otherwise the cursor overshoots the rendered block.
				if (!isLastLine || hasTrailingNewline) {
					buffer.push(ansiEscapes.cursorNextLine);
				}

				continue;
			}

			buffer.push(
				ansiEscapes.cursorTo(0) +
					nextLines[i] +
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
				str +
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
	{showCursor = false, incremental = false} = {},
): LogUpdate => {
	if (incremental) {
		return createIncremental(stream, {showCursor});
	}

	return createStandard(stream, {showCursor});
};

const logUpdate = {create};
export default logUpdate;
