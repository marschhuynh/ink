import test from 'ava';
import {createInputParser} from '../src/input-parser.js';

test('terminal replies leave ordinary coalesced keys in the application channel', t => {
	const responses: unknown[] = [];
	const parser = createInputParser({
		onTerminalResponse: (response: unknown) => responses.push(response),
	});
	t.deepEqual(parser.push('x\u001B[?12;1Ry'), ['x', 'y']);
	t.deepEqual(responses, [{type: 'cursor-position', row: 12, column: 1}]);
});

test('private CPR and Kitty replies share one input parser without replay', t => {
	const responses: unknown[] = [];
	const parser = createInputParser({
		onTerminalResponse: (response: unknown) => responses.push(response),
	});
	t.deepEqual(parser.push('⚡︎\u001B[?3u\u001B[?4;2R✅'), ['⚡︎', '✅']);
	t.deepEqual(responses, [
		{type: 'kitty-keyboard', flags: 3},
		{type: 'cursor-position', row: 4, column: 2},
	]);
	t.deepEqual(parser.push('next'), ['next']);
	t.is(responses.length, 2);
});

test('modified F3 remains a key rather than a public-CPR response', t => {
	const responses: unknown[] = [];
	const parser = createInputParser({
		onTerminalResponse: (response: unknown) => responses.push(response),
	});
	t.deepEqual(parser.push('\u001B[1;2R'), ['\u001B[1;2R']);
	t.deepEqual(responses, []);
});

test('known private reply partials cannot escape through the ordinary ESC flush', t => {
	const responses: unknown[] = [];
	const parser = createInputParser({
		onTerminalResponse: (response: unknown) => responses.push(response),
	});
	t.deepEqual(parser.push('\u001B[?12;'), []);
	t.false(parser.hasPendingEscape());
	t.is(parser.flushPendingEscape(), undefined);
	t.deepEqual(parser.push('2Rk'), ['k']);
	t.deepEqual(responses, [{type: 'cursor-position', row: 12, column: 2}]);
});

test('startup holds ambiguous ESC prefixes only while negotiation is pending', t => {
	let pending = true;
	const parser = createInputParser({
		onTerminalResponse: (_response: unknown) => {},
		isTerminalResponsePending: () => pending,
	});
	t.deepEqual(parser.push('\u001B'), []);
	t.false(parser.hasPendingEscape());
	t.is(parser.flushPendingEscape(), undefined);
	pending = false;
	t.true(parser.hasPendingEscape());
	t.is(parser.flushPendingEscape(), '\u001B');
	t.is(parser.flushPendingEscape(), undefined);
});

test('late complete private replies remain protocol records after startup settles', t => {
	const responses: unknown[] = [];
	const parser = createInputParser({
		onTerminalResponse: (response: unknown) => responses.push(response),
		isTerminalResponsePending: () => false,
	});
	t.deepEqual(parser.push('\u001B[?5;2Rz'), ['z']);
	t.deepEqual(responses, [{type: 'cursor-position', row: 5, column: 2}]);
});

test('bracketed paste retains response-like text verbatim', t => {
	const responses: unknown[] = [];
	const parser = createInputParser({
		onTerminalResponse: (response: unknown) => responses.push(response),
	});
	const pasted = 'a\u001B[?5;2R\u001B[?3u⚡︎';
	t.deepEqual(parser.push(`\u001B[200~${pasted}\u001B[201~`), [
		{paste: pasted},
	]);
	t.deepEqual(responses, []);
});

test('a parser without response routing keeps its existing generic input contract', t => {
	const parser = createInputParser();
	t.deepEqual(parser.push('\u001B[?5;2R\u001B[?3u'), [
		'\u001B[?5;2R',
		'\u001B[?3u',
	]);
});

for (const [reply, expected] of [
	['\u001B[?12;2R', {type: 'cursor-position', row: 12, column: 2}],
	['\u001B[?3u', {type: 'kitty-keyboard', flags: 3}],
] as const) {
	test(`startup reply is consumed at every split boundary: ${JSON.stringify(reply)}`, t => {
		for (let split = 1; split < reply.length; split++) {
			const responses: unknown[] = [];
			const parser = createInputParser({
				onTerminalResponse: (response: unknown) => responses.push(response),
				isTerminalResponsePending: () => true,
			});
			t.deepEqual(parser.push(reply.slice(0, split)), []);
			t.false(parser.hasPendingEscape());
			t.is(parser.flushPendingEscape(), undefined);
			t.deepEqual(parser.push(reply.slice(split) + '😀'), ['😀']);
			t.deepEqual(responses, [expected]);
		}
	});
}

test('normal Kitty keyboard CSI-u events are not capability replies', t => {
	const responses: unknown[] = [];
	const parser = createInputParser({
		onTerminalResponse: (response: unknown) => responses.push(response),
	});
	t.deepEqual(parser.push('\u001B[97;5u'), ['\u001B[97;5u']);
	t.deepEqual(responses, []);
});

test('oversized private replies are discarded rather than accepted as capabilities', t => {
	const responses: unknown[] = [];
	const parser = createInputParser({
		onTerminalResponse: (response: unknown) => responses.push(response),
	});
	t.deepEqual(parser.push('\u001B[?' + '0'.repeat(10_000) + '1;2Rk'), ['k']);
	t.deepEqual(responses, []);
	parser.push('\u001B[?' + '0'.repeat(10_000));
	t.deepEqual(parser.push('1;2Rz'), ['z']);
	t.deepEqual(responses, []);
});

test('a truncated oversized reply cannot swallow an interrupt or following key', t => {
	const parser = createInputParser({
		onTerminalResponse: (_response: unknown) => {},
	});
	parser.push('\u001B[?' + '0'.repeat(10_000));
	t.deepEqual(parser.push('\u0003'), ['\u0003']);
	t.deepEqual(parser.push('x'), ['x']);
});

test('normal keys recover from an expired private reply prefix', t => {
	let pending = true;
	const responses: unknown[] = [];
	const parser = createInputParser({
		onTerminalResponse: (response: unknown) => responses.push(response),
		isTerminalResponsePending: () => pending,
	});
	parser.push('\u001B[?1');
	pending = false;
	t.deepEqual(parser.push('a'), ['a']);
	t.deepEqual(responses, []);
});
