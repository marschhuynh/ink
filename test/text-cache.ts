import test from 'ava';
import measureText, {getMeasureTextCacheSize} from '../src/measure-text.js';
import wrapText, {getWrapTextCacheSize} from '../src/wrap-text.js';

const cacheMax = 256;

test('measureText cache is bounded', t => {
	for (let index = 0; index < cacheMax + 100; index++) {
		measureText(`bounded-measure-${index}`);
	}

	t.true(getMeasureTextCacheSize() <= cacheMax);
});

test('wrapText cache is bounded', t => {
	for (let index = 0; index < cacheMax + 100; index++) {
		wrapText(`bounded wrap ${index}`, 20, 'wrap');
	}

	t.true(getWrapTextCacheSize() <= cacheMax);
});
