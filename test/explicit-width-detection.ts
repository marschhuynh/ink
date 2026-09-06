import test, {type ExecutionContext} from 'ava';
import sinon from 'sinon';
import {
	ExplicitWidthDetection,
	canOverwriteFirstCell,
} from '../src/explicit-width-detection.js';

const query = '\u001B[?6n';
const probe = '\u001B]66;w=1; \u001B\\\u001B[?6n\r';
const setup = (t: ExecutionContext, reserve = true) => {
	const clock = sinon.useFakeTimers();
	t.teardown(() => clock.restore());
	const writes: string[] = [];
	const results: boolean[] = [];
	let reservations = 0;
	const detector = new ExplicitWidthDetection({
		getSize: () => ({columns: 80, rows: 24}),
		write: text => {
			writes.push(text);
		},
		reserve: () => {
			reservations++;
			return reserve;
		},
		onResult: supported => {
			results.push(supported);
		},
	});
	t.teardown(() => detector.cancel());
	return {clock, writes, results, detector, reservations: () => reservations};
};

test.serial(
	'detector waits for input readiness within the first-frame deadline',
	t => {
		const {clock, writes, results, detector} = setup(t);
		detector.start();
		clock.tick(199);
		t.deepEqual(writes, []);
		detector.setInputReady(true);
		t.deepEqual(writes, [query]);
		clock.tick(1);
		t.deepEqual(results, [false]);
		detector.setInputReady(true);
		detector.start();
		t.deepEqual(writes, [query]);
		t.is(clock.countTimers(), 0);
	},
);

test.serial(
	'detector confirms same-row one-cell advance and reserves before drawing',
	t => {
		const {writes, results, detector, reservations, clock} = setup(t);
		detector.setInputReady(true);
		t.deepEqual(writes, []);
		detector.start();
		detector.accept({row: 7, column: 1});
		t.is(reservations(), 1);
		t.deepEqual(writes, [query, probe]);
		t.deepEqual(results, []);
		detector.accept({row: 7, column: 2});
		t.deepEqual(results, [true]);
		t.true(detector.settled);
		t.false(detector.pending);
		t.is(clock.countTimers(), 0);
		detector.cancel();
		detector.accept({row: 7, column: 2});
		t.deepEqual(results, [true]);
	},
);

for (const initial of [
	{row: 1, column: 5},
	{row: 0, column: 1},
	{row: 25, column: 1},
	{row: 1, column: 81},
	{row: Number.NaN, column: 1},
	{row: 1.5, column: 1},
]) {
	test.serial(
		`detector rejects unsafe initial position ${JSON.stringify(initial)}`,
		t => {
			const {writes, results, detector, reservations} = setup(t);
			detector.setInputReady(true);
			detector.start();
			detector.accept(initial);
			t.deepEqual(results, [false]);
			t.deepEqual(writes, [query]);
			t.is(reservations(), 0);
		},
	);
}

for (const reply of [
	{row: 7, column: 1},
	{row: 8, column: 2},
	{row: 7, column: 3},
]) {
	test.serial(
		`detector rejects unsupported or unexpected advance ${JSON.stringify(reply)}`,
		t => {
			const {results, detector} = setup(t);
			detector.setInputReady(true);
			detector.start();
			detector.accept({row: 7, column: 1});
			detector.accept(reply);
			t.deepEqual(results, [false]);
		},
	);
}

test.serial(
	'detector never draws when output cannot reserve its first cell',
	t => {
		const {writes, results, detector} = setup(t, false);
		detector.setInputReady(true);
		detector.start();
		detector.accept({row: 7, column: 1});
		t.deepEqual(writes, [query]);
		t.deepEqual(results, [false]);
	},
);

test.serial(
	'detector cancels on readiness loss and ignores late replies',
	async t => {
		const {writes, results, detector, clock} = setup(t);
		detector.setInputReady(true);
		detector.start();
		detector.accept({row: 7, column: 1});
		detector.setInputReady(false);
		await detector.finished;
		detector.accept({row: 7, column: 2});
		clock.tick(500);
		t.deepEqual(results, [false]);
		t.deepEqual(writes, [query, probe]);
	},
);

