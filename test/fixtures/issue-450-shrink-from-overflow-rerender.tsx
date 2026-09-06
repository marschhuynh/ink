import process from 'node:process';
import {runIssue450RerenderFixture} from './issue-450-fixture-helpers.js';

// Isolate this physical overflow-to-(rows - 1) shrink from automatic startup
// coalescing. Frame 1 replaces overflow at 100ms, before the 200ms capability
// window would flush the first gated frame, so overflow never paints.
process.env['INK_EXPLICIT_WIDTH'] = '0';

runIssue450RerenderFixture({
	heightForFrame: (rows, frameCount) =>
		frameCount === 0 ? rows + 1 : rows - 1,
});
