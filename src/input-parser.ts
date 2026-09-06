const escape = '\u001B';
const pasteStart = '\u001B[200~';
const pasteEnd = '\u001B[201~';

export type InputEvent = string | {readonly paste: string};

type ParsedInput = {
	readonly events: InputEvent[];
	readonly pending: string;
};

type ParsedSequence =
	| {
			readonly sequence: string;
			readonly nextIndex: number;
	  }
	| 'pending'
	| undefined;

const isCsiParameterByte = (byte: number): boolean => {
	return byte >= 0x30 && byte <= 0x3f;
};

const isCsiIntermediateByte = (byte: number): boolean => {
	return byte >= 0x20 && byte <= 0x2f;
};

const isCsiFinalByte = (byte: number): boolean => {
	return byte >= 0x40 && byte <= 0x7e;
};

const parseCsiSequence = (
	input: string,
	startIndex: number,
	prefixLength: number,
): ParsedSequence => {
	const csiPayloadStart = startIndex + prefixLength + 1;
	let index = csiPayloadStart;
	for (; index < input.length; index++) {
		const byte = input.codePointAt(index);
		if (byte === undefined) {
			return 'pending';
		}

		if (isCsiParameterByte(byte) || isCsiIntermediateByte(byte)) {
			continue;
		}

		// Preserve legacy terminal function-key sequences like ESC[[A and ESC[[5~.
		if (byte === 0x5b && index === csiPayloadStart) {
			continue;
		}

		if (isCsiFinalByte(byte)) {
			return {
				sequence: input.slice(startIndex, index + 1),
				nextIndex: index + 1,
			};
		}

		return undefined;
	}

	return 'pending';
};

const parseSs3Sequence = (
	input: string,
	startIndex: number,
	prefixLength: number,
): ParsedSequence => {
	const nextIndex = startIndex + prefixLength + 2;
	if (nextIndex > input.length) {
		return 'pending';
	}

	const finalByte = input.codePointAt(nextIndex - 1);
	if (finalByte === undefined || !isCsiFinalByte(finalByte)) {
		return undefined;
	}

	return {
		sequence: input.slice(startIndex, nextIndex),
		nextIndex,
	};
};

const parseControlSequence = (
	input: string,
	startIndex: number,
	prefixLength: number,
): ParsedSequence => {
	const sequenceType = input[startIndex + prefixLength];
	if (sequenceType === undefined) {
		return 'pending';
	}

	if (sequenceType === '[') {
		return parseCsiSequence(input, startIndex, prefixLength);
	}

	if (sequenceType === 'O') {
		return parseSs3Sequence(input, startIndex, prefixLength);
	}

	return undefined;
};

const parseEscapedCodePoint = (
	input: string,
	escapeIndex: number,
): {
	readonly sequence: string;
	readonly nextIndex: number;
} => {
	const nextCodePoint = input.codePointAt(escapeIndex + 1);
	const nextCodePointLength =
		nextCodePoint !== undefined && nextCodePoint > 0xff_ff ? 2 : 1;
	const nextIndex = escapeIndex + 1 + nextCodePointLength;

	return {
		sequence: input.slice(escapeIndex, nextIndex),
		nextIndex,
	};
};

type ParsedEscapeSequence =
	| {
			readonly sequence: string;
			readonly nextIndex: number;
	  }
	| 'pending';

const parseEscapeSequence = (
	input: string,
	escapeIndex: number,
): ParsedEscapeSequence => {
	if (escapeIndex === input.length - 1) {
		return 'pending';
	}

	const next = input[escapeIndex + 1]!;
	if (next === escape) {
		if (escapeIndex + 2 >= input.length) {
			return 'pending';
		}

		const doubleEscapeSequence = parseControlSequence(input, escapeIndex, 2);
		if (doubleEscapeSequence === 'pending') {
			return 'pending';
		}

		if (doubleEscapeSequence) {
			return doubleEscapeSequence;
		}

		return {
			sequence: input.slice(escapeIndex, escapeIndex + 2),
			nextIndex: escapeIndex + 2,
		};
	}

	const controlSequence = parseControlSequence(input, escapeIndex, 1);
	if (controlSequence === 'pending') {
		return 'pending';
	}

	if (controlSequence) {
		return controlSequence;
	}

	return parseEscapedCodePoint(input, escapeIndex);
};

/**
Split a chunk of non-escape text so that backspace bytes (`0x7F` and `0x08`) become individual events. When a user holds the backspace key, the terminal sends repeated bytes in a single stdin chunk. Without splitting, `parseKeypress` receives the multi-byte string and fails to recognize it as a key event, corrupting the input state.

Other control characters like `\r` and `\t` are NOT split because they can legitimately appear inside pasted text.
*/
const splitBackspaceBytes = (text: string, events: InputEvent[]): void => {
	let textSegmentStart = 0;

	for (let index = 0; index < text.length; index++) {
		const character = text[index]!;
		if (character === '\u007F' || character === '\u0008') {
			if (index > textSegmentStart) {
				events.push(text.slice(textSegmentStart, index));
			}

			events.push(character);
			textSegmentStart = index + 1;
		}
	}

	if (textSegmentStart < text.length) {
		events.push(text.slice(textSegmentStart));
	}
};

