import React, {
	forwardRef,
	useContext,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
	type PropsWithChildren,
} from 'react';
import Yoga from 'yoga-layout';
import {type Except} from 'type-fest';
import {type Styles} from '../styles.js';
import {type DOMElement} from '../dom.js';
import {
	clampViewportScroll,
	getScrollViewportMetadata,
	requestRootPaint,
	sameOffset,
} from '../layout-metadata.js';
import {accessibilityContext} from './AccessibilityContext.js';
import {backgroundContext} from './BackgroundContext.js';

export type PaintOrder = {
	epoch: number;
	index: number;
};

export type BoxRef = DOMElement & {
	scrollTo: (options: {x?: number; y?: number}) => void;
	getScrollPosition: () => {x: number; y: number};
	scrollToTop: () => void;
	scrollToBottom: () => void;
	getBounds: () => {x: number; y: number; width: number; height: number};
	getPaintOrder: () => PaintOrder | undefined;
};

export type Props = Except<Styles, 'textWrap'> & {
	/**
	A label for the element for screen readers.
	*/
	readonly 'aria-label'?: string;

	/**
	Hide the element from screen readers.
	*/
	readonly 'aria-hidden'?: boolean;

	/**
	The role of the element.
	*/
	readonly 'aria-role'?:
		| 'button'
		| 'checkbox'
		| 'combobox'
		| 'list'
		| 'listbox'
		| 'listitem'
		| 'menu'
		| 'menuitem'
		| 'option'
		| 'progressbar'
		| 'radio'
		| 'radiogroup'
		| 'tab'
		| 'tablist'
		| 'table'
		| 'textbox'
		| 'timer'
		| 'toolbar';

	/**
	The state of the element.
	*/
	readonly 'aria-state'?: {
		readonly busy?: boolean;
		readonly checked?: boolean;
		readonly disabled?: boolean;
		readonly expanded?: boolean;
		readonly multiline?: boolean;
		readonly multiselectable?: boolean;
		readonly readonly?: boolean;
		readonly required?: boolean;
		readonly selected?: boolean;
	};
};

