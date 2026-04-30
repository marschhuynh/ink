import test from 'ava';
import measureText, {getMeasureTextCacheSize} from '../src/measure-text.js';
import wrapText, {getWrapTextCacheSize} from '../src/wrap-text.js';

const CACHE_MAX = 256;

test('measureText cache is bounded', t => {
	for (let index = 0; index < CACHE_MAX + 100; index++) {
		measureText(`bounded-measure-${index}`);
	}

	t.true(getMeasureTextCacheSize() <= CACHE_MAX);
});

test('wrapText cache is bounded', t => {
	for (let index = 0; index < CACHE_MAX + 100; index++) {
		wrapText(`bounded wrap ${index}`, 20, 'wrap');
	}

	t.true(getWrapTextCacheSize() <= CACHE_MAX);
});
