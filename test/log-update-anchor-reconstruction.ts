// Newly authored from published 7.7.5-alpha artifacts; not recovered tests.
import test from 'ava';
import logUpdate from '../src/log-update.js';
import createStdout from './helpers/create-stdout.js';
import {
	Terminal,
	viewportLine,
	writeTerminal,
} from './helpers/terminal-model.js';

const csi = '\u001B[';
const frames = ['a\nb\nc\nd', 'b\nc\nd\ne', 'c\nd\ne\nf'];

test('reconstruction: non-fullscreen scroll waits for an absolute row anchor', async t => {
	const stdout = createStdout(20);
	stdout.rows = 12;
	const log = logUpdate.create(stdout, {incremental: true, showCursor: true});
	log(frames[0]!);
	log(frames[1]!);
	t.false(stdout.get().includes(`${csi}1;4r`));
	t.true(stdout.get().endsWith(`${csi}?6n`));
	t.true(log.hasPendingAnchorQuery());
	log.noteCursorRow(9);
	t.false(log.hasPendingAnchorQuery());
	log(frames[2]!);
	t.true(stdout.get().includes(`${csi}6;9r`));

	const terminal = new Terminal({cols: 20, rows: 12, allowProposedApi: true});
	t.teardown(() => {
		terminal.dispose();
	});
	await writeTerminal(
		terminal,
		`${csi}1;1HPROMPT${csi}6;1H${frames[1]!.replaceAll('\n', '\r\n')}`,
	);
	await writeTerminal(terminal, stdout.get());
	t.is(viewportLine(terminal, 0).trimEnd(), 'PROMPT');
	for (const [index, row] of frames[2]!.split('\n').entries()) {
		t.is(viewportLine(terminal, 5 + index).trimEnd(), row);
	}
});

test('reconstruction: an intervening write makes an anchor reply stale', t => {
	const stdout = createStdout(20);
	stdout.rows = 12;
	const log = logUpdate.create(stdout, {incremental: true, showCursor: true});
	log(frames[0]!);
	log(frames[1]!);
	t.true(log.hasPendingAnchorQuery());
	log(frames[2]!);
	log.noteCursorRow(9);
	t.false(log.hasPendingAnchorQuery());
	log('d\ne\nf\ng');
	t.false(stdout.get().includes(`${csi}6;9r`));
	t.true(stdout.get().endsWith(`${csi}?6n`));
	log.noteCursorRow(9);
	log('e\nf\ng\nh');
	t.true(stdout.get().includes(`${csi}6;9r`));
});

test('reconstruction: unanswered anchor queries have a lifetime retry budget', t => {
	const stdout = createStdout(20);
	stdout.rows = 12;
	const log = logUpdate.create(stdout, {incremental: true, showCursor: true});
	for (let frame = 0; frame < 9; frame++) {
		log(Array.from({length: 4}, (_, row) => `row-${frame + row}`).join('\n'));
	}

	t.is(
		stdout.getWrites().filter(write => write.includes(`${csi}?6n`)).length,
		3,
	);
	t.false(log.hasPendingAnchorQuery());
	log.reset();
	log(frames[0]!);
	log(frames[1]!);
	t.false(log.hasPendingAnchorQuery());
	t.false(stdout.get().includes(`${csi}?6n`));
});

test('reconstruction: sync establishes home while reset rejects unsolicited anchors', t => {
	const stdout = createStdout(20);
	stdout.rows = 12;
	const log = logUpdate.create(stdout, {incremental: true, showCursor: true});
	log.sync(frames[0]!);
	log(frames[1]!);
	t.true(stdout.get().includes(`${csi}1;4r`));
	log.reset();
	log.noteCursorRow(9);
	log(frames[0]!);
	log(frames[1]!);
	t.false(stdout.get().includes(`${csi}6;9r`));
	t.true(log.hasPendingAnchorQuery());
	log.clear();
	t.false(log.hasPendingAnchorQuery());
});

test('reconstruction: unknown height and committed carets do not arm anchor queries', t => {
	for (const withCaret of [false, true]) {
		const stdout = createStdout(20);
		if (withCaret) stdout.rows = 12;
		const log = logUpdate.create(stdout, {incremental: true, showCursor: true});
		if (withCaret) log.setCursorPosition({x: 0, y: 0});
		log(frames[0]!);
		log(frames[1]!);
		t.false(log.hasPendingAnchorQuery());
		t.false(stdout.get().includes(`${csi}?6n`));
		t.false(stdout.get().includes(`${csi}1;4r`));
	}
});
