import React from 'react';
import test from 'ava';
import {Box, Text} from '../src/index.js';
import {renderToString} from './helpers/render-to-string.js';

test('position absolute with top offset', t => {
	const output = renderToString(
		<Box height={5} width={10}>
			<Box position="absolute" top={2}>
				<Text>X</Text>
			</Box>
		</Box>,
	);

	const lines = output.split('\n');
	t.is(lines[0], '');
	t.is(lines[1], '');
	t.is(lines[2]?.trimEnd(), 'X');
});

test('position absolute with left offset', t => {
	const output = renderToString(
		<Box height={3} width={10}>
			<Box position="absolute" left={5}>
				<Text>X</Text>
			</Box>
		</Box>,
	);

	t.true(output.includes('     X'));
});

test('position absolute with top and left offset', t => {
	const output = renderToString(
		<Box height={5} width={10}>
			<Box position="absolute" top={2} left={3}>
				<Text>X</Text>
			</Box>
		</Box>,
	);

	const lines = output.split('\n');
	t.is(lines[2]?.trimEnd(), '   X');
});

test('position absolute with right offset', t => {
	const output = renderToString(
		<Box height={3} width={10}>
			<Box position="absolute" right={0}>
				<Text>X</Text>
			</Box>
		</Box>,
		{columns: 10},
	);

	const lines = output.split('\n');
	t.true(lines[0]?.endsWith('X'));
});

test('position absolute with bottom offset', t => {
	const output = renderToString(
		<Box height={5} width={10}>
			<Box position="absolute" bottom={0}>
				<Text>X</Text>
			</Box>
		</Box>,
	);

	const lines = output.split('\n');
	t.is(lines[4]?.trimEnd(), 'X');
});

test('zIndex - higher zIndex renders on top', t => {
	const output = renderToString(
		<Box height={3} width={20}>
			<Box position="absolute" top={0} left={0} zIndex={1}>
				<Text>AAA</Text>
			</Box>
			<Box position="absolute" top={0} left={1} zIndex={2}>
				<Text>BBB</Text>
			</Box>
		</Box>,
	);

	t.true(output.includes('ABBB'));
});

test('zIndex - lower zIndex renders below', t => {
	const output = renderToString(
		<Box height={3} width={20}>
			<Box position="absolute" top={0} left={1} zIndex={2}>
				<Text>BBB</Text>
			</Box>
			<Box position="absolute" top={0} left={0} zIndex={1}>
				<Text>AAA</Text>
			</Box>
		</Box>,
	);

	t.true(output.includes('ABBB'));
});

test('zIndex - default zIndex is 0', t => {
	const output = renderToString(
		<Box height={3} width={20}>
			<Box position="absolute" top={0} left={0}>
				<Text>First</Text>
			</Box>
			<Box position="absolute" top={0} left={0} zIndex={1}>
				<Text>Second</Text>
			</Box>
		</Box>,
	);

	t.true(output.includes('Second'));
});

test('zIndex - same zIndex renders in DOM order', t => {
	const output = renderToString(
		<Box height={3} width={20}>
			<Box position="absolute" top={0} left={0} zIndex={1}>
				<Text>AAA</Text>
			</Box>
			<Box position="absolute" top={0} left={0} zIndex={1}>
				<Text>BBB</Text>
			</Box>
		</Box>,
	);

	t.true(output.includes('BBB'));
});

test('multiple positioned elements with different zIndex', t => {
	const output = renderToString(
		<Box height={5} width={30}>
			<Box position="absolute" top={0} left={0} zIndex={3}>
				<Text>TOP</Text>
			</Box>
			<Box position="absolute" top={0} left={0} zIndex={1}>
				<Text>BOTTOM</Text>
			</Box>
			<Box position="absolute" top={0} left={0} zIndex={2}>
				<Text>MIDDLE</Text>
			</Box>
		</Box>,
	);

	t.true(output.includes('TOP'));
});

test('position absolute clipped by overflow hidden - horizontal', t => {
	const output = renderToString(
		<Box height={3} width={10} overflow="hidden">
			<Box position="absolute" top={0} left={15}>
				<Text>HIDDEN</Text>
			</Box>
		</Box>,
	);

	t.false(output.includes('HIDDEN'));
});

test('position absolute clipped by overflow hidden - vertical', t => {
	const output = renderToString(
		<Box height={3} width={20} overflow="hidden">
			<Box position="absolute" top={10} left={0}>
				<Text>HIDDEN</Text>
			</Box>
		</Box>,
	);

	t.false(output.includes('HIDDEN'));
});

test('position absolute partially clipped by overflow hidden', t => {
	const output = renderToString(
		<Box height={3} width={10} overflow="hidden">
			<Box position="absolute" top={0} left={7}>
				<Text>ABCDEF</Text>
			</Box>
		</Box>,
	);

	t.true(output.includes('ABC'));
	t.false(output.includes('ABCDEF'));
});

test('position absolute visible within overflow hidden container', t => {
	const output = renderToString(
		<Box height={5} width={20} overflow="hidden">
			<Box position="absolute" top={1} left={2}>
				<Text>VISIBLE</Text>
			</Box>
		</Box>,
	);

	t.true(output.includes('VISIBLE'));
});

test('position absolute outside left boundary is clipped', t => {
	const output = renderToString(
		<Box height={3} width={20} overflow="hidden">
			<Box position="absolute" top={0} left={-10}>
				<Text>HIDDEN</Text>
			</Box>
		</Box>,
	);

	t.false(output.includes('HIDDEN'));
});