test.serial(
	'detector times out without taking raw input ownership',
	async t => {
		const {writes, results, detector, clock} = setup(t);
		detector.start();
		clock.tick(200);
		await detector.finished;
		t.deepEqual(writes, []);
		t.deepEqual(results, [false]);
	},
);

test.serial(
	'synchronous replies settle only after the complete probe write returns',
	t => {
		const clock = sinon.useFakeTimers();
		t.teardown(() => clock.restore());
		const events: string[] = [];
		const detector = new ExplicitWidthDetection({
			getSize: () => ({columns: 80, rows: 24}),
			reserve: () => {
				events.push('reserve');
				return true;
			},
			write: text => {
				events.push(text);
				detector.accept({row: 3, column: text === query ? 1 : 2});
				events.push('write returned');
			},
			onResult: supported => {
				events.push(`settled ${supported}`);
			},
		});
		detector.setInputReady(true);
		detector.start();
		t.deepEqual(events, [
			query,
			'write returned',
			'reserve',
			probe,
			'write returned',
			'settled true',
		]);
		t.is(clock.countTimers(), 0);
	},
);

test.serial(
	'reentrant cancellation remains pending until result publication completes',
	t => {
		const events: string[] = [];
		let detector!: ExplicitWidthDetection;
		detector = new ExplicitWidthDetection({
			getSize: () => ({columns: 80, rows: 24}),
			reserve: () => true,
			write: text => {
				events.push(text);
				detector.cancel();
				detector.onSettled(() => events.push(`published ${detector.settled}`));
				events.push(`write pending ${detector.pending}`);
			},
			onResult: supported => {
				events.push(`result ${supported} settled ${detector.settled}`);
			},
		});
		detector.setInputReady(true);
		detector.start();
		t.deepEqual(events, [
			query,
			'write pending true',
			'result false settled false',
			'published true',
		]);
	},
);

test.serial(
	'query write failures settle fallback and release the deadline',
	async t => {
		const clock = sinon.useFakeTimers();
		t.teardown(() => clock.restore());
		const results: boolean[] = [];
		const detector = new ExplicitWidthDetection({
			getSize: () => ({columns: 80, rows: 24}),
			reserve: () => true,
			write: () => {
				throw new Error('query write failed');
			},
			onResult: result => {
				results.push(result);
			},
		});
		detector.setInputReady(true);
		detector.start();
		t.is(clock.countTimers(), 0);
		await detector.finished;
		t.deepEqual(results, [false]);
	},
);

test('first-cell reservation accepts only rendition prefixes and printable initial content', t => {
	for (const text of [
		'A',
		' ',
		'⚡︎',
		'┌─┐',
		'\u001B[31m⚠️',
		'\u001B]8;;https://example.test\u001B\\⚡︎',
	]) {
		t.true(canOverwriteFirstCell(text), JSON.stringify(text));
	}
	for (const text of [
		'',
		'\nA',
		'\tA',
		'\u0301A',
		'\u200DA',
		'\u001B[2CA',
		'\u001B]52;c;abc\u0007A',
		'\u001B]8;;unfinished',
		'\u001B[31',
	]) {
		t.false(canOverwriteFirstCell(text), JSON.stringify(text));
	}
});

for (const lateEvent of ['readiness', 'reply']) {
	test.serial(
		'elapsed deadline rejects late ' +
			lateEvent +
			' before the timer callback runs',
		t => {
			const {clock, detector, writes, results} = setup(t);
			if (lateEvent === 'reply') detector.setInputReady(true);
			detector.start();
			clock.setSystemTime(clock.now + 201);
			if (lateEvent === 'readiness') detector.setInputReady(true);
			else detector.accept({row: 3, column: 1});
			t.deepEqual(results, [false]);
			t.deepEqual(writes, lateEvent === 'reply' ? [query] : []);
			t.is(clock.countTimers(), 0);
		},
	);
}
