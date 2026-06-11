import React, {useEffect} from 'react';
import test from 'ava';
import {Text, render, useTextSelection} from '../src/index.js';
import createStdout from './helpers/create-stdout.js';

function Probe({onText}: {readonly onText: (text: string) => void}) {
	const selection = useTextSelection();

	useEffect(() => {
		selection.start({x: 0, y: 0});
		selection.update({x: 5, y: 0});
		selection.finish();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	useEffect(() => {
		onText(selection.text);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selection.text]);

	return <Text>hello world</Text>;
}

test('useTextSelection exposes selected text and actions', async t => {
	let latest = '';
	const stdout = createStdout();

	const instance = render(
		<Probe
			onText={text => {
				latest = text;
			}}
		/>,
		{stdout, debug: true},
	);

	await new Promise(resolve => {
		setTimeout(resolve, 50);
	});

	t.is(latest, 'hello');
	instance.unmount();
});
