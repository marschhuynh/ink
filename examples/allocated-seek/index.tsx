import process from 'node:process';
import React, {useState} from 'react';
import {
	Box,
	Text,
	render,
	useApp,
	useInput,
	useStderr,
	useStdout,
	useWindowSize,
} from '../../src/index.js';

const flag = '🏳️‍♀️';
const cluster = '👩‍👩⚡X';
const vs15 = '⚡︎';
const vs16 = '⚡️';
const refusalMessage =
	'allocated-seek example requires a foreground TTY on stdin and stdout; piped invocations are refused.\n';

function longMessage(stream: 'stdout' | 'stderr'): string {
	const lines = [`${stream.toUpperCase()} ${new Date().toISOString()}`];
	for (let index = 0; index < 40; index++) {
		lines.push(`${stream} line ${index} ${'x'.repeat(64)}`);
	}

	return `${lines.join('\n')}\n`;
}

function Line({
	columns,
	edge,
	children,
}: {
	readonly columns: number;
	readonly edge: string;
	readonly children: React.ReactNode;
}) {
	return (
		<Box
			flexShrink={0}
			height={1}
			justifyContent="space-between"
			width={columns}
		>
			<Box overflow="hidden">{children}</Box>
			<Text>{edge}</Text>
		</Box>
	);
}

function AllocatedSeek() {
	const {exit} = useApp();
	const {columns, rows} = useWindowSize();
	const {stdout, write: writeStdout} = useStdout();
	const {write: writeStderr} = useStderr();
	const [fullscreen, setFullscreen] = useState(true);
	const [middleTick, setMiddleTick] = useState(0);
	const [frameTick, setFrameTick] = useState(0);

	useInput(input => {
		if (input === 'n') {
			setMiddleTick(value => value + 1);
			return;
		}

		if (input === 'f') {
			setFrameTick(value => value + 1);
			return;
		}

		if (input === 'o') {
			writeStdout(longMessage('stdout'));
			return;
		}

		if (input === 'e') {
			writeStderr(longMessage('stderr'));
			return;
		}

		if (input === 'i') {
			setFullscreen(value => !value);
			return;
		}

		if (input === 'q') {
			exit();
		}
	});

	const height = fullscreen ? rows : Math.max(1, rows - 3);
	const middleIndex = Math.floor((height - 1) / 2);

	return (
		<Box flexDirection="column" height={height} width={columns}>
			{Array.from({length: height}, (_, index) => {
				const isLast = index === height - 1;
				const isMiddle = index === middleIndex;
				let content: React.ReactNode;

				if (isMiddle) {
					content = (
						<Text wrap="truncate">
							MIDDLE {middleTick} f={frameTick}
						</Text>
					);
				} else {
					switch (index) {
						case 0: {
							content = (
								<Text wrap="truncate">
									SEEK {fullscreen ? 'full' : 'inline'} {columns}x{rows}/
									{stdout.columns} f={frameTick} n/f/o/e/i/q
								</Text>
							);
							break;
						}

						case 1: {
							content = (
								<Text wrap="truncate">
									A{flag}B f={frameTick}
								</Text>
							);
							break;
						}

						case 2: {
							content = (
								<Text wrap="truncate">
									{cluster} ASCII f={frameTick}
								</Text>
							);
							break;
						}

						case 3: {
							content = (
								<Text wrap="truncate">
									VS15 {vs15} VS16 {vs16} f={frameTick}
								</Text>
							);
							break;
						}

						case 4: {
							content = (
								<Text wrap="truncate">
									<Text>A</Text>
									<Text backgroundColor="red">⚡</Text>
									<Text>B</Text>
									<Text backgroundColor="cyan"> </Text>
									<Text>C f={frameTick}</Text>
								</Text>
							);
							break;
						}

						default: {
							content = (
								<Text wrap="truncate">
									FILL {index} f={frameTick}
								</Text>
							);
							break;
						}
					}
				}

				return (
					<Line key={index} columns={columns} edge={isLast ? '+' : '|'}>
						{content}
					</Line>
				);
			})}
		</Box>
	);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	process.stderr.write(refusalMessage);
	process.exitCode = 1;
} else {
	render(<AllocatedSeek />, {
		incrementalRendering: true,
		patchConsole: true,
		exitOnCtrlC: false,
		alternateScreen: true,
	});
}
