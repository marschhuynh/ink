import test from 'ava';
import stripAnsi from 'strip-ansi';
import Output from '../src/output.js';
import {TextSelectionController} from '../src/text-selection-controller.js';
import {paintSelection} from '../src/paint-selection.js';

const renderWithSelection = (
	controller: TextSelectionController,
	write: (output: Output) => void,
	width = 16,
	height = 1,
) => {
	const output = new Output({width, height});
	write(output);
	return output.get({
		capturePlainRows: true,
		paint(grid, plainRows, maskRows) {
			controller.captureRows(plainRows, maskRows);
			paintSelection(grid, controller.getPaintSpans(width, height), maskRows);
		},
	}).output;
};

test('paints selected cells with inverse style', t => {
	const controller = new TextSelectionController();
	controller.start({x: 1, y: 0});
	controller.update({x: 4, y: 0});

	const result = renderWithSelection(controller, o => {
		o.write(0, 0, 'hello', {transformers: [], selectable: true});
	});
	t.regex(result, /\[7m/); // Inverse on
	t.is(stripAnsi(result), 'hello'); // Visible text unchanged
});

test('chrome cells inside the span are not painted', t => {
	const controller = new TextSelectionController();
	controller.start({x: 0, y: 0});
	controller.update({x: 9, y: 0});

	const result = renderWithSelection(controller, o => {
		o.write(0, 0, '1│', {transformers: []}); // Gutter: chrome
		o.write(3, 0, 'import', {transformers: [], selectable: true}); // Code: content
	});
	// The gutter glyphs carry no inverse styling; inverse opens exactly at
	// the code (the escape immediately precedes "import").
	t.true(result.startsWith('1│'));
	t.regex(result, /\[7mimport/);
});

test('selection scrolled out of the viewport is not painted', t => {
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

	scrollY = 3; // Anchor row now 3 rows above the viewport
	const result = renderWithSelection(controller, o => {
		o.write(0, 0, 'line-four', {transformers: [], selectable: true});
	});
	t.notRegex(result, /\[7m\S/); // No painted glyph cells from the stale row
});

test('wide characters never get half-glyph highlights', t => {
	const controller = new TextSelectionController();
	controller.start({x: 1, y: 0});
	controller.update({x: 2, y: 0}); // Touches only the first half of 中

	const result = renderWithSelection(controller, o => {
		o.write(0, 0, 'a中b', {transformers: [], selectable: true});
	});
	t.is(stripAnsi(result), 'a中b');
	// The wide glyph is highlighted as a whole: inverse opens before 中 and
	// closes before b.
	t.regex(result, /\[7m中/);
	t.regex(result, /\[27mb|\[0mb|\[mb/);
});

test('identical rows do not leak highlight to each other', t => {
	// Identical lines share cached StyledChar objects inside Output; painting
	// row 0 must not also paint row 1.
	const controller = new TextSelectionController();
	controller.start({x: 0, y: 0});
	controller.update({x: 3, y: 0}); // Only row 0 selected

	const output = new Output({width: 8, height: 2});
	output.write(0, 0, 'same', {transformers: [], selectable: true});
	output.write(0, 1, 'same', {transformers: [], selectable: true});

	const result = output.get({
		capturePlainRows: true,
		paint(grid, plainRows, maskRows) {
			controller.captureRows(plainRows, maskRows);
			paintSelection(grid, controller.getPaintSpans(8, 2), maskRows);
		},
	}).output;

	const [first, second] = result.split('\n');
	t.regex(first!, /\[7m/);
	t.notRegex(second!, /\[7m/);
});
