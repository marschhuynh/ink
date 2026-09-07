import {spawn} from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import url from 'node:url';
import test from 'ava';

const __dirname = url.fileURLToPath(new URL('.', import.meta.url));
const fixturePath = path.join(
	__dirname,
	'../examples/allocated-seek/index.tsx',
);

const terminalControl = new RegExp(
	`[${String.fromCodePoint(0x1b)}\u009B\u009D\u0090\u0098\u009E\u009F]`,
);
const refusalMessage =
	'allocated-seek example requires a foreground TTY on stdin and stdout; piped invocations are refused.';

test('piped allocated-seek fixture refuses without terminal controls', async t => {
	const env = {
		...process.env,
		// eslint-disable-next-line @typescript-eslint/naming-convention
		NODE_NO_WARNINGS: '1',
	};

	const childProcess = spawn(process.execPath, ['--import=tsx', fixturePath], {
		cwd: path.join(__dirname, '..'),
		env,
		stdio: ['pipe', 'pipe', 'pipe'],
	});

	childProcess.stdin?.end();

	let stdout = '';
	let stderr = '';

	if (!childProcess.stdout || !childProcess.stderr) {
		t.fail('Fixture process did not expose stdout/stderr pipes');
		return;
	}

	childProcess.stdout.on('data', (data: Uint8Array | string) => {
		stdout += typeof data === 'string' ? data : data.toString();
	});

	childProcess.stderr.on('data', (data: Uint8Array | string) => {
		stderr += typeof data === 'string' ? data : data.toString();
	});

	const result = await new Promise<
		{timedOut: true} | {timedOut: false; exitCode: number}
	>((resolve, reject) => {
		const timeout = setTimeout(() => {
			childProcess.kill();
			resolve({timedOut: true});
		}, 5000);

		childProcess.on('error', error => {
			clearTimeout(timeout);
			reject(error);
		});

		childProcess.on('close', exitCode => {
			clearTimeout(timeout);
			resolve({timedOut: false, exitCode: exitCode ?? 0});
		});
	});

	if (result.timedOut) {
		t.fail('Fixture hung instead of refusing a piped invocation');
		return;
	}

	t.is(result.exitCode, 1, `stderr: ${stderr}`);
	t.true(
		stderr.includes(refusalMessage),
		'stderr includes the TTY refusal message',
	);
	t.is(stdout, '');
	t.notRegex(stdout, terminalControl);
	t.notRegex(stderr, terminalControl);
});
