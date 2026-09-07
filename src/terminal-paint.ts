import {
	hideCursorEscape,
	showCursorEscape,
	type CursorPosition,
} from './cursor-helpers.js';
import {encodeSeekRow, type PreparedSeekRow} from './allocated-seek.js';

export type PaintContext = {
	strategy: 'raw' | 'osc66' | 'seek-viewport';
	columns: number;
	rows: number;
};

export function selectPaintStrategy(input: {
	eligible: boolean;
	capability: 'raw' | 'osc66' | 'fallback';
	incremental: boolean;
	outputHeight: number;
	rows: number;
}): PaintContext['strategy'] {
	if (!input.eligible || input.capability === 'raw') return 'raw';
	if (input.capability === 'osc66') return 'osc66';
	return input.incremental && input.outputHeight === input.rows
		? 'seek-viewport'
		: 'raw';
}

export type PhysicalFrame = {
	context: PaintContext;
	ownsViewport: boolean;
	valid: boolean;
	logicalRows: readonly string[];
	allocatedWidths: readonly number[];
	cursor: {x: number; y: number} | undefined;
};

export const decawmOff = '\u001B[?7l';
export const decawmOn = '\u001B[?7h';
export const eraseDisplayHome = '\u001B[2J\u001B[H';
export const hyperlinkClose = '\u001B]8;;\u001B\\';
export const sgrReset = '\u001B[0m';
export const seekViewportReset = `${hyperlinkClose}${sgrReset}${eraseDisplayHome}`;

export const isSeekViewport = (
	context: PaintContext | undefined,
): context is PaintContext => context?.strategy === 'seek-viewport';

export const isSeekPhysicalFrame = (
	frame: PhysicalFrame | undefined,
): frame is PhysicalFrame => isSeekViewport(frame?.context);

export const isOwnedSeekViewport = (
	frame: PhysicalFrame | undefined,
): frame is PhysicalFrame =>
	Boolean(frame?.valid && frame.ownsViewport && isSeekViewport(frame.context));
export const clampSeekCursor = (
	cursor: CursorPosition | undefined,
	columns: number,
	rows: number,
): CursorPosition | undefined => {
	if (cursor === undefined || columns < 1 || rows < 1) {
		return undefined;
	}

	return {
		x: Math.min(Math.max(cursor.x, 0), columns - 1),
		y: Math.min(Math.max(cursor.y, 0), rows - 1),
	};
};

const cup = (x: number, y: number): string => `\u001B[${y + 1};${x + 1}H`;

export const buildSeekCursorSequence = (
	cursor: CursorPosition | undefined,
	columns: number,
	rows: number,
	cursorWasShown: boolean,
): string => {
	const clamped = clampSeekCursor(cursor, columns, rows);
	const hide = cursorWasShown || clamped === undefined ? hideCursorEscape : '';
	if (clamped === undefined) {
		return hide + cup(0, Math.max(0, rows - 1));
	}

	return hide + cup(clamped.x, clamped.y) + showCursorEscape;
};

export const encodeSeekRows = (
	prepared: readonly PreparedSeekRow[],
	indexes: readonly number[],
	columns: number,
): string => {
	let output = '';
	for (const index of indexes) {
		output += encodeSeekRow(prepared[index]!, index, columns);
	}

	return output;
};

export const wrapSeekPaint = (payload: string): string =>
	payload.length === 0 ? '' : `${decawmOff}${payload}${decawmOn}`;
