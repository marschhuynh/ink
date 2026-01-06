import test from 'ava';
import ansiEscapes from 'ansi-escapes';
import logUpdate from '../src/log-update.js';
import createStdout from './helpers/create-stdout.js';

test('standard rendering - renders and updates output', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout);

	render('Hello');
	t.is((stdout.write as any).callCount, 1);
	t.is((stdout.write as any).firstCall.args[0], 'Hello\n');

	render('World');
	t.is((stdout.write as any).callCount, 2);
	t.true(
		((stdout.write as any).secondCall.args[0] as string).includes('World'),
	);
});

test('standard rendering - skips identical output', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout);

	render('Hello');
	render('Hello');

	t.is((stdout.write as any).callCount, 1);
});

test('incremental rendering - renders and updates output', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('Hello');
	t.is((stdout.write as any).callCount, 1);
	t.is((stdout.write as any).firstCall.args[0], 'Hello\n');

	render('World');
	t.is((stdout.write as any).callCount, 2);
	t.true(
		((stdout.write as any).secondCall.args[0] as string).includes('World'),
	);
});

test('incremental rendering - skips identical output', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('Hello');
	render('Hello');

	t.is((stdout.write as any).callCount, 1);
});

test('incremental rendering - surgical updates', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('Line 1\nLine 2\nLine 3');
	render('Line 1\nUpdated\nLine 3');

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.includes(ansiEscapes.cursorNextLine)); // Skips unchanged lines
	t.true(secondCall.includes('Updated')); // Only updates changed line
	t.false(secondCall.includes('Line 1')); // Doesn't rewrite unchanged
	t.false(secondCall.includes('Line 3')); // Doesn't rewrite unchanged
});

test('incremental rendering - clears extra lines when output shrinks', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('Line 1\nLine 2\nLine 3');
	render('Line 1');

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.includes(ansiEscapes.eraseLines(2))); // Erases 2 extra lines
});

test('incremental rendering - when output grows', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('Line 1');
	render('Line 1\nLine 2\nLine 3');

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.includes(ansiEscapes.cursorNextLine)); // Skips unchanged first line
	t.true(secondCall.includes('Line 2')); // Adds new line
	t.true(secondCall.includes('Line 3')); // Adds new line
	t.false(secondCall.includes('Line 1')); // Doesn't rewrite unchanged
});

test('incremental rendering - single write call with multiple surgical updates', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render(
		'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10',
	);
	render(
		'Line 1\nUpdated 2\nLine 3\nUpdated 4\nLine 5\nUpdated 6\nLine 7\nUpdated 8\nLine 9\nUpdated 10',
	);

	t.is((stdout.write as any).callCount, 2); // Only 2 writes total (initial + update)
});

test('incremental rendering - shrinking output keeps screen tight', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('Line 1\nLine 2\nLine 3');
	render('Line 1\nLine 2');
	render('Line 1');

	const thirdCall = stdout.get();

	t.is(
		thirdCall,
		ansiEscapes.eraseLines(2) + // Erase Line 2 and ending cursorNextLine
			ansiEscapes.cursorUp(1) + // Move to beginning of Line 1
			ansiEscapes.cursorNextLine, // Move to next line after Line 1
	);
});

test('incremental rendering - clear() fully resets incremental state', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('Line 1\nLine 2\nLine 3');
	render.clear();
	render('Line 1');

	const afterClear = stdout.get();

	t.is(afterClear, ansiEscapes.eraseLines(0) + 'Line 1\n'); // Should do a fresh write
});

test('incremental rendering - done() resets before next render', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('Line 1\nLine 2\nLine 3');
	render.done();
	render('Line 1');

	const afterDone = stdout.get();

	t.is(afterDone, ansiEscapes.eraseLines(0) + 'Line 1\n'); // Should do a fresh write
});

