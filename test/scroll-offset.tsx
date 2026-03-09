import React, {useEffect, useRef, useState} from 'react';
import test from 'ava';
import delay from 'delay';
import {Box, Text, render, type BoxRef} from '../src/index.js';
import createStdout from './helpers/create-stdout.js';
import {renderToString} from './helpers/render-to-string.js';

type ScrollFixtureProps = {
	readonly scrollY: number;
};

function ScrollFixture({scrollY}: ScrollFixtureProps) {
	const boxRef = useRef<BoxRef>(null);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		setReady(true);
	}, []);

	useEffect(() => {
		if (ready && boxRef.current) {
			boxRef.current.scrollTo({y: scrollY});
		}
	}, [ready, scrollY]);

	return (
		<Box
			ref={boxRef}
			width={10}
			height={3}
			overflow="scroll"
			flexDirection="column"
		>
			<Box flexDirection="column" flexShrink={0}>
				<Text>A1</Text>
				<Text>A2</Text>
			</Box>
			<Box flexShrink={0}>
				<Text>B1</Text>
			</Box>
			<Box flexShrink={0}>
				<Text>C1</Text>
			</Box>
			<Box flexShrink={0}>
				<Text>D1</Text>
			</Box>
		</Box>
	);
}

test('overflow scroll applies a one-line vertical offset correctly', async t => {
	const stdout = createStdout(100);

	render(<ScrollFixture scrollY={1} />, {stdout, debug: true});
	await delay(100);

	t.is(stdout.get().trimEnd(), 'A2\nB1\nC1');
});

test('overflow scroll aligns the next item exactly at a boundary offset', async t => {
	const stdout = createStdout(100);

	render(<ScrollFixture scrollY={2} />, {stdout, debug: true});
	await delay(100);

	t.is(stdout.get().trimEnd(), 'B1\nC1\nD1');
});

test('overflow hidden clips a negatively shifted flex column at line precision', t => {
	const output = renderToString(
		<Box height={3} overflowY="hidden" flexDirection="column">
			<Box marginTop={-1} flexDirection="column" flexShrink={0}>
				<Box flexShrink={0}>
					<Text>A1</Text>
				</Box>
				<Box flexShrink={0}>
					<Text>A2</Text>
				</Box>
				<Box flexShrink={0}>
					<Text>B1</Text>
				</Box>
				<Box flexShrink={0}>
					<Text>C1</Text>
				</Box>
			</Box>
		</Box>,
	);

	t.is(output, 'A2\nB1\nC1');
});
