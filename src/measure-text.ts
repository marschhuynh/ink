import stringWidth from 'string-width';

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
		return cachedDimensions;
	}

	const lines = text.split('\n');
	let width = Math.max(0, ...lines.map(line => stringWidth(line)));

	// If width is > 0, add a tiny epsilon to prevent Yoga from wrapping
	// items with exact integer width (like 1) in some flexbox configurations.
	// This fixes a layout regression where items would wrap unexpectedly.
	if (width > 0) {
		width += 0.01;
		// Width += 0;
	}

	const height = lines.length;
	const dimensions = {width, height};
	cache.set(text, dimensions);

	return dimensions;
};

export default measureText;