test('incremental rendering - multiple consecutive clear() calls (should be harmless no-ops)', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('Line 1\nLine 2\nLine 3');
	render.clear();
	render.clear();
	render.clear();

	t.is((stdout.write as any).callCount, 4); // Initial render + 3 clears (each writes eraseLines)

	// Verify state is properly reset after multiple clears
	render('New content');
	const afterClears = stdout.get();
	t.is(afterClears, ansiEscapes.eraseLines(0) + 'New content\n'); // Should do a fresh write
});

test('incremental rendering - sync() followed by update (assert incremental path is used)', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render.sync('Line 1\nLine 2\nLine 3');
	t.is((stdout.write as any).callCount, 0); // The sync() call shouldn't write to stdout

	render('Line 1\nUpdated\nLine 3');
	t.is((stdout.write as any).callCount, 1);

	const firstCall = (stdout.write as any).firstCall.args[0] as string;
	t.true(firstCall.includes(ansiEscapes.cursorNextLine)); // Skips unchanged lines
	t.true(firstCall.includes('Updated')); // Only updates changed line
	t.false(firstCall.includes('Line 1')); // Doesn't rewrite unchanged
	t.false(firstCall.includes('Line 3')); // Doesn't rewrite unchanged
});

test('incremental rendering - render to empty string (full clear vs early exit)', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('Line 1\nLine 2\nLine 3');
	render('');

	t.is((stdout.write as any).callCount, 2);
	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.is(secondCall, ansiEscapes.eraseLines(4) + '\n'); // Erases all 4 lines + writes single newline

	// Rendering empty string again should be skipped (identical output)
	render('');
	t.is((stdout.write as any).callCount, 2); // No additional write
});

// =====================================================
// Wide Character & Unicode Tests
// =====================================================

test('incremental rendering - gear icon with text presentation selector', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	// Using gear icon with text presentation selector (⚙︎ = U+2699 U+FE0E)
	render('⚙︎ Task running');
	render('⚙︎ Task completed');

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.includes('Task completed'));
	// The gear icon line should remain intact
	t.true(secondCall.includes('⚙︎'));
});

test('incremental rendering - gear icon consistency across updates', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	// Simulating the tool call display scenario
	const gearIcon = '⚙︎';
	render(
		`${gearIcon} Wait 10s then generate random number\n   cmd: sleep 10\n   Running ... 2s`,
	);
	const firstOutput = (stdout.write as any).firstCall.args[0] as string;

	render(
		`${gearIcon} Wait 10s then generate random number\n   cmd: sleep 10\n   Executed (exit 0)\n   Done in 10.2s`,
	);
	const secondOutput = (stdout.write as any).secondCall.args[0] as string;

	// Verify both outputs have the gear icon
	t.true(firstOutput.includes(gearIcon));
	t.true(
		secondOutput.includes(gearIcon) ||
			secondOutput.includes(ansiEscapes.cursorNextLine),
	);

	// If the first line is unchanged, it should be skipped
	// The second call should include cursorNextLine to skip the unchanged first line
	t.true(secondOutput.includes(ansiEscapes.cursorNextLine));
});

test('incremental rendering - comparing gear icon variants', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	// Test different gear icon variants
	const gearText = '⚙︎'; // Text presentation (U+2699 U+FE0E)
	const gearEmoji = '⚙️'; // Emoji presentation (U+2699 U+FE0F)
	const gearPlain = '⚙'; // Plain (U+2699)

	render(`${gearText} Text presentation`);
	const output1 = (stdout.write as any).lastCall.args[0] as string;

	render(`${gearEmoji} Emoji presentation`);
	const output2 = (stdout.write as any).lastCall.args[0] as string;

	render(`${gearPlain} Plain gear`);
	const output3 = (stdout.write as any).lastCall.args[0] as string;

	// All should render without issues
	t.true(output1.includes(gearText));
	t.true(output2.includes(gearEmoji));
	t.true(output3.includes(gearPlain));
});

test('incremental rendering - wide emoji characters', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('🚀 Launching...');
	render('🚀 Launched!');

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.includes('Launched!'));
});

