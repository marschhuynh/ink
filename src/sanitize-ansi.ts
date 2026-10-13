import {hasAnsiControlCharacters, tokenizeAnsi} from './ansi-tokenizer.js';

const sgrParametersRegex = /^[\d:;]*$/;

// These are text controls, not ANSI sequence delimiters or layout whitespace.
/* eslint-disable no-control-regex */
const unsupportedTextControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/* eslint-enable no-control-regex */

const normalizeText = (text: string): string =>
	(text as string & {toWellFormed: () => string})
		.toWellFormed()
		.replaceAll(/\r\n?/g, '\n')
		.replaceAll(unsupportedTextControls, '');

// Strip ANSI escape sequences that would conflict with Ink's layout.
// Preserved: SGR sequences (colors, bold, etc. - end with 'm') and
// OSC 8 hyperlinks. LF and tabs are retained for layout/tab expansion.
// Stripped: cursor movement, screen clearing, and other control sequences.
const sanitizeAnsi = (text: string): string => {
	if (!hasAnsiControlCharacters(text)) {
		return normalizeText(text);
	}

	let output = '';

	for (const token of tokenizeAnsi(text)) {
		if (token.type === 'text') {
			output += normalizeText(token.value);
			continue;
		}

		if (
			token.type === 'osc' &&
			(token.value.startsWith('\u001B]8;') ||
				token.value.startsWith('\u009D8;'))
		) {
			output += token.value;
			continue;
		}

		if (
			token.type === 'csi' &&
			token.finalCharacter === 'm' &&
			token.intermediateString === '' &&
			sgrParametersRegex.test(token.parameterString)
		) {
			output += token.value;
		}
	}

	return output;
};

export default sanitizeAnsi;
