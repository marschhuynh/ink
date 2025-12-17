import React, {
	forwardRef,
	useContext,
	useRef,
	useImperativeHandle,
	useLayoutEffect,
	useState,
	type PropsWithChildren,
} from 'react';
import Yoga from 'yoga-layout';
import {type Except} from 'type-fest';
import {type Styles} from '../styles.js';
import {type DOMElement} from '../dom.js';
import {accessibilityContext} from './AccessibilityContext.js';
import {backgroundContext} from './BackgroundContext.js';

export type BoxRef = DOMElement & {
	scrollTo: (options: {x?: number; y?: number}) => void;
	getScrollPosition: () => {x: number; y: number};
	scrollToTop: () => void;
	scrollToBottom: () => void;
	getBounds: () => {x: number; y: number; width: number; height: number};
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
const Box = forwardRef<BoxRef, PropsWithChildren<Props>>(
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
				if (!yogaNode) return {width: 0, height: 0};

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
				if (!yogaNode) return {x: 0, y: 0};

				const containerWidth =
					yogaNode.getComputedWidth() -
					yogaNode.getComputedBorder(Yoga.EDGE_LEFT) -
					yogaNode.getComputedBorder(Yoga.EDGE_RIGHT);
				const containerHeight =
					yogaNode.getComputedHeight() -
					yogaNode.getComputedBorder(Yoga.EDGE_TOP) -
					yogaNode.getComputedBorder(Yoga.EDGE_BOTTOM);
				const content = getContentDimensions();

				return {
					x: Math.max(0, content.width - containerWidth),
					y: Math.max(0, content.height - containerHeight),
				};
			};

			return Object.assign(element, {
				scrollTo({x, y}: {x?: number; y?: number}) {
					const maxScroll = getMaxScroll();

					if (x !== undefined) {
						scrollStateRef.current.x = Math.max(0, Math.min(x, maxScroll.x));
					}

					if (y !== undefined) {
						scrollStateRef.current.y = Math.max(0, Math.min(y, maxScroll.y));
					}

					element.internal_scrollOffset = {
						...scrollStateRef.current,
					};

					setScrollVersion(v => v + 1);
				},
				getScrollPosition() {
					return {...scrollStateRef.current};
				},
				scrollToTop() {
					scrollStateRef.current.y = 0;
					element.internal_scrollOffset = {...scrollStateRef.current};
					setScrollVersion(v => v + 1);
				},
				scrollToBottom() {
					const maxScroll = getMaxScroll();
					scrollStateRef.current.y = maxScroll.y;
					element.internal_scrollOffset = {...scrollStateRef.current};
					setScrollVersion(v => v + 1);
				},
				getBounds() {
					const {yogaNode} = element;
					if (!yogaNode) return {x: 0, y: 0, width: 0, height: 0};

					let x = yogaNode.getComputedLeft();
					let y = yogaNode.getComputedTop();
					const width = yogaNode.getComputedWidth();
					const height = yogaNode.getComputedHeight();

					let parent = element.parentNode;
					while (parent && 'yogaNode' in parent && parent.yogaNode) {
						x += parent.yogaNode.getComputedLeft();
						y += parent.yogaNode.getComputedTop();
						parent = parent.parentNode;
					}

					return {x, y, width, height};
				},
			});
		}, []);

		const isScrollContainer =
			style.overflow === 'scroll' ||
			style.overflowX === 'scroll' ||
			style.overflowY === 'scroll';

		useLayoutEffect(() => {
			if (internalRef.current && isScrollContainer) {
				internalRef.current.internal_scrollOffset = scrollStateRef.current;
			}
		});

		const {isScreenReaderEnabled} = useContext(accessibilityContext);
		const label = ariaLabel ? <ink-text>{ariaLabel}</ink-text> : undefined;
		if (isScreenReaderEnabled && ariaHidden) {
			return null;
		}

		const boxElement = (
			<ink-box
				ref={internalRef}
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

Box.displayName = 'Box';

export default Box;
