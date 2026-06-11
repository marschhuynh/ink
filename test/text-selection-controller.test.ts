import test from 'ava';
import {TextSelectionController} from '../src/text-selection-controller.js';

test('start/update/finish computes text from captured rows', t => {
	const controller = new TextSelectionController();
	controller.captureRows(['hello world']);
	controller.start({x: 0, y: 0});
	controller.update({x: 5, y: 0});
	controller.finish();
	t.is(controller.getSnapshot().text, 'hello');
	t.false(controller.getSnapshot().isDragging);
});

test('text recomputes when rows arrive after the gesture', t => {
	const controller = new TextSelectionController();
	controller.start({x: 0, y: 0});
	controller.update({x: 5, y: 0});
	controller.finish();
	t.is(controller.getSnapshot().text, '');
	controller.captureRows(['hello world']);
	t.is(controller.getSnapshot().text, 'hello');
});

test('chrome cells are excluded from extracted text', t => {
	const controller = new TextSelectionController();
	const mask = (p: string) => [...p].map(c => c === '#');
	controller.captureRows(
		['⚙ Edited file · /path.ts'],
		[mask('--######################')], // Icon + gap are chrome
	);
	controller.start({x: 0, y: 0});
	controller.update({x: 24, y: 0});
	controller.finish();
	t.is(controller.getSnapshot().text, 'Edited file · /path.ts');
});

test('viewport provider converts screen points to content space', t => {
	const controller = new TextSelectionController();
	let scrollY = 0;
	controller.setViewportProvider(() => ({
		top: 2,
		left: 1,
		width: 10,
		height: 3,
		scrollY,
	}));

	controller.captureRows(['', '', ' line-A', ' line-B', ' line-C']); // Screen rows
	controller.start({x: 1, y: 2}); // -> content {x: 0, y: 0}
	t.deepEqual(controller.getSnapshot().anchor, {x: 0, y: 0});

	scrollY = 2; // Container scrolled down 2 rows
	controller.captureRows(['', '', ' line-C', ' line-D', ' line-E']);
	controller.update({x: 7, y: 4}); // -> content {x: 6, y: 4}
	t.deepEqual(controller.getSnapshot().focus, {x: 6, y: 4});

	// Rows observed before the scroll are retained under their content keys.
	t.is(controller.getSnapshot().text, 'line-A\nline-B\nline-C\nline-D\nline-E');
});

test('subscribers are notified only on real changes', t => {
	const controller = new TextSelectionController();
	let calls = 0;
	controller.subscribe(() => calls++);
	controller.captureRows(['abc']);
	controller.captureRows(['abc']); // Identical rows, no selection -> no emit
	t.is(calls, 0);
	controller.start({x: 0, y: 0});
	t.is(calls, 1);
});

test('clear resets selection and row cache', t => {
	const controller = new TextSelectionController();
	controller.captureRows(['abc']);
	controller.start({x: 0, y: 0});
	controller.update({x: 2, y: 0});
	controller.clear();
	const snapshot = controller.getSnapshot();
	t.is(snapshot.anchor, null);
	t.is(snapshot.text, '');
	t.true(snapshot.isEmpty);
});

test('invalidate callback fires on visual changes', t => {
	const controller = new TextSelectionController();
	let invalidations = 0;
	controller.onInvalidate = () => invalidations++;
	controller.captureRows(['abc']);
	controller.start({x: 0, y: 0});
	controller.update({x: 2, y: 0});
	t.true(invalidations >= 2);
});

test('cache freezes after finish: re-rendered rows do not change extracted text', t => {
	const controller = new TextSelectionController();
	controller.captureRows(['hello world']);
	controller.start({x: 0, y: 0});
	controller.update({x: 5, y: 0});
	controller.finish();
	t.is(controller.getSnapshot().text, 'hello');

	// Identical row keeps the selection; text never silently changes post-release.
	controller.captureRows(['hello world']);
	t.is(controller.getSnapshot().text, 'hello');
});

test('selection auto-clears when content reflows underneath it', t => {
	const controller = new TextSelectionController();
	controller.captureRows(['hello world']);
	controller.start({x: 0, y: 0});
	controller.update({x: 5, y: 0});
	controller.finish();

	// A streamed message above re-rendered; this content row now holds other text.
	controller.captureRows(['goodbye moon']);
	t.true(controller.getSnapshot().isEmpty);
	t.is(controller.getSnapshot().text, '');
});

test('cache keeps updating while dragging (auto-scroll depends on it)', t => {
	const controller = new TextSelectionController();
	controller.captureRows(['hello world']);
	controller.start({x: 0, y: 0});
	controller.update({x: 5, y: 0});
	// Still dragging: new rows replace cache entries and text recomputes.
	controller.captureRows(['HELLO world']);
	t.is(controller.getSnapshot().text, 'HELLO');
});

test('a transient null viewport after finish does not clear or move the selection', t => {
	const controller = new TextSelectionController();
	let viewport: {
		top: number;
		left: number;
		width: number;
		height: number;
		scrollY: number;
	} | null = {top: 0, left: 2, width: 11, height: 1, scrollY: 0};
	controller.setViewportProvider(() => viewport);

	// "  hello world" sliced to the viewport [left: 2, width: 11] -> "hello world".
	controller.captureRows(['  hello world']);
	controller.start({x: 2, y: 0});
	controller.update({x: 7, y: 0});
	controller.finish();
	t.is(controller.getSnapshot().text, 'hello');
	t.deepEqual(controller.getPaintSpans(13, 1), [{y: 0, x1: 2, x2: 7}]);

	// Bounds momentarily unavailable (e.g. width 0 mid-re-render): provider
	// returns null. The frozen cache must not be compared against a full-grid
	// re-slice, and the highlight must stay attached to its last viewport.
	viewport = null;
	controller.captureRows(['  hello world']);
	t.false(controller.getSnapshot().isEmpty);
	t.is(controller.getSnapshot().text, 'hello');
	t.deepEqual(controller.getPaintSpans(13, 1), [{y: 0, x1: 2, x2: 7}]);

	// Bounds return: selection is intact and still correct.
	viewport = {top: 0, left: 2, width: 11, height: 1, scrollY: 0};
	controller.captureRows(['  hello world']);
	t.is(controller.getSnapshot().text, 'hello');
});

test('getPaintSpans drops rows scrolled outside the viewport', t => {
	const controller = new TextSelectionController();
	let scrollY = 0;
	controller.setViewportProvider(() => ({
		top: 0,
		left: 0,
		width: 16,
		height: 1,
		scrollY,
	}));
	controller.captureRows(['line-one']);
	controller.start({x: 0, y: 0});
	controller.update({x: 4, y: 0});

	t.deepEqual(controller.getPaintSpans(16, 1), [{y: 0, x1: 0, x2: 4}]);

	scrollY = 3; // Anchor row now 3 rows above the viewport
	t.deepEqual(controller.getPaintSpans(16, 1), []);
});
