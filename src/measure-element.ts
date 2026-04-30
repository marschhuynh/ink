import Yoga from 'yoga-layout';
import {type DOMElement} from './dom.js';

type ElementMeasurement = {
	/**
	Element width.
	*/
	width: number;

	/**
	Element height.
	*/
	height: number;

	/**
	Element absolute horizontal position (column) on screen.
	*/
	x: number;

	/**
	Element absolute vertical position (row) on screen.
	*/
	y: number;
};

/**
Measure the dimensions and absolute position of a particular `<Box>` element.
Returns an object with `width`, `height`, `x`, and `y` properties.
This function is useful when your component needs to know the amount of available space it has. You can use it when you need to change the layout based on the length of its content.

Note: `measureElement()` returns `{width: 0, height: 0, x: 0, y: 0}` when called during render (before layout is calculated). Call it from post-render code, such as `useEffect`, `useLayoutEffect`, input handlers, or timer callbacks. When content changes, pass the relevant dependency to your effect so it re-measures after each update.
*/
const measureElement = (node: DOMElement): ElementMeasurement => {
	const {yogaNode} = node;
	if (!yogaNode) {
		return {width: 0, height: 0, x: 0, y: 0};
	}

	let x = yogaNode.getComputedLeft();
	let y = yogaNode.getComputedTop();
	let current: DOMElement | undefined = node.parentNode;

	while (current?.yogaNode) {
		const parentYoga = current.yogaNode;
		x +=
			parentYoga.getComputedLeft() +
			parentYoga.getComputedPadding(Yoga.EDGE_LEFT);
		y +=
			parentYoga.getComputedTop() +
			parentYoga.getComputedPadding(Yoga.EDGE_TOP);
		current = current.parentNode;
	}

	return {
		width: yogaNode.getComputedWidth(),
		height: yogaNode.getComputedHeight(),
		x,
		y,
	};
};

export default measureElement;
