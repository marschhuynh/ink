import React from 'react';
import test from 'ava';
import {Box, Text} from '../src/index.js';
import {renderToString} from './helpers/render-to-string.js';

test('tab characters are expanded to spaces', t => {
	const output = renderToString(
		<Box>
			<Text>{'\t\tHello'}</Text>
		</Box>,
	);

	t.is(output, '    Hello');
});

test('tabs in multi-line text are expanded consistently', t => {
	const output = renderToString(
		<Box>
			<Text>{'\tA\n\t\tB\n\t\t\tC'}</Text>
		</Box>,
	);

	t.is(output, '  A\n    B\n      C');
});

test('mixed tabs and spaces are preserved', t => {
	const output = renderToString(
		<Box>
			<Text>{'\t Hello'}</Text>
		</Box>,
	);

	t.is(output, '   Hello');
});
