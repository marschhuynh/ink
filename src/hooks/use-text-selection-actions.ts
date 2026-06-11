import {useContext, useMemo} from 'react';
import {textSelectionContext} from '../components/TextSelectionContext.js';
import {type TextSelectionHandle} from '../text-selection-controller.js';

/**
Drive the text selection without subscribing to it.

Returns a stable handle of actions plus `getSnapshot()` for at-event-time
reads. Unlike `useTextSelection()`, the host component never re-renders on
selection changes — use this for mouse bridges and key handlers so dragging
repaints only the highlight overlay, not the React tree.
*/
export default function useTextSelectionActions(): TextSelectionHandle {
	const controller = useContext(textSelectionContext);

	if (!controller) {
		throw new Error('useTextSelectionActions must be used within an Ink app');
	}

	return useMemo(
		() => ({
			start: controller.start,
			update: controller.update,
			finish: controller.finish,
			clear: controller.clear,
			setViewportProvider: controller.setViewportProvider,
			getSnapshot: controller.getSnapshot,
		}),
		[controller],
	);
}
