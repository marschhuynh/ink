import widestLine from 'widest-line';

export const measureTextCacheMax = 256;

const cache = new Map<string, Output>();

type Output = {
	width: number;
	height: number;
};

const measureText = (text: string): Output => {
	if (text.length === 0) {
		return {
			width: 0,
			height: 0,
		};
	}

	const cachedDimensions = cache.get(text);

	if (cachedDimensions) {
		cache.delete(text);
		cache.set(text, cachedDimensions);
		return cachedDimensions;
	}

	const width = widestLine(text);
	const height = text.split('\n').length;
	const dimensions = {width, height};
	cache.set(text, dimensions);
	if (cache.size > measureTextCacheMax) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey !== undefined) {
			cache.delete(oldestKey);
		}
	}

	return dimensions;
};

export const getMeasureTextCacheSize = (): number => cache.size;

export default measureText;
