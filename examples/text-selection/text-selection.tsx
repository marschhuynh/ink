import React, {useEffect, useRef, useState} from 'react';
import {
	render,
	Box,
	Text,
	useInput,
	useTextSelection,
	type BoxRef,
} from '../../src/index.js';

// Demonstrates the framework-level text selection API. Selection is driven
// here from the keyboard (arrow keys extend, c clears); mouse-driven
// selection lives in @nuvin/ink-input's useMouseTextSelection(), which feeds
// the same controller through the same actions.
function TextSelectionDemo() {
	const scrollRef = useRef<BoxRef>(null);
	const selection = useTextSelection();
	const origin = {x: 0, y: 1};
	const [cursor, setCursor] = useState({x: 0, y: 1});
	const startedRef = useRef(false);

	useEffect(() => {
		selection.setViewportProvider(() => {
			const bounds = scrollRef.current?.getBounds();
			if (!bounds) return null;
			return {
				top: bounds.y,
				left: bounds.x,
				width: bounds.width,
				height: bounds.height,
				scrollY: scrollRef.current?.getScrollPosition().y ?? 0,
			};
		});
		return () => {
			selection.setViewportProvider(null);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useInput((input, key) => {
		if (input === 'c') {
			startedRef.current = false;
			selection.clear();
			return;
		}

		if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
			const next = {
				x: Math.max(
					0,
					cursor.x + (key.rightArrow ? 1 : key.leftArrow ? -1 : 0),
				),
				y: Math.max(0, cursor.y + (key.downArrow ? 1 : key.upArrow ? -1 : 0)),
			};
			setCursor(next);

			if (!startedRef.current) {
				startedRef.current = true;
				selection.start(origin);
			}

			selection.update(next);
		}
	});

	return (
		<Box flexDirection="column" padding={1}>
			<Text bold>Arrow keys extend the selection · c clears</Text>
			<Box
				ref={scrollRef}
				borderStyle="round"
				flexDirection="column"
				height={6}
				overflow="scroll"
				width={44}
			>
				{Array.from({length: 12}, (_, index) => (
					<Box key={index} flexShrink={0}>
						<Text
							selectable={false}
						>{`${String(index + 1).padStart(2)}│ `}</Text>
						<Text>{`line ${index + 1}: selectable content here`}</Text>
					</Box>
				))}
			</Box>
			<Box flexDirection="column" marginTop={1}>
				<Text dimColor>Selected text (gutter is chrome, never copied):</Text>
				<Text>{selection.isEmpty ? '(none)' : selection.text}</Text>
			</Box>
		</Box>
	);
}

render(<TextSelectionDemo />);