const parseKeypresses = (input: string): ParsedInput => {
	const events: InputEvent[] = [];
	let index = 0;
	const pendingFrom = (pendingStartIndex: number): ParsedInput => ({
		events,
		pending: input.slice(pendingStartIndex),
	});

	while (index < input.length) {
		const escapeIndex = input.indexOf(escape, index);
		if (escapeIndex === -1) {
			splitBackspaceBytes(input.slice(index), events);
			return {
				events,
				pending: '',
			};
		}

		if (escapeIndex > index) {
			splitBackspaceBytes(input.slice(index, escapeIndex), events);
		}

		const parsedEscapeSequence = parseEscapeSequence(input, escapeIndex);
		if (parsedEscapeSequence === 'pending') {
			return pendingFrom(escapeIndex);
		}

		if (parsedEscapeSequence.sequence === pasteStart) {
			const afterStart = parsedEscapeSequence.nextIndex;
			const endIndex = input.indexOf(pasteEnd, afterStart);
			if (endIndex === -1) {
				return pendingFrom(escapeIndex);
			}

			events.push({paste: input.slice(afterStart, endIndex)});
			index = endIndex + pasteEnd.length;
			continue;
		}

		events.push(parsedEscapeSequence.sequence);
		index = parsedEscapeSequence.nextIndex;
	}

	return {
		events,
		pending: '',
	};
};

export type TerminalResponse =
	| {type: 'cursor-position'; row: number; column: number}
	| {type: 'kitty-keyboard'; flags: number};

type InputParserOptions = {
	onTerminalResponse?: (response: TerminalResponse) => void;
	isTerminalResponsePending?: () => boolean;
};

export type InputParser = {
	push: (chunk: string) => InputEvent[];
	hasPendingEscape: () => boolean;
	flushPendingEscape: () => string | undefined;
	reset: () => void;
};

const maxTerminalResponseLength = 64;
const privateResponsePrefix = /^\u001B\[\?\d[\d;]*$/;

export const createInputParser = ({
	onTerminalResponse,
	isTerminalResponsePending,
}: InputParserOptions = {}): InputParser => {
	let pending = '';
	let discardingPrivateResponse = false;
	const holdTerminalPrefix = (): boolean =>
		Boolean(onTerminalResponse) &&
		(privateResponsePrefix.test(pending) ||
			(Boolean(isTerminalResponsePending?.()) &&
				(pending === escape ||
					pending === `${escape}[` ||
					pending === `${escape}[?`)));

	return {
		push(chunk) {
			let input = chunk;
			if (discardingPrivateResponse) {
				let end = 0;
				while (
					end < input.length &&
					(isCsiParameterByte(input.charCodeAt(end)) ||
						isCsiIntermediateByte(input.charCodeAt(end)))
				)
					end++;
				if (end === input.length) return [];
				// Drain only the malformed response, not a new escape or Ctrl+C.
				const terminator = input[end];
				input = input.slice(
					end + (terminator === 'R' || terminator === 'u' ? 1 : 0),
				);
				discardingPrivateResponse = false;
			}
			if (
				onTerminalResponse &&
				privateResponsePrefix.test(pending) &&
				isTerminalResponsePending &&
				!isTerminalResponsePending() &&
				input &&
				!/[\d;Ru]/.test(input[0]!)
			) {
				// Once startup has expired, an unmistakable new key must not be
				// attached to a truncated terminal reply. Valid late tails still drain.
				pending = '';
			}
			const parsedInput = parseKeypresses(pending + input);
			pending = parsedInput.pending;
			if (!onTerminalResponse) return parsedInput.events;
			if (
				pending.length > maxTerminalResponseLength &&
				privateResponsePrefix.test(pending)
			) {
				pending = '';
				discardingPrivateResponse = true;
			}
			return parsedInput.events.filter(event => {
				// Paste is an opaque application event, even when it contains replies.
				if (typeof event !== 'string') return true;
				const cursor = /^\u001B\[\?(\d+);(\d+)R$/.exec(event);
				if (cursor) {
					if (event.length > maxTerminalResponseLength) return false;
					const row = Number(cursor[1]);
					const column = Number(cursor[2]);
					if (
						Number.isSafeInteger(row) &&
						row > 0 &&
						Number.isSafeInteger(column) &&
						column > 0
					) {
						onTerminalResponse({type: 'cursor-position', row, column});
					}
					return false;
				}
				const kitty = /^\u001B\[\?(\d+)u$/.exec(event);
				if (kitty) {
					if (event.length > maxTerminalResponseLength) return false;
					const flags = Number(kitty[1]);
					if (Number.isSafeInteger(flags))
						onTerminalResponse({type: 'kitty-keyboard', flags});
					return false;
				}
				return true;
			});
		},
		hasPendingEscape() {
			// Don't trigger the escape flush timer while assembling a paste start
			// marker (`\u001B[200` and then `~`) or while waiting for paste end.
			return (
				pending.startsWith(escape) &&
				!holdTerminalPrefix() &&
				!pending.startsWith(pasteStart) &&
				pending !== '\u001B[200'
			);
		},
		flushPendingEscape() {
			if (!pending.startsWith(escape) || holdTerminalPrefix()) {
				return undefined;
			}

			const pendingEscape = pending;
			pending = '';
			return pendingEscape;
		},
		reset() {
			pending = '';
			discardingPrivateResponse = false;
		},
	};
};
