import {useContext, useMemo, useSyncExternalStore} from 'react';
import {textSelectionContext} from '../components/TextSelectionContext.js';
import {
	type TextSelectionActions,
	type TextSelectionSnapshot,
} from '../text-selection-controller.js';

/**
Read the current text selection and drive it programmatically.

`anchor`/`focus` are content coordinates; `start`/`update` take 0-based screen
cells on the Ink output grid. Only components calling this hook re-render on
selection changes.
*/
export default function useTextSelection(): TextSelectionSnapshot &
	TextSelectionActions {
	const controller = useContext(textSelectionContext);

	if (!controller) {
		throw new Error('useTextSelection must be used within an Ink app');
	}

	const snapshot = useSyncExternalStore(
		listener => controller.subscribe(listener),
		() => controller.getSnapshot(),
	);

	const actions = useMemo(
		() => ({
			start: controller.start,
			update: controller.update,
			finish: controller.finish,
			clear: controller.clear,
			setViewportProvider: controller.setViewportProvider,
		}),
		[controller],
	);

	return {...snapshot, ...actions};
}
