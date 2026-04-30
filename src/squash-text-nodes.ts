import {type DOMElement} from './dom.js';
import sanitizeAnsi from './sanitize-ansi.js';

// Squashing text nodes allows to combine multiple text nodes into one and write
// to `Output` instance only once. For example, <Text>hello{' '}world</Text>
// is actually 3 text nodes, which would result 3 writes to `Output`.
//
// Also, this is necessary for libraries like ink-link (https://github.com/sindresorhus/ink-link),
// which need to wrap all children at once, instead of wrapping 3 text nodes separately.
const squashTextNodes = (node: DOMElement): string => {
	let text = '';

	for (let index = 0; index < node.childNodes.length; index++) {
		const childNode = node.childNodes[index];

		if (childNode === undefined) {
			continue;
		}

		let nodeText = '';

		if (childNode.nodeName === '#text') {
			nodeText = childNode.nodeValue;
		} else {
			if (
				childNode.nodeName === 'ink-text' ||
				childNode.nodeName === 'ink-virtual-text'
			) {
				nodeText = squashTextNodes(childNode);
			}

			// Since these text nodes are being concatenated, `Output` instance won't be able to
			// apply children transform, so we have to do it manually here for each text node
			if (
				nodeText.length > 0 &&
				typeof childNode.internal_transform === 'function'
			) {
				nodeText = childNode.internal_transform(nodeText, index);
			}
		}

		text += nodeText;
	}

	return expandTabs(sanitizeAnsi(text));
};

/**
 * Normalize tab characters to spaces for consistent layout in Ink/Yoga.
 *
 * `string-width` counts `\t` as 0 width (it's a `\p{Control}` character),
 * which causes Yoga to allocate too little space for tab-containing text.
 * The terminal then renders tabs as advancing to the next tab stop (up to 8
 * columns), producing misaligned layouts.
 *
 * Expanding tabs to spaces here — the single chokepoint where all text passes
 * before both measurement and rendering — fixes the entire pipeline.
 */
const expandTabs = (text: string, tabSize = 4): string => {
	if (!text.includes('\t')) return text;
	return text.replaceAll('\t', ' '.repeat(tabSize));
};

export default squashTextNodes;