/**
`<Box>` is an essential Ink component to build your layout. It's like `<div style="display: flex">` in the browser.
*/
export const createBoxComponent = (
	displayName: string,
	viewportCulling: boolean,
) => {
	const Component = forwardRef<BoxRef, PropsWithChildren<Props>>(
		(
			{
				children,
				backgroundColor,
				'aria-label': ariaLabel,
				'aria-hidden': ariaHidden,
				'aria-role': role,
				'aria-state': ariaState,
				...style
			},
			ref,
		) => {
			const internalRef = useRef<DOMElement>(null);
			const scrollStateRef = useRef({x: 0, y: 0});
			const [scrollVersion, setScrollVersion] = useState(0);

			useImperativeHandle(ref, () => {
				const element = internalRef.current;
				if (!element) {
					return null as unknown as BoxRef;
				}

				const getContentDimensions = () => {
					const {yogaNode} = element;
					if (!yogaNode) {
						return {width: 0, height: 0};
					}

					let maxWidth = 0;
					let maxHeight = 0;

					const measureNode = (
						node: typeof element,
						offsetX: number,
						offsetY: number,
					) => {
						for (const child of node.childNodes) {
							if ('yogaNode' in child && child.yogaNode) {
								const childYoga = child.yogaNode;
								const childX = offsetX + childYoga.getComputedLeft();
								const childY = offsetY + childYoga.getComputedTop();
								const right = childX + childYoga.getComputedWidth();
								const bottom = childY + childYoga.getComputedHeight();
								maxWidth = Math.max(maxWidth, right);
								maxHeight = Math.max(maxHeight, bottom);
								measureNode(child as typeof element, childX, childY);
							}
						}
					};

					measureNode(element, 0, 0);

					return {width: maxWidth, height: maxHeight};
				};

				const getMaxScroll = () => {
					const {yogaNode} = element;
					if (!yogaNode) {
						return {x: 0, y: 0};
					}

					const containerWidth =
						yogaNode.getComputedWidth() -
						yogaNode.getComputedBorder(Yoga.EDGE_LEFT) -
						yogaNode.getComputedBorder(Yoga.EDGE_RIGHT);
					const containerHeight =
						yogaNode.getComputedHeight() -
						yogaNode.getComputedBorder(Yoga.EDGE_TOP) -
						yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM);
					const metadata = getScrollViewportMetadata(element);
					const content =
						viewportCulling && metadata
							? metadata.contentExtent
							: getContentDimensions();

					return {
						x: Math.max(0, content.width - containerWidth),
						y: Math.max(0, content.height - containerHeight),
					};
				};

				const applyViewportScroll = (requested: {x?: number; y?: number}) => {
					if (viewportCulling) {
						const current =
							element.internal_scrollOffset ?? scrollStateRef.current;
						const next = clampViewportScroll(element, requested);
						// Keep the hook ref synchronized before the caller's React controller
						// commit can run this component's layout effect.
						scrollStateRef.current = {...next};
						if (sameOffset(current, next)) return;
						element.internal_scrollOffset = {...next};
						requestRootPaint(element);
						return;
					}

					const maxScroll = getMaxScroll();
					if (requested.x !== undefined) {
						scrollStateRef.current.x = Math.max(
							0,
							Math.min(requested.x, maxScroll.x),
						);
					}

					if (requested.y !== undefined) {
						scrollStateRef.current.y = Math.max(
							0,
							Math.min(requested.y, maxScroll.y),
						);
					}

					element.internal_scrollOffset = {...scrollStateRef.current};
					setScrollVersion(version => version + 1);
				};

				return Object.assign(element, {
					scrollTo(requested: {x?: number; y?: number}) {
						applyViewportScroll(requested);
					},
					getScrollPosition() {
						if (viewportCulling) {
							return {...(element.internal_scrollOffset ?? {x: 0, y: 0})};
						}

						return {...scrollStateRef.current};
					},
					scrollToTop() {
						applyViewportScroll({y: 0});
					},
					scrollToBottom() {
						applyViewportScroll({y: Number.MAX_SAFE_INTEGER});
					},
					getBounds() {
						const {yogaNode} = element;
						if (!yogaNode) {
							return {x: 0, y: 0, width: 0, height: 0};
						}

						let x = yogaNode.getComputedLeft();
						let y = yogaNode.getComputedTop();
						const width = yogaNode.getComputedWidth();
						const height = yogaNode.getComputedHeight();

						// A pinned sticky is drawn away from its Yoga-derived position.
						// Prefer its recorded rect only while its paint epoch is current;
						// rejected subtrees can intentionally retain older sticky rects.
						const stickyRect = element.internal_stickyRect;
						if (
							element.style.position === 'sticky' &&
							stickyRect &&
							element.internal_paintEpoch !== undefined
						) {
							let root: DOMElement = element;
							while (root.parentNode) {
								root = root.parentNode;
							}

							if (
								root.nodeName === 'ink-root' &&
								root.internal_paintEpoch !== undefined &&
								element.internal_paintEpoch === root.internal_paintEpoch
							) {
								return {x: stickyRect.x, y: stickyRect.y, width, height};
							}
						}

						let parent = element.parentNode;
						while (parent && 'yogaNode' in parent && parent.yogaNode) {
							x += parent.yogaNode.getComputedLeft();
							y += parent.yogaNode.getComputedTop();
							parent = parent.parentNode;
						}

						return {x, y, width, height};
					},
					getPaintOrder() {
						let root: DOMElement = element;
						while (root.parentNode) {
							root = root.parentNode;
						}

						if (
							element.internal_paintEpoch === undefined ||
							element.internal_paintIndex === undefined ||
							element.internal_paintEpoch !== root.internal_paintEpoch
						) {
							return undefined;
						}

						return {
							epoch: element.internal_paintEpoch,
							index: element.internal_paintIndex,
						};
					},
				});
			}, []);

			const isScrollContainer =
				style.overflow === 'scroll' ||
				style.overflowX === 'scroll' ||
				style.overflowY === 'scroll';

			useLayoutEffect(() => {
				const element = internalRef.current;
				if (!element || !isScrollContainer) return;
				if (viewportCulling) {
					const retained =
						element.internal_scrollOffset ?? scrollStateRef.current;
					scrollStateRef.current = {...retained};
					element.internal_scrollOffset = {...retained};
					return;
				}

				element.internal_scrollOffset = scrollStateRef.current;
			});

			const {isScreenReaderEnabled} = useContext(accessibilityContext);
			const label = ariaLabel ? <ink-text>{ariaLabel}</ink-text> : undefined;
			if (isScreenReaderEnabled && ariaHidden) {
				return null;
			}

			const boxElement = (
				<ink-box
					ref={internalRef}
					internal_viewportCulling={viewportCulling || undefined}
					style={{
						flexWrap: 'nowrap',
						flexDirection: 'row',
						flexGrow: 0,
						flexShrink: 1,
						...style,
						backgroundColor,
						overflowX: style.overflowX ?? style.overflow ?? 'visible',
						overflowY: style.overflowY ?? style.overflow ?? 'visible',
					}}
					internal_accessibility={{
						role,
						state: ariaState,
					}}
					internal_scrollVersion={isScrollContainer ? scrollVersion : undefined}
				>
					{isScreenReaderEnabled && label ? label : children}
				</ink-box>
			);

			// If this Box has a background color, provide it to children via context
			if (backgroundColor) {
				return (
					<backgroundContext.Provider value={backgroundColor}>
						{boxElement}
					</backgroundContext.Provider>
				);
			}

			return boxElement;
		},
	);

	Component.displayName = displayName;
	return Component;
};

const Box = createBoxComponent('Box', false);
export default Box;
