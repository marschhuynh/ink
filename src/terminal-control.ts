export type TerminalControl = {
	kind: 'csi' | 'osc' | 'string' | 'esc' | 'c0';
	raw: string;
	end: number; // Exclusive source offset
};

const consumeCsiBody = (text: string, start: number): number | undefined => {
	let index = start;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code < 0x30 || code > 0x3f) {
			break;
		}

		index++;
	}

	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code < 0x20 || code > 0x2f) {
			break;
		}

		index++;
	}

	if (index >= text.length) {
		return undefined;
	}

	const final = text.charCodeAt(index);
	if (final < 0x40 || final > 0x7e) {
		return undefined;
	}

	return index - start + 1;
};

const consumeString = (
	text: string,
	start: number,
	isOsc: boolean,
	c1Introducer: boolean,
): number | undefined => {
	let index = start + (c1Introducer ? 1 : 2);
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (isOsc && code === 0x07) {
			return index - start + 1;
		}

		if (code === 0x9c) {
			return index - start + 1;
		}

		if (
			code === 0x1b &&
			index + 1 < text.length &&
			text.charCodeAt(index + 1) === 0x5c
		) {
			return index - start + 2;
		}

		index++;
	}

	return undefined;
};

const consumeEsc = (text: string, start: number): number | undefined => {
	if (start + 1 >= text.length) {
		return undefined;
	}

	const next = text.charCodeAt(start + 1);
	if (next === 0x5b) {
		const body = consumeCsiBody(text, start + 2);
		return body === undefined ? undefined : 2 + body;
	}

	if (next === 0x5d) {
		return consumeString(text, start, true, false);
	}

	if (next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58) {
		return consumeString(text, start, false, false);
	}

	let index = start + 1;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code >= 0x20 && code <= 0x2f) {
			index++;
			continue;
		}

		if (code >= 0x30 && code <= 0x7e) {
			return index - start + 1;
		}

		return undefined;
	}

	return undefined;
};

const token = (
	kind: TerminalControl['kind'],
	text: string,
	start: number,
	length: number,
): TerminalControl => ({
	kind,
	raw: text.slice(start, start + length),
	end: start + length,
});

export function readTerminalControl(
	text: string,
	start: number,
): TerminalControl | undefined {
	if (start >= text.length) {
		return undefined;
	}

	const code = text.charCodeAt(start);

	if (code === 0x1b) {
		const length = consumeEsc(text, start);
		if (length === undefined) {
			return undefined;
		}

		const next = text.charCodeAt(start + 1);
		if (next === 0x5b) {
			return token('csi', text, start, length);
		}

		if (next === 0x5d) {
			return token('osc', text, start, length);
		}

		if (next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58) {
			return token('string', text, start, length);
		}

		return token('esc', text, start, length);
	}

	if (code === 0x9b) {
		const body = consumeCsiBody(text, start + 1);
		if (body === undefined) {
			return undefined;
		}

		return token('csi', text, start, 1 + body);
	}

	if (
		code === 0x9d ||
		code === 0x90 ||
		code === 0x9f ||
		code === 0x9e ||
		code === 0x98
	) {
		const length = consumeString(text, start, code === 0x9d, true);
		if (length === undefined) {
			return undefined;
		}

		return token(code === 0x9d ? 'osc' : 'string', text, start, length);
	}

	if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
		return token('c0', text, start, 1);
	}

	return undefined;
}
