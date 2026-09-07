import test from 'ava';
import {readTerminalControl} from '../src/terminal-control.js';

test('OSC payload is one opaque token', t => {
	const raw = '\u001B]8;;https://example.test/🏳️‍♀️\u001B\\';
	const token = readTerminalControl(raw + 'X', 0);
	t.deepEqual(token, {kind: 'osc', raw, end: raw.length});
});

test('CSI sequences consume through the final byte', t => {
	for (const raw of [
		'\u001B[31m',
		'\u001B[38:2:255:128:0;1m',
		'\u001B[?25h',
		'\u001B[1 q',
		'\u009B31m',
	]) {
		t.deepEqual(readTerminalControl(`${raw}X`, 0), {
			kind: 'csi',
			raw,
			end: raw.length,
		});
	}
});

test('OSC terminates on BEL, ST, and C1 ST', t => {
	for (const end of ['\u0007', '\u001B\\', '\u009C']) {
		const raw = `\u001B]8;id=⚡;https://example.test/⚡︎${end}`;
		t.deepEqual(readTerminalControl(`${raw}X`, 0), {
			kind: 'osc',
			raw,
			end: raw.length,
		});
	}
});

test('C1 OSC introducer is one opaque token', t => {
	for (const end of ['\u0007', '\u001B\\', '\u009C']) {
		const raw = `\u009D8;;https://example.test${end}`;
		t.deepEqual(readTerminalControl(`${raw}X`, 0), {
			kind: 'osc',
			raw,
			end: raw.length,
		});
	}
});

test('DCS APC PM SOS payloads are one opaque token', t => {
	for (const start of [
		'\u001BP',
		'\u0090',
		'\u001B_',
		'\u009F',
		'\u001B^',
		'\u009E',
		'\u001BX',
		'\u0098',
	]) {
		const raw = `${start}52;c;⚡︎\u001B[31m\u001B\\`;
		t.deepEqual(readTerminalControl(`${raw}X`, 0), {
			kind: 'string',
			raw,
			end: raw.length,
		});
	}
});

test('BEL inside DCS APC PM SOS is payload not a terminator', t => {
	for (const start of [
		'\u001BP',
		'\u0090',
		'\u001B_',
		'\u009F',
		'\u001B^',
		'\u009E',
		'\u001BX',
		'\u0098',
	]) {
		const raw = `${start}52;c;\u26A1\u0007still\u001B\\`;
		t.deepEqual(readTerminalControl(`${raw}X`, 0), {
			kind: 'string',
			raw,
			end: raw.length,
		});
	}
});

test('truncated controls are undefined', t => {
	for (const input of [
		'\u001B[',
		'\u009B',
		'\u001B[31',
		'\u001B[31\u0001',
		'\u001B',
		'\u001B\u0001',
		'\u001B]payload',
		'\u001B]payload\u001B',
		'\u001BPpayload',
		'\u009Dpayload',
	]) {
		t.is(readTerminalControl(input, 0), undefined);
	}
});

test('non-string ESC sequences consume through the final byte', t => {
	t.deepEqual(readTerminalControl('\u001B(B界', 0), {
		kind: 'esc',
		raw: '\u001B(B',
		end: 3,
	});
	t.deepEqual(readTerminalControl('\u001B7X', 0), {
		kind: 'esc',
		raw: '\u001B7',
		end: 2,
	});
	t.deepEqual(readTerminalControl('\u001B8X', 0), {
		kind: 'esc',
		raw: '\u001B8',
		end: 2,
	});
});

test('C0 DEL and leftover C1 are single-character tokens', t => {
	for (const raw of [
		'\r',
		'\t',
		'\u0007',
		'\u0008',
		'\u0000',
		'\u007F',
		'\u009C',
	]) {
		t.deepEqual(readTerminalControl(`${raw}B`, 0), {
			kind: 'c0',
			raw,
			end: 1,
		});
	}
});

test('end is the exclusive source offset', t => {
	const prefix = 'ABC';
	const raw = '\u001B[31m';
	t.deepEqual(readTerminalControl(`${prefix}${raw}X`, prefix.length), {
		kind: 'csi',
		raw,
		end: prefix.length + raw.length,
	});
});
