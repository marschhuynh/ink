import test from 'ava';
import React from 'react';
import stripAnsi from 'strip-ansi';
import delay from 'delay';
import {render, Box, Text} from '../src/index.js';
import createStdout from './helpers/create-stdout.js';

// =====================================================
// Full Flow Box Integration Test
// =====================================================

test.serial(
	'full flow - complex nested layout with multiple states',
	async t => {
		const stdout = createStdout(100);

		// Complex layout simulating a tool call viewer with multiple nested boxes
		function ComplexToolViewer({
			isExpanded,
			status,
			timer,
			output,
		}: {
			readonly isExpanded: boolean;
			readonly status: 'pending' | 'running' | 'completed';
			readonly timer: number;
			readonly output?: string;
		}) {
			const statusColors = {
				pending: 'gray',
				running: 'yellow',
				completed: 'green',
			} as const;

			return (
				<Box flexDirection="column" borderStyle="round" width="100%">
					{/* Header row */}
					<Box paddingX={1} justifyContent="space-between">
						<Box gap={1}>
							<Text>{isExpanded ? '▼' : '▶'}</Text>
							<Text>⚙︎</Text>
							<Text bold>Đây là một bài test phức tạp</Text>
						</Box>
						<Text color={statusColors[status]}>
							{status === 'running' ? `Running ${timer}s` : status}
						</Text>
					</Box>

					{/* Expanded content */}
					{isExpanded && (
						<Box flexDirection="column" paddingX={2}>
							{/* Command info */}
							<Box
								borderStyle="single"
								borderColor="gray"
								flexDirection="column"
								paddingX={1}
							>
								<Text dimColor>Command:</Text>
								<Text> sleep 10 && echo $RANDOM</Text>
							</Box>

							{/* Output section */}
							{output && (
								<Box marginTop={1} flexDirection="column">
									<Text dimColor>Output:</Text>
									<Box borderStyle="round" paddingX={1}>
										<Text>{output}</Text>
									</Box>
								</Box>
							)}

							{/* Status bar */}
							<Box marginTop={1} gap={2}>
								<Text color="gray">Exit code: 0</Text>
								<Text color="gray">Duration: {timer}s</Text>
							</Box>
						</Box>
					)}
				</Box>
			);
		}

		// ========================================
		// State 1: Collapsed and pending
		// ========================================
		const {unmount, rerender} = render(
			<ComplexToolViewer isExpanded={false} status="pending" timer={0} />,
			{stdout},
		);

		let output = stripAnsi(stdout.get()).trimEnd();

		t.snapshot(output, 'Collapsed pending state');

		// ========================================
		// State 2: Expanded and running
		// ========================================
		rerender(<ComplexToolViewer isExpanded status="running" timer={3} />);
		await delay(50);

		output = stripAnsi(stdout.get()).trimEnd();
		t.snapshot(output, 'Expanded running state');

		// ========================================
		// State 3: Completed with output
		// ========================================
		rerender(
			<ComplexToolViewer
				isExpanded
				status="completed"
				timer={10}
				output="Random number: 42069"
			/>,
		);
		await delay(50);

		output = stripAnsi(stdout.get()).trimEnd();
		t.snapshot(output, 'Completed state with output');

		// ========================================
		// State 4: Collapsed again (completed)
		// ========================================
		rerender(
			<ComplexToolViewer
				isExpanded={false}
				status="completed"
				timer={10}
				output="Random number: 42069"
			/>,
		);
		await delay(50);

		output = stripAnsi(stdout.get()).trimEnd();
		t.snapshot(output, 'Collapsed completed state');

		unmount();
	},
);
