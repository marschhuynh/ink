// Newly authored artifact-driven reconstruction tests, not recovered originals.
import test from 'ava';
import * as outputModule from '../src/output.js';

const Output = outputModule.default;

test('reconstruction: output caches share measurements and bound FIFO retention', t => {
	t.is(typeof outputModule.OutputCaches, 'function');
	const caches = new outputModule.OutputCaches();
	const first = new Output({width: 20, height: 1, caches});
	const next = new Output({width: 20, height: 1, caches});
	t.is(first.measureWidestLine('a\n界x'), 3);
	t.is(next.measureWidestLine('a\n界x'), 3);
	t.is(caches.widestLineWidths.size, 1);
	for (let index = 0; index < 4096; index++) {
		caches.measureWidestLine(`row-${index}`);
		caches.getStringWidth(`cell-${index}`);
	}
	t.is(caches.widestLineWidths.size, 3073);
	t.false(caches.widestLineWidths.has('a\n界x'));
	t.is(caches.widths.size, 4096);
	caches.getStringWidth('overflow');
	t.is(caches.widths.size, 3073);
	t.false(caches.widths.has('cell-0'));
});