test('incremental rendering - CJK characters', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('日本語 Line 1\n中文 Line 2\n한국어 Line 3');
	render('日本語 Line 1\n中文 Updated\n한국어 Line 3');

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.includes('Updated'));
	t.true(secondCall.includes(ansiEscapes.cursorNextLine)); // Skips unchanged lines
	t.false(secondCall.includes('日本語 Line 1')); // First line unchanged
	t.false(secondCall.includes('한국어 Line 3')); // Third line unchanged
});

test('incremental rendering - Vietnamese text with diacritics', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	// Vietnamese text with diacritical marks
	render('Đây là một bài test phức tạp\nLine 2\nLine 3');
	render('Đây là một bài test phức tạp\nUpdated\nLine 3');

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.includes('Updated'));
	t.true(secondCall.includes(ansiEscapes.cursorNextLine)); // First line unchanged
	t.false(secondCall.includes('Đây là một bài test phức tạp')); // First line unchanged
	t.false(secondCall.includes('Line 3')); // Third line unchanged
});

test('incremental rendering - mixed width characters', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	// Mix of narrow (ASCII) and wide (emoji, CJK) characters
	render('Hello 🌍 世界 World');
	render('Hello 🌍 世界 Updated');

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.includes('Updated'));
});

// =====================================================
// ANSI Escape Sequence Tests
// =====================================================

test('incremental rendering - colored text updates', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	// Using raw ANSI escape codes for green and red
	const green = '\u001B[32m';
	const red = '\u001B[31m';
	const reset = '\u001B[0m';

	render(`${green}Status: Running${reset}`);
	render(`${red}Status: Error${reset}`);

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.includes('Error'));
});

test('incremental rendering - line with unchanged prefix and changing suffix', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	render('⚙︎ Task Name\n   Running ... 1s');
	render('⚙︎ Task Name\n   Running ... 2s');
	render('⚙︎ Task Name\n   Running ... 3s');

	// Each update should only update the second line
	t.is((stdout.write as any).callCount, 3);

	const secondCall = (stdout.write as any).secondCall.args[0] as string;
	t.true(secondCall.includes(ansiEscapes.cursorNextLine)); // First line skipped
	t.true(secondCall.includes('2s'));

	const thirdCall = (stdout.write as any).thirdCall.args[0] as string;
	t.true(thirdCall.includes(ansiEscapes.cursorNextLine)); // First line skipped
	t.true(thirdCall.includes('3s'));
});

test('incremental rendering - line count changes with unicode prefix', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	// Start with 3 lines
	render('⚙︎ Task\n   cmd: test\n   Running ... 2s');

	// Change to 4 lines (like when task completes)
	render('⚙︎ Task\n   cmd: test\n   Executed (exit 0)\n   Done in 10.2s');

	const secondCall = (stdout.write as any).secondCall.args[0] as string;

	// Should include the new line
	t.true(secondCall.includes('Done in 10.2s'));
});

test('incremental rendering - preserves spacing with special characters', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	// Test that spacing around special characters is preserved
	const line1 = '⚙︎ Task Name';
	const line2a = '   Status: Running';
	const line2b = '   Status: Done';

	render(`${line1}\n${line2a}`);
	const firstOutput = (stdout.write as any).firstCall.args[0] as string;

	render(`${line1}\n${line2b}`);
	const secondOutput = (stdout.write as any).secondCall.args[0] as string;

	// Verify first line is skipped in second render
	t.true(secondOutput.includes(ansiEscapes.cursorNextLine));
	t.false(secondOutput.includes('Task Name'));
	t.true(secondOutput.includes('Done'));

	// Check the first output has proper structure
	t.true(firstOutput.includes(line1));
	t.true(firstOutput.includes(line2a));
});

// =====================================================
// Full Flow Integration Test
// =====================================================

