import {createContext} from 'react';
import {type TextSelectionController} from '../text-selection-controller.js';

/**
Provides the instance-owned text selection controller to hooks. The value is
stable for the lifetime of the Ink instance — no module-level state exists.
*/
export const textSelectionContext = createContext<
	TextSelectionController | undefined
>(undefined);