test('incremental rendering - full flow with render, sync, clear, and done', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	// Phase 1: Initial render with Vietnamese text
	render('⚙︎ Đây là một bài test phức tạp\n   cmd: sleep 10\n   Running ... 0s');
	t.is((stdout.write as any).callCount, 1);
	const initialRender = (stdout.write as any).firstCall.args[0] as string;
	t.true(initialRender.includes('Đây là một bài test phức tạp'));
	t.true(initialRender.includes('Running ... 0s'));

	// Phase 2: Update timer (simulating running state)
	render('⚙︎ Đây là một bài test phức tạp\n   cmd: sleep 10\n   Running ... 1s');
	t.is((stdout.write as any).callCount, 2);
	const update1 = (stdout.write as any).secondCall.args[0] as string;
	// First two lines should be skipped (cursorNextLine used)
	t.true(update1.includes(ansiEscapes.cursorNextLine));
	t.true(update1.includes('Running ... 1s'));
	t.false(update1.includes('Đây là một bài test phức tạp')); // First line unchanged

	// Phase 3: Another timer update
	render('⚙︎ Đây là một bài test phức tạp\n   cmd: sleep 10\n   Running ... 2s');
	t.is((stdout.write as any).callCount, 3);
	const update2 = (stdout.write as any).thirdCall.args[0] as string;
	t.true(update2.includes('Running ... 2s'));

	// Phase 4: Clear and start fresh
	render.clear();
	t.is((stdout.write as any).callCount, 4);

	// Phase 5: Sync previous state (no stdout write)
	render.sync(
		'⚙︎ Đây là một bài test phức tạp\n   cmd: sleep 10\n   Executed (exit 0)',
	);
	t.is((stdout.write as any).callCount, 4); // Sync doesn't write

	// Phase 6: Update from synced state
	render(
		'⚙︎ Đây là một bài test phức tạp\n   cmd: sleep 10\n   Executed (exit 0)\n   Done in 10.2s',
	);
	t.is((stdout.write as any).callCount, 5);
	const afterSync = (stdout.write as any).lastCall.args[0] as string;
	// Should use incremental update from synced state
	t.true(afterSync.includes('Done in 10.2s'));

	// Phase 7: Mark as done
	render.done();

	// Phase 8: New render after done (fresh start)
	render('⚙︎ New task starting\n   Running ...');
	t.is((stdout.write as any).callCount, 6);
	const afterDone = (stdout.write as any).lastCall.args[0] as string;
	// After done(), should be a fresh render
	t.true(afterDone.includes('New task starting'));
});

test('incremental rendering - simulating tool call state transitions', t => {
	const stdout = createStdout();
	const render = logUpdate.create(stdout, {incremental: true});

	const gearIcon = '⚙︎';
	const taskName = 'Wait 10s then generate random number';

	// State 1: Running with spinner updates
	for (let i = 0; i <= 5; i++) {
		render(
			`${gearIcon} ${taskName}\n   cmd: sleep 10 && echo $RANDOM\n   Running ... ${i}s`,
		);
	}

	// Verify incremental updates happened (6 writes total)

	t.is((stdout.write as any).callCount, 6);

	// Verify the last few updates only changed the timer line
	// eslint-disable-next-line @typescript-eslint/no-unsafe-call
	const update5 = (stdout.write as any).getCall(4).args[0] as string;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-call
	const update6 = (stdout.write as any).getCall(5).args[0] as string;

	t.true(update5.includes(ansiEscapes.cursorNextLine)); // Skipped unchanged lines
	t.true(update6.includes(ansiEscapes.cursorNextLine)); // Skipped unchanged lines
	t.true(update5.includes('4s'));
	t.true(update6.includes('5s'));

	// State 2: Completed - line count changes
	render(
		`${gearIcon} ${taskName}\n   cmd: sleep 10 && echo $RANDOM\n   Executed (exit 0)\n   Done in 10.2s`,
	);

	t.is((stdout.write as any).callCount, 7);

	const completedRender = (stdout.write as any).lastCall.args[0] as string;
	t.true(completedRender.includes('Done in 10.2s'));
	t.true(completedRender.includes('Executed (exit 0)'));

	// Verify first line was still skipped (unchanged)
	t.true(completedRender.includes(ansiEscapes.cursorNextLine));
});
